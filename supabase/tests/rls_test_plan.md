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

## Org-scoped policies — IMPLEMENTED in migrations 0002 + 0003 (+ 0004 delete-hardening)

Cases 1–8 plus the org/cross-tenant/escalation matrix are enforced by
`supabase/migrations/0002_org_scoped_rls.sql` and `0003_org_access_union.sql`,
covered by the runnable suite `supabase/tests/org_rls_test.sql` (T1–T29, 136 assertions). The
suite has been executed against Postgres 16 with a Supabase-style `auth` shim — all
assertions pass (`ALL ORG-RLS ASSERTIONS PASSED`).

**Destructive-delete hardening (T17/T24/T25, migration `0004`):** core evidence tables
(`organizations`/`apps`/`contracts`/`app_contracts`/`people`/`app_users`) have **no `DELETE`
policy** — `FOR ALL` manage policies were split into `INSERT`+`UPDATE`. T17 = org-manager delete
denied; T24 = owner/admin/editor delete denied (editor `UPDATE` still works, rows survive);
T25 = `/apps` + `/apps/[id]` reads still valid.

**Same-tenant child integrity (T26, migration `0005`):** composite `(parent_ref, tenant_id) →
parent(id, tenant_id)` FKs on `app_contracts`/`app_users`/`app_user_identity_matches`/`identity_accounts`/`license_rules`/
`license_evaluations`/`invoices`. T26 = 11 cross-tenant link inserts each rejected with
`foreign_key_violation`; valid same-tenant links + nullable (MATCH SIMPLE) links still insert.
This is write-integrity only — org-scoped child-table reads remain deferred (RISK-002).

**Child-table read-scope truth pass (T27, PR #18 — docs/tests only, no migration):** asserts the
*current* read reality without broadening it. The 6 **default-deny** tables (`identity_accounts`,
`app_user_identity_matches`, `license_rules`, `license_evaluations`, `files`, `invoices`) return 0
rows even to a tenant **owner** (despite seeded rows). The **tenant-only** table `people` is readable
by tenant members but returns 0 rows to an **org-only** user. Positive controls (owner reads tenant
rows; org-only user reads its own-org app) prove the zeros are policy, not empty tables.
(`app_contracts` and `app_users` were tenant-only when T27 was written in PR #18; they have since become
org-scoped read in `0006`/`0007` and T27 was updated accordingly — see T28/T29.) Canonical read map:
[docs/02 §8](../../docs/02_SECURITY_AND_RLS.md).

**Org-scoped read for `app_contracts` (T28, migration `0006`, PR #20):** `app_contracts` gains ONE
org-scoped `SELECT` policy — an org-only user may read a link row iff they can already read the linked
**app OR contract** under related-org RLS (the `EXISTS` subqueries reuse `apps`/`contracts` RLS;
`0005` keeps it tenant-bound). T28 proves: tenant owner reads all tenant links; org-only users read
only links tied to apps/contracts they can read (app-side **and** contract-side branches); cross-tenant
(`owner_b`) and a pure non-member (`nobody`) read 0; and the default-deny/tenant-only tables still read
0 for an org-only user (no broadening leaked). Read-only — no `DELETE` policy added.

**Org-scoped read for `app_users` (T29, migration `0007`, PR #21):** `app_users` gains ONE org-scoped
`SELECT` policy — an org-only user may read an app-user row iff they can already read the linked **app**
(the `EXISTS (select 1 from apps ...)` reuses `apps` RLS; `0005` keeps it tenant-bound). T29 proves:
tenant owner reads all tenant app_users; `mgr_a1` reads only App A1's users; `mgr_a2` reads App A-pay
(responsible) + App A2; `agency_u` reads only App A-pay (paying); `owner_b` reads only its own tenant-B
user (0 tenant-A); `nobody` reads 0; an org-only delete is denied (no `DELETE` policy — row survives);
and `people`/`identity_accounts`/`app_user_identity_matches`/`license_*`/`invoices`/`files` still read 0
for an org-only user. The `0007` policy pins `a.tenant_id = app_users.tenant_id` explicitly (defense in
depth, mirroring `0003`); **T29h** plants a normally-impossible FK-bypassed corrupt cross-tenant row
(`session_replication_role=replica`) and proves an org-only user who can read the parent app still
cannot read it. Read-only — no identity matching / license eval / provisioning.

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

Not org-scoped for reads (RISK-002, narrowed by PR #20/#21; reality pinned by T27/T28/T29, canonical map [docs/02 §8](../../docs/02_SECURITY_AND_RLS.md)):
**tenant-only** (tenant members read, org-only users do not) — `people`;
**default-deny** (no read policy at all) — `identity_accounts`, `app_user_identity_matches`,
`license_rules`, `license_evaluations`, `files`, `invoices`.
`app_contracts` (`0006`) and `app_users` (`0007`) are now **org-scoped for read** — no longer in this list.

### Run locally

```bash
bash scripts/test-rls.sh
```

That script (the same one CI runs — `.github/workflows/rls-tests.yml`) spins up a
throwaway `postgres:16` container, installs a Supabase-style `auth` shim
(`auth.uid()` + the `authenticated`/`service_role` roles hosted Supabase provides),
applies every `supabase/migrations/*.sql` in order, applies the test-role grants,
then runs every `supabase/tests/*_test.sql` with `ON_ERROR_STOP=1`. Any failed
assertion fails the run (non-zero exit); the container is removed even on failure.
Requires Docker. It never touches hosted Supabase and uses no service-role keys.

New test files are picked up automatically as long as they are named `*_test.sql`.
