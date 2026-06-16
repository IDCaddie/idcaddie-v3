# ID Caddie v3 Security Model

## Core principle
Authorization lives in Postgres RLS, not in frontend filtering.

## Tenant boundary
Every customer-owned row has `tenant_id`.
A user can read tenant rows only if they have an active membership in that tenant.

## Roles
- owner: full tenant admin, including billing/security settings.
- admin: full operational admin, except destructive owner-only actions.
- editor: can create/update operational records.
- viewer: read-only.
- org_manager: can manage resources scoped to their organization.
- org_viewer: can read resources scoped to their organization.

## Service-role-only operations
- connector credential writes/reads
- external scrape execution
- license evaluation writes
- import processing state changes
- audit log creation from trusted server paths
- destructive bulk operations

## Required tests
- Tenant A user cannot read Tenant B data.
- Tenant A user cannot update Tenant B data.
- Viewer cannot edit.
- Editor cannot manage members/security settings.
- Org manager can edit only resources assigned to their org.
- Group/org manager access cannot escape to unrelated resources.
- Audit logs cannot be updated/deleted by normal users.
- Files are inaccessible outside tenant.
- Service-role functions do not expose raw credentials to users.

## Legacy findings driving this model
Grounded in [current-security-risk-map.md](./current-security-risk-map.md). Each v3 rule above closes a concrete legacy failure:
- **RLS over frontend filtering** ← legacy authorized via ~198 direct client Firestore calls + `DataProvider.js:47-62` filtering; `list` rules were open to any auth user (`firestore.rules:75,150,176,295`).
- **Exact per-org/per-resource role checks** ← legacy group-manager rule was not group-specific → cross-group edit escalation (`firestore.rules:388-409`, P0).
- **Credentials service-role only + encrypted** ← legacy stored integration secrets in **plaintext** at `IDCApps/{id}/private/scraperCredentials` (`scraperConfigManager.js:122-128`, P0).
- **Append-only audit (DB-enforced)** ← legacy `logs` were append-only by convention only; `scraperLogs` editor-writable/deletable (`firestore.rules:110-113`), Admin-SDK could delete, 90-day hard purge (`cleanupOldLogs.js`).
- **Tenant boundary in Postgres** ← legacy isolation was project-per-tenant (`webapp/.firebaserc`); no in-DB scoping.
- **Re-secure privileged operations** ← several legacy callables shipped with **no auth check** (`sendVerificationEmail`, `syncAppApps`, `calculateFieldValues`, `sendUserInviteEmail`).
- **Hashed tokens, real revocation** ← legacy ingestor/inbound tokens were plaintext / id-as-secret, non-constant-time compare (`handleIngestData.js:42`); API keys/SCIM were already hashed (keep that pattern).
- **Validated, non-destructive imports** ← legacy CSV/API ingest full-replaced and hard-deleted unmatched users with no validation/audit (`onFileLinkedToApp.js:283-290`).

> Org-scoped roles (`org_manager`/`org_viewer`) are **net-new** — no legacy analog. Enforced in `supabase/migrations/0002_org_scoped_rls.sql` + `0003_org_access_union.sql`, verified by `supabase/tests/org_rls_test.sql` (T1–T23, all passing).
>
> **Stewardship vs. read (MVP rule):**
> - **WRITE is single-org/steward:** apps via `responsible_org_id`, contracts via `procurement_org_id` (or a tenant editor+). Being merely paying/procurement-related does **not** grant write.
> - **READ is multi-org/related:** app read = `responsible_org_id` OR `paying_org_id` OR `procurement_owner_org_id`; contract read = `procurement_org_id` OR `paying_org_id`. This keeps chargeback visibility intact under centralized procurement.
> - Every org FK used for read/write is tenant-bound by the `enforce_owning_org_tenant` trigger. `0002` also fixed a pre-existing `0001` tenant-admin→owner self-promotion.
> - Org scoping for child tables remains deferred for `app_users` (tenant-only) and the default-deny tables (`license_*`, `files`, `invoices`, `identity_*`). `app_contracts` is now org-scoped for **read** (`0006`, PR #20 — read a link iff you can read the linked app or contract). A future `resource_org_links` table + org hierarchy may supersede the column-based model. Canonical read map: [02 §8](./02_SECURITY_AND_RLS.md).
