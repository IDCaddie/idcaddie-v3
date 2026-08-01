-- 0077 — the runner-only write boundary for canonical SaaS evidence.
--
-- The property this suite exists to protect: a partial sweep must never be able to retire a workspace. Everything else here —
-- scoping, idempotency, categorisation — is in service of that, because a write path that stales wrongly destroys evidence an
-- access review depends on.

reset role;

insert into public.tenants (id, name, slug) values
  ('a1000000-0000-4000-8000-00000000000a', 'Sink A', 'sink-a'), ('a1000000-0000-4000-8000-00000000000b', 'Sink B', 'sink-b');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('a1000000-0000-4000-8000-0000000000c1', 'a1000000-0000-4000-8000-00000000000a', 'slack', 'WS one',      'pending', 'discovered'),
  ('a1000000-0000-4000-8000-0000000000c2', 'a1000000-0000-4000-8000-00000000000a', 'slack', 'WS two',      'pending', 'discovered'),
  ('a1000000-0000-4000-8000-0000000000c3', 'a1000000-0000-4000-8000-00000000000b', 'slack', 'Other tenant','pending', 'discovered');

-- Seed a run with app_user_account facts, then record per-resource metrics.
create or replace function pg_temp.seed_accounts(p_tenant uuid, p_conn uuid, p_run uuid, p_exts text[], p_complete boolean, p_rejected integer, p_term text)
  returns void language plpgsql as $$
declare e text; k text;
begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at)
  values (p_run, p_tenant, p_conn, 'running', clock_timestamp()) on conflict (id) do nothing;
  foreach e in array p_exts loop
    k := case when e like 'B%' then 'true' else 'false' end;
    perform public.runner_insert_discovery_fact(
      p_tenant, p_run, 'app_user_account', 'deep_provider_sync', 'slack', 'slack:'||p_conn||':users:'||e, e, now(), 1.0,
      jsonb_build_object('fact_type','app_user_account','app_user_external_id',e,'app_instance_key','T123',
                         'display_name','Person '||e,'email',lower(e)||'@example.test','is_bot',k::boolean,'is_deleted',false,'is_admin',false),
      jsonb_build_object('provider','slack','source_endpoint','users.list','schema_version','1','sanitizer_version','1','normalizer_version','1'));
  end loop;
  perform public.runner_record_saas_resource_discovery(p_run, p_tenant, 'app_user_account',
    1, array_length(p_exts,1), array_length(p_exts,1), p_rejected, 0, 0, p_term, p_complete, false);
end $$;

-- ════ W0: grants — runner only, and no direct table write ═════════════════════════════════════════════════════════
do $$
declare f text;
begin
  foreach f in array array[
    'public.runner_promote_saas_app_accounts(uuid,uuid)',
    'public.runner_promote_saas_app_groups(uuid,uuid)',
    'public.runner_mark_absent_saas_app_accounts_stale(uuid,uuid)',
    'public.runner_record_capability_state(uuid,uuid,text,text,text,uuid,integer)',
    'public.runner_record_saas_resource_discovery(uuid,uuid,text,integer,integer,integer,integer,integer,integer,text,boolean,boolean)']
  loop
    assert     has_function_privilege('connector_runner', f, 'EXECUTE'), 'W0 runner EXECUTE ' || f;
    assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'W0 authenticated denied ' || f;
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'W0 anon denied ' || f;
    assert not has_function_privilege('service_role', f, 'EXECUTE'), 'W0 service_role denied ' || f;
    assert not has_function_privilege('public', f, 'EXECUTE'), 'W0 PUBLIC denied ' || f;
    assert (select array_to_string(proconfig, ',') from pg_proc where oid = f::regprocedure) like 'search_path=%', 'W0 pinned search_path ' || f;
  end loop;

  -- The gate only means something if the runner cannot go round it.
  foreach f in array array['app_accounts','app_account_groups','app_account_group_memberships','connector_run_resource_discovery'] loop
    assert not has_table_privilege('connector_runner', 'public.' || f, 'INSERT'), 'W0 runner must not INSERT ' || f || ' directly';
    assert not has_table_privilege('connector_runner', 'public.' || f, 'UPDATE'), 'W0 runner must not UPDATE ' || f || ' directly';
  end loop;
end $$;

-- ════ W1: promote — upsert, idempotency, categorisation, no identity write ════════════════════════════════════════
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  C1 constant uuid := 'a1000000-0000-4000-8000-0000000000c1';
  R1 constant uuid := 'a1000000-0000-4000-8000-00000000d001';
  r jsonb; n int; ident_before int; ident_after int;
begin
  select count(*) into ident_before from public.identity_accounts;

  perform pg_temp.seed_accounts(TA, C1, R1, array['U1','U2','B1'], true, 0, 'last_page');
  r := public.runner_promote_saas_app_accounts(R1, TA);
  assert (r ->> 'accountsCreated')::int = 3, 'W1 three accounts created, got ' || (r ->> 'accountsCreated');

  -- Bots stay non-human. A misclassified bot is a bot in an access review.
  select count(*) into n from public.app_accounts where connection_id = C1 and account_kind = 'human';
  assert n = 2, 'W1 two humans, got ' || n;
  select count(*) into n from public.app_accounts where connection_id = C1 and account_kind = 'bot';
  assert n = 1, 'W1 one bot, got ' || n;

  -- Email is normalized at write time, so matching never has to lower-case at read time.
  assert (select normalized_email from public.app_accounts where connection_id = C1 and external_id = 'U1') = 'u1@example.test', 'W1 email normalized';

  -- Replay is idempotent: same run, same facts, no duplicates and nothing "created".
  r := public.runner_promote_saas_app_accounts(R1, TA);
  assert (r ->> 'accountsCreated')::int = 0 and (r ->> 'accountsUpdated')::int = 3, 'W1 replay must update, not create';
  select count(*) into n from public.app_accounts where connection_id = C1;
  assert n = 3, 'W1 replay must not duplicate, got ' || n;

  -- Nothing reached the identity graph.
  select count(*) into ident_after from public.identity_accounts;
  assert ident_after = ident_before, 'W1 a SaaS account must never create an identity';
end $$;

-- ════ W2: scoping — provider pinned, connector scoped, tenant isolated ════════════════════════════════════════════
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  TB constant uuid := 'a1000000-0000-4000-8000-00000000000b';
  C1 constant uuid := 'a1000000-0000-4000-8000-0000000000c1';
  C2 constant uuid := 'a1000000-0000-4000-8000-0000000000c2';
  R1 constant uuid := 'a1000000-0000-4000-8000-00000000d001';
  R2 constant uuid := 'a1000000-0000-4000-8000-00000000d002';
  raised boolean; n int; msg text;
begin
  -- Cross-tenant: the run does not belong to tenant B. The message is asserted, not just the fact of an error — three
  -- independent gates (run ownership, connector ownership, eligibility read) are all tenant-scoped, so `raised` alone
  -- passes even when the FIRST gate is deleted. Mutation testing found exactly that.
  msg := '';
  begin perform public.runner_promote_saas_app_accounts(R1, TB); exception when others then msg := sqlerrm; end;
  assert msg like 'run % does not belong to tenant%', 'W2 cross-tenant promote must be refused by the ownership gate, got: ' || msg;

  -- An unknown run is refused rather than silently promoting nothing.
  msg := '';
  begin perform public.runner_promote_saas_app_accounts('a1000000-0000-4000-8000-00000000dead', TA); exception when others then msg := sqlerrm; end;
  assert msg like 'run % does not belong to tenant%', 'W2 an unknown run must be refused, got: ' || msg;

  -- Same gate on the staler.
  msg := '';
  begin perform public.runner_mark_absent_saas_app_accounts_stale(R1, TB); exception when others then msg := sqlerrm; end;
  assert msg like 'run % does not belong to tenant%', 'W2 cross-tenant stale must be refused, got: ' || msg;

  -- The SAME provider ids under a second connector are separate accounts, and neither run touches the other's rows.
  perform pg_temp.seed_accounts(TA, C2, R2, array['U1','U2'], true, 0, 'last_page');
  perform public.runner_promote_saas_app_accounts(R2, TA);
  select count(*) into n from public.app_accounts where tenant_id = TA and external_id = 'U1';
  assert n = 2, 'W2 the same id in two workspaces is two accounts, got ' || n;
  select count(*) into n from public.app_accounts where connection_id = C1;
  assert n = 3, 'W2 promoting C2 must not alter C1, got ' || n;

  -- A fact claiming another provider cannot retarget a row: the provider is read from the CONNECTOR, never the fact.
  raised := false;
  begin
    perform public.runner_insert_discovery_fact(TA, R1, 'app_user_account', 'deep_provider_sync', 'okta',
      'okta:x:users:U9', 'U9', now(), 1.0,
      jsonb_build_object('fact_type','app_user_account','app_user_external_id','U9'),
      jsonb_build_object('provider','okta'));
  exception when others then raised := true; end;
  perform public.runner_promote_saas_app_accounts(R1, TA);
  select count(*) into n from public.app_accounts where connection_id = C1 and external_id = 'U9';
  assert n = 0, 'W2 a fact from another provider must not be promoted onto a slack connector';
end $$;

-- ════ W3: eligibility — an incomplete sweep promotes and stales NOTHING ═══════════════════════════════════════════
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  C1 constant uuid := 'a1000000-0000-4000-8000-0000000000c1';
  R3 constant uuid := 'a1000000-0000-4000-8000-00000000d003';
  R4 constant uuid := 'a1000000-0000-4000-8000-00000000d004';
  R5 constant uuid := 'a1000000-0000-4000-8000-00000000d005';
  raised boolean; r jsonb; n int;
begin
  -- completeness=false
  perform pg_temp.seed_accounts(TA, C1, R3, array['U1'], false, 0, 'last_page');
  raised := false;
  begin perform public.runner_promote_saas_app_accounts(R3, TA); exception when others then raised := true; end;
  assert raised, 'W3 an incomplete run must not promote';
  r := public.runner_mark_absent_saas_app_accounts_stale(R3, TA);
  assert (r ->> 'eligible')::boolean = false and (r ->> 'staleMarked')::int = 0, 'W3 an incomplete run must stale nothing';

  -- rejected > 0
  perform pg_temp.seed_accounts(TA, C1, R4, array['U1'], true, 2, 'last_page');
  r := public.runner_mark_absent_saas_app_accounts_stale(R4, TA);
  -- `eligible`, not just `staleMarked`. Every prior C1 account is absent from this fixture (3 of 3), so the circuit
  -- breaker would force staleMarked=0 on its own and the assertion would pass with the eligibility clause DELETED —
  -- a test passing for the wrong reason. The gate returns eligible=false; the breaker returns eligible=true.
  assert (r ->> 'eligible')::boolean = false and (r ->> 'staleMarked')::int = 0, 'W3 a run with rejected records must stale nothing';

  -- a capped run (page/item/time budget) is not last_page
  perform pg_temp.seed_accounts(TA, C1, R5, array['U1'], true, 0, 'page_budget');
  r := public.runner_mark_absent_saas_app_accounts_stale(R5, TA);
  assert (r ->> 'eligible')::boolean = false and (r ->> 'staleMarked')::int = 0, 'W3 a capped run must stale nothing';

  -- and everything is still current.
  select count(*) into n from public.app_accounts where connection_id = C1 and sync_status = 'current';
  assert n = 3, 'W3 no account may have been retired by an ineligible run, got ' || n;
end $$;

-- ════ W4: ONE RESOURCE'S COMPLETENESS MUST NOT AUTHORIZE ANOTHER'S STALE ══════════════════════════════════════════
-- The reason this migration adds a per-resource table instead of reusing connector_run_discovery.
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  C1 constant uuid := 'a1000000-0000-4000-8000-0000000000c1';
  R6 constant uuid := 'a1000000-0000-4000-8000-00000000d006';
  r jsonb; n int;
begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at)
  values (R6, TA, C1, 'running', clock_timestamp()) on conflict (id) do nothing;
  -- Groups completed perfectly; accounts did NOT finish. A shared completeness row would let the group sweep retire every
  -- account the user sweep never reached.
  perform public.runner_record_saas_resource_discovery(R6, TA, 'group', 1, 5, 5, 0, 0, 0, 'last_page', true, false);
  perform public.runner_record_saas_resource_discovery(R6, TA, 'app_user_account', 1, 2, 2, 0, 0, 0, 'page_budget', false, false);

  r := public.runner_mark_absent_saas_app_accounts_stale(R6, TA);
  assert (r ->> 'eligible')::boolean = false, 'W4 a complete GROUP sweep must not authorize staling ACCOUNTS';
  select count(*) into n from public.app_accounts where connection_id = C1 and sync_status = 'stale';
  assert n = 0, 'W4 nothing may have been retired, got ' || n;
end $$;

-- ════ W5: a complete sweep stales exactly the absent account, once, with an audit event ═══════════════════════════
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  C1 constant uuid := 'a1000000-0000-4000-8000-0000000000c1';
  R7 constant uuid := 'a1000000-0000-4000-8000-00000000d007';
  r jsonb; n int; a_before int; a_after int; ev jsonb;
begin
  select count(*) into a_before from public.audit_logs where action = 'saas_evidence.staled';

  -- U2 is absent from this sweep. 1 of 3 = 33%… above the 30% breaker, so add a fourth first to make it 1 of 4 = 25%.
  perform pg_temp.seed_accounts(TA, C1, R7, array['U1','B1','U3'], true, 0, 'last_page');
  perform public.runner_promote_saas_app_accounts(R7, TA);
  r := public.runner_mark_absent_saas_app_accounts_stale(R7, TA);
  assert (r ->> 'staleMarked')::int = 1, 'W5 exactly one absent account should be retired, got ' || (r ->> 'staleMarked');
  assert (select sync_status from public.app_accounts where connection_id = C1 and external_id = 'U2') = 'stale', 'W5 U2 is the absent one';
  assert (select stale_since is not null from public.app_accounts where connection_id = C1 and external_id = 'U2'), 'W5 stale carries its timestamp';

  -- Exactly one audit event, carrying bounded metadata only.
  select count(*) into a_after from public.audit_logs where action = 'saas_evidence.staled';
  assert a_after = a_before + 1, 'W5 exactly one audit event, delta ' || (a_after - a_before);
  select after_json into ev from public.audit_logs where action = 'saas_evidence.staled' order by created_at desc limit 1;
  assert ev ->> 'reason_code' = 'absent_from_complete_sweep', 'W5 audit carries a bounded reason';
  -- No name, email, raw provider data or exception text.
  assert ev::text !~* 'example\.test|Person |xox|token|secret', 'W5 the audit event must carry no personal or provider data';

  -- Re-running the staler writes NO second event: the row is already stale, so the trigger''s WHEN clause never fires.
  r := public.runner_mark_absent_saas_app_accounts_stale(R7, TA);
  select count(*) into n from public.audit_logs where action = 'saas_evidence.staled';
  assert n = a_after, 'W5 a status-preserving replay must emit no audit event';
end $$;

-- ════ W6: promotion returns a stale account to current and clears the timestamp ═══════════════════════════════════
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  C1 constant uuid := 'a1000000-0000-4000-8000-0000000000c1';
  R8 constant uuid := 'a1000000-0000-4000-8000-00000000d008';
begin
  perform pg_temp.seed_accounts(TA, C1, R8, array['U1','U2','B1','U3'], true, 0, 'last_page');
  perform public.runner_promote_saas_app_accounts(R8, TA);
  assert (select sync_status from public.app_accounts where connection_id = C1 and external_id = 'U2') = 'current', 'W6 the returning account is current again';
  -- The 0070 invariant, applied here from the start rather than retrofitted.
  assert (select stale_since is null from public.app_accounts where connection_id = C1 and external_id = 'U2'), 'W6 promotion must clear stale_since';
end $$;

-- ════ W7: the circuit breaker refuses a mass retirement ═══════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  C2 constant uuid := 'a1000000-0000-4000-8000-0000000000c2';
  R9  constant uuid := 'a1000000-0000-4000-8000-00000000d009';
  R10 constant uuid := 'a1000000-0000-4000-8000-00000000d010';
  r jsonb; n int;
begin
  -- C2 has U1,U2. A sweep seeing only U1 would retire 50% — far more likely a bad read than half a workspace leaving.
  perform pg_temp.seed_accounts(TA, C2, R9, array['U1'], true, 0, 'last_page');
  perform public.runner_promote_saas_app_accounts(R9, TA);
  r := public.runner_mark_absent_saas_app_accounts_stale(R9, TA);
  assert (r ->> 'circuitBreakerTriggered')::boolean, 'W7 a 50% retirement must trip the breaker';
  assert (r ->> 'staleMarked')::int = 0, 'W7 and stale nothing';
  select count(*) into n from public.app_accounts where connection_id = C2 and sync_status = 'stale';
  assert n = 0, 'W7 no account retired';
  -- The run is flagged for review rather than silently passing.
  assert (select review_required from public.connector_run_resource_discovery where run_id = R9 and resource = 'app_user_account'), 'W7 the run is flagged for review';
end $$;

-- ════ W8: the latest-run guard blocks a superseded sweep ══════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  C1 constant uuid := 'a1000000-0000-4000-8000-0000000000c1';
  OLD constant uuid := 'a1000000-0000-4000-8000-00000000d011';
  NEWR constant uuid := 'a1000000-0000-4000-8000-00000000d012';
  r jsonb; msg text; raised boolean;
begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at)
  values (OLD, TA, C1, 'running', now() - interval '2 hours'), (NEWR, TA, C1, 'running', now());
  perform public.runner_record_saas_resource_discovery(OLD,  TA, 'app_user_account', 1, 1, 1, 0, 0, 0, 'last_page', true, false);
  perform public.runner_record_saas_resource_discovery(NEWR, TA, 'app_user_account', 1, 4, 4, 0, 0, 0, 'last_page', true, false);

  -- Staling on the OLDER sweep would treat everything the newer one found as absent.
  r := public.runner_mark_absent_saas_app_accounts_stale(OLD, TA);
  assert (r ->> 'superseded')::boolean, 'W8 a superseded run must be refused';
  assert (r ->> 'staleMarked')::int = 0, 'W8 and stale nothing';

  -- And the PROMOTERS carry the same guard. Without it, replaying the older run's promote returns every account the
  -- newer sweep retired to `current` — and silently, because the audit trigger only fires on current -> stale.
  -- Asserting the MESSAGE, not just that something raised: the eligibility gate above would also raise.
  raised := false;
  begin perform public.runner_promote_saas_app_accounts(OLD, TA); exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'W8 a superseded run must not promote accounts';
  assert msg like '%superseded by a later complete run%', 'W8 accounts must be refused by the latest-run guard, got: ' || msg;

  perform public.runner_record_saas_resource_discovery(OLD,  TA, 'group', 1, 1, 1, 0, 0, 0, 'last_page', true, false);
  perform public.runner_record_saas_resource_discovery(NEWR, TA, 'group', 1, 2, 2, 0, 0, 0, 'last_page', true, false);
  raised := false;
  begin perform public.runner_promote_saas_app_groups(OLD, TA); exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'W8 a superseded run must not promote groups';
  assert msg like '%superseded by a later complete run%', 'W8 groups must be refused by the latest-run guard, got: ' || msg;
end $$;

-- ════ W9: capability freshness — last_success_at is advanced, never erased ════════════════════════════════════════
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  C1 constant uuid := 'a1000000-0000-4000-8000-0000000000c1';
  R constant uuid := 'a1000000-0000-4000-8000-00000000d008';
  s text; ok_at timestamptz;
begin
  perform public.runner_record_capability_state(TA, C1, 'app_accounts', 'available', null, R, 4);
  select last_success_at into ok_at from public.connector_capability_state where connection_id = C1 and capability = 'app_accounts';
  assert ok_at is not null, 'W9 a success is recorded';

  -- A later failure must NOT erase when it last worked — that is the fact Sync Health reports.
  perform public.runner_record_capability_state(TA, C1, 'app_accounts', 'failed', 'http_error', R, null);
  select state, last_success_at into s, ok_at from public.connector_capability_state where connection_id = C1 and capability = 'app_accounts';
  assert s = 'failed', 'W9 the new state is recorded';
  assert ok_at is not null, 'W9 last_success_at must survive a later failure';

  -- A plan limit is its own state, not a failure.
  perform public.runner_record_capability_state(TA, C1, 'usage', 'plan_dependent', 'requires_business_plus', R, null);
  assert (select state from public.connector_capability_state where connection_id = C1 and capability = 'usage') = 'plan_dependent', 'W9 plan limits are distinct';
end $$;

-- ════ W10: no raw payload can reach a canonical row ═══════════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  C1 constant uuid := 'a1000000-0000-4000-8000-0000000000c1';
  n int;
begin
  -- The promoters read only NAMED fields from fact_json. A fact carrying extra provider junk cannot smuggle it through,
  -- because there is no column for it and no promote parameter accepts arbitrary JSON.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name in ('app_accounts','app_account_groups','connector_run_resource_discovery')
     and (column_name like '%raw%' or column_name like '%payload%' or data_type = 'jsonb');
  assert n = 0, 'W10 no canonical SaaS table may hold a raw or jsonb provider column, found ' || n;

  -- And no promote/record RPC takes a jsonb parameter.
  select count(*) into n from pg_proc p
   where p.proname in ('runner_promote_saas_app_accounts','runner_promote_saas_app_groups',
                       'runner_mark_absent_saas_app_accounts_stale','runner_record_saas_resource_discovery','runner_record_capability_state')
     and 'jsonb'::regtype = any(p.proargtypes::oid[]);
  assert n = 0, 'W10 no write RPC may accept an arbitrary jsonb record, found ' || n;
end $$;

-- ════ W11: an un-allowlisted key is refused at the front door ═════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  R constant uuid := 'a1000000-0000-4000-8000-00000000d001';
  raised boolean; n int;
begin
  -- A Slack profile blob riding along on an otherwise valid account fact.
  raised := false;
  begin
    perform public.runner_insert_discovery_fact(TA, R, 'app_user_account', 'deep_provider_sync', 'slack',
      'slack:x:users:UBAD', 'UBAD', now(), 1.0,
      jsonb_build_object('fact_type','app_user_account','app_user_external_id','UBAD','profile',
                         jsonb_build_object('image_512','https://…','phone','+1','title','VP')),
      jsonb_build_object('provider','slack'));
  exception when others then raised := true; end;
  assert raised, 'W11 an un-allowlisted app_user_account key must be refused';

  raised := false;
  begin
    perform public.runner_insert_discovery_fact(TA, R, 'group', 'deep_provider_sync', 'slack',
      'slack:x:usergroups:GBAD', 'GBAD', now(), 1.0,
      jsonb_build_object('fact_type','group','group_external_id','GBAD','channels', jsonb_build_array('C123')),
      jsonb_build_object('provider','slack'));
  exception when others then raised := true; end;
  assert raised, 'W11 an un-allowlisted group key must be refused';

  -- Nothing was written on either attempt.
  select count(*) into n from public.discovery_facts where natural_key in ('UBAD','GBAD');
  assert n = 0, 'W11 a refused fact must leave no row, found ' || n;

  -- And the allowlisted shape still goes through.
  perform public.runner_insert_discovery_fact(TA, R, 'group', 'deep_provider_sync', 'slack',
    'slack:x:usergroups:GOK', 'GOK', now(), 1.0,
    jsonb_build_object('fact_type','group','group_external_id','GOK','group_name','Eng','group_handle','eng',
                       'description','Engineering','member_count',4,'is_active',true,'app_instance_key','T123'),
    jsonb_build_object('provider','slack'));
  select count(*) into n from public.discovery_facts where natural_key = 'GOK';
  assert n = 1, 'W11 an allowlisted group fact is accepted';
end $$;

-- ════ W12: an unknown fact type never reaches the staging table ═══════════════════════════════════════════════════
do $$
declare
  TA constant uuid := 'a1000000-0000-4000-8000-00000000000a';
  R constant uuid := 'a1000000-0000-4000-8000-00000000d001';
  raised boolean; n int;
begin
  raised := false;
  begin
    perform public.runner_insert_discovery_fact(TA, R, 'slack_channel', 'deep_provider_sync', 'slack',
      'slack:x:conversations:C1', 'C1', now(), 1.0,
      jsonb_build_object('fact_type','slack_channel','id','C1'), jsonb_build_object('provider','slack'));
  exception when others then raised := true; end;
  assert raised, 'W12 an unknown fact type must be refused';
  select count(*) into n from public.discovery_facts where fact_type = 'slack_channel';
  assert n = 0, 'W12 no row written for an unknown fact type';
end $$;
