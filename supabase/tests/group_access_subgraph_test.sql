-- 0072 — product_group_access_subgraph.
--
-- The group subgraph is the first read RPC written after the P0 duplicate-connector fix, so connector scoping is not a nice-to-have
-- here: it is the property the whole surface rests on. These tests are weighted accordingly — most of them try to make a group pull
-- in a row it does not own.
--
-- NOTE ON NEGATIVE TESTS: `raise exception` is SQLSTATE P0001 and `when others` swallows it, so negatives assert on a flag set
-- OUTSIDE the handler.

reset role;

-- ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Tenant A holds THREE okta connectors: ACT (active, the subject), SUP (superseded by ACT — the P0 shape), and IND (a genuinely
-- different organization, which must stay fully readable). Tenant B is unrelated.
insert into public.tenants (id, name, slug) values
  ('9c000000-0000-4000-8000-00000000000a', 'Group A', 'grp-a'),
  ('9c000000-0000-4000-8000-00000000000b', 'Group B', 'grp-b');
insert into auth.users (id, email) values ('9c000000-0000-4000-8000-00000000aaf1', 'grp-owner@example.test') on conflict do nothing;
insert into public.profiles (id, email) values ('9c000000-0000-4000-8000-00000000aaf1', 'grp-owner@example.test') on conflict do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-00000000aaf1', 'owner') on conflict do nothing;

insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('9c000000-0000-4000-8000-0000000000ac', '9c000000-0000-4000-8000-00000000000a', 'okta', 'Active',     'pending', 'discovered'),
  ('9c000000-0000-4000-8000-0000000000e5', '9c000000-0000-4000-8000-00000000000a', 'okta', 'Superseded', 'pending', 'discovered'),
  ('9c000000-0000-4000-8000-0000000000cd', '9c000000-0000-4000-8000-00000000000a', 'okta', 'Other org',  'pending', 'discovered'),
  ('9c000000-0000-4000-8000-0000000000bb', '9c000000-0000-4000-8000-00000000000b', 'okta', 'Tenant B',   'pending', 'discovered');

-- Groups: one per connector. ACT's is the subject; the others exist to be excluded or preserved.
insert into public.directory_groups (id, tenant_id, connection_id, provider, external_id, name, description, group_type_category, sync_status, last_seen_at) values
  ('9c000000-0000-4000-8000-000000009001', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000ac', 'okta', '00gACT', 'Everyone',  'All employees', 'built_in',   'current', now()),
  ('9c000000-0000-4000-8000-000000009002', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000e5', 'okta', '00gACT', 'Everyone',  'All employees', 'built_in',   'current', now()),
  ('9c000000-0000-4000-8000-000000009003', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000cd', 'okta', '00gIND', 'OtherOrg',  null,            'okta_group', 'current', now()),
  ('9c000000-0000-4000-8000-000000009004', '9c000000-0000-4000-8000-00000000000b', '9c000000-0000-4000-8000-0000000000bb', 'okta', '00gTB',  'TenantB',   null,            'okta_group', 'current', now()),
  -- A STALE group under the active connector, and an empty one, for the state cases.
  ('9c000000-0000-4000-8000-000000009005', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000ac', 'okta', '00gOLD', 'Retired',   null,            'okta_group', 'stale',   now() - interval '9 days'),
  ('9c000000-0000-4000-8000-000000009006', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000ac', 'okta', '00gEMP', 'Empty',     null,            'okta_group', 'current', now());
update public.directory_groups set stale_since = now() - interval '9 days' where id = '9c000000-0000-4000-8000-000000009005';

-- Identities: two under ACT (one current, one stale), one under SUP with the SAME external id, one under IND, one in tenant B.
insert into public.identity_accounts (id, tenant_id, connection_id, provider, external_id, login, email, display_name, is_active, sync_status) values
  ('9c000000-0000-4000-8000-0000000000f1', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000ac', 'okta', '00uA', 'ada@example.test',  'ada@example.test',  'Ada Lovelace', true,  'current'),
  ('9c000000-0000-4000-8000-0000000000f2', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000ac', 'okta', '00uB', 'bob@example.test',  'bob@example.test',  'Bob Stone',    false, 'current'),
  ('9c000000-0000-4000-8000-0000000000f3', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000e5', 'okta', '00uA', 'ada@example.test',  'ada@example.test',  'Ada Lovelace', true,  'current'),
  ('9c000000-0000-4000-8000-0000000000f4', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000cd', 'okta', '00uC', 'cy@example.test',   'cy@example.test',   'Cy Other',     true,  'current');

-- Applications: one under ACT, one under SUP (same external id), one under IND.
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, name, label, status_category, sign_on_category, sync_status) values
  ('9c000000-0000-4000-8000-0000000000a1', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000ac', 'okta', '0oaS', 'sf', 'Salesforce', 'active', 'saml_2_0',       'current'),
  ('9c000000-0000-4000-8000-0000000000a2', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000e5', 'okta', '0oaS', 'sf', 'Salesforce', 'active', 'saml_2_0',       'current'),
  ('9c000000-0000-4000-8000-0000000000a3', '9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000cd', 'okta', '0oaZ', 'zd', 'Zendesk',    'active', 'openid_connect', 'current');

-- Edges. ACT's group has both ACT identities as members; SUP's group has its own member; the ACT group grants Salesforce.
-- Ada ALSO holds Salesforce directly, which is the "would they keep it without the group" case.
insert into public.directory_group_memberships (tenant_id, connection_id, provider, directory_group_id, identity_account_id, sync_status) values
  ('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000ac', 'okta', '9c000000-0000-4000-8000-000000009001', '9c000000-0000-4000-8000-0000000000f1', 'current'),
  ('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000ac', 'okta', '9c000000-0000-4000-8000-000000009001', '9c000000-0000-4000-8000-0000000000f2', 'stale'),
  ('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000e5', 'okta', '9c000000-0000-4000-8000-000000009002', '9c000000-0000-4000-8000-0000000000f3', 'current');
update public.directory_group_memberships set stale_since = now() - interval '3 days'
 where directory_group_id = '9c000000-0000-4000-8000-000000009001' and sync_status = 'stale';

insert into public.directory_application_group_assignments (tenant_id, connection_id, provider, directory_application_id, directory_group_id, sync_status) values
  ('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000ac', 'okta', '9c000000-0000-4000-8000-0000000000a1', '9c000000-0000-4000-8000-000000009001', 'current'),
  ('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000e5', 'okta', '9c000000-0000-4000-8000-0000000000a2', '9c000000-0000-4000-8000-000000009002', 'current');

insert into public.directory_application_user_assignments (tenant_id, connection_id, provider, directory_application_id, identity_account_id, sync_status) values
  ('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000ac', 'okta', '9c000000-0000-4000-8000-0000000000a1', '9c000000-0000-4000-8000-0000000000f1', 'current');

update public.connectors set superseded_by = '9c000000-0000-4000-8000-0000000000ac', superseded_at = now(),
       superseded_reason = 'same org (test)' where id = '9c000000-0000-4000-8000-0000000000e5';

-- ════ G0: grant shape ═════════════════════════════════════════════════════════════════════════════════════════════
do $$ begin
  assert     has_function_privilege('authenticated', 'public.product_group_access_subgraph(uuid,uuid,boolean)', 'EXECUTE'), 'G0 authenticated EXECUTE';
  assert not has_function_privilege('anon', 'public.product_group_access_subgraph(uuid,uuid,boolean)', 'EXECUTE'), 'G0 anon denied';
  assert not has_function_privilege('public', 'public.product_group_access_subgraph(uuid,uuid,boolean)', 'EXECUTE'), 'G0 PUBLIC denied';
  assert (select array_to_string(proconfig, ',') from pg_proc where proname = 'product_group_access_subgraph') like 'search_path=%', 'G0 search_path pinned';
  assert (select prosecdef from pg_proc where proname = 'product_group_access_subgraph'), 'G0 security definer';
  -- Direct table access stays denied for browser roles: reads go through the RPC or not at all.
  assert not has_table_privilege('authenticated', 'public.directory_group_memberships', 'SELECT'), 'G0 authenticated has no direct membership read';
  assert not has_table_privilege('anon', 'public.directory_groups', 'SELECT'), 'G0 anon has no direct group read';
end $$;

-- ════ G1: the happy path — summary, members, applications ═════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '9c000000-0000-4000-8000-00000000000a';
  GA constant uuid := '9c000000-0000-4000-8000-000000009001';
  j jsonb;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','9c000000-0000-4000-8000-00000000aaf1')::text, true);

  j := public.product_group_access_subgraph(TA, GA);
  assert j is not null, 'G1 the active group must resolve';
  assert j -> 'group' ->> 'name' = 'Everyone', 'G1 name';
  assert j -> 'group' ->> 'group_type_category' = 'built_in', 'G1 built-in type is carried';
  assert j -> 'group' ->> 'description' = 'All employees', 'G1 description is projected (the list RPC does not carry it)';
  assert (j ->> 'bounded')::boolean = false, 'G1 a small group is not bounded';

  -- Default scope is current-only: Bob's membership is stale, so one member.
  assert jsonb_array_length(j -> 'memberships') = 1, 'G1 current-only memberships, got ' || jsonb_array_length(j -> 'memberships');
  assert jsonb_array_length(j -> 'identities') = 1, 'G1 current-only member identities';
  assert jsonb_array_length(j -> 'groupAssignments') = 1, 'G1 one application grant';
  assert jsonb_array_length(j -> 'applications') = 1, 'G1 one application';
  -- Ada holds Salesforce directly too — the row that answers "would she keep it without this group".
  assert jsonb_array_length(j -> 'userAssignments') = 1, 'G1 the member''s direct holding of the granted app is returned';
end $$;

-- ════ G2: include_stale widens to the SAME connector only ═════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '9c000000-0000-4000-8000-00000000000a';
  GA constant uuid := '9c000000-0000-4000-8000-000000009001';
  SUP constant uuid := '9c000000-0000-4000-8000-0000000000e5';
  j jsonb; conns text[];
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','9c000000-0000-4000-8000-00000000aaf1')::text, true);

  j := public.product_group_access_subgraph(TA, GA, true);
  assert jsonb_array_length(j -> 'memberships') = 2, 'G2 include_stale must add the stale membership, got ' || jsonb_array_length(j -> 'memberships');
  assert jsonb_array_length(j -> 'identities') = 2, 'G2 both member identities';

  -- The stale scope is not a back door to the superseded connector.
  select array_agg(x) into conns from (
    select jsonb_array_elements(j -> 'memberships') ->> 'connection_id' x
    union all select jsonb_array_elements(j -> 'identities') ->> 'connection_id'
    union all select jsonb_array_elements(j -> 'applications') ->> 'connection_id'
    union all select jsonb_array_elements(j -> 'groupAssignments') ->> 'connection_id'
    union all select jsonb_array_elements(j -> 'userAssignments') ->> 'connection_id') s;
  assert not (SUP::text = any(conns)), 'G2 include_stale must never reach the superseded connector';
end $$;

-- ════ G3: SUPERSEDED, CROSS-TENANT and MISSING are one answer ═════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '9c000000-0000-4000-8000-00000000000a';
  TB constant uuid := '9c000000-0000-4000-8000-00000000000b';
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','9c000000-0000-4000-8000-00000000aaf1')::text, true);

  -- The superseded connector's group is a real row with the same name and external id. It must be unreachable.
  assert public.product_group_access_subgraph(TA, '9c000000-0000-4000-8000-000000009002') is null, 'G3 a superseded group must not resolve';
  -- Another tenant's group, addressed with the caller's own tenant id, and with the owning tenant's id.
  assert public.product_group_access_subgraph(TA, '9c000000-0000-4000-8000-000000009004') is null, 'G3 another tenant''s group must not resolve';
  assert public.product_group_access_subgraph(TB, '9c000000-0000-4000-8000-000000009004') is null, 'G3 a tenant the caller does not own must not resolve';
  -- A group id that does not exist.
  assert public.product_group_access_subgraph(TA, '9c000000-0000-4000-8000-00000000dead') is null, 'G3 a missing group must not resolve';
end $$;

-- ════ G4: a DIFFERENT active organization stays fully readable ════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '9c000000-0000-4000-8000-00000000000a';
  j jsonb;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','9c000000-0000-4000-8000-00000000aaf1')::text, true);
  -- Supersession is per connector. A second, genuinely different Okta organization in the same tenant is untouched.
  j := public.product_group_access_subgraph(TA, '9c000000-0000-4000-8000-000000009003');
  assert j is not null, 'G4 the other organization''s group must resolve';
  assert j -> 'group' ->> 'name' = 'OtherOrg', 'G4 it is the right group';
end $$;

-- ════ G5: the composite FKs make a cross-connector edge impossible, and the RPC does not RELY on that ══════════════
-- Two separate facts, tested separately.
do $$
declare n int; blocked boolean;
begin
  -- (a) The database enforces it. dgm_group_fk / dgm_identity_fk and their assignment counterparts are COMPOSITE on
  -- (id, tenant_id, connection_id, provider), so an edge can only ever reference its own connection's rows.
  select count(*) into n from pg_constraint
   where contype = 'f' and conname in ('dgm_group_fk','dgm_identity_fk','daga_group_fk','daga_application_fk','daua_application_fk','daua_identity_fk');
  assert n = 6, 'G5a expected six composite endpoint FKs, saw ' || n;

  -- Attempting the forbidden shape is rejected outright.
  blocked := true;
  begin
    insert into public.directory_group_memberships (tenant_id, connection_id, provider, directory_group_id, identity_account_id, sync_status)
    values ('9c000000-0000-4000-8000-00000000000a', '9c000000-0000-4000-8000-0000000000cd', 'okta',
            '9c000000-0000-4000-8000-000000009001', '9c000000-0000-4000-8000-0000000000f4', 'current');
    blocked := false;
  exception when others then null; end;
  assert blocked, 'G5a a cross-connector membership must be rejected by the composite FK';
end $$;

do $$
declare
  TA constant uuid := '9c000000-0000-4000-8000-00000000000a';
  GA constant uuid := '9c000000-0000-4000-8000-000000009001';
  ACT constant uuid := '9c000000-0000-4000-8000-0000000000ac';
  j jsonb; bad int;
begin
  -- (b) Belt AND braces. The RPC scopes every read by the anchor's connection_id as well. That is redundant WHILE the FKs hold —
  -- which is exactly why it needs testing: a redundant guard that is never exercised is a guard nobody notices removing. Drop the
  -- FKs, plant the forbidden rows, and require the RPC to exclude them on its own authority.
  reset role;
  alter table public.directory_group_memberships drop constraint dgm_group_fk;
  alter table public.directory_application_group_assignments drop constraint daga_group_fk;

  insert into public.directory_group_memberships (tenant_id, connection_id, provider, directory_group_id, identity_account_id, sync_status)
  values (TA, '9c000000-0000-4000-8000-0000000000cd', 'okta', GA, '9c000000-0000-4000-8000-0000000000f4', 'current');
  insert into public.directory_application_group_assignments (tenant_id, connection_id, provider, directory_application_id, directory_group_id, sync_status)
  values (TA, '9c000000-0000-4000-8000-0000000000cd', 'okta', '9c000000-0000-4000-8000-0000000000a3', GA, 'current');

  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','9c000000-0000-4000-8000-00000000aaf1')::text, true);
  j := public.product_group_access_subgraph(TA, GA);

  select count(*) into bad from (
    select jsonb_array_elements(j -> 'memberships') ->> 'connection_id' c
    union all select jsonb_array_elements(j -> 'groupAssignments') ->> 'connection_id'
    union all select jsonb_array_elements(j -> 'identities') ->> 'connection_id'
    union all select jsonb_array_elements(j -> 'applications') ->> 'connection_id'
    union all select jsonb_array_elements(j -> 'userAssignments') ->> 'connection_id') s
   where c is distinct from ACT::text;
  assert bad = 0, 'G5b every returned row must belong to the group''s OWN connector, saw ' || bad || ' foreign row(s)';
  assert jsonb_array_length(j -> 'memberships') = 1, 'G5b the foreign membership must be excluded by the RPC itself';
  assert jsonb_array_length(j -> 'groupAssignments') = 1, 'G5b the foreign assignment must be excluded by the RPC itself';

  reset role;
  delete from public.directory_group_memberships where connection_id = '9c000000-0000-4000-8000-0000000000cd' and directory_group_id = GA;
  delete from public.directory_application_group_assignments where connection_id = '9c000000-0000-4000-8000-0000000000cd' and directory_group_id = GA;
  alter table public.directory_group_memberships add constraint dgm_group_fk
    foreign key (directory_group_id, tenant_id, connection_id, provider)
    references public.directory_groups (id, tenant_id, connection_id, provider) on delete cascade;
  alter table public.directory_application_group_assignments add constraint daga_group_fk
    foreign key (directory_group_id, tenant_id, connection_id, provider)
    references public.directory_groups (id, tenant_id, connection_id, provider) on delete cascade;
end $$;

-- ════ G6: the response carries no raw provider payload or internal plumbing ═══════════════════════════════════════
do $$
declare
  TA constant uuid := '9c000000-0000-4000-8000-00000000000a';
  j jsonb; k text;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','9c000000-0000-4000-8000-00000000aaf1')::text, true);
  j := public.product_group_access_subgraph(TA, '9c000000-0000-4000-8000-000000009001', true);

  -- external_id in particular: it is the provider's own identifier and the thing 0061 deliberately never projects.
  foreach k in array array['external_id','raw_payload','tenant_id','source_endpoint','last_discovery_run_id','schema_version','sanitizer_version','normalizer_version','normalized_name','normalized_login','normalized_email']
  loop
    assert position(k in j::text) = 0, 'G6 the response must not contain ' || k;
  end loop;
end $$;

-- ════ G7: empty and stale groups are real answers, not failures ═══════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '9c000000-0000-4000-8000-00000000000a';
  j jsonb;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','9c000000-0000-4000-8000-00000000aaf1')::text, true);

  -- A group with no members and no grants resolves with empty arrays — distinct from not-found.
  j := public.product_group_access_subgraph(TA, '9c000000-0000-4000-8000-000000009006');
  assert j is not null, 'G7 an empty group must still resolve';
  assert jsonb_array_length(j -> 'memberships') = 0 and jsonb_array_length(j -> 'applications') = 0, 'G7 empty arrays';

  -- A STALE group still opens: its record is preserved, and the caller needs to see why it is stale.
  j := public.product_group_access_subgraph(TA, '9c000000-0000-4000-8000-000000009005', true);
  assert j is not null, 'G7 a stale group must still resolve';
  assert j -> 'group' ->> 'sync_status' = 'stale', 'G7 the stale state is reported';
  assert (j -> 'group' ->> 'stale_since') is not null, 'G7 a stale group carries its timestamp';
end $$;

-- ════ G8: determinism ═════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '9c000000-0000-4000-8000-00000000000a';
  a jsonb; b jsonb;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','9c000000-0000-4000-8000-00000000aaf1')::text, true);
  a := public.product_group_access_subgraph(TA, '9c000000-0000-4000-8000-000000009001', true);
  b := public.product_group_access_subgraph(TA, '9c000000-0000-4000-8000-000000009001', true);
  -- Every array is ORDER BY'd, so repeated calls are byte-identical. Without that a paginating caller could see a row twice.
  assert a::text = b::text, 'G8 repeated calls must return an identical response';
end $$;

-- ════ G9: authorization ═══════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '9c000000-0000-4000-8000-00000000000a';
  GA constant uuid := '9c000000-0000-4000-8000-000000009001';
  ed uuid := '9c000000-0000-4000-8000-00000000eda1';
begin
  reset role;
  insert into auth.users (id, email) values (ed, 'grp-editor@example.test') on conflict do nothing;
  insert into public.profiles (id, email) values (ed, 'grp-editor@example.test') on conflict do nothing;
  insert into public.tenant_memberships (tenant_id, user_id, role) values (TA, ed, 'editor') on conflict do nothing;

  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub', ed)::text, true);
  -- owner/admin only. An editor of the same tenant gets the not-found answer, not a partial view.
  assert public.product_group_access_subgraph(TA, GA) is null, 'G9 an editor must not read the group subgraph';
end $$;

-- ════ G10: the fan-in bound — refused, not truncated ══════════════════════════════════════════════════════════════
-- "Everyone" in a real organization names every identity in the tenant. The other two 0061 subgraphs let the LOADER cap the
-- result after the RPC has built it; for a group that means materializing the whole membership list as jsonb first. This RPC
-- counts before it builds and refuses. Without a test the bound is invisible: every other fixture here is three rows.
do $$
declare
  TA constant uuid := '9c000000-0000-4000-8000-00000000000a';
  ACT constant uuid := '9c000000-0000-4000-8000-0000000000ac';
  BIG constant uuid := '9c000000-0000-4000-8000-000000009007';
  j jsonb; n int;
begin
  reset role;
  insert into public.directory_groups (id, tenant_id, connection_id, provider, external_id, name, group_type_category, sync_status, last_seen_at)
  values (BIG, TA, ACT, 'okta', '00gBIG', 'Everyone (large)', 'built_in', 'current', now());

  -- 2600 members => 1 + 2600 identities + 2600 memberships = 5201, over the function's 5000 cap.
  insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, sync_status)
  select TA, ACT, 'okta', 'bulk-' || i, 'bulk' || i || '@example.test', 'current' from generate_series(1, 2600) i;
  insert into public.directory_group_memberships (tenant_id, connection_id, provider, directory_group_id, identity_account_id, sync_status)
  select TA, ACT, 'okta', BIG, ia.id, 'current' from public.identity_accounts ia
   where ia.connection_id = ACT and ia.external_id like 'bulk-%';

  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','9c000000-0000-4000-8000-00000000aaf1')::text, true);
  j := public.product_group_access_subgraph(TA, BIG);

  assert j is not null, 'G10 a too-large group must still resolve — the group is real, only its neighbourhood is refused';
  assert (j ->> 'bounded')::boolean = true, 'G10 bounded must be true';
  assert j -> 'group' ->> 'name' = 'Everyone (large)', 'G10 the summary is still returned';
  -- Refused, NOT truncated. A partial list would read as the whole membership.
  assert jsonb_array_length(j -> 'memberships') = 0, 'G10 no partial membership list may be returned';
  assert jsonb_array_length(j -> 'identities') = 0, 'G10 no partial identity list may be returned';

  -- And the small group beside it is unaffected: the bound is per request, not a tenant-wide switch.
  j := public.product_group_access_subgraph(TA, '9c000000-0000-4000-8000-000000009001');
  assert (j ->> 'bounded')::boolean = false, 'G10 a small group in the same tenant is still evaluated';

  reset role;
  delete from public.directory_group_memberships where directory_group_id = BIG;
  delete from public.identity_accounts where connection_id = ACT and external_id like 'bulk-%';
  delete from public.directory_groups where id = BIG;
  select count(*) into n from public.identity_accounts where connection_id = ACT and external_id like 'bulk-%';
  assert n = 0, 'G10 fixtures cleaned up so later suites are unaffected';
end $$;
