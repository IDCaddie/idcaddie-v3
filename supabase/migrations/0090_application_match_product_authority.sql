-- 0090_application_match_product_authority.sql
--
-- Phase 18B0 — make `application_matches` PRODUCT-AUTHORITATIVE.
--
--     directory application  →  canonical PRODUCT   (required, the relationship)
--                            →  operational INSTANCE (optional, a refinement of it)
--
-- ══ A CORRECTIVE SUCCESSOR TO 0088, NOT A DISAGREEMENT WITH IT ══════════════════════════════════════════════════════════════════
-- 0088 built the review boundary this table had been waiting for since 0075 — propose and decide, a real lifecycle — and it aimed
-- both at `app_id` for a reason that was TRUE WHEN IT WAS WRITTEN: `apps.canonical_app_id` had no writer anywhere, so pointing the
-- relationship at `app_products` would have aimed it at a table nothing populated. Its header says so, and says not to repoint it.
--
-- #420 (a6e767e, merged one commit BEFORE 0088) removed that premise. `src/lib/data/app-canonicalization.ts` now inserts
-- `app_products` and writes `apps.canonical_app_id` through a governed decision. The endpoint 0088 called unbacked is backed.
-- 0088 is historical fact and is not edited here; its header is stale from #420 onward, and `docs/05` records that explicitly.
--
-- ══ WHY THE ENDPOINT HAS TO MOVE ════════════════════════════════════════════════════════════════════════════════════════════════
-- 0024 is explicit about the two nouns: `app_products` is "the CANONICAL app/product" (Salesforce, Jira), and `apps` "STAYS the
-- operational instance row" (Salesforce Production, Salesforce Sandbox). The deterministic evidence chain Phase 18A built runs
--
--     directory_applications.external_id  →  confirmed app_aliases (0087)  →  app_product_id
--
-- and it establishes the PRODUCT, not the instance. An IdP knows it integrates "Salesforce"; it does not know which of a tenant's
-- Salesforce instances that is. With `app_id NOT NULL` the single thing a matcher can prove deterministically is the single thing
-- the table cannot record — so 18C would have to invent an instance to write a product fact. That is the bug this closes.
--
-- So the product becomes the authority and the instance becomes an optional refinement. This is NOT two competing endpoints:
-- `app_product_id` is always the relationship, and `app_id`, when present, only says WHICH instance of that same product.
-- 0084 established the two models coexist because they answer different questions; this adds the hierarchy 0084 implies.
--
-- ══ WHAT THIS MIGRATION DOES NOT DO ═════════════════════════════════════════════════════════════════════════════════════════════
-- No matcher, no UI, no provider code, no canonical-app writer (that is #420's), no change to `app_aliases` or 0087, no new table,
-- no new RLS policy, no table grant, no `connector_runner` authority, no `service_role`. `product_decide_application_match` is
-- deliberately untouched — it is keyed on (match id, decision) and never referenced either endpoint, so 0088's version stays
-- correct verbatim. `application_matches` stays deny-all to every browser role exactly as 0075 left it.
-- Rule 5 is untouched: its loader parses only id / directory_application_id / status and has never seen either endpoint.
-- 0089 (#421, `product_app_accounts_for_governance` over `app_accounts`) sits between 0088 and this one and shares no object with
-- it; the relationship is migration order and nothing else.
-- Staging only; applied to no hosted database.
--
-- ══ ON `DROP` WITHOUT `IF EXISTS` ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Every object this migration drops was created UNCONDITIONALLY by an earlier migration in the same ordered chain (0075, 0085,
-- 0088). Dropping them plainly makes this migration assert its own premise: if 0088's index or command is not there, the chain is
-- broken and that must fail loudly rather than be tolerated into a half-corrected schema.

begin;

-- ══ 1. the canonical endpoint, added nullable so existing rows can be examined before anything is demanded of them ═══════════════
alter table public.application_matches add column if not exists app_product_id uuid;

-- ══ 2. DETERMINISTIC backfill — the only inference permitted is one the schema already asserts ═══════════════════════════════════
-- 0088's propose command has been live, so real proposed/decided rows may exist. `apps.canonical_app_id` IS the "which product is
-- this instance" fact, declared as a same-tenant FK in 0024 and now written by #420. Reading it is not a guess. NOTHING else is
-- admissible: not app name, vendor name, normalized name, contract label, similarity, or model output. A product identity invented
-- from a string is indistinguishable from a correct one once written, and every consumer downstream would treat it as a
-- human-grade fact.
update public.application_matches m
   set app_product_id = a.canonical_app_id
  from public.apps a
 where a.id = m.app_id
   and a.tenant_id = m.tenant_id
   and a.canonical_app_id is not null
   and m.app_product_id is null;

-- ══ 3. REFUSE rather than invent ════════════════════════════════════════════════════════════════════════════════════════════════
-- A row whose instance has no canonical product cannot be given one. Aborting is the only honest option: deleting it would discard
-- a human decision recorded through 0088's decide command, and defaulting it would fabricate canonical identity. The diagnostic
-- names the count and a bounded sample of directory-application ids so an operator can act on it — internal uuids only, never a
-- provider payload or a row value.
--
-- The remedy is to canonicalize those `apps` rows first (#420's flow populates `canonical_app_id`), then re-run.
do $$
declare v_orphans integer; v_sample text;
begin
  select count(*) into v_orphans from public.application_matches where app_product_id is null;
  if v_orphans > 0 then
    select string_agg(x.directory_application_id::text, ', ')
      into v_sample
      from (select directory_application_id from public.application_matches
             where app_product_id is null order by directory_application_id limit 5) x;
    raise exception
      '0090: % application_matches row(s) have no canonical product and none can be derived. Populate apps.canonical_app_id for the referenced instances, then re-run. First directory_application_id(s): %',
      v_orphans, v_sample;
  end if;
end $$;

-- ══ 4. the authority becomes required; the refinement becomes optional ══════════════════════════════════════════════════════════
alter table public.application_matches alter column app_product_id set not null;
alter table public.application_matches alter column app_id drop not null;

-- ══ 5. TENANT INTEGRITY for the new authority — the same composite-FK pattern every canonical child uses ════════════════════════
-- Structural, not procedural: a foreign product is impossible even for a buggy SECURITY DEFINER function.
alter table public.application_matches
  add constraint application_matches_product_tenant_fk
  foreign key (app_product_id, tenant_id) references public.app_products (id, tenant_id) on delete cascade;

-- ══ 6. THE REFINEMENT INVARIANT ═════════════════════════════════════════════════════════════════════════════════════════════════
-- If an instance is named, it MUST be an instance OF THE PRODUCT this match asserts. Without this the table could hold
--
--     app_product_id = Salesforce   AND   app_id = Jira Production
--
-- which is not a refinement of anything — it is two contradictory claims in one row, and the "authority vs refinement" hierarchy
-- would be a convention rather than a fact.
--
-- ONE three-column FK does all of it. `apps.canonical_app_id` is the instance's own product, so referencing
-- (id, canonical_app_id, tenant_id) forces product agreement AND same-tenant in a single constraint.
--
-- MATCH SIMPLE (the default) is load-bearing in BOTH directions:
--   · `app_id IS NULL`                      → the check is SKIPPED, so a product-only match is valid. That is the common case.
--   · `apps.canonical_app_id IS NULL`       → REFUSED, because a foreign key can never match a NULL referenced key. Deliberate:
--                                             an instance whose own product is unknown cannot refine a product claim. The remedy
--                                             is to canonicalize the app first, never to relax this.
alter table public.apps
  add constraint apps_id_canonical_tenant_key unique (id, canonical_app_id, tenant_id);

alter table public.application_matches
  add constraint application_matches_instance_refines_product_fk
  foreign key (app_id, app_product_id, tenant_id)
  references public.apps (id, canonical_app_id, tenant_id) match simple on delete set null;

-- ══ 7. CANDIDATE IDENTITY MOVES TO THE PRODUCT ══════════════════════════════════════════════════════════════════════════════════
-- 0088 created `application_matches_candidate_idx` over (tenant_id, directory_application_id, app_id) and built its whole replay
-- story on it. What makes two proposals "the same proposal" is now the PRODUCT they claim, not the instance they may or may not
-- name: two rows that differ only in an optional refinement are one canonical candidate at two levels of detail.
--
-- Keying this on `app_id` is a correctness bug the moment `app_id` becomes nullable: Postgres treats NULLs as DISTINCT in a unique
-- index, so every product-level proposal (`app_id IS NULL`) inserts a fresh duplicate, and a matcher re-running each sync deposits
-- one row per run forever. The product key makes re-proposal a no-op, makes a rejected candidate unresurrectable — including
-- through a different instance — and makes an accepted one unduplicatable, structurally, for all statuses.
--
-- THE INDEX IS REPLACED, NOT RE-DECLARED. `create unique index if not exists` under 0088's name would find the name taken, emit a
-- NOTICE, and silently leave 0088's app_id definition active — the migration would report success and ship the wrong key. That
-- shadowing was reproduced directly before this was written. Hence an explicit drop, and no `if not exists` on the create.
drop index public.application_matches_candidate_idx;

create unique index application_matches_candidate_idx
  on public.application_matches (tenant_id, directory_application_id, app_product_id);

-- ACCEPTED cardinality is 0075's and is unchanged: at most one accepted match per directory application (its partial unique index
-- is on (tenant_id, directory_application_id) and never mentioned an endpoint), and deliberately MANY-TO-ONE on the canonical
-- side — many directory applications may accept one product, which is the normal shape for one product integrated in several IdPs.
-- Nothing here makes app_product_id unique on its own; doing so would break that.
create index application_matches_product_idx
  on public.application_matches (tenant_id, app_product_id) where status = 'accepted';

-- ══ 8. the governed read — the authority, not the refinement ════════════════════════════════════════════════════════════════════
-- 0085 returned `app_id`. That is now the SUBORDINATE field, and a governance read that exposes the refinement while omitting the
-- relationship is backwards. Swapped, not widened: the surface stays four columns, and `app_id` is deliberately NOT added — no
-- consumer needs it, and a bounded read does not carry a column because the table happens to have one.
--
-- Rule 5 consumes neither endpoint (its loader parses only id / directory_application_id / status), so this changes no governance
-- behaviour. CREATE OR REPLACE cannot change a function's return type, so the old signature is dropped first; the grant is
-- re-applied below because DROP takes it with the function.
drop function public.product_application_matches(uuid, uuid, integer);

create function public.product_application_matches(
  p_tenant_id uuid, p_after_id uuid default null, p_limit integer default 500
) returns table (
  id uuid, directory_application_id uuid, app_product_id uuid, status text
) language sql security definer set search_path = public stable as $$
  select m.id, m.directory_application_id, m.app_product_id, m.status
    from public.application_matches m
   where public.has_tenant_role(p_tenant_id, array['owner', 'admin'])
     and m.tenant_id = p_tenant_id
     and (p_after_id is null or m.id > p_after_id)
   order by m.id
   limit greatest(1, least(coalesce(p_limit, 500), 500));
$$;

-- ══ 9. THE PROPOSE COMMAND — REQUIRED COMPATIBILITY WORK, NOT SCOPE ═════════════════════════════════════════════════════════════
-- 0088's propose command cannot write this schema: it never supplies `app_product_id`, which §4 just made NOT NULL, and its
-- `on conflict (tenant_id, directory_application_id, app_id)` names an index that no longer exists. Left alone it would fail on
-- every call. Replacing it is the cost of the correction, so it happens in the same transaction — there is no instant at which the
-- boundary is installed but unusable.
--
-- THE OLD SIGNATURE IS DROPPED, NOT REPLACED. `create or replace` cannot add a parameter, and leaving
-- (uuid, uuid, uuid, text, text) resident would be worse than untidy: with the new function's trailing default, a five-argument
-- call could resolve against either, and a stale overload that still writes an instance as if it were the relationship is an
-- alternate authorization path with its own grant. One command, one signature.
--
-- PARAMETER ORDER is forced by PostgreSQL: only trailing parameters may carry defaults, so the optional refinement goes last. The
-- required endpoint keeps 0088's third position, which is what a caller reads as "the thing being matched to".
drop function public.product_propose_application_match(uuid, uuid, uuid, text, text);

create function public.product_propose_application_match(
  p_tenant_id uuid,
  p_directory_application_id uuid,
  p_app_product_id uuid,
  p_method text,
  p_confidence text,
  p_app_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public volatile as $$
declare
  v_existing text;
  v_inserted integer := 0;
begin
  -- 0088's gate, verbatim: owner/admin, the same authority as the 0085 read and the 0087 declaration. `connector_runner` is not
  -- granted; proposing a canonical relationship is product-side judgement and discovery has none.
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    return jsonb_build_object('status', 'not_allowed');
  end if;

  -- 0088's method vocabulary, unchanged. `exact_domain` stays refused (the directory side carries no domain column, so nothing can
  -- truthfully claim it) and `suggested` stays refused (the weak-evidence bucket, with no producer; admitting it before one exists
  -- invites exactly the name-similarity matching this line of work prevents).
  if p_method not in ('manual', 'exact_external_id', 'vendor_catalog') then
    return jsonb_build_object('status', 'invalid_method');
  end if;
  if p_confidence not in ('high', 'medium', 'low') then
    return jsonb_build_object('status', 'invalid_confidence');
  end if;

  -- AUTHORIZATION facts first, reported as one indistinguishable status exactly as 0088 did: a foreign or missing row must not be
  -- distinguishable from an unauthorized one. The composite FKs are the final backstop; this is the bounded caller-facing form.
  if not exists (select 1 from public.directory_applications d
                  where d.id = p_directory_application_id and d.tenant_id = p_tenant_id)
     or not exists (select 1 from public.app_products p
                     where p.id = p_app_product_id and p.tenant_id = p_tenant_id)
     or (p_app_id is not null
         and not exists (select 1 from public.apps a where a.id = p_app_id and a.tenant_id = p_tenant_id)) then
    return jsonb_build_object('status', 'not_allowed');
  end if;

  -- Then the SEMANTIC fact, which is a different kind of wrong and gets its own bounded status. The caller is authorized for both
  -- rows; the claim is self-contradictory — an instance of Jira cannot refine a match to Salesforce, and an instance whose own
  -- `canonical_app_id` is NULL refines nothing. §6's FK would refuse this anyway; catching it here returns a bounded status
  -- instead of letting a constraint violation escape as a Postgres error.
  if p_app_id is not null
     and not exists (select 1 from public.apps a
                      where a.id = p_app_id and a.tenant_id = p_tenant_id
                        and a.canonical_app_id = p_app_product_id) then
    return jsonb_build_object('status', 'invalid_refinement');
  end if;

  -- `decided_by`/`decided_at` stay NULL and status is always 'proposed' — the 0075 CHECK already refuses any other combination for
  -- a proposed row, so auto-accepting from here is structurally impossible rather than merely un-implemented.
  insert into public.application_matches
    (tenant_id, directory_application_id, app_product_id, app_id, method, confidence, status)
  values
    (p_tenant_id, p_directory_application_id, p_app_product_id, p_app_id, p_method, p_confidence, 'proposed')
  on conflict (tenant_id, directory_application_id, app_product_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    return jsonb_build_object('status', 'proposed');
  end if;

  -- The PRODUCT candidate already exists. Report its state and change nothing — including when this call carries a refinement the
  -- stored row lacks.
  --
  -- NO SILENT ENRICHMENT. It is tempting to fill in a newly-learned `app_id` on an existing proposed row, and this deliberately
  -- does not: nothing in the current architecture ranks two pieces of instance evidence against each other, so "enrich if
  -- previously NULL" is last-write-wins wearing a conservative disguise — the first caller to guess an instance would win, and a
  -- reviewer would see a refinement nobody proposed. Idempotency is worth more than automatic precision here. Adding a refinement
  -- to a live candidate is a distinct operation with its own review, and it is not this command.
  --
  -- Keyed on the PRODUCT, so a rejected candidate cannot be resurrected — nor an accepted one duplicated — by presenting a
  -- different instance. That is the whole reason candidate identity moved.
  select m.status into v_existing
    from public.application_matches m
   where m.tenant_id = p_tenant_id
     and m.directory_application_id = p_directory_application_id
     and m.app_product_id = p_app_product_id;
  return jsonb_build_object('status', 'already_' || coalesce(v_existing, 'proposed'));
end $$;

-- ══ 10. least privilege, re-applied — DROP took the old grants with the old functions ═══════════════════════════════════════════
-- Hosted Supabase grants EXECUTE on new public functions to anon/authenticated by default (0045), and `revoke from public` alone
-- does not remove it, so every role is named — 0085's and 0088's posture, unchanged. `service_role` is deliberately not named,
-- matching the 0061/0078/0085/0087/0088 product-RPC precedent.
do $$
declare f text;
begin
  foreach f in array array[
    'public.product_application_matches(uuid, uuid, integer)',
    'public.product_propose_application_match(uuid, uuid, uuid, text, text, uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated, connector_runner', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

comment on function public.product_application_matches(uuid, uuid, integer) is
  'Bounded, tenant-gated read of application_matches for the governance loader. Returns the CANONICAL endpoint (app_product_id); the optional operational refinement (app_id) is deliberately not exposed. owner/admin only.';
comment on function public.product_propose_application_match(uuid, uuid, uuid, text, text, uuid) is
  'Proposes a directory-application → canonical app_product match (status proposed, never decided). The operational instance is an OPTIONAL refinement and must belong to the same product. owner/admin. Idempotent on (tenant, directory_application, app_product); never resurrects a rejected candidate nor duplicates an accepted one, and never enriches an existing candidate. A proposal is not a match.';

commit;
