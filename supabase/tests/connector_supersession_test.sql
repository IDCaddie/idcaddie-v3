-- 0071 — one Okta organization, one active connector.
--
-- Two connector rows in one tenant read the same Okta organization, so every product surface double-counted. The fix records the
-- supersession on the connector and excludes it from all nine 0061 read RPCs.
--
-- What these tests must establish, in order of importance:
--   1. Every read surface agrees — one scope, not eight independently-correct ones.
--   2. The superseded connector's rows still EXIST and are untouched. Exclusion is a read-time decision, not a deletion.
--   3. A genuinely different Okta organization is unaffected.
--   4. The exclusion keys on connector ownership, not on any row attribute.
--
-- NOTE ON NEGATIVE TESTS: `raise exception` is SQLSTATE P0001 and a `when others` handler swallows it, so every negative case
-- asserts on a flag set OUTSIDE the handler.

reset role;

-- ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Tenant A: LEG and SUR read the SAME organization (identical external_ids), plus IND — a genuinely DIFFERENT organization
-- whose external_ids do not overlap. Tenant B is an unrelated tenant.
insert into public.tenants (id, name, slug) values
  ('5b000000-0000-4000-8000-00000000000a', 'Supersede A', 'sup-a'),
  ('5b000000-0000-4000-8000-00000000000b', 'Supersede B', 'sup-b');

insert into auth.users (id, email) values ('5b000000-0000-4000-8000-00000000a0f1', 'sup-owner@example.test') on conflict do nothing;
insert into public.profiles (id, email) values ('5b000000-0000-4000-8000-00000000a0f1', 'sup-owner@example.test') on conflict do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('5b000000-0000-4000-8000-00000000000a', '5b000000-0000-4000-8000-00000000a0f1', 'owner') on conflict do nothing;

insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('5b000000-0000-4000-8000-00000000001e', '5b000000-0000-4000-8000-00000000000a', 'okta', 'Legacy',      'pending', 'discovered'),
  ('5b000000-0000-4000-8000-00000000005a', '5b000000-0000-4000-8000-00000000000a', 'okta', 'Survivor',    'pending', 'discovered'),
  ('5b000000-0000-4000-8000-000000000d1f', '5b000000-0000-4000-8000-00000000000a', 'okta', 'Other org',   'pending', 'discovered'),
  ('5b000000-0000-4000-8000-00000000000f', '5b000000-0000-4000-8000-00000000000b', 'okta', 'Other tenant','pending', 'discovered');

-- Same organization read twice: LEG and SUR carry the SAME external_ids. IND is a different organization.
-- created_at is set explicitly and DISTINCTLY. A tie would let an "oldest row per external_id" dedup fail at the first count
-- assertion for the wrong reason; distinct timestamps let such an implementation appear to work, so it is caught by S6 — which
-- tests the actual principle, that exclusion follows connector ownership rather than row resemblance.
insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, sync_status, created_at) values
  ('5b000000-0000-4000-8000-00000000000a', '5b000000-0000-4000-8000-00000000001e', 'okta', '00uSHARED', 'p@example.test', 'current', now() - interval '2 days'),
  ('5b000000-0000-4000-8000-00000000000a', '5b000000-0000-4000-8000-00000000005a', 'okta', '00uSHARED', 'p@example.test', 'current', now() - interval '1 day'),
  ('5b000000-0000-4000-8000-00000000000a', '5b000000-0000-4000-8000-000000000d1f', 'okta', '00uOTHER',  'q@example.test', 'current', now());
insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, group_type_category, sync_status) values
  ('5b000000-0000-4000-8000-00000000000a', '5b000000-0000-4000-8000-00000000001e', 'okta', '00gSHARED', 'Everyone', 'built_in',   'current'),
  ('5b000000-0000-4000-8000-00000000000a', '5b000000-0000-4000-8000-00000000005a', 'okta', '00gSHARED', 'Everyone', 'built_in',   'current'),
  ('5b000000-0000-4000-8000-00000000000a', '5b000000-0000-4000-8000-00000000005a', 'okta', '00gEXTRA',  'Eng',      'okta_group', 'current'),
  ('5b000000-0000-4000-8000-00000000000a', '5b000000-0000-4000-8000-000000000d1f', 'okta', '00gOTHER',  'OtherOrg', 'okta_group', 'current');
insert into public.directory_applications (tenant_id, connection_id, provider, external_id, name, label, status_category, sync_status) values
  ('5b000000-0000-4000-8000-00000000000a', '5b000000-0000-4000-8000-00000000001e', 'okta', '0oaSHARED', 'sf', 'Salesforce', 'active', 'current'),
  ('5b000000-0000-4000-8000-00000000000a', '5b000000-0000-4000-8000-00000000005a', 'okta', '0oaSHARED', 'sf', 'Salesforce', 'active', 'current'),
  ('5b000000-0000-4000-8000-00000000000a', '5b000000-0000-4000-8000-000000000d1f', 'okta', '0oaOTHER',  'zd', 'Zendesk',    'active', 'current');

-- Edges, one per connector, so the edge RPCs and the counts RPC are exercised too.
insert into public.directory_group_memberships (tenant_id, connection_id, provider, directory_group_id, identity_account_id, sync_status)
select '5b000000-0000-4000-8000-00000000000a', c, 'okta',
       (select id from public.directory_groups where connection_id = c limit 1),
       (select id from public.identity_accounts where connection_id = c limit 1), 'current'
  from unnest(array['5b000000-0000-4000-8000-00000000001e'::uuid, '5b000000-0000-4000-8000-00000000005a'::uuid, '5b000000-0000-4000-8000-000000000d1f'::uuid]) c;
insert into public.directory_application_user_assignments (tenant_id, connection_id, provider, directory_application_id, identity_account_id, sync_status)
select '5b000000-0000-4000-8000-00000000000a', c, 'okta',
       (select id from public.directory_applications where connection_id = c limit 1),
       (select id from public.identity_accounts where connection_id = c limit 1), 'current'
  from unnest(array['5b000000-0000-4000-8000-00000000001e'::uuid, '5b000000-0000-4000-8000-00000000005a'::uuid, '5b000000-0000-4000-8000-000000000d1f'::uuid]) c;
insert into public.directory_application_group_assignments (tenant_id, connection_id, provider, directory_application_id, directory_group_id, sync_status)
select '5b000000-0000-4000-8000-00000000000a', c, 'okta',
       (select id from public.directory_applications where connection_id = c limit 1),
       (select id from public.directory_groups where connection_id = c limit 1), 'current'
  from unnest(array['5b000000-0000-4000-8000-00000000001e'::uuid, '5b000000-0000-4000-8000-00000000005a'::uuid, '5b000000-0000-4000-8000-000000000d1f'::uuid]) c;

-- ════ S0: the pointer's shape is enforced ═════════════════════════════════════════════════════════════════════════
do $$
declare blocked boolean;
begin
  -- A pointer with no timestamp/reason is an undocumented decision; a reason with no pointer excludes nothing.
  blocked := true;
  begin
    update public.connectors set superseded_by = '5b000000-0000-4000-8000-00000000005a' where id = '5b000000-0000-4000-8000-00000000001e';
    blocked := false;
  exception when others then null; end;
  assert blocked, 'S0 a bare superseded_by must be rejected';

  blocked := true;
  begin
    update public.connectors set superseded_reason = 'because' where id = '5b000000-0000-4000-8000-00000000001e';
    blocked := false;
  exception when others then null; end;
  assert blocked, 'S0 a reason without a pointer must be rejected';

  -- Self-supersession would exclude a connector on its own authority and orphan every row it owns.
  blocked := true;
  begin
    update public.connectors set superseded_by = id, superseded_at = now(), superseded_reason = 'self'
     where id = '5b000000-0000-4000-8000-00000000001e';
    blocked := false;
  exception when others then null; end;
  assert blocked, 'S0 self-supersession must be rejected';

  assert (select superseded_by is null from public.connectors where id = '5b000000-0000-4000-8000-00000000001e'),
    'S0 no rejected attempt may have left a partial write';
end $$;

-- ════ S1: BEFORE supersession every surface double-counts — the defect, reproduced ════════════════════════════════
do $$
declare
  TA constant uuid := '5b000000-0000-4000-8000-00000000000a';
  c jsonb; n int;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','5b000000-0000-4000-8000-00000000a0f1')::text, true);

  c := public.product_directory_access_counts(TA);
  -- 2 shared people + 1 from the other org; 2 shared groups + 1 extra + 1 other; 2 shared apps + 1 other.
  assert (c ->> 'identities')::int = 3, 'S1 expected 3 identities pre-fix, got ' || (c ->> 'identities');
  assert (c ->> 'groups')::int = 4, 'S1 expected 4 groups pre-fix, got ' || (c ->> 'groups');
  assert (c ->> 'applications')::int = 3, 'S1 expected 3 applications pre-fix, got ' || (c ->> 'applications');

  select count(*) into n from public.product_list_directory_identities(TA);
  assert n = 3, 'S1 the list must show the same 3 pre-fix, got ' || n;
end $$;

-- ════ S2: record the supersession, then every surface agrees ══════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '5b000000-0000-4000-8000-00000000000a';
  LEG constant uuid := '5b000000-0000-4000-8000-00000000001e';
  SUR constant uuid := '5b000000-0000-4000-8000-00000000005a';
  c jsonb; n int; ids uuid[];
begin
  update public.connectors set superseded_by = SUR, superseded_at = now(), superseded_reason = 'same org (test)' where id = LEG;

  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','5b000000-0000-4000-8000-00000000a0f1')::text, true);

  -- COUNTS (Home, /access): the duplicate is gone, the other organization is still there.
  c := public.product_directory_access_counts(TA);
  assert (c ->> 'identities')::int = 2, 'S2 counts identities should be 2, got ' || (c ->> 'identities');
  assert (c ->> 'groups')::int = 3, 'S2 counts groups should be 3, got ' || (c ->> 'groups');
  assert (c ->> 'applications')::int = 2, 'S2 counts applications should be 2, got ' || (c ->> 'applications');
  assert (c ->> 'memberships')::int = 2, 'S2 counts memberships should be 2, got ' || (c ->> 'memberships');
  assert (c ->> 'userAssignments')::int = 2, 'S2 counts userAssignments should be 2, got ' || (c ->> 'userAssignments');
  assert (c ->> 'groupAssignments')::int = 2, 'S2 counts groupAssignments should be 2, got ' || (c ->> 'groupAssignments');

  -- LISTS (People, Groups, Directory applications) must equal the counts exactly — this is requirement 8.
  select count(*) into n from public.product_list_directory_identities(TA);
  assert n = (c ->> 'identities')::int, 'S2 People list (' || n || ') must equal the count (' || (c ->> 'identities') || ')';
  select count(*) into n from public.product_list_directory_groups(TA);
  assert n = (c ->> 'groups')::int, 'S2 Groups list (' || n || ') must equal the count';
  select count(*) into n from public.product_list_directory_applications(TA);
  assert n = (c ->> 'applications')::int, 'S2 Applications list (' || n || ') must equal the count';
  select count(*) into n from public.product_list_group_memberships(TA);
  assert n = (c ->> 'memberships')::int, 'S2 memberships list must equal the count';
  select count(*) into n from public.product_list_user_assignments(TA);
  assert n = (c ->> 'userAssignments')::int, 'S2 user assignments list must equal the count';
  select count(*) into n from public.product_list_group_assignments(TA);
  assert n = (c ->> 'groupAssignments')::int, 'S2 group assignments list must equal the count';

  -- Not one returned row may belong to the superseded connector, on ANY of the six lists.
  select array_agg(connection_id) into ids from public.product_list_directory_identities(TA);
  assert not (LEG = any(ids)), 'S2 People leaked a superseded row';
  select array_agg(connection_id) into ids from public.product_list_directory_groups(TA);
  assert not (LEG = any(ids)), 'S2 Groups leaked a superseded row';
  select array_agg(connection_id) into ids from public.product_list_directory_applications(TA);
  assert not (LEG = any(ids)), 'S2 Applications leaked a superseded row';
  select array_agg(connection_id) into ids from public.product_list_group_memberships(TA);
  assert not (LEG = any(ids)), 'S2 memberships leaked a superseded row';
  select array_agg(connection_id) into ids from public.product_list_user_assignments(TA);
  assert not (LEG = any(ids)), 'S2 user assignments leaked a superseded row';
  select array_agg(connection_id) into ids from public.product_list_group_assignments(TA);
  assert not (LEG = any(ids)), 'S2 group assignments leaked a superseded row';

  -- The stale scope is not a way around it: include_stale must not resurrect a superseded connector.
  select count(*) into n from public.product_list_directory_identities(TA, null, null, true);
  assert n = 2, 'S2 include_stale must not resurrect superseded rows, got ' || n;
end $$;

-- ════ S3: detail pages agree — a superseded record has no detail page ═════════════════════════════════════════════
do $$
declare
  TA constant uuid := '5b000000-0000-4000-8000-00000000000a';
  LEG constant uuid := '5b000000-0000-4000-8000-00000000001e';
  SUR constant uuid := '5b000000-0000-4000-8000-00000000005a';
  leg_person uuid; sur_person uuid; leg_app uuid; sur_app uuid; g jsonb;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','5b000000-0000-4000-8000-00000000a0f1')::text, true);

  select id into leg_person from public.identity_accounts where connection_id = LEG;
  select id into sur_person from public.identity_accounts where connection_id = SUR;
  select id into leg_app from public.directory_applications where connection_id = LEG;
  select id into sur_app from public.directory_applications where connection_id = SUR;

  -- The same PERSON exists under both connectors as two different rows. One opens, one does not.
  assert public.product_identity_access_subgraph(TA, sur_person) is not null, 'S3 the surviving person must open';
  assert public.product_identity_access_subgraph(TA, leg_person) is null,
    'S3 a superseded person must be indistinguishable from one that never existed';
  assert public.product_application_access_subgraph(TA, sur_app) is not null, 'S3 the surviving application must open';
  assert public.product_application_access_subgraph(TA, leg_app) is null, 'S3 a superseded application must not open';

  -- And the surviving subgraph must not have pulled in the superseded connector's neighbours.
  g := public.product_identity_access_subgraph(TA, sur_person);
  assert not (g::text like '%' || LEG::text || '%'), 'S3 the surviving subgraph leaked the superseded connector id';
end $$;

-- ════ S4: a genuinely different Okta organization is untouched ════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '5b000000-0000-4000-8000-00000000000a';
  IND constant uuid := '5b000000-0000-4000-8000-000000000d1f';
  ids uuid[]; p uuid;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','5b000000-0000-4000-8000-00000000a0f1')::text, true);

  -- Supersession is per connector, so a second, unrelated organization stays fully visible. A rule like "one okta connector per
  -- tenant" would have silently deleted this from the product.
  select array_agg(connection_id) into ids from public.product_list_directory_identities(TA);
  assert IND = any(ids), 'S4 the other organization must remain visible';
  select array_agg(connection_id) into ids from public.product_list_directory_groups(TA);
  assert IND = any(ids), 'S4 the other organization''s groups must remain visible';

  select id into p from public.identity_accounts where connection_id = IND;
  assert public.product_identity_access_subgraph(TA, p) is not null, 'S4 the other organization''s detail pages must still open';
end $$;

-- ════ S5: nothing was deleted or rewritten — the exclusion is read-time only ══════════════════════════════════════
do $$
declare
  LEG constant uuid := '5b000000-0000-4000-8000-00000000001e';
  n int; st text;
begin
  reset role;
  -- Every legacy row still exists, still `current`, still owned by the legacy connector.
  select count(*) into n from public.identity_accounts where connection_id = LEG;
  assert n = 1, 'S5 the legacy identity row must still exist, saw ' || n;
  select sync_status into st from public.identity_accounts where connection_id = LEG;
  assert st = 'current', 'S5 the legacy row must NOT have been restatused, it is ' || st;

  select count(*) into n from public.directory_groups where connection_id = LEG;
  assert n = 1, 'S5 the legacy group row must still exist';
  select count(*) into n from public.directory_applications where connection_id = LEG;
  assert n = 1, 'S5 the legacy application row must still exist';
  select count(*) into n from public.directory_group_memberships where connection_id = LEG;
  assert n = 1, 'S5 the legacy membership edge must still exist';

  -- The connector row itself survives, carrying the decision and its reason.
  select count(*) into n from public.connectors where id = LEG and superseded_by is not null and superseded_reason is not null;
  assert n = 1, 'S5 the superseded connector row must remain, with its recorded reason';
end $$;

-- ════ S6: the exclusion keys on OWNERSHIP, not on any row attribute ═══════════════════════════════════════════════
do $$
declare
  TA constant uuid := '5b000000-0000-4000-8000-00000000000a';
  LEG constant uuid := '5b000000-0000-4000-8000-00000000001e';
  SUR constant uuid := '5b000000-0000-4000-8000-00000000005a';
  n int;
begin
  -- Give the legacy person a DIFFERENT external_id, login and display name. If the filter were deduplicating on any row
  -- attribute, the row would reappear the moment it stopped looking like its twin. It must stay excluded regardless.
  update public.identity_accounts
     set external_id = '00uCOMPLETELY_DIFFERENT', login = 'nothing-alike@example.test', display_name = 'Nothing Alike'
   where connection_id = LEG;

  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','5b000000-0000-4000-8000-00000000a0f1')::text, true);
  select count(*) into n from public.product_list_directory_identities(TA);
  assert n = 2, 'S6 a superseded row must stay excluded on OWNERSHIP alone, got ' || n;

  reset role;
  -- Un-supersede and it returns immediately: the filter reads the pointer, nothing is cached or materialized.
  update public.connectors set superseded_by = null, superseded_at = null, superseded_reason = null where id = LEG;
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','5b000000-0000-4000-8000-00000000a0f1')::text, true);
  select count(*) into n from public.product_list_directory_identities(TA);
  assert n = 3, 'S6 clearing the pointer must restore the rows, got ' || n;

  reset role;
  update public.connectors set superseded_by = SUR, superseded_at = now(), superseded_reason = 'same org (test)' where id = LEG;
end $$;

-- ════ S7: another tenant is unaffected, and authorization still governs ═══════════════════════════════════════════
do $$
declare
  TB constant uuid := '5b000000-0000-4000-8000-00000000000b';
  TA constant uuid := '5b000000-0000-4000-8000-00000000000a';
  n int;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','5b000000-0000-4000-8000-00000000a0f1')::text, true);
  -- The caller owns tenant A only. Supersession must not have widened what a tenant can see.
  select count(*) into n from public.product_list_directory_identities(TB);
  assert n = 0, 'S7 another tenant must return nothing, got ' || n;
  assert public.product_directory_access_counts(TB) is null
      or (public.product_directory_access_counts(TB) ->> 'identities')::int = 0, 'S7 another tenant must count zero';
end $$;
