# 43 · Old-App Source-Line Rebuild Ledger

**Canonical source for: the old-app code-derived rebuild ledger.** Use this when deciding what v3 still needs to
rebuild from the existing Firebase/Next.js ID Caddie app. This doc is intentionally more concrete than the broad
parity docs: it ties old-app source files and line ranges to v3 rebuild requirements so product scope does not get
lost.

> ## Status banner — do not remove
> - This is a **source-code inspection ledger**, not a live old-app screenshot walkthrough. It was produced from
>   the old app source tree (`frontend-v2/`, `webapp/functions/`, `webapp/firestore.rules`, `webapp/storage.rules`,
>   `extension/`, and `DemoFeatures/IDCIngestor`).
> - The old app contains **48 `page.*` route/page files**. It also contains **63 total files** under
>   `frontend-v2/src/app`. Do not describe the 63 directory files as route files.
> - The old app contains **146 Cloud Function source files** (`.js`/`.ts`, excluding tests). It also contains
>   **166 total files** under `webapp/functions/src`. Do not describe the 166 directory files as source files.
> - Binary/demo documents and files named like private keys were **not quoted or ported**. Do not copy legacy secrets,
>   API tokens, private keys, Firebase config values, JWTs, cookies, or customer data into v3 docs/code.
> - This doc **does not implement parity**. Every row remains a rebuild requirement until v3 code/tests/hosted
>   verification exist or the capability is explicitly waived in writing.
> - v3's direction remains: familiar UX, materially stronger backend; Postgres/RLS, least privilege, append-only
>   migrations, no service-role request path, deterministic/reviewable matching, no real connector tokens until
>   RISK-007 boundaries are proven.

---

## 1. Executive read: what the old app actually is

The old app is a **SaaS governance operating system**, not a simple app inventory. The authenticated route guide says
`IDCApps` covers apps, users, license/usage insights and UAR; `admin` covers billing, company, recompute and SSO;
`company` covers groups/users; `contracts` covers contracts/timelines; `reports` covers the reporting suite;
`people` covers the unified identity index; `files` covers file intake; and `logging` covers activity logs
(`frontend-v2/src/app/(authenticated)/AGENTS.md:9-20`). The sidebar exposes the same product map to users:
Core, People & Access, Analytics, Files, Administration, plus exact children for contracts, apps, reports, files,
company users, SSO/SCIM, billing, activity logs and recompute (`frontend-v2/src/components/Sidebar.tsx:29-119`).

**v3 rebuild implication:** the product cannot be reduced to apps/contracts/files. Full replacement requires the
same workflow categories, but with a stronger backend and explicit authz.

### 1.1 Secondary tree-comparison correction

A second old-tree/v3-tree comparison found that this ledger is a strong source map and that the appendices inventory
nearly all old-app files, but appendix inventory is not the same thing as a rebuild requirement. Several real old-app
capabilities were only appendix-listed or under-specified. This patch therefore adds explicit requirement rows for:
external API-key/Chrome-plugin auth, company user invite/admin lifecycle, identity-change cascades,
file/invoice group access propagation, public monthly-summary token reads, document viewer parity, people metrics
context, and persisted table/filter/report UX.

It also corrects the headline counts above: `63` is the total file count under `frontend-v2/src/app`, not the route
count; `166` is the total file count under `webapp/functions/src`, not the Cloud Function source count. The measured
counts are `48` `page.*` route/page files and `146` Cloud Function source files excluding tests.

**Use this section while building:** if a capability appears in the old-app appendices but has no requirement row,
create a row or record an explicit rebuild/waive/defer decision before claiming parity.

---

## 2. Non-negotiable rebuild rules extracted from the old code

| Rule | Old source evidence | v3 requirement |
|---|---|---|
| Keep the familiar IA/navigation. | Old route guide and sidebar enumerate the product areas (`AGENTS.md:9-20`, `Sidebar.tsx:29-119`). | v3 navigation must eventually cover dashboard, apps, app insights, contracts, invoices, files/inbound, people/risks/settings, reports/schedules, groups, company users, SSO/SCIM, billing, audit, recompute. |
| Do not copy client-side authz as the security boundary. | `DataProvider` subscribes directly to Firestore and filters by groups in the client query path (`DataProvider.js:47-64`, `:109-131`). | v3 must enforce tenant/org/resource authority in Postgres RLS/server actions/DAL; client filters are UX only. |
| Do not port broad destructive operations unchanged. | Firestore rules allow editor deletes for apps/files/contracts/invoices (`firestore.rules:72-83`, `:140-156`, `:173-184`); app detail deletes an app directly (`IDCApps/[id]/page.tsx:398-407`). | v3 should prefer archive/tombstone/reviewed deletes, audit every state change, and avoid blind hard-delete flows. |
| Do not port legacy credential storage. | Scraper credentials are written to `IDCApps/{appId}/private/scraperCredentials` (`scraperConfigManager.js:120-128`, `:258-289`). | v3 connector secrets must use the vault/envelope/runner boundary; no request-path secret reads/writes; RISK-007 stays open until proven. |
| Do not port weak ingestion token patterns. | Scraper ingestor creates token strings from timestamp + `Math.random()` and stores them in a private subcollection (`automatedScrapingService.js:481-504`). | v3 ingest tokens must be random, hashed, scoped, auditable, revocable, expiry-aware, replay-resistant. |
| Do not port simplified group-manager authz. | Firestore rules admit a simplified “manager in some group + member of resource group” check (`firestore.rules:387-408`). | v3 RLS must bind manager authority to the exact resource/org/group; no “manager somewhere” write escalation. |
| Keep immutable evidence, improve retention. | Old compliance reviews are immutable (`firestore.rules:133-138`) but logs are also purged after 90 days (`cleanupOldLogs.js:7-38`). | v3 audit logs remain append-only; log purge is not ported without an explicit archival/retention design. |

---

## 3. Source-line rebuild ledger by product area

### 3.1 Shell, auth, navigation, and global data loading

| Old code | What it does | What v3 must rebuild / improve | Current v3 posture |
|---|---|---|---|
| `frontend-v2/src/components/Sidebar.tsx:29-119` | Defines full user-facing IA: Home, Contracts/Gantt, Invoices, Applications/Utilization/Unmanaged/Sync Health/Scraping/Settings, People/Risk/Settings, Dashboards, Reports, Files/Inbound, Groups, Company Users, SSO/SCIM, Billing, Activity Logs, Recompute. | Preserve familiar IA and mark missing areas as not-built instead of silently omitting them. | Partial. v3 has some routes, not the full old IA. |
| `frontend-v2/src/context/AuthContext.js:34-64` | Firebase auth listener reads custom claims `role` and `groups`, then stores them in UI context. | v3 must derive session/tenant/org/role from Supabase/Auth tables server-side and never trust client claims for authorization. | Partial; auth/tenant context exists, but admin UI/parity incomplete. |
| `frontend-v2/src/context/AuthContext.js:75-115` | Email/password login, local/session persistence, logout, forced token refresh. | v3 should preserve login/logout UX where useful, but use Supabase session boundaries and server route protection. | Partial. |
| `frontend-v2/src/configs/acl.js:5-28` | CASL role gates UI: admin manage all, editor read/write all, viewer/user read. | v3 may keep UI affordance gating, but authority must live in RLS/server actions. | Partial; RLS stronger, UI role model incomplete. |
| `frontend-v2/src/context/DataProvider.js:17-37` | Persists user group-filter preferences in Firestore. | v3 should support saved user preferences/saved views with tenant/user scoping. | Missing. |
| `frontend-v2/src/context/DataProvider.js:47-64` | Calculates effective group filter based on site role and group membership. | v3 should model org/group/resource visibility in DB, not client-only query filters. | Partial/RLS foundation exists. |
| `frontend-v2/src/context/DataProvider.js:66-131` | Live-subscribes to contracts and IDCApps so recalculations update pages. | v3 should offer deterministic refresh/revalidation after writes and safe server-derived metrics; realtime is optional, but stale cross-page metrics are not acceptable. | Partial. |
| `frontend-v2/src/context/DataProvider.js:152-180` | Lazily fetches app users, files, reports, datasets. | v3 needs typed DAL/server actions for these surfaces, each RLS-scoped. | Partial/missing by surface. |

| `webapp/functions/src/api/createAPIKeyFunction.js`, `api/apiHelperFunctions.js`, `api/chromePluginFunction.js` | Issues/updates external API keys, provides key hashing/base64 helpers, and exposes Chrome-plugin-facing API endpoints. | Explicitly rebuild, waive, or defer the external API-key + Chrome-plugin surface. If rebuilt, v3 needs scoped external API keys, hashing, rotation/revocation, audit logs, rate limiting, tenant binding, least-privilege endpoint projections, endpoint tests, and no accidental public/request-path data exposure. | Missing. Security-sensitive external auth/data boundary; P0/P1. |
| `webapp/functions/src/companies/users/userCRUD.js`, `webapp/functions/src/email/sendInviteEmail.js` | Company user CRUD/admin lifecycle and invite email flow. | Rebuild tenant-scoped company user admin lifecycle with invite-token lifecycle, email send audit/status, role-change audit, and least-privilege admin checks. | Partial/unknown; P1. |
| `frontend-v2/src/app/(authenticated)/profile/page.tsx`, `frontend-v2/src/app/forgot-password/page.tsx`, `frontend-v2/src/app/login/page.tsx`, `frontend-v2/src/app/sso-callback/page.tsx` | Profile, password reset/login, and SSO callback UX. | Preserve familiar account UX while moving authority/session exchange to server-side Supabase/auth boundaries. | Partial/missing by route. |

### 3.2 Dashboard and custom dashboards

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `frontend-v2/src/app/(authenticated)/page.tsx:32-52` | Home quick links and summary cards for contracts, invoices, apps, people. | Rebuild home as the daily governance cockpit, not a static landing page. |
| `frontend-v2/src/app/(authenticated)/page.tsx:68-153` | Creates/loads a Home Dashboard and chart widgets. | Rebuild dashboard widgets with server-derived datasets, saved configs, and RLS-safe drill-through. |
| `frontend-v2/src/components/charts/ChartWidget.tsx`, `WidgetEditorDialog.tsx`, `chartUtils.ts`, `chartPresets.ts` | Custom chart rendering, widget editor, chart presets. | Rebuild only after underlying datasets exist; do not hard-code old client-side aggregation as authority. |
| `frontend-v2/src/app/(authenticated)/dashboards/*.tsx` | Dashboard list/detail/create route set. | Restore dashboard CRUD with audited writes and per-user/tenant visibility. |

### 3.3 Apps inventory and app detail command center

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `frontend-v2/src/app/(authenticated)/IDCApps/page.tsx:30-43` | Classifies app data source as API Synced, Manual/Pushed, or No Data Source. | v3 apps list needs connector/manual/source-state badges with safe provenance. |
| `IDCApps/page.tsx:45-54` | Hard-coded app commodity/category options. | v3 needs either seeded category taxonomy or tenant-configurable taxonomy. |
| `IDCApps/page.tsx:56-83` | Apps list supports create, select, inline edit, search/filter/sort, cost type/period. | Rebuild familiar app list UX; writes must be server/RLS/audited. |
| `IDCApps/page.tsx:121-139` | Injects linked contract fields and data-source status into app rows. | v3 needs server-derived app summary view/materialized read model, not client stitching. |
| `IDCApps/page.tsx:150-175` | Sorts by app users, ELU, cost, waste, renewal, auto-renew. | v3 must expose sortable metrics from trusted rollups. |
| `IDCApps/page.tsx:520-554` | Renders active/total users, ELU, cost, waste, next expiry/renewal, auto-renew, setup action. | v3 apps table parity requires these columns or explicit waiver. |
| `IDCApps/page.tsx:605-633` | Create app modal with name/category/description. | Rebuild as audited app-create action, not direct Firestore client write. |
| `frontend-v2/src/app/(authenticated)/IDCApps/[id]/page.tsx:50-123` | App detail is a large command center: app, app users, linked contracts, editing, invoices, CSV upload, compliance, licenses, cost period, owner pickers. | Treat app detail as the main product center; v3 should not stop at a read-only app page. |
| `IDCApps/[id]/page.tsx:132-158` | Search-as-you-type owner picker across the `people` materialized directory, restricted to source `idp`. | v3 needs PeoplePicker-style ownership assignment from deterministic identity records. |
| `IDCApps/[id]/page.tsx:160-235` | Fetches app, injects linked contract fields, fetches app users and linked contract documents. | v3 app detail needs server-side linked contract/app-user projections. |
| `IDCApps/[id]/page.tsx:237-287` | Watches invoices, compliance reviews, and license rules for the app. | v3 app detail needs linked invoice, review/audit, and license rule panels. |
| `IDCApps/[id]/page.tsx:290-325` | Maps people records to managed/orphaned/unknown app-user tiers and per-user license matches. | v3 app user roster must show identity tier + license matches with explainable evidence. |
| `IDCApps/[id]/page.tsx:336-380` | Uploads invoice PDFs/images and user CSVs into files with linkedDocs context. | v3 files/invoice/user-list upload must be row-first, storage-safe, scanned/validated, and linked to apps. |
| `IDCApps/[id]/page.tsx:383-407` | Saves app field edits and deletes app directly. | Save can be rebuilt with audited RLS. Hard delete should be replaced with archive/tombstone unless explicitly approved. |
| `IDCApps/[id]/page.tsx:453-529` | Adds compliance attestation/review records and updates app compliance summary. | v3 needs immutable compliance review records and summary rollups. |
| `IDCApps/[id]/page.tsx:531-560` | Computes app metrics via canonical utility to avoid page drift. | v3 metrics should be canonical DB/server-derived functions, not duplicated UI math. |
| `IDCApps/[id]/page.tsx:1182-1246` | App invoice table with upload, status, vendor, amount, invoice number/date, link to invoice detail. | v3 app detail needs invoice evidence table. |
| `IDCApps/[id]/page.tsx:1520-1744` | App-user table with configurable columns, filtering, sorting, export, account tier, license matches. | v3 app-user roster is not complete until this level of table behavior and evidence exists. |
| `IDCApps/[id]/page.tsx:1750-1769` | Admin configuration bundle: field config, scraper config, inbound channels, linked apps, IdP assignments, matching rules. | Rebuild as separate safe admin panels; no live connector/token work until vault/runner/KMS proof is complete. |

### 3.4 App configuration, field calculations, license rules, and pricing

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `frontend-v2/src/app/(authenticated)/IDCApps/[id]/components/FieldConfiguration.tsx` | Admin-managed dynamic field definitions and calculation UI. | Decide whether field configurability is parity-required. If yes, rebuild with strict expression allowlist and server-side execution. |
| `webapp/functions/src/shared/runtime/fieldCalcEngine.js` | Runtime expression engine for field calculations. | Do not port raw expression power without sandbox/security review; use allowlisted deterministic calculations. |
| `webapp/functions/src/companies/IDCApps/calculateFieldValues/*.js` | Preview/run/persist computed field values and calc errors. | Rebuild as typed job/action with audit, idempotency, and safe error reporting. |
| `frontend-v2/src/app/(authenticated)/IDCApps/[id]/components/LicenseRulesConfig.tsx` | License rule editing UX. | Rebuild license rules as first-class DB entities with criteria JSON schema and audit. |
| `frontend-v2/src/app/(authenticated)/IDCApps/[id]/components/PricingWizard.tsx` | Pricing/license wizard UI. | Rebuild only after license rule model exists; preserve familiar workflow. |
| `webapp/functions/src/companies/IDCApps/licenses/onLicenseWrite.js:1-51` | Trigger recomputes license assignments after license rule writes. | v3 should recompute via explicit job/transaction, not hidden trigger magic. |
| `webapp/functions/src/companies/IDCApps/licenses/evaluateUserLicenses.js:80-121` | Normalizes license rules and cost inputs. | v3 needs exact money/period normalization tests. |
| `evaluateUserLicenses.js:129-191` | Evaluates assigned/active/used seats against users. | Rebuild deterministic user-license assignment. |
| `evaluateUserLicenses.js:268-296` | Writes app-level rollups for assigned seats, active seats, waste, monthly normalized values. | Rebuild canonical app-license rollups. |
| `webapp/functions/src/shared/money/*.js` | Money helpers, invoice proration, license stats, app metrics. | Port behavior as tested server utilities; this is one of the highest-value parity areas. |

### 3.5 People, identity, UAR, app-user matching

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `frontend-v2/src/app/(authenticated)/people/page.tsx` | Unified people directory route, with identity/app account fields. | v3 needs People directory, not just backend matches. |
| `frontend-v2/src/app/(authenticated)/people/risks/page.tsx` | Risk view for people/app access. | Rebuild as UAR/shadow/orphan/stale risk surface. |
| `frontend-v2/src/app/(authenticated)/people/settings/page.tsx` | Matching settings UI. | Rebuild settings cautiously; deterministic default, review before fuzzy matching. |
| `.cursor/rules/idp-assignment-matching.mdc` | Old engineering guidance for IdP assignment matching. | Keep deterministic/staged resolver design; document any non-deterministic matching as review-only. |
| `webapp/functions/src/companies/people/rebuildPeopleCollection.js:29-69` | Rebuilds `people` materialized view from IDP + app-user data. | v3 needs materialized/person summary read model. |
| `rebuildPeopleCollection.js:71-108` | Builds provider app index and identity source classification. | v3 discovery facts/resolver should track provider evidence. |
| `rebuildPeopleCollection.js:135-213` | Seeds people from IDP/provider records, normalizes names/emails/status. | v3 person identity records should be deterministic and auditable. |
| `rebuildPeopleCollection.js:215-246` | Adds non-provider app accounts to people. | v3 app_user_accounts must link to person candidates through reviewable matching. |
| `rebuildPeopleCollection.js:250-306` | Classifies managed/orphaned/unknown and computes app counts. | v3 People and App Users UI must surface classification and evidence. |
| `rebuildPeopleCollection.js:353-360` | Writes `_summary` and `_appTiers`. | v3 should use DB views/materialized tables for summary and per-app tier counts. |

| `webapp/functions/src/companies/IDCApps/syncIdpAssignments.js`, `IDCApps/users/watchUserUpdated.js`, `IDCApps/users/watchUserDeleted.js` | Keeps app-user/identity state consistent when IdP assignments or users change/delete. | Rebuild deterministic tenant-scoped identity/app-account reconciliation on update/delete. Avoid destructive cross-tenant writes; prefer staged/reviewable reconciliation where matching is ambiguous. | Missing/partial; P1. |
| `frontend-v2/src/context/PeopleMetricsContext.tsx` | Provides people metrics/dashboard state to frontend surfaces. | Rebuild people metrics as server-derived tenant-scoped read models, then expose UX context/hooks only as presentation state. | Missing; P2 unless needed for demo parity. |

### 3.6 Contracts, Gantt, contract writes, app links

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `frontend-v2/src/app/(authenticated)/contracts/page.tsx` | Contract list with search/filter/sort/export/bulk actions. | v3 contract list exists partially; parity requires exact filters, columns, export, and safe deletion/archive. |
| `frontend-v2/src/app/(authenticated)/contracts/[id]/page.tsx` | Contract detail surface with linked apps/files/fields. | v3 detail exists partially; must finish linked files/apps/invoices/history. |
| `frontend-v2/src/app/(authenticated)/contracts/create/page.tsx` | Contract create form. | v3 has create/edit but must maintain field parity and AI/file path. |
| `frontend-v2/src/app/(authenticated)/contracts/gantt/page.tsx` | Renewal/procurement timeline/Gantt. | v3 is missing Gantt/timeline parity. |
| `webapp/functions/src/companies/contracts/contractsDailyCRON.js` | Daily contract lifecycle/update job. | v3 should implement scheduled lifecycle status updates only after lifecycle states are modeled. |
| `webapp/functions/src/linkedDocs/syncLinkedDocs.js` | Syncs linkedDocs relationship snapshots. | v3 needs canonical app-contract/file-invoice link tables and deterministic denormalized summaries. |

### 3.7 Files, inbound data, invoices, AI extraction

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `frontend-v2/src/app/(authenticated)/files/page.tsx` | Files list with file status/metadata. | v3 must rebuild files list/detail/preview beyond storage foundation. |
| `frontend-v2/src/app/(authenticated)/files/[fileId]/page.tsx` | File detail/preview and linked resource display. | v3 needs signed-url previews and linked evidence panels. |
| `frontend-v2/src/app/(authenticated)/files/inbound/page.tsx` | Inbound intake/file import route. | v3 needs safe inbound queue and non-destructive review before canonical writes. |
| `webapp/functions/src/api/v1/ingest/processInboundAPI.js:7-49` | Inbound API reads header token/ingestor id and hands data to helper. | v3 should use hashed/scoped/replay-safe ingest tokens and audit. |
| `webapp/functions/src/api/v1/ingest/helpers/handleIngestData.js:37-50` | Validates incoming token against stored token for external calls. | Do not port direct token comparison; use hash/constant-time/scoped validation. |
| `handleIngestData.js:80-130` | Creates file metadata and stores file bytes under `files/{fileId}`. | v3 must keep row-first upload/finalize pattern and private storage. |
| `webapp/functions/src/files/onFileLinkedToApp.js` | Processes linked userlist files into app-user data. | v3 user imports must be reviewable, idempotent, non-destructive, and audited. |
| `webapp/functions/src/files/onInvoiceLinkedToApp.js` | Processes invoice file links and backfills invoice/app spend. | v3 invoice evidence and spend rollups require this workflow. |
| `webapp/functions/src/storage/processFileWithAI.js:32-75` | Storage trigger starts AI processing for uploaded documents. | v3 AI must run out-of-request and never auto-save without review. |
| `webapp/functions/src/storage/handleDocumentAICompletion.js` | Completes Document AI extraction into structured fields. | Rebuild strict schema validation, suggestion review, and audit. |
| `webapp/functions/src/constants/documentTypes.js` | Defines document types/prompts/fields. | Rebuild a strict prompt/schema registry; contracts and invoices both matter. |
| `frontend-v2/src/components/DocumentAIViewer.tsx` | Review UI for extracted document content. | v3 needs a review UI before AI extraction can be considered parity. |

| `webapp/functions/src/files/fileGroupSync.js`, `webapp/functions/src/files/invoiceGroupSync.js` | Propagates group-scoped access/permissions for files and invoices. | Rebuild explicit group-scoped file/invoice authorization with tests proving access cannot drift, overgrant, or leak cross-tenant. | Missing; authorization-sensitive P1. |
| `frontend-v2/src/components/DocumentViewer.tsx` | General document viewer separate from the AI extraction reviewer. | Rebuild document preview/viewer parity with signed URLs, tenant/resource authorization, safe file type handling, and no public object access. | Missing/partial; P2. |

### 3.8 Invoices, spend, chargeback, billing

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `frontend-v2/src/app/(authenticated)/invoices/page.tsx` | Invoice list with search/filter/export/bulk delete. | v3 needs invoice list/detail and safer deletion/archive semantics. |
| `frontend-v2/src/app/(authenticated)/invoices/[id]/page.tsx` | Invoice detail with linked apps/contracts/files. | Rebuild invoice detail as spend evidence, not just attachment metadata. |
| `frontend-v2/src/app/(authenticated)/IDCApps/[id]/invoices/[invoiceId]/page.tsx` | App-scoped invoice detail. | Preserve app-centric invoice workflow in v3 app detail. |
| `webapp/functions/src/companies/billing/calculateMonthlyBilling.js` | Monthly billing calculation. | Rebuild billing only after invoice/spend/license data exists. |
| `webapp/functions/src/companies/currency/exchangeRateSync.js` | Exchange-rate sync. | v3 needs explicit currency/rate model for spend reports. |
| `webapp/functions/src/shared/money/invoiceProration.js` | Invoice proration. | Port with tests before spend reports. |

### 3.9 Reports, scheduled reports, exports

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `frontend-v2/src/app/(authenticated)/reports/page.tsx` | Reports hub. | Rebuild reports hub only when report data exists. |
| `reports/monthly-procurement/page.tsx` | Monthly procurement report UI. | Rebuild contract procurement report with exports/scheduling. |
| `reports/cost-snapshot/page.tsx` | Cost comparison report. | Rebuild after cost rollups exist. |
| `reports/monthly-snapshot/page.tsx` | Monthly snapshot report. | Rebuild after app/contract/file metrics exist. |
| `reports/user-comparison/page.tsx` | User comparison report. | Rebuild after People/app-user model exists. |
| `reports/it-spend/page.tsx` | IT spend by department report. | Rebuild after invoices/currency/org cost allocation exist. |
| `reports/overlap-analysis/page.tsx` | Overlap analysis report. | Rebuild after app-user/person/license matching exists. |
| `reports/license-analysis/page.tsx:239-338` | License analysis configuration, saved configs, app/license selection. | Rebuild report config persistence and safe report generation. |
| `reports/license-analysis/page.tsx:792-856` | CSV/user/PDF export. | v3 reports need RLS-scoped export actions. |
| `reports/schedules/page.tsx` and `ScheduleDialog.tsx` | Scheduled report UI. | Rebuild scheduled-report configs/runs with tenant-scoped recipients. |
| `webapp/functions/src/email/reportScheduleRunner.js:319-369` | Scheduled/triggered report execution with recipient and role checks. | v3 report scheduler must run out-of-request and audit sends. |
| `webapp/functions/src/email/monthlyProcurementReport.js:10-29`, `:49-84` | Manual/scheduled procurement email, 120-day procurement window. | Preserve procurement-report semantics with explicit tests. |
| `webapp/functions/src/email/monthlySummarySender.js:8-69`, `:146-194` | Monthly summary emails, tokens, summary data. | Rebuild only with safe token model and no secret leakage. |
| `webapp/functions/src/monthlySummaryTokens/confirmMonthlySummary.js`, `getMonthlySummaryByToken.js` | Public/tokened monthly-summary confirmation and read path. | Explicitly rebuild, waive, or defer. If rebuilt, use scoped tokens, expiry, tenant binding, safe public read projection, audit, and no broad report access. Sender-side parity alone is not enough. |

### 3.9a Frontend table/report/document UX support

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `frontend-v2/src/components/DocumentViewer.tsx` | General document viewing/preview UX, separate from `DocumentAIViewer`. | Rebuild document viewer parity for files/contracts/invoices with signed, authorized preview/download behavior. |
| `frontend-v2/src/context/PeopleMetricsContext.tsx` | People metric state/context used by dashboards/people surfaces. | Rebuild people metrics as server-derived facts; client context may cache/display but must not be authority. |
| `frontend-v2/src/hooks/useTableConfig*`, `useTableSort*`, `useUrlFilters*`, `useSavedReportConfigs*` | Persisted table column config, stable sorting, URL-filter state, and saved report/table configurations. | Preserve familiar table/report UX: persisted columns, URL-shareable filters, stable sorts, and saved configs. Treat as product parity even though it is not a backend security surface. |

### 3.10 Connectors, scrapers, generic API, inbound API

**Current v3 correction:** `0030_connector_secret_envelope_columns.sql` is already merged/applied in the current
build and completes the encrypted-envelope schema shape only. PR #160 added the runner-backed store adapter. PR #161
added a staging dry-run harness only. None of these closes RISK-007, proves hosted KMS/IAM separation, or permits real
connector credential storage/use.

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `webapp/functions/src/appScraping/scraperConfigSchema.js:8-64` | Defines 50+ scraper/provider types. | v3 connector backlog must track each provider or an explicit waiver. |
| `scraperConfigSchema.js:81-113` | Base scraper config status/schedule/run metadata. | v3 connector metadata schema should include enabled/type/schedule/status/run counts/error metadata. |
| `scraperConfigSchema.js:119-220+` | Per-scraper settings, including tokens, domains, service account keys, SCIM tokens. | v3 must separate non-secret settings from vault-backed secrets and never leak secret-shaped fields. |
| `scraperConfigManager.js:73-138` | Configure scraper and save credentials. | v3 must split configuration from secret-save; request path must not decrypt. |
| `scraperConfigManager.js:192-226` | Deletes scraper config and credential doc. | v3 revocation/rotation/tombstone must be separately designed; no blind credential delete. |
| `scraperConfigManager.js:231-305` | Merges credentials with existing secret material. | v3 should never read/decrypt old secret to merge in request path; use rotate/add-version workflows. |
| `scraperConfigManager.js:310-330` | Tests credentials and returns validation result. | v3 credential testing requires runner-only secret use and redacted results. |
| `automatedScrapingService.js:68-122` | Maps scraper types to handlers. | v3 connector framework should register providers behind a narrow interface. |
| `automatedScrapingService.js:127-157` | Manual run callable. | v3 manual run should enqueue a runner job, not call provider APIs on request path. |
| `automatedScrapingService.js:162-212` | Scheduled scraper batch and people rebuild after batch. | v3 scheduled connectors should write discovery facts/staging, then trigger safe resolver jobs. |
| `automatedScrapingService.js:218-333` | Executes scrape, pulls private credentials, calls handler, converts users to CSV, uploads via ingest, updates run log. | v3 must keep normalization pipeline but replace credential/read/logging/upload with vault, runner role, discovery facts, and audited run lifecycle. |
| `automatedScrapingService.js:425-478` | Converts arbitrary user objects to CSV. | v3 imports should use typed schemas where possible; CSV is an import/export surface, not the canonical format. |
| `automatedScrapingService.js:481-504` | Creates ingestor token for app-scraper. | v3 token generation must be cryptographically random, hashed, scoped, expiry-aware. |
| `webapp/functions/src/appScraping/scrapers/genericApiScraper.js` | Configurable generic API pagination/response mapping. | Rebuild later as a reviewed connector family; high power/high risk. |
| `DemoFeatures/IDCIngestor/**` | Shell-based ingestors for several apps plus private-key files. | Treat as legacy import examples only. Do not port private keys or scripts directly. |

### 3.11 Admin, groups, permissions, SSO, SCIM

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `frontend-v2/src/app/(authenticated)/company/users/page.tsx` | Company user management. | v3 needs user/admin management UI with no self-promotion path. |
| `company/groups/page.tsx`, `company/groups/[groupId]/page.tsx` | Groups and group membership management. | Rebuild group/org/resource membership admin with RLS checks. |
| `webapp/functions/src/groups/groupManagement.js` | Group CRUD, membership, role updates, claims refresh. | v3 equivalent must be DB-authoritative and audited. |
| `webapp/functions/src/groups/permissionSync.js` | Synchronizes resource permission subcollections. | v3 should avoid denormalized permission drift; use relational joins/RLS policies. |
| `webapp/functions/src/groups/linkedResourceSync.js` | Keeps linked resources/groups in sync. | v3 linked resources should use relational tables and tested cascades. |
| `frontend-v2/src/app/(authenticated)/admin/sso/page.tsx` | SSO/SCIM admin screen. | v3 needs enterprise SSO/SCIM later; do not fake readiness. |
| `frontend-v2/src/services/samlAuth.ts`, `oidcAuth.ts` | SAML/OIDC frontend services. | Rebuild only after auth design; no client-side auth bypass. |
| `frontend-v2/src/app/sso-callback/page.tsx:11-76` | Handles SP-initiated and IdP-initiated SAML callback. | v3 needs server-validated callback/session exchange. |
| `webapp/functions/src/scim/scimTokenManager.js:15-37` | Generates SCIM token hash and returns plaintext token once. | v3 SCIM tokens should be hashed, scoped, rotatable/revocable, audited. |
| `webapp/functions/src/scim/scimMiddleware.js` | Bearer token auth and SCIM validation. | Rebuild with tenant-scoped token lookup and constant-time compare. |
| `webapp/functions/src/scim/index.js:89-119`, `:252-391` | SCIM service provider config/schema and user create/get/list/update/patch/delete. | v3 SCIM must be backed by users/people/roles model and audited. |
| `webapp/functions/src/auth/blockingAuth.js`, `onUserCreate.js`, `emailVerification.js` | Signup blocking, custom claim setup, verification. | v3 auth lifecycle must be explicit; no unreviewed auto-provision. |

### 3.12 Audit, logging, recompute, maintenance, migration, extension

| Old code | What it does | v3 rebuild requirement |
|---|---|---|
| `frontend-v2/src/app/(authenticated)/logging/page.tsx`, `logging/[logId]/page.tsx` | Audit list/detail UI with action/type filters. | v3 audit table exists but viewer parity is missing. |
| `webapp/functions/src/logging/logChange.js:3-37` | Writes logs and intentionally does not fail business action if logging fails. | v3 audit should be transactionally reliable for sensitive writes where possible. |
| `webapp/functions/src/logging/cleanupOldLogs.js:7-38` | Deletes logs older than 90 days. | Do not port destructive purge without archival/retention approval. |
| `frontend-v2/src/app/(authenticated)/admin/recompute/page.tsx` | Manual recompute UI. | v3 needs safe recompute/admin jobs after metrics exist. |
| `webapp/functions/src/companies/aggregates/manualRecompute.js` | Recompute backend job. | Rebuild as idempotent, tenant-scoped, auditable job. |
| `webapp/functions/src/maintenance/*.js` | AI repair, orphaned links cleanup, migration of user lists. | Rebuild only after equivalent tables exist; no broad cleanup jobs without dry-run/preview. |
| `webapp/functions/src/migration/*.js`, `migrations/*.js` | Legacy migration utilities. | v3 migration plan must be non-destructive, staged, reconciled, and never migrate secrets. |
| `extension/*` | Chrome extension auth/content/popup. | Decide explicitly: rebuild, waive, or defer; do not silently forget. |

---

### 3.13 Route/product gap snapshot

The old app has `48` `page.*` route/page files versus a much smaller v3 route surface at this checkpoint. v3 is
currently front-loaded on the secure backend and connector-vault foundation. That is correct sequencing, but it is not
full UX parity.

Known missing or incomplete route/product areas include invoices, billing, SSO/SCIM, contracts Gantt, app insights
(ELU/stale/UAR), the full reports suite, dashboard widgets, files detail/inbound flows, company/groups, profile,
people risks/settings, persisted table/report UX, and the Chrome extension/API-key surface. Each must be built,
explicitly waived, or explicitly deferred before old-app replacement.

## 4. Build-order implications for v3

| Order | Why it comes here | Build target | Must not claim |
|---|---|---|---|
| 1 | Connector secrets are the highest-risk prerequisite for live provider ingestion. | Schema shape through `0030`, runner-backed `connector_secrets` store adapter (#160), staging dry-run harness (#161), then human-run hosted synthetic evidence and hosted KMS/IAM proof. | Do not claim real credential readiness. |
| 2 | App detail is where old-app workflows converge. | App detail parity: linked contracts, app users, identity tier, license matches, invoices, compliance, files, config panels. | Do not treat `/apps/[id]` read-only as parity. |
| 3 | License waste is the clearest business value. | License rules, user-license assignment, fixed/elastic seat math, vacancy/stale waste, rollups, tests. | Do not duplicate old client math as authority. |
| 4 | People/UAR unlocks unmanaged/shadow/stale reporting. | People directory, app-user identity evidence, managed/orphaned/unknown, UAR risk views. | Do not silently merge fuzzy matches. |
| 5 | Files/invoices are evidence inputs to contracts/spend/AI. | Files list/detail/preview, invoice upload/review/linking, user-list import queue. | Do not auto-apply AI or import destructively. |
| 6 | Reports depend on the underlying facts. | Procurement, cost snapshot, monthly snapshot, user comparison, IT spend, overlap, license analysis, schedules. | Do not ship empty reports. |
| 7 | Admin/SSO/SCIM/billing depend on stable users/orgs/data. | Groups, users, SSO/SCIM, billing, audit viewer, recompute. | Do not claim enterprise parity before these exist. |
| 8 | Cutover requires data movement and acceptance. | Migration tools, rollback rehearsal, OMC signoff. | Do not migrate into missing surfaces or migrate secrets. |

---

## 5. Forget-nothing checklist

Every item below must become `built+verified`, `removed-approved`, `deprecated-approved`, or `OMC-waived` before
old-app replacement. Default is **blocker**.

- Shell/nav: full sidebar IA, active states, role-gated display, user menu/version.
- Auth/profile: email/password, SSO callback, password reset, email verification, terms acceptance, profile page.
- Dashboard: home cards, quick links, custom dashboards, chart widgets, saved configs.
- Apps: list/create/edit/archive, filters, categories, cost period/type, data-source status, contract summary,
  user counts, ELU, waste, renewal/procurement dates, setup action.
- App detail: general info, group access, contract/cost management, invoices, compliance reviews, license rules,
  app users table, CSV export, CSV upload, owner pickers, admin config panels.
- App insights: utilization, unmanaged/UAR, stale/sync health.
- People: directory, risk view, settings, identity matching, app accounts, identity-change cascades, managed/orphaned/unknown, summaries, people metrics context.
- Contracts: list/detail/create/edit, Gantt, app links, files, renewal/procurement lifecycle, exports.
- Files: list/detail/inbound, upload, preview/download, document viewer, linked resources, group-scoped access propagation, AI status, retry/failure, signed URLs.
- Invoices: list/detail/app-scoped detail, invoice file processing, spend rollups, currency/proration.
- Reports: hub, procurement, cost snapshot, monthly snapshot, public/tokened monthly-summary view, user comparison, IT spend, overlap, license analysis,
  persisted table state, URL filters, saved report configs, scheduled report runs, PDF/CSV/user exports.
- AI: Document AI/Vertex path, document type schemas/prompts, completion handler, stuck-operation repair, review UI.
- Connectors: scraper config, per-provider settings, generic API, app handlers, manual/scheduled runs, run logs,
  normalization into discovery facts/imports, app+user+usage data, no real tokens until vault proven.
- Inbound API/imports: ingestor tokens, inbound email tokens, API/file userlist ingestion, non-destructive previews.
- External API/plugin: external API-key issuance, hashing, rotation/revocation, Chrome-plugin endpoints, scoped projections, rate limits, audit, rebuild/waive/defer decision.
- Admin/security: groups, memberships, company users, invite email lifecycle, role updates, permission sync, file/invoice group propagation, company settings, billing.
- Enterprise: SSO/SAML/OIDC, SCIM service provider config, token generation/revocation/status, SCIM CRUD/PATCH.
- Audit/ops: activity logs, log detail, immutable audit, recompute, maintenance jobs, link cleanup, migration tools,
  rollback, version endpoint.
- Extension/demo tools: Chrome extension and shell ingestors must be rebuilt, waived, or explicitly removed.

---

## 6. Old frontend route inventory (all route files found)

| Old route | Old file | Lines |
|---|---|---|
| `/IDCApps/:id/invoices/:invoiceId` | `frontend-v2/src/app/(authenticated)/IDCApps/[id]/invoices/[invoiceId]/page.tsx` | `531` |
| `/IDCApps/:id` | `frontend-v2/src/app/(authenticated)/IDCApps/[id]/page.tsx` | `1776` |
| `/IDCApps/insights/elu` | `frontend-v2/src/app/(authenticated)/IDCApps/insights/elu/page.tsx` | `518` |
| `/IDCApps/insights/stale` | `frontend-v2/src/app/(authenticated)/IDCApps/insights/stale/page.tsx` | `352` |
| `/IDCApps/insights/uar` | `frontend-v2/src/app/(authenticated)/IDCApps/insights/uar/page.tsx` | `629` |
| `/IDCApps` | `frontend-v2/src/app/(authenticated)/IDCApps/page.tsx` | `638` |
| `/IDCApps/scraping` | `frontend-v2/src/app/(authenticated)/IDCApps/scraping/page.tsx` | `265` |
| `/IDCApps/settings` | `frontend-v2/src/app/(authenticated)/IDCApps/settings/page.tsx` | `243` |
| `/admin/billing/invoice/:id` | `frontend-v2/src/app/(authenticated)/admin/billing/invoice/[id]/page.tsx` | `306` |
| `/admin/billing` | `frontend-v2/src/app/(authenticated)/admin/billing/page.tsx` | `345` |
| `/admin/company` | `frontend-v2/src/app/(authenticated)/admin/company/page.tsx` | `286` |
| `/admin/recompute` | `frontend-v2/src/app/(authenticated)/admin/recompute/page.tsx` | `277` |
| `/admin/sso` | `frontend-v2/src/app/(authenticated)/admin/sso/page.tsx` | `662` |
| `/company/groups/:groupId` | `frontend-v2/src/app/(authenticated)/company/groups/[groupId]/page.tsx` | `692` |
| `/company/groups` | `frontend-v2/src/app/(authenticated)/company/groups/page.tsx` | `192` |
| `/company/users` | `frontend-v2/src/app/(authenticated)/company/users/page.tsx` | `790` |
| `/contracts/:id` | `frontend-v2/src/app/(authenticated)/contracts/[id]/page.tsx` | `775` |
| `/contracts/create` | `frontend-v2/src/app/(authenticated)/contracts/create/page.tsx` | `283` |
| `/contracts/gantt` | `frontend-v2/src/app/(authenticated)/contracts/gantt/page.tsx` | `611` |
| `/contracts` | `frontend-v2/src/app/(authenticated)/contracts/page.tsx` | `628` |
| `/dashboards/:id` | `frontend-v2/src/app/(authenticated)/dashboards/[id]/page.tsx` | `211` |
| `/dashboards/create` | `frontend-v2/src/app/(authenticated)/dashboards/create/page.tsx` | `184` |
| `/dashboards` | `frontend-v2/src/app/(authenticated)/dashboards/page.tsx` | `123` |
| `/files/:fileId` | `frontend-v2/src/app/(authenticated)/files/[fileId]/page.tsx` | `448` |
| `/files/inbound` | `frontend-v2/src/app/(authenticated)/files/inbound/page.tsx` | `444` |
| `/files` | `frontend-v2/src/app/(authenticated)/files/page.tsx` | `454` |
| `/invoices/:id` | `frontend-v2/src/app/(authenticated)/invoices/[id]/page.tsx` | `332` |
| `/invoices` | `frontend-v2/src/app/(authenticated)/invoices/page.tsx` | `328` |
| `/logging/[logId]` | `frontend-v2/src/app/(authenticated)/logging/[logId]/page.tsx` | `170` |
| `/logging` | `frontend-v2/src/app/(authenticated)/logging/page.tsx` | `226` |
| `/` | `frontend-v2/src/app/(authenticated)/page.tsx` | `387` |
| `/people` | `frontend-v2/src/app/(authenticated)/people/page.tsx` | `875` |
| `/people/risks` | `frontend-v2/src/app/(authenticated)/people/risks/page.tsx` | `529` |
| `/people/settings` | `frontend-v2/src/app/(authenticated)/people/settings/page.tsx` | `312` |
| `/profile` | `frontend-v2/src/app/(authenticated)/profile/page.tsx` | `263` |
| `/reports/cost-snapshot` | `frontend-v2/src/app/(authenticated)/reports/cost-snapshot/page.tsx` | `508` |
| `/reports/it-spend` | `frontend-v2/src/app/(authenticated)/reports/it-spend/page.tsx` | `623` |
| `/reports/license-analysis` | `frontend-v2/src/app/(authenticated)/reports/license-analysis/page.tsx` | `1641` |
| `/reports/monthly-procurement` | `frontend-v2/src/app/(authenticated)/reports/monthly-procurement/page.tsx` | `113` |
| `/reports/monthly-snapshot` | `frontend-v2/src/app/(authenticated)/reports/monthly-snapshot/page.tsx` | `638` |
| `/reports/overlap-analysis` | `frontend-v2/src/app/(authenticated)/reports/overlap-analysis/page.tsx` | `1378` |
| `/reports` | `frontend-v2/src/app/(authenticated)/reports/page.tsx` | `195` |
| `/reports/schedules` | `frontend-v2/src/app/(authenticated)/reports/schedules/page.tsx` | `401` |
| `/reports/user-comparison` | `frontend-v2/src/app/(authenticated)/reports/user-comparison/page.tsx` | `864` |
| `/users` | `frontend-v2/src/app/(authenticated)/users/page.tsx` | `5` |
| `/forgot-password` | `frontend-v2/src/app/forgot-password/page.tsx` | `112` |
| `/login` | `frontend-v2/src/app/login/page.tsx` | `325` |
| `/sso-callback` | `frontend-v2/src/app/sso-callback/page.tsx` | `104` |

---

## 7. Old Cloud Functions source inventory (all non-test source files found)

Each file below is either a rebuild source, a legacy-only anti-pattern to avoid, or a candidate for explicit waiver.
Do not silently ignore any module.

### api

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/api/apiHelperFunctions.js` | `35` |
| `webapp/functions/src/api/chromePluginFunction.js` | `176` |
| `webapp/functions/src/api/createAPIKeyFunction.js` | `52` |
| `webapp/functions/src/api/v1/apps/get_apps.js` | `52` |
| `webapp/functions/src/api/v1/ingest/deleteInboundEmailToken.js` | `53` |
| `webapp/functions/src/api/v1/ingest/generateInboundEmailToken.js` | `50` |
| `webapp/functions/src/api/v1/ingest/generateIngestorToken.js` | `70` |
| `webapp/functions/src/api/v1/ingest/helpers/handleIngestData-single-tenant.js` | `121` |
| `webapp/functions/src/api/v1/ingest/helpers/handleIngestData.js` | `131` |
| `webapp/functions/src/api/v1/ingest/processInboundAPI.js` | `49` |
| `webapp/functions/src/api/v1/ingest/processInboundEmail.js` | `126` |

### appScraping

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/appScraping/app_handlers/fetchGenericAPIApps.js` | `5` |
| `webapp/functions/src/appScraping/app_handlers/fetchOktaApps.js` | `33` |
| `webapp/functions/src/appScraping/automatedScrapingService.js` | `508` |
| `webapp/functions/src/appScraping/handlers/fetchAtlassianUsers.js` | `117` |
| `webapp/functions/src/appScraping/handlers/fetchGenericAPIUsers.js` | `5` |
| `webapp/functions/src/appScraping/handlers/fetchOktaAppUsers.js` | `71` |
| `webapp/functions/src/appScraping/handlers/fetchTableauUsers.js` | `74` |
| `webapp/functions/src/appScraping/sanitizeObjectForFirebase.js` | `47` |
| `webapp/functions/src/appScraping/scraperConfigManager.js` | `582` |
| `webapp/functions/src/appScraping/scraperConfigSchema.js` | `433` |
| `webapp/functions/src/appScraping/scrapers/alicloudScraper.js` | `127` |
| `webapp/functions/src/appScraping/scrapers/apolloScraper.js` | `91` |
| `webapp/functions/src/appScraping/scrapers/asanaScraper.js` | `118` |
| `webapp/functions/src/appScraping/scrapers/astronomerScraper.js` | `91` |
| `webapp/functions/src/appScraping/scrapers/auth0Scraper.js` | `104` |
| `webapp/functions/src/appScraping/scrapers/awsScraper.js` | `110` |
| `webapp/functions/src/appScraping/scrapers/circleciScraper.js` | `62` |
| `webapp/functions/src/appScraping/scrapers/cloudflareScraper.js` | `95` |
| `webapp/functions/src/appScraping/scrapers/contentfulScraper.js` | `103` |
| `webapp/functions/src/appScraping/scrapers/databricksScraper.js` | `126` |
| `webapp/functions/src/appScraping/scrapers/datadogScraper.js` | `99` |
| `webapp/functions/src/appScraping/scrapers/datarobotScraper.js` | `112` |
| `webapp/functions/src/appScraping/scrapers/dialpadScraper.js` | `139` |
| `webapp/functions/src/appScraping/scrapers/dockerhubScraper.js` | `83` |
| `webapp/functions/src/appScraping/scrapers/domoScraper.js` | `149` |
| `webapp/functions/src/appScraping/scrapers/dropboxScraper.js` | `69` |
| `webapp/functions/src/appScraping/scrapers/egnyteScraper.js` | `101` |
| `webapp/functions/src/appScraping/scrapers/figmaScraper.js` | `157` |
| `webapp/functions/src/appScraping/scrapers/freshworksScraper.js` | `90` |
| `webapp/functions/src/appScraping/scrapers/genericApiScraper.js` | `1078` |
| `webapp/functions/src/appScraping/scrapers/githubEnterpriseScraper.js` | `138` |
| `webapp/functions/src/appScraping/scrapers/githubScraper.js` | `137` |
| `webapp/functions/src/appScraping/scrapers/gongScraper.js` | `102` |
| `webapp/functions/src/appScraping/scrapers/googleScraper.js` | `459` |
| `webapp/functions/src/appScraping/scrapers/greenhouseScraper.js` | `98` |
| `webapp/functions/src/appScraping/scrapers/hubspotScraper.js` | `97` |
| `webapp/functions/src/appScraping/scrapers/intercomScraper.js` | `94` |
| `webapp/functions/src/appScraping/scrapers/jiraScraper.js` | `84` |
| `webapp/functions/src/appScraping/scrapers/launchdarklyScraper.js` | `83` |
| `webapp/functions/src/appScraping/scrapers/lucidchartScraper.js` | `151` |
| `webapp/functions/src/appScraping/scrapers/marketoScraper.js` | `108` |
| `webapp/functions/src/appScraping/scrapers/merakiScraper.js` | `69` |
| `webapp/functions/src/appScraping/scrapers/microsoft365Scraper.js` | `146` |
| `webapp/functions/src/appScraping/scrapers/mixpanelScraper.js` | `79` |
| `webapp/functions/src/appScraping/scrapers/mongodbScraper.js` | `108` |
| `webapp/functions/src/appScraping/scrapers/n8nScraper.js` | `142` |
| `webapp/functions/src/appScraping/scrapers/notionScraper.js` | `151` |
| `webapp/functions/src/appScraping/scrapers/octopusScraper.js` | `94` |
| `webapp/functions/src/appScraping/scrapers/oktaScraper.js` | `191` |
| `webapp/functions/src/appScraping/scrapers/pagerdutyScraper.js` | `107` |
| `webapp/functions/src/appScraping/scrapers/productboardScraper.js` | `111` |
| `webapp/functions/src/appScraping/scrapers/retoolScraper.js` | `84` |
| `webapp/functions/src/appScraping/scrapers/salesforceScraper.js` | `233` |
| `webapp/functions/src/appScraping/scrapers/salesloftScraper.js` | `87` |
| `webapp/functions/src/appScraping/scrapers/servicenowScraper.js` | `87` |
| `webapp/functions/src/appScraping/scrapers/sigmaScraper.js` | `90` |
| `webapp/functions/src/appScraping/scrapers/slackScraper.js` | `172` |
| `webapp/functions/src/appScraping/scrapers/tableauScraper.js` | `173` |
| `webapp/functions/src/appScraping/scrapers/workdayScraper.js` | `65` |
| `webapp/functions/src/appScraping/scrapers/wrikeScraper.js` | `114` |
| `webapp/functions/src/appScraping/scrapers/zapierScraper.js` | `92` |
| `webapp/functions/src/appScraping/scrapers/zendeskScraper.js` | `87` |
| `webapp/functions/src/appScraping/scrapers/zoomScraper.js` | `75` |
| `webapp/functions/src/appScraping/syncAppApps.js` | `98` |

### auth

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/auth/blockingAuth.js` | `61` |
| `webapp/functions/src/auth/emailVerification.js` | `90` |
| `webapp/functions/src/auth/onUserCreate.js` | `100` |
| `webapp/functions/src/auth/roleChecks.js` | `39` |

### companies

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/companies/IDCApps/calculateFieldValues/calculateFieldValues.js` | `149` |
| `webapp/functions/src/companies/IDCApps/calculateFieldValues/previewFieldCalculation.js` | `270` |
| `webapp/functions/src/companies/IDCApps/calculateFieldValues/runFieldCalculations.js` | `177` |
| `webapp/functions/src/companies/IDCApps/licenses/evaluateUserLicenses.js` | `341` |
| `webapp/functions/src/companies/IDCApps/licenses/onLicenseWrite.js` | `51` |
| `webapp/functions/src/companies/IDCApps/private/setAppPrivateData.js` | `62` |
| `webapp/functions/src/companies/IDCApps/syncIdpAssignments.js` | `146` |
| `webapp/functions/src/companies/IDCApps/users/watchUserDeleted.js` | `59` |
| `webapp/functions/src/companies/IDCApps/users/watchUserUpdated.js` | `136` |
| `webapp/functions/src/companies/IDCApps/watchAppDeleted.js` | `38` |
| `webapp/functions/src/companies/aggregates/manualRecompute.js` | `80` |
| `webapp/functions/src/companies/billing/calculateMonthlyBilling.js` | `139` |
| `webapp/functions/src/companies/contracts/contractsDailyCRON.js` | `46` |
| `webapp/functions/src/companies/currency/exchangeRateSync.js` | `58` |
| `webapp/functions/src/companies/helperFunctions.js` | `60` |
| `webapp/functions/src/companies/people/rebuildPeopleCollection.js` | `425` |
| `webapp/functions/src/companies/users/userCRUD.js` | `392` |

### constants

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/constants/defaultFieldDefinitions.js` | `4` |
| `webapp/functions/src/constants/documentTypes.js` | `158` |

### email

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/email/emailUtils.js` | `239` |
| `webapp/functions/src/email/migrateReportSchedules.js` | `123` |
| `webapp/functions/src/email/monthlyProcurementReport.js` | `132` |
| `webapp/functions/src/email/monthlySummarySender.js` | `302` |
| `webapp/functions/src/email/reportScheduleRunner.js` | `374` |
| `webapp/functions/src/email/reportTemplates.js` | `238` |
| `webapp/functions/src/email/sendInviteEmail.js` | `132` |

### files

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/files/fileGroupSync.js` | `251` |
| `webapp/functions/src/files/invoiceGroupSync.js` | `118` |
| `webapp/functions/src/files/onDeleteFirestoreFileDoc.js` | `42` |
| `webapp/functions/src/files/onFileLinkedToApp.js` | `565` |
| `webapp/functions/src/files/onInvoiceLinkedToApp.js` | `566` |

### groups

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/groups/groupManagement.js` | `410` |
| `webapp/functions/src/groups/linkedResourceSync.js` | `195` |
| `webapp/functions/src/groups/permissionSync.js` | `270` |

### linkedDocs

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/linkedDocs/syncLinkedDocs.js` | `318` |

### logging

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/logging/appOnWriteLog.js` | `80` |
| `webapp/functions/src/logging/cleanupOldLogs.js` | `71` |
| `webapp/functions/src/logging/contractOnWrite.js` | `69` |
| `webapp/functions/src/logging/fileOnWrite.js` | `64` |
| `webapp/functions/src/logging/logChange.js` | `39` |

### maintenance

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/maintenance/checkDocumentAIOperations.js` | `106` |
| `webapp/functions/src/maintenance/cleanupOrphanedLinks.js` | `251` |
| `webapp/functions/src/maintenance/migrateUserListsToLinkedDocs.js` | `206` |

### migration

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/migration/migrateFilesToNewStructure.js` | `187` |

### migrations

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/migrations/migrateToPermissionSubcollections.js` | `173` |

### monthlySummaryTokens

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/monthlySummaryTokens/confirmMonthlySummary.js` | `90` |
| `webapp/functions/src/monthlySummaryTokens/getMonthlySummaryByToken.js` | `128` |

### resources

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/resources/resourceValidation.js` | `160` |

### scheduled

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/scheduled/checkStuckAiProcessing.js` | `48` |

### scheduledJobs

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/scheduledJobs/generateReportRuns.js` | `113` |
| `webapp/functions/src/scheduledJobs/monthly.js` | `164` |
| `webapp/functions/src/scheduledJobs/nightly.js` | `107` |

### scim

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/scim/index.js` | `516` |
| `webapp/functions/src/scim/scimMiddleware.js` | `382` |
| `webapp/functions/src/scim/scimTokenManager.js` | `123` |

### shared

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/shared/constants/fieldDefinitions.js` | `904` |
| `webapp/functions/src/shared/constants/identityStatus.js` | `104` |
| `webapp/functions/src/shared/money/appMetrics.js` | `202` |
| `webapp/functions/src/shared/money/criteriaEvaluation.js` | `79` |
| `webapp/functions/src/shared/money/invoiceProration.js` | `186` |
| `webapp/functions/src/shared/money/licenseStats.js` | `251` |
| `webapp/functions/src/shared/runtime/fieldCalcEngine.js` | `850` |
| `webapp/functions/src/shared/utils/computedFields.js` | `231` |

### storage

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/storage/handleDocumentAICompletion.js` | `119` |
| `webapp/functions/src/storage/onDeleteStorageFile.js` | `44` |
| `webapp/functions/src/storage/processFileWithAI.js` | `337` |

### system

| Old function source file | Lines |
|---|---:|
| `webapp/functions/src/system/getAppVersion.js` | `11` |

---

## 8. Cross-references and risk posture

This doc sharpens [39](./39_OLD_APP_DIRECT_INSPECTION_INVENTORY.md), [40](./40_CODE_DERIVED_OLD_APP_INVENTORY.md),
and [41](./41_FULL_PARITY_IMPLEMENTATION_ROADMAP.md). If this doc reveals a capability absent from doc 27/33/41,
update those docs or record an explicit waiver. The default assumption is still full old-app parity before cutover.

**This doc does not close any risk. RISK-007 remains OPEN. RISK-001 remains OPEN. Cutover remains BLOCKED.**

**Operational rule:** while rebuilding v3, consult this ledger before each feature PR. If an old-app capability is only
listed in an appendix, promote it to a requirement row or record a written rebuild/waive/defer decision before claiming
that product area is complete.
