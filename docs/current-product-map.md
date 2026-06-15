# Current Product Map (Legacy Firebase ID Caddie)

Source: `/Users/samvemuri/Desktop/IDCaddie_Repo-main`. Evidence cites exact legacy file paths.
This treats the old implementation as **evidence, not a pattern to copy**. See [v3-product-scope.md](./v3-product-scope.md) and [current-security-risk-map.md](./current-security-risk-map.md).

## Architecture at a glance
- **Frontend:** `frontend-v2/` — Next.js App Router, Firebase compat client SDK. **No server-side data layer**: 54 files import Firebase, ~198 direct `.firestore()` call sites; privileged ops go through ~30 `httpsCallable` Cloud Functions. Route protection is client-side only (`frontend-v2/src/app/(authenticated)/layout.tsx` → `components/AuthGuard.tsx`); no middleware/server session.
- **Backend:** `webapp/functions/` — 82 Cloud Functions (callables, Firestore triggers, scheduled CRONs, auth blocking, SCIM/ingest HTTP endpoints).
- **Tenancy:** effectively **single-tenant per Firebase project**. Isolation = separate projects (`webapp/.firebaserc`: `idcaddie-dev`, `idcaddiecorporate`, `flywheeldigital-cb222`, `fir-idcaddie`). No `companyId`/`tenant_id` anywhere in live paths. "Tenant" code comments say "Single-tenant: No company ID needed" throughout.
- **Extension:** `extension/` — Chrome extension (auth.js, content.js, popup.js). **DEFER** (per scope).
- **Other:** `DemoFeatures/IDCIngestor/` connector scripts, IT-spend worksheets/PDFs (demo data).

Disposition legend: **KEEP** = core, port to Postgres · **REDESIGN** = core need, rebuild off Firestore-trigger/claims plumbing · **DEFER** = post-MVP · **DELETE** = don't port.

---

## 1. Screens / routes (`frontend-v2/src/app/`)

| Route | Purpose | Disposition |
|---|---|---|
| `login/`, `forgot-password/`, `sso-callback/` | Email/password + SSO (SAML/OIDC) auth | REDESIGN (Supabase Auth) / DEFER (SSO) |
| `(authenticated)/page.tsx` | Home dashboard, metric cards, widgets | REDESIGN (simple landing) |
| `(authenticated)/IDCApps/page.tsx` | **App inventory** list: cost, license utilization, user metrics | **KEEP** |
| `IDCApps/[id]/page.tsx` | App detail: user roster, invoices, compliance reviews, linked contracts/docs | **KEEP** |
| `IDCApps/[id]/invoices/[invoiceId]/page.tsx` | Invoice review split-view (AI extraction) | KEEP |
| `IDCApps/insights/elu/page.tsx` | Effective License Utilization / waste | KEEP |
| `IDCApps/insights/stale/page.tsx` | **Stale users** / sync-freshness | **KEEP** |
| `IDCApps/insights/uar/page.tsx` | **Unmanaged Account Ratio** + risk tiers | **KEEP** |
| `IDCApps/scraping/page.tsx` | Scraper config/sync status | DEFER |
| `IDCApps/settings/page.tsx` | Custom field definitions | REDESIGN |
| `contracts/page.tsx`, `contracts/[id]/`, `contracts/create/` | **Contracts** list/detail/create (PDF AI extraction) | **KEEP** (AI part DEFER) |
| `contracts/gantt/page.tsx` | Contract timeline | DEFER |
| `company/users/page.tsx` | Platform user management (role/status, bulk) | **KEEP** |
| `company/groups/page.tsx`, `groups/[groupId]/` | Access-control groups + assigned resources | REDESIGN (RLS-backed) |
| `people/page.tsx` | **People directory** (IdP + app-only), drill to app accounts | **KEEP** |
| `people/risks/page.tsx` | Orphaned/shadow/service account risk + overlap spend | **KEEP** |
| `people/settings/page.tsx` | IdP config, matching rules, domain aliases | REDESIGN |
| `users/page.tsx` | Redirect alias → `/people` | DELETE |
| `files/page.tsx`, `files/[fileId]/` | Document inventory + detail (AI status) | KEEP |
| `files/inbound/page.tsx` | Email/API-ingested files + channel config | DEFER |
| `invoices/page.tsx`, `invoices/[id]/` | **Invoice** inventory/detail (chargeback) | **KEEP** |
| `logging/page.tsx`, `logging/[logId]/` | **Audit log** viewer + before/after diff (read-only) | **KEEP** |
| `profile/page.tsx` | Own account / password | KEEP |
| `admin/company/page.tsx` | Company profile, domain rules, API keys | REDESIGN |
| `admin/recompute/page.tsx` | Manual recompute of derived fields | REDESIGN |
| `admin/billing/page.tsx`, `billing/invoice/[id]/` | Subscription billing of IdP users | DEFER |
| `admin/sso/page.tsx` | SAML + SCIM config | DEFER |
| `dashboards/` (page, `[id]`, `create`) | Widget dashboard builder | DEFER |
| `reports/` (8 routes: cost-snapshot, it-spend, license-analysis, monthly-procurement, monthly-snapshot, overlap-analysis, schedules, user-comparison) | Analytics + scheduled email reports | **DEFER** (all) |

---

## 2. Major workflows
- **App source-of-truth:** inventory apps, ownership fields, license rules → utilization/waste. KEEP.
- **Contracts & app↔contract linking:** contract metadata, allocations to apps, renewal/expiry CRON (`webapp/functions/src/companies/contracts/contractsDailyCRON.js`). KEEP.
- **People / app-user import + identity matching:** CSV/API/IdP ingest → `IDCApps/{id}/users` → email/local-part matching (`watchUserUpdated.js`) → unified `people` directory (`rebuildPeopleCollection.js`). KEEP/REDESIGN (make non-destructive — see risk map).
- **Stale / unmanaged user reporting:** insights/stale + insights/uar. KEEP.
- **Spend / chargeback:** invoice import, monthly billing (`calculateMonthlyBilling.js`), FX sync (`exchangeRateSync.js`). KEEP (chargeback); DEFER subscription billing.
- **Auditability:** Firestore `onWrite` triggers → `logs` collection (`webapp/functions/src/logging/*`). REDESIGN as Postgres append-only audit.
- **Connector scraping (53 integrations):** `webapp/functions/src/appScraping/*`. DEFER.
- **AI document processing (DocumentAI/VertexAI):** `webapp/functions/src/storage/processFileWithAI.js`. DEFER.
- **SCIM / inbound API+email ingest:** `webapp/functions/src/scim/*`, `src/api/v1/ingest/*`. DEFER.

---

## 3. Inferred Firestore collections / doc shapes
Evidence: `frontend-v2/src/context/DataProvider.js`, `AuthContext.js`, `PeopleMetricsContext.tsx`, `utils/appMetrics.ts`, `utils/costTypes.ts`, `firestore.rules`.

| Collection | Shape (observed fields) | v3 target table |
|---|---|---|
| `company/config` (singleton) | profile, domain auth rules, API keys, invoice settings | `tenants` + settings |
| `users/{uid}` | `role`, `groups` (claim mirror), `termsAcceptedAt`, `preferences.groupFilterIds`; subcols `apps`, `appAssignments` | `profiles` + `tenant_memberships` |
| `groups/{id}` + `/members/{uid}` | `name`, `settings.defaultRole`; member `{role: manager|viewer, joinedAt, addedBy}` | `organizations`/groups + memberships |
| `IDCApps/{id}` | `fields.{name,category,custom}`, computed `linkedSummaries.{users,licenses}`, `groups[]` | `apps` (+ generated/computed) |
| `IDCApps/{id}/users` | app-account roster `{email, role, status, isActive, isUtilized, licenseCostTotal}` | `app_users` |
| `IDCApps/{id}/appAssignments/{tgt}/assignedUsers` | IdP assignment matches | `app_user_identity_matches` |
| `IDCApps/{id}/licenses` | per-app license rules (seats/purchased/assigned/active) | `license_rules` + `license_evaluations` |
| `IDCApps/{id}/monthlyData` | monthly snapshot | DEFER |
| `IDCApps/{id}/complianceReviews` | immutable review records | (audit-like) |
| `IDCApps/{id}/scraperLogs` | per-app scraper log (⚠ client-writable) | DEFER |
| `IDCApps/{id}/private/*` | scraper credentials / provider keys (plaintext) | encrypted credential store (service-role only) |
| `contracts/{id}` | metadata, `groups[]`, `fields.totalCost`, allocations | `contracts` |
| `files/{id}` | `contractId`, `appId`, `uploadedAt`, AI analysis, `groups[]` | `files` |
| `invoices/{id}` | vendor/app-linked, status (pending/reviewed/disputed), AI fields | `invoices` |
| `people/{id}` + `_summary` + `_appTiers` | unified person `{email, source:idp|app-only, appAccounts[], totalLicenseCostMonthly}` | `people` |
| `logs/{id}` | `{timestamp, userId, action, documentType, documentId, changes{before,after}, metadata}` | `audit_logs` (append-only) |
| `ingestors/{id}` (+ `/private/apiToken`) | ingest tokens | DEFER |
| `inboundTokens/{id}` | email ingest token (id-as-secret) | DEFER |
| `_settings/scim` | SCIM token hash | DEFER |
| `APIKeys/{sha256}` | `{userId, active}` | API keys (hashed) |
| `dashboards`, `charts`, `reports`, `reportSchedules`, `datasets`, `billing`, `monthlyProcurementReport` | reporting/billing | DEFER |

---

## 4. Cloud Functions classification (`webapp/functions/index.js`, 82 functions)
Full inventory with trigger type / invoker / disposition is large; summarized by area. **MVP tally: ~13 KEEP, ~28 REDESIGN, ~31 DEFER, ~10 DELETE.**

| Area | Examples (file) | Disposition |
|---|---|---|
| **Auth/identity** | `onUserCreate.js`, `blockingAuth.js`, `emailVerification.js` | REDESIGN (Supabase auth triggers); `sendVerificationEmail` DELETE (no auth, mail-enumeration vector) |
| **Users/roles/groups** | `companies/users/userCRUD.js`, `groups/groupManagement.js`, `groups/permissionSync.js` | KEEP admin CRUD; DELETE claims/permission-subcollection plumbing (→ RLS) |
| **Apps/licenses/field calc** | `watchAppDeleted.js`, `licenses/onLicenseWrite.js`, `calculateFieldValues/*` | REDESIGN (Postgres triggers/computed cols/views) |
| **Scraping (53 connectors)** | `appScraping/automatedScrapingService.js`, `scrapers/*`, `syncAppApps.js` | DEFER (all) |
| **Contracts/billing/chargeback** | `contracts/contractsDailyCRON.js`, `billing/calculateMonthlyBilling.js`, `currency/exchangeRateSync.js` | KEEP (chargeback core) |
| **People/app-user import** | `people/rebuildPeopleCollection.js`, `files/onFileLinkedToApp.js`, `syncIdpAssignments.js` | KEEP/REDESIGN (validated + non-destructive) |
| **Files/storage** | `files/*`, `storage/onDeleteStorageFile.js`, `linkedDocs/syncLinkedDocs.js` | REDESIGN (FKs + storage hooks) |
| **AI document processing** | `storage/processFileWithAI.js`, `handleDocumentAICompletion.js` | DEFER |
| **Email/reports** | `email/*`, `scheduledJobs/*`, `monthlySummaryTokens/*` | DEFER |
| **Logging/audit** | `logging/{appOnWriteLog,contractOnWrite,fileOnWrite,logChange,cleanupOldLogs}.js` | REDESIGN (append-only audit) |
| **Maintenance/migration** | `maintenance/*`, `migration(s)/*`, `scripts/captureLegacySnapshot.js` | DELETE (one-off); backup tooling reused (see migration plan) |
| **API/ingest/SCIM** | `api/createAPIKeyFunction.js`, `api/v1/ingest/*`, `scim/*`, `api/chromePluginFunction.js` | REDESIGN API keys; DEFER ingest/SCIM/chrome |

> ⚠ Several core callables ship today **with no auth check**: `sendVerificationEmail`, `syncAppApps`, `calculateFieldValues`, `sendUserInviteEmail`, plus auth-only-no-role `retryProcessUserlistFile`, `rebuildPeople`, `manualCalculateMonthlyBilling`. These must be re-secured in v3 — see [current-security-risk-map.md](./current-security-risk-map.md).
