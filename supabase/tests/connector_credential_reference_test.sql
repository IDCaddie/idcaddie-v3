-- connector_credential_reference_test.sql — verifies migration 0043 (the dedicated deny-all connector_credential_references
-- table + the connector_runner column-scoped read). ENVIRONMENT CONTRACT (scripts/test-rls.sh): a local throwaway Postgres,
-- ALL migrations applied, the connector_runner role present (0021), and the harness grant block applied (which — KEPT IN
-- LOCKSTEP with 0043 — revokes the reference table from anon/authenticated). Run with psql -v ON_ERROR_STOP=1. NEVER hosted.
-- Acting principal switched via SET LOCAL ROLE inside DO blocks. SYNTHETIC values only (no real ARN/credential/account).

\set ON_ERROR_STOP on
reset role;

-- ── Fixtures: two tenants; connectors; reference rows for A1 + B1 (NOT for A2, the fail-closed case) ───────────────────
insert into public.tenants (id, name, slug) values
  ('a2000000-0000-4000-8000-000000000001', 'Cred Ref Tenant A', 'cred-ref-a'),
  ('b2000000-0000-4000-8000-000000000002', 'Cred Ref Tenant B', 'cred-ref-b')
on conflict (id) do nothing;
insert into public.connectors (id, tenant_id, provider, status) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'microsoft_entra', 'active'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'microsoft_entra', 'active'),
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002', 'microsoft_entra', 'active')
on conflict (id) do nothing;
insert into public.connector_credential_references (tenant_id, connector_id, provider, credential_secret_ref, credential_version) values
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'microsoft_entra', 'EXAMPLE-external-secret-reference-A', 'v1'),
  ('b2000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000001', 'microsoft_entra', 'EXAMPLE-external-secret-reference-B', 'v1')
on conflict do nothing;

-- ── C0: the table is a deny-all Tier-2 store — NOT-NULL reference columns, RLS enabled, ZERO policies ──────────────────
do $$ begin
  assert (select is_nullable from information_schema.columns where table_name='connector_credential_references' and column_name='credential_secret_ref') = 'NO', 'C0 credential_secret_ref is NOT NULL';
  assert (select is_nullable from information_schema.columns where table_name='connector_credential_references' and column_name='credential_version') = 'NO', 'C0 credential_version is NOT NULL';
  assert (select relrowsecurity from pg_class where oid='public.connector_credential_references'::regclass), 'C0 reference table has RLS enabled';
  assert (select count(*) from pg_policies where schemaname='public' and tablename='connector_credential_references') = 0, 'C0 reference table has ZERO policies (default deny-all)';
end $$;

-- ── C1: connector_runner resolves the OWNED reference via the tenant-bound JOIN; BYPASSRLS control; missing ref fails closed ──
do $$
declare n_owned int; n_bypass int; n_cross int; n_noref int;
begin
  set local role connector_runner;
  select count(*) into n_owned from public.connector_credential_references r
    join public.connectors c on c.id=r.connector_id and c.tenant_id=r.tenant_id and c.provider=r.provider
    where r.tenant_id='a2000000-0000-4000-8000-000000000001' and r.connector_id='a3000000-0000-4000-8000-000000000001' and r.provider='microsoft_entra' and c.status='active';
  -- BYPASSRLS control: WITHOUT a tenant bind the runner CAN see tenant B's reference row (so RLS is NOT the boundary) ...
  select count(*) into n_bypass from public.connector_credential_references where connector_id='b3000000-0000-4000-8000-000000000001';
  -- ... but the runner's tenant-bound WHERE excludes B's connector under tenant A.
  select count(*) into n_cross from public.connector_credential_references r
    join public.connectors c on c.id=r.connector_id and c.tenant_id=r.tenant_id and c.provider=r.provider
    where r.tenant_id='a2000000-0000-4000-8000-000000000001' and r.connector_id='b3000000-0000-4000-8000-000000000001' and r.provider='microsoft_entra' and c.status='active';
  -- a connector with NO reference row -> 0 (fail closed).
  select count(*) into n_noref from public.connector_credential_references r
    join public.connectors c on c.id=r.connector_id and c.tenant_id=r.tenant_id and c.provider=r.provider
    where r.tenant_id='a2000000-0000-4000-8000-000000000001' and r.connector_id='a3000000-0000-4000-8000-000000000002' and r.provider='microsoft_entra' and c.status='active';
  reset role;
  assert n_owned = 1,  'C1 connector_runner resolves the owned reference via the tenant-bound JOIN';
  assert n_bypass = 1, 'C1 connector_runner is BYPASSRLS (sees B''s reference unscoped) — the tenant-bound WHERE, not RLS, is the boundary';
  assert n_cross = 0,  'C1 the tenant-bound WHERE returns NOTHING for another tenant''s connector (no cross-tenant leak)';
  assert n_noref = 0,  'C1 a connector with no reference row fails closed (not resolvable)';
end $$;

-- ── C2: connector_runner grant is NARROW — column SELECT on the reference cols + connectors identity/status, NO write ──
do $$ begin
  assert     has_column_privilege('connector_runner','public.connector_credential_references','credential_secret_ref','SELECT'), 'C2 runner column SELECT on credential_secret_ref';
  assert     has_column_privilege('connector_runner','public.connector_credential_references','credential_version','SELECT'),    'C2 runner column SELECT on credential_version';
  assert not has_table_privilege('connector_runner','public.connector_credential_references','SELECT'), 'C2 runner holds NO table-level SELECT (column-scoped only)';
  assert not has_table_privilege('connector_runner','public.connector_credential_references','INSERT'), 'C2 runner must NOT INSERT the reference (cannot provision/substitute)';
  assert not has_table_privilege('connector_runner','public.connector_credential_references','UPDATE'), 'C2 runner must NOT UPDATE the reference';
  assert not has_table_privilege('connector_runner','public.connector_credential_references','DELETE'), 'C2 runner must NOT DELETE the reference';
  -- connectors: identity + status only (for the eligibility JOIN); NO write; still zero TABLE-level (column-scoped)
  assert     has_column_privilege('connector_runner','public.connectors','status','SELECT'),   'C2 runner column SELECT on connectors.status (for the JOIN)';
  assert not has_table_privilege('connector_runner','public.connectors','INSERT'), 'C2 runner must NOT INSERT connectors';
  assert not has_table_privilege('connector_runner','public.connectors','UPDATE'), 'C2 runner must NOT UPDATE connectors';
  assert not has_table_privilege('connector_runner','public.connectors','DELETE'), 'C2 runner must NOT DELETE connectors';
end $$;

-- ── C3: REQUEST-PATH is fully denied — authenticated + anon can neither READ nor WRITE the reference (deny-all) ────────
do $$ begin
  assert not has_table_privilege('authenticated','public.connector_credential_references','SELECT'),                       'C3 authenticated holds NO SELECT on the reference table';
  assert not has_column_privilege('authenticated','public.connector_credential_references','credential_secret_ref','SELECT'), 'C3 authenticated CANNOT read credential_secret_ref';
  assert not has_column_privilege('authenticated','public.connector_credential_references','credential_version','SELECT'),    'C3 authenticated CANNOT read credential_version';
  assert not has_table_privilege('anon','public.connector_credential_references','SELECT'),                                 'C3 anon holds NO SELECT on the reference table';
  assert (select coalesce(array_agg(distinct privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='connector_credential_references') = array[]::text[], 'C3 authenticated holds EXACTLY ZERO privileges on the reference table';
end $$;
set role authenticated;
do $$ declare ok_read boolean := false; ok_write boolean := false; begin
  begin perform 1 from public.connector_credential_references; ok_read := false; exception when insufficient_privilege then ok_read := true; end;
  begin insert into public.connector_credential_references (tenant_id, connector_id, provider, credential_secret_ref, credential_version)
        values ('a2000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000001','microsoft_entra','EXAMPLE-substituted','v1'); ok_write := false;
  exception when insufficient_privilege then ok_write := true; end;
  assert ok_read,  'C3 authenticated must NOT read the credential reference table (deny-all)';
  assert ok_write, 'C3 authenticated must NOT insert/substitute a credential reference';
end $$;
reset role;
set role anon;
do $$ declare ok boolean := false; begin
  begin perform 1 from public.connector_credential_references; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'C3 anon must NOT read the credential reference table';
end $$;
reset role;

-- ── C4: bounded, non-empty (the length CHECKs) ────────────────────────────────────────────────────────────────────────
do $$ declare ok_empty boolean := false; ok_long boolean := false; begin
  begin update public.connector_credential_references set credential_version=''             where connector_id='a3000000-0000-4000-8000-000000000001'; exception when check_violation then ok_empty := true; end;
  begin update public.connector_credential_references set credential_secret_ref=repeat('x',513) where connector_id='a3000000-0000-4000-8000-000000000001'; exception when check_violation then ok_long := true; end;
  assert ok_empty, 'C4 empty credential_version violates the length CHECK';
  assert ok_long,  'C4 an over-length (513) credential_secret_ref violates the length CHECK';
end $$;

-- ── C5: connectors is UNCHANGED (reverted) — NO credential columns; authenticated SELECT posture identical; no backfill ─
do $$ begin
  assert (select count(*) from information_schema.columns where table_name='connectors' and column_name in ('credential_secret_ref','credential_version')) = 0, 'C5 connectors has NO credential columns (reference lives in the dedicated table)';
  assert (select coalesce(array_agg(distinct privilege_type::text order by privilege_type::text), array[]::text[]) from information_schema.role_table_grants
          where grantee='authenticated' and table_schema='public' and table_name='connectors') = array['SELECT'], 'C5 authenticated STILL holds EXACTLY [SELECT] on connectors (unchanged)';
  insert into public.connectors (id, tenant_id, provider, status) values ('a3000000-0000-4000-8000-0000000000ff','a2000000-0000-4000-8000-000000000001','slack','pending');
  assert (select count(*) from public.connector_credential_references where connector_id='a3000000-0000-4000-8000-0000000000ff') = 0, 'C5 a new connector has NO fabricated reference (fail closed by default; no backfill)';
end $$;

-- clean up (tenant cascade removes connectors, which cascade-removes reference rows).
reset role;
delete from public.tenants where id in ('a2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002');
