-- okta_connector_config_test.sql — verifies migration 0063 (O2A: metadata-only Okta connector configuration).
-- ENVIRONMENT CONTRACT (scripts/test-rls.sh): a local throwaway Postgres, ALL migrations applied, the Supabase auth shim
-- (auth.uid() reads request.jwt.claims->>'sub') + the authenticated/service_role roles present. Run with ON_ERROR_STOP=1.
-- Self-contained fixtures (own UUIDs) so ordering vs other *_test.sql does not matter. SYNTHETIC values only.
--
-- WHAT THIS PROVES. The approved model (docs/78) has NO per-connector secret, so the security of O2A rests entirely on: who may
-- write, what they may write, and what the database refuses to represent at all. Every assertion below targets one of those.
\set ON_ERROR_STOP on
reset role;

-- ── Fixtures: two tenants; owner/admin/editor/viewer of A; owner of B; one non-member ─────────────────────────────────────
insert into auth.users (id, email) values
  ('c0a70000-0000-4000-8000-00000000a001','owner-a@example.test'),
  ('c0a70000-0000-4000-8000-00000000a002','admin-a@example.test'),
  ('c0a70000-0000-4000-8000-00000000a003','editor-a@example.test'),
  ('c0a70000-0000-4000-8000-00000000a004','viewer-a@example.test'),
  ('c0a70000-0000-4000-8000-00000000b001','owner-b@example.test'),
  ('c0a70000-0000-4000-8000-00000000f001','nonmember@example.test')
on conflict (id) do nothing;
insert into public.profiles (id, email) values
  ('c0a70000-0000-4000-8000-00000000a001','owner-a@example.test'),
  ('c0a70000-0000-4000-8000-00000000a002','admin-a@example.test'),
  ('c0a70000-0000-4000-8000-00000000a003','editor-a@example.test'),
  ('c0a70000-0000-4000-8000-00000000a004','viewer-a@example.test'),
  ('c0a70000-0000-4000-8000-00000000b001','owner-b@example.test'),
  ('c0a70000-0000-4000-8000-00000000f001','nonmember@example.test')
on conflict (id) do nothing;
insert into public.tenants (id, name, slug) values
  ('c0a70000-0000-4000-8000-00000000d001','O2A Tenant A','o2a-tenant-a'),
  ('c0a70000-0000-4000-8000-00000000d002','O2A Tenant B','o2a-tenant-b')
on conflict (id) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('c0a70000-0000-4000-8000-00000000d001','c0a70000-0000-4000-8000-00000000a001','owner'),
  ('c0a70000-0000-4000-8000-00000000d001','c0a70000-0000-4000-8000-00000000a002','admin'),
  ('c0a70000-0000-4000-8000-00000000d001','c0a70000-0000-4000-8000-00000000a003','editor'),
  ('c0a70000-0000-4000-8000-00000000d001','c0a70000-0000-4000-8000-00000000a004','viewer'),
  ('c0a70000-0000-4000-8000-00000000d002','c0a70000-0000-4000-8000-00000000b001','owner')
on conflict do nothing;

-- Synthetic sha256-shaped fingerprints (64 hex). Never derived here — derivation lives in reviewed TypeScript (O1C).
\set FP_ORG '''aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888'''
\set FP_APP '''1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb'''

-- ── C0: the table, its governance CHECKs, RLS and the audit trigger exist ─────────────────────────────────────────────────
do $$ begin
  assert (select relrowsecurity from pg_class where oid='public.okta_connector_configs'::regclass), 'C0 RLS enabled';
  assert exists (select 1 from pg_constraint where conname='okta_config_certification_chk'), 'C0 certification CHECK';
  assert exists (select 1 from pg_constraint where conname='okta_config_production_chk'), 'C0 production CHECK';
  assert exists (select 1 from pg_constraint where conname='okta_config_scopes_chk'), 'C0 scopes CHECK';
  assert exists (select 1 from pg_constraint where conname='okta_config_verified_requires_success_chk'), 'C0 verified-requires-success CHECK';
  assert exists (select 1 from pg_trigger where tgname='okta_connector_config_audit'), 'C0 audit trigger';
  -- NO secret/key column may exist on this table at all.
  assert not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='okta_connector_configs'
      and (column_name like '%private%' or column_name like '%secret%' or column_name like '%token%'
           or column_name like '%pem%' or column_name like '%assertion%')
  ), 'C0 NO secret-bearing column may exist';
end $$;

-- ── C1: OWNER can create; the result is truthful and unverified ───────────────────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"c0a70000-0000-4000-8000-00000000a001"}',false);
set role authenticated;
do $$
declare r jsonb; cfg public.okta_connector_configs%rowtype; conn public.connectors%rowtype;
begin
  r := public.create_okta_connector_configuration(
        'c0a70000-0000-4000-8000-00000000d001','acme.okta.com','0oaOWNERapp0000001',
        'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
        '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
        'c0a70000-0000-4000-8000-00000000e001');
  assert r->>'outcome' = 'created', 'C1 owner create';
  assert r->>'connection_state' = 'configured', 'C1 state is configured';

  select * into cfg from public.okta_connector_configs where id = (r->>'config_id')::uuid;
  select * into conn from public.connectors where id = (r->>'connector_id')::uuid;

  -- Server-derived authority: the caller supplied none of these.
  assert cfg.tenant_id = 'c0a70000-0000-4000-8000-00000000d001', 'C1 tenant derived';
  assert cfg.created_by = 'c0a70000-0000-4000-8000-00000000a001', 'C1 actor derived from auth.uid()';
  assert cfg.contract_version = '1.0.0', 'C1 contract version derived';
  assert cfg.authentication_mode = 'private_key_jwt', 'C1 auth mode derived';
  assert cfg.approved_scopes @> array['okta.users.read','okta.groups.read','okta.apps.read']::text[]
     and cardinality(cfg.approved_scopes) = 3, 'C1 exact three scopes derived';
  assert cfg.certification_only is true and cfg.production_enabled is false, 'C1 governance pinned';

  -- NOTHING is claimed as verified.
  assert cfg.verified_organization_fingerprint is null, 'C1 no verified fingerprint';
  assert cfg.validation_status = 'never_validated', 'C1 never validated';
  assert cfg.last_validated_at is null, 'C1 no validation timestamp';
  assert cfg.signing_key_id is null, 'C1 no signing key until O2B';
  assert cfg.public_key_delivery_mode = 'not_configured', 'C1 delivery mode not yet configured';
  assert conn.connection_state = 'configured', 'C1 connector state truthful';
  assert conn.status = 'pending', 'C1 connector NOT active';
  -- (The "no credential reference" assertion lives in C8: `connector_credential_references` is revoked from `authenticated`,
  -- so it cannot be read from inside this block — which is itself the correct posture.)
end $$;
reset role;

-- ── C2: audit written EXACTLY ONCE, bounded, non-secret ───────────────────────────────────────────────────────────────────
do $$
declare n int; a public.audit_logs%rowtype;
begin
  select count(*) into n from public.audit_logs
    where tenant_id='c0a70000-0000-4000-8000-00000000d001' and action='okta_connector_configuration_created';
  assert n = 1, 'C2 exactly one created audit event, got ' || n;
  select * into a from public.audit_logs
    where tenant_id='c0a70000-0000-4000-8000-00000000d001' and action='okta_connector_configuration_created';
  assert a.actor_user_id = 'c0a70000-0000-4000-8000-00000000a001', 'C2 actor recorded';
  assert a.resource_type = 'okta_connector_config', 'C2 resource type';
  assert (a.after_json->>'verified')::boolean is false, 'C2 audit says NOT verified';
  assert a.after_json ? 'normalized_org_host', 'C2 bounded projection present';
  -- No secret-shaped VALUE anywhere in the event. Matched on shapes and on secret-bearing KEYS — not on substrings that occur
  -- legitimately in mode names (`authentication_mode` is "private_key_jwt", which contains "private").
  assert a.after_json::text !~ '-----BEGIN', 'C2 audit carries no PEM';
  assert not (a.after_json ?| array['private_key','secret','access_token','client_assertion','client_secret','api_token']),
    'C2 audit carries no secret-bearing key';
  -- ALLOWLIST, not pattern-matching: the projection is an explicit jsonb_build_object, so asserting its EXACT key set proves no
  -- unexpected value can ever appear. (A blob-shaped scan would flag the 64-hex fingerprint, which is deliberately included and
  -- non-secret.)
  assert (select array_agg(k order by k) from jsonb_object_keys(a.after_json) k) = array[
    'authentication_mode','certification_only','connector_id','contract_version','normalized_org_host','production_enabled',
    'proposed_organization_fingerprint','provider','public_key_delivery_mode','validation_status','verified'
  ]::text[], 'C2 audit projection is exactly the allowlisted key set';
  -- the only value mentioning "private" is the non-secret auth-mode label
  assert a.after_json->>'authentication_mode' = 'private_key_jwt', 'C2 auth mode label present and non-secret';
end $$;

-- ── C3: IDEMPOTENCY — replay returns the same connector and emits NO second created event ─────────────────────────────────
select set_config('request.jwt.claims','{"sub":"c0a70000-0000-4000-8000-00000000a001"}',false);
set role authenticated;
do $$
declare r jsonb; n int; before_conn int; after_conn int;
begin
  select count(*) into before_conn from public.connectors where tenant_id='c0a70000-0000-4000-8000-00000000d001';
  r := public.create_okta_connector_configuration(
        'c0a70000-0000-4000-8000-00000000d001','acme.okta.com','0oaOWNERapp0000001',
        'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
        '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
        'c0a70000-0000-4000-8000-00000000e001');   -- SAME idempotency key
  assert r->>'outcome' = 'idempotent_replay', 'C3 replay detected';
  select count(*) into after_conn from public.connectors where tenant_id='c0a70000-0000-4000-8000-00000000d001';
  assert before_conn = after_conn, 'C3 no second connector created';
  select count(*) into n from public.audit_logs
    where tenant_id='c0a70000-0000-4000-8000-00000000d001' and action='okta_connector_configuration_created';
  assert n = 1, 'C3 STILL exactly one created audit event, got ' || n;
end $$;
reset role;

-- ── C4: ADMIN can create; EDITOR, VIEWER, NON-MEMBER and CROSS-TENANT cannot ──────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"c0a70000-0000-4000-8000-00000000a002"}',false);
set role authenticated;
do $$ declare r jsonb; begin
  r := public.create_okta_connector_configuration(
        'c0a70000-0000-4000-8000-00000000d001','admin-org.okta.com','0oaADMINapp000001',
        'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
        '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
        'c0a70000-0000-4000-8000-00000000e002');
  assert r->>'outcome' = 'created', 'C4 admin create';
end $$;
reset role;

do $$
declare
  actors text[] := array[
    'c0a70000-0000-4000-8000-00000000a003',  -- editor
    'c0a70000-0000-4000-8000-00000000a004',  -- viewer
    'c0a70000-0000-4000-8000-00000000f001'   -- non-member
  ];
  a text; i int := 0;
begin
  foreach a in array actors loop
    i := i + 1;
    perform set_config('request.jwt.claims', json_build_object('sub', a)::text, false);
    execute 'set role authenticated';
    begin
      perform public.create_okta_connector_configuration(
        'c0a70000-0000-4000-8000-00000000d001','denied.okta.com','0oaDENIEDapp00001',
        'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
        '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
        ('c0a70000-0000-4000-8000-00000000e1' || lpad(i::text,2,'0'))::uuid);
      execute 'reset role';
      assert false, 'C4 actor ' || a || ' must NOT create a connector';
    exception when insufficient_privilege then execute 'reset role';
    end;
  end loop;
end $$;

-- CROSS-TENANT: owner of B cannot create in A.
select set_config('request.jwt.claims','{"sub":"c0a70000-0000-4000-8000-00000000b001"}',false);
set role authenticated;
do $$ begin
  begin
    perform public.create_okta_connector_configuration(
      'c0a70000-0000-4000-8000-00000000d001','cross.okta.com','0oaCROSSapp000001',
      'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
      '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
      'c0a70000-0000-4000-8000-00000000e201');
    assert false, 'C4 cross-tenant create must be denied';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ANONYMOUS (no auth.uid()) is denied.
select set_config('request.jwt.claims','',false);
set role authenticated;
do $$ begin
  begin
    perform public.create_okta_connector_configuration(
      'c0a70000-0000-4000-8000-00000000d001','anon.okta.com','0oaANONapp0000001',
      'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
      '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
      'c0a70000-0000-4000-8000-00000000e301');
    assert false, 'C4 anonymous create must be denied';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ── C5: the database REFUSES to represent an untruthful configuration ─────────────────────────────────────────────────────
do $$
declare
  tid uuid := 'c0a70000-0000-4000-8000-00000000d001';
  cid uuid;
  cfg_id uuid;
begin
  select connector_id into cid from public.okta_connector_configs where tenant_id = tid limit 1;

  -- governance cannot be flipped
  begin update public.okta_connector_configs set certification_only = false where tenant_id = tid;
    assert false, 'C5 certification_only must not be settable to false'; exception when check_violation then null; end;
  begin update public.okta_connector_configs set production_enabled = true where tenant_id = tid;
    assert false, 'C5 production_enabled must not be settable to true'; exception when check_violation then null; end;

  -- contract version and auth mode are pinned
  begin update public.okta_connector_configs set contract_version = '2.0.0' where tenant_id = tid;
    assert false, 'C5 contract version pinned'; exception when check_violation then null; end;
  begin update public.okta_connector_configs set authentication_mode = 'api_token' where tenant_id = tid;
    assert false, 'C5 auth mode pinned'; exception when check_violation then null; end;

  -- scopes: superseded sets, duplicates, manage scopes and extras are all impossible
  begin update public.okta_connector_configs set approved_scopes = array['okta.users.read']::text[] where tenant_id = tid;
    assert false, 'C5 users-only scope set rejected'; exception when check_violation then null; end;
  begin update public.okta_connector_configs set approved_scopes = array['okta.users.read','okta.groups.read']::text[] where tenant_id = tid;
    assert false, 'C5 two-scope set rejected'; exception when check_violation then null; end;
  begin update public.okta_connector_configs
      set approved_scopes = array['okta.users.read','okta.groups.read','okta.apps.read','okta.users.manage']::text[] where tenant_id = tid;
    assert false, 'C5 manage scope rejected'; exception when check_violation then null; end;
  begin update public.okta_connector_configs
      set approved_scopes = array['okta.users.read','okta.users.read','okta.groups.read','okta.apps.read']::text[] where tenant_id = tid;
    assert false, 'C5 duplicate scope rejected'; exception when check_violation then null; end;

  -- THE CENTRAL ONE: a verified fingerprint cannot exist without a successful validation.
  -- Scoped to a SINGLE row by id. An unscoped UPDATE would set the same verified fingerprint on several rows and trip
  -- `okta_config_verified_org_uidx` first — the suite would still fail, but for the wrong reason, leaving this CHECK unproven.
  select id into strict cfg_id from public.okta_connector_configs where tenant_id = tid order by created_at limit 1;
  begin
    update public.okta_connector_configs
      set verified_organization_fingerprint = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888'
      where id = cfg_id;
    assert false, 'C5 verified fingerprint requires validation_status=succeeded';
  exception when check_violation then null; end;

  -- …and the positive direction: WITH a successful validation recorded, the same write is accepted. This proves the constraint
  -- gates on validation state rather than forbidding the column outright.
  update public.okta_connector_configs
    set validation_status = 'succeeded', last_validated_at = now(),
        verified_organization_fingerprint = 'cccc9999dddd8888eeee7777ffff6666aaaa5555bbbb4444cccc3333dddd2222'
    where id = cfg_id;
  assert (select verified_organization_fingerprint is not null from public.okta_connector_configs where id = cfg_id),
    'C5 verified fingerprint accepted once validation succeeded';
  -- restore the fixture to its unverified state for later assertions
  update public.okta_connector_configs
    set verified_organization_fingerprint = null, validation_status = 'never_validated', last_validated_at = null
    where id = cfg_id;

  -- invalid host shapes
  begin insert into public.okta_connector_configs (tenant_id, connector_id, normalized_org_host, client_id,
      proposed_organization_fingerprint, service_app_fingerprint, approved_scopes, idempotency_key)
    values (tid, cid, 'ACME.OKTA.COM', '0oaX00000000001',
      'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
      '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
      array['okta.users.read','okta.groups.read','okta.apps.read']::text[], gen_random_uuid());
    assert false, 'C5 upper-case host rejected'; exception when check_violation then null; when unique_violation then null; end;
end $$;

-- Host/client-id shapes that must all be refused (each inserted against a fresh connector to isolate the CHECK under test).
do $$
declare
  tid uuid := 'c0a70000-0000-4000-8000-00000000d001';
  bad_hosts text[] := array['acme.evil.com','a.b.okta.com','okta.com','acme.okta.com:8443','acme.okta.com/x','169.254.169.254','localhost','acme.notokta.com'];
  bad_ids   text[] := array['','0oa','has space','0oaX;drop','0oa' || repeat('x', 300)];
  h text; c text; k uuid; new_conn uuid;
begin
  foreach h in array bad_hosts loop
    insert into public.connectors (tenant_id, provider, status) values (tid,'okta','pending') returning id into new_conn;
    begin
      insert into public.okta_connector_configs (tenant_id, connector_id, normalized_org_host, client_id,
        proposed_organization_fingerprint, service_app_fingerprint, approved_scopes, idempotency_key)
      values (tid, new_conn, h, '0oaVALIDapp000001',
        'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
        '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
        array['okta.users.read','okta.groups.read','okta.apps.read']::text[], gen_random_uuid());
      assert false, 'C5 host must be rejected: ' || h;
    exception when check_violation then null; end;
    delete from public.connectors where id = new_conn;
  end loop;

  foreach c in array bad_ids loop
    insert into public.connectors (tenant_id, provider, status) values (tid,'okta','pending') returning id into new_conn;
    begin
      insert into public.okta_connector_configs (tenant_id, connector_id, normalized_org_host, client_id,
        proposed_organization_fingerprint, service_app_fingerprint, approved_scopes, idempotency_key)
      values (tid, new_conn, 'shapes.okta.com', c,
        'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
        '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
        array['okta.users.read','okta.groups.read','okta.apps.read']::text[], gen_random_uuid());
      assert false, 'C5 client id must be rejected: ' || quote_literal(c);
    exception when check_violation then null; end;
    delete from public.connectors where id = new_conn;
  end loop;
end $$;

-- ── C6: duplicate ACTIVE configuration for the same target is refused ─────────────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"c0a70000-0000-4000-8000-00000000a001"}',false);
set role authenticated;
do $$ declare r jsonb; begin
  -- same tenant + host + client id, but a DIFFERENT idempotency key: this is a genuine duplicate, not a retry.
  r := public.create_okta_connector_configuration(
        'c0a70000-0000-4000-8000-00000000d001','acme.okta.com','0oaOWNERapp0000001',
        'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
        '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
        'c0a70000-0000-4000-8000-00000000e999');
  assert r->>'outcome' = 'duplicate_configuration', 'C6 duplicate active config refused, got ' || (r->>'outcome');
end $$;
reset role;

-- Same host, DIFFERENT client id is allowed (a recreated service app is credential replacement, not a duplicate org).
select set_config('request.jwt.claims','{"sub":"c0a70000-0000-4000-8000-00000000a001"}',false);
set role authenticated;
do $$ declare r jsonb; begin
  r := public.create_okta_connector_configuration(
        'c0a70000-0000-4000-8000-00000000d001','acme.okta.com','0oaRECREATEDapp01',
        'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
        '2222aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888cccc',
        'c0a70000-0000-4000-8000-00000000e998');
  assert r->>'outcome' = 'created', 'C6 same host + different client id is allowed';
end $$;
reset role;

-- A DIFFERENT tenant may connect the SAME Okta org — tenants are isolated, and blocking would leak existence.
select set_config('request.jwt.claims','{"sub":"c0a70000-0000-4000-8000-00000000b001"}',false);
set role authenticated;
do $$ declare r jsonb; begin
  r := public.create_okta_connector_configuration(
        'c0a70000-0000-4000-8000-00000000d002','acme.okta.com','0oaOWNERapp0000001',
        'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
        '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
        'c0a70000-0000-4000-8000-00000000e997');
  assert r->>'outcome' = 'created', 'C6 cross-tenant same Okta org is allowed';
end $$;
reset role;

-- ── C7: request roles cannot write or delete directly; reads are tenant-scoped ────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"c0a70000-0000-4000-8000-00000000a001"}',false);
set role authenticated;
do $$ declare n int; begin
  -- INSERT: RLS has no insert policy, so a write attempt is refused outright (42501).
  begin
    insert into public.okta_connector_configs (tenant_id, connector_id, normalized_org_host, client_id,
      proposed_organization_fingerprint, service_app_fingerprint, approved_scopes, idempotency_key)
    values ('c0a70000-0000-4000-8000-00000000d001', gen_random_uuid(), 'direct.okta.com','0oaDIRECT00000001',
      'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
      '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777aaaa8888bbbb',
      array['okta.users.read','okta.groups.read','okta.apps.read']::text[], gen_random_uuid());
    assert false, 'C7 direct INSERT must be denied';
  exception when insufficient_privilege then null; end;

  -- UPDATE/DELETE: the ENFORCEMENT BOUNDARY IS RLS, NOT TABLE GRANTS. Both this harness and hosted Supabase blanket-grant DML on
  -- public tables to `authenticated`, so the migration's REVOKE is defence-in-depth that the platform re-grants. With RLS enabled
  -- and NO update/delete policy, the correct and provable property is that a request role can modify ZERO ROWS — silently, without
  -- an error. Asserting "must raise" would have been testing the wrong mechanism.
  update public.okta_connector_configs set client_id = '0oaTAMPERED000001';
  get diagnostics n = row_count;
  assert n = 0, 'C7 direct UPDATE must affect zero rows, affected ' || n;

  delete from public.okta_connector_configs;
  get diagnostics n = row_count;
  assert n = 0, 'C7 direct DELETE must affect zero rows, affected ' || n;

  -- Connector deletion is likewise unavailable: `connectors` is the parent of 19 `on delete cascade` FKs across 12 tables, so a
  -- successful delete would silently destroy the tenant's canonical directory graph.
  --
  -- `connectors` is hardened by GRANT (a privilege error) whereas this table is hardened by RLS (zero rows). Both satisfy the
  -- property under test — "a request role cannot delete a connector" — so accept either, and fail only if a row actually goes.
  begin
    delete from public.connectors where tenant_id='c0a70000-0000-4000-8000-00000000d001';
    get diagnostics n = row_count;
    assert n = 0, 'C7 connector DELETE must affect zero rows, affected ' || n;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- A member of tenant B sees only B's configs.
select set_config('request.jwt.claims','{"sub":"c0a70000-0000-4000-8000-00000000b001"}',false);
set role authenticated;
do $$ declare n_a int; n_b int; begin
  select count(*) into n_a from public.okta_connector_configs where tenant_id='c0a70000-0000-4000-8000-00000000d001';
  select count(*) into n_b from public.okta_connector_configs where tenant_id='c0a70000-0000-4000-8000-00000000d002';
  assert n_a = 0, 'C7 tenant B must not read tenant A configs, saw ' || n_a;
  assert n_b >= 1, 'C7 tenant B reads its own config';
end $$;
reset role;

-- A viewer of tenant A CAN read (non-secret status metadata) but still cannot write.
select set_config('request.jwt.claims','{"sub":"c0a70000-0000-4000-8000-00000000a004"}',false);
set role authenticated;
do $$ declare n int; begin
  select count(*) into n from public.okta_connector_configs where tenant_id='c0a70000-0000-4000-8000-00000000d001';
  assert n >= 1, 'C7 viewer reads tenant status metadata';
end $$;
reset role;

-- ── C8: no Okta connector acquires a credential reference ─────────────────────────────────────────────────────────────────
do $$ declare n int; begin
  select count(*) into n
    from public.connector_credential_references r
    join public.okta_connector_configs c on c.connector_id = r.connector_id;
  assert n = 0, 'C8 no Okta connector may have a credential reference, found ' || n;
end $$;

-- ── C9: the connection-state vocabulary is truthful and closed ────────────────────────────────────────────────────────────
do $$
declare tid uuid := 'c0a70000-0000-4000-8000-00000000d001';
begin
  -- O2A never produces a state that claims verification.
  assert not exists (
    select 1 from public.connectors
    where tenant_id = tid and connection_state in ('ready_for_initial_sync','verified')
  ), 'C9 O2A must not produce a verified/ready state';
  -- and an invented state is refused outright
  begin update public.connectors set connection_state = 'healthy' where tenant_id = tid;
    assert false, 'C9 unknown connection_state rejected'; exception when check_violation then null; end;
  begin update public.connectors set connection_state = 'connected' where tenant_id = tid;
    assert false, 'C9 connected state rejected'; exception when check_violation then null; end;
  -- O2A did not touch 0052's vocabulary: the discovery lifecycle states must all still be accepted.
  begin update public.connectors set connection_state = 'discovered' where tenant_id = tid and connection_state = 'configured';
    exception when check_violation then assert false, 'C9 O2A must not have narrowed the 0052 vocabulary'; end;
  update public.connectors set connection_state = 'configured' where tenant_id = tid and connection_state = 'discovered';
end $$;

select 'ALL O2A OKTA CONNECTOR CONFIG ASSERTIONS PASSED' as result;
