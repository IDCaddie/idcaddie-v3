-- 0091 — hosted safe-update compatibility for the governance finding sync.
--
-- THE DEFECT, OBSERVED ON HOSTED STAGING AT 0090. `product_sync_governance_findings` failed for EVERY call —
-- including one with an empty payload — with:
--
--     SQLSTATE 21000 · DELETE requires a WHERE clause
--
-- so `governance_findings` could not be written at all. Managed Supabase preloads `safeupdate`, which rejects any
-- UPDATE or DELETE whose parse tree carries no WHERE clause. Stock Postgres does not load it, which is exactly why
-- 43/43 real-DB suites, the full RLS suite, CI, and a schema-identical replica of this database all passed while the
-- hosted call could never have worked. Reproduced locally against `supabase/postgres` with `safeupdate` preloaded:
-- the bare form errors, `where true` succeeds, and a bare UPDATE is rejected too (proving the guard is live).
--
-- THE CORRECTION IS ONE TOKEN. `delete from reported_findings;` becomes `delete from reported_findings where true;`.
-- The statement stays a DELETE, so row counts, triggers, MVCC and rollback behaviour are untouched; `where true` is
-- the predicate safeupdate accepts, verified rather than assumed. The full-clear utility statement would also pass
-- (utility statements are never intercepted) but changes the statement class for no benefit, and a redesign of the
-- reporting table would change finding semantics — neither is warranted for an extension-compatibility defect.
--
-- WHY THE CLEAR EXISTS AT ALL, unchanged: `reported_findings` is `on commit drop`, so it is normally fresh. A second
-- call inside ONE transaction would otherwise inherit the first call's rows and reconcile against a payload that is
-- not the caller's. The clear is a full clear, and `where true` keeps it exactly that.
--
-- 0083 IS NOT EDITED. The function is redefined here so that staging, production and every future environment
-- receive the identical reviewed artifact through the migration chain rather than an ad-hoc fix.
--
-- NOTHING ELSE CHANGES. Same name, signature, return type, volatility, SECURITY DEFINER posture, pinned search_path,
-- role gate, input contract, finding identity, first_seen_at / last_seen_at / reopen_count behaviour, refresh,
-- closure, and withheld_from_closure accounting. The body below is 0083's, byte-for-byte, apart from that one
-- predicate — asserted mechanically by `scripts/../governance-finding-sync-equivalence.test.ts`, not by reading.
--
-- No table, column, index, constraint, policy or RLS change. No new object. No data write. No scheduler.

begin;

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
  delete from reported_findings where true;

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

  -- Both connection-id sets are CALLER-SUPPLIED, and both are load-bearing: one gates closure, the other declares what
  -- a finding depends on. Neither can carry a FK (they are arrays), so ownership is verified here or nowhere. Without
  -- this, declaring another tenant's connector — or a UUID that names nothing at all — is enough to force a close.
  -- Tenant authority itself comes from the has_tenant_role gate above and auth.uid(), never from a parameter.
  if exists (
    select 1 from unnest(p_complete_connection_ids) cid
     where not exists (select 1 from public.connectors c where c.id = cid and c.tenant_id = p_tenant_id)) then
    raise exception 'complete_connection_ids names a connection that does not belong to tenant %', p_tenant_id
      using errcode = '42501';
  end if;
  if exists (
    select 1 from reported_findings r, unnest(r.evidence_connection_ids) cid
     where not exists (select 1 from public.connectors c where c.id = cid and c.tenant_id = p_tenant_id)) then
    raise exception 'evidence_connection_ids names a connection that does not belong to tenant %', p_tenant_id
      using errcode = '42501';
  end if;
  -- A rule that declares no sources cannot ever be proven absent; refuse it here so the failure names the rule rather
  -- than surfacing later as an immortal finding. (The table CHECK is the structural backstop.)
  if exists (select 1 from reported_findings r where cardinality(r.evidence_connection_ids) = 0) then
    raise exception 'every finding must declare at least one evidence connection';
  end if;

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
-- Least privilege, re-asserted rather than assumed. `create or replace` preserves an existing ACL, so on staging this
-- is a no-op; it matters on a database where hosted ALTER DEFAULT PRIVILEGES (0045) has granted EXECUTE to
-- anon/authenticated behind our back. Identical to 0083's block for this function. `connector_runner` produces
-- evidence, never conclusions; `service_role` is deliberately not named, matching the 0061/0073/0078/0082 precedent.
revoke execute on function public.product_sync_governance_findings(uuid, text, text, jsonb, uuid[])
  from public, anon, authenticated, connector_runner;
grant  execute on function public.product_sync_governance_findings(uuid, text, text, jsonb, uuid[])
  to authenticated;

commit;
