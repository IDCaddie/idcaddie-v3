-- 0005_same_tenant_child_integrity.sql
--
-- Enforce SAME-TENANT relational integrity at the database layer: a child/link row may not
-- reference a parent row that lives in a different tenant. RLS hides cross-tenant rows on read,
-- but without this a corrupt row (e.g. an `app_users` row claiming `tenant_id = B` while its
-- `app_id` points at a tenant-A app) could still be WRITTEN. This makes such writes fail with a
-- foreign-key violation at the constraint layer, not merely become invisible.
--
-- Mechanism: give each referenced parent a `UNIQUE (id, tenant_id)` (id is already the PK, so this
-- is redundant for uniqueness but is the required target for a composite FK), then add a composite
-- FK `(parent_ref, tenant_id) -> parent(id, tenant_id)` on each child. The pair must match, so the
-- parent must live in the child's tenant.
--
-- Notes:
--   * MATCH SIMPLE (default): if the parent-ref column is NULL the FK is not checked, so nullable
--     links (invoices.file_id/app_id/contract_id, license_evaluations.license_rule_id) keep their
--     nullable semantics. (We do NOT use MATCH FULL.)
--   * ON DELETE NO ACTION (default): adds NO new cascade — PR #16's hard-delete protection (RLS, no
--     DELETE policy on core tables) is unaffected; existing simple FKs keep their own delete actions.
--   * Constraints only — no table/column/RLS change, no data change. Reads and the destructive-delete
--     hardening (0004) are untouched.
--   * `identity_accounts` is NOT a parent of any tenant-scoped child, so it needs no composite
--     UNIQUE — but it IS a child of `people` via its nullable `person_id`, so it gets a same-tenant FK.

begin;

-- ── Composite UNIQUE (id, tenant_id) on referenced parents ───────────────────────────────────
alter table public.apps          add constraint apps_id_tenant_key          unique (id, tenant_id);
alter table public.contracts     add constraint contracts_id_tenant_key     unique (id, tenant_id);
alter table public.people        add constraint people_id_tenant_key        unique (id, tenant_id);
alter table public.app_users     add constraint app_users_id_tenant_key     unique (id, tenant_id);
alter table public.license_rules add constraint license_rules_id_tenant_key unique (id, tenant_id);
alter table public.files         add constraint files_id_tenant_key         unique (id, tenant_id);
-- organizations is both parent and self-child (parent_org_id) — needs the composite unique too.
alter table public.organizations add constraint organizations_id_tenant_key unique (id, tenant_id);

-- ── Same-tenant composite FKs on child/link tables ──────────────────────────────────────────
-- app_contracts (app_id, contract_id both NOT NULL)
alter table public.app_contracts add constraint app_contracts_app_same_tenant
  foreign key (app_id, tenant_id) references public.apps (id, tenant_id);
alter table public.app_contracts add constraint app_contracts_contract_same_tenant
  foreign key (contract_id, tenant_id) references public.contracts (id, tenant_id);

-- app_users (app_id NOT NULL)
alter table public.app_users add constraint app_users_app_same_tenant
  foreign key (app_id, tenant_id) references public.apps (id, tenant_id);

-- app_user_identity_matches (app_user_id, person_id both NOT NULL)
alter table public.app_user_identity_matches add constraint auim_app_user_same_tenant
  foreign key (app_user_id, tenant_id) references public.app_users (id, tenant_id);
alter table public.app_user_identity_matches add constraint auim_person_same_tenant
  foreign key (person_id, tenant_id) references public.people (id, tenant_id);

-- identity_accounts (child of people via nullable person_id — MATCH SIMPLE keeps null valid)
alter table public.identity_accounts add constraint identity_accounts_person_same_tenant
  foreign key (person_id, tenant_id) references public.people (id, tenant_id);

-- organizations self-reference (nullable parent_org_id) — a tenant's org tree must stay in-tenant.
-- This is write integrity only; org-hierarchy *traversal/inheritance* is still deferred (RISK-004).
alter table public.organizations add constraint organizations_parent_same_tenant
  foreign key (parent_org_id, tenant_id) references public.organizations (id, tenant_id);

-- license_rules (app_id NOT NULL)
alter table public.license_rules add constraint license_rules_app_same_tenant
  foreign key (app_id, tenant_id) references public.apps (id, tenant_id);

-- license_evaluations (app_id, app_user_id NOT NULL; license_rule_id nullable)
alter table public.license_evaluations add constraint license_evaluations_app_same_tenant
  foreign key (app_id, tenant_id) references public.apps (id, tenant_id);
alter table public.license_evaluations add constraint license_evaluations_app_user_same_tenant
  foreign key (app_user_id, tenant_id) references public.app_users (id, tenant_id);
alter table public.license_evaluations add constraint license_evaluations_rule_same_tenant
  foreign key (license_rule_id, tenant_id) references public.license_rules (id, tenant_id);

-- invoices (file_id, app_id, contract_id all NULLABLE — MATCH SIMPLE keeps nulls valid)
alter table public.invoices add constraint invoices_file_same_tenant
  foreign key (file_id, tenant_id) references public.files (id, tenant_id);
alter table public.invoices add constraint invoices_app_same_tenant
  foreign key (app_id, tenant_id) references public.apps (id, tenant_id);
alter table public.invoices add constraint invoices_contract_same_tenant
  foreign key (contract_id, tenant_id) references public.contracts (id, tenant_id);

commit;
