-- 0090_application_match_candidate_contract.sql
--
-- Phase 18C0 — the ONE bounded read the deterministic matcher will need, and nothing that uses it.
--
-- ══ 1. WHY NO NEW METHOD LITERAL ════════════════════════════════════════════════════════════════════════════════════════════════
-- An earlier draft of this migration added a sixth `application_matches.method` value and re-created 0088's propose command to
-- admit it. Both are removed: the existing vocabulary already says the true thing, so a new literal would be a schema change with
-- no semantic gain.
--
-- 0075 defines `method` as "HOW the match was decided" — PROVENANCE, never proof the pair is correct — and `confidence` as what
-- lets a reviewer weigh the assertion. 0088 then defines `vendor_catalog` as "an existing canonical catalog mapping". The evidence
-- 18C will walk is exactly that: a confirmed `provider_app_id` alias resolves to a canonical `app_product`, and the tenant's
-- operational instances of that product become candidates. The provenance IS the catalog mapping.
--
-- `exact_external_id` stays inappropriate for the same reason it always was: the identifier proves the PRODUCT, and an `apps`
-- row's own identifier is never compared, so claiming an exact identifier match against that app would be false. `vendor_catalog`
-- claims neither instance identity nor acceptance nor confidence, which is precisely the shape of what the matcher will know.
--
-- Phase 18C will therefore propose with `method = 'vendor_catalog'`. Confidence stays planner logic and is never written here.
-- 0075 and 0088 are untouched.
--
-- ══ 2. WHY THE READ MUST BE A DEFINER FUNCTION ══════════════════════════════════════════════════════════════════════════════════
-- `directory_applications` is deny-all (0057: RLS on, no policy) and 0061 deliberately withholds `external_id` from every
-- product read. So product code cannot perform `directory_application → alias` at all: the join key is unreachable. This
-- function reads the identifier INSIDE the database, uses it to join, and NEVER returns it — the same discipline 0087
-- established for declaration. No SELECT policy is added, no table grant, and no other RPC gains the identifier.
--
-- ══ 3. PARENT-FIRST PAGING, WHICH IS THE LOAD-BEARING PART ══════════════════════════════════════════════════════════════════════
-- One directory application expands into 0, 1 or N candidate rows. A LIMIT applied to the EXPLODED join would split a
-- many-instance group across a page boundary, and a matcher that saw half a group would propose half the candidates and
-- call the run complete — silently deciding an ambiguity by truncation.
--
-- So the bound is on PARENTS: a page of eligible directory applications is chosen first, ordered by immutable `id`, and
-- only then is every selected parent expanded to its COMPLETE candidate set. The row count is therefore unbounded by
-- design; the parent count is not. A group can never be split.
--
-- The cursor is the last PARENT id, which the caller can read directly off the last row because the output is ordered by
-- it and the LEFT JOIN guarantees every selected parent appears at least once — including zero-instance parents, which is
-- what stops a page made entirely of them from stalling the walk.
--
-- WHAT THE CURSOR TRAVERSES, precisely: RESOLVED directory applications only. The confirmed-alias join lives inside the
-- parent CTE, so an application with no settled canonical product is never a parent and never appears — a page simply
-- skips over any run of unresolved ids, however long, and lands on the next resolved one. This feed therefore answers
-- "which applications have candidates", NOT "which applications exist".
--
-- 18C MUST NOT INFER THE COMPLEMENT FROM THIS FEED'S SILENCE. The authorized complete census is
-- `product_list_directory_applications` (0061, redefined 0073), whose eligibility is IDENTICAL when called with
-- p_include_stale := false — same owner/admin gate, same superseded/disconnected exclusion, same sync_status = 'current',
-- same ascending `id` cursor. Walking both and taking the difference is what distinguishes PRODUCT UNRESOLVED (in the
-- census, absent here) from RESOLVED WITH ZERO INSTANCES (present here with a NULL app_id). Absence from this feed alone
-- means only "no candidates", and a caller that reads it as "no such application" has invented a fact.
--
-- ══ WHAT THIS MIGRATION DOES NOT DO ═════════════════════════════════════════════════════════════════════════════════════════════
-- No matcher, no planner, no proposal loop, no matcher-state orchestration, no Rule 5 change, no scheduler, no UI, no
-- provider code, no background principal, no `service_role`, no `connector_runner` authority, no new table, no RLS policy,
-- no table grant, and NO change to the method domain or to 0088's governed writer. Every historical migration —
-- 0075/0085/0087/0088/0089 — is untouched. This migration creates exactly one function. Staging only; applied to no hosted
-- database.

begin;

-- ══ 2. THE BOUNDED CANDIDATE READ ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Returns FACTS ONLY: which directory application resolved to which product, and which operational instances belong to
-- that product. No ranking, no selection, no confidence — those are the caller's, under the contract in docs/79.
--
-- The column list is the whole disclosure surface and is deliberately three ids: no external_id, no alias_value, no label,
-- name, vendor, provider or any other payload. Their absence is what makes it impossible for a later reader to key on one
-- by accident.
--
-- ELIGIBILITY mirrors 0087's declaration rule, because the same question is being asked of the same row: only a `current`
-- directory application with a non-blank identifier may establish identity, and a superseded or disconnected connector's
-- rows are excluded exactly as every 0061/0073 directory read excludes them. A directory application with no CONFIRMED
-- alias yields NO rows at all — `pending`, `rejected` and the undefined `auto` are not settled judgements (0087/18A1), and
-- a `name` alias is never deterministic, so none of them can bridge.
create or replace function public.product_application_match_candidates(
  p_tenant_id uuid,
  p_after_directory_application_id uuid default null,
  p_limit integer default 200
) returns table (
  directory_application_id uuid,
  app_product_id uuid,
  app_id uuid
) language sql security definer set search_path = public stable as $$
  with parents as (
    -- THE PAGE IS PARENTS. The limit lives here and nowhere else.
    select da.id as directory_application_id, al.app_product_id
      from public.directory_applications da
      join public.app_aliases al
        on al.tenant_id = da.tenant_id
       and al.alias_type = 'provider_app_id'
       and al.review_status = 'confirmed'
       and al.alias_value = btrim(da.external_id)
     where public.has_tenant_role(p_tenant_id, array['owner', 'admin'])
       and da.tenant_id = p_tenant_id
       and da.sync_status = 'current'
       and btrim(coalesce(da.external_id, '')) <> ''
       and not exists (
             select 1 from public.connectors sc
              where sc.id = da.connection_id
                and (sc.superseded_by is not null or sc.disconnected_at is not null))
       and (p_after_directory_application_id is null or da.id > p_after_directory_application_id)
     order by da.id
     limit greatest(1, least(coalesce(p_limit, 200), 200))
  )
  -- LEFT JOIN, and that is the zero-instance contract: a resolved product with no operational instance still returns its
  -- parent, with app_id NULL. That row means PRODUCT RESOLVED, ZERO INSTANCES — never "product unresolved", which is the
  -- absence of a row entirely. It is also what lets a page of only zero-instance parents advance the cursor.
  select p.directory_application_id, p.app_product_id, ap.id as app_id
    from parents p
    left join public.apps ap
      -- `ap.tenant_id = p_tenant_id` is DEFENCE IN DEPTH, not the guarantee. 0024's composite FK
      -- apps_canonical_app_same_tenant (canonical_app_id, tenant_id) -> app_products (id, tenant_id) already makes it
      -- impossible for an app to be grouped under another tenant's product, so removing this predicate cannot change a
      -- single row and no test can catch its removal. It stays because it makes the scope explicit at the join, but it
      -- must not be mistaken for the thing doing the work.
      on ap.tenant_id = p_tenant_id
     and ap.canonical_app_id = p.app_product_id
   order by p.directory_application_id, ap.id nulls first;
$$;

comment on function public.product_application_match_candidates(uuid, uuid, integer) is
  'Deterministic application-match candidates: directory application -> confirmed canonical product -> that product operational instances. Reads directory_applications.external_id INTERNALLY and never returns it. Pages by PARENT directory application so a many-instance candidate group is never split. A zero-instance product returns one row with app_id NULL.';

-- ══ LEAST PRIVILEGE ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Hosted Supabase's ALTER DEFAULT PRIVILEGES (0045) grants EXECUTE on new public functions straight to anon/authenticated
-- and `revoke from public` alone does not remove it, so every role is named. `connector_runner` is revoked: it produces
-- provider evidence and has no business reading canonical judgements. `service_role` is deliberately not named, matching
-- the 0061/0073/0078/0082/0083/0085/0087/0089 product-RPC precedent.
do $$
declare f text := 'public.product_application_match_candidates(uuid, uuid, integer)';
begin
  execute format('revoke execute on function %s from public, anon, authenticated, connector_runner', f);
  execute format('grant execute on function %s to authenticated', f);
end $$;

commit;
