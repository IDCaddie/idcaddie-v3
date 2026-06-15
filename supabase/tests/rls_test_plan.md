# RLS Test Plan

Before building UI, prove these pass against local Supabase.

## Test users
- owner_a: owner in Tenant A
- editor_a: editor in Tenant A
- viewer_a: viewer in Tenant A
- org_manager_a1: manager in Tenant A / Org A1
- owner_b: owner in Tenant B

## Required cases
1. owner_a can read Tenant A apps.
2. owner_a cannot read Tenant B apps.
3. viewer_a can read but cannot update Tenant A apps.
4. editor_a can create/update Tenant A apps.
5. editor_a cannot manage tenant memberships unless policy allows it explicitly.
6. org_manager_a1 can update records assigned to Org A1 only, once scoped org policies are added.
7. org_manager_a1 cannot update records assigned to Org A2.
8. no normal user can update/delete audit_logs.
9. service-role job can write license_evaluations.
10. browser anon/authenticated client cannot read integration secrets.

## Org-scoped policies — IMPLEMENTED in migrations 0002 + 0003

Cases 1–8 plus the org/cross-tenant/escalation matrix are enforced by
`supabase/migrations/0002_org_scoped_rls.sql` and `0003_org_access_union.sql`,
covered by the runnable suite `supabase/tests/org_rls_test.sql` (T1–T23). The suite
has been executed against Postgres 16 with a Supabase-style `auth` shim — all
assertions pass (`ALL ORG-RLS ASSERTIONS PASSED`).

### Access model: stewardship (write) vs. related-org (read)
- **WRITE / steward (single-org):** apps `responsible_org_id`, contracts `procurement_org_id` (or tenant editor+).
- **READ (multi-org, 0003):** app = responsible OR paying OR procurement-owner org; contract = procurement OR paying org. Keeps chargeback visible under centralized procurement.
- Tenant binding on every access org FK via the `enforce_owning_org_tenant` trigger.

Union-read cases (T18–T23): read app via `paying_org_id`; read app via
`procurement_owner_org_id`; read contract via `paying_org_id`; **centralized-procurement**
contract still readable by the paying agency; paying/procurement relation does **not**
grant write; foreign-tenant `paying_org_id` and `procurement_owner_org_id` blocked by the trigger.

Coverage added beyond the original cases:
- Cross-tenant **write** denial for tenant-wide roles (not just read).
- `org_manager` exact-org edit; cross-org / cross-tenant **edit + delete + insert** denial.
- No reassigning a resource into an unmanaged or **foreign-tenant** org (USING/WITH CHECK + integrity trigger).
- The **cross-tenant owning-org leak** found in adversarial review (a tenant member could point `apps.responsible_org_id` / `contracts.procurement_org_id` at a foreign-tenant org) — blocked by `has_org_role_in_tenant` + the `enforce_owning_org_tenant` trigger.
- `org_viewer` read-but-not-edit; org-only user baseline isolation (`tenants`/`organizations`).
- `organization_memberships` read isolation + no self-grant (own org or other org).
- A pre-existing **0001 escalation** (tenant admin self-promoting to `owner` / demoting the owner) — closed by splitting into owner-only vs admin-non-owner membership policies.
- audit_logs append-only verified against `authenticated` (no write policy) **and** `service_role` (BYPASSRLS, blocked by trigger incl. writable-CTE / upsert / MERGE).

Still tenant-scoped (org scoping deferred — see migration header): `app_users`,
`license_rules`, `license_evaluations`, `files`, `invoices`, `app_contracts`.

### Run locally
The committed test assumes a Supabase-style environment (`auth.uid()`, roles
`authenticated`/`service_role`, table grants). For plain Postgres, provide a shim
(create `auth.uid()` reading `request.jwt.claims`, the two roles, and grants),
apply `0001` then `0002`, then run `org_rls_test.sql` with `psql -v ON_ERROR_STOP=1`.
