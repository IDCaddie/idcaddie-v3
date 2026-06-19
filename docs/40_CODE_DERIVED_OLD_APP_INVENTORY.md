# 40 · Code-Derived Old-App Inventory

**Purpose:** since the live old app is not accessible, inventory it from the **legacy codebase** (`frontend-v2/`,
`webapp/functions/`, `extension/`, `DemoFeatures/`, legacy docs) so v3 full-parity work can proceed. **This
inventory is derived from the legacy old-app codebase, not live old-app inspection.**

> ## ⚠️ STATUS BANNER (do not remove)
> - **This inventory is derived from the legacy old-app codebase, not live old-app inspection. Live old-app
>   inspection remains incomplete.** No screenshots were captured; no user acceptance; nothing was run.
> - **OMC requires full old-app parity before cutover unless OMC explicitly waives a specific capability.**
> - **Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete.**
> - **Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified.**
> - **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage
>   completion is necessary but not sufficient for cutover.** No doc 17 §5 box ticked; no feature built.

**Source (read-only, outside this repo):** `frontend-v2/src/app/(authenticated)/`, `frontend-v2/src/services|context|hooks`,
`webapp/functions/src/{api,appScraping,companies,email,files,groups,logging,scim,storage,scheduled,scheduledJobs}`,
`extension/`, `DemoFeatures/IDCIngestor/`. v3 status is **repo-evidence only** ([37 §5](./37_EXISTING_PARITY_DOCS_AUDIT.md)/[39](./39_OLD_APP_DIRECT_INSPECTION_INVENTORY.md));
parity is **not** invented — absent v3 route/module ⇒ **Missing**; partial Supabase/RLS/storage/auth foundation ⇒
**Partial**; otherwise **Unknown**. Default cutover-blocker = **Yes** unless OMC waives ([38 §5](./38_OMC_FULL_PARITY_SCOPE_DECISION.md)).

---

## 1. Frontend routes (`frontend-v2/src/app/(authenticated)/`)

| Route | Feature area | Capabilities (code-inferred) | v3 equivalent | v3 status | Blocker |
|---|---|---|---|---|---|
| `/page.tsx` | Dashboard/home | metric cards, widgets | none | Missing | Yes |
| `/dashboards`, `/dashboards/create`, `/[id]` | **Custom dashboard builder** | create/edit custom dashboards | none | Missing | Yes |
| `/IDCApps` | Apps inventory | list: cost, license utilization, user metrics; filters/sort | `/apps` (read) | Partial | Yes |
| `/IDCApps/[id]` | App detail | roster, invoices, compliance reviews, linked contracts/docs | `/apps/[id]` (read) | Partial | Yes |
| `/IDCApps/[id]/invoices/[invoiceId]` | Invoice review | AI split-view extraction | none | Missing | Yes |
| `/IDCApps/insights/elu` | License optimization | Effective License Utilization / waste | none | Missing | Yes |
| `/IDCApps/insights/stale` | Stale users | sync-freshness | none | Missing | Yes |
| `/IDCApps/insights/uar` | Shadow IT / UAR | Unmanaged Account Ratio + risk tiers | none | Missing | Yes |
| `/IDCApps/scraping` | Connectors | scraper config / sync status | none | Missing | Yes |
| `/IDCApps/settings` | Admin | custom field definitions | none | Missing | Yes |
| `/contracts`, `/[id]`, `/create` | Contracts | list/detail/create + edit; PDF AI | `/contracts`,`/[id]`,`/new`,`/[id]/edit` | Partial | Yes |
| `/contracts/gantt` | Contracts | contract timeline | none | Missing | Yes |
| `/files`, `/files/[fileId]` | Files | document inventory + detail (AI status) | bucket only (no UI) | Missing | Yes |
| `/files/inbound` | Imports | email/API-ingested files + channel config | none | Missing | Yes |
| `/invoices`, `/invoices/[id]` | Spend | invoice inventory/detail (chargeback) | none | Missing | Yes |
| `/people`, `/people/risks`, `/people/settings` | Identity | directory (IdP+app-only), orphan/shadow risks, matching rules | match-status read only | Partial | Yes |
| `/company/users` | Admin | platform user management (role/status, bulk) | none (RLS only) | Partial | Yes |
| `/company/groups`, `/[groupId]` | Roles/perms | groups + **granular group permissions** | none | Missing | Yes |
| `/reports`, `/reports/cost-snapshot`, `/it-spend`, `/license-analysis`, `/monthly-procurement`, `/monthly-snapshot`, `/overlap-analysis`, `/user-comparison`, `/schedules` | Reporting | 7+ report types + scheduled reports | none | Missing | Yes |
| `/logging`, `/logging/[logId]` | Audit | audit log viewer + before/after diff (read-only) | `audit_logs`+`0010`, no viewer | Partial | Yes |
| `/admin/company` | Admin | company profile, domain rules, API keys | none | Missing | Yes |
| `/admin/recompute` | Admin | manual recompute of derived fields | none | Missing | Yes |
| `/admin/sso` | Auth | **SSO/SAML/OIDC** config | none | Missing | Yes |
| `/admin/billing`, `/billing/invoice/[id]` | Billing | subscription billing of IdP users | none | Missing | Yes |
| `/profile` | Auth | own account / password | none | Missing | Yes |
| `/login`, `/sso-callback`, `/forgot-password` | Auth | login, SSO callback, password reset | `/login` (password) | Partial | Yes |
| `/users` (→`/people`) | Identity | redirect alias | n/a | n/a (verify waiver) | Unknown |

---

## 2. Backend functions (`webapp/functions/src/`)

| Module | Area | Trigger (inferred) | Data touched | v3 equivalent | Status | Sec? |
|---|---|---|---|---|---|---|
| `api/chromePluginFunction`, `createAPIKeyFunction`, `api/v1` (`handleIngestData`, `processInboundAPI`) | Imports/API | callable / HTTP | apps, users, API keys | none | Missing | **Yes** |
| `appScraping/*` (52 scrapers, `automatedScrapingService`, `runAppScraper`, `runScheduledScrapers`, `configureAppScraper`, `testScraperCredentials`, `updateScraperCredentials`) | Connectors | callable + scheduled | app/user inventory, **credentials** | none | Missing | **Yes** |
| `companies/billing` (`calculateMonthlyBilling`, `manualCalculateMonthlyBilling`, `backfillInvoicedCosts`) | Billing | callable + scheduled | invoices, spend | none | Missing | Yes |
| `companies/currency` (`syncExchangeRatesMonthly`, `manualExchangeRateSync`) | Spend | scheduled | FX rates | none | Missing | No |
| `companies/contracts` (`updateContract`, `contractsDailyCRON`, `CONTRACT_FIELD_ORDER`) | Contracts | callable + scheduled + onWrite | contracts | contract-write (`0004`/`0010`) | Partial | Yes |
| `companies/IDCApps` (`updateIDCApp`, `syncAppApps`, `dailySyncApps`, `updateAppMonthlyData`, `applyComputedFields`, computed-fields) | Apps | callable + scheduled + triggers | apps, metrics | apps read (DAL) | Partial | Yes |
| `companies/people`/`users` (`createUser`, `deleteUser`, `updateUserRole`, `rebuildPeople`, `syncIdpAssignments`, `listUsers`, `buildUserLicenseStamp`, `computeUserIsActive`) | Identity | callable + triggers | people, identity, roles | match-status read; no people dir | Partial/Missing | **Yes** |
| `groups/*` (`createGroup`/`update`/`delete`, `addUserToGroup`, `permissionSync`, `initializeResourcePermissions`, `refreshUserGroupClaims`, `validateUserCanEditResource`, `requireEditorOrAdmin`, `SITE_ROLES`) | Roles/perms | callable + triggers | groups, granular permissions, claims | RLS + memberships (no groups) | Partial | **Yes** |
| `storage/processFileWithAI`, `handleDocumentAICompletion`, `onDeleteStorageFile` | AI/Files | storage trigger + callable | files, AI extraction | bucket boundary only | Missing | **Yes** |
| `files/*` (`onFileLinkedToApp`, `onInvoiceLinkedToApp`, `fileGroupSync`, `invoiceGroupSync`, `onDeleteFirestoreFileDoc`) | Files | Firestore triggers | file↔app/invoice links | schema only | Missing | Yes |
| `logging/*` (`logChange`, `appOnWriteLog`, `contractOnWrite`, `fileOnWrite`, `cleanupOldLogs`) | Audit | Firestore triggers + scheduled | audit log (+ **90-day purge**) | `audit_logs`+`0010` (append-only; no purge) | Partial | **Yes** |
| `email/*` (`monthlyProcurementReport`, `reportScheduleRunner`, `monthlySummarySender`, `sendInviteEmail`, `reportTemplates`) | Reporting | scheduled + callable | reports, emails | none | Missing | No |
| `scim/*` (`generateScimToken`, `revokeScimToken`, `scimMiddleware`, `scimTokenManager`) | Identity/Auth | HTTP (SCIM) | SCIM provisioning, **tokens** | none | Missing | **Yes** |
| `scheduled`/`scheduledJobs` (`checkStuckAiProcessing`, `generateReportRuns`, `monthly.js`, `nightly.js`, `processScheduledReports`, `scheduledCleanupOrphanedLinks`) | Ops | scheduled (CRON) | AI, reports, link integrity | none | Missing | No |
| `migration`/`migrations` (`runMigration`, `checkUserListMigrationStatus`, `retryProcessUserlistFile`) | Migration | callable | bulk user/data import | none (doc 34 plan) | Missing | Yes |
| `auth` (`blockSignup`, `blockUnverified`, `acceptTermsOfService`, `createUserDocument`, `watchUserCreated/Deleted`) | Auth | auth triggers | auth users, profiles | Supabase Auth + RLS | Partial | **Yes** |
| `api` token mgmt (`generateInboundEmailToken`, `deleteInboundEmailToken`, `generateIngestorToken`, `setAppPrivateData`, `PRIVATE_CREDENTIALS_SCHEMA`) | Connectors/Secrets | callable | **ingestion tokens / private creds** | none (vault not built, RISK-007) | Missing | **Yes** |

---

## 3. Connectors / scrapers (`appScraping/scrapers` + `DemoFeatures/IDCIngestor`)

**52 connectors found** (each scrapes app/user inventory + usage into the SaaS-governance model). v3 has **none**
(connector framework + credential vault not built — RISK-007). **All Missing; all blockers; all security-sensitive
(handle third-party credentials).** Auth models observed in code: `apikey` · `basic` · `bearer`/OAuth · `scim` ·
`generic_api` (configurable); pagination `cursor`/`offset`/`page`/`link`.

`alicloud · apollo · asana · astronomer · auth0 · aws · circleci · cloudflare · contentful · databricks ·
datadog · datarobot · dialpad · dockerhub · domo · dropbox · egnyte · figma · freshworks · genericApi ·
githubEnterprise · github · gong · google · greenhouse · hubspot · intercom · jira · launchdarkly · lucidchart ·
marketo · meraki · microsoft365 · mixpanel · mongodb · n8n · notion · octopus · okta · pagerduty · productboard ·
retool · salesforce · salesloft · servicenow · sigma · slack · tableau · workday · wrike · zapier · zendesk ·
zoom` — plus the **generic API** connector, **Okta/Atlassian app+user handlers**, and **`DemoFeatures/IDCIngestor`**
(1password, asana, atlassian, databricks-prism, intercom + an `IDC_uploader.sh`/`create_IDC_api.sh` inbound API
ingestor). Token storage via `setAppPrivateData` / `PRIVATE_CREDENTIALS_SCHEMA` / `updateScraperCredentials`.

| Field | Value (shared) |
|---|---|
| Data imported/scraped | per-connector app inventory, app-user roster, usage/license/last-active |
| Auth/token/security | third-party API keys / OAuth tokens / SCIM tokens stored as private credentials — **must use the v3 vault (RISK-007), never a Postgres column / generated types / logs** |
| v3 equivalent | none |
| Parity status | **Missing** (all 52) |
| Cutover blocker | **Yes** (unless OMC waives specific connectors in writing) |

---

## 4. AI / document processing (`storage/` + `constants/documentTypes`)

| Capability | Input → output | v3 equivalent | Status | Security notes |
|---|---|---|---|---|
| `processFileWithAI` (storage trigger) | uploaded PDF → Google Document AI extraction job | none (pdf-validation only, PR #40) | Missing | **Yes** — runs on upload; must be out-of-request, no service-role on request path |
| `handleDocumentAICompletion` | Doc-AI result → structured fields on contract/invoice | none | Missing | **Yes** — suggestions-only, no silent overwrite (doc 16) |
| `checkDocumentAIOperations`, `checkStuckAiProcessing` (scheduled) | poll/repair stuck AI jobs | none | Missing | No |
| `documentPrompts` / `documentTypes` (`constants`) | per-doc-type prompts + field schemas (contracts AND invoices) | none | Missing | **Yes** — prompt/schema allowlist; strict parsing |
| `DocumentAIViewer` (frontend) | AI extraction split-view review UI | none | Missing | No |

**AI covers contracts AND invoices.** v3 has the PDF-validation core + Storage boundary only; no AI worker, no
viewer, no completion handler. **AI/API connector parity is not complete.**

---

## 5. Reports / exports (`email/`, `scheduledJobs/`, `reports/*`)

| Report | Source (code) | v3 equivalent | Status |
|---|---|---|---|
| Monthly procurement | `monthlyProcurementReport`, `sendMonthlyProcurementReport`, `generateProcurementEmailHTML` | none | Missing |
| Cost snapshot | `/reports/cost-snapshot` | none | Missing |
| Monthly snapshot | `/reports/monthly-snapshot`, `monthlySummarySender`, `sendMonthlySummaryEmails` | none | Missing |
| User comparison | `/reports/user-comparison` | none | Missing |
| Overlap analysis | `/reports/overlap-analysis` | none | Missing |
| License analysis | `/reports/license-analysis` | none | Missing |
| IT spend | `/reports/it-spend` (+ `DemoFeatures` IT-spend worksheets) | none | Missing |
| Scheduled reports | `reportScheduleRunner`, `generateReportRuns`, `processScheduledReports`, `/reports/schedules`, `triggerReportSchedule`, saved configs (`useSavedReportConfigs`) | none | Missing |
| CSV/export/download | `apps-2026-03-27.csv` + per-report download (code-inferred; **confirm format live**) | none | Missing |

All reporting/export is **Missing** in v3. **Imports** (`/files/inbound`, `api/v1` ingest, `IDCIngestor`,
`migration/runMigration`) are likewise Missing and must be **non-destructive upsert + preview** (doc 17 box 12).

---

## 6. Admin / security / identity

| Capability | Legacy (code) | v3 equivalent | Status | Sec? |
|---|---|---|---|---|
| SSO / SAML / OIDC | `/admin/sso`, `services/samlAuth.ts`, `oidcAuth.ts`, `/sso-callback` | none (password login only) | Missing | **Yes** |
| SCIM provisioning | `scim/` (`generateScimToken`, `scimMiddleware`) | none | Missing | **Yes** |
| Company users / groups | `/company/users`, `/company/groups`, `groupManagement` | RLS memberships (no UI/groups) | Partial | **Yes** |
| Granular / group permissions | `permissionSync`, `initializeResourcePermissions`, `validateUserCanEditResource`, `SITE_ROLES`, `refreshUserGroupClaims` | RLS org-scoping (no granular UI) | Partial | **Yes** |
| Billing | `calculateMonthlyBilling`, `/admin/billing` | none | Missing | Yes |
| API keys / ingestion tokens | `createAPIKeyFunction`, `generateInboundEmailToken`, `generateIngestorToken`, `setAppPrivateData`, `PRIVATE_CREDENTIALS_SCHEMA` | none (vault not built, RISK-007) | Missing | **Yes** |
| Audit / logging | `logChange`, `*OnWriteLog`, `cleanupOldLogs` (**90-day purge**) | `audit_logs`+`0010` (append-only; **no destructive purge — `removed-approved`**) | Partial | **Yes** |
| Role checks | `requireEditorOrAdmin`, `updateUserRole`, `updateUserRoleInGroup` | RLS roles (tenant/org memberships) | Partial | **Yes** |
| Chrome extension | `extension/` (manifest, auth, content) | none | Missing | Yes |
| Terms / signup gating | `blockSignup`, `blockUnverified`, `acceptTermsOfService` | none | Missing | Yes |

---

## 7. Top cutover blockers (from code-derived inventory)

1. **Connectors + credential vault** — 52 scrapers + ingestion tokens; v3 has none and **no vault** (RISK-007). The
   single largest area; prerequisite = the vault before any connector.
2. **AI document processing** — contract + invoice extraction (Google Doc AI) entirely absent in v3.
3. **People / identity / UAR** — directory, matching rules, orphan/shadow risk, stale users — v3 has a read slice only.
4. **Reporting + exports** — 7+ report types + scheduled/emailed reports + CSV — all Missing.
5. **Files** — upload/download/preview UI + AI status + inbound ingest — only the Storage boundary exists.
6. **Spend / billing / invoices** — invoice review, chargeback, monthly billing, FX — all Missing.
7. **SSO/SAML/OIDC + SCIM** — enterprise auth/provisioning — Missing (v3 = password login only).
8. **Granular group permissions + admin** — groups, resource permissions, company/admin screens — Partial/Missing.
9. **Custom dashboards builder** — Missing.
10. **Data migration + the 90-day audit-purge difference** — Firestore→v3 (doc 34); the legacy destructive
    log-purge is intentionally **not ported** (`removed-approved`, append-only).

---

## 8. Likely PR backlog by feature area (code-derived, indicative — not a commitment)

Connectors+vault (**many** PRs: vault, framework, then per-connector or per-connector-family) · AI (worker +
completion + viewer + invoice AI) · People/Identity/UAR · Reporting/exports (per report + scheduler + export) ·
Files (upload/download/preview/inbound) · Spend/Billing/Invoices · SSO/SAML/OIDC + SCIM · Groups/granular
permissions/admin · Dashboards builder · Imports (non-destructive) · Audit viewer · Apps/Contracts field-parity +
links + gantt · Migration + rehearsals + acceptance. **Consistent with [38 §8](./38_OMC_FULL_PARITY_SCOPE_DECISION.md):
full parity likely means dozens of PRs — the 52 connectors alone imply a large sub-program.** Exact count needs
the live walkthrough + OMC waivers; do not treat this as a low number. **This inventory is sequenced into
dependency-ordered epics + connector waves + PR-count ranges in [41_FULL_PARITY_IMPLEMENTATION_ROADMAP](./41_FULL_PARITY_IMPLEMENTATION_ROADMAP.md).**

---

## 9. Cannot determine without live old-app access

Code shows structure, not lived behavior. Still required (per [39](./39_OLD_APP_DIRECT_INSPECTION_INVENTORY.md)):
exact rendered UI / field labels / button text / per-role differences; empty/loading/error/validation behavior;
real filter/search/sort + saved views; exact import/export **formats** (columns) and report layouts; the real AI
prompts/outputs and auto-apply-vs-suggest behavior; which of the 52 connectors are actually used vs waivable;
per-connector live auth/rotation specifics; performance/SLO expectations; and which capabilities OMC will **waive
in writing** (doc 18 + [38 §5](./38_OMC_FULL_PARITY_SCOPE_DECISION.md)). **Live old-app inspection remains
incomplete.**

---

## 10. Cross-references + risk posture

Builds on [37](./37_EXISTING_PARITY_DOCS_AUDIT.md) (docs audit), [38](./38_OMC_FULL_PARITY_SCOPE_DECISION.md)
(full-parity decision), [39](./39_OLD_APP_DIRECT_INSPECTION_INVENTORY.md) (the live-inspection packet this
code-derived inventory pre-fills). Folds into [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) as the line-item master.

**This inventory is derived from the legacy old-app codebase, not live old-app inspection. Live old-app
inspection remains incomplete.** No live inspection, no screenshots, no user acceptance, no feature built.
**OMC requires full old-app parity before cutover unless OMC explicitly waives a specific capability. Old-app
parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient
for cutover.** No production/staging mutation, no hosted command, no secrets. OMC/Flywheel is a paying production
**replacement, not a pilot**.
