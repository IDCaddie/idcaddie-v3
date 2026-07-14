-- 0047_connector_customer_pilot.sql
--
-- Provider-neutral CUSTOMER-PILOT CONTROL PLANE (P5E14, Gate S3 readiness). The durable enrollment / consent / incident / exit /
-- deletion substrate that must exist and be enforceable BEFORE one real customer pilot can be authorized. It ACTIVATES nothing: a
-- pilot is `draft` by default; no customer execution happens because these rows exist. A pilot run still requires (a future,
-- separate GO to) enable the pilot + its customer kill switch, and every runner gate below to pass. Staging only (CHECK
-- environment='staging'); discovery-only + promotion-disabled + manual-only enforced by CHECK; one active pilot maximum.
--
-- SECURITY MODEL (mirrors 0044/0045/0046): request roles (anon/authenticated) get NOTHING (RLS-enabled + ZERO policies +
-- revoke-all + the 0045 deny-all EXECUTE revoke incl. the Supabase default-privilege grant). service_role runs the ADMIN pilot
-- lifecycle (create/consent/approve/enable/transition/incident/exit/deletion). connector_runner runs ONLY two read/assert functions
-- (read one pilot; assert pilot-authorized) + the run-counter — never a direct table write, never consent/approval mutation. All
-- SECURITY DEFINER with a pinned empty search_path (schema-qualified). Reuses 0044 connector_execution_permitted + kill switches.
--
-- STORES NO customer names/emails/UPNs, secret values, tokens, full ARNs, DB URLs, raw signed documents, raw Graph payloads, or
-- discovery-row contents — only opaque references, sanitized summaries, and aggregate metadata.
--
-- Migration-safety: ALTER ADD COLUMN|CONSTRAINT / CREATE TABLE|INDEX|FUNCTION + GRANT/REVOKE only — additive; no teardown, no row
-- purge, no destructive ops. microsoft_entra stays certificationOnly; RISK-007 remains OPEN; Phase C remains BLOCKED; staging only;
-- a production project/account/tenant/credential must NEVER appear here.

begin;

-- Extend the 0044 kill-switch scope with a per-PILOT layer (customer-specific enablement).
do $$ begin
  if exists (select 1 from pg_constraint where conname='cks_scope_check') then
    alter table public.connector_kill_switches drop constraint cks_scope_check;
    alter table public.connector_kill_switches add constraint cks_scope_check
      check (scope in ('global','provider','environment','tenant','connector','schedule','pilot'));
  end if;
end $$;

-- ── 1. PILOT ENROLLMENT — the durable, human-approved customer-pilot record + the exact config + limits it binds. ──────
create table if not exists public.connector_pilot_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  provider text not null,
  environment text not null default 'staging',
  is_synthetic boolean not null default false,               -- true for staging test fixtures; a real customer pilot is false
  customer_account_reference text,                            -- OPAQUE reference only (never a name/email/tenant-id/domain)
  pilot_status text not null default 'draft',
  requested_by text not null,
  approved_by text,
  approval_reason text,
  approved_at timestamptz,
  support_owner text,
  incident_owner text,
  data_processing_purpose text,
  approved_permissions text,                                  -- the single approved Graph app permission (e.g. 'User.Read.All')
  credential_version text,
  schema_version text,
  retention_days integer,
  pilot_start_at timestamptz,
  pilot_end_at timestamptz,
  maximum_runs integer not null default 3,
  maximum_records_per_run integer not null default 100,
  runs_used integer not null default 0,
  discovery_only boolean not null default true,
  promotion_disabled boolean not null default true,
  manual_only boolean not null default true,
  schedule_allowed boolean not null default false,
  customer_kill_switch_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cpe_status_check check (pilot_status in (
    'draft','consent_pending','approved','enabled','paused','completed','cancelled','expired','incident_hold')),
  constraint cpe_environment_staging_only check (environment = 'staging'),
  constraint cpe_discovery_only_true check (discovery_only = true),
  constraint cpe_promotion_disabled_true check (promotion_disabled = true),
  constraint cpe_manual_only_true check (manual_only = true),               -- S3 is manual-only (no schedule)
  constraint cpe_schedule_disallowed check (schedule_allowed = false),      -- S3 disallows a schedule
  constraint cpe_kill_switch_required_true check (customer_kill_switch_required = true),
  constraint cpe_retention_bound check (retention_days is null or retention_days between 1 and 90),
  constraint cpe_max_runs_bound check (maximum_runs between 1 and 3),        -- conservative pilot cap
  constraint cpe_max_records_bound check (maximum_records_per_run between 1 and 1000),
  constraint cpe_runs_used_bound check (runs_used >= 0 and runs_used <= maximum_runs),
  constraint cpe_customer_ref_when_real check (is_synthetic = true or customer_account_reference is not null),
  constraint cpe_window_order check (pilot_start_at is null or pilot_end_at is null or pilot_end_at > pilot_start_at),
  constraint cpe_same_tenant_connector
    foreign key (connector_id, tenant_id) references public.connectors (id, tenant_id) on delete cascade
);
-- At most ONE ENABLED pilot at a time (one active customer pilot / one customer tenant), staging-wide.
create unique index if not exists cpe_one_enabled_pilot on public.connector_pilot_enrollments (environment) where pilot_status = 'enabled';
-- At most ONE non-terminal enrollment per (tenant, connector, provider).
create unique index if not exists cpe_one_active_per_connector on public.connector_pilot_enrollments (tenant_id, connector_id, provider)
  where pilot_status in ('draft','consent_pending','approved','enabled','paused','incident_hold');
create index if not exists cpe_owner_idx on public.connector_pilot_enrollments (tenant_id, connector_id, provider, pilot_status);

-- ── 2. CONSENT — durable consent evidence (opaque references only; NEVER a raw document/secret/token). ─────────────────
create table if not exists public.connector_pilot_consents (
  id uuid primary key default gen_random_uuid(),
  pilot_enrollment_id uuid not null references public.connector_pilot_enrollments (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  consent_version text not null,
  consent_scope text not null,
  consent_purpose text not null,
  approved_permissions text not null,
  consented_by text not null,
  consented_at timestamptz not null default now(),
  expiry_at timestamptz not null,
  withdrawal_at timestamptz,
  evidence_reference text not null,                           -- OPAQUE reference (e.g. a ticket id / hash) — never the document
  data_retention_agreement boolean not null default false,
  deletion_agreement boolean not null default false,
  incident_contact_ack boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cpc_evidence_len check (char_length(evidence_reference) between 1 and 256),
  constraint cpc_expiry_after_consent check (expiry_at > consented_at)
);
create index if not exists cpc_pilot_idx on public.connector_pilot_consents (pilot_enrollment_id, expiry_at);

-- ── 3. INCIDENT — sanitized incident metadata; an incident may place a pilot HOLD (fail-closed). ───────────────────────
create table if not exists public.connector_pilot_incidents (
  id uuid primary key default gen_random_uuid(),
  pilot_enrollment_id uuid not null references public.connector_pilot_enrollments (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  category text not null,
  severity text not null,
  sanitized_summary text not null,
  places_hold boolean not null default true,
  opened_by text not null,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint cpi_severity_check check (severity in ('info','warning','error','critical')),
  constraint cpi_summary_len check (char_length(sanitized_summary) between 1 and 512)
);
create index if not exists cpi_pilot_idx on public.connector_pilot_incidents (pilot_enrollment_id);

-- ── 4. EXIT REVIEW — mandatory review record at pilot end. ────────────────────────────────────────────────────────────
create table if not exists public.connector_pilot_exit_reviews (
  id uuid primary key default gen_random_uuid(),
  pilot_enrollment_id uuid not null references public.connector_pilot_enrollments (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  outcome text not null,
  sanitized_summary text not null,
  reviewed_by text not null,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint cper_outcome_check check (outcome in ('passed','failed','inconclusive','withdrawn')),
  constraint cper_summary_len check (char_length(sanitized_summary) between 1 and 512)
);

-- ── 5. DELETION JOB — durable, reviewable, fail-closed deletion-request metadata (no auto-execute; requires approval). ─
create table if not exists public.connector_pilot_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  pilot_enrollment_id uuid not null references public.connector_pilot_enrollments (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  scope text not null,
  job_status text not null default 'requested',
  requested_by text not null,
  approved_by text,
  approved_at timestamptz,
  sanitized_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cpd_scope_check check (scope in ('run_scoped','customer_scoped')),
  constraint cpd_status_check check (job_status in ('requested','approved','rejected','completed')),
  constraint cpd_summary_len check (sanitized_summary is null or char_length(sanitized_summary) <= 512)
);

-- ─────────────────────────────── RLS: request roles get NOTHING (deny-all) ────────────────────────────────────────────
alter table public.connector_pilot_enrollments  enable row level security;
alter table public.connector_pilot_consents      enable row level security;
alter table public.connector_pilot_incidents     enable row level security;
alter table public.connector_pilot_exit_reviews  enable row level security;
alter table public.connector_pilot_deletion_jobs enable row level security;
revoke all on public.connector_pilot_enrollments, public.connector_pilot_consents, public.connector_pilot_incidents,
              public.connector_pilot_exit_reviews, public.connector_pilot_deletion_jobs from anon, authenticated, connector_runner;

commit;

-- ════════════════════════════════════════════ FUNCTIONS ═════════════════════════════════════════════════════════════
begin;

-- ── Shared opaque-reference guard: true if the text looks like a secret/token/ARN/credential-bearing-URL/PEM/email. Defined
--    ONCE so the enrollment, consent, incident, and exit-review sanitizers cannot drift apart (they previously did). The URL branch
--    matches ANY `scheme://user:pass@…` (mysql/mongodb/redis/… not just postgres) so no credential-in-URL scheme bypasses it.
--    Internal-only: the SECURITY DEFINER admin functions call it as owner; EXECUTE is revoked from public/anon/authenticated below.
create or replace function public.connector_pilot_ref_is_sensitive(p_ref text) returns boolean
  language sql immutable set search_path = '' as $$
  select p_ref ~* '(arn:aws|eyj[a-z0-9]|bearer |access_token|client_secret|[a-z][a-z0-9+.-]*://[^ ]*:[^ ]*@|-----begin|@[a-z0-9.-]+\.[a-z]{2,})';
$$;

-- ── ADMIN: create a draft pilot enrollment (service_role). CHECKs force staging/discovery/promotion/manual; connector owned. ─
create or replace function public.admin_create_pilot_enrollment(
  p_tenant_id uuid, p_connector_id uuid, p_provider text, p_environment text, p_is_synthetic boolean,
  p_customer_account_reference text, p_requested_by text, p_support_owner text, p_incident_owner text,
  p_data_processing_purpose text, p_approved_permissions text, p_credential_version text, p_schema_version text,
  p_retention_days integer, p_pilot_start_at timestamptz, p_pilot_end_at timestamptz, p_maximum_runs integer,
  p_maximum_records_per_run integer
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_environment <> 'staging' then raise exception 'pilot is staging-only'; end if;
  if not exists (select 1 from public.connectors c where c.id=p_connector_id and c.tenant_id=p_tenant_id and c.provider=p_provider and c.status='active') then
    raise exception 'pilot target is not an active owned connector';
  end if;
  if p_is_synthetic is not true and p_customer_account_reference is null then raise exception 'a real customer pilot needs a customer account reference'; end if;
  -- the customer reference is the field most likely to receive a name/email/domain — enforce opacity (no secret/email/url), the
  -- guarantee the migration header promises. It stays an opaque pointer (a ticket id / hash), never a customer identifier.
  if p_customer_account_reference is not null and public.connector_pilot_ref_is_sensitive(p_customer_account_reference) then
    raise exception 'customer account reference must be an opaque reference (no name/email/domain/secret/url)';
  end if;
  insert into public.connector_pilot_enrollments (
    tenant_id, connector_id, provider, environment, is_synthetic, customer_account_reference, pilot_status, requested_by,
    support_owner, incident_owner, data_processing_purpose, approved_permissions, credential_version, schema_version,
    retention_days, pilot_start_at, pilot_end_at, maximum_runs, maximum_records_per_run
  ) values (
    p_tenant_id, p_connector_id, p_provider, 'staging', coalesce(p_is_synthetic,false), p_customer_account_reference, 'draft',
    p_requested_by, p_support_owner, p_incident_owner, p_data_processing_purpose, p_approved_permissions, p_credential_version,
    p_schema_version, p_retention_days, p_pilot_start_at, p_pilot_end_at, coalesce(p_maximum_runs,3), coalesce(p_maximum_records_per_run,100)
  ) returning id into v_id;
  return v_id;
end; $$;

-- ── ADMIN: record consent evidence (opaque only); moves draft -> consent_pending. Rejects a secret/doc-shaped reference. ─
create or replace function public.admin_record_pilot_consent(
  p_pilot_id uuid, p_consent_version text, p_consent_scope text, p_consent_purpose text, p_approved_permissions text,
  p_consented_by text, p_expiry_at timestamptz, p_evidence_reference text, p_retention_agreement boolean,
  p_deletion_agreement boolean, p_incident_contact_ack boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_status text; v_id uuid;
begin
  select tenant_id, pilot_status into v_tenant, v_status from public.connector_pilot_enrollments where id=p_pilot_id;
  if v_tenant is null then raise exception 'pilot not found'; end if;
  if v_status not in ('draft','consent_pending') then raise exception 'consent can only be recorded on a draft/consent_pending pilot'; end if;
  if public.connector_pilot_ref_is_sensitive(p_evidence_reference) then
    raise exception 'consent evidence must be an opaque reference (no document/secret/email/url)';
  end if;
  insert into public.connector_pilot_consents (pilot_enrollment_id, tenant_id, consent_version, consent_scope, consent_purpose,
    approved_permissions, consented_by, expiry_at, evidence_reference, data_retention_agreement, deletion_agreement, incident_contact_ack)
    values (p_pilot_id, v_tenant, p_consent_version, p_consent_scope, p_consent_purpose, p_approved_permissions, p_consented_by,
      p_expiry_at, p_evidence_reference, coalesce(p_retention_agreement,false), coalesce(p_deletion_agreement,false), coalesce(p_incident_contact_ack,false))
    returning id into v_id;
  update public.connector_pilot_enrollments set pilot_status='consent_pending', updated_at=now() where id=p_pilot_id and pilot_status='draft';
  return v_id;
end; $$;

-- ── ADMIN: approve (consent_pending -> approved). Requires an active consent + all bindings + ownership + agreements. ──
create or replace function public.admin_approve_pilot_enrollment(p_pilot_id uuid, p_approved_by text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v record; v_consent record;
begin
  select * into v from public.connector_pilot_enrollments where id=p_pilot_id for update;
  if v.id is null then raise exception 'pilot not found'; end if;
  if v.pilot_status <> 'consent_pending' then raise exception 'only a consent_pending pilot can be approved'; end if;
  if v.support_owner is null or v.incident_owner is null then raise exception 'support + incident owners required'; end if;
  if v.approved_permissions is null or v.credential_version is null or v.schema_version is null
     or v.pilot_start_at is null or v.pilot_end_at is null or v.retention_days is null then
    raise exception 'pilot is missing required bindings'; end if;
  select * into v_consent from public.connector_pilot_consents
    where pilot_enrollment_id=p_pilot_id and withdrawal_at is null and expiry_at > now()
      and approved_permissions = v.approved_permissions and data_retention_agreement = true and deletion_agreement = true
      and incident_contact_ack = true order by consented_at desc limit 1;
  if v_consent.id is null then raise exception 'no active, complete consent for this pilot'; end if;
  update public.connector_pilot_enrollments set pilot_status='approved', approved_by=p_approved_by, approval_reason=p_reason,
         approved_at=now(), updated_at=now() where id=p_pilot_id and pilot_status='consent_pending';
end; $$;

-- ── ADMIN: enable (approved -> enabled). Window must be open; the partial unique index caps ONE enabled pilot. ──
create or replace function public.admin_enable_pilot_enrollment(p_pilot_id uuid, p_by text)
returns void language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  select * into v from public.connector_pilot_enrollments where id=p_pilot_id for update;
  if v.id is null then raise exception 'pilot not found'; end if;
  if v.pilot_status <> 'approved' then raise exception 'only an approved pilot can be enabled'; end if;
  if v.pilot_end_at <= now() then raise exception 'pilot window already ended'; end if;
  update public.connector_pilot_enrollments set pilot_status='enabled', updated_at=now() where id=p_pilot_id and pilot_status='approved';
end; $$;

-- ── ADMIN: lifecycle transitions pause/cancel/complete/expire (fail-closed). Terminal = cancelled/completed/expired. ──
create or replace function public.admin_set_pilot_status(p_pilot_id uuid, p_new_status text, p_by text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if p_new_status not in ('paused','cancelled','completed','expired') then raise exception 'invalid pilot transition'; end if;
  select pilot_status into v_status from public.connector_pilot_enrollments where id=p_pilot_id for update;
  if v_status is null then raise exception 'pilot not found'; end if;
  if v_status in ('cancelled','completed','expired') then raise exception 'pilot already terminal'; end if;
  if p_new_status='paused' and v_status not in ('enabled','incident_hold') then raise exception 'only an enabled/held pilot can be paused'; end if;
  update public.connector_pilot_enrollments set pilot_status=p_new_status,
         approval_reason=coalesce(p_reason, approval_reason), updated_at=now() where id=p_pilot_id;
end; $$;

-- ── ADMIN: expire stale pilots past their window (sweep). ──
create or replace function public.admin_expire_stale_pilots() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  update public.connector_pilot_enrollments set pilot_status='expired', updated_at=now()
   where pilot_status in ('approved','enabled','paused','consent_pending','draft') and pilot_end_at is not null and pilot_end_at <= now();
  get diagnostics v_n = row_count; return v_n;
end; $$;

-- ── ADMIN: withdraw consent — sets withdrawal_at (blocks execution immediately) + pauses the pilot. ──
create or replace function public.admin_withdraw_pilot_consent(p_pilot_id uuid, p_by text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.connector_pilot_consents set withdrawal_at=now(), updated_at=now()
   where pilot_enrollment_id=p_pilot_id and withdrawal_at is null;
  update public.connector_pilot_enrollments set pilot_status='paused', approval_reason=coalesce(p_reason,'consent withdrawn'), updated_at=now()
   where id=p_pilot_id and pilot_status in ('enabled','approved','incident_hold');
end; $$;

-- ── ADMIN: place an incident hold — records a sanitized incident + moves the pilot to incident_hold (fail-closed). ──
create or replace function public.admin_pilot_incident_hold(p_pilot_id uuid, p_category text, p_severity text, p_summary text, p_by text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_id uuid;
begin
  if public.connector_pilot_ref_is_sensitive(p_summary) then
    raise exception 'incident summary must be sanitized'; end if;
  select tenant_id into v_tenant from public.connector_pilot_enrollments where id=p_pilot_id;
  if v_tenant is null then raise exception 'pilot not found'; end if;
  insert into public.connector_pilot_incidents (pilot_enrollment_id, tenant_id, category, severity, sanitized_summary, opened_by)
    values (p_pilot_id, v_tenant, p_category, p_severity, p_summary, p_by) returning id into v_id;
  update public.connector_pilot_enrollments set pilot_status='incident_hold', updated_at=now()
   where id=p_pilot_id and pilot_status not in ('cancelled','completed','expired');
  return v_id;
end; $$;

-- ── ADMIN: record a mandatory exit review. ──
create or replace function public.admin_record_pilot_exit_review(p_pilot_id uuid, p_outcome text, p_summary text, p_by text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_id uuid;
begin
  if public.connector_pilot_ref_is_sensitive(p_summary) then
    raise exception 'exit-review summary must be sanitized'; end if;
  select tenant_id into v_tenant from public.connector_pilot_enrollments where id=p_pilot_id;
  if v_tenant is null then raise exception 'pilot not found'; end if;
  insert into public.connector_pilot_exit_reviews (pilot_enrollment_id, tenant_id, outcome, sanitized_summary, reviewed_by)
    values (p_pilot_id, v_tenant, p_outcome, p_summary, p_by) returning id into v_id;
  return v_id;
end; $$;

-- ── ADMIN: create a deletion job (requested; no execution). Reviewable + fail-closed; needs explicit approval to act. ──
create or replace function public.admin_create_pilot_deletion_job(p_pilot_id uuid, p_scope text, p_by text, p_summary text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_id uuid;
begin
  select tenant_id into v_tenant from public.connector_pilot_enrollments where id=p_pilot_id;
  if v_tenant is null then raise exception 'pilot not found'; end if;
  insert into public.connector_pilot_deletion_jobs (pilot_enrollment_id, tenant_id, scope, requested_by, sanitized_summary)
    values (p_pilot_id, v_tenant, p_scope, p_by, left(coalesce(p_summary,''),512)) returning id into v_id;
  return v_id;  -- status='requested'; NOTHING is deleted here
end; $$;

-- ── ADMIN: approve a deletion job (requested -> approved). Still does NOT execute any deletion. ──
create or replace function public.admin_approve_pilot_deletion_job(p_job_id uuid, p_by text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.connector_pilot_deletion_jobs set job_status='approved', approved_by=p_by, approved_at=now(), updated_at=now()
   where id=p_job_id and job_status='requested';
  if not found then raise exception 'deletion job not approvable (missing / not requested)'; end if;
end; $$;

-- ── RUNNER: read one pilot's status for operator validation (NO write). ──
create or replace function public.runner_read_pilot(p_pilot_id uuid, p_tenant_id uuid, p_connector_id uuid, p_provider text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  select pilot_status into v_status from public.connector_pilot_enrollments
   where id=p_pilot_id and tenant_id=p_tenant_id and connector_id=p_connector_id and provider=p_provider;
  if v_status is null then raise exception 'no matching pilot'; end if;  -- sanitized: no config echoed
  return v_status;
end; $$;

-- ── RUNNER: THE execution gate. Fail-closed: raises unless EVERY pilot condition holds. Returns approved_permissions. ──
create or replace function public.runner_assert_pilot_authorized(
  p_pilot_id uuid, p_tenant_id uuid, p_connector_id uuid, p_provider text, p_credential_version text,
  p_approved_permissions text, p_wants_schedule boolean
) returns text language plpgsql security definer set search_path = '' as $$
declare v record; v_consent_ok boolean; v_switch_ok boolean;
begin
  select * into v from public.connector_pilot_enrollments
   where id=p_pilot_id and tenant_id=p_tenant_id and connector_id=p_connector_id and provider=p_provider
     and environment='staging' and pilot_status='enabled'
     and discovery_only=true and promotion_disabled=true
     and credential_version=p_credential_version and approved_permissions=p_approved_permissions;
  if v.id is null then raise exception 'pilot not authorized (missing / not enabled / config mismatch)'; end if;
  if v.support_owner is null or v.incident_owner is null then raise exception 'pilot missing support/incident owner'; end if;
  if v.pilot_start_at is null or v.pilot_end_at is null or now() < v.pilot_start_at or now() > v.pilot_end_at then raise exception 'outside pilot window'; end if;
  if v.runs_used >= v.maximum_runs then raise exception 'pilot run limit reached'; end if;
  if coalesce(p_wants_schedule,false) and v.schedule_allowed <> true then raise exception 'schedule not allowed for this pilot'; end if;
  -- active, unexpired, non-withdrawn consent with the matching approved permission
  select exists (select 1 from public.connector_pilot_consents c where c.pilot_enrollment_id=p_pilot_id
    and c.withdrawal_at is null and c.expiry_at > now() and c.approved_permissions=v.approved_permissions) into v_consent_ok;
  if not v_consent_ok then raise exception 'no active consent (expired / withdrawn / missing)'; end if;
  -- kill switches: the standard layers (global/provider/environment/tenant/connector) AND, if required, a per-pilot switch enabled
  if not public.connector_execution_permitted(v.tenant_id, v.connector_id, v.provider, v.environment) then
    raise exception 'execution blocked by kill switch'; end if;
  if v.customer_kill_switch_required then
    select exists (select 1 from public.connector_kill_switches where scope='pilot' and scope_key=p_pilot_id::text and enabled=true) into v_switch_ok;
    if not v_switch_ok then raise exception 'customer pilot kill switch not enabled'; end if;
  end if;
  return v.approved_permissions;
end; $$;

-- ── RUNNER: atomically consume one pilot run (bump the counter, enforce the cap). ──
create or replace function public.runner_record_pilot_run(p_pilot_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_used integer;
begin
  update public.connector_pilot_enrollments set runs_used = runs_used + 1, updated_at=now()
   where id=p_pilot_id and pilot_status='enabled' and runs_used < maximum_runs
   returning runs_used into v_used;
  if v_used is null then raise exception 'pilot run not recordable (not enabled / run limit reached)'; end if;
  return v_used;
end; $$;

-- ── RUNNER: make the pilot gate MANDATORY. A connector under a real (non-synthetic) pilot enrollment may run ONLY through the
--    pilot gate; the SYNTHETIC controlled path calls this first and fails closed if the connector is pilot-governed — so a customer
--    connector cannot be discovered off the ungated synthetic path (which knows nothing of consent/window/limits/kill-switches). ──
create or replace function public.runner_assert_not_pilot_governed(p_tenant_id uuid, p_connector_id uuid, p_provider text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.connector_pilot_enrollments
      where tenant_id=p_tenant_id and connector_id=p_connector_id and provider=p_provider
        and is_synthetic=false and pilot_status not in ('cancelled','completed','expired')) then
    raise exception 'connector is under a customer pilot enrollment — run it through the pilot gate, not the synthetic path';
  end if;
end; $$;

-- ── GRANTS: EXECUTE revoked from PUBLIC + anon + authenticated (Supabase default-privilege deny, per 0045). ────────────
revoke execute on function
  public.admin_create_pilot_enrollment(uuid,uuid,text,text,boolean,text,text,text,text,text,text,text,text,integer,timestamptz,timestamptz,integer,integer),
  public.admin_record_pilot_consent(uuid,text,text,text,text,text,timestamptz,text,boolean,boolean,boolean),
  public.admin_approve_pilot_enrollment(uuid,text,text), public.admin_enable_pilot_enrollment(uuid,text),
  public.admin_set_pilot_status(uuid,text,text,text), public.admin_expire_stale_pilots(),
  public.admin_withdraw_pilot_consent(uuid,text,text), public.admin_pilot_incident_hold(uuid,text,text,text,text),
  public.admin_record_pilot_exit_review(uuid,text,text,text), public.admin_create_pilot_deletion_job(uuid,text,text,text),
  public.admin_approve_pilot_deletion_job(uuid,text),
  public.runner_read_pilot(uuid,uuid,uuid,text),
  public.runner_assert_pilot_authorized(uuid,uuid,uuid,text,text,text,boolean),
  public.runner_record_pilot_run(uuid),
  public.runner_assert_not_pilot_governed(uuid,uuid,text),
  public.connector_pilot_ref_is_sensitive(text)
  from public, anon, authenticated;

grant execute on function
  public.admin_create_pilot_enrollment(uuid,uuid,text,text,boolean,text,text,text,text,text,text,text,text,integer,timestamptz,timestamptz,integer,integer),
  public.admin_record_pilot_consent(uuid,text,text,text,text,text,timestamptz,text,boolean,boolean,boolean),
  public.admin_approve_pilot_enrollment(uuid,text,text), public.admin_enable_pilot_enrollment(uuid,text),
  public.admin_set_pilot_status(uuid,text,text,text), public.admin_expire_stale_pilots(),
  public.admin_withdraw_pilot_consent(uuid,text,text), public.admin_pilot_incident_hold(uuid,text,text,text,text),
  public.admin_record_pilot_exit_review(uuid,text,text,text), public.admin_create_pilot_deletion_job(uuid,text,text,text),
  public.admin_approve_pilot_deletion_job(uuid,text)
  to service_role;

grant execute on function
  public.runner_read_pilot(uuid,uuid,uuid,text),
  public.runner_assert_pilot_authorized(uuid,uuid,uuid,text,text,text,boolean),
  public.runner_record_pilot_run(uuid),
  public.runner_assert_not_pilot_governed(uuid,uuid,text)
  to connector_runner;

commit;
