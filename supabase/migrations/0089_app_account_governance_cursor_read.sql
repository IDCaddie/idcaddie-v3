-- 0089 — a stable cursor read of app accounts, for the governance evidence walk.
--
-- WHY A SECOND READ RATHER THAN A CHANGED ONE. `product_app_accounts` (0078) serves a HUMAN browsing a paged table:
-- it orders by `display_name nulls last, email nulls last, external_id`, pages by OFFSET, and returns
-- `count(*) over ()` for the pager. `src/app/(authenticated)/saas/accounts/page.tsx` depends on all three. Converting
-- it in place would give that table UUID-ordered pages — the precise mistake 0061's read path already documents:
-- cursor-paging straight to a customer's screen hands them an alphabetically random page. So the two readers get two
-- contracts, because they are asking two different questions:
--
--   UI          -> "show me a page of accounts a person can scan"      -> display order, offset, total
--   GOVERNANCE  -> "show me EVERY account, exactly once"               -> id order, cursor, no total
--
-- WHAT THIS FIXES, AND WHY OFFSET COULD NOT. Governance uses the walk as evidence for CLOSING findings, so a silently
-- skipped row is not a display glitch — it withholds an account's finding while its connection stays closure-eligible,
-- and migration 0083 then resolves something still true. Under OFFSET that was reachable: 0078's ORDER BY is
-- `(display_name, email, external_id)` while the governance loader reads with `p_connection_id = null`, and
-- `external_id` is unique only per `(tenant, connection, provider)` — so the order is NOT TOTAL in the scope actually
-- read (two accounts for one person in two workspaces tie on all three keys). Tied rows have no guaranteed
-- inter-statement ordering, and a row deleted before the offset shifts every later row left by one, skipping one at the
-- page boundary. PR #418 made the detectable half fail closed; it could not make the read stable.
--
-- `id` fixes it structurally: it is `uuid primary key default gen_random_uuid()` — immutable and globally unique — so
-- `where id > p_after_id order by id` is a TOTAL order that no concurrent write can reshuffle. A row present for the
-- whole walk cannot be missed, because its id is fixed and the cursor passes over every id in ascending order exactly
-- once.
--
-- HONEST LIMIT, so nobody reads more into this than it says: the walk is CURSOR-STABLE, not a point-in-time SNAPSHOT.
-- A row inserted mid-walk appears if its id sorts above the cursor and does not if it sorts below; a row deleted
-- mid-walk simply is not returned. That is sufficient for closure authority, and the direction is what makes it safe:
-- the only row a walk can miss is one CREATED during it, which under-reports a new finding rather than falsely closing
-- an existing one — an existing finding's subject predates the walk and carries a fixed id the cursor must traverse.
-- Snapshot isolation would need a run boundary; nothing here claims one.
--
-- Additive: 0078 is untouched, no table changes, no policy, no grant to any table.

-- Stale rows are returned ALWAYS — there is no `p_include_stale`. The cross-source engine decides what staleness means
-- per rule (a stale account is not live access, but it is also not absence), and a read that filtered them would answer
-- that question on the engine's behalf and make "we did not fetch it" indistinguishable from "it is not there".
--
-- The column list is exactly what the engine consumes and nothing more: no email, display_name, external_id or
-- workspace id. Those are the mutable, connection-scoped fields the governance layer must never reason over, and their
-- absence here is what makes it impossible for a future guard to key on one by accident.
create or replace function public.product_app_accounts_for_governance(
  p_tenant_id uuid, p_after_id uuid default null, p_limit integer default 500
) returns table (
  id uuid, connection_id uuid, provider text,
  account_kind text, account_status text, is_admin boolean, sync_status text
) language sql security definer set search_path = public stable as $$
  select a.id, a.connection_id, a.provider,
         a.account_kind, a.account_status, a.is_admin, a.sync_status
    from public.app_accounts a
   where public.has_tenant_role(p_tenant_id, array['owner', 'admin'])
     and a.tenant_id = p_tenant_id
     and (p_after_id is null or a.id > p_after_id)
   order by a.id
   limit greatest(1, least(coalesce(p_limit, 500), 500));
$$;

-- Hosted Supabase's ALTER DEFAULT PRIVILEGES (0045) grants EXECUTE on new public functions straight to
-- anon/authenticated and `revoke from public` alone does not remove it, so every role is named. `connector_runner` is
-- revoked: it produces evidence and never reads the product surface. `service_role` is deliberately not named,
-- matching the 0061/0073/0078/0082/0083/0085 product-RPC precedent. `app_accounts` itself stays deny-all — this adds
-- no table grant and no policy.
do $$
declare f text := 'public.product_app_accounts_for_governance(uuid, uuid, integer)';
begin
  execute format('revoke execute on function %s from public, anon, authenticated, connector_runner', f);
  execute format('grant execute on function %s to authenticated', f);
end $$;
