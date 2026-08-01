-- 0073 — connector management: disconnect, replace, scoping, inventory, history.
--
-- The load-bearing properties, in order:
--   1. Disconnect EXCLUDES but never deletes. Every row, run and audit event survives, and reconnect restores them.
--   2. Two active Okta organizations stay separate. Scoping to one never shows the other's records.
--   3. The inventory is the ONE read that shows inactive connectors — hiding them would make disconnect look like deletion.
--   4. Every operator action is owner/admin-only, tenant-scoped, reason-bearing and audited.
--
-- NOTE ON NEGATIVE TESTS: `raise exception` is SQLSTATE P0001 and `when others` swallows it, so negatives assert on a flag set
-- OUTSIDE the handler.

reset role;

-- ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Tenant A holds THREE Okta directories: CORP and SUB are two genuinely different organizations (the multi-directory case),
-- and OLD is a retired predecessor. Tenant B is unrelated.
insert into public.tenants (id, name, slug) values
  ('7d000000-0000-4000-8000-00000000000a', 'Manage A', 'mng-a'),
  ('7d000000-0000-4000-8000-00000000000b', 'Manage B', 'mng-b');
insert into auth.users (id, email) values
  ('7d000000-0000-4000-8000-0000000000f1', 'mng-owner@example.test'),
  ('7d000000-0000-4000-8000-0000000000f2', 'mng-editor@example.test') on conflict do nothing;
insert into public.profiles (id, email) values
  ('7d000000-0000-4000-8000-0000000000f1', 'mng-owner@example.test'),
  ('7d000000-0000-4000-8000-0000000000f2', 'mng-editor@example.test') on conflict do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('7d000000-0000-4000-8000-00000000000a', '7d000000-0000-4000-8000-0000000000f1', 'owner'),
  ('7d000000-0000-4000-8000-00000000000a', '7d000000-0000-4000-8000-0000000000f2', 'editor') on conflict do nothing;

insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('7d000000-0000-4000-8000-00000000c001', '7d000000-0000-4000-8000-00000000000a', 'okta', 'Corporate',  'pending', 'discovered'),
  ('7d000000-0000-4000-8000-00000000c002', '7d000000-0000-4000-8000-00000000000a', 'okta', 'Subsidiary', 'pending', 'discovered'),
  ('7d000000-0000-4000-8000-00000000c003', '7d000000-0000-4000-8000-00000000000a', 'okta', 'Old corp',   'pending', 'discovered'),
  ('7d000000-0000-4000-8000-00000000c004', '7d000000-0000-4000-8000-00000000000b', 'okta', 'Other tenant','pending','discovered');

-- One person, one group, one application per directory. Distinct external ids: these are DIFFERENT organizations.
insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, display_name, is_active, sync_status)
select '7d000000-0000-4000-8000-00000000000a', c, 'okta', 'u-' || c, 'u' || left(c::text, 4) || '@example.test', 'Person ' || left(c::text, 4), true, 'current'
  from unnest(array['7d000000-0000-4000-8000-00000000c001'::uuid, '7d000000-0000-4000-8000-00000000c002'::uuid, '7d000000-0000-4000-8000-00000000c003'::uuid]) c;
insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, group_type_category, sync_status)
select '7d000000-0000-4000-8000-00000000000a', c, 'okta', 'g-' || c, 'Group ' || left(c::text, 4), 'okta_group', 'current'
  from unnest(array['7d000000-0000-4000-8000-00000000c001'::uuid, '7d000000-0000-4000-8000-00000000c002'::uuid, '7d000000-0000-4000-8000-00000000c003'::uuid]) c;
insert into public.directory_applications (tenant_id, connection_id, provider, external_id, name, label, status_category, sync_status)
select '7d000000-0000-4000-8000-00000000000a', c, 'okta', 'a-' || c, 'app', 'App ' || left(c::text, 4), 'active', 'current'
  from unnest(array['7d000000-0000-4000-8000-00000000c001'::uuid, '7d000000-0000-4000-8000-00000000c002'::uuid, '7d000000-0000-4000-8000-00000000c003'::uuid]) c;

-- A discovery run on CORP, so history has something to show and survive.
insert into public.connector_runs (id, tenant_id, connector_id, status, started_at, records_seen)
values ('7d000000-0000-4000-8000-00000000d001', '7d000000-0000-4000-8000-00000000000a', '7d000000-0000-4000-8000-00000000c001', 'succeeded', now() - interval '1 day', 3);

-- ════ M0: shape and privilege ═════════════════════════════════════════════════════════════════════════════════════
do $$
declare f text;
begin
  foreach f in array array[
    'public.product_connector_inventory(uuid)',
    'public.product_connector_runs(uuid,uuid,timestamptz,integer)',
    'public.product_disconnect_connector(uuid,uuid,text)',
    'public.product_reconnect_connector(uuid,uuid)',
    'public.product_replace_connector(uuid,uuid,uuid,text)'
  ] loop
    assert     has_function_privilege('authenticated', f, 'EXECUTE'), 'M0 authenticated EXECUTE ' || f;
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'M0 anon denied ' || f;
    assert not has_function_privilege('public', f, 'EXECUTE'), 'M0 PUBLIC denied ' || f;
  end loop;
  -- Both retirement columns move together, or neither.
  assert exists (select 1 from pg_constraint where conname = 'connectors_disconnect_complete_chk' and convalidated), 'M0 disconnect CHECK validated';
end $$;

do $$
declare blocked boolean := true;
begin
  begin
    update public.connectors set disconnected_at = now() where id = '7d000000-0000-4000-8000-00000000c003';
    blocked := false;
  exception when others then null; end;
  assert blocked, 'M0 a timestamp with no reason must be rejected';
  assert (select disconnected_at is null from public.connectors where id = '7d000000-0000-4000-8000-00000000c003'), 'M0 no partial write';
end $$;

-- ════ M1: two active organizations stay separate ══════════════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '7d000000-0000-4000-8000-00000000000a';
  CORP constant uuid := '7d000000-0000-4000-8000-00000000c001';
  SUB constant uuid := '7d000000-0000-4000-8000-00000000c002';
  c jsonb; ids uuid[]; n int;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','7d000000-0000-4000-8000-0000000000f1')::text, true);

  -- Unscoped: every ACTIVE connector. Three directories, three people. This is not a merge — each row still belongs to its own
  -- connector, which is what the per-connector counts on the management page report.
  c := public.product_directory_access_counts(TA);
  assert (c ->> 'identities')::int = 3, 'M1 unscoped should see all three, got ' || (c ->> 'identities');

  -- Scoped: exactly one directory.
  c := public.product_directory_access_counts(TA, CORP);
  assert (c ->> 'identities')::int = 1, 'M1 scoped counts should be 1, got ' || (c ->> 'identities');
  assert (c ->> 'groups')::int = 1 and (c ->> 'applications')::int = 1, 'M1 scoped groups/apps';

  -- And the LIST agrees with the count, on the same scope. If these disagreed the customer would see two different truths.
  select array_agg(connection_id) into ids from public.product_list_directory_identities(TA, CORP);
  assert array_length(ids, 1) = 1 and ids[1] = CORP, 'M1 scoped list must contain only the scoped connector';
  select count(*) into n from public.product_list_directory_groups(TA, SUB);
  assert n = 1, 'M1 the other organization is independently readable';

  -- Scoping to one organization never leaks another's rows.
  select array_agg(connection_id) into ids from public.product_list_directory_applications(TA, SUB);
  assert not (CORP = any(ids)), 'M1 scoping to the subsidiary must not show corporate applications';
end $$;

-- ════ M2: DISCONNECT excludes but never deletes ═══════════════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '7d000000-0000-4000-8000-00000000000a';
  OLD constant uuid := '7d000000-0000-4000-8000-00000000c003';
  r jsonb; c jsonb; n int; audit_before int; audit_after int;
begin
  select count(*) into audit_before from public.audit_logs where resource_type = 'connector';

  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','7d000000-0000-4000-8000-0000000000f1')::text, true);

  r := public.product_disconnect_connector(TA, OLD, 'Retired after the office closed');
  assert (r ->> 'ok')::boolean, 'M2 disconnect should succeed';
  assert r ->> 'reason' = 'disconnected', 'M2 reason';

  -- Excluded from every product read.
  c := public.product_directory_access_counts(TA);
  assert (c ->> 'identities')::int = 2, 'M2 a disconnected directory must drop out of the counts, got ' || (c ->> 'identities');
  select count(*) into n from public.product_list_directory_identities(TA);
  assert n = 2, 'M2 and out of the lists';
  -- Even when explicitly asked for by id: a URL is not authorization to see a retired directory.
  c := public.product_directory_access_counts(TA, OLD);
  assert (c ->> 'identities')::int = 0, 'M2 explicitly scoping to a disconnected directory must return nothing';
  -- And its detail pages close.
  assert public.product_group_access_subgraph(TA, (select id from public.directory_groups where connection_id = OLD)) is null,
    'M2 a disconnected directory''s group must not resolve';

  reset role;
  -- NOTHING was deleted.
  select count(*) into n from public.identity_accounts where connection_id = OLD;
  assert n = 1, 'M2 the identity row must survive disconnect';
  select count(*) into n from public.directory_groups where connection_id = OLD;
  assert n = 1, 'M2 the group row must survive';
  select count(*) into n from public.directory_applications where connection_id = OLD;
  assert n = 1, 'M2 the application row must survive';
  select count(*) into n from public.connectors where id = OLD;
  assert n = 1, 'M2 the connector row must survive';
  assert (select disconnected_reason from public.connectors where id = OLD) = 'Retired after the office closed', 'M2 the reason is recorded';

  -- And it was audited.
  select count(*) into audit_after from public.audit_logs where resource_type = 'connector';
  assert audit_after = audit_before + 1, 'M2 exactly one audit event, delta ' || (audit_after - audit_before);
  assert exists (select 1 from public.audit_logs where resource_type = 'connector' and resource_id = OLD and action = 'connector.disconnected'),
    'M2 the audit event names the action';
end $$;

-- ════ M3: RECONNECT restores, without rediscovery ═════════════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '7d000000-0000-4000-8000-00000000000a';
  OLD constant uuid := '7d000000-0000-4000-8000-00000000c003';
  r jsonb; c jsonb;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','7d000000-0000-4000-8000-0000000000f1')::text, true);

  r := public.product_reconnect_connector(TA, OLD);
  assert (r ->> 'ok')::boolean and r ->> 'reason' = 'reconnected', 'M3 reconnect should succeed';

  -- The rows were never removed, so they are simply visible again. No discovery ran.
  c := public.product_directory_access_counts(TA);
  assert (c ->> 'identities')::int = 3, 'M3 reconnect must restore the records, got ' || (c ->> 'identities');
  assert (select disconnected_at is null and disconnected_reason is null from public.connectors where id = OLD), 'M3 both columns cleared';

  -- Idempotent.
  r := public.product_reconnect_connector(TA, OLD);
  assert (r ->> 'ok')::boolean and r ->> 'reason' = 'already_active', 'M3 reconnecting an active directory is a no-op';
end $$;

-- ════ M4: REPLACE uses supersession, and guards its preconditions ═════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '7d000000-0000-4000-8000-00000000000a';
  CORP constant uuid := '7d000000-0000-4000-8000-00000000c001';
  SUB constant uuid := '7d000000-0000-4000-8000-00000000c002';
  OLD constant uuid := '7d000000-0000-4000-8000-00000000c003';
  OTHER constant uuid := '7d000000-0000-4000-8000-00000000c004';
  r jsonb; c jsonb; n int;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','7d000000-0000-4000-8000-0000000000f1')::text, true);

  assert (public.product_replace_connector(TA, CORP, CORP, 'x') ->> 'reason') = 'same_connector', 'M4 self-replacement rejected';
  -- Another tenant's connector is not found — it is never confirmed to exist.
  assert (public.product_replace_connector(TA, CORP, OTHER, 'x') ->> 'reason') = 'not_found', 'M4 cross-tenant successor rejected';

  r := public.product_replace_connector(TA, OLD, CORP, 'Re-created the Okta integration for the same org');
  assert (r ->> 'ok')::boolean and r ->> 'reason' = 'replaced', 'M4 replace should succeed';

  c := public.product_directory_access_counts(TA);
  assert (c ->> 'identities')::int = 2, 'M4 the replaced directory drops out, got ' || (c ->> 'identities');
  reset role;
  select count(*) into n from public.identity_accounts where connection_id = OLD;
  assert n = 1, 'M4 the replaced directory''s rows survive';
  assert (select superseded_by from public.connectors where id = OLD) = CORP, 'M4 the pointer is recorded';
  assert exists (select 1 from public.audit_logs where resource_type = 'connector' and resource_id = OLD and action = 'connector.replaced'), 'M4 audited';

  -- A superseded connector may not be reconnected: that would put two connectors for one organization back into active views,
  -- which is exactly the double-count the P0 fix closed.
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','7d000000-0000-4000-8000-0000000000f1')::text, true);
  assert (public.product_reconnect_connector(TA, OLD) ->> 'reason') = 'superseded', 'M4 a superseded directory cannot be reconnected';
  -- Nor disconnected again — it is already excluded.
  assert (public.product_disconnect_connector(TA, OLD, 'again') ->> 'reason') = 'superseded', 'M4 a superseded directory cannot be disconnected';

  reset role;
  update public.connectors set superseded_by = null, superseded_at = null, superseded_reason = null where id = OLD;
end $$;

-- ════ M5: a reason is mandatory, and a retired successor is refused ═══════════════════════════════════════════════
do $$
declare
  TA constant uuid := '7d000000-0000-4000-8000-00000000000a';
  CORP constant uuid := '7d000000-0000-4000-8000-00000000c001';
  OLD constant uuid := '7d000000-0000-4000-8000-00000000c003';
  raised boolean;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','7d000000-0000-4000-8000-0000000000f1')::text, true);

  -- Someone will have to explain this decision months from now.
  raised := false;
  begin perform public.product_disconnect_connector(TA, OLD, '   '); exception when others then raised := true; end;
  assert raised, 'M5 a blank disconnect reason must be rejected';
  raised := false;
  begin perform public.product_replace_connector(TA, OLD, CORP, ''); exception when others then raised := true; end;
  assert raised, 'M5 a blank replacement reason must be rejected';

  -- Pointing at a retired successor would exclude both and leave the organization with no active directory at all.
  perform public.product_disconnect_connector(TA, CORP, 'temporarily off');
  assert (public.product_replace_connector(TA, OLD, CORP, 'valid reason') ->> 'reason') = 'successor_inactive', 'M5 retired successor refused';
  perform public.product_reconnect_connector(TA, CORP);
end $$;

-- ════ M6: authorization ═══════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '7d000000-0000-4000-8000-00000000000a';
  TB constant uuid := '7d000000-0000-4000-8000-00000000000b';
  OLD constant uuid := '7d000000-0000-4000-8000-00000000c003';
  raised boolean; n int;
begin
  set local role postgres;
  -- An EDITOR of the same tenant may not read the inventory or retire anything.
  perform set_config('request.jwt.claims', json_build_object('sub','7d000000-0000-4000-8000-0000000000f2')::text, true);
  select count(*) into n from public.product_connector_inventory(TA);
  assert n = 0, 'M6 an editor must not read the connector inventory';
  raised := false;
  begin perform public.product_disconnect_connector(TA, OLD, 'nope'); exception when others then raised := true; end;
  assert raised, 'M6 an editor must not disconnect';

  -- An owner of tenant A may not act on tenant B.
  perform set_config('request.jwt.claims', json_build_object('sub','7d000000-0000-4000-8000-0000000000f1')::text, true);
  raised := false;
  begin perform public.product_disconnect_connector(TB, '7d000000-0000-4000-8000-00000000c004', 'nope'); exception when others then raised := true; end;
  assert raised, 'M6 acting on another tenant must be refused';
  select count(*) into n from public.product_connector_inventory(TB);
  assert n = 0, 'M6 another tenant''s inventory is empty';
end $$;

-- ════ M7: the inventory is the one read that SHOWS retired directories ════════════════════════════════════════════
do $$
declare
  TA constant uuid := '7d000000-0000-4000-8000-00000000000a';
  OLD constant uuid := '7d000000-0000-4000-8000-00000000c003';
  CORP constant uuid := '7d000000-0000-4000-8000-00000000c001';
  n int; lc text; people int;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','7d000000-0000-4000-8000-0000000000f1')::text, true);
  perform public.product_disconnect_connector(TA, OLD, 'Retired');

  select count(*) into n from public.product_connector_inventory(TA);
  assert n = 3, 'M7 the inventory must list every connector including retired ones, got ' || n;

  select lifecycle, identities into lc, people from public.product_connector_inventory(TA) where id = OLD;
  assert lc = 'disconnected', 'M7 retirement outranks the discovery state, got ' || lc;
  -- Its counts are still reported: the page has to be able to say what a retired directory holds.
  assert people = 1, 'M7 a retired directory still reports its contents, got ' || people;

  select identities into people from public.product_connector_inventory(TA) where id = CORP;
  assert people = 1, 'M7 counts are PER connector, never summed across organizations, got ' || people;

  -- History survives retirement.
  select count(*) into n from public.product_connector_runs(TA, CORP);
  assert n = 1, 'M7 discovery history is readable';
  select count(*) into n from public.product_connector_runs(TA, '7d000000-0000-4000-8000-00000000c004');
  assert n = 0, 'M7 another tenant''s connector has no readable history';

  perform public.product_reconnect_connector(TA, OLD);
end $$;
