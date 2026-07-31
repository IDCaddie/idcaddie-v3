-- 0070 — the `sync_status = 'current' -> stale_since IS NULL` invariant.
--
-- The bug this closes: `runner_promote_okta_directory_users` (0053) and `runner_promote_okta_directory_groups` (0054) restored a row to
-- `current` without clearing `stale_since`, while the other four promote RPCs did clear it. A returning identity or group carried a
-- timestamp saying it had last been seen months ago while its status said it was current.
--
-- The positive cases go through the REAL promote and stale RPCs — a test that set `sync_status` by hand would prove nothing about the
-- functions that are supposed to maintain the invariant.
--
-- NOTE ON NEGATIVE TESTS: `raise exception` in PL/pgSQL is SQLSTATE P0001, which a `when others` handler swallows. Every negative case
-- below therefore asserts on a flag set OUTSIDE the handler, never on the handler running.

reset role;

-- ── Fixtures: two tenants; T1 has TWO okta connections (cross-connector isolation); T2 has one. ───────────────────────
insert into public.tenants (id, name, slug) values
  ('c7000000-0000-4000-8000-000000000001', 'Invariant T1', 'inv-t1'),
  ('c7000000-0000-4000-8000-000000000002', 'Invariant T2', 'inv-t2');
insert into public.connectors (id, tenant_id, provider, status, connection_state) values
  ('c7000000-0000-4000-8000-0000000000c1', 'c7000000-0000-4000-8000-000000000001', 'okta', 'pending', 'verified'),
  ('c7000000-0000-4000-8000-0000000000cb', 'c7000000-0000-4000-8000-000000000001', 'okta', 'pending', 'verified'),
  ('c7000000-0000-4000-8000-0000000000c2', 'c7000000-0000-4000-8000-000000000002', 'okta', 'pending', 'verified'),
  -- CC is reserved for the CHECK-constraint tests, which insert rows by hand. Keeping them off C1/CB matters: those hand-made rows
  -- would count toward the stale circuit breaker's denominator in the RPC round-trip tests and trip it.
  ('c7000000-0000-4000-8000-0000000000cc', 'c7000000-0000-4000-8000-000000000001', 'okta', 'pending', 'verified');

-- Seed a complete, promotable run carrying a SET of entities.
--
-- The set matters. `runner_mark_absent_*_stale` refuses to stale anything once more than 30% of a connection's current rows would go
-- stale (the mass-staleness circuit breaker, migration 0053). Phase 2.1 must not touch that threshold, so the fixtures are sized to
-- work with it: four entities discovered, one disappearing, is 25% and passes. A two-row fixture would trip the breaker and the test
-- would be asserting on the breaker instead of on the timestamp.
create or replace function pg_temp.seed_users(p_tenant uuid, p_conn uuid, p_run uuid, p_exts text[], p_complete boolean, p_rejected integer, p_term text)
  returns void language plpgsql as $$
declare e text;
begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values (p_run, p_tenant, p_conn, 'running', clock_timestamp());
  foreach e in array p_exts loop
    perform public.runner_insert_discovery_fact(
      p_tenant, p_run, 'identity_account', 'identity_provider_discovery', 'okta', 'okta:'||p_conn||':users:'||e, e, now(), 1.0,
      jsonb_build_object('fact_type','identity_account','external_id',e,'connection_id',p_conn::text,'login',e,'normalized_login',lower(e),
                         'email',e||'@example.test','normalized_email',lower(e)||'@example.test','first_name','F','last_name','L','status','ACTIVE','is_active',true),
      jsonb_build_object('provider','okta','source_endpoint','users','schema_version','1','sanitizer_version','1','normalizer_version','1'));
  end loop;
  perform public.runner_record_okta_discovery_metrics(p_run, p_tenant, array_length(p_exts,1), array_length(p_exts,1), array_length(p_exts,1), array_length(p_exts,1), p_rejected, p_term, p_complete, '1','1','1', null);
end $$;

create or replace function pg_temp.seed_groups(p_tenant uuid, p_conn uuid, p_run uuid, p_exts text[], p_complete boolean, p_rejected integer, p_term text)
  returns void language plpgsql as $$
declare e text;
begin
  insert into public.connector_runs (id, tenant_id, connector_id, status, started_at) values (p_run, p_tenant, p_conn, 'running', clock_timestamp());
  foreach e in array p_exts loop
    perform public.runner_insert_discovery_fact(
      p_tenant, p_run, 'directory_group', 'identity_provider_discovery', 'okta', 'okta:'||p_conn||':groups:'||e, e, now(), 1.0,
      jsonb_build_object('fact_type','directory_group','external_id',e,'connection_id',p_conn::text,'name',e,'normalized_name',lower(e),'group_type_category','okta_group'),
      jsonb_build_object('provider','okta','source_endpoint','groups','schema_version','1','sanitizer_version','1','normalizer_version','1'));
  end loop;
  perform public.runner_record_okta_discovery_metrics(p_run, p_tenant, array_length(p_exts,1), array_length(p_exts,1), array_length(p_exts,1), array_length(p_exts,1), p_rejected, p_term, p_complete, '1','1','1', null);
end $$;

-- ════ C0: the CHECK exists on every one of the six discovery tables ═══════════════════════════════════════════════════
do $$
declare v_n int; v_missing text;
begin
  select count(*), string_agg(t.tbl, ', ') filter (where c.conname is null)
    into v_n, v_missing
    from (values ('identity_accounts'), ('directory_groups'), ('directory_applications'),
                 ('directory_group_memberships'), ('directory_application_user_assignments'),
                 ('directory_application_group_assignments')) as t(tbl)
    left join pg_constraint c
      on c.conrelid = ('public.' || t.tbl)::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%stale_since is null%'
   where c.conname is not null;
  assert v_n = 6, 'C0 expected the invariant CHECK on all six tables, saw ' || v_n || ' (missing: ' || coalesce(v_missing, '-') || ')';

  -- Validated, not left NOT VALID — an unvalidated constraint would let pre-existing bad rows survive unnoticed.
  select count(*) into v_n from pg_constraint c
   where c.contype = 'c' and not c.convalidated
     and pg_get_constraintdef(c.oid) ilike '%stale_since is null%';
  assert v_n = 0, 'C0 every invariant CHECK must be validated, ' || v_n || ' are NOT VALID';
end $$;

-- ════ C1: a CURRENT row cannot retain stale_since — on any of the six tables ══════════════════════════════════════════
do $$
declare
  T1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
  CC constant uuid := 'c7000000-0000-4000-8000-0000000000cc';
  blocked boolean; g uuid; a uuid; i uuid;
begin
  -- Direct INSERT of the contradictory state must fail. Flag set OUTSIDE the handler (P0001/23514 both land in `when others`).
  blocked := true;
  begin
    insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status, stale_since)
    values (T1, CC, 'okta', 'ext-bad-insert', 'bad', 'current', now());
    blocked := false;                      -- reached only if the CHECK did NOT fire
  exception when others then null;
  end;
  assert blocked, 'C1 INSERT of current+stale_since must be rejected';

  -- UPDATE into the contradictory state must fail too.
  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status)
  values (T1, CC, 'okta', 'ext-c1', 'ok', 'current') returning id into g;
  blocked := true;
  begin
    update public.directory_groups set stale_since = now() where id = g;
    blocked := false;
  exception when others then null;
  end;
  assert blocked, 'C1 UPDATE setting stale_since on a current row must be rejected';
  assert (select stale_since is null from public.directory_groups where id = g), 'C1 the row must be unchanged';

  -- The same on identity_accounts and directory_applications, so the guard is not one table deep.
  blocked := true;
  begin
    insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, sync_status, stale_since)
    values (T1, CC, 'okta', 'ext-bad-ia', 'bad@example.test', 'current', now());
    blocked := false;
  exception when others then null;
  end;
  assert blocked, 'C1 identity_accounts must reject current+stale_since';

  blocked := true;
  begin
    insert into public.directory_applications (tenant_id, connection_id, provider, external_id, name, label, sync_status, stale_since)
    values (T1, CC, 'okta', 'ext-bad-app', 'bad', 'Bad', 'current', now());
    blocked := false;
  exception when others then null;
  end;
  assert blocked, 'C1 directory_applications must reject current+stale_since';
end $$;

-- ════ C2: a STALE row MAY carry stale_since, and so may review_required / disconnected ════════════════════════════════
do $$
declare
  T1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
  CC constant uuid := 'c7000000-0000-4000-8000-0000000000cc';
  g uuid;
begin
  -- The invariant constrains ONLY `current`. Over-constraining would break the stale marker itself.
  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status, stale_since)
  values (T1, CC, 'okta', 'ext-c2-stale', 'stale-ok', 'stale', now()) returning id into g;
  assert (select stale_since is not null from public.directory_groups where id = g), 'C2 a stale row must keep its timestamp';

  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status, stale_since)
  values (T1, CC, 'okta', 'ext-c2-review', 'review-ok', 'review_required', now());
  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status, stale_since)
  values (T1, CC, 'okta', 'ext-c2-disc', 'disc-ok', 'disconnected', now());
  -- Reaching here without an exception is the assertion.
end $$;

-- ════ C3: IDENTITIES — the real round trip. current -> stale -> current clears the timestamp. ═════════════════════════
do $$
declare
  T1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
  C1 constant uuid := 'c7000000-0000-4000-8000-0000000000c1';
  RUN1 constant uuid := 'c7000000-0000-4000-8000-00000000a101';
  RUN2 constant uuid := 'c7000000-0000-4000-8000-00000000a102';
  RUN3 constant uuid := 'c7000000-0000-4000-8000-00000000a103';
  v_status text; v_stale timestamptz; v_first timestamptz;
begin
  -- Run 1 discovers the person.
  perform pg_temp.seed_users(T1, C1, RUN1, array['ada','grace','alan','edsger'], true, 0, 'last_page');
  perform public.runner_promote_okta_directory_users(RUN1, T1);
  select sync_status, stale_since, first_seen_at into v_status, v_stale, v_first
    from public.identity_accounts where tenant_id = T1 and connection_id = C1 and external_id = 'ada';
  assert v_status = 'current', 'C3 after first promote expected current, got ' || v_status;
  assert v_stale is null, 'C3 a newly discovered identity must have no stale_since';

  -- Run 2 does NOT see Ada (the other three are still there) -> the stale RPC marks her absent. 1 of 4 = 25%, under the breaker.
  perform pg_temp.seed_users(T1, C1, RUN2, array['grace','alan','edsger'], true, 0, 'last_page');
  perform public.runner_promote_okta_directory_users(RUN2, T1);
  perform public.runner_mark_absent_okta_identities_stale(RUN2, T1);
  select sync_status, stale_since into v_status, v_stale
    from public.identity_accounts where tenant_id = T1 and connection_id = C1 and external_id = 'ada';
  assert v_status = 'stale', 'C3 absent identity should be stale, got ' || v_status;
  assert v_stale is not null, 'C3 current -> stale must SET stale_since';

  -- Run 3 sees them again. THIS is the bug: before 0070 the row went back to current carrying run 2''s timestamp.
  perform pg_temp.seed_users(T1, C1, RUN3, array['ada','grace','alan','edsger'], true, 0, 'last_page');
  perform public.runner_promote_okta_directory_users(RUN3, T1);
  select sync_status, stale_since, first_seen_at into v_status, v_stale, v_first
    from public.identity_accounts where tenant_id = T1 and connection_id = C1 and external_id = 'ada';
  assert v_status = 'current', 'C3 returning identity should be current, got ' || v_status;
  assert v_stale is null, 'C3 stale -> current MUST clear stale_since (this is the 0053 bug)';
  -- The fix must not have disturbed the rest of the upsert.
  assert v_first is not null, 'C3 first_seen_at must still be preserved across re-promotion';
end $$;

-- ════ C4: GROUPS — the same round trip through the 0054 path ══════════════════════════════════════════════════════════
do $$
declare
  T1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
  C1 constant uuid := 'c7000000-0000-4000-8000-0000000000c1';
  RUN1 constant uuid := 'c7000000-0000-4000-8000-00000000b101';
  RUN2 constant uuid := 'c7000000-0000-4000-8000-00000000b102';
  RUN3 constant uuid := 'c7000000-0000-4000-8000-00000000b103';
  v_status text; v_stale timestamptz;
begin
  perform pg_temp.seed_groups(T1, C1, RUN1, array['engineering','sales','support','finance'], true, 0, 'last_page');
  perform public.runner_promote_okta_directory_groups(RUN1, T1);
  select sync_status, stale_since into v_status, v_stale
    from public.directory_groups where tenant_id = T1 and connection_id = C1 and external_id = 'engineering';
  assert v_status = 'current' and v_stale is null, 'C4 newly discovered group must be current with no stale_since';

  perform pg_temp.seed_groups(T1, C1, RUN2, array['sales','support','finance'], true, 0, 'last_page');
  perform public.runner_promote_okta_directory_groups(RUN2, T1);
  perform public.runner_mark_absent_okta_directory_groups_stale(RUN2, T1);
  select sync_status, stale_since into v_status, v_stale
    from public.directory_groups where tenant_id = T1 and connection_id = C1 and external_id = 'engineering';
  assert v_status = 'stale' and v_stale is not null, 'C4 current -> stale must set stale_since';

  perform pg_temp.seed_groups(T1, C1, RUN3, array['engineering','sales','support','finance'], true, 0, 'last_page');
  perform public.runner_promote_okta_directory_groups(RUN3, T1);
  select sync_status, stale_since into v_status, v_stale
    from public.directory_groups where tenant_id = T1 and connection_id = C1 and external_id = 'engineering';
  assert v_status = 'current', 'C4 returning group should be current, got ' || v_status;
  assert v_stale is null, 'C4 stale -> current MUST clear stale_since (this is the 0054 bug)';
end $$;

-- ════ C5: replaying a promote over an ALREADY-current row is idempotent ═══════════════════════════════════════════════
do $$
declare
  T1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
  CB constant uuid := 'c7000000-0000-4000-8000-0000000000cb';
  RUN constant uuid := 'c7000000-0000-4000-8000-00000000a110';
  v_n int; v_stale timestamptz; v_first_a timestamptz; v_first_b timestamptz;
begin
  perform pg_temp.seed_users(T1, CB, RUN, array['idem'], true, 0, 'last_page');
  perform public.runner_promote_okta_directory_users(RUN, T1);
  select first_seen_at into v_first_a from public.identity_accounts where tenant_id = T1 and connection_id = CB and external_id = 'idem';

  perform public.runner_promote_okta_directory_users(RUN, T1);   -- same run, replayed
  select count(*), max(stale_since), max(first_seen_at) into v_n, v_stale, v_first_b
    from public.identity_accounts where tenant_id = T1 and connection_id = CB and external_id = 'idem';
  assert v_n = 1, 'C5 replay must not duplicate the row, saw ' || v_n;
  assert v_stale is null, 'C5 replay must leave stale_since null';
  assert v_first_b = v_first_a, 'C5 replay must preserve first_seen_at';
end $$;

-- ════ C6: promotion touches ONLY its own connector, and never another tenant ══════════════════════════════════════════
do $$
declare
  T1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
  T2 constant uuid := 'c7000000-0000-4000-8000-000000000002';
  C1 constant uuid := 'c7000000-0000-4000-8000-0000000000c1';
  CB constant uuid := 'c7000000-0000-4000-8000-0000000000cb';
  C2 constant uuid := 'c7000000-0000-4000-8000-0000000000c2';
  RUN constant uuid := 'c7000000-0000-4000-8000-00000000a120';
  sib uuid; other uuid; v_status text; v_stale timestamptz;
begin
  -- A STALE row with the same external_id under a sibling connector in the same tenant, and one in another tenant.
  insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, sync_status, stale_since)
  values (T1, CB, 'okta', 'shared-ext', 'shared@example.test', 'stale', now() - interval '30 days') returning id into sib;
  insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, sync_status, stale_since)
  values (T2, C2, 'okta', 'shared-ext', 'shared@example.test', 'stale', now() - interval '30 days') returning id into other;

  perform pg_temp.seed_users(T1, C1, RUN, array['shared-ext'], true, 0, 'last_page');
  perform public.runner_promote_okta_directory_users(RUN, T1);

  -- The promoted connector's own row is current and clean...
  select sync_status, stale_since into v_status, v_stale
    from public.identity_accounts where tenant_id = T1 and connection_id = C1 and external_id = 'shared-ext';
  assert v_status = 'current' and v_stale is null, 'C6 the promoted row must be current with no stale_since';

  -- ...and neither neighbour moved. A promote that cleared stale_since tenant-wide would silently un-stale other connectors.
  select sync_status, stale_since into v_status, v_stale from public.identity_accounts where id = sib;
  assert v_status = 'stale' and v_stale is not null, 'C6 the sibling connector row must be untouched';
  select sync_status, stale_since into v_status, v_stale from public.identity_accounts where id = other;
  assert v_status = 'stale' and v_stale is not null, 'C6 the other tenant''s row must be untouched';
end $$;

-- ════ C7: an INCOMPLETE run still cannot re-promote — the fix did not weaken the eligibility gate ═════════════════════
do $$
declare
  T1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
  CB constant uuid := 'c7000000-0000-4000-8000-0000000000cb';
  R_INC  constant uuid := 'c7000000-0000-4000-8000-00000000a130';
  R_REJ  constant uuid := 'c7000000-0000-4000-8000-00000000a131';
  R_TERM constant uuid := 'c7000000-0000-4000-8000-00000000a132';
  R_GRP  constant uuid := 'c7000000-0000-4000-8000-00000000b130';
  promoted boolean; v_status text; v_stale timestamptz; row_id uuid;
begin
  -- A stale row that must NOT be revived by an ineligible run.
  insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, sync_status, stale_since)
  values (T1, CB, 'okta', 'gated', 'gated@example.test', 'stale', now() - interval '10 days') returning id into row_id;

  -- completeness = false
  perform pg_temp.seed_users(T1, CB, R_INC, array['gated'], false, 0, 'last_page');
  promoted := true;
  begin perform public.runner_promote_okta_directory_users(R_INC, T1); exception when others then promoted := false; end;
  assert not promoted, 'C7 an incomplete run must not promote';

  -- records_rejected > 0
  perform pg_temp.seed_users(T1, CB, R_REJ, array['gated'], true, 3, 'last_page');
  promoted := true;
  begin perform public.runner_promote_okta_directory_users(R_REJ, T1); exception when others then promoted := false; end;
  assert not promoted, 'C7 a run with rejected records must not promote';

  -- termination_reason <> 'last_page'
  perform pg_temp.seed_users(T1, CB, R_TERM, array['gated'], true, 0, 'page_budget');
  promoted := true;
  begin perform public.runner_promote_okta_directory_users(R_TERM, T1); exception when others then promoted := false; end;
  assert not promoted, 'C7 a run that did not reach last_page must not promote';

  -- The row is still stale WITH its timestamp: no ineligible path leaked through the new clear.
  select sync_status, stale_since into v_status, v_stale from public.identity_accounts where id = row_id;
  assert v_status = 'stale', 'C7 the gated row must still be stale, got ' || v_status;
  assert v_stale is not null, 'C7 the gated row must KEEP its stale_since — no ineligible run may clear it';

  -- Same gate on the groups path.
  perform pg_temp.seed_groups(T1, CB, R_GRP, array['gated-group'], false, 0, 'last_page');
  promoted := true;
  begin perform public.runner_promote_okta_directory_groups(R_GRP, T1); exception when others then promoted := false; end;
  assert not promoted, 'C7 an incomplete groups run must not promote';
end $$;

-- ════ C8: the 0068 stale-transition audit still fires on current -> stale, and ONLY there ═════════════════════════════
do $$
declare
  T1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
  CB constant uuid := 'c7000000-0000-4000-8000-0000000000cb';
  RUN1 constant uuid := 'c7000000-0000-4000-8000-00000000a001';
  RUN2 constant uuid := 'c7000000-0000-4000-8000-00000000a002';
  RUN3 constant uuid := 'c7000000-0000-4000-8000-00000000a003';
  n_before int; n_after_stale int; n_after_return int; n_after_repair int; g uuid;
begin
  select count(*) into n_before from public.audit_logs where resource_type = 'directory_group';

  perform pg_temp.seed_groups(T1, CB, RUN1, array['audited','a-two','a-three','a-four'], true, 0, 'last_page');
  perform public.runner_promote_okta_directory_groups(RUN1, T1);
  select count(*) into n_after_repair from public.audit_logs where resource_type = 'directory_group';
  assert n_after_repair = n_before, 'C8 a promote (nothing -> current) must write NO stale audit event';

  -- current -> stale for exactly one of four (25%, under the breaker): exactly one event.
  perform pg_temp.seed_groups(T1, CB, RUN2, array['a-two','a-three','a-four'], true, 0, 'last_page');
  perform public.runner_promote_okta_directory_groups(RUN2, T1);
  perform public.runner_mark_absent_okta_directory_groups_stale(RUN2, T1);
  select count(*) into n_after_stale from public.audit_logs where resource_type = 'directory_group';
  assert n_after_stale = n_before + 1, 'C8 current -> stale must write exactly one event, delta was ' || (n_after_stale - n_before);

  -- stale -> current (the newly fixed path): still NO event. The audit trail records disappearance, not return.
  perform pg_temp.seed_groups(T1, CB, RUN3, array['audited','a-two','a-three','a-four'], true, 0, 'last_page');
  perform public.runner_promote_okta_directory_groups(RUN3, T1);
  select count(*) into n_after_return from public.audit_logs where resource_type = 'directory_group';
  assert n_after_return = n_after_stale, 'C8 stale -> current must write no event, delta was ' || (n_after_return - n_after_stale);

  -- And the repair-shaped UPDATE (null a timestamp, leave the status alone) writes nothing either — which is why section 1
  -- of the migration is audit-neutral.
  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status, stale_since)
  values (T1, CB, 'okta', 'repair-shaped', 'repair', 'stale', now()) returning id into g;
  update public.directory_groups set sync_status = 'current', stale_since = null where id = g;
  select count(*) into n_after_repair from public.audit_logs where resource_type = 'directory_group';
  assert n_after_repair = n_after_return, 'C8 a stale -> current repair must write no audit event';
end $$;

-- ════ C9: the repair statement is idempotent and narrowly scoped ══════════════════════════════════════════════════════
do $$
declare
  T1 constant uuid := 'c7000000-0000-4000-8000-000000000001';
  CB constant uuid := 'c7000000-0000-4000-8000-0000000000cb';
  keep uuid; v_n int; v_stale timestamptz;
begin
  -- A legitimately stale row with a timestamp. Re-running the migration's repair must not touch it.
  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, sync_status, stale_since)
  values (T1, CB, 'okta', 'repair-keep', 'keep', 'stale', now() - interval '5 days') returning id into keep;

  update public.directory_groups set stale_since = null where sync_status = 'current' and stale_since is not null;
  get diagnostics v_n = row_count;
  assert v_n = 0, 'C9 on a repaired database the repair must be a no-op, it updated ' || v_n || ' row(s)';

  select stale_since into v_stale from public.directory_groups where id = keep;
  assert v_stale is not null, 'C9 the repair must never clear a genuinely stale row';
end $$;

-- ════ C10: no row anywhere violates the invariant after the whole suite ═══════════════════════════════════════════════
-- The same query used for the hosted staging check, run against everything the tests above created.
do $$
declare v_n int;
begin
  select
    (select count(*) from public.identity_accounts                       where sync_status = 'current' and stale_since is not null)
  + (select count(*) from public.directory_groups                        where sync_status = 'current' and stale_since is not null)
  + (select count(*) from public.directory_applications                  where sync_status = 'current' and stale_since is not null)
  + (select count(*) from public.directory_group_memberships             where sync_status = 'current' and stale_since is not null)
  + (select count(*) from public.directory_application_user_assignments  where sync_status = 'current' and stale_since is not null)
  + (select count(*) from public.directory_application_group_assignments where sync_status = 'current' and stale_since is not null)
  into v_n;
  assert v_n = 0, 'C10 found ' || v_n || ' row(s) violating current -> stale_since is null';
end $$;
