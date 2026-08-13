-- 0083 — persisted governance findings.
--
-- The property this suite exists to protect: **a finding must never close because a source went quiet.** Everything
-- else here — grants, isolation, reopen counting — is ordinary care. G5 is the one that matters, because its failure
-- mode is silent and reads as progress: a suspended employee's live SaaS account marked resolved on the morning the
-- SaaS connector happened to be broken.

reset role;

insert into public.tenants (id, name, slug) values
  ('f6000000-0000-4000-8000-00000000000a', 'Finding A', 'finding-a'),
  ('f6000000-0000-4000-8000-00000000000b', 'Finding B', 'finding-b');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('f6000000-0000-4000-8000-0000000000c1', 'f6000000-0000-4000-8000-00000000000a', 'okta',  'Okta A',  'pending', 'discovered'),
  ('f6000000-0000-4000-8000-0000000000c2', 'f6000000-0000-4000-8000-00000000000a', 'slack', 'Slack A', 'pending', 'discovered'),
  ('f6000000-0000-4000-8000-0000000000c3', 'f6000000-0000-4000-8000-00000000000b', 'okta',  'Okta B',  'pending', 'discovered');

-- ════ G0: deny-all table, product-only functions ══════════════════════════════════════════════════════════════════
do $$
declare f text;
begin
  assert (select relrowsecurity from pg_class where oid = 'public.governance_findings'::regclass),
    'G0 RLS enabled';
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename = 'governance_findings') = 0,
    'G0 no policy — reads go through a product RPC or not at all';
  foreach f in array array[
    'public.product_sync_governance_findings(uuid,text,text,jsonb,uuid[])',
    'public.product_governance_findings(uuid,text,text,integer)']
  loop
    assert     has_function_privilege('authenticated', f, 'EXECUTE'), 'G0 authenticated EXECUTE ' || f;
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'G0 anon denied ' || f;
    assert not has_function_privilege('public', f, 'EXECUTE'), 'G0 PUBLIC denied ' || f;
    -- The runner produces evidence, never conclusions.
    assert not has_function_privilege('connector_runner', f, 'EXECUTE'), 'G0 connector_runner denied ' || f;
    assert (select array_to_string(proconfig, ',') from pg_proc where oid = f::regprocedure) like 'search_path=%',
      'G0 pinned search_path ' || f;
  end loop;
  assert not has_table_privilege('authenticated', 'public.governance_findings', 'SELECT'), 'G0 no direct read';
  assert not has_table_privilege('connector_runner', 'public.governance_findings', 'INSERT'), 'G0 runner cannot write';
end $$;

-- ════ G1: the role gate refuses, and a refused sync writes nothing ════════════════════════════════════════════════
do $$
declare msg text; n int;
begin
  begin
    perform public.product_sync_governance_findings(
      'f6000000-0000-4000-8000-00000000000a', 'cross_source', 'v1',
      '[{"finding_key":"cross-source:x:1","rule_id":"r","subject_type":"person","subject_id":"s",
         "severity":"high","confidence":"high","title_key":"t","summary_key":"s"}]'::jsonb, '{}');
    assert false, 'G1 the gate must refuse';
  exception when insufficient_privilege then msg := sqlerrm;
  end;
  assert msg like 'not authorized%', 'G1 refused by the role gate, got: ' || msg;
  select count(*) into n from public.governance_findings;
  assert n = 0, 'G1 a refused sync writes nothing, found ' || n;
end $$;

-- ── Authorized from here. A definer function keeps its own privileges, so replacing the gate is enough.
-- Parameter NAMES must match 0001 exactly — `create or replace function` refuses to rename an input parameter.
create or replace function public.has_tenant_role(target_tenant_id uuid, allowed_roles text[])
  returns boolean language sql security definer set search_path = public stable as $$ select true $$;

-- ════ G2: the two engines carry DIFFERENT scope shapes, and the database enforces the difference ══════════════════
do $$
declare msg text;
begin
  -- provider_local without its connection+provider is not a provider-local finding.
  begin
    insert into public.governance_findings
      (tenant_id, engine, finding_key, rule_id, rule_version, subject_type, subject_id, severity, confidence,
       title_key, summary_key)
    values ('f6000000-0000-4000-8000-00000000000a', 'provider_local', 'governance:r:1', 'r', 'v1',
            'identity', 'i1', 'high', 'high', 't', 's');
    assert false, 'G2 provider_local REQUIRES connection_id + provider';
  exception when check_violation then null;
  end;
  -- cross_source WITH a connection is a provider-local finding wearing the wrong label.
  begin
    insert into public.governance_findings
      (tenant_id, engine, finding_key, rule_id, rule_version, connection_id, provider, subject_type, subject_id,
       severity, confidence, title_key, summary_key)
    values ('f6000000-0000-4000-8000-00000000000a', 'cross_source', 'cross-source:r:1', 'r', 'v1',
            'f6000000-0000-4000-8000-0000000000c1', 'okta', 'person', 'p1', 'high', 'high', 't', 's');
    assert false, 'G2 cross_source REFUSES a connection/provider — it is tenant-wide by definition';
  exception when check_violation then null;
  end;
  -- The two id spaces cannot collide into one row: each engine's key must carry its own domain prefix.
  begin
    insert into public.governance_findings
      (tenant_id, engine, finding_key, rule_id, rule_version, subject_type, subject_id, severity, confidence,
       title_key, summary_key)
    values ('f6000000-0000-4000-8000-00000000000a', 'cross_source', 'governance:r:1', 'r', 'v1',
            'person', 'p1', 'high', 'high', 't', 's');
    assert false, 'G2 a cross-source key must not live in the provider-local id space';
  exception when check_violation then null;
  end;
end $$;

-- ════ G3: opening, and idempotent re-sync ═════════════════════════════════════════════════════════════════════════
-- Split across two transactions on purpose: `now()` is the TRANSACTION timestamp, so a single DO block would compare
-- last_seen_at against itself and the assertion would pass without testing anything. The function keeps `now()` rather
-- than `clock_timestamp()` deliberately — every row in one sync should carry one observation time.
create temp table g3_marks (k text primary key, first_seen timestamptz, last_seen timestamptz);

do $$
declare r jsonb;
begin
  r := public.product_sync_governance_findings(
    'f6000000-0000-4000-8000-00000000000a', 'cross_source', 'v1',
    format('[
      {"finding_key":"cross-source:saas_account_without_identity:A","rule_id":"saas_account_without_identity",
       "subject_type":"app_account","subject_id":"acct-A","severity":"medium","confidence":"high",
       "title_key":"t.a","summary_key":"s.a","remediation_key":"rem.a",
       "evidence":{"counts":{"accounts":1}},"source_providers":["slack"],
       "evidence_connection_ids":["%s","%s"]},
      {"finding_key":"cross-source:suspended_identity_active_saas:B","rule_id":"suspended_identity_active_saas",
       "subject_type":"person","subject_id":"person-B","severity":"high","confidence":"high",
       "title_key":"t.b","summary_key":"s.b",
       "evidence":{"counts":{"accounts":1}},"source_providers":["okta","slack"],
       "evidence_connection_ids":["%s"]}]',
      'f6000000-0000-4000-8000-0000000000c1', 'f6000000-0000-4000-8000-0000000000c2',
      'f6000000-0000-4000-8000-0000000000c1')::jsonb,
    '{}');
  assert (r ->> 'opened')::int = 2, 'G3 two findings opened, got ' || (r ->> 'opened');
  assert (r ->> 'closed')::int = 0, 'G3 nothing to close on a first run';
  insert into g3_marks select 'A', first_seen_at, last_seen_at from public.governance_findings
   where finding_key = 'cross-source:saas_account_without_identity:A';
end $$;

do $$
declare r jsonb; n int; f2 timestamptz; l2 timestamptz; m record;
begin
  -- Re-reporting the SAME findings is a refresh, not a second finding.
  r := public.product_sync_governance_findings(
    'f6000000-0000-4000-8000-00000000000a', 'cross_source', 'v1',
    format('[
      {"finding_key":"cross-source:saas_account_without_identity:A","rule_id":"saas_account_without_identity",
       "subject_type":"app_account","subject_id":"acct-A","severity":"medium","confidence":"high",
       "title_key":"t.a","summary_key":"s.a","evidence":{},"source_providers":["slack"],
       "evidence_connection_ids":["%s","%s"]},
      {"finding_key":"cross-source:suspended_identity_active_saas:B","rule_id":"suspended_identity_active_saas",
       "subject_type":"person","subject_id":"person-B","severity":"high","confidence":"high",
       "title_key":"t.b","summary_key":"s.b","evidence":{},"source_providers":["okta","slack"],
       "evidence_connection_ids":["%s"]}]',
      'f6000000-0000-4000-8000-0000000000c1', 'f6000000-0000-4000-8000-0000000000c2',
      'f6000000-0000-4000-8000-0000000000c1')::jsonb,
    array['f6000000-0000-4000-8000-0000000000c1','f6000000-0000-4000-8000-0000000000c2']::uuid[]);
  assert (r ->> 'opened')::int = 0, 'G3 a re-sync opens nothing';
  assert (r ->> 'refreshed')::int = 2, 'G3 both refreshed, got ' || (r ->> 'refreshed');
  assert (r ->> 'reopened')::int = 0, 'G3 nothing reopened';

  select count(*) into n from public.governance_findings
   where tenant_id = 'f6000000-0000-4000-8000-00000000000a';
  assert n = 2, 'G3 still two rows — one per deterministic identity, got ' || n;

  select * into m from g3_marks where k = 'A';
  select first_seen_at, last_seen_at into f2, l2 from public.governance_findings
   where finding_key = 'cross-source:saas_account_without_identity:A';
  assert f2 = m.first_seen, 'G3 first_seen_at NEVER moves — it is the age of the condition';
  assert l2 > m.last_seen, 'G3 last_seen_at advances';
end $$;

-- ════ G4: a second OPEN row for one identity is impossible, by constraint rather than by function ═════════════════
do $$
begin
  begin
    insert into public.governance_findings
      (tenant_id, engine, finding_key, rule_id, rule_version, subject_type, subject_id, severity, confidence,
       title_key, summary_key)
    values ('f6000000-0000-4000-8000-00000000000a', 'cross_source',
            'cross-source:saas_account_without_identity:A', 'r', 'v1', 'app_account', 'acct-A', 'low', 'low', 't', 's');
    assert false, 'G4 no duplicate finding for one deterministic identity';
  exception when unique_violation then null;
  end;
end $$;

-- ════ G5: THE ONE THAT MATTERS — a finding must NOT close because its source went quiet ═══════════════════════════
do $$
declare r jsonb; st text; res timestamptz; seen timestamptz; seen_after timestamptz;
begin
  select last_seen_at into seen from public.governance_findings
   where finding_key = 'cross-source:saas_account_without_identity:A';

  -- The Slack connector broke. The rule stops firing for finding A — not because the account was linked, but because
  -- we cannot see Slack at all. The run declares only Okta complete, which is the truth about what it could read.
  r := public.product_sync_governance_findings(
    'f6000000-0000-4000-8000-00000000000a', 'cross_source', 'v1', '[]'::jsonb,
    array['f6000000-0000-4000-8000-0000000000c1']::uuid[]);

  select status, resolved_at, last_seen_at into st, res, seen_after from public.governance_findings
   where finding_key = 'cross-source:saas_account_without_identity:A';
  assert st = 'open', 'G5 a finding whose evidence source was INCOMPLETE must stay open, got ' || st;
  assert res is null, 'G5 and must not be stamped resolved';
  assert seen_after = seen, 'G5 and must not be touched at all — silence is not an observation';
  assert (r ->> 'withheld_from_closure')::int = 1,
    'G5 the withheld count makes the incomplete run VISIBLE, got ' || (r ->> 'withheld_from_closure');

  -- Finding B depends only on Okta, which WAS complete — so its absence is real evidence, and it closes.
  select status into st from public.governance_findings
   where finding_key = 'cross-source:suspended_identity_active_saas:B';
  assert st = 'closed', 'G5 a finding whose sources were ALL complete closes on absence, got ' || st;
  assert (r ->> 'closed')::int = 1, 'G5 exactly one closed, got ' || (r ->> 'closed');
end $$;

-- ════ G6: with complete evidence, absence closes ══════════════════════════════════════════════════════════════════
do $$
declare r jsonb; st text; res timestamptz;
begin
  r := public.product_sync_governance_findings(
    'f6000000-0000-4000-8000-00000000000a', 'cross_source', 'v1', '[]'::jsonb,
    array['f6000000-0000-4000-8000-0000000000c1','f6000000-0000-4000-8000-0000000000c2']::uuid[]);
  select status, resolved_at into st, res from public.governance_findings
   where finding_key = 'cross-source:saas_account_without_identity:A';
  assert st = 'closed', 'G6 now that Slack is complete, absence is evidence — got ' || st;
  assert res is not null, 'G6 resolved_at is stamped on close';
  assert (r ->> 'withheld_from_closure')::int = 0, 'G6 nothing withheld once every source reported';
end $$;

-- ════ G7: reopen — the row survives the close, the age survives the reopen ════════════════════════════════════════
do $$
declare r jsonb; f1 timestamptz; f2 timestamptz; rc int; st text; res timestamptz;
begin
  select first_seen_at into f1 from public.governance_findings
   where finding_key = 'cross-source:saas_account_without_identity:A';

  r := public.product_sync_governance_findings(
    'f6000000-0000-4000-8000-00000000000a', 'cross_source', 'v1',
    '[{"finding_key":"cross-source:saas_account_without_identity:A","rule_id":"saas_account_without_identity",
       "subject_type":"app_account","subject_id":"acct-A","severity":"medium","confidence":"high",
       "title_key":"t.a","summary_key":"s.a","evidence":{},"source_providers":["slack"],
       "evidence_connection_ids":[]}]'::jsonb,
    array['f6000000-0000-4000-8000-0000000000c1','f6000000-0000-4000-8000-0000000000c2']::uuid[]);
  assert (r ->> 'reopened')::int = 1, 'G7 the condition came back, got ' || (r ->> 'reopened');
  assert (r ->> 'opened')::int = 0, 'G7 a reopen is not a new finding';

  select first_seen_at, reopen_count, status, resolved_at into f2, rc, st, res
    from public.governance_findings where finding_key = 'cross-source:saas_account_without_identity:A';
  assert st = 'open', 'G7 open again';
  assert res is null, 'G7 resolved_at cleared';
  assert rc = 1, 'G7 reopen_count advanced, got ' || rc;
  assert f2 = f1, 'G7 and first_seen_at STILL the original — a recurring condition is not a new one';

  -- Refreshing a reopened finding must not advance the count again: reopen is a TRANSITION, not a state.
  r := public.product_sync_governance_findings(
    'f6000000-0000-4000-8000-00000000000a', 'cross_source', 'v1',
    '[{"finding_key":"cross-source:saas_account_without_identity:A","rule_id":"saas_account_without_identity",
       "subject_type":"app_account","subject_id":"acct-A","severity":"medium","confidence":"high",
       "title_key":"t.a","summary_key":"s.a","evidence":{},"source_providers":["slack"],
       "evidence_connection_ids":[]}]'::jsonb,
    array['f6000000-0000-4000-8000-0000000000c1','f6000000-0000-4000-8000-0000000000c2']::uuid[]);
  assert (r ->> 'reopened')::int = 0, 'G7 refreshing an already-open finding is not a reopen';
  select reopen_count into rc from public.governance_findings
   where finding_key = 'cross-source:saas_account_without_identity:A';
  assert rc = 1, 'G7 reopen_count unchanged by a refresh, got ' || rc;
end $$;

-- ════ G8: the two engines do not close each other ═════════════════════════════════════════════════════════════════
-- A provider-local sync reports nothing about cross-source findings, and must not resolve them by omission.
do $$
declare r jsonb; st text;
begin
  r := public.product_sync_governance_findings(
    'f6000000-0000-4000-8000-00000000000a', 'provider_local', 'v1',
    format('[{"finding_key":"governance:identity_without_effective_access:X",
              "rule_id":"identity_without_effective_access","connection_id":"%s","provider":"okta",
              "subject_type":"identity","subject_id":"ident-X","severity":"info","confidence":"high",
              "title_key":"t.x","summary_key":"s.x","evidence":{},"source_providers":["okta"],
              "evidence_connection_ids":["%s"]}]',
      'f6000000-0000-4000-8000-0000000000c1', 'f6000000-0000-4000-8000-0000000000c1')::jsonb,
    array['f6000000-0000-4000-8000-0000000000c1','f6000000-0000-4000-8000-0000000000c2']::uuid[]);
  assert (r ->> 'opened')::int = 1, 'G8 the provider-local finding opened';
  assert (r ->> 'closed')::int = 0, 'G8 and it closed NOTHING belonging to the other engine';

  select status into st from public.governance_findings
   where finding_key = 'cross-source:saas_account_without_identity:A';
  assert st = 'open', 'G8 the cross-source finding is untouched by a provider-local run, got ' || st;
end $$;

-- ════ G9: CROSS-TENANT ISOLATION ══════════════════════════════════════════════════════════════════════════════════
do $$
declare r jsonb; n int; st text;
begin
  -- Tenant B syncs an EMPTY evaluation declaring every connection complete. Nothing of tenant A's may close.
  r := public.product_sync_governance_findings(
    'f6000000-0000-4000-8000-00000000000b', 'cross_source', 'v1', '[]'::jsonb,
    array['f6000000-0000-4000-8000-0000000000c1','f6000000-0000-4000-8000-0000000000c2',
          'f6000000-0000-4000-8000-0000000000c3']::uuid[]);
  assert (r ->> 'closed')::int = 0, 'G9 tenant B closed nothing — it has nothing';

  select status into st from public.governance_findings
   where finding_key = 'cross-source:saas_account_without_identity:A';
  assert st = 'open', 'G9 tenant A''s finding survives tenant B''s sync, got ' || st;

  -- The same deterministic key in two tenants is two findings, not one.
  r := public.product_sync_governance_findings(
    'f6000000-0000-4000-8000-00000000000b', 'cross_source', 'v1',
    '[{"finding_key":"cross-source:saas_account_without_identity:A","rule_id":"saas_account_without_identity",
       "subject_type":"app_account","subject_id":"acct-A","severity":"medium","confidence":"high",
       "title_key":"t.a","summary_key":"s.a","evidence":{},"source_providers":["slack"],
       "evidence_connection_ids":[]}]'::jsonb, '{}');
  assert (r ->> 'opened')::int = 1, 'G9 tenant B opens its own';
  select count(*) into n from public.governance_findings
   where finding_key = 'cross-source:saas_account_without_identity:A';
  assert n = 2, 'G9 one row per tenant per identity, got ' || n;

  -- And the read RPC never crosses.
  select count(*) into n from public.product_governance_findings('f6000000-0000-4000-8000-00000000000b', null, 'open', 100);
  assert n = 1, 'G9 tenant B reads only its own, got ' || n;
end $$;

-- ════ G10: the read is ordered by severity and filters by engine and status ═══════════════════════════════════════
do $$
declare first_sev text; n int;
begin
  select severity into first_sev from public.product_governance_findings(
    'f6000000-0000-4000-8000-00000000000a', null, 'open', 100) limit 1;
  assert first_sev = 'medium', 'G10 highest severity first (medium outranks the info row), got ' || first_sev;

  select count(*) into n from public.product_governance_findings(
    'f6000000-0000-4000-8000-00000000000a', 'provider_local', 'open', 100);
  assert n = 1, 'G10 engine filter, got ' || n;

  select count(*) into n from public.product_governance_findings(
    'f6000000-0000-4000-8000-00000000000a', 'cross_source', 'closed', 100);
  assert n = 1, 'G10 the resolved B finding is still readable as closed, got ' || n;
end $$;

-- ════ G11: a malformed payload is refused loudly ══════════════════════════════════════════════════════════════════
do $$
declare msg text;
begin
  begin
    perform public.product_sync_governance_findings(
      'f6000000-0000-4000-8000-00000000000a', 'cross_source', 'v1', '{"not":"an array"}'::jsonb, '{}');
    assert false, 'G11 a non-array payload must be refused';
  exception when others then msg := sqlerrm;
  end;
  assert msg like '%must be a jsonb array%', 'G11 refused for the stated reason, got: ' || msg;

  begin
    perform public.product_sync_governance_findings(
      'f6000000-0000-4000-8000-00000000000a', 'nonsense', 'v1', '[]'::jsonb, '{}');
    assert false, 'G11 an unknown engine must be refused';
  exception when others then msg := sqlerrm;
  end;
  assert msg like '%unknown engine%', 'G11 unknown engine refused, got: ' || msg;
end $$;

-- Restore the real gate VERBATIM from 0001 so a later test file in the same run cannot inherit the stub.
create or replace function public.has_tenant_role(target_tenant_id uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.tenant_memberships tm
    where tm.tenant_id = target_tenant_id
      and tm.user_id = auth.uid()
      and tm.status = 'active'
      and tm.role = any(allowed_roles)
  );
$$;

do $$
begin
  assert not public.has_tenant_role('f6000000-0000-4000-8000-00000000000a', array['owner']),
    'the has_tenant_role stub must not survive this file';
end $$;
