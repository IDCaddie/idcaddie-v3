-- 0010_contracts_audit_on_write.sql
--
-- DB-side audit-on-write for contracts. Records every contract INSERT/UPDATE the
-- database ACCEPTS, capturing the acting user from the caller's JWT — so an audit
-- trail exists BEFORE any contract write UI / server action is built.
--
-- WHY DB-SIDE (not an app route): audit_logs is append-only with NO `authenticated`
-- INSERT policy (0001 SELECT-only + 0002 reject_audit_mutation), so a normal request
-- path CANNOT write audit rows. The only safe writer is a SECURITY DEFINER trigger
-- owned by the migration owner — never a service-role app client (which would also
-- bypass tenant RLS on every other table). See docs/13 §4, docs/09.
--
-- WHAT THIS DOES NOT CHANGE:
--   * Contract write AUTHORIZATION is untouched — existing RLS (0004: tenant
--     editor+ via has_tenant_role, OR org procurement-manager via
--     has_org_role_in_tenant; paying_org_id never grants write; no DELETE/FOR ALL)
--     still decides who may write. This trigger only RECORDS an accepted write.
--   * No policy is added/removed on contracts or audit_logs. No DELETE policy, no
--     FOR ALL, no `authenticated` INSERT on audit_logs.
--   * No user-visible behavior changes (invisible backend improvement).
--
-- WHY AFTER (not BEFORE): an AFTER ROW trigger fires only for rows the statement
-- actually wrote. A write blocked by RLS (0 rows) or rejected by the
-- enforce_owning_org_tenant BEFORE trigger (raises, statement aborts) never reaches
-- this trigger — so failed/no-op writes are NOT audited. Same transaction: if the
-- write later rolls back, its audit row rolls back too.
--
-- ACTOR under SECURITY DEFINER: SECURITY DEFINER changes the EXECUTING ROLE (to the
-- function owner, which has the table privilege + RLS bypass needed to append to
-- audit_logs), but it does NOT change session GUCs. auth.uid() reads the request's
-- JWT claim, so it still returns the CALLER (the writing user), not the owner, not
-- service_role. Verified by org_rls_test.sql T31 (actor = the exact writing user).

begin;

create or replace function public.audit_contract_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Curated, non-sensitive allowlist only (all fields already visible in the normal
  -- contracts UI). Deliberately NOT the full OLD/NEW row: no costs, dates, notes, or
  -- legal text land in the audit metadata. before_json is intentionally left NULL
  -- (we record an accepted-write event, not a full row diff).
  insert into public.audit_logs (
    tenant_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    after_json
  )
  values (
    new.tenant_id,
    auth.uid(),
    case when tg_op = 'INSERT' then 'contract.created' else 'contract.updated' end,
    'contract',
    new.id,
    jsonb_build_object(
      'contract_id', new.id,
      'contract_name', new.contract_name,
      'operation', lower(tg_op),
      'status', new.status,
      'procurement_org_id', new.procurement_org_id,
      'paying_org_id', new.paying_org_id
    )
  );
  return null;  -- AFTER ROW trigger: return value is ignored
end;
$$;

-- A trigger function cannot be invoked directly (Postgres rejects a non-trigger call),
-- so even though `authenticated` is granted EXECUTE on public functions by the harness,
-- there is no way to call this to forge an audit row outside an actual contract write.

drop trigger if exists contracts_audit_on_write on public.contracts;
create trigger contracts_audit_on_write
  after insert or update on public.contracts
  for each row execute function public.audit_contract_write();

commit;
