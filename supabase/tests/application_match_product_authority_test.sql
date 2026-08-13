-- 0088 — application_matches is PRODUCT-AUTHORITATIVE.
--
-- Two properties this suite exists to protect:
--   (1) the canonical relationship is the PRODUCT and is required, while the operational INSTANCE is an optional refinement that
--       can never contradict it — enforced structurally, so a buggy definer function cannot write a contradiction;
--   (2) candidate identity is keyed on the product, because keying it on a NULLABLE instance would let one product-level
--       proposal duplicate without limit under ordinary Postgres NULL-uniqueness semantics.

reset role;

insert into public.tenants (id, name, slug) values
  ('91000000-0000-4000-8000-00000000000a', 'Product Authority A', 'prod-authority-a'),
  ('91000000-0000-4000-8000-00000000000b', 'Product Authority B', 'prod-authority-b');

insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('91000000-0000-4000-8000-0000000000c1', '91000000-0000-4000-8000-00000000000a', 'okta', 'Dir A', 'pending', 'discovered'),
  ('91000000-0000-4000-8000-0000000000c2', '91000000-0000-4000-8000-00000000000b', 'okta', 'Dir B', 'pending', 'discovered');

-- Two directory applications in tenant A (both may legitimately point at ONE product), one in tenant B.
insert into public.directory_applications (id, tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('91000000-0000-4000-8000-0000000000d1', '91000000-0000-4000-8000-00000000000a', '91000000-0000-4000-8000-0000000000c1', 'okta', '0oaSFDC00001', 'Salesforce',     'current'),
  ('91000000-0000-4000-8000-0000000000d2', '91000000-0000-4000-8000-00000000000a', '91000000-0000-4000-8000-0000000000c1', 'okta', '0oaSFDC00002', 'Salesforce EU',  'current'),
  ('91000000-0000-4000-8000-0000000000e1', '91000000-0000-4000-8000-00000000000b', '91000000-0000-4000-8000-0000000000c2', 'okta', '0oaFOREIGN01', 'Foreign app',    'current');

insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('91000000-0000-4000-8000-0000000000f1', '91000000-0000-4000-8000-00000000000a', 'Salesforce', 'salesforce'),
  ('91000000-0000-4000-8000-0000000000f2', '91000000-0000-4000-8000-00000000000a', 'Jira',       'jira'),
  ('91000000-0000-4000-8000-0000000000fb', '91000000-0000-4000-8000-00000000000b', 'Foreign',    'foreign');

-- Operational instances. a1 is canonicalized to Salesforce; a2 to Jira; a3 has NO canonical product at all.
insert into public.apps (id, tenant_id, name, canonical_app_id) values
  ('91000000-0000-4000-8000-0000000000a1', '91000000-0000-4000-8000-00000000000a', 'Salesforce Production', '91000000-0000-4000-8000-0000000000f1'),
  ('91000000-0000-4000-8000-0000000000a2', '91000000-0000-4000-8000-00000000000a', 'Jira Production',       '91000000-0000-4000-8000-0000000000f2'),
  ('91000000-0000-4000-8000-0000000000a3', '91000000-0000-4000-8000-00000000000a', 'Uncanonicalized app',   null),
  ('91000000-0000-4000-8000-0000000000ab', '91000000-0000-4000-8000-00000000000b', 'Foreign instance',      '91000000-0000-4000-8000-0000000000fb');

-- helper: attempt an insert and report the outcome as a bounded label rather than an exception.
create or replace function pg_temp.try_match(
  p_tenant uuid, p_dir uuid, p_product uuid, p_app uuid, p_status text default 'proposed'
) returns text language plpgsql as $$
begin
  insert into public.application_matches
    (tenant_id, directory_application_id, app_product_id, app_id, method, confidence, status, decided_at)
  values
    (p_tenant, p_dir, p_product, p_app, 'manual', 'high', p_status,
     case when p_status = 'proposed' then null else now() end);
  return 'ok';
exception
  when foreign_key_violation then return 'fk_violation';
  when unique_violation      then return 'unique_violation';
  when not_null_violation    then return 'not_null_violation';
  when check_violation       then return 'check_violation';
end $$;

-- ════ P1: the canonical endpoint is REQUIRED, the refinement is OPTIONAL ═════════════════════════════════════════════════════
do $$ begin
  assert (select is_nullable from information_schema.columns
           where table_name = 'application_matches' and column_name = 'app_product_id') = 'NO',
    'P1 app_product_id must be NOT NULL — it is the relationship';
  assert (select is_nullable from information_schema.columns
           where table_name = 'application_matches' and column_name = 'app_id') = 'YES',
    'P1 app_id must be NULLABLE — it is an optional refinement';

  -- and the requirement is real, not just declared
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d1', null, null) = 'not_null_violation',
    'P1 a match without a product must be refused';
end $$;

-- ════ P2: PRODUCT-ONLY match — the case Phase 18A can actually reach today ═══════════════════════════════════════════════════
do $$ begin
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d1','91000000-0000-4000-8000-0000000000f1', null) = 'ok',
    'P2 app_id NULL is a valid product-level match';
  assert (select app_id from public.application_matches
           where directory_application_id = '91000000-0000-4000-8000-0000000000d1') is null,
    'P2 and it really stored NULL rather than defaulting an instance';
end $$;

-- ════ P3: TENANT INTEGRITY — both endpoints, structurally ═══════════════════════════════════════════════════════════════════
do $$ begin
  -- foreign PRODUCT
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d2','91000000-0000-4000-8000-0000000000fb', null) = 'fk_violation',
    'P3 a product from another tenant must be structurally impossible';
  -- foreign DIRECTORY APPLICATION
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000e1','91000000-0000-4000-8000-0000000000f1', null) = 'fk_violation',
    'P3 a directory application from another tenant must be structurally impossible';
  -- foreign INSTANCE (refinement side)
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d2','91000000-0000-4000-8000-0000000000f1','91000000-0000-4000-8000-0000000000ab') = 'fk_violation',
    'P3 an instance from another tenant must be structurally impossible';
end $$;

-- ════ P4: THE REFINEMENT INVARIANT — an instance may only refine ITS OWN product ═════════════════════════════════════════════
do $$ begin
  -- matching: Salesforce Production refines Salesforce
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d2','91000000-0000-4000-8000-0000000000f1','91000000-0000-4000-8000-0000000000a1') = 'ok',
    'P4 an instance whose canonical product IS the claimed product is a valid refinement';

  -- MISMATCH: product says Salesforce, instance is Jira Production. This is the contradiction the FK exists to make impossible.
  delete from public.application_matches where directory_application_id = '91000000-0000-4000-8000-0000000000d2';
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d2','91000000-0000-4000-8000-0000000000f1','91000000-0000-4000-8000-0000000000a2') = 'fk_violation',
    'P4 product=Salesforce with instance=Jira Production must be REFUSED';

  -- canonical_app_id IS NULL: an instance whose own product is unknown cannot refine a product claim (approved Decision B).
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d2','91000000-0000-4000-8000-0000000000f1','91000000-0000-4000-8000-0000000000a3') = 'fk_violation',
    'P4 an instance with canonical_app_id NULL must be REFUSED as a refinement';
end $$;

-- ════ P5: CANDIDATE IDENTITY is the PRODUCT, and NULL instances cannot spam ══════════════════════════════════════════════════
do $$ begin
  delete from public.application_matches;
  -- first product-level proposal
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d1','91000000-0000-4000-8000-0000000000f1', null) = 'ok',
    'P5 the first candidate is accepted';

  -- THE SPAM CASE. Under a candidate key that included the nullable app_id, Postgres would treat these NULLs as distinct and this
  -- second identical proposal would insert a duplicate — once per matcher run, forever.
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d1','91000000-0000-4000-8000-0000000000f1', null) = 'unique_violation',
    'P5 re-proposing the SAME product with NULL instance must NOT duplicate';

  -- the same candidate refined with an instance is still the SAME candidate
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d1','91000000-0000-4000-8000-0000000000f1','91000000-0000-4000-8000-0000000000a1') = 'unique_violation',
    'P5 an instance refinement does not create a SECOND canonical candidate';

  -- AMBIGUITY IS PRESERVED: a different product for the same directory application is a different candidate.
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d1','91000000-0000-4000-8000-0000000000f2', null) = 'ok',
    'P5 a competing PRODUCT candidate must remain representable for human review';
  assert (select count(*) from public.application_matches
           where directory_application_id = '91000000-0000-4000-8000-0000000000d1' and status = 'proposed') = 2,
    'P5 two competing proposals coexist';
end $$;

-- ════ P6: CARDINALITY — one accepted per directory app; many directory apps per product ══════════════════════════════════════
do $$ begin
  delete from public.application_matches;
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d1','91000000-0000-4000-8000-0000000000f1', null, 'accepted') = 'ok',
    'P6 an accepted match is allowed';
  -- a SECOND accepted product for the SAME directory application must be refused (0075's partial unique index, endpoint-independent)
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d1','91000000-0000-4000-8000-0000000000f2', null, 'accepted') = 'unique_violation',
    'P6 a directory application may accept at most ONE product';

  -- but MANY directory applications may accept the SAME product — one product integrated twice is normal, not a conflict.
  assert pg_temp.try_match('91000000-0000-4000-8000-00000000000a','91000000-0000-4000-8000-0000000000d2','91000000-0000-4000-8000-0000000000f1', null, 'accepted') = 'ok',
    'P6 many directory applications may accept ONE product';
  assert (select count(*) from public.application_matches
           where app_product_id = '91000000-0000-4000-8000-0000000000f1' and status = 'accepted') = 2,
    'P6 the product is deliberately NOT unique across directory applications';
end $$;

-- ════ P7: the governed read returns the AUTHORITY, not the refinement ═══════════════════════════════════════════════════════
do $$
declare sig text;
begin
  select pg_get_function_result(p.oid) into sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'product_application_matches';
  assert sig like '%app_product_id%', format('P7 the read must expose app_product_id, got: %s', sig);
  -- `app_id` must not appear as its own column. Matching on the delimiter avoids a false hit inside `app_product_id`.
  assert sig not like '%(app_id %' and sig not like '%, app_id %',
    format('P7 the read must NOT expose app_id — it is the subordinate refinement. got: %s', sig);
  -- and the surface stays four columns wide
  assert (length(sig) - length(replace(sig, ',', ''))) = 3, format('P7 the read must stay 4 columns, got: %s', sig);
end $$;

-- ════ P8: PRIVILEGE POSTURE is unchanged — the table stays unreachable ══════════════════════════════════════════════════════
do $$ begin
  assert (select relrowsecurity from pg_class where oid = 'public.application_matches'::regclass),
    'P8 RLS stays enabled on application_matches';
  assert not exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
                      where c.relname = 'application_matches'),
    'P8 application_matches stays deny-all — no policy may be added';

  assert not has_table_privilege('anon', 'public.application_matches', 'SELECT'), 'P8 anon no direct SELECT';
  assert not has_table_privilege('authenticated', 'public.application_matches', 'SELECT'), 'P8 authenticated no direct SELECT';
  assert not has_table_privilege('authenticated', 'public.application_matches', 'INSERT'), 'P8 authenticated no direct INSERT';
  assert not has_table_privilege('connector_runner', 'public.application_matches', 'SELECT'), 'P8 connector_runner no direct SELECT';
  assert not has_table_privilege('connector_runner', 'public.application_matches', 'INSERT'), 'P8 connector_runner no direct INSERT';

  -- the read RPC keeps its exact grant shape
  assert     has_function_privilege('authenticated', 'public.product_application_matches(uuid,uuid,integer)', 'EXECUTE'),
    'P8 authenticated keeps EXECUTE on the read';
  assert not has_function_privilege('anon', 'public.product_application_matches(uuid,uuid,integer)', 'EXECUTE'),
    'P8 anon denied';
  assert not has_function_privilege('connector_runner', 'public.product_application_matches(uuid,uuid,integer)', 'EXECUTE'),
    'P8 connector_runner gains NO authority over canonical relationships';
  assert not has_function_privilege('public', 'public.product_application_matches(uuid,uuid,integer)', 'EXECUTE'),
    'P8 PUBLIC denied';
  assert (select array_to_string(proconfig, ',') from pg_proc where proname = 'product_application_matches') like 'search_path=%',
    'P8 search_path stays pinned';
end $$;

reset role;
do $$ begin raise notice 'ALL APPLICATION MATCH PRODUCT AUTHORITY ASSERTIONS PASSED'; end $$;
