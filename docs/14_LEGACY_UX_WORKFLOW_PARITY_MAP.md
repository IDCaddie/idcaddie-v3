# 14 · Legacy UX & Workflow Parity Map

**Canonical source for: the legacy→v3 parity *contract* — what "same product, better backend" means
and the hard gate it imposes on cutover.** This doc **defines** parity; it does **not** implement it.
Capability/status tracking lives in [11_LEGACY_PARITY_AND_OMC_CHECKLIST](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md)
(the scorecard); this doc is the finer-grained **per-workflow UX contract** and the release rule.

> **Release rule (the one that governs cutover):** v3 may **not** cut OMC/Flywheel (or onboard a new
> paid customer) over from legacy until **every legacy workflow a real user actually uses** is one of:
> (a) **rebuilt in v3 with the same user-facing experience**, (b) **replaced by an explicitly approved
> better workflow**, or (c) **intentionally removed with explicit approval**. **Backend readiness alone
> — RLS passing, migrations applied — is NOT sufficient.** OMC/Flywheel cutover and new paid-customer
> onboarding remain **blocked** ([00](./00_PRODUCT_STATUS.md), §5).

## 1. Doctrine
- **Same product experience.** Users open v3 and feel *"this is the same ID Caddie I know."*
- **Better backend.** Real tenant isolation, RLS, append-only audit, non-destructive imports,
  same-tenant integrity, no hard deletes, better auth/session, safer exports, cleaner schema —
  the legacy P0s ([current-security-risk-map.md](./current-security-risk-map.md)) are fixed.
- **No user-visible regression.** Frontend/workflow **parity**; backend **replacement**. Security and
  backend improvements are *required*, but they must **not** break a user's muscle memory (the fields,
  buttons, filters, labels, sort order, report outputs they rely on) **without explicit approval**.
- **Direction of change:** copy the legacy *experience*, **not** the legacy *implementation*. Never
  reproduce a legacy backend anti-pattern (client-side filtering as security, mutable audit, blind
  delete-on-import, plaintext credentials) to "match" — those are exactly what v3 exists to fix.

## 2. Definitions
| Term | Meaning |
|---|---|
| **Same** | v3 reproduces the legacy workflow with the **same user-facing experience** — equivalent fields shown, actions/buttons, filters/sorts/search, and report/export outputs. Backend may differ (and should be safer); the *user* sees no regression. |
| **Better but approved** | v3 intentionally differs from legacy in a way that is **documented and approved** by the product owner (e.g. preview-before-import instead of blind delete). An *unapproved* "better" is a regression risk, not parity. |
| **Missing** | A legacy workflow real users rely on that v3 does **not** yet provide (no equivalent, or only a read-only subset). A `P0/P1` Missing item is a **cutover blocker**. |
| **Intentionally removed** | A legacy workflow deliberately dropped, with **explicit documented approval** (e.g. the vendor-enrichment Chrome extension pending privacy review). Without approval, removal is a regression, not a decision. |
| **Cutover blocker** | A Missing or unapproved-different `P0/P1` workflow that **must** be Same / Better-approved / Removed-approved before OMC/Flywheel (or a new paid customer matching that profile) can cut over. |
| **Backend-only improvement** | A change with **no user-visible difference** — RLS, audit triggers, FKs, types, server-session. Allowed and encouraged without product approval (still needs the normal docs/test/PR discipline). |
| **User-visible change** | Any change a user can *perceive*: a field added/removed/relabeled, a button moved/renamed, a different filter/sort/default, a different export column set, a changed navigation path. **Requires approval** (§6). |
| **Legacy workflow parity** | The full set: the user can accomplish the **same goal**, via the **same steps**, seeing the **same information** and getting the **same outputs** as in legacy — or an approved better version. |
| **Exact output parity** | Reports/exports/CSV produce the **same columns, ordering, and semantics** a user/downstream consumer depends on. Asserted **only** where the legacy output is documented/inspected; otherwise `needs legacy inspection` (do not promise it blind). |
| **Approved replacement** | A "Better but approved" workflow that **supersedes** the legacy one (the legacy version is intentionally not rebuilt). |

## 3. Legacy route/screen parity map
Legacy *routes/goals* are from documented evidence ([11](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md); the
legacy source `frontend-v2/`,`webapp/`,`extension/` lives **outside** this repo). **Exact legacy fields,
button labels, filters, sort orders, and export formats are NOT in this repo** — they are marked
**`needs legacy inspection`** and must be captured from the running legacy app before a parity claim is
made. **Do not invent them.** Parity status: `Same` · `Better-approved` · `Partial` (read-only/subset) ·
`Missing` · `Not-started` · `Removed-approved`.

| Legacy route/screen | Legacy user goal | Legacy fields shown | Legacy buttons/actions | Legacy filters/sorts/search | Legacy reports/exports | Current v3 equivalent | Backend improvement in v3 | Parity status | Missing gap | Cutover blocker | Notes/evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `login/page.tsx` (+ `samlAuth.ts`, `oidcAuth.ts`, `AuthGuard.tsx`) | Sign in (email/pw + SAML + OIDC) | needs legacy inspection | sign-in; SSO buttons (labels: needs inspection) | n/a | n/a | `/login` email/pw + server session (Proxy) — PR #6 | server-side session + RLS, not a client `AuthGuard` | **Partial** | SAML/OIDC SSO not built; not exercised vs hosted Supabase Auth | **Yes** (if customer uses SSO) | [11] auth row |
| `IDCApps/page.tsx` | See the app inventory (cost, license util, user metrics) + CSV export | needs legacy inspection (incl. cost/license/user-metric columns) | needs inspection; CSV export | needs legacy inspection (filters/sort/search) | CSV export (format: needs inspection) | `/apps` read-only list (name/vendor/category/status) — PR #13 | RLS-scoped reads, no client filtering | **Partial** | cost / license util / user metrics columns; filters/sort/search; CSV export | **Yes** | [11] app-inventory row |
| `IDCApps/[id]/page.tsx` | Drill into one app (metadata, roster, linked contracts/invoices, license rules) | needs legacy inspection | needs inspection | n/a | needs inspection | `/apps/[id]` read-only metadata + owning-org IDs + roster + match status + account summary (PR #14/#21/#23/#24) | RLS-scoped; route id lookup-only not authz | **Partial** | org *names* (only IDs); linked contracts/invoices/files/license rules; edit | **Yes** | [11] app-detail row |
| `IDCApps/[id]/page.tsx` (users table) | Per-app account roster | needs legacy inspection | needs inspection | needs inspection | needs inspection | read-only "App users" roster on `/apps/[id]` — PR #21 | `0007` org-scoped read, no PII leak | **Partial** | matching/provisioning/utilization columns + actions | **Yes** | [11] app-users row |
| `contracts/page.tsx`, `IDCApps/[id]/page.tsx` (`linkedDocs.IDCApps`) | Link apps↔contracts; cost-allocation % | needs legacy inspection | link / unlink; set cost-allocation % | needs inspection | n/a | read-only linked-apps/contracts panels — PR #20 | `0006`/`0009` org-scoped read, tenant-bound | **Partial** | link/unlink actions; cost-allocation % | **Yes** | [11] app-contract-linking row |
| `contracts/page.tsx` | List contracts (renewal/expiry dates) | needs legacy inspection | needs inspection | needs inspection | needs inspection | `/contracts` read-only list (name/vendor/status/renewal/end) — PR #19 | related-org RLS read | **Partial** | filters/sort/search; any missing columns | **Yes** | [11] contracts row |
| `contracts/[id]/page.tsx` | View one contract | name/status/dates/cost (`fieldDefinitions`) | view; **Edit** (link → `/edit`) | n/a | n/a | `/contracts/[id]` read-only detail + **Edit** link (PR #19/#20/#31) | related-org RLS read | **Partial** | org names; invoices/files; gantt | **Yes** | [11] contracts row; [15] |
| `contracts/create/` | Create a contract | **inspected ([15])**: name\*, status (Draft/Executed/Cancelled/Expired), category, monthlyCost, start/expiry/procurement/renewal dates, notes + Upload-PDF/AI tab | Create Contract; back→list; save→detail | n/a | n/a | **`/contracts/new` create form (PR #31)** + **parity fields** category/procurement_date/notes/po_number/auto_renew/month_to_month (PR #32, `0011`), on the #30 RLS-gated path, audited (`0010`); RLS is the boundary (not client role) | steward/editor write; `tenant_id` server-resolved; audit via DB trigger | **Partial** | legacy `commodity_*` (hidden) + `validated` (read-only) have no v3 column; the **Upload-PDF/AI tab is DESIGNED ([16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md), PR #33) but not built** ([15](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)) | **Yes** | [13]/[15]/[16]; [11] contracts row |
| `contracts/[id]/` (edit) | Edit a contract | same field set ([15]); legacy edits **inline** on detail | save/edit; **Delete** (NOT ported) | n/a | n/a | **`/contracts/[id]/edit` (PR #31 + #32 fields)** — dedicated route (legacy inline), posts to `updateContractAction` (PATCH; `tenant_id` immutable) | steward/editor write; denied save → generic (no enumeration) | **Partial** | same remaining gaps as create (`commodity_*`/`validated`/PDF-AI); legacy hard-delete intentionally **not** ported | **Yes** | [13]/[15] |
| `contracts/gantt/` | Renewal timeline / gantt view | needs legacy inspection | needs inspection | needs inspection (date range) | needs inspection | none | n/a (read model exists) | **Missing** | the gantt/renewal-timeline view | **Yes** (if users rely on it) | [11] contracts row |
| `people/page.tsx` | Unified people directory (IdP + app-only) | needs legacy inspection | needs inspection | needs inspection | needs inspection | none — `people` is **tenant-only** read; intentionally **not** org-scoped (doc 12) | RLS tenant-only; no tenant-wide HR leak to org users | **Not-started** | the directory surface (tenant-admin scope) | **Yes** (if directory is a used workflow) | [11] people row; [12] |
| `people/settings/page.tsx`, `syncIdpAssignments.js` | View/manage IdP identity accounts | needs legacy inspection | needs inspection | needs inspection | needs inspection | none — `identity_accounts` **default-deny** (doc 12: no app anchor → not org-scopable) | RLS default-deny; no IdP directory leak | **Not-started** | a tenant-scoped admin identity surface | **Yes** (if used) | [11] identity-accounts row; [12] |
| `watchUserUpdated.js`, `shared/identityStatus.js` | Identity→app-user matching (email/local-part, IdP-priority merge) | n/a (server) | n/a | n/a | n/a | read-only matched/unmatched **status** only (PR #23); **algorithm + merge NOT built** | match read org-scoped, no PII (`0008`) | **Not-started** | the matching algorithm + merge (server-side) | **Yes** | [12]; [11] matching row |
| `IDCApps/insights/uar/page.tsx`, `resolveUAR` | Unmanaged-account report (orphaned/managed/unknown; orphaned spend; critical-risk) | needs legacy inspection | needs inspection | needs inspection | needs inspection (report output) | none — a **non-UAR** matched/unmatched + stale-candidate **count summary** exists (PR #24); **no orphaned/managed/deactivated status** | app-side scoping; no tenant-wide people/identity read (doc 12 §4) | **Not-started** | the actual UAR (managed/orphaned classification) | **Yes** | [11] UAR row; [12 §4] |
| `IDCApps/insights/stale/page.tsx` | Stale-users report (freshness, days-since-update, thresholds) | needs legacy inspection | needs inspection | needs inspection (thresholds) | needs inspection | none — a read-only **stale-candidate count** (>90d from `last_active_at`) exists (PR #24); not a confirmed-stale report | derived from visible `app_users` only | **Not-started** | the stale-users report (per-app freshness, thresholds) | **Yes** | [11] stale row; PR #24 |
| `IDCApps/[id]/components/LicenseRulesConfig.tsx` | Configure per-app seat/license rules | needs legacy inspection | save rule | n/a | n/a | none — `license_rules` **default-deny** | RLS default-deny | **Not-started** | license-rules surface + writes | **Yes** | [11] license row |
| `utils/licenseEvaluation.ts`, `licenses/evaluateUserLicenses.js` | License utilization / waste (ELU) | needs legacy inspection | n/a (server) | n/a | needs inspection | none — `license_evaluations` **default-deny** | RLS default-deny; evaluated server-side | **Not-started** | utilization/waste compute + surface | **Yes** | [11] license row |
| `billing/calculateMonthlyBilling.js`, `reports/cost-snapshot/`, `invoices/` | Spend / chargeback (invoice % allocation, monthly billing, cost reports) | needs legacy inspection | needs inspection | needs inspection | cost reports (format: needs inspection) | none — `invoices` **default-deny**; chargeback read model proven only for apps/contracts | related-org read model for chargeback (apps/contracts); invoices need own policy (RISK-002) | **Not-started** | invoice read policy + chargeback surfaces/reports | **Yes** | [11] spend row; [02 §8] |
| `files/page.tsx`, `webapp/.../storage/*` | Contract docs / file storage | **inspected ([16 §0])**: client-only MIME check, Storage `files/{id}` (no tenant path), tokenized public URLs | upload/download | needs inspection | n/a | **DESIGNED ([16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md), #33)** + **`files` metadata schema (`0012`, #34) + RLS policies (`0013`, #35** — tenant-member SELECT + contract-write INSERT, no UPDATE/DELETE/FOR ALL; T34); **no upload/Storage/signed-URL/UI surface yet** | tenant-bound metadata + FK + tested RLS live; `files` not app-surfaced | **Design + schema + RLS** (not surfaced) | the upload/Storage/UI implementation | **Yes** (if users attach docs) | [11] storage row; [16] |
| `files/inbound/page.tsx`, `onFileLinkedToApp.js:290` | Import / app-user data update (CSV/email/API → app_users) — **legacy deletes outdated users** | needs legacy inspection | upload / import | needs inspection | n/a | none | **non-destructive** (preview + soft-delete + audit; no blind delete) — an **approved better** workflow (RISK-008) | **Not-started** (Better-approved target) | the import flow (preview/upsert/audit) | **Yes** | [11] imports row; legacy blind-delete is the anti-pattern to NOT copy |
| `utils/downloadFile.ts`, `reports/schedules/`, `generateReportRuns.js` | Exports / scheduled email reports (token-gated) | needs legacy inspection | export / schedule | needs inspection | CSV per list/report (format: needs inspection); scheduled email | none | **tenant-scoped** exports, no secrets; scoped query + audit | **Not-started** | export/report engine + scheduling | **Yes** | [11] exports row |
| `logging/page.tsx`, `webapp/.../logging/*`, `cleanupOldLogs.js` | Audit history (before/after diff viewer; 90-day purge) | needs legacy inspection | view diff | needs inspection (date/actor filters) | needs inspection | none (UI) — `audit_logs` table is **append-only** | append-only/tamper-evident; **no purge** (legacy 90-day purge is intentionally dropped — retention design needed, RISK-009) | **Not-started** | the audit-viewer UI | **Yes** (if used for compliance) | [11] audit row; retention is a **Better-approved** difference to confirm |
| `admin/company/`, `admin/recompute/` | Admin / settings (company profile, domain allowlist, API keys, recompute) | needs legacy inspection | needs inspection | n/a | n/a | none | RLS; hashed API keys | **Not-started** | admin/settings surfaces | **Yes** (if admins use it) | [11] admin row |
| `samlAuth.ts`, `oidcAuth.ts` | SSO (SAML / OIDC / SAML IdP) | needs legacy inspection | SSO sign-in | n/a | n/a | none (email/pw only) | server-session model | **Not-started** | SSO/OIDC/SAML | **Yes** (if customer requires SSO) | [11] auth row |
| `extension/content.js`, `extension/auth.js` | Vendor/app enrichment Chrome extension (hashed email detection) | needs legacy inspection | n/a | n/a | n/a | none | n/a | **Removed-approved (pending)** — deferred / maybe-DELETE, **privacy review first** | confirm removal approval | No (if approved-removed) | [11] enrichment row — candidate for **intentional removal** |
| `company/groups/`, `permissionSync.js` | Tenant/company/group management | needs legacy inspection | needs inspection | n/a | n/a | tenants + organizations + memberships + RLS; context resolved (PR #1/#9) | row-level isolation (205 RLS assertions) vs per-project | **Partial** (`verified` backend; no admin UI) | tenant/group **management UI** + tenant switching | **Yes** (if admins manage groups in-app) | [11] tenant-model row |
| `appScraping/scrapers/*`, `scim/index.js` | Connectors / integrations (53+ OAuth scrapers, SCIM) | needs legacy inspection | connect / configure | n/a | n/a | none | connector behind a vault; encrypted creds, service-role-only (RISK-007) | **Not-started** | the connector framework | **Yes** (data freshness depends on it) | [11] connectors row |
| `processFileWithAI.js`, `handleDocumentAICompletion.js` | AI contract/invoice extraction | **inspected ([16 §0])**: service-role Storage fn, no prompt-injection defense, wholesale AI fields, auto-overwrite | n/a | n/a | n/a | none built — **DESIGNED ([16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md), PR #33)**: AI **suggestions only**, strict allowlist + `parseContractWriteInput`, user reviews+applies, no service-role app route | provider boundary; AI output untrusted; no secrets in app tables | **Design** (not built) | the extraction worker + review UI | No (build after the file surface) | [11] AI row; [16] |

## 4. Current v3 route parity map
| v3 route/screen | What it currently does | Maps to legacy route/workflow | Same/Better/Missing | User-visible differences vs legacy | Backend improvements | Cutover-blocker notes |
|---|---|---|---|---|---|---|
| `/` (`(authenticated)/page.tsx`) | Protected shell: resolved tenant/org context + read-only nav to apps/contracts | legacy authenticated landing | **Partial** | not a product dashboard; minimal nav | server-session, RLS-scoped context | not a user-facing parity surface; fine as a shell |
| `/login` | Email/pw sign-in → server session (Proxy) | `login/page.tsx` (+ SAML/OIDC) | **Partial** | no SSO buttons; not hosted-exercised | server-side session, not client `AuthGuard` | **blocker** if the customer uses SSO |
| `/logout` (route handler) | Clears session | legacy logout | **Same** (behavioral) | none material | server-side | not a blocker |
| `/apps` | Read-only inventory list (name/vendor/category/status) | `IDCApps/page.tsx` | **Partial** | no cost/license/user metrics, no filters/sort/search, no CSV | RLS-scoped, no client filtering | **blocker** until metrics + export + filters reach parity |
| `/apps/[id]` | Read-only app metadata + owning-org IDs + app-user roster + match status + account summary | `IDCApps/[id]/page.tsx` | **Partial** | org names not shown (IDs only); no linked contracts/invoices/files/license rules; no edit; UAR/stale are count-summaries not the legacy reports | RLS-scoped; route id lookup-only; no PII in match status | **blocker** until child surfaces + edit + real UAR/license reach parity |
| `/contracts` | Contracts list + **New contract** button | `contracts/page.tsx` | **Partial** | no filters/sort/search; no list-page inline cell-edit / bulk-delete; no CSV export | related-org RLS read | **blocker** until list filters/sort/search/export reach parity |
| `/contracts/new` + `/contracts/[id]/edit` | **Create / edit a contract** (PR #31 + parity fields PR #32) | `contracts/create/`, `contracts/[id]/` (legacy edits inline) | **Partial** | legacy `commodity_*` (hidden) + `validated` (read-only) + **gantt** have no v3 surface; **PDF-upload/AI is DESIGNED ([16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md), PR #33) but not built**; no delete/archive/link | RLS-gated #30 write path, audited (`0010`); **no client role gate** | **blocker** until the remaining fields/PDF-AI reach parity or are `Removed-approved` |
| `/contracts/[id]` | Contract detail + linked apps panel + **Edit** link | `contracts/[id]/page.tsx` | **Partial** | org names not shown; no invoices/files; no gantt | related-org RLS read; linked-apps via `0006`/`0009` | **blocker** until gantt + child surfaces parity |

## 5. Release / cutover gate (hard rules)
1. **OMC/Flywheel cutover is BLOCKED** until **every** `P0/P1` legacy workflow (the "Cutover blocker = Yes" rows above) is **Same**, **Better-approved**, or **Removed-approved**.
2. **New paid-customer onboarding is BLOCKED** until at least the same workflow gate is satisfied **for that customer's profile** (the subset of workflows that customer actually uses) — *and* the backend is hosted-applied and verified (RISK-001).
3. **Any deviation from legacy must be explicitly approved and documented** here (as `Better-approved` or `Removed-approved`) before it ships in a cutover-bound build.
4. **No cutover on backend readiness alone.** RLS passing (205 assertions), migrations applied, types generated, **contract audit-on-write live (`0010`)** — none of that is a cutover signal. The signal is **workflow parity**, owner-signed.
5. **No cutover on RLS passing alone.** Security is necessary, not sufficient.

## 6. PR review rule (new — also in [07_P0_REVIEW_CHECKLIST](./07_P0_REVIEW_CHECKLIST.md))
For any PR that touches a user-facing surface, the reviewer must answer:
> **"Does this PR preserve or restore a legacy user workflow exactly? If not, is the difference
> intentional, documented (here, as Better-approved / Removed-approved), and approved by the product
> owner?"**

An unapproved user-visible change is a **blocking** review finding. Backend-only changes (no perceivable
difference) are exempt from product approval (still need docs/test/PR discipline).

## 7. Backend-improvement policy (encouraged, when invisible or approved)
Backend improvements are **required** and **encouraged** when they are **invisible to the user or
clearly beneficial**: RLS, append-only audit, non-destructive import (preview + soft-delete), no hard
delete, same-tenant FKs, safer/tenant-scoped exports, server-side auth/session, cleaner schema. These
ship without product approval (normal docs/test discipline applies). **But:** the moment a backend
improvement produces a **user-visible** change (a different field, action, default, sort, export column,
or navigation), it crosses into §6 and needs approval. And we **never** copy a legacy *backend*
anti-pattern to achieve "sameness" — the experience is preserved, the implementation is replaced.

## 8. Next implementation order (re-ranked around parity)
0. **This parity map** (PR #28) — the contract that gates everything below.
1. ~~**Contract audit-on-write**~~ — ✅ **DONE (PR #29, `0010`)** — DB-side `SECURITY DEFINER` trigger ([13 §4](./13_CONTRACT_STEWARD_WRITE_DESIGN.md)); invisible backend improvement (no user-visible workflow change), landed before any write UI. Every accepted contract write is now audited.
1b. ~~**Contract write PATH (backend)**~~ — ✅ **DONE (PR #30)** — server-side DAL + `"use server"` actions on the anon client, gated by the existing RLS, `tenant_id` resolved server-side, audit inherited from `0010` ([13 §4](./13_CONTRACT_STEWARD_WRITE_DESIGN.md)). Invisible backend; no user-visible change.
2. ~~**Contract create/edit UI**~~ — ✅ **DONE (PR #31), PARTIAL parity** — `/contracts/new` + `/contracts/[id]/edit` posting to the #30 actions; legacy inspected first ([15_LEGACY_CONTRACT_FORM_INSPECTION](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)); RLS is the boundary (v3 does **not** port legacy's client `user.role` gate), denied save is generic (no enumeration), no delete/archive.
2b. ~~**Contract-form schema-backed parity fields**~~ — ✅ **DONE (PR #32, `0011`)** — added `category`/`procurement_date`/`notes`/`po_number`/`auto_renew`/`month_to_month` (forward migration + types regen + form/detail/list wiring). `commodity_*`/`validated` deliberately **not** added (hidden / read-only in legacy). **Still PARTIAL** — see 2c.
2c. ~~**Contract PDF/AI extraction DESIGN**~~ — ✅ **DONE (PR #33, [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md))** — security/design plan only (legacy anti-patterns documented; assistive upload → tenant-bound signed-URL Storage → AI **suggestions only**, strict-allowlist parsed → user reviews+applies → save via the PR #30 RLS-gated action). **Nothing built.**
2d. **Remaining contract-form parity gaps** ← **next (if product wants Same)** — **implement** PDF-upload/AI per [16 §10](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) (migration → RLS+tests → Storage+validation → extraction worker → UI → audit, each its own PR; RISK-002), the renewal **gantt**, and the legacy list-page inline-edit/bulk-delete. Inspect legacy first. **Cutover stays blocked** until closed or `Removed-approved`.
3. **App-contract link/unlink parity** — the legacy linking + cost-allocation workflow.
4. **App-user import/update parity** — the legacy import, rebuilt **non-destructive** (Better-approved): preview + upsert + soft-delete + audit, never blind delete.
5. **UAR parity** — the legacy unmanaged-account report (app-side scoped; doc 12 §4).
6. **Stale-users parity** — the legacy stale report.
7. **Export/report parity** — legacy CSV/scheduled reports, tenant-scoped + audited; **exact output parity** only after inspecting legacy outputs.
8. **License / spend / files / invoices parity** — needs read policies first (RISK-002).
9. **Hosted apply** — only when the above are safe and a reviewed deployment runbook exists (RISK-001).

Each step must inspect the legacy workflow first (§9), preserve its UX or get approval, and update this map.

## 9. Unknowns — `needs legacy inspection` (do not invent)
Before claiming **Same** / **Exact output parity** for any row, capture from the **running legacy app**
(source is outside this repo):
- **Exact fields shown** per screen and their order.
- **Exact column names** in tables and exports.
- **Filters / sort order / search** behavior and defaults per list.
- **Exports / report outputs** — columns, ordering, CSV format, scheduled-report contents.
- **Button labels** and action semantics.
- **Route paths** (exact legacy URLs) and navigation structure.
- **Import behaviors** — what legacy does on conflict / outdated rows (legacy *deletes* — to be replaced, not copied).
- **Admin / settings behavior** — company profile, domain allowlist, API-key handling, recompute.
- **SSO** — SAML/OIDC config and login UX.
Until inspected, these stay marked `needs legacy inspection` here and in §3; a PR may **not** assert
parity for a workflow whose legacy details are still unknown.

## 10. Honest status
This PR is **docs only** — no migration, no RLS change, no UI, no code. It **defines** parity; it
implements none of it. No legacy workflow is yet **Same**; the shipped v3 surfaces are **Partial**
(read-only subsets). RISK-002 + RISK-016 remain **open**; hard delete blocked; the contract write
backend (RLS authority `0004` + audit `0010` + DAL/server-action path PR #30) exists but the create/edit
**UI** and its **legacy parity are still not built**; **OMC/Flywheel cutover and new paid-customer onboarding remain blocked**.
