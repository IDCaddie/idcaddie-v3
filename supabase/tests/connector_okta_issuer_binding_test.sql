-- connector_okta_issuer_binding_test.sql — verifies migration 0048 (the non-secret per-org Okta issuer-binding table + RLS).
-- ENVIRONMENT CONTRACT (scripts/test-rls.sh): a local throwaway Postgres, ALL migrations applied, the Supabase auth shim
-- (auth.uid() reads request.jwt.claims->>'sub') + the authenticated/service_role roles present. Run with ON_ERROR_STOP=1.
-- Self-contained fixtures (own UUIDs) so ordering vs other *_test.sql does not matter. SYNTHETIC values only (no real issuer/PII).

\set ON_ERROR_STOP on
reset role;

-- ── Fixtures: users, two tenants/orgs, memberships (manager+viewer of A; manager of B), one active binding for org A ──────
insert into auth.users (id, email) values
  ('e18b0000-0000-4000-8000-0000000000a1','mgr-a@example.test'),
  ('e18b0000-0000-4000-8000-0000000000a2','viw-a@example.test'),
  ('e18b0000-0000-4000-8000-0000000000b1','mgr-b@example.test')
on conflict (id) do nothing;
insert into public.profiles (id, email) values
  ('e18b0000-0000-4000-8000-0000000000a1','mgr-a@example.test'),
  ('e18b0000-0000-4000-8000-0000000000a2','viw-a@example.test'),
  ('e18b0000-0000-4000-8000-0000000000b1','mgr-b@example.test')
on conflict (id) do nothing;
insert into public.tenants (id, name, slug) values
  ('e18b0000-0000-4000-8000-0000000000d1','Okta Issuer Tenant A','okta-issuer-a'),
  ('e18b0000-0000-4000-8000-0000000000d2','Okta Issuer Tenant B','okta-issuer-b')
on conflict (id) do nothing;
insert into public.organizations (id, tenant_id, name) values
  ('e18b0000-0000-4000-8000-0000000000e1','e18b0000-0000-4000-8000-0000000000d1','Org A'),
  ('e18b0000-0000-4000-8000-0000000000e2','e18b0000-0000-4000-8000-0000000000d2','Org B')
on conflict (id) do nothing;
insert into public.organization_memberships (organization_id, user_id, role) values
  ('e18b0000-0000-4000-8000-0000000000e1','e18b0000-0000-4000-8000-0000000000a1','manager'),
  ('e18b0000-0000-4000-8000-0000000000e1','e18b0000-0000-4000-8000-0000000000a2','viewer'),
  ('e18b0000-0000-4000-8000-0000000000e2','e18b0000-0000-4000-8000-0000000000b1','manager')
on conflict do nothing;
insert into public.connector_okta_issuer_bindings
  (id, tenant_id, organization_id, provider, okta_hostname, issuer_url, environment, approved_scopes, created_by) values
  ('e18b0000-0000-4000-8000-0000000000f1','e18b0000-0000-4000-8000-0000000000d1','e18b0000-0000-4000-8000-0000000000e1',
   'okta','acme.okta.com','https://acme.okta.com','staging', array['okta.users.read']::text[], 'test-operator')
on conflict (id) do nothing;

-- ── I0: RLS enabled; the CHECK constraints + partial unique indexes exist; NO secret column exists ────────────────────────
do $$ begin
  assert (select relrowsecurity from pg_class where oid='public.connector_okta_issuer_bindings'::regclass), 'I0 RLS enabled';
  assert exists (select 1 from pg_constraint where conname='okta_issuer_provider_chk'), 'I0 provider CHECK';
  assert exists (select 1 from pg_constraint where conname='okta_issuer_scope_chk'), 'I0 scope CHECK';
  assert exists (select 1 from pg_constraint where conname='okta_issuer_https_chk'), 'I0 https CHECK';
  assert exists (select 1 from pg_constraint where conname='okta_issuer_env_chk'), 'I0 env CHECK';
  assert exists (select 1 from pg_indexes where indexname='connector_okta_issuer_bindings_active_org_uidx'), 'I0 active-org uidx';
  assert exists (select 1 from pg_indexes where indexname='connector_okta_issuer_bindings_active_issuer_uidx'), 'I0 active-issuer uidx';
  assert (select count(*) from information_schema.columns where table_name='connector_okta_issuer_bindings'
          and lower(column_name) ~ '(secret|token|verifier|authorization_code|password|ciphertext|credential)') = 0, 'I0 no secret column';
end $$;

-- ── I1: an org MANAGER of A reads A''s binding; a VIEWER reads nothing; a manager of B reads nothing (cross-org denied) ────
select set_config('request.jwt.claims','{"sub":"e18b0000-0000-4000-8000-0000000000a1"}',false);
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.connector_okta_issuer_bindings where organization_id='e18b0000-0000-4000-8000-0000000000e1';
  assert v = 1, format('I1 org-A manager should read 1 binding, saw %s', v);
  select count(*) into v from public.connector_okta_issuer_bindings; -- all rows visible to this user
  assert v = 1, format('I1 org-A manager should see ONLY its org (1), saw %s', v);
end $$;
reset role;

select set_config('request.jwt.claims','{"sub":"e18b0000-0000-4000-8000-0000000000a2"}',false); -- viewer of A
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.connector_okta_issuer_bindings;
  assert v = 0, format('I1 org-A VIEWER (not manager) should read 0 bindings, saw %s', v);
end $$;
reset role;

select set_config('request.jwt.claims','{"sub":"e18b0000-0000-4000-8000-0000000000b1"}',false); -- manager of B
set role authenticated;
do $$ declare v int; begin
  select count(*) into v from public.connector_okta_issuer_bindings;
  assert v = 0, format('I1 org-B manager cross-org read should be 0, saw %s', v);
end $$;
reset role;

-- ── I2: request roles cannot WRITE (no insert/update/delete grant or policy) ──────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"e18b0000-0000-4000-8000-0000000000a1"}',false);
set role authenticated;
do $$ begin
  -- with the real hosted grant surface (SELECT-only for authenticated), writes are denied at the PRIVILEGE layer (42501).
  begin
    insert into public.connector_okta_issuer_bindings (tenant_id, organization_id, provider, okta_hostname, issuer_url, environment, approved_scopes, created_by)
      values ('e18b0000-0000-4000-8000-0000000000d1','e18b0000-0000-4000-8000-0000000000e1','okta','x.okta.com','https://x.okta.com','staging', array['okta.users.read']::text[],'mgr');
    assert false, 'I2 authenticated manager must NOT insert an issuer binding';
  exception when insufficient_privilege then null; end;
  begin
    update public.connector_okta_issuer_bindings set approved_by='mgr' where id='e18b0000-0000-4000-8000-0000000000f1';
    assert false, 'I2 authenticated manager must NOT update an issuer binding';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.connector_okta_issuer_bindings where id='e18b0000-0000-4000-8000-0000000000f1';
    assert false, 'I2 authenticated manager must NOT delete an issuer binding';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ── I3: CHECK constraints reject a non-Okta provider, a broader scope, an http issuer, a non-staging env ──────────────────
do $$ begin
  begin insert into public.connector_okta_issuer_bindings (tenant_id, organization_id, provider, okta_hostname, issuer_url, environment, approved_scopes, created_by)
    values ('e18b0000-0000-4000-8000-0000000000d1','e18b0000-0000-4000-8000-0000000000e1','slack','x.okta.com','https://x.okta.com','staging',array['okta.users.read']::text[],'o');
    assert false, 'I3 non-okta provider must be rejected'; exception when check_violation then null; end;
  begin insert into public.connector_okta_issuer_bindings (tenant_id, organization_id, provider, okta_hostname, issuer_url, environment, approved_scopes, created_by)
    values ('e18b0000-0000-4000-8000-0000000000d1','e18b0000-0000-4000-8000-0000000000e1','okta','x.okta.com','https://x.okta.com','staging',array['okta.users.read','okta.groups.read']::text[],'o');
    assert false, 'I3 broader scope must be rejected'; exception when check_violation then null; end;
  begin insert into public.connector_okta_issuer_bindings (tenant_id, organization_id, provider, okta_hostname, issuer_url, environment, approved_scopes, created_by)
    values ('e18b0000-0000-4000-8000-0000000000d1','e18b0000-0000-4000-8000-0000000000e1','okta','x.okta.com','http://x.okta.com','staging',array['okta.users.read']::text[],'o');
    assert false, 'I3 http issuer must be rejected'; exception when check_violation then null; end;
  begin insert into public.connector_okta_issuer_bindings (tenant_id, organization_id, provider, okta_hostname, issuer_url, environment, approved_scopes, created_by)
    values ('e18b0000-0000-4000-8000-0000000000d1','e18b0000-0000-4000-8000-0000000000e1','okta','x.okta.com','https://x.okta.com','production',array['okta.users.read']::text[],'o');
    assert false, 'I3 non-staging env must be rejected'; exception when check_violation then null; end;
end $$;

-- ── I4: the same issuer cannot be ACTIVELY bound to a second organization (cross-org reassignment blocked) ────────────────
do $$ begin
  begin insert into public.connector_okta_issuer_bindings (tenant_id, organization_id, provider, okta_hostname, issuer_url, environment, approved_scopes, created_by)
    values ('e18b0000-0000-4000-8000-0000000000d2','e18b0000-0000-4000-8000-0000000000e2','okta','acme.okta.com','https://acme.okta.com','staging',array['okta.users.read']::text[],'o');
    assert false, 'I4 same issuer must not be actively bound to a second org'; exception when unique_violation then null; end;
end $$;

-- ── I5: EXACT-privilege backstop — authenticated holds ONLY [SELECT]; anon holds NOTHING; anon reads nothing ───────────────
do $$ begin
  -- authenticated holds ONLY SELECT (no write grant); the write-denial in I2 is the PRIVILEGE layer, not just RLS.
  assert has_table_privilege('authenticated','public.connector_okta_issuer_bindings','SELECT'), 'I5 authenticated has SELECT';
  assert not has_table_privilege('authenticated','public.connector_okta_issuer_bindings','INSERT'), 'I5 authenticated has NO INSERT';
  assert not has_table_privilege('authenticated','public.connector_okta_issuer_bindings','UPDATE'), 'I5 authenticated has NO UPDATE';
  assert not has_table_privilege('authenticated','public.connector_okta_issuer_bindings','DELETE'), 'I5 authenticated has NO DELETE';
  -- anon holds NOTHING
  assert not has_table_privilege('anon','public.connector_okta_issuer_bindings','SELECT'), 'I5 anon has NO SELECT';
  assert not has_table_privilege('anon','public.connector_okta_issuer_bindings','INSERT'), 'I5 anon has NO INSERT';
end $$;

select set_config('request.jwt.claims','{"sub":"e18b0000-0000-4000-8000-0000000000a1"}',false); -- an org-A manager
set role anon;
do $$ declare v int; begin
  begin
    select count(*) into v from public.connector_okta_issuer_bindings;
    assert false, 'I5 anon must not read the issuer bindings';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select 'connector_okta_issuer_binding_test OK' as result;
