-- 0087_application_alias_declaration.sql
--
-- Phase 18A2 — the governed command that lets an authorized product-side operator declare
--
--     "this directory application corresponds to this canonical app product"
--
-- WITHOUT the product ever receiving `directory_applications.external_id`.
--
-- ══ WHY A COMMAND, AND WHY IT DOES NOT WEAKEN 0061 ══════════════════════════════════════════════════════════════════════════════
-- Phase 18A1 shipped the deterministic resolver over `app_aliases` and found it had nothing to resolve: the table is empty and no
-- product-side path can populate it. The obvious design — a server action that reads the directory application's `external_id` and
-- records it — CANNOT EXECUTE. `directory_applications` enables RLS and defines NO policy at all (0057), so it is deny-all to
-- `authenticated`; and the 0061 read RPCs deliberately return "ONLY bounded safe fields … and NEVER external_id / raw_payload /
-- normalized_* / credentials / settings / profiles / last_discovery_run_id / source_endpoint".
--
-- 0061's rule is about what is RETURNED to a browser caller, not about what a definer function may READ. Its own RPCs already read
-- `directory_applications` internally and simply do not return the identifier. This migration follows exactly that discipline: the
-- identifier is read inside the database boundary, used to key the alias, and NEVER returned. The product asks the question with
-- two row ids it already holds and receives one bounded status string. That PRESERVES the information-hiding decision — it does
-- not override it. No SELECT policy is added, no table grant is added, and no read path to `external_id` is created.
--
-- `external_id` is opaque provider evidence (0057: "Okta app id (0oa...) — immutable provider identity"), stored unencrypted and
-- not a credential. It was withheld from the canonical READ RPCs as minimum-disclosure discipline, not because it is secret.
--
-- BE PRECISE ABOUT WHAT THIS COMMAND HIDES. It never RETURNS the identifier — but it does WRITE it to app_aliases.alias_value,
-- and 0024 lets any tenant MEMBER read that table. So after a declaration the identifier is member-readable. That is not a new
-- disclosure and not a widened audience: 0025 already grants members read on discovery_facts, whose fact_json carries the same
-- `external_id` for directory_application facts — it is literally what the 0057 promote RPC reads — and 0024 classifies
-- alias_value as "a label/id, never a secret/token". The honest claim is therefore narrow: THE COMMAND DOES NOT RETURN IT, AND
-- ADDS NO NEW DISCLOSURE PATH. It is NOT "external_id is invisible to the product", and nothing should be built on that.
--
-- ══ AUTHORIZATION — owner/admin, and why NOT editor ═════════════════════════════════════════════════════════════════════════════
-- The `app_aliases` RLS policy (0024) lets owner/admin/EDITOR write the table directly, so it would be easy to assume editor here.
-- It is deliberately owner/admin, matching 0061 (the gate on the canonical directory rows this command acts on) and the 0078
-- product-command precedent. An editor cannot read `directory_applications` at all, and 0061 denies them even its bounded list,
-- so this command is gated at the level that may see the canonical directory surface it operates on. Note the rationale is NOT
-- that the identifier is otherwise unobtainable — an editor is a member, and members can read discovery_facts (0025) where the
-- same external_id sits in fact_json. The gate is about who may make a canonical judgement over a directory row, not secrecy.
--
-- `p_tenant_id` is VERIFIED, never trusted: has_tenant_role() resolves the caller from auth.uid() and an active membership. Because
-- tenant_memberships.user_id references public.profiles(id), any caller that passes the gate necessarily has a profiles row, so
-- writing reviewed_by = auth.uid() cannot violate the app_aliases.reviewed_by FK.
--
-- ══ WHAT THIS MIGRATION DOES NOT DO ════════════════════════════════════════════════════════════════════════════════════════════
-- No table, column, index, policy or table grant. No SELECT on directory_applications for anyone. No product RPC that returns
-- external_id. No connector_runner authority (it holds none on the canonical catalog and gains none). Nothing touches
-- `application_matches` (0075) — declaring canonical identity is NOT application matching, and the matcher remains unbuilt.
-- Staging only; nothing applied to production.

begin;

-- ══ the command ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Returns a bounded status ONLY. Never the identifier, never the source row, never a DB error or SQL detail:
--
--   created            a new confirmed canonical judgement was recorded
--   already_confirmed  this identifier is already confirmed to this product — idempotent success
--   conflict           a judgement already exists that is not this one (different product, or pending, or rejected)
--   source_not_current the directory application cannot establish identity right now
--   not_allowed        caller lacks authority, or either row is absent/foreign — deliberately indistinguishable
create or replace function public.product_declare_application_alias(
  p_tenant_id uuid,
  p_directory_application_id uuid,
  p_app_product_id uuid
) returns jsonb language plpgsql security definer set search_path = public volatile as $$
declare
  v_external_id      text;
  v_sync_status      text;
  v_existing_product uuid;
  v_existing_status  text;
  v_inserted         integer := 0;
begin
  -- A. Authorize. Verify, never trust, the passed tenant. A non-owner/admin gets the same answer as a nonexistent tenant.
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    return jsonb_build_object('status', 'not_allowed');
  end if;

  -- B. Read the source INTERNALLY, scoped to the verified tenant. A foreign or missing directory application is indistinguishable
  --    from an unauthorized one — no existence disclosure, the 0061 rule.
  select da.external_id, da.sync_status
    into v_external_id, v_sync_status
    from public.directory_applications da
   where da.id = p_directory_application_id
     and da.tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('status', 'not_allowed');
  end if;

  -- C. Source eligibility. Only a CURRENT directory application may mint a NEW canonical judgement: a stale, review_required or
  --    disconnected row is evidence the provider stopped confirming this application exists, which is not a basis for creating
  --    identity. A blank identifier fails the same gate for the same reason — the source cannot establish identity either way.
  --    (This is one-directional: an ALREADY-confirmed alias keeps resolving forever regardless of its source's sync_status. The
  --    Phase 18A1 resolver never reads the directory side at all. Provider freshness and canonical judgement are separate facts.)
  v_external_id := btrim(coalesce(v_external_id, ''));
  if v_sync_status is distinct from 'current' or v_external_id = '' then
    return jsonb_build_object('status', 'source_not_current');
  end if;

  -- D. The target product must belong to the same verified tenant. The composite FK below is the final backstop; this check exists
  --    so a cross-tenant attempt returns a bounded status instead of raising a foreign-key exception at the caller.
  if not exists (select 1 from public.app_products p where p.id = p_app_product_id and p.tenant_id = p_tenant_id) then
    return jsonb_build_object('status', 'not_allowed');
  end if;

  -- E. Conflict semantics on the 0026 natural key UNIQUE(tenant_id, alias_type, alias_value). A human decision outranks a
  --    re-submitted declaration: only "already confirmed to the SAME product" is an idempotent success. A different product, a
  --    pending proposal, or a rejected mapping are all conflicts — this command never promotes, resurrects or overwrites.
  select a.app_product_id, a.review_status
    into v_existing_product, v_existing_status
    from public.app_aliases a
   where a.tenant_id = p_tenant_id
     and a.alias_type = 'provider_app_id'
     and a.alias_value = v_external_id;
  if found then
    if v_existing_product = p_app_product_id and v_existing_status = 'confirmed' then
      return jsonb_build_object('status', 'already_confirmed');
    end if;
    return jsonb_build_object('status', 'conflict');
  end if;

  -- F. Declare. 'confirmed' because an owner/admin invoking a command named "declare" IS the review — Phase 18A1 resolves only
  --    'confirmed', so writing 'pending' would produce a judgement nothing can use, and 'auto' has no defined meaning anywhere in
  --    this schema. confidence 100: exact identifier equality asserted by a human, the 0..100 scale's ceiling.
  insert into public.app_aliases
    (tenant_id, app_product_id, alias_type, alias_value, source, confidence, review_status, reviewed_by, reviewed_at)
  values
    (p_tenant_id, p_app_product_id, 'provider_app_id', v_external_id, 'product_declaration', 100, 'confirmed', auth.uid(), now())
  on conflict (tenant_id, alias_type, alias_value) do nothing;
  get diagnostics v_inserted = row_count;

  -- A concurrent declaration took the natural key between the read and the insert. Re-read and re-decide rather than reporting a
  -- conflict that may not be one: if the other writer chose the SAME product, this call is still idempotent.
  if v_inserted = 0 then
    select a.app_product_id, a.review_status
      into v_existing_product, v_existing_status
      from public.app_aliases a
     where a.tenant_id = p_tenant_id
       and a.alias_type = 'provider_app_id'
       and a.alias_value = v_external_id;
    if found and v_existing_product = p_app_product_id and v_existing_status = 'confirmed' then
      return jsonb_build_object('status', 'already_confirmed');
    end if;
    return jsonb_build_object('status', 'conflict');
  end if;

  return jsonb_build_object('status', 'created');
end $$;

-- ══ least privilege ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- On hosted Supabase, ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions straight to anon/authenticated (0045), and
-- `revoke from public` alone does not remove it — every role is named. `connector_runner` is revoked: canonical identity is a
-- product-side judgement and discovery may never assert it. `service_role` is deliberately NOT named, matching the 0061/0073/0078
-- product-RPC precedent — it holds table grants on everything and bypasses RLS already, so revoking EXECUTE on a wrapper would buy
-- nothing and would put this migration permanently out of step with every other product command in the schema.
revoke execute on function public.product_declare_application_alias(uuid, uuid, uuid) from public, anon, authenticated, connector_runner;
grant  execute on function public.product_declare_application_alias(uuid, uuid, uuid) to authenticated;

comment on function public.product_declare_application_alias(uuid, uuid, uuid) is
  'Declares a canonical app_aliases judgement (provider_app_id -> app_product) from a directory application, owner/admin only. Reads directory_applications.external_id INTERNALLY and never returns it, preserving the 0061 minimum-disclosure boundary. Returns a bounded status only. Declaring canonical identity is not application matching.';

commit;
