-- 0023_graph_scale_discovery_indexes.sql
--
-- GRAPH-SCALE DISCOVERY INDEXES (docs/42 §56). Schema-grounded indexes for discovery, app-user/identity
-- matching, tenant-scoped RLS hot paths, and app-graph normalization — landed BEFORE the Okta/Google/
-- Microsoft discovery connectors write high-volume data. This is INDEXES ONLY: no column/schema change, no
-- grant, no policy, no RLS-behavior change, no app-graph write, no canonical vendor/app table.
--
-- SCHEMA-GROUNDED (verified against `0001` core graph tables). Notes that drove the column choices:
--   * graph tables have NO `organization_id`; apps' owning-org columns are procurement_owner_org_id /
--     paying_org_id / responsible_org_id; contracts' are procurement_org_id / paying_org_id;
--   * email columns differ: people.primary_email / app_users.email / identity_accounts.email;
--   * external-id columns differ: app_users.external_user_id / identity_accounts.external_id;
--   * there is NO `identity_account_id` column anywhere — the match graph is app_user → person and
--     identity_account → person (NOT app_user → identity_account), so the match indexes are on person_id;
--   * `app_user_identity_matches` already has UNIQUE(app_user_id, person_id) (leading app_user_id), so we add
--     only the tenant + person_id indexes (no duplicate of that unique coverage).
--
-- Plain (NON-CONCURRENT) CREATE INDEX: the graph tables are currently near-empty and this lands before
-- discovery volume, so a normal transactional create is correct here. NOTE: if these indexes are ever
-- DEFERRED until AFTER discovery data has loaded, a future index migration MUST use `CREATE INDEX
-- CONCURRENTLY` (which CANNOT run inside a transaction block) to avoid long write locks (docs/42 §56).
--
-- Migration-safety: CREATE INDEX only — no table teardown, no row purge, no RLS disable, no grant, no policy.

begin;

-- tenant_memberships — the RLS membership hot path (who-can-see-which-tenant).
create index tenant_memberships_user_tenant_status_idx on public.tenant_memberships (user_id, tenant_id, status);

-- app_users — high-volume discovery target (one row per discovered SaaS app user).
create index app_users_tenant_app_idx        on public.app_users (tenant_id, app_id);
create index app_users_email_lower_idx        on public.app_users (lower(email));
create index app_users_external_user_id_idx   on public.app_users (external_user_id);
create index app_users_tenant_status_idx      on public.app_users (tenant_id, status);

-- identity_accounts — identity-source rows (link to person via person_id).
create index identity_accounts_tenant_idx          on public.identity_accounts (tenant_id);
create index identity_accounts_person_idx          on public.identity_accounts (person_id);
create index identity_accounts_email_lower_idx     on public.identity_accounts (lower(email));
create index identity_accounts_external_id_idx     on public.identity_accounts (external_id);
create index identity_accounts_tenant_provider_idx on public.identity_accounts (tenant_id, provider);

-- people — the normalized person records discovery matches against.
create index people_tenant_idx                  on public.people (tenant_id);
create index people_primary_email_lower_idx     on public.people (lower(primary_email));
create index people_tenant_employee_status_idx  on public.people (tenant_id, employee_status);

-- app_user_identity_matches — the app_user → person match graph (person_id lookups; tenant scoping).
-- UNIQUE(app_user_id, person_id) already exists, so app_user_id lookups are covered by its leading column.
create index app_user_identity_matches_tenant_idx on public.app_user_identity_matches (tenant_id);
create index app_user_identity_matches_person_idx on public.app_user_identity_matches (person_id);

-- apps — app graph + vendor/name normalization (case-insensitive) + owning-org joins.
create index apps_tenant_status_idx          on public.apps (tenant_id, status);
create index apps_vendor_name_lower_idx       on public.apps (lower(vendor_name));
create index apps_name_lower_idx              on public.apps (lower(name));
create index apps_procurement_owner_org_idx   on public.apps (procurement_owner_org_id);
create index apps_paying_org_idx              on public.apps (paying_org_id);
create index apps_responsible_org_idx         on public.apps (responsible_org_id);

-- contracts — status, vendor normalization, renewals, owning-org joins.
create index contracts_tenant_status_idx     on public.contracts (tenant_id, status);
create index contracts_vendor_name_lower_idx  on public.contracts (lower(vendor_name));
create index contracts_renewal_date_idx       on public.contracts (renewal_date);
create index contracts_procurement_org_idx    on public.contracts (procurement_org_id);
create index contracts_paying_org_idx         on public.contracts (paying_org_id);

-- invoices — tenant/app/contract joins + date range.
create index invoices_tenant_idx              on public.invoices (tenant_id);
create index invoices_app_idx                 on public.invoices (app_id);
create index invoices_contract_idx            on public.invoices (contract_id);
create index invoices_tenant_invoice_date_idx on public.invoices (tenant_id, invoice_date);

-- app_contracts — the contract-side lookup (the composite PK leads with app_id).
create index app_contracts_contract_idx on public.app_contracts (contract_id);

-- license_evaluations — per app / app_user / tenant rollups.
create index license_evaluations_tenant_idx   on public.license_evaluations (tenant_id);
create index license_evaluations_app_user_idx  on public.license_evaluations (app_user_id);
create index license_evaluations_app_idx        on public.license_evaluations (app_id);

-- license_rules — active rules per app / tenant.
create index license_rules_tenant_idx     on public.license_rules (tenant_id);
create index license_rules_app_active_idx  on public.license_rules (app_id, active);

commit;
