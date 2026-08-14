-- 0090_application_match_candidate_contract.sql
--
-- Phase 18C0 — the truthful contract the deterministic matcher will need, and NOTHING that uses it.
--
-- Two additions, both prerequisites of the same future matcher and therefore one migration: a method literal that can
-- describe what the matcher will actually know, and the bounded read that can hand it candidates without widening the
-- disclosure boundary. Shipping them apart would leave an interval in which the read exists but nothing may truthfully
-- label its output.
--
-- ══ 1. WHY A NEW METHOD, AND WHY NONE OF THE FIVE WOULD DO ══════════════════════════════════════════════════════════════════════
-- The evidence chain 18C will walk is:
--
--     directory_applications.external_id  →  CONFIRMED provider_app_id alias (0087)  →  app_product
--                                         →  apps WHERE canonical_app_id = app_product   →  0 / 1 / N instances
--
-- The identifier proves the PRODUCT. It never touches the `apps` row, so it does not prove the INSTANCE — and that stays
-- true when exactly one instance exists. A candidate set of size one is exhaustive by CARDINALITY, not by evidence; the
-- zero case is the proof, since a recognised product may legitimately own no operational instance at all.
--
-- Against that, every existing value is false:
--   manual             an operator's judgement — the matcher is not an operator
--   exact_domain       nothing in this chain is a domain, and 0088 already refuses it
--   exact_external_id  claims the external identifier matched THIS instance. It matched the product. False at N=1 too
--   vendor_catalog     0075 never defined it; its only description is 0088's "an existing canonical catalog mapping",
--                      nothing writes it, no test pins it, and `vendors` is a modelled noun (Atlassian) distinct from
--                      `app_products` (Jira) — so it reads as an EXTERNAL vendor catalogue. Retrofitting a convenient
--                      meaning onto an old enum value is how a vocabulary stops meaning anything
--   suggested          the weak-evidence bucket 0088 refuses precisely to keep name-similarity out; and this derivation
--                      is deterministic, so the label would understate as badly as exact_external_id overstates
--
-- METHOD IS PROVENANCE, NOT PROOF. 0075 says so in its own words — "HOW the match was decided … the automated methods are
-- recorded distinctly so a low-quality heuristic can be found and revisited later". Nothing reads it: the 0085 read
-- returns (id, directory_application_id, app_id, status), no engine branches on it, no UI renders it. So the honest fix is
-- a provenance literal that names where the candidate came from, and leaves how much to believe it to `confidence`.
--
--     canonical_product   Candidate derived deterministically from a confirmed canonical-product mapping and the tenant's
--                         operational instances belonging to that product; the evidence does not itself identify this
--                         instance as the correct one.
--
-- Existing values are untouched, and widening a CHECK invalidates no existing row.
--
-- THE CONFIDENCE CONTRACT IS DOCUMENTED, NOT ENCODED. `confidence` is 0075's weighing field — "a match without one is an
-- assertion nobody can weigh" — so it, unlike method, MAY vary with cardinality: one instance → `medium` (exhaustive but
-- still inferential), many → `low` for every candidate (nothing distinguishes them). It is pinned in docs/79 and will be
-- pinned in the planner that writes it; encoding it here would put a rule in the schema that the schema cannot check.
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
-- ══ WHAT THIS MIGRATION DOES NOT DO ═════════════════════════════════════════════════════════════════════════════════════════════
-- No matcher, no planner, no proposal loop, no matcher-state orchestration, no Rule 5 change, no scheduler, no UI, no
-- provider code, no background principal, no `service_role`, no `connector_runner` authority, no new table, no RLS policy,
-- no table grant. 0075/0085/0087/0088/0089 are untouched apart from the two edits named above. Staging only; applied to no
-- hosted database.

begin;

-- ══ 1. METHOD DOMAIN ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Dropped and re-added rather than "if not exists": the constraint is created unconditionally by 0075 in this same ordered
-- chain, so if it is absent the chain is broken and that must fail loudly.
alter table public.application_matches drop constraint application_matches_method_chk;
alter table public.application_matches add constraint application_matches_method_chk
  check (method in ('manual', 'exact_domain', 'exact_external_id', 'vendor_catalog', 'suggested', 'canonical_product'));

comment on column public.application_matches.method is
  'Provenance of how the candidate was produced, never proof that it is correct. canonical_product = derived deterministically from a confirmed canonical-product mapping and the tenant operational instances of that product; the evidence does not identify which instance is correct.';

-- The propose command must admit the literal, or the value would be legal in the table and unreachable through the only
-- writer — a contract that cannot be exercised. Byte-identical to 0088 apart from the admitted list.
create or replace function public.product_propose_application_match(
  p_tenant_id uuid,
  p_directory_application_id uuid,
  p_app_id uuid,
  p_method text,
  p_confidence text
) returns jsonb language plpgsql security definer set search_path = public volatile as $$
declare
  v_existing text;
  v_inserted integer := 0;
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    return jsonb_build_object('status', 'not_allowed');
  end if;
  if p_method not in ('manual', 'exact_external_id', 'vendor_catalog', 'canonical_product') then
    return jsonb_build_object('status', 'invalid_method');
  end if;
  if p_confidence not in ('high', 'medium', 'low') then
    return jsonb_build_object('status', 'invalid_confidence');
  end if;

  -- Both endpoints must belong to the verified tenant. A foreign or missing row is indistinguishable from an unauthorized one —
  -- the composite FKs are the final backstop, but the caller must not learn which of the two it was.
  if not exists (select 1 from public.directory_applications d where d.id = p_directory_application_id and d.tenant_id = p_tenant_id)
     or not exists (select 1 from public.apps a where a.id = p_app_id and a.tenant_id = p_tenant_id) then
    return jsonb_build_object('status', 'not_allowed');
  end if;

  insert into public.application_matches
    (tenant_id, directory_application_id, app_id, method, confidence, status)
  values
    (p_tenant_id, p_directory_application_id, p_app_id, p_method, p_confidence, 'proposed')
  on conflict (tenant_id, directory_application_id, app_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    return jsonb_build_object('status', 'proposed');
  end if;

  -- The pair already exists. Report its state and change nothing: a decided candidate is never re-opened by re-proposing, and a
  -- live proposal is never duplicated or re-scored.
  select m.status into v_existing
    from public.application_matches m
   where m.tenant_id = p_tenant_id
     and m.directory_application_id = p_directory_application_id
     and m.app_id = p_app_id;
  return jsonb_build_object('status', 'already_' || coalesce(v_existing, 'proposed'));
end $$;

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
