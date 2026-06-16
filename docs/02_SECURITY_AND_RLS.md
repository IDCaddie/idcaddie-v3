# 02 · Security Model & RLS

**Canonical source for: the authorization model.** Every other doc links here instead of
re-explaining RLS. Implemented in `supabase/migrations/0002_org_scoped_rls.sql`,
`0003_org_access_union.sql`, and `0004_destructive_delete_hardening.sql`; proven by
`supabase/tests/org_rls_test.sql` (83 assertions, T1–T26, `verified-local`, `ci-enforced` via
PR #2). Schema: [v3-data-model.md](./v3-data-model.md).
Design rationale & legacy evidence: [v3-security-model.md](./v3-security-model.md),
[current-security-risk-map.md](./current-security-risk-map.md).

> **Core principle:** authorization lives in Postgres RLS. The app runs queries *as the
> authenticated user* and never decides or filters access for security.

## 1. Tenant isolation — the hard wall
Every tenant-owned row has `tenant_id`. RLS keys on membership, via SECURITY DEFINER
helpers (they read membership tables bypassing those tables' own RLS, avoiding recursion):
- `is_tenant_member(tenant_id)` — active row in `tenant_memberships`.
- `has_tenant_role(tenant_id, roles[])` — active membership with one of `roles`.

No row is visible or writable outside its tenant. Tenancy is **not** per-project (legacy)
and **not** client-supplied — it derives from membership rows.

## 2. Roles
- **Tenant-wide** (`tenant_memberships.role`): `owner` ⊃ `admin` ⊃ `editor` ⊃ `viewer`.
  Tenant-wide roles read all rows in their tenant; `editor`+ write.
- **Org-scoped** (`organization_memberships.role`): `manager` (write within org) or
  `viewer` (read within org). An org-only user has *no* tenant membership and sees only
  their org's resources. Helpers: `is_org_member`, `has_org_role`,
  `has_org_role_in_tenant(org, tenant, roles[])` (the last also binds the org to the
  row's tenant — see §5).

## 3. Read vs write split (the key design choice)
**Writes are single-org (steward); reads are multi-org (related).**

| Resource | READ (org-scoped user) | WRITE / manage (org-scoped user) |
|---|---|---|
| `apps` | member of `responsible_org_id` **OR** `paying_org_id` **OR** `procurement_owner_org_id` (tenant-bound) | manager of `responsible_org_id` only |
| `contracts` | member of `procurement_org_id` **OR** `paying_org_id` (tenant-bound) | manager of `procurement_org_id` only |

Tenant `editor`+ can also write; tenant `viewer`+ can also read (tenant-wide). Being
merely paying/procurement-related grants **read, never write**.

**Why:** in a holding company (Omnicom) procurement is often centralized. If access keyed
on a single owning column, the agency that *pays* for an app/contract couldn't see it —
breaking chargeback. So read follows any related org; only the accountable steward edits.
*Centralized-procurement example:* a contract procured by "Central Procurement" but paid
by agency A3 is readable by A3 (via `paying_org_id`) though A3 isn't the procurement org
(test T20).

## 4. Audit immutability
`audit_logs` is append-only, enforced two ways: (a) no `UPDATE`/`DELETE` RLS policy for
normal roles, and (b) a `BEFORE UPDATE OR DELETE` trigger `audit_logs_no_mutation`
(function `reject_audit_mutation`) that raises unconditionally for **every** role —
including `BYPASSRLS` `service_role` — covering plain
DML, writable CTEs, upserts, and `MERGE`. Inserts come only from trusted server paths
(service-role / SECURITY DEFINER). Deletes are blocked even for retention (see gap below).

## 4b. No hard-delete of core evidence (destructive-delete hardening)
`0004` removes normal authenticated **hard-delete** from the core business/evidence tables —
`organizations`, `apps`, `contracts`, `app_contracts`, `people`, `app_users`. `0001`/`0002` had
broad `FOR ALL` manage policies that silently granted `DELETE`; `0004` drops them and recreates
explicit `INSERT` + `UPDATE` policies with the **same** `USING`/`WITH CHECK` (so editors and org
stewards keep create/edit), but **no `DELETE` policy** — so a `DELETE` affects 0 rows for every
`authenticated` role. Reads (tenant + org-union) are untouched, so `/apps` and `/apps/[id]` are
unaffected. `tenant_memberships`/`organization_memberships` keep delete (removing a member is normal,
reversible access admin, not evidence destruction). The remaining core tables (`identity_accounts`,
`app_user_identity_matches`, `license_rules`, `license_evaluations`, `files`, `invoices`) have RLS
enabled but no policy = default-deny already (their future write policies must likewise omit `DELETE`).
Hard delete, if ever needed, belongs in an audited admin/service break-glass path — **archive /
soft-delete UI is not built** (deferred; tracked in [04](./04_RISK_REGISTER.md), [06](./06_BUILD_SEQUENCE.md)).

## 5. Cross-tenant integrity trigger
Because access reads trust the owning-org columns, those columns must never point at
another tenant's org. `enforce_owning_org_tenant` (`BEFORE INSERT/UPDATE`) rejects any
access-relevant org FK whose organization is in a different tenant — for `apps`
(`responsible_org_id`, `paying_org_id`, `procurement_owner_org_id`) and `contracts`
(`procurement_org_id`, `paying_org_id`). This closes the cross-tenant org-pointer leak
(see §7) at the data layer, in addition to the tenant binding inside the read policies.

## 5b. Same-tenant child integrity (relational, not RLS)
`0005` enforces that a child/link row cannot reference a parent row in a **different tenant** —
at the constraint layer, so a corrupt write *fails* rather than just being hidden by RLS. Each
referenced parent gets a `UNIQUE (id, tenant_id)`, and each child gets a composite FK
`(parent_ref, tenant_id) → parent(id, tenant_id)`, so the parent must live in the child's tenant:
`app_contracts → apps, contracts`; `app_users → apps`; `app_user_identity_matches → app_users, people`; `identity_accounts → people`;
`organizations → organizations` (self, `parent_org_id`); `license_rules → apps`;
`license_evaluations → apps, app_users, license_rules`; `invoices → files, apps, contracts`.
`MATCH SIMPLE` (default) keeps nullable links (invoices
`file_id`/`app_id`/`contract_id`, `license_evaluations.license_rule_id`) valid when null;
`ON DELETE NO ACTION` adds **no** new cascade (so `0004`'s hard-delete protection is unaffected).
This is **write integrity only** — it does **not** add org-scoped *read* policies for those child
tables (still deferred — RISK-002), and the `organizations` self-FK only keeps `parent_org_id`
in-tenant; org-hierarchy *traversal/inheritance* stays deferred (RISK-004). Proven by T26.

## 6. Tenant-admin self-promotion blocked
`0001`'s membership policy gated only on the actor's role, letting an `admin` set their
own row to `owner` or demote the owner (tenant takeover). `0002` splits it: **owners**
manage all membership rows; **admins** manage only non-`owner` rows and cannot write
`role='owner'`.

## 7. Threat scenarios → enforcement → test coverage
| # | Threat | Expected | Enforced by | Test |
|---|--------|----------|-------------|------|
| 1 | Tenant A user reads Tenant B rows | 0 rows | `is_tenant_member` / tenant-bound policies | T1 |
| 2 | Tenant **viewer** mutates a row | denied | no write policy for `viewer` | T2 |
| 3 | Org manager edits a **sibling org**'s resource | denied | `has_org_role_in_tenant` exact-org | T4 |
| 4 | Org manager reassigns/escalates to another org | denied (`WITH CHECK`/check_violation) | manage `WITH CHECK` + trigger | T3+4 |
| 5 | **Paying** org member tries to **write** | read ok, write denied | steward-only write policy | T21 |
| 6 | Org **viewer** edits its own org's resource | read ok, write denied | manager-only write | T5 |
| 7 | Cross-tenant org-pointer planted, then foreign-org member reads | plant errors; read 0 rows | `enforce_owning_org_tenant` + tenant-bound read | T7, T22+23 |
| 8 | Tenant **admin** self-promotes to `owner` / demotes owner | denied | split owner/admin membership policies | T16 |
| 9 | Normal user updates/deletes an audit log | denied | no policy + trigger | T6 |
| 10 | `service_role` mutates an audit log | denied | trigger (BYPASSRLS-proof) | T6 |
| 11 | Org-only user enumerates other tenants/sibling orgs | 0 rows | `is_org_member` / `is_tenant_participant` | T11, T13 |
| 12 | Related-org (paying/procurement) **read** works | rows returned | `0003` union read | T18, T19, T20 |
| 13 | Cross-tenant **write** by a tenant-wide role | denied | tenant policy `WITH CHECK` | T14 |
| 14 | Org manager hard-deletes its own-org app | denied (0 rows) | no `DELETE` policy (`0004`) | T17 |
| 15 | Tenant **owner/admin/editor** hard-deletes a core evidence row | denied (0 rows); row survives; editor `UPDATE` still works | no `DELETE` policy (`0004`) | T24 |
| 16 | App inventory/detail reads still valid after hardening | rows returned | SELECT policies untouched | T25 |
| 17 | Child/link row references a parent in **another tenant** | write fails (foreign_key_violation); valid same-tenant + nullable links still insert | composite same-tenant FKs (`0005`) | T26 |

Test labels map to the `-- Test N` blocks in `org_rls_test.sql` (26 scenarios; T3+4 and
T22+23 are combined blocks).

## 8. Deferred / known gaps (open in [04_RISK_REGISTER.md](./04_RISK_REGISTER.md))
- **Child tables tenant-scoped, not org-scoped:** `app_users`, `files`, `invoices`,
  `license_rules`, `license_evaluations`, `app_contracts` enforce `tenant_id` but not
  per-org reads. Safe (no cross-tenant leak) but an org-only user may see tenant-wide
  child rows. Org-scope them when a feature reads them per-org. (RISK-002)
- **Audit retention unresolved:** deletes are blocked, so there is no purge/archival path
  yet; `audit_logs` grows unbounded. Needs a partition/archival design. (RISK-009)
- **`resource_org_links` + org hierarchy deferred:** today access is column-based and
  org membership is flat (no parent→child inheritance). (RISK-003/004)
- **Nothing hosted-applied:** the model is proven on a local Postgres shim, not Supabase. (RISK-001)

## 9. Non-negotiables for any future change
- New tenant-owned table ⇒ `tenant_id NOT NULL` + RLS keyed on `is_tenant_member`.
- New access-relevant org FK ⇒ add it to `enforce_owning_org_tenant` (tenant-bound) **and** a test.
- **No `FOR ALL` (or `FOR DELETE`) policy on a core evidence table** (`organizations`, `apps`, `contracts`, `app_contracts`, `people`, `app_users`, …) — it silently grants hard-delete. Write policies are `INSERT` + `UPDATE` only until an audited admin/archive path exists (`0004`, §4b).
- **New tenant-scoped child/link table** ⇒ give referenced parents `UNIQUE (id, tenant_id)` and the child a composite FK `(parent_ref, tenant_id) → parent(id, tenant_id)` so cross-tenant references fail at the constraint layer (`0005`, §5b) — RLS alone only hides them, it doesn't prevent the write.
- Never weaken RLS, never filter for security in the client, never use the service-role
  key in a request path. Reviewer enforcement: [07_P0_REVIEW_CHECKLIST.md](./07_P0_REVIEW_CHECKLIST.md).
