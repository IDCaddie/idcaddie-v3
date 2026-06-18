-- 0014 · Contract-file Storage authorization helpers
--
-- Two public-schema predicates that the (hosted, staging-only) contract-files `storage.objects` policies
-- will call — see docs/22 §5 (the finalized object-policy plan). They live here (NOT a storage.* policy) so
-- they are applied with the rest of the schema and can be RLS-tested locally; the `storage.objects` policies
-- themselves are NEVER a migration (docs/21 — the local harness has no `storage` schema) and are applied to
-- STAGING ONLY by a human. This migration adds NO storage.* object, creates no bucket, applies no policy.
--
-- SECURITY DEFINER: both bypass `files`-table RLS on purpose. An org-only procurement manager may INSERT a
-- `files` row under 0013 but CANNOT SELECT it (the deliberate 0013 read/write asymmetry, docs/16 §5) — the
-- definer lets the Storage policy still authorize them off the `files` row. `auth.uid()` still resolves to
-- the caller (the inner can_write_contract / is_tenant_member re-derive the caller's authority); no recursion
-- (storage.objects is never referenced by public.files policies); search_path pinned to public.
--
-- Both REQUIRE a matching `files` metadata row for (file_id, tenant_id) to exist first — no `files` row ⇒
-- false (no orphan-object authorization). `paying_org` never grants write (carried entirely by
-- can_write_contract, 0013/0004; not widened here).

create or replace function public.can_write_contract_file(target_file_id uuid, target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.files f
    where f.id = target_file_id
      and f.tenant_id = target_tenant_id
      and public.can_write_contract(f.contract_id, f.tenant_id)
  );
$$;

create or replace function public.can_read_contract_file(target_file_id uuid, target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.files f
    where f.id = target_file_id
      and f.tenant_id = target_tenant_id
      and public.is_tenant_member(f.tenant_id)
  );
$$;

comment on function public.can_write_contract_file(uuid, uuid) is
  'Storage object-policy predicate (docs/22 §5): a files row exists for (file_id, tenant) AND the caller has contract-write authority on its contract (0013/can_write_contract; never paying_org). SECURITY DEFINER to bypass files-SELECT RLS for org-only managers.';
comment on function public.can_read_contract_file(uuid, uuid) is
  'Storage object-policy predicate (docs/22 §5): a files row exists for (file_id, tenant) AND the caller can read it (0013 files SELECT = tenant member; org-scoped read deferred).';
