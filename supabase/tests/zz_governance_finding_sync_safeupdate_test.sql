-- 0091 — the governance finding sync under hosted safe-update semantics.
--
-- The property this suite protects: the ONE-token correction in 0091 must leave the finding lifecycle exactly as 0083
-- defined it. A migration that redefines a SECURITY DEFINER function owning first_seen_at, reopen_count and the
-- closure gate can silently change any of them, and no amount of reading proves otherwise — so each is re-proven here
-- against the redefined function.
--
-- L10 is the case that mattered on hosted: an EMPTY payload failed too, because the bare DELETE ran before any payload
-- work. When this file runs under `scripts/test-safeupdate.sh` (Supabase's own image with `safeupdate` preloaded), the
-- pre-0091 function fails every one of these and the corrected one passes.

reset role;

insert into public.tenants (id, name, slug) values
  ('5afe0000-0000-4000-8000-00000000000a', 'Safeupdate A', 'safeupdate-a'),
  ('5afe0000-0000-4000-8000-00000000000b', 'Safeupdate B', 'safeupdate-b');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('5afe0000-0000-4000-8000-0000000000c1', '5afe0000-0000-4000-8000-00000000000a', 'okta', 'A', 'pending', 'discovered'),
  ('5afe0000-0000-4000-8000-0000000000c2', '5afe0000-0000-4000-8000-00000000000b', 'okta', 'B', 'pending', 'discovered');

create or replace function public.has_tenant_role(target_tenant_id uuid, allowed_roles text[])
  returns boolean language sql security definer set search_path = public stable as $$ select true $$;

create temporary table sfu_marks (label text, id uuid, first_seen timestamptz, reopen int, reason text, remediation text, status text)
  on commit preserve rows;

do $$
declare
  t  uuid := '5afe0000-0000-4000-8000-00000000000a';
  tb uuid := '5afe0000-0000-4000-8000-00000000000b';
  c  uuid := '5afe0000-0000-4000-8000-0000000000c1';
  cb uuid := '5afe0000-0000-4000-8000-0000000000c2';
  k  text := 'cross-source:discovered_application_unmanaged_by_idp:sfu';
  stem text := 'crossSource.discovered_application_unmanaged_by_idp';
  r jsonb; n int; s text;
  reasons text[] := array['product_unresolved','operational_instance_absent','operational_match_unaccepted'];
  payload jsonb;
begin
  -- ── L10 · EMPTY payload. On hosted this was the proof the failure was structural, not data-shaped. ──────────────
  r := public.product_sync_governance_findings(t, 'cross_source', '1', '[]'::jsonb, '{}');
  assert (r ->> 'reported')::int = 0, 'L10 empty payload must be accepted, got ' || r::text;
  assert (r ->> 'opened')::int = 0 and (r ->> 'closed')::int = 0, 'L10 empty payload changes nothing';

  -- ── L1 · a finding opens ────────────────────────────────────────────────────────────────────────────────────────
  for i in 1..3 loop
    payload := jsonb_build_array(jsonb_build_object(
      'finding_key', k, 'rule_id', 'discovered_application_unmanaged_by_idp',
      'subject_type', 'directory_application', 'subject_id', 'sfu-app-1',
      'severity', 'low', 'confidence', 'medium',
      'title_key',       stem || '.' || reasons[i] || '.title',
      'summary_key',     stem || '.' || reasons[i] || '.summary',
      'remediation_key', stem || '.' || reasons[i] || '.remediation',
      'evidence', jsonb_build_object('counts', jsonb_build_object('applications', 1), 'reason', reasons[i]),
      'source_providers', jsonb_build_array('okta'),
      'evidence_connection_ids', jsonb_build_array(c)));
    r := public.product_sync_governance_findings(t, 'cross_source', '1', payload, array[c]);
    if i = 1 then
      assert (r ->> 'opened')::int = 1, 'L1 first sync opens, got ' || r::text;
    else
      -- ── L2 / L3 · the same subject REFRESHES, including when the reason and copy change ──────────────────────────
      assert (r ->> 'refreshed')::int = 1, 'L2/L3 must refresh, got ' || r::text;
      assert (r ->> 'opened')::int = 0 and (r ->> 'reopened')::int = 0 and (r ->> 'closed')::int = 0,
        'L2/L3 must not open, reopen or close, got ' || r::text;
    end if;
    insert into sfu_marks
      select 'S'||i, id, first_seen_at, reopen_count, evidence_json #>> '{reason}', remediation_key, status
        from public.governance_findings where tenant_id = t and finding_key = k;
  end loop;

  -- ── L4 / L5 · identity, age and reopen_count are stable across every refresh ─────────────────────────────────────
  select count(*) into n from public.governance_findings where tenant_id = t and finding_key = k;
  assert n = 1, 'L4 exactly ONE lifecycle row, got ' || n;
  select count(distinct id)         into n from sfu_marks; assert n = 1, 'L4 the row id is stable';
  select count(distinct first_seen) into n from sfu_marks; assert n = 1, 'L4 first_seen_at is stable';
  select count(distinct reopen)     into n from sfu_marks; assert n = 1, 'L5 reopen_count is stable on refresh';
  assert (select max(reopen) from sfu_marks) = 0, 'L5 reopen_count is still 0';
  select count(distinct reason)      into n from sfu_marks; assert n = 3, 'L3 the reason changed three times';
  select count(distinct remediation) into n from sfu_marks; assert n = 3, 'L3 the remediation key changed three times';

  -- ── L7 · a run that proves nothing must NOT close ────────────────────────────────────────────────────────────────
  r := public.product_sync_governance_findings(t, 'cross_source', '1', '[]'::jsonb, '{}'::uuid[]);
  assert (r ->> 'closed')::int = 0 and (r ->> 'withheld_from_closure')::int = 1,
    'L7 a proof-less run withholds closure, got ' || r::text;
  select status into s from public.governance_findings where tenant_id = t and finding_key = k;
  assert s = 'open', 'L7 the finding stays open, got ' || s;

  -- ── L6 · an absent finding closes when the evidence IS complete ─────────────────────────────────────────────────
  r := public.product_sync_governance_findings(t, 'cross_source', '1', '[]'::jsonb, array[c]);
  assert (r ->> 'closed')::int = 1, 'L6 complete proof closes, got ' || r::text;
  select status into s from public.governance_findings where tenant_id = t and finding_key = k;
  assert s = 'closed', 'L6 status closed, got ' || s;

  -- ── L8 · reappearance reopens, counts the reopen, and STILL keeps first_seen_at ──────────────────────────────────
  r := public.product_sync_governance_findings(t, 'cross_source', '1', payload, array[c]);
  assert (r ->> 'reopened')::int = 1, 'L8 reappearance reopens, got ' || r::text;
  select first_seen_at, reopen_count into s, n from public.governance_findings where tenant_id = t and finding_key = k;
  assert n = 1, 'L8 reopen_count increments to 1, got ' || n;
  assert s::timestamptz = (select min(first_seen) from sfu_marks), 'L8 first_seen_at survives a real reopen';

  -- ── L9 · cross-tenant isolation ─────────────────────────────────────────────────────────────────────────────────
  r := public.product_sync_governance_findings(tb, 'cross_source', '1',
        jsonb_build_array(jsonb_build_object(
          'finding_key', k, 'rule_id', 'discovered_application_unmanaged_by_idp',
          'subject_type', 'directory_application', 'subject_id', 'sfu-app-1',
          'severity', 'low', 'confidence', 'medium',
          'title_key', stem || '.title', 'summary_key', stem || '.summary', 'remediation_key', stem || '.remediation',
          'evidence', jsonb_build_object('counts', jsonb_build_object('applications', 1)),
          'source_providers', jsonb_build_array('okta'),
          'evidence_connection_ids', jsonb_build_array(cb))), array[cb]);
  assert (r ->> 'opened')::int = 1, 'L9 tenant B opens its own';
  select count(*) into n from public.governance_findings where finding_key = k;
  assert n = 2, 'L9 the same key in two tenants is TWO rows, got ' || n;
  select status into s from public.governance_findings where tenant_id = t and finding_key = k;
  assert s = 'open', 'L9 tenant B''s sync must not disturb tenant A, got ' || s;
  -- B still cannot declare A's connection complete.
  begin
    perform public.product_sync_governance_findings(tb, 'cross_source', '1', '[]'::jsonb, array[c]);
    assert false, 'L9 tenant B must not name tenant A''s connection';
  exception when insufficient_privilege then null; end;

  -- ── Two calls in ONE transaction — the reason the clear exists at all. The second must reconcile against its OWN
  --    payload, not inherit the first one's rows.
  r := public.product_sync_governance_findings(t, 'cross_source', '1', payload, array[c]);
  assert (r ->> 'reported')::int = 1, 'clear: first call reports 1';
  r := public.product_sync_governance_findings(t, 'cross_source', '1', '[]'::jsonb, array[c]);
  assert (r ->> 'reported')::int = 0, 'clear: the second call must NOT inherit the first payload, got ' || r::text;
  assert (r ->> 'closed')::int = 1, 'clear: the second call closes what it did not report, got ' || r::text;

  raise notice 'SAFEUPDATE L1-L10 OK — lifecycle identical under the corrected clear';
end $$;
