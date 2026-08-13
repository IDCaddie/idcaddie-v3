-- 0083 — persisted governance findings, with a lifecycle that refuses to lie when a source went quiet.
--
-- WHY THIS EXISTS. Phase 14's engine (`src/lib/server/governance-analytics/`) computes deterministic findings in memory
-- and writes nothing, so a finding has no age, no history, and no way to be acknowledged. "This has been true for six
-- weeks" and "this is new since Tuesday" are different sentences to an administrator, and neither could be said.
--
-- TWO ENGINES, TWO SCOPES, ONE TABLE. Phase 14 is PROVIDER-LOCAL: its scope is (tenant, connection, provider) and its
-- finding id is folded over that triple. The cross-source engine is TENANT-WIDE: it spans connections and providers by
-- definition, so it has no connection and no provider to name. These are not the same scope and this migration does not
-- pretend they are — `gf_scope_chk` makes a provider-local row REQUIRE its connection+provider and a cross-source row
-- REFUSE both. One table because the LIFECYCLE is identical and worth writing once; two disjoint scope shapes because
-- collapsing them is how one column comes to mean two things.
--
-- ══ THE PROPERTY THIS MIGRATION EXISTS TO GET RIGHT ═══════════════════════════════════════════════════════════════════
-- A finding must NOT close because the evidence that proved it stopped arriving.
--
-- Every rule here is of the form "X is true of the estate". When a rule stops firing there are two possible reasons, and
-- they are opposite: the condition ended, or we stopped being able to see it. A connector that failed, lost a scope, hit
-- a plan limit, or simply had not run yet produces exactly the same silence as a fixed problem. Closing on silence would
-- mark a suspended employee's live SaaS account "resolved" because the SaaS connector was broken that morning — the
-- single worst failure this table could have, because it is invisible and it reads as progress.
--
-- So closure is EVIDENCE-GATED, not absence-gated. Each finding records `evidence_connection_ids`: the connections whose
-- facts the rule actually read. A sync declares `p_complete_connection_ids`: the connections that produced COMPLETE,
-- CURRENT evidence for this evaluation. A finding closes only when every connection it depends on is in that set
-- (`evidence_connection_ids <@ complete`). Otherwise it is WITHHELD — left open, untouched, and counted in the return
-- value, so an incomplete run is a number a caller can see rather than a silent state change.
--
-- The 0053/0077 complete-and-clean-run gate is the same idea one layer down; this is that discipline applied to findings.

create table if not exists public.governance_findings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  -- WHICH ENGINE PRODUCED THIS. The two evaluation scopes stay distinguishable forever.
  engine text not null,
  constraint gf_engine_chk check (engine in ('provider_local', 'cross_source')),

  -- The deterministic identity, computed by the engine from canonical row ids alone (never a label, email or
  -- external_id — those are mutable, and a finding whose identity moves when someone is renamed has no lifecycle).
  -- The domain prefix is CHECKed per engine so the two id spaces can never collide into one row.
  finding_key text not null,
  constraint gf_key_domain_chk check (
    (engine = 'provider_local' and finding_key like 'governance:%') or
    (engine = 'cross_source'   and finding_key like 'cross-source:%')),

  rule_id text not null,
  -- Which version of the rule produced this. A rule whose definition changes produces different findings, and an
  -- administrator comparing last month to this month needs to know which of the two moved.
  rule_version text not null,

  -- SOURCE SCOPE METADATA. Required for provider-local, forbidden for cross-source — see the header.
  connection_id uuid,
  provider text,
  constraint gf_scope_chk check (
    (engine = 'provider_local' and connection_id is not null and provider is not null) or
    (engine = 'cross_source'   and connection_id is null     and provider is null)),

  -- The subject is `text`, not `uuid`: Phase 14 uses a per-scope hash TOKEN as the subject of a graph diagnostic, and a
  -- uuid column would force that rule family out of the table. No FK for the same reason a polymorphic FK is impossible
  -- across person / account / group / application — the id is canonical, and the engine is the thing that guarantees it.
  subject_type text not null,
  subject_id text not null,

  severity text not null,
  constraint gf_severity_chk check (severity in ('info', 'low', 'medium', 'high')),
  -- Kept SEPARATE from severity, exactly as Phase 14 keeps them: how bad it is and how sure we are are different axes,
  -- and folding them produces a "medium" that means neither.
  confidence text not null,
  constraint gf_confidence_chk check (confidence in ('high', 'medium', 'low')),

  -- Message KEYS, never prose. Phase 14 defers wording to the UI so one rule can be reworded without a migration.
  title_key text not null,
  summary_key text not null,
  remediation_key text,

  -- Bounded, PII-free evidence: counts, canonical row ids, sync_status values. The Phase 14 privacy rule applies
  -- unchanged — never an external_id, email, login, label, URL, token or profile datum.
  evidence_json jsonb not null default '{}'::jsonb,
  constraint gf_evidence_object_chk check (jsonb_typeof(evidence_json) = 'object'),
  -- Which providers contributed, for display and filtering. Provenance, not identity.
  source_providers text[] not null default '{}',
  -- THE CLOSURE GATE. The connections whose evidence this finding rests on; see the header.
  evidence_connection_ids uuid[] not null default '{}',

  status text not null default 'open',
  constraint gf_status_chk check (status in ('open', 'closed')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint gf_resolved_chk check (
    (status = 'open' and resolved_at is null) or (status = 'closed' and resolved_at is not null)),
  -- How many times this exact condition came back after being resolved. A finding that reopens four times is a process
  -- problem rather than an incident, and that is only visible if the row survives the close.
  reopen_count integer not null default 0,
  constraint gf_reopen_nonneg_chk check (reopen_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ONE row per deterministic identity per tenant. This is what makes "no duplicate open finding for the same identity"
  -- structural rather than a property of the sync function: a second open row cannot be inserted even by hand.
  constraint gf_identity_key unique (tenant_id, finding_key)
);

create index if not exists gf_open_idx on public.governance_findings (tenant_id, engine, severity)
  where status = 'open';
create index if not exists gf_subject_idx on public.governance_findings (tenant_id, subject_type, subject_id);

-- RLS on, ZERO policies — the posture of every directory_*, app_account_* and person_account_links table. Reads go
-- through a product RPC or not at all. The runner is revoked: a finding is a conclusion drawn from evidence, and the
-- runner's job ends at the evidence.
alter table public.governance_findings enable row level security;
revoke all on public.governance_findings from anon, authenticated, connector_runner;

-- ══ SYNC ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- One evaluation's worth of findings, reconciled against what is already open.
--
--   p_findings                 the findings the engine asserts are TRUE RIGHT NOW (a jsonb array)
--   p_complete_connection_ids  the connections that produced COMPLETE, CURRENT evidence for this evaluation — the
--                              caller's honest declaration of what it could actually see. Pass '{}' and nothing that
--                              depends on a connector can close, which is the correct behaviour for a partial run.
--
-- Reported     -> inserted (new), or refreshed (already open), or REOPENED (was closed) with first_seen_at preserved.
-- Not reported -> closed ONLY IF every connection it depends on is in p_complete_connection_ids; otherwise WITHHELD.
--
-- Deterministic and idempotent: syncing the same findings twice changes nothing but `last_seen_at`.
create or replace function public.product_sync_governance_findings(
  p_tenant_id uuid,
  p_engine text,
  p_rule_version text,
  p_findings jsonb,
  p_complete_connection_ids uuid[] default '{}'
) returns jsonb language plpgsql security definer set search_path = public volatile as $$
declare
  v_opened integer := 0; v_reopened integer := 0; v_refreshed integer := 0;
  v_closed integer := 0; v_withheld integer := 0; v_reported integer := 0; v_upserted integer := 0;
  v_now timestamptz := now();
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    raise exception 'not authorized for tenant %', p_tenant_id using errcode = '42501';
  end if;
  if p_engine not in ('provider_local', 'cross_source') then
    raise exception 'unknown engine %', p_engine;
  end if;
  if jsonb_typeof(p_findings) <> 'array' then
    raise exception 'p_findings must be a jsonb array';
  end if;

  -- Materialize the reported set once; every branch below reads it.
  create temporary table if not exists reported_findings (
    finding_key text primary key, rule_id text, connection_id uuid, provider text,
    subject_type text, subject_id text, severity text, confidence text,
    title_key text, summary_key text, remediation_key text,
    evidence_json jsonb, source_providers text[], evidence_connection_ids uuid[]
  ) on commit drop;
  delete from reported_findings;

  insert into reported_findings
  select
    f ->> 'finding_key', f ->> 'rule_id',
    nullif(f ->> 'connection_id', '')::uuid, nullif(f ->> 'provider', ''),
    f ->> 'subject_type', f ->> 'subject_id', f ->> 'severity', f ->> 'confidence',
    f ->> 'title_key', f ->> 'summary_key', nullif(f ->> 'remediation_key', ''),
    coalesce(f -> 'evidence', '{}'::jsonb),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(f -> 'source_providers')), '{}'),
    coalesce((select array_agg(value::uuid) from jsonb_array_elements_text(f -> 'evidence_connection_ids')), '{}')
  from jsonb_array_elements(p_findings) f
  -- A duplicate key inside ONE payload is an engine bug, not a lifecycle event. Take the first and let the
  -- primary key refuse the rest loudly rather than silently last-write-wins.
  on conflict (finding_key) do nothing;

  select count(*) into v_reported from reported_findings;

  -- Classify BEFORE the upsert, against the rows as they stand. Deriving "was this closed?" from the upsert's own
  -- output cannot work — RETURNING sees the new row, so a finding that reopened during some EARLIER sync and is merely
  -- being refreshed now looks identical to one reopening this instant.
  select
    count(*) filter (where g.id is null),
    count(*) filter (where g.status = 'open'),
    count(*) filter (where g.status = 'closed')
  into v_opened, v_refreshed, v_reopened
  from reported_findings r
  left join public.governance_findings g
    on g.tenant_id = p_tenant_id and g.finding_key = r.finding_key;

  -- ── Reported: insert, refresh, or reopen. first_seen_at is NEVER moved — it is the age of the condition. ───────────
  with upserted as (
    insert into public.governance_findings (
      tenant_id, engine, finding_key, rule_id, rule_version, connection_id, provider,
      subject_type, subject_id, severity, confidence, title_key, summary_key, remediation_key,
      evidence_json, source_providers, evidence_connection_ids,
      status, first_seen_at, last_seen_at, resolved_at)
    select p_tenant_id, p_engine, r.finding_key, r.rule_id, p_rule_version, r.connection_id, r.provider,
           r.subject_type, r.subject_id, r.severity, r.confidence, r.title_key, r.summary_key, r.remediation_key,
           r.evidence_json, r.source_providers, r.evidence_connection_ids,
           'open', v_now, v_now, null
      from reported_findings r
    on conflict (tenant_id, finding_key) do update set
      -- The rule's current assessment wins: severity, confidence and evidence are properties of the CONDITION now.
      rule_version = excluded.rule_version,
      severity = excluded.severity, confidence = excluded.confidence,
      title_key = excluded.title_key, summary_key = excluded.summary_key, remediation_key = excluded.remediation_key,
      evidence_json = excluded.evidence_json, source_providers = excluded.source_providers,
      evidence_connection_ids = excluded.evidence_connection_ids,
      last_seen_at = v_now,
      status = 'open',
      resolved_at = null,
      reopen_count = public.governance_findings.reopen_count
                     + case when public.governance_findings.status = 'closed' then 1 else 0 end,
      updated_at = v_now
    returning 1)
  select count(*) into v_upserted from upserted;

  -- ── Not reported: close ONLY with sufficient evidence. This is the whole point of the migration. ───────────────────
  with closable as (
    select g.id, (g.evidence_connection_ids <@ p_complete_connection_ids) as covered
      from public.governance_findings g
     where g.tenant_id = p_tenant_id and g.engine = p_engine and g.status = 'open'
       and not exists (select 1 from reported_findings r where r.finding_key = g.finding_key)
  ), closed as (
    update public.governance_findings g
       set status = 'closed', resolved_at = v_now, updated_at = v_now
      from closable c
     where g.id = c.id and c.covered
    returning 1)
  select (select count(*) from closed), (select count(*) from closable where not covered)
    into v_closed, v_withheld;

  return jsonb_build_object(
    'reported', v_reported,
    'opened', v_opened,
    'reopened', v_reopened,
    'refreshed', v_refreshed,
    'closed', v_closed,
    -- Findings left open because the run could not prove they had ended. A caller that ignores this number is reading
    -- an evaluation as complete when it was not.
    'withheld_from_closure', v_withheld);
end $$;

-- ══ READ ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Bounded, tenant-gated, no external ids. Deliberately minimal: the product surface is a later PR, and a read that
-- exists before its consumer grows filters nobody asked for.
create or replace function public.product_governance_findings(
  p_tenant_id uuid, p_engine text default null, p_status text default 'open', p_limit integer default 100
) returns table (
  id uuid, engine text, rule_id text, rule_version text, connection_id uuid, provider text,
  subject_type text, subject_id text, severity text, confidence text,
  title_key text, summary_key text, remediation_key text, evidence_json jsonb,
  source_providers text[], status text, first_seen_at timestamptz, last_seen_at timestamptz,
  resolved_at timestamptz, reopen_count integer
) language sql security definer set search_path = public stable as $$
  select g.id, g.engine, g.rule_id, g.rule_version, g.connection_id, g.provider,
         g.subject_type, g.subject_id, g.severity, g.confidence,
         g.title_key, g.summary_key, g.remediation_key, g.evidence_json,
         g.source_providers, g.status, g.first_seen_at, g.last_seen_at, g.resolved_at, g.reopen_count
    from public.governance_findings g
   where public.has_tenant_role(p_tenant_id, array['owner', 'admin'])
     and g.tenant_id = p_tenant_id
     and (p_engine is null or g.engine = p_engine)
     and (p_status is null or g.status = p_status)
   order by case g.severity when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end,
            g.first_seen_at, g.id
   limit least(coalesce(p_limit, 100), 500);
$$;

-- ══ LEAST PRIVILEGE ════════════════════════════════════════════════════════════════════════════════════════════════════
-- Hosted Supabase's ALTER DEFAULT PRIVILEGES (0045) grants EXECUTE on new public functions straight to anon/authenticated
-- and `revoke from public` alone does not remove it, so every role is named. `connector_runner` is revoked: it produces
-- evidence, never conclusions. `service_role` is deliberately not named, matching the 0061/0073/0078/0082 precedent.
do $$
declare f text;
begin
  foreach f in array array[
    'public.product_sync_governance_findings(uuid, text, text, jsonb, uuid[])',
    'public.product_governance_findings(uuid, text, text, integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated, connector_runner', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
