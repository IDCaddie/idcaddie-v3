# 11 · Legacy Capability Map & OMC Parity Checklist

**Canonical source for: what v3 must preserve from the legacy Firebase app before moving the
paying client off it, and the go/no-go to cut over.** This is a product-control doc — it tracks
*parity*, not implementation detail. Deep legacy evidence (routes, collections, functions, with
exact file paths and KEEP/REDESIGN/DEFER dispositions) lives in
[current-product-map.md](./current-product-map.md) and [current-security-risk-map.md](./current-security-risk-map.md);
this doc links there rather than restating it. v3 status is per [00_PRODUCT_STATUS](./00_PRODUCT_STATUS.md).

> Evidence is cited from the legacy repo `/Users/samvemuri/Desktop/IDCaddie_Repo-main` (paths
> relative to it) and from this repo. Claims that could not be verified from code/docs are marked
> **needs-verification** — not asserted from memory.

## 1. Executive summary
**The paying client is Flywheel Digital (an Omnicom agency).** The legacy app is deployed
per-customer as separate Firebase projects (`webapp/.firebaserc`: `flywheeldigital-cb222`,
`idcaddiecorporate`, …) — isolation is "one project per customer", not row-level. v3 replaces this
with a single multi-tenant Postgres + RLS.

- **Preserve (the reason OMC pays):** the app inventory + ownership/paying/procurement orgs,
  contracts with renewal tracking, app↔contract linking, people / app-user identity matching, the
  **unmanaged-account** and **stale-user** reports, license utilization/waste, and spend/chargeback —
  all tenant-scoped and exportable.
- **Intentionally improve:** authorization moves from client-side `AuthGuard` + per-project isolation
  to **Postgres RLS** (row-level, tested); audit logs become **append-only/tamper-evident** (legacy
  `logs` are mutable and purged at 90 days via `cleanupOldLogs.js`); imports become **non-destructive**
  (legacy deletes "outdated" users — `webapp/functions/src/files/onFileLinkedToApp.js:290`); scraper
  credentials move from **plaintext** Firestore (`IDCApps/{id}/private/*`) to an encrypted,
  service-role-only store; several callables that ship today **with no auth check** get re-secured.
- **Do not cut over until complete:** see the [cutover rule](#4-cutover-rule). OMC stays on Firebase
  until every P0/P1 parity item is implemented, verified, and signed off.

## 2. Capability inventory
Status values: `not-started` · `in-progress` · `implemented` · `verified` · `needs-verification`.
"v3 status" reflects the foundation (schema/RLS/auth/data layer) **plus the product surfaces that now
ship** (apps, app detail, contracts, contract detail, linked panels, app-user roster, match status,
account summary — RLS-scoped, read-only) **plus the first write workflow: contract create/edit**
(`/contracts/new`, `/contracts/[id]/edit` — PR #31, RLS-gated, audited, **Partial** legacy parity).
**No contract delete/archive, no link/unlink, no files/AI, no UAR, no matching algorithm, no
imports/exports, no license/spend, no hosted apply.** Cutover remains **blocked** (§4).

> **This table is the capability *scorecard*.** The finer-grained, per-workflow **UX parity contract**
> (legacy fields/buttons/filters/exports → v3, with the `needs legacy inspection` unknowns and the
> "same product, better backend / no user-visible regression" rule) is
> [14_LEGACY_UX_WORKFLOW_PARITY_MAP](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md). Cutover is gated on **workflow
> parity there**, not on this scorecard or RLS readiness alone.

| Area | Legacy Firebase capability | Evidence (legacy paths) | v3 status today | Required v3 PR/stage | Parity target | Security improvement in v3 | Status |
|---|---|---|---|---|---|---|---|
| Authentication / login | Firebase Auth email/pw + SAML + OIDC; client-side `AuthGuard` | `frontend-v2/src/app/login/page.tsx`, `services/samlAuth.ts`, `services/oidcAuth.ts`, `components/AuthGuard.tsx` | email/pw skeleton + server session (Proxy) | done (PR #6); SSO = Stage ≥12 | email/pw at launch; SSO follows | server-side session + RLS, not client guard | `in-progress` |
| Tenant / company / org model | "Groups" + one Firebase project per customer; custom claims | `company/groups/`, `webapp/.firebaserc`, `permissionSync.js` | tenants + organizations + memberships + RLS; context resolved | done (PR #1/#9) | one tenant = one OMC org tree | row-level isolation (177 RLS assertions, T1–T32) vs per-project | `verified` |
| App inventory | List apps w/ cost, license util, user metrics, CSV export | `frontend-v2/src/app/(authenticated)/IDCApps/page.tsx` | `/apps` screen (PR #13) — read-only list (name/vendor/category/status) via typed DAL; **no cost/license/user metrics or CSV yet** | Stage 4 ✅; metrics/export later | OMC sees the same inventory | RLS-scoped reads, no client filtering (verified: org-only user sees only related apps) | `implemented` (read-only list only) |
| App detail | App metadata, user roster, linked contracts/invoices, license rules | `IDCApps/[id]/page.tsx` | `/apps/[id]` (PR #14) — read-only metadata (name/vendor/category/status/timestamps + owning-org **IDs**); **no roster/contracts/invoices/files/license rules; org names + edit deferred** | Stage 4b ✅; child surfaces later | per-app drill-down | RLS-scoped; route id is lookup-only, not authz (verified) | `implemented` (metadata only) |
| Contracts | List/detail/create/edit; renewal & expiry dates; gantt | `contracts/page.tsx`, `contracts/[id]/`, `contracts/create/`, `contracts/gantt/` | `/contracts` + `/contracts/[id]` read-only (PR #19) **+ create/edit** `/contracts/new` + `/contracts/[id]/edit` (PR #31) on the RLS-gated #30 write path, audited (`0010`). Write authority `0004` (procurement-steward / tenant-editor); `tenant_id` server-resolved. **Partial parity** — supported v3 columns only; legacy `category`/`procurementDate`/`notes`/`poNumber`/`autoRenew`/`monthToMonth`/`commodity_*`/`validated` + PDF/AI + **gantt** have no v3 column/surface ([15](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)). No delete/archive/link/files | Stage 5 | OMC sees + can edit contracts | RLS related-org read + steward/editor write (verified); `paying_org_id` read-only | `partial` (read-only list + detail; create/edit **Partial parity**; gantt/delete/links `not-started`) |
| App–contract linking | `linkedDocs.IDCApps` cross-refs, cost allocation % | `contracts/[id]/page.tsx`, `IDCApps/[id]/page.tsx` | `app_contracts` table + RLS | Stage 5 | linked apps↔contracts | **read-only linked panels (PR #20)** — `0006` org-scoped read; shows only links to apps/contracts you may read; **no link/unlink, no cost-allocation %** | `partial` (read-only view; linking + cost % `not-started`) |
| People / users | Unified `people` directory (IdP + app-only), drill to accounts | `people/page.tsx`, `webapp/functions/.../rebuildPeopleCollection.js` | `people` table + RLS | Stage 6 | people directory | RLS; tenant-scoped | `not-started` |
| Identity accounts | IdP identities (SCIM/scrapers), `idp.*` source | `people/settings/page.tsx`, `syncIdpAssignments.js` | `identity_accounts` table (**default-deny today** — no read policy) | Stage 6 | identity source-of-record | RLS-on, default-deny; needs a read policy before surfacing (RISK-002) | `not-started` |
| App users | Per-app account roster `IDCApps/{id}/users` | `IDCApps/[id]/page.tsx` (users table) | **read-only roster on `/apps/[id]` (PR #21)** — `0007` org-scoped read; direct `app_users` columns only | Stage 6a | per-app accounts | RLS org-scoped read (`0007`, T29); **no matching/provisioning/utilization** | `partial` (read-only roster; matching/UAR/stale/provisioning `not-started`) |
| Identity→app-user matching | Email/local-part match, IdP-priority merge | `watchUserUpdated.js`, `syncIdpAssignments.js`, `shared/identityStatus.js` | `app_user_identity_matches` table — **org-scoped READ (PR #23, `0008`)** | Stage 6c | accurate matched/unmatched | **read-only matched/unmatched STATUS shown** ([12](./12_IDENTITY_MATCHING_READ_SCOPE.md), T30) — RLS org-scoped, no PII; **the matching algorithm + merge are NOT built** (server-side, future) | `partial` (read-only status; matching algorithm / merge `not-started`) |
| Unmanaged accounts report (UAR) | Orphaned/managed/unknown per app; orphaned spend; critical-risk (IdP-deactivated still provisioned) | `IDCApps/insights/uar/page.tsx`, `utils/appMetrics.ts` (`resolveUAR`) | derivable from `app_users`+matches | Stage 6–7 | OMC identifies unmanaged accounts | RLS-scoped **from the app side** ([12 §4](./12_IDENTITY_MATCHING_READ_SCOPE.md)); managed/orphaned via a definer status view, never tenant-wide `people`/`identity` reads | `not-started` (a **non-UAR** read-only matched/unmatched + stale-candidate **count summary** exists — PR #24; **no orphaned/managed/deactivated status**) |
| Stale users report | Per-app data freshness, days-since-update, thresholds | `IDCApps/insights/stale/page.tsx` | derivable from `app_users` | Stage 6–7 | OMC identifies stale users | RLS-scoped | `not-started` (a read-only **stale-candidate count** from direct `app_users.last_active_at` >90d exists — PR #24; not a confirmed-stale report) |
| License rules / evaluations | Per-app seat rules (fixed/elastic), ELU/waste | `IDCApps/[id]/components/LicenseRulesConfig.tsx`, `utils/licenseEvaluation.ts`, `licenses/evaluateUserLicenses.js` | `license_rules` + `license_evaluations` tables (**default-deny today** — no read policy) | Stage 7 | license utilization/waste | RLS-on, default-deny; evaluated server-side; needs a read policy before surfacing (RISK-002) | `not-started` |
| Spend / chargeback | Invoice link % allocation, monthly billing snapshot, cost reports | `billing/calculateMonthlyBilling.js`, `reports/cost-snapshot/`, `reports/it-spend/`, `invoices/` | `invoices` table (**default-deny today** — no read policy); related-org read union proven for `apps`/`contracts` | Stage 8 | chargeback by org | related-org read model `verified` for apps/contracts; **`invoices` needs its own read policy** before any chargeback surface (RISK-002, [02 §8](./02_SECURITY_AND_RLS.md)) | `not-started` |
| Imports | CSV/email/API ingest → app users; **deletes outdated users** | `webapp/functions/src/files/onFileLinkedToApp.js:290`, `files/inbound/page.tsx` | none | Stage 11 | **non-destructive** (preview + soft-delete + audit) | no blind delete; upsert + audit (RISK-008) | `not-started` |
| Exports | CSV per list/report; scheduled email reports (token-gated) | `utils/downloadFile.ts`, `reports/schedules/`, `scheduledJobs/generateReportRuns.js` | none | Stage 10 | **tenant-scoped** exports, no secrets | scoped query + audit | `not-started` |
| Audit / history | `onWrite` triggers → `logs`; before/after diff viewer; 90-day purge | `webapp/functions/src/logging/*`, `logging/page.tsx`, `cleanupOldLogs.js` | `audit_logs` table — **append-only** (trigger blocks update/delete) | Stage 9 (UI) | read-only audit viewer | append-only/tamper-evident, no purge | `verified` (table); UI `not-started` |
| Admin / settings | Company profile, domain allowlist, API keys, recompute | `admin/company/`, `admin/recompute/` | none | Stage ≥9 | admin surface | RLS; hashed API keys | `not-started` |
| Connectors / integrations | 53+ OAuth scrapers (Okta/Google/Slack/Salesforce…), SCIM | `webapp/functions/src/appScraping/scrapers/*`, `scim/index.js` | none | Stage 12 | connector(s) behind vault | encrypted creds, service-role-only (RISK-007) | `not-started` |
| Contract upload / storage | Firebase Storage `/files/{id}` + metadata | `webapp/functions/src/storage/*`, `files/page.tsx` | none (Supabase Storage deferred) | Stage 8 | tenant-scoped file storage | scoped storage policies | `not-started` |
| AI contract ingestion / extraction | Google Document AI (contract/invoice processors) + Vertex AI/Gemini fallback | `webapp/functions/src/storage/processFileWithAI.js`, `handleDocumentAICompletion.js` | none | Stage ≥12 (deferred) | extract renewal/cost fields | provider boundary; no secrets in app tables | `not-started` |
| Vendor/app enrichment scraper | Chrome extension: page email detection (SHA-256 hashed) → Firestore | `extension/content.js`, `extension/auth.js` | none | deferred / maybe-DELETE | optional enrichment | n/a (deferred; privacy review first) | `not-started` |

## 3. OMC / Omnicom paid-client acceptance checklist
Practical go/no-go. **Still NO for cutover today.** Several **read-only** surfaces now ship — app
inventory + detail (PR #13/#14), contracts list + detail (PR #19), linked app↔contract panels (PR #20),
app-user roster (PR #21), match status (PR #23), account summary (PR #24) — but **writes, UAR, matching
algorithm, license/spend, imports/exports, reports, and any hosted deployment are still missing**, so
acceptance is **not** close. OMC cutover and new paid-customer onboarding remain **blocked** (§4).

| # | Question | Today | Gated by |
|---|----------|-------|----------|
| 1 | Can OMC see the same app inventory? | **Partial** — read-only list + detail (incl. app-user roster, match status, account summary) shipped (PR #13/#14/#21/#23/#24); cost/license/user metrics + CSV export still missing | Stage 4 ✅ (read-only); metrics/export later |
| 2 | Can OMC see ownership / paying / procurement orgs? | **Partial** — owning-org **IDs** surfaced on `/apps/[id]` + `/contracts/[id]` (PR #14/#19); org **names** + drill-down deferred | Stage 4–5 (org-name enrichment) |
| 3 | Can OMC see contracts and renewal dates? | **Partial** — read-only list + detail with renewal/start/end dates (PR #19) **+ create/edit UI** (PR #31, RLS-gated, audited); still **Partial parity** — legacy `category`/`procurementDate`/`notes`/`poNumber`/`autoRenew`/`monthToMonth`/PDF-AI/gantt/delete missing ([15](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)) | Stage 5 — read + create/edit shipped; parity gaps + gantt later |
| 4 | Can OMC identify unmanaged accounts? | **No** | Stage 6–7 (UAR) |
| 5 | Can OMC identify stale users? | **No** | Stage 6–7 |
| 6 | Can OMC import / update app-user data? | **No** | Stage 11 (non-destructive import) |
| 7 | Can OMC export scoped reports? | **No** | Stage 10 (tenant-scoped export) |
| 8 | Can OMC trust the data is tenant-isolated? | **Yes** | RLS `verified` (PR #1/#9) — the foundation that makes the rest safe |
| 9 | Can OMC keep using the old Firebase app until v3 is ready? | **Yes** | Legacy Firebase is `legacy-production` — unchanged by v3 |

## 4. Cutover rule
**Hard rule: do not move OMC/Flywheel from Firebase to v3 until every P0 and P1 parity item below
is `implemented`, `verified`, and signed off** (by the product owner + a security reviewer). Until
then, legacy Firebase remains production and v3 ships incrementally behind it. Partial parity is not
a cutover; a half-migrated OMC is worse than no migration.

## 5. Gap list
- **P0 (cutover blockers — core of why OMC pays):** app inventory (#1,2) · contracts + renewal dates
  (#3) · app↔contract linking · people / app-user matching · unmanaged-account report (#4) · stale-user
  report (#5) · non-destructive import (#6) · tenant-scoped export (#7) · read-only audit viewer ·
  license utilization · spend/chargeback. *(Tenant isolation #8 is already `verified`.)*
- **P1 (needed for an enterprise paid client, can follow with sign-off):** SSO (SAML/OIDC) · SCIM
  provisioning · admin/settings (domain allowlist, API keys) · automated identity matching · safe
  write surfaces (steward-only, audited).
- **P2 (nice-to-have improvements):** dashboards/widgets · scheduled email reports · contract gantt ·
  AI contract ingestion (Document AI/LLM) · connector scrapers · cost-trend snapshots.
- **Deferred / future:** Chrome enrichment extension (privacy review first) · org-hierarchy
  inheritance + `resource_org_links` (RISK-003/004) · subscription billing of IdP users.

## 6. Updated roadmap (next PRs to parity)
Each stage closes specific parity items; sequence per [06_BUILD_SEQUENCE](./06_BUILD_SEQUENCE.md).

| Next PR / stage | Closes parity for | OMC checklist |
|---|---|---|
| Read-only app inventory (Stage 4) | app inventory; owning-org fields | #1, #2 |
| App detail (Stage 4–5) | app detail / roster | #1, #2 |
| Contracts (Stage 5) | contracts + renewal dates; app↔contract linking | #3 |
| People / app users (Stage 6) | people, identity accounts, app users, matching | #4, #5 (data) |
| Unmanaged-accounts report (Stage 6–7) | UAR | #4 |
| Stale-users report (Stage 6–7) | stale | #5 |
| License + spend/chargeback (Stage 7–8) | license eval; chargeback | (#2 cost) |
| Exports (Stage 10) | tenant-scoped reports | #7 |
| Imports (Stage 11) | **non-destructive** app-user import | #6 |
| Audit viewer (Stage 9) | read-only audit | — |
| Safe writes (across stages) | steward-only edits, audited | — |
| Storage (Stage 8) | contract upload | (#3 docs) |
| AI contract ingestion (≥12, deferred) | renewal/cost extraction | — |
| Connectors (Stage 12, deferred) | scraper sync behind vault | — |

## 7. How to use this doc
- A capability is **not parity** until its row is `verified` *and* the matching OMC checklist item is **Yes**.
- Every PR that lands a parity surface updates its row here (status + "v3 status") and the matching
  OMC checklist row, and links the PR. Drift here = an unverified cutover claim (RISK-016).
