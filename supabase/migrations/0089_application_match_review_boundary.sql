-- 0089_application_match_review_boundary.sql
--
-- Phase 18B — the governed propose/decide boundary around `application_matches` (0075).
--
--     deterministic evidence  →  PROPOSED match  →  human ACCEPT / REJECT  →  accepted relationship
--
-- 0075 shaped the output and deliberately ran no matcher; 0085 added the bounded read and the matcher-run state. This adds the
-- only two mutations that table will ever need, and nothing else. A proposal is NEVER truth: only an accepted row is a canonical
-- relationship, and only a human puts one there.
--
-- ══ THE ENDPOINT GAP THIS PHASE DOES NOT CLOSE — READ BEFORE BUILDING THE MATCHER ═══════════════════════════════════════════════
-- The SaaS side of a match is `apps` (the operational/contract instance), which is correct and consistent across 0075, 0085 and
-- Rule 5, and it is backed by real data: the Slack resolver store upserts `apps` during sync (keyed on tenant_id +
-- external_instance_id), so `apps`, `external_instance_id` and `instance_domain` all have live writers.
--
-- The break is one column. Phase 18A's canonical evidence resolves to `app_products`, and the only link from a product to its
-- operational instance — `apps.canonical_app_id` — has **zero writers** anywhere in migrations, src or the runner, and is NULL on
-- every row. (`src/lib/server/connector-vault/resolution.ts` says so outright: "nothing populates apps.canonical_app_id yet".)
-- `app_products` itself is likewise read-only in the product today.
--
-- So there is NO deterministic path from a confirmed canonical alias to an `apps` row. That does not block THIS boundary — a
-- human owner/admin can propose and decide a real relationship against apps rows that genuinely exist, and every branch here is
-- exercisable end to end — but a deterministic matcher (18C) would have nothing to propose from. **Populating
-- `apps.canonical_app_id` (and a write path for `app_products`) is the prerequisite for 18C.** Recording it here so the matcher
-- is not built against an empty seam, which is exactly how Phase 18A first went wrong.
--
-- Do NOT "fix" this by repointing `application_matches` at `app_product_id`: that would aim the FK at a table with no writer at
-- all and leave the matcher more blocked, not less. `app_id -> apps` is the endpoint backed by real data.
--
-- ══ WHAT THIS MIGRATION DOES NOT DO ════════════════════════════════════════════════════════════════════════════════════════════
-- No new read path (0085's `product_application_matches` stays the only one). No table grant, no RLS policy — `application_matches`
-- stays deny-all to every browser role, exactly as 0075 left it. No `connector_runner` authority. No `service_role`. No matcher, no
-- UI, no change to Rule 5 or to `application_matcher_state`: human decisions and matcher execution state stay separate facts.
-- Staging only; applied to no hosted database.

begin;

-- ══ 1. candidate identity — what makes two proposals "the same proposal" ════════════════════════════════════════════════════════
-- 0075 constrains only ACCEPTED rows (one per directory application). Proposals were unconstrained, so a matcher re-running every
-- sync would deposit a fresh duplicate each time, and a rejected candidate would silently reappear.
--
-- The natural identity of a candidate is the PAIR it links: (tenant, directory application, app). One row per pair, whatever its
-- status, for all time. That makes three properties structural rather than procedural:
--   · re-proposing is a no-op — the row already exists;
--   · a REJECTED candidate can never be resurrected by proposing again;
--   · an ACCEPTED candidate can never be duplicated.
-- Method is deliberately NOT part of the key: two methods arriving at the same pair are one candidate with two lines of evidence,
-- not two candidates. Ambiguity is unaffected — different `app_id` targets are different pairs, so one directory application may
-- still carry several competing proposals, which is the whole point of §5 below.
create unique index if not exists application_matches_candidate_idx
  on public.application_matches (tenant_id, directory_application_id, app_id);

-- ══ 2. PROPOSE ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Creates a `proposed` row and nothing else. `decided_by`/`decided_at` stay NULL — the 0075 CHECK already refuses any other
-- combination for a proposed row, so auto-accepting from here is structurally impossible, not merely un-implemented.
--
-- METHOD VOCABULARY. 0075 permits manual | exact_domain | exact_external_id | vendor_catalog | suggested. This boundary admits
-- three of them:
--   · manual             an operator's own judgement
--   · exact_external_id  an exact provider identifier match — what a confirmed `provider_app_id` app_alias (0087) supports
--   · vendor_catalog     an existing canonical catalog mapping
-- `exact_domain` is refused: the directory side carries no domain column at all, so nothing can truthfully claim it.
-- `suggested` is refused: it is the weak-evidence bucket, nothing produces it, and admitting it before a producer exists invites
-- exactly the name-similarity matching this whole line of work is built to prevent. Neither is a fuzzy method; both are simply
-- unclaimable today, and adding one later means naming the evidence that earns it.
--
-- WHO MAY PROPOSE. owner/admin — the same gate as the 0085 read, the 0087 declaration and the 0078 precedent. Proposal generation
-- is product-side orchestration; `connector_runner` is NOT granted and no new machine identity is introduced. When 18C runs a
-- matcher it runs product-side, for a tenant, through this same command.
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
  if p_method not in ('manual', 'exact_external_id', 'vendor_catalog') then
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

-- ══ 3. DECIDE ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- proposed → accepted | rejected, once. `decided_by` is auth.uid() and `decided_at` is the database's clock — neither is a
-- parameter, so a caller cannot attribute a decision to somebody else or backdate one.
--
-- A decided row is IMMUTABLE through this command: the UPDATE is guarded on `status = 'proposed'`. Changing a prior decision is a
-- different workflow with its own audit expectations, and hiding it inside "decide" would make a canonical relationship silently
-- toggleable. `already_decided` says so plainly rather than pretending nothing happened.
--
-- ACCEPTED CARDINALITY is 0075's, unchanged: at most one accepted match per directory application (partial unique index), and
-- deliberately many-to-one on the SaaS side — two directory applications may both legitimately accept one `apps` row. Two
-- concurrent accepts for one directory application therefore cannot both succeed; the loser's unique violation is caught and
-- reported as a bounded status instead of escaping as a Postgres error.
create or replace function public.product_decide_application_match(
  p_tenant_id uuid,
  p_match_id uuid,
  p_decision text
) returns jsonb language plpgsql security definer set search_path = public volatile as $$
declare
  v_updated integer := 0;
  v_current text;
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    return jsonb_build_object('status', 'not_allowed');
  end if;
  if p_decision not in ('accepted', 'rejected') then
    return jsonb_build_object('status', 'invalid_decision');
  end if;

  begin
    update public.application_matches m
       set status = p_decision, decided_by = auth.uid(), decided_at = now(), updated_at = now()
     where m.id = p_match_id
       and m.tenant_id = p_tenant_id
       and m.status = 'proposed';
    get diagnostics v_updated = row_count;
  exception when unique_violation then
    -- another accepted match for this directory application won the race
    return jsonb_build_object('status', 'accepted_exists');
  end;

  if v_updated = 1 then
    return jsonb_build_object('status', p_decision);
  end if;

  -- Nothing moved: either the row is not this tenant's / does not exist, or it was already decided. Both are reported without
  -- disclosing which, except that an in-tenant decided row is a legitimate thing for its own tenant to be told about.
  select m.status into v_current
    from public.application_matches m
   where m.id = p_match_id and m.tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('status', 'not_allowed');
  end if;
  return jsonb_build_object('status', 'already_decided');
end $$;

-- ══ 4. least privilege ═════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Hosted Supabase grants EXECUTE on new public functions to anon/authenticated by default (0045), so every role is named.
-- `connector_runner` is revoked: proposing or deciding a canonical relationship is product-side authority, and discovery has none.
-- `service_role` is deliberately not named, matching the 0061/0078/0085/0087 product-RPC precedent. No table grant and no RLS
-- policy is added anywhere — `application_matches` remains unreachable except through these functions and 0085's read.
do $$
declare f text;
begin
  foreach f in array array[
    'public.product_propose_application_match(uuid, uuid, uuid, text, text)',
    'public.product_decide_application_match(uuid, uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated, connector_runner', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

comment on function public.product_propose_application_match(uuid, uuid, uuid, text, text) is
  'Proposes a directory-application ↔ apps match (status proposed, never decided). owner/admin. Idempotent on (tenant, directory_application, app); never resurrects a rejected candidate nor duplicates an accepted one. A proposal is not a match.';
comment on function public.product_decide_application_match(uuid, uuid, text) is
  'Accepts or rejects ONE proposed application match. owner/admin; decided_by is auth.uid(). A decided row is immutable through this command. At most one accepted match per directory application.';

commit;
