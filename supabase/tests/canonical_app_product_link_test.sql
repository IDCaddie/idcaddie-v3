-- canonical_app_product_link_test.sql — the authority and integrity model Phase 18B0 RELIES ON.
--
-- Phase 18B0 adds NO migration: it is the first writer for a canonical layer whose schema has existed since 0024. That makes
-- these guarantees load-bearing and, until now, unpinned — the feature is only correct because `apps.canonical_app_id` is
-- editor-writable, member-readable, structurally same-tenant, and closed to the connector runner. If any of that drifts, the
-- resolver silently becomes either unusable or unsafe, so it is asserted here against a real database rather than assumed.
--
-- Seeds its own cn……… id space and truncates nothing.

\set ON_ERROR_STOP on
reset role;

insert into auth.users (id, email) values
  ('cabb0000-0000-4000-8000-00000000e001','cn_editor@t1.test'),
  ('cabb0000-0000-4000-8000-00000000e002','cn_viewer@t1.test'),
  ('cabb0000-0000-4000-8000-00000000e003','cn_owner@t2.test');
insert into public.profiles (id, email) values
  ('cabb0000-0000-4000-8000-00000000e001','cn_editor@t1.test'),
  ('cabb0000-0000-4000-8000-00000000e002','cn_viewer@t1.test'),
  ('cabb0000-0000-4000-8000-00000000e003','cn_owner@t2.test');
insert into public.tenants (id, name, slug) values
  ('cabb0000-0000-4000-8000-000000000011','CN T1','cn-t1'),
  ('cabb0000-0000-4000-8000-000000000012','CN T2','cn-t2');
insert into public.tenant_memberships (tenant_id, user_id, role, status) values
  ('cabb0000-0000-4000-8000-000000000011','cabb0000-0000-4000-8000-00000000e001','editor','active'),
  ('cabb0000-0000-4000-8000-000000000011','cabb0000-0000-4000-8000-00000000e002','viewer','active'),
  ('cabb0000-0000-4000-8000-000000000012','cabb0000-0000-4000-8000-00000000e003','owner','active');

-- Two apps in T1 sharing nothing but a tenant, plus one product in each tenant.
insert into public.apps (id, tenant_id, name, external_instance_id) values
  ('cabb0000-0000-4000-8000-0000000000a1','cabb0000-0000-4000-8000-000000000011','Slack (corp)','T111'),
  ('cabb0000-0000-4000-8000-0000000000a2','cabb0000-0000-4000-8000-000000000011','Slack (subsidiary)','T222');
insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('cabb0000-0000-4000-8000-0000000000b1','cabb0000-0000-4000-8000-000000000011','Slack','slack'),
  ('cabb0000-0000-4000-8000-0000000000b9','cabb0000-0000-4000-8000-000000000012','Slack','slack');

-- ── C1 — an EDITOR may set canonical_app_id; this is the authority the resolver depends on ──────────────────────────────────
select set_config('request.jwt.claims','{"sub":"cabb0000-0000-4000-8000-00000000e001"}',false);
set role authenticated;
do $$
declare v integer;
begin
  update public.apps set canonical_app_id = 'cabb0000-0000-4000-8000-0000000000b1'
   where id = 'cabb0000-0000-4000-8000-0000000000a1';
  get diagnostics v = row_count;
  assert v = 1, format('C1 an editor must be able to canonicalize an app (%s rows)', v);

  -- ONE PRODUCT, MANY APPS: the multi-instance case 0024 exists for. Two workspaces, one canonical product.
  update public.apps set canonical_app_id = 'cabb0000-0000-4000-8000-0000000000b1'
   where id = 'cabb0000-0000-4000-8000-0000000000a2';
  get diagnostics v = row_count;
  assert v = 1, format('C1 one product must be able to own many apps (%s rows)', v);
end $$;
reset role;

-- ── C2 — a VIEWER may read the link but never write it ──────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"cabb0000-0000-4000-8000-00000000e002"}',false);
set role authenticated;
do $$
declare v integer; denied boolean := false;
begin
  select count(*) into v from public.apps where canonical_app_id = 'cabb0000-0000-4000-8000-0000000000b1';
  assert v = 2, format('C2 a member must READ the canonical link, saw %s', v);

  update public.apps set canonical_app_id = null where id = 'cabb0000-0000-4000-8000-0000000000a1';
  get diagnostics v = row_count;
  assert v = 0, format('C2 ESCALATION: a viewer un-canonicalized an app (%s rows)', v);

  begin
    insert into public.app_products (tenant_id, name, normalized_name)
    values ('cabb0000-0000-4000-8000-000000000011','Invented','invented');
  exception when others then denied := true; end;
  assert denied, 'C2 ESCALATION: a viewer created a canonical product';
end $$;
reset role;

-- ── C3 — cross-tenant canonical identity is STRUCTURALLY impossible, not merely unused ──────────────────────────────────────
-- apps_canonical_app_same_tenant (0024) is a composite FK on (canonical_app_id, tenant_id). Asserted privileged, because a
-- constraint that only holds while RLS agrees is not a constraint.
do $$
declare ok boolean := false;
begin
  begin
    update public.apps set canonical_app_id = 'cabb0000-0000-4000-8000-0000000000b9'   -- tenant 2's product
     where id = 'cabb0000-0000-4000-8000-0000000000a1';
  exception when foreign_key_violation then ok := true; end;
  assert ok, 'C3 CROSS-TENANT: an app was grouped under another tenant''s canonical product';
end $$;

-- ── C4 — a foreign tenant sees none of it ───────────────────────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims','{"sub":"cabb0000-0000-4000-8000-00000000e003"}',false);
set role authenticated;
do $$
declare v integer;
begin
  select count(*) into v from public.apps where tenant_id = 'cabb0000-0000-4000-8000-000000000011';
  assert v = 0, format('C4 CROSS-TENANT: tenant 2 read %s of tenant 1''s apps', v);
  select count(*) into v from public.app_aliases where tenant_id = 'cabb0000-0000-4000-8000-000000000011';
  assert v = 0, format('C4 CROSS-TENANT: tenant 2 read %s of tenant 1''s aliases', v);
end $$;
reset role;

-- ── C5 — the connector runner gets NO canonical decision authority ──────────────────────────────────────────────────────────
-- Discovery observes instances; it may never assert which canonical product one IS. Phase 18B0 adds no grant, and this pins it.
do $$
declare v boolean;
begin
  select has_table_privilege('connector_runner','public.app_products','insert') into v;
  assert not v, 'C5 the connector runner must not create canonical products';
  select has_table_privilege('connector_runner','public.app_aliases','insert') into v;
  assert not v, 'C5 the connector runner must not declare canonical aliases';
  select has_table_privilege('connector_runner','public.apps','update') into v;
  assert not v, 'C5 the connector runner must not set canonical_app_id';
end $$;

-- ── C6 — the alias natural key admits exactly one judgement per identifier ──────────────────────────────────────────────────
-- The resolver reads at most one alias row and treats absence as unresolved; that is only sound because the 0026 key makes
-- competing judgements impossible. Ambiguity is the ABSENCE of a row, never several.
insert into public.app_aliases
  (tenant_id, app_product_id, app_id, alias_type, alias_value, source, confidence, review_status, reviewed_at)
values
  ('cabb0000-0000-4000-8000-000000000011','cabb0000-0000-4000-8000-0000000000b1','cabb0000-0000-4000-8000-0000000000a1',
   'external_instance_id','T111','product_declaration',100,'confirmed', now());
do $$
declare ok boolean := false;
begin
  begin
    insert into public.app_aliases
      (tenant_id, app_product_id, alias_type, alias_value, source, confidence, review_status)
    values
      ('cabb0000-0000-4000-8000-000000000011','cabb0000-0000-4000-8000-0000000000b9',
       'external_instance_id','T111','product_declaration',100,'confirmed');
    exception when others then ok := true;
  end;
  assert ok, 'C6 a second competing judgement for one identifier must be impossible';
end $$;

reset role;
