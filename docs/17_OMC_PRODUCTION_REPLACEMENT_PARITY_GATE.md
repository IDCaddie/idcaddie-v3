# 17 · OMC/Flywheel Production Replacement Parity Gate

**Canonical source for: the binding go/no-go checklist for REPLACING the current live OMC/Flywheel
production app with v3.** This doc is the authoritative cutover gate. [11](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md)
is the capability scorecard and [14](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md) is the per-workflow UX
contract + doctrine; **this doc decides whether cutover may happen at all.** If 11/14 and 17 ever
disagree on cutover-readiness, **17 wins.** [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md)
is the **working confirmation process** that feeds this gate (the questionnaire + workshop + decision
log that resolves the `probably`/`unknown` rows in §4); **18 feeds 17 — it does not replace it, and
running it does not make v3 ready.**

> **Standing business rule (do not soften):**
> - OMC/Flywheel is **NOT a pilot.** They are a **paying production customer (~$3.5k/month).**
> - v3 is intended to **replace the current live app** — not run alongside it as a trial.
> - **Cutover means OMC users do not notice missing workflows, broken workflows, or regressions.**
> - v3 must reach **current-app parity before product improvements.**
> - Improvements come **only after replacement**, through version-controlled, planned rollouts.
> - **Cutover is currently BLOCKED** (see §3). This PR does not change that, and does not claim readiness.

> **Evidence base:** this gate was built by reading the actual legacy app at
> `…/IDCaddie_Repo-main` (`frontend-v2/src/app/(authenticated)/`, `webapp/functions/src/*`) and
> cross-checking the current v3 repo — not from prior docs alone. The legacy app spans ~40 authenticated
> routes and dozens of Cloud Functions; v3 today is an auth + RLS foundation with read-only apps/contracts
> surfaces plus one write slice (contract create/edit). The replacement gap is large and honest (§8).

---

## 1. Cutover principle

1. **No surprise regressions.** A workflow a real OMC user relies on must not vanish or break at cutover.
2. **Same product workflow first; better backend/security underneath.** v3 fixes the legacy P0s (real
   tenant isolation, RLS, append-only audit, no plaintext credentials, no blind-delete imports) **without**
   changing the user-facing workflow — unless a difference is classified and approved (§6).
3. **Any behavior difference must be classified and approved BEFORE cutover** (§6). "Better" by developer
   preference alone is not allowed.
4. **"Not built" = cutover blocker** unless it is explicitly `removed-approved` or `not-used-by-OMC`
   (with documented OMC confirmation). Silence is a blocker, not a pass.

---

## 2. Status taxonomy

Used by the matrix (§4). Never blur these.

| Status | Meaning |
|---|---|
| `same` | v3 reproduces the legacy workflow with the same user-facing experience. Backend may differ (and should be safer). |
| `partial` | v3 has a subset (e.g. read-only where legacy is read/write, or missing fields/filters). **Cutover blocker if required.** |
| `better-approved` | v3 intentionally differs in a way that is **documented + reviewed + accepted** (e.g. RLS org-scoping instead of permission fan-out). Not a blocker once approved AND its admin surface exists. |
| `removed-approved` | Legacy workflow deliberately dropped with **explicit documented approval** (e.g. destructive 90-day log purge). Not a blocker. |
| `not-built` | No v3 equivalent. **Cutover blocker if required-for-cutover.** |
| `blocked` | Cannot proceed until a prerequisite/decision lands (e.g. anything needing the credential vault or hosted apply). |
| `unknown-needs-legacy-inspection` | Legacy behavior not yet captured from the running app (do not invent). |
| `unknown-needs-OMC-confirmation` | Whether OMC actually uses this is unconfirmed; required-ness can't be set until OMC confirms. |
| `not-used-by-OMC` | Confirmed (by OMC) that OMC does not use this legacy workflow. Not a blocker. |

**`Required for OMC cutover?` column semantics:** `yes` = required; `no` = not required; **`probably`/`unknown` = treated as REQUIRED-for-cutover until OMC confirms otherwise** (consistent with §1.4 "silence is a blocker, not a pass"). Every `probably`/`unknown` must be resolved to `yes`/`no` **through the [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md) workflow** (the §9 confirmation list is the question set; doc 18 is the working questionnaire + decision log) before a go/no-go decision (§5). A verbal "probably not used" is not enough — removal needs a recorded owner + evidence (doc 18 §2/§8).

---

## 3. Hard cutover blockers (current)

These are the categories that make cutover a NO today. None may be hand-waved.

**Operations / data (gating everything):**
- **No hosted Supabase apply** — all of `0001`–`0013` + RLS are `verified-local` only against an auth shim; never applied to hosted Supabase. First apply is unproven (**RISK-001**).
- **No staging Supabase verification** and **no staging Vercel** wired to Supabase. Auth/session + tenant-context have never run against hosted Supabase Auth.
- **No OMC-shaped staging dataset.**
- **No hosted-apply / rollback / DR / backup-restore runbook**, and no deploy/promote CI (the 4 CI workflows are PR-time gates only).
- **No OMC data-migration plan** (Firestore + Storage → Postgres + Supabase Storage) for apps/contracts/people/app_users/files/invoices/billing + file bytes + AI history. Cutover as-is loses the historical corpus. (Never via `local_demo.sql` — **RISK-015**.)
- **No post-cutover monitoring.**

**Product surface:**
- **Files not app-surfaced** — only the `files` metadata table + RLS (`0012`/`0013`) exist; no Storage bucket, upload, signed URLs, validation/scan gate, preview, or file/extraction audit.
- **PDF/AI extraction not implemented** (design only — [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)); legacy's DEFAULT contract-create path is upload-PDF.
- **Imports/connectors not built** — no connector subsystem, no SCIM ingestion, no scheduled sync; **no credential vault (RISK-007 — safe path DESIGNED in [19](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md), not implemented; vault is a prerequisite for ANY connector)**; **no non-destructive upsert writer**; no CSV/userlist ingestion.
- **License rules / evaluations / ELU / waste not built**; **invoices not built** (no ingestion, no proration); **reporting/exports not built** (no CSV/PDF, no scheduled/emailed reports, no dashboards, no cost snapshots).
- **IDC platform billing not built** — the monthly cron + billing surface that IS the ~$3.5k/mo revenue mechanism is absent.
- **App-contract link/unlink + cost allocation missing** (read-only today).
- **UAR / unmanaged / orphaned / People directory / identity matching missing**; the v3 `apps/[id]` account summary is explicitly **not** UAR.
- **Admin/settings parity missing** — no user-management UI, role-change UI, groups/org admin UI, company/tenant settings, password reset.
- **Audit UI missing** — `audit_logs` is append-only but unsurfaced; only `contracts` has an audit-on-write trigger (`0010`).

**Risk:**
- **RISK-002 open** (child/link tables not fully org-scoped for reads; org-scoped file read deferred).
- **RISK-016 open.**
- Related: **RISK-001** (no hosted apply), **RISK-007** (no credential vault), **RISK-012** (no provisioning/tenant-switch UI), **RISK-009** (audit retention), **RISK-013** (telemetry privacy review).

**Conditional (hard blocker IFF OMC confirms use — §9 confirmation list):**
- **SAML SSO sign-in** absent in v3.
- **SCIM 2.0 provisioning** absent in v3.
- Connector long-tail, governance/attestations, custom-field/calc engine, per-app cost allocation, group-scoped file visibility, daily contract auto-expire.

---

## 4. Required replacement parity matrix

One row per concrete legacy workflow (grounded in the legacy source). Columns:
**Legacy area** · **Legacy evidence inspected** · **Current live expectation** · **v3 status** ·
**Required for OMC cutover?** (yes/probably/unknown/no) · **Cutover blocker?** · **Approved difference?** ·
**Next track** (→ §7) · **Notes**.

`Approved difference?` is `yes` only for `better-approved`/`removed-approved` rows; otherwise `—` (the gap must be closed, not waved through). `unknown` required-ness ⇒ resolve via §9 OMC confirmation before relying on the row.

### 4.1 Core platform (auth, session, roles, admin/settings, audit)

| Legacy area | Legacy evidence | Current live expectation | v3 status | Required? | Blocker? | Approved diff? | Next track | Notes |
|---|---|---|---|---|---|---|---|---|
| auth: email/pw | `login`, `auth/` | Email/pw sign-in + unverified gate + remember-me | `partial` | yes | yes | — | B-admin | v3 has Supabase email/pw via server action; no verify gate, bare UX |
| auth: SSO | `admin/sso`, SAML callback | SAML SSO (SP- + IdP-initiated) | `not-built` | unknown | yes | — | B-admin | Hard blocker IFF OMC signs in via SAML — §9 |
| provisioning: SCIM | `scim/` (Express SCIM 2.0) | Auto user provisioning from IdP + group→role | `not-built` | unknown | yes | — | B-connectors | Hard blocker IFF OMC provisions logins via IdP — §9 |
| auth: verify | `auth/` | Email verification send/resend + gate | `not-built` | probably | no | — | B-admin | Part of email/pw posture |
| auth: reset | legacy forgot-pw | Password reset via email | `not-built` | yes | yes | — | B-admin | Day-one self-service login gap |
| profile | `profile` | Change own password + display name | `not-built` | probably | no | — | B-admin | Self-service profile mgmt |
| admin/users | `company/users`, `users` | List/create/delete users + invite | `not-built` | yes | yes | — | B-admin | Soft-disable membership; do NOT port user hard-delete |
| admin/users | `company/users` | Change a user's role | `partial` | yes | yes | — | B-admin | RLS blocks self-promotion (`0002`) but no role-change UI; legacy roles differ — §9 |
| groups | `company/groups` | Group CRUD + membership (manager/viewer) | `partial` | yes | yes | — | B-admin | Org-membership data + RLS exist; no admin UI |
| groups/access | permission model | Group-based resource access | `better-approved` | yes | yes | yes — RLS org-scoping replaces fan-out | B-admin | Better at data layer (closes a legacy P0); admin UI is the gap. Do NOT port subcollection fan-out |
| admin/company | `admin/company` | Company/tenant profile mgmt | `not-built` | probably | no | — | B-admin | v3 multi-tenant ⇒ needs tenant-settings equivalent |
| admin/company | `admin/company` | Restrict signup to allowed domains | `not-built` | probably | no | — | B-admin | Tied to self-signup (v3 has none yet) — §9 |
| admin/company | `admin/company` | API key generate/delete | `not-built` | unknown | no | — | B-admin | Depends on API/Chrome-plugin use — §9 |
| logging | `logging`, `logging/[logId]` | Activity-log list + detail with before→after diff | `partial` | yes | yes | — | B-admin | Only `contracts` audited (`0010`, curated allowlist, `before_json` NULL — not a full diff); no viewer UI; no triggers for apps/files/users/memberships/invoices — §9 granularity |
| logging | scheduled purge | Auto-purge logs >90 days (daily hard delete) | `removed-approved` | no | no | yes — append-only, no destructive purge | — | Do NOT port. RISK-009: archival (not delete) design later — §9 |
| profile | `profile` | Accept Terms of Service | `not-built` | unknown | no | — | B-admin | Confirm ToS-acceptance compliance need — §9 |
| admin | `admin/recompute` | Manual recompute of derived data | `not-built` | no | no | yes — job-level, not a user button | — | Largely obsoleted by RLS/SQL-derived model |
| tenancy | single-tenant legacy | Multi-tenant / tenant switching | `better-approved` | no | no | yes — v3 is genuinely multi-tenant | — | Switching deferred (RISK-012). Do NOT port single-tenant assumptions |

### 4.2 Apps

| Legacy area | Legacy evidence | Current live expectation | v3 status | Required? | Blocker? | Approved diff? | Next track | Notes |
|---|---|---|---|---|---|---|---|---|
| apps: inventory | `IDCApps` | Inventory w/ cost+utilization columns + metric cards | `partial` | yes | yes | — | B-apps | v3 = 4 read-only columns; no cost/users/ELU/UAR/waste/cards |
| apps: inventory | `IDCApps` | Filter (category/status/source) + URL filters + search | `not-built` | yes | yes | — | B-apps | None on v3 table |
| apps: inventory | `IDCApps` | Create a new application | `not-built` | yes | yes | — | B-apps | Apps area is fully read-only |
| apps: detail/edit | `IDCApps/[id]` | Edit app metadata (owner/category/classification/cadence…) | `not-built` | yes | yes | — | B-apps | Columns exist; no edit UI/write path. Route via server DAL + RLS |
| apps: inventory | `IDCApps` | Bulk/single delete app | `not-built` | probably | no | — | B-apps | `0004` blocks DELETE; legacy was `window.confirm` hard delete — build archive instead — §9 |
| apps: export | `IDCApps` | Export apps/app-users CSV | `not-built` | yes | yes | — | B-reports | No CSV util anywhere in v3 |
| apps: detail | `IDCApps/[id]` | Detail metrics (annual/monthly cost, users, ELU, UAR, waste $) | `partial` | yes | yes | — | B-apps | v3 shows raw fields + read-only roster + PII-free summary; no cost/ELU/UAR |
| apps: roster | `IDCApps/[id]` users | Roster: auto columns, saved picker, status/tier/license filters + badges | `partial` | yes | yes | — | B-people | v3 = fixed read-only subset (PR #23); no picker/filters/badges — §9 custom columns |
| apps: insights | `IDCApps/insights` | ELU / license-utilization (vacancy vs stale waste) | `not-built` | yes | yes | — | B-licenses | Depends on license engine. Headline value prop |
| apps: insights | `IDCApps/insights` | UAR / unmanaged (managed/orphaned/unknown, orphaned spend, Critical-Risk) | `not-built` | yes | yes | — | B-people | v3 summary is explicitly NOT UAR. Preserve legacy denominator (active accounts) |
| apps: insights | `IDCApps/insights` | Sync Health / stale-data | `not-built` | probably | yes | — | B-connectors | Meaningless until connectors exist |
| apps: scraping | `IDCApps/scraping` | Configure/run/test/schedule scrapers; Sync All | `not-built` | unknown | yes | — | B-connectors | Needs credential vault first — §9 connectors |
| apps: license rules | `IDCApps/settings` | Define license rules + accept/dismiss AI suggestions | `not-built` | probably | yes | — | B-licenses | v3 `license_rules` schema can't represent legacy shape; needs extension |
| apps: governance | `IDCApps/settings` | Attestations (UAR/justification/config review) + cadence + signed history (ISO/SOC) | `not-built` | unknown | yes | — | B-apps | Large surface; confirm OMC is audited against it — §9 |
| apps↔contracts | `IDCApps/[id]` | Link/view contracts for an app | `partial` | yes | no | — | B-apps | Read-only links via `0006`/`0009`; linking is the contract-links row |
| apps: field config | `IDCApps/settings` | Custom App/User fields + calc-expression engine + preview | `not-built` | unknown | yes | — | B-apps | Powerful/niche; confirm reliance — §9 |
| apps: IdP | `IDCApps/scraping` | IdP assignment linking + matching rules | `not-built` | probably | yes | — | B-connectors | Tied to Okta + matching; alias/local-part rules must carry forward |
| apps: inbound | `files/inbound` | Inbound channels (email-forward + REST push, tokens) | `not-built` | unknown | yes | — | B-connectors | Plaintext tokens in legacy ⇒ v3 must vault — §9 |
| apps: account intel | `IDCApps/[id]` (PR #23/#24) | Account summary (matched/unmatched, active/inactive, stale candidates) | `better-approved` | probably | no | yes — PII-free interim (RISK-002 scope) | B-people | NOT UAR; defensible interim — §9 semantics |

### 4.3 Contracts

| Legacy area | Legacy evidence | Current live expectation | v3 status | Required? | Blocker? | Approved diff? | Next track | Notes |
|---|---|---|---|---|---|---|---|---|
| contracts: list | `contracts` | Browse + spend KPIs (status counts, annual/monthly spend, expiring-soon, notice 7/30/60d) | `partial` | yes | yes | — | A/B-contracts | v3 = read-only columns; `total_cost` only, NO `monthly_cost` ⇒ KPI cost-semantics decision — §9 |
| contracts: list | `contracts` | URL-persisted filters + column sort | `not-built` | probably | no | — | B-contracts | Real usability gap for a contract-heavy customer |
| contracts: list | `contracts` | Inline-edit status/category/cost | `not-built` | probably | no | — | B-contracts | Edit exists via detail form; do NOT port client-side writes |
| contracts: create | `contracts/create` (blank tab) | Create blank contract | `same` | yes | no | — | done (#30/#31) | Built: `/contracts/new` → server action → RLS, audited (`0010`) |
| contracts: create | `contracts/create` (PDF tab) | Create by uploading a PDF + AI auto-extract | `not-built` | yes | yes | — | A-extraction | Legacy DEFAULT create path; v3 has schema stubs + design (16) only |
| contracts: detail | `contracts/[id]` | View all fields | `partial` | yes | no | — | B-contracts | Read-only + parity fields (`0011`) + read-only links; missing files/AI panels |
| contracts: edit | `contracts/[id]/edit` | Edit + save fields | `partial` | yes | yes | — | B-contracts | Most parity fields (#31/#32), RLS boundary, audited; no `monthly_cost`; `commodity_*`/`validated` dropped — §9 |
| contracts: delete | `contracts/[id]` | Delete single/bulk | `removed-approved` | no | no | yes — no hard delete (`0004`) | — | Legacy `window.confirm` hard delete; build archive if needed — §9 |
| contracts: links | `contracts/[id]` allocator | Link/unlink apps + per-app cost allocation % | `partial` | probably | yes | — | B-apps | Read-only; `app_contracts` has no percentage column; no link/unlink — §9 chargeback |
| contracts: files | `contracts/[id]` | Upload/view/unlink contract files | `not-built` | yes | yes | — | A-storage | Load-bearing for AI analysis; only table+RLS exist |
| contracts: AI | `contracts/[id]` | AI analysis (summary/unfavourable terms/gotchas/entities) | `not-built` | yes | yes | — | A-extraction | Depends on PDF pipeline; v3 = suggestions-only/human-review — §9 |
| contracts: access | `contracts/[id]` groups | Group-based access on a contract | `better-approved` | yes | no | yes — RLS org-scoping | B-admin | Admin UI to assign is the gap |
| contracts: gantt | `contracts/gantt` | Renewal/timeline Gantt | `not-built` | probably | yes | — | B-contracts | Visible legacy planning surface — §9 |
| contracts: export | `contracts` | Export contracts CSV | `not-built` | yes | no | — | B-reports | Folds into the reports export util |
| contracts: lifecycle | daily CRON | Auto-flip past-expiry contracts to Expired | `not-built` | probably | no | — | B-contracts | v3 has no scheduler; must be per-tenant/RLS-safe if ported — §9 |
| contracts: audit | `logging/contractOnWrite` + `0010` | Audit create/update/delete with field diff | `partial` | yes | no | — | B-admin | `0010` records accepted-write event (no diff, `before_json` NULL) — coarser — §9 granularity |

### 4.4 People / identity

| Legacy area | Legacy evidence | Current live expectation | v3 status | Required? | Blocker? | Approved diff? | Next track | Notes |
|---|---|---|---|---|---|---|---|---|
| people: directory | `people` | Unified People directory (IdP + apps), paginated, per-person drill-down | `not-built` | probably | yes | — | B-people | Tables exist (tenant-only/default-deny); nothing writes them. Blocker depends on IdP feed — §9 |
| people: search | `people` | Search by name/email + filter by app/source | `not-built` | probably | yes | — | B-people | Depends on directory |
| people: matching | matching fns | App-user→identity matching (email/idpEmail/domain-alias/local-part) + per-method stats | `not-built` | probably | yes | — | B-people | Future SECURITY DEFINER job; schema richer than legacy but unpopulated |
| people: settings | `people/settings` | Per-provider matching rules (alias groups, local-part + whitelist) | `not-built` | probably | yes | — | B-people | Must carry forward or cross-domain merges regress |
| people: rebuild | daily 2AM job | Recompute/scheduled rebuild of people index | `not-built` | probably | yes | — | B-people | Do NOT port Firestore delete-and-rewrite; preserve review state |
| people: risk | `people/risks` | Orphaned / Critical-Risk (IdP-deactivated yet provisioned) + $ at risk | `not-built` | probably | yes | — | B-people | Highest-value compliance output; blocker IFF IdP feed — §9 |
| people: risk | `people/risks` | Shadow-IT / service-account report | `not-built` | unknown | no | — | B-people | Secondary — §9 |
| people: UAR | `IDCApps/[id]` + people | Per-app UAR/OAR scoring (Managed/Orphaned/Unknown/Critical + thresholds) | `partial` | probably | yes | — | B-people | v3 has PII-free non-UAR summary only; needs org-level identity reads |
| people: roster | `IDCApps/[id]` (PR #23) | Per-app matched/unmatched view | `partial` | yes | yes | — | B-people | Status-only; lacks managed/orphaned classification + person detail |
| people: export | `people` | Export people/risks CSV | `not-built` | probably | no | — | B-reports | Depends on directory + risk views |
| people: review | n/a (legacy auto-only) | Human review sign-off on a match | `not-built` | no | no | yes — NEW feature, not parity | — | Legacy has NO human review; v3 schema supports it — §9 if desired |

### 4.5 Licenses / spend / invoices / billing

| Legacy area | Legacy evidence | Current live expectation | v3 status | Required? | Blocker? | Approved diff? | Next track | Notes |
|---|---|---|---|---|---|---|---|---|
| licenses: rules | `licenses/`, `IDCApps/settings` | Define rule (criteria/cost/seats/period/utilization field) | `not-built` | probably | yes | — | B-licenses | v3 single `expression_json` can't represent legacy shape; needs schema extension |
| licenses: eval | `licenses/` | Per-user evaluation (stamp licenses, assigned vs active, skip deprovisioned) | `not-built` | probably | yes | — | B-licenses | `license_evaluations` lacks ELU/waste/cost cols; zero out deprovisioned |
| licenses: ELU | `licenses/` | ELU + waste per rule (Assigned/Active ELU, usage rate, vacancy/stale waste $, elastic vs fixed) | `not-built` | probably | yes | — | B-licenses | Subtle waste math; preserve exactly + unit-test |
| licenses: rollup | `licenses/` | App-level rollup (overallELU, monthly cost, monthly waste, totalCost sync) | `not-built` | probably | yes | — | B-licenses | Cost-weighted ELU + mixed-period normalization |
| licenses: AI | invoice line items | AI-suggested license rules (accept/dismiss) | `not-built` | unknown | no | — | B-licenses | Depends on invoice AI — §9 |
| invoices: list | `invoices` | List: view/search/filter/sort, bulk delete, CSV | `not-built` | yes | yes | — | B-licenses | `invoices` default-deny, no `status`; legacy bulk delete was hard — gate behind hardening |
| invoices: detail | `invoices/[id]` | Detail: edit, set status, link apps/contracts, AI confidence + source file | `not-built` | yes | yes | — | B-licenses | Table lacks status/AI-confidence/linkedDocs |
| invoices: ingest | DocumentAI/Vertex | Invoice ingestion + AI field extraction | `not-built` | yes | yes | — | A-extraction | Shares contract AI + Storage prereqs |
| spend: cost rollup | `resources/`, billing | App invoiced cost rollup (prorated monthly/annual from periods) | `not-built` | yes | yes | — | B-licenses | Needs `period_start`/`period_end` + status cols; unify two legacy proration impls |
| reports: chargeback | `reports/it-spend` | IT Spend by Department (contract/invoiced/forecast, monthly/annual, per-dept, CSV) | `not-built` | yes | yes | — | B-reports | De-facto chargeback view; depends on proration |
| reports: license | `reports/license-analysis` | License Analysis (rules + custom-criteria, active %, wasted cost, save/load, CSV+PDF) | `not-built` | probably | yes | — | B-reports | Depends on license rules — §9 mode/PDF |
| revenue: billing | `billing/`, monthly cron | IDC platform billing: monthly cron (unique IDP users × rate), idempotent billing doc | `not-built` | yes | yes | — | B-billing | **The ~$3.5k/mo revenue mechanism.** $1/user + dedup basis is load-bearing — §9 rate |
| revenue: dashboard | `admin/billing` | Admin billing dashboard (estimate, user count, 12-mo history, settings) | `not-built` | yes | yes | — | B-billing | Customer-facing billing surface |
| revenue: invoice PDF | `billing/` | Branded ID-Caddie invoice PDF ($1/user, wire instructions) | `not-built` | yes | yes | — | B-billing | Confirm sent-to-OMC vs internal — §9 |
| reports: summary email | `email/`, `monthlySummaryTokens` | Monthly summary email + token-gated web view (confirm/unsubscribe) | `not-built` | unknown | no | — | B-reports | Two coexisting legacy mechanisms — confirm which/if live; do not build both — §9 |

### 4.6 Imports / connectors

| Legacy area | Legacy evidence | Current live expectation | v3 status | Required? | Blocker? | Approved diff? | Next track | Notes |
|---|---|---|---|---|---|---|---|---|
| connectors: config | `appScraping/` | Configure connector (type, creds, test, schedule, enable) | `not-built` | unknown | yes | — | B-connectors | Needs credential vault first — §9 |
| connectors: sync | `appScraping/` | Run a connector sync (manual) → roster | `not-built` | unknown | yes | — | B-connectors | Must funnel through non-destructive upsert |
| connectors: scheduled | `scheduled/`, `scheduledJobs/` | Scheduled sync (daily/weekly) across enabled apps | `not-built` | unknown | yes | — | B-connectors | Needs cron/queue infra (pg_cron vs external) |
| connectors: upsert | `appScraping/` | Import-driven roster upsert AND removal | `not-built` | yes | yes | — | B-connectors | Legacy = blind destructive replace; do NOT port. Build non-destructive upsert + soft-delete + diff-preview |
| connectors: okta | `appScraping/` (Okta) | Okta connector (dir users + app discovery + assignments) | `not-built` | probably | yes | — | B-connectors | Strong evidence OMC uses Okta. No blind-delete on transient failure — §9 |
| connectors: google | `appScraping/` (Google) | Google Workspace (service-account / DWD) | `not-built` | unknown | yes | — | B-connectors | Vault the service-account key — §9 |
| connectors: long-tail | `appScraping/` (~53 registered) | MS 365 / Slack / Salesforce / AWS / GitHub / Jira / Zoom + ~46 others | `not-built` | unknown | yes | — | B-connectors | UI labels only 5; "Test All" is dead code. Port only OMC-confirmed — §9 |
| connectors: generic | `appScraping/` | Generic REST connector (endpoint + field mapping) | `not-built` | unknown | no | — | B-connectors | §9 |
| imports: inbound email | `files/inbound`, `email/` | Per-app email-forward ingest | `not-built` | unknown | yes | — | B-connectors | Confirm live ingestors — §9 |
| imports: inbound API | `api/` | Authenticated REST push ingest | `not-built` | unknown | yes | — | B-connectors | Legacy tokens plaintext, string-equality — v3 must vault/hash — §9 |
| imports: manual CSV | `files/inbound` | Manual CSV/file upload of roster or invoice | `not-built` | yes | yes | — | A-storage | Almost certainly used; common funnel. No upload in v3 |
| imports: dashboards | `files/inbound` | Inbound-activity & connector-status dashboards | `not-built` | unknown | yes | — | B-connectors | Operational visibility if connectors live — §9 |
| connectors: creds | `appScraping/` config | Connector credential storage & rotation | `not-built` | unknown | yes | — | B-connectors | **RISK-007** — legacy 50+ secrets PLAINTEXT. Vault (service-role-only) BEFORE any connector |
| connectors: audit | `scraperLogs` | Connector run audit/logging | `not-built` | no | no | — | B-connectors | Extend append-only `audit_logs`; lower priority |
| auth: SCIM login | `scim/` | SCIM provisioning of LOGIN accounts (soft-disable on delete) | `not-built` | unknown | yes | — | B-connectors | Distinct from roster SCIM; dup of §4.1 SCIM — §9 |

### 4.7 Exports / reports / dashboards

| Legacy area | Legacy evidence | Current live expectation | v3 status | Required? | Blocker? | Approved diff? | Next track | Notes |
|---|---|---|---|---|---|---|---|---|
| reports: suite | `reports/*` (8 routes) | Monthly Procurement, Cost Comparison, IT-Spend, Monthly/Cost Snapshot, License/Overlap/User-Comparison | `not-built` | probably | yes | — | B-reports | 0 report routes in v3; most depend on invoice proration + a snapshot cron — §9 which run |
| reports: schedules | `reports/schedules`, `scheduled/` | Scheduled email reports + run history + delivery | `not-built` | unknown | yes | — | B-reports | Check live `reportSchedules` — §9 |
| reports: snapshots | `reports/*-snapshot` | Monthly/cost snapshot capture (point-in-time) | `not-built` | probably | yes | — | B-reports | Needs a capture cron + snapshot table (net-new) |
| reports: export util | all report/list routes | Shared CSV (+PDF) export across the app | `not-built` | yes | yes | — | B-reports | No export utility anywhere in v3 |
| dashboards | `dashboards`, `dashboards/[id]`, `create` | Custom + home dashboards | `not-built` | unknown | yes | — | B-reports | `_home_dashboard` may back the home screen — §9 |

### 4.8 Files / storage

| Legacy area | Legacy evidence | Current live expectation | v3 status | Required? | Blocker? | Approved diff? | Next track | Notes |
|---|---|---|---|---|---|---|---|---|
| files: upload | `files`, `storage/` | Upload (PDF/CSV/…) with doc type + optional AI; private bucket + MIME/size/scan gate | `not-built` | yes | yes | — | A-storage | Only table+RLS (`0012`/`0013`). Use upload-then-commit (not legacy write-doc-then-upload race) |
| files: list | `files` | Browse/search/filter/sort inventory + CSV | `not-built` | yes | yes | — | A-storage | Page server-side; do NOT port whole-collection client fetch |
| files: preview | `files/[fileId]` | View/preview in-app + download (signed URL, original filename) | `not-built` | yes | yes | — | A-storage | Needs signed-URL logic + viewer |
| files: delete | `storage/onDeleteStorageFile` | Delete single/bulk (Storage + AI outputs + metadata) | `not-built` | probably | no | — | A-storage | Legacy hard-deletes; v3 no-hard-delete-of-evidence — build archive; atomicity story — §9 |
| files: links | `files`, `0012` FK | Link/unlink file ↔ contracts & apps (bidirectional) | `partial` | yes | yes | — | A-storage | `0012`/`0013` give a one-directional contract foothold; no UI, no app linkage |
| files: AI | `storage/processFileWithAI` | AI extraction (DocumentAI entities + Vertex/Gemini summary) | `not-built` | probably | no | — | A-extraction | Design (16) only; v3 = suggestions-only/human-review — §9 |
| files: userlist | `storage/` userlist | CSV userlist → app users (field calc, IdP match, license suggest) | `not-built` | yes | yes | — | A-storage / B-connectors | Primary "load my users"; non-destructive upsert, race-free upload-then-commit |
| files: inbound | `files/inbound` | Inbound channels (email-forward + API push) + monitor | `not-built` | unknown | no | — | B-connectors | Dup of §4.6 inbound — §9 |
| files: access | legacy ABAC | Group-based file access (inherit from linked contracts/apps) | `better-approved` | probably | no | yes — tenant-member + contract-write authority (`0013`) | A-storage | REGRESSION risk IFF OMC restricts files to a user subset — §9; org-scoped read deferred (RISK-002) |
| files: audit | `logging/fileOnWrite` | File change audit (create/update/delete + diff) | `not-built` | probably | no | — | A-storage | No files audit trigger in v3; extend `0010` pattern; lower fidelity than legacy diff |

### 4.9 Production operations

| Legacy area | Legacy evidence | Current live expectation | v3 status | Required? | Blocker? | Approved diff? | Next track | Notes |
|---|---|---|---|---|---|---|---|---|
| ops: hosted apply | n/a (legacy = Firebase) | Apply `0001`–`0013` to hosted (staging→prod) + post-apply verification | `not-built` | yes | yes | — | A/B-ops | **RISK-001.** Project linked but nothing applied; first apply must be gated, human-run, reviewed |
| ops: environments | n/a | Staging Supabase + staging Vercel; hosted Supabase Auth exercised | `not-built` | yes | yes | — | A/B-ops | Auth/session verified-local only; no prod/custom domain (RISK-013) |
| ops: rollback/DR | n/a | Rollback/forward-fix + backup/restore runbook; deploy/promote CI; monitoring | `not-built` | yes | yes | — | A/B-ops | 4 CI workflows are PR-only gates |
| ops: data migration | Firestore + Storage | Migrate OMC data (docs + objects + AI history) → Postgres + Supabase Storage | `not-built` | yes | yes | — | A/B-ops | Bespoke + risky; never via `local_demo.sql` (RISK-015) |
| ops: monitoring | n/a | Post-cutover monitoring/alerting | `not-built` | yes | yes | — | A/B-ops | None today |

---

## 5. Cutover go/no-go checklist

**Cutover is a NO unless EVERY box is true.** Each is verifiable; none is a judgment call left to the engineer mid-cutover.

- [ ] Every **required-for-cutover** workflow in §4 is `same`, `better-approved`, or `removed-approved`.
- [ ] **No required workflow is `partial`, `not-built`, `blocked`, `unknown-needs-legacy-inspection`, or `unknown-needs-OMC-confirmation`.**
- [ ] **Every §4 row has `Required for OMC cutover?` = `yes` or `no`** — **no `probably`/`unknown` remain** (each was resolved via the §9 OMC-confirmation pass and re-classified). Until then, `probably`/`unknown` count as required (§2), so this box cannot be ticked while any remain.
- [ ] Every `unknown-needs-OMC-confirmation` row (§9) has been **confirmed by OMC** and re-classified.
- [ ] **Hosted Supabase staging apply done and verified** (schema + RLS suite re-run against hosted Postgres/Auth, not the local shim).
- [ ] **Vercel staging wired to Supabase and tested** (auth/session + tenant-context exercised on hosted Supabase Auth).
- [ ] **OMC-shaped dataset loaded in staging** and the critical flows validated against it.
- [ ] **All RLS tests pass locally AND staging verification passes** (no behavior divergence between shim and hosted).
- [ ] **All critical OMC user flows validated** end-to-end in staging.
- [ ] **No service-role app code paths** (`check-auth-safety.sh` green; RLS is the only authorization boundary).
- [ ] **No unsafe connector tokens** — every connector secret is in the encrypted vault (RISK-007), service-role-only, never plaintext.
- [ ] **No destructive imports** — all import/sync writers are non-destructive upsert + soft-delete with a diff/preview (no blind delete).
- [ ] **No public file URLs** — files are private bucket + short-lived signed URLs only.
- [ ] **No unaudited writes for sensitive workflows** — contract/file/invoice/user/membership writes are audited (append-only).
- [ ] **Documented rollback plan** (DB + app), rehearsed in staging.
- [ ] **Documented old-app freeze / cutover plan** (data-migration cutoff, freeze window, switchover, fallback).
- [ ] **OMC acceptance signoff** recorded.

---

## 6. Approved-difference process

Any difference from legacy MUST be classified before cutover — `better-approved`, `removed-approved`, or it is a blocker.

1. **Classify** the difference against the §2 taxonomy and add/annotate its §4 row.
2. **"Better" is not a developer-preference decision.** It must be **documented** (what differs + why it is safer/correct), **reviewed**, and **accepted** by the product/cutover owner — recorded here and in [14 §6/§7](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md).
3. **Default classification when unsure:** blocker (close the gap), not "better".

**Worked examples (current v3 stance):**
- **Non-destructive import (upsert + soft-delete + preview) instead of blind full-replace delete** → **likely `better-approved`** (fixes a legacy data-loss P0). Document + accept.
- **No hard delete (apps/contracts/files/invoices/users)** → **`better-approved` IF an audited archive/soft-delete exists**; until then the *removal workflow* is a gap, not approved.
- **RLS org-scoping instead of permission-document fan-out / client-side role gates** → **`better-approved`** (closes a legacy P0). Still needs the admin UI to assign access.
- **Removing the Chrome extension / vendor-enrichment** → **`removed-approved` ONLY if OMC explicitly accepts**; otherwise blocker/unknown.
- **PDF AI: review-and-apply suggestions instead of auto-overwrite on upload** → **`better-approved`** (safer; no prompt-injection auto-write) — but **must be documented and OMC-confirmed acceptable** (§9), since the *upload-then-extract* workflow itself must still exist.
- **Append-only audit instead of 90-day hard purge** → **`better-approved`** (tamper-evidence); RISK-009 archival design owed.

---

## 7. Next recommended PR sequence (from #35)

Two interleaved tracks. **Track A** continues the security/file path already in motion ([16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)); **Track B** is the broader replacement-parity build-out. Ranges are rough and depend on §9 confirmation; many B-items are themselves multi-PR. **Any hosted apply, staging/production deploy, or cutover step in either track follows the [20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md) runbook** (staging-first, verify-after-apply, stop/rollback rules; RISK-001 open until a reviewed staging apply happens); connector credentials additionally follow [19](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md).

**Track A — security / file path continuation (depends on the OPS gate for hosted use):**
1. Private Supabase **Storage bucket** + server-side validation (extension/MIME/magic-byte/size + scan gate). *(A-storage)*
2. **Upload server action** (upload-then-commit; writes the `files` row via the `0013` INSERT authority). *(A-storage)*
3. **Signed-URL read path** + minimal file list/preview/download. *(A-storage)*
4. **Extraction worker** (out-of-request, tenant-re-deriving; **no service-role app route**). *(A-extraction)*
5. **AI suggestions parser** (strict allowlist through `parseContractWriteInput`; suggestions-only). *(A-extraction)*
6. **Review-and-apply UI** (user accepts → save via the PR #30 RLS-gated action). *(A-extraction)*
7. **File/extraction audit** (extend the `0010` append-only pattern to files). *(A-storage)*
8. **Org-scoped `files` read** (the deferred RISK-002 read broadening, with tests).

**Track B — replacement parity governance + build-out (each its own PR(s), with tests):**
1. **OMC workflow-by-workflow confirmation pass** — fill every §9 row; re-classify the matrix. *(governance; do this early — it sizes everything else)*
2. **OPS foundation (gates everything hosted):** first reviewed hosted **staging apply** + verification → hosted **Auth** exercise → **staging+prod Vercel** → **deploy/promote CI** → **rollback/DR/backup** runbook → **OMC data-migration** (Firestore+Storage → Postgres+Storage). *(A/B-ops; ~8–12)*
3. **Admin/core-platform:** password reset, user-management UI + writes, role-change UI, groups/org-membership admin UI, company/tenant settings, **audit-log viewer** + audit triggers for apps/files/users/memberships/invoices. *(B-admin; ~8–12)*
4. **Apps parity:** inventory cost/metric columns + cards + filter/search/sort/**export**, app create/edit/archive, governance/attestation (if confirmed), custom-field/calc engine (if confirmed), sync-health. *(B-apps; ~10–14)*
5. **App-contract link/unlink** + per-app cost-allocation %. *(B-apps)*
6. **Connectors:** **credential vault FIRST** — implement [19_CONNECTOR_CREDENTIAL_VAULT_DESIGN](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md) (RISK-007; design done PR #38, implementation+tests still owed) → **non-destructive upsert writer** + diff/preview → CSV/userlist ingestion → Okta + Google + Slack + generic → inbound email/API → scheduler infra → connector dashboards + audit. *(B-connectors; ~10–16, OMC-scope-dependent)*
7. **Imports preview/upsert** (non-destructive; shared by all connectors + manual upload). *(B-connectors)*
8. **Licenses/spend:** license-rule schema extension + editor + per-user eval + ELU/waste + app rollup; **invoices** (schema add status+period, list/detail, AI ingestion, prorated cost rollup). *(B-licenses; ~15–21)*
9. **People/identity:** org-scoped reads for people/identity_accounts → matching engine + rules + scheduled rebuild → People directory + Risks + Settings → real **UAR/Critical-Risk**. *(B-people; ~8–12)*
10. **Reports/exports/dashboards:** shared CSV/PDF export util → monthly-snapshot capture cron + table → the report suite → scheduled+emailed reports + run history → dashboards. *(B-reports; ~8–12)*
11. **IDC platform billing/revenue:** billing table + monthly cron + admin dashboard + branded invoice PDF. *(B-billing; ~4–6)*
12. **SSO/SCIM** (only if §9 confirms OMC uses them) — SAML sign-in + SCIM provisioning + IdP-group→role mapping. *(B-admin/connectors)*

*Owner: TBD per track — assign in the §9 confirmation pass. Dependencies: OPS gate (B-2) and credential vault (B-6) block large swaths; invoice schema + snapshot cron gate most of B-8/B-10.*

---

## 8. Current known replacement estimate (honest)

**This is NOT "a few PRs away."**

- A prior rough figure put production replacement at **~20–35 PRs**. The grounded legacy inspection behind
  this doc shows that is **optimistic for full parity** — it likely reflects only a *narrow* subset of what
  OMC uses.
- The legacy app spans **~105 distinct workflows** across ~40 routes + dozens of Cloud Functions. A
  from-current-state **full** production replacement is realistically **~70–110 PRs** (most likely landing
  ~85–95) at this repo's small, single-concern PR cadence — see the §7 per-track ranges, which sum into
  that band.
- **The actual required number depends entirely on the §9 OMC-confirmation pass.** Many large areas
  (SSO, SCIM, the connector long-tail, governance/attestations, custom fields, the full report suite,
  inbound channels) are `unknown-needs-OMC-confirmation`. If OMC's real usage is **narrow** (contracts +
  apps + manual file upload + a couple of connectors, no SSO/SCIM/governance), the required set could
  compress toward **~25–40 PRs**. If OMC uses the **full** breadth, it pushes to the **high end (110+)**.

**Key dependencies/unknowns that move the number:**
1. **The first hosted Supabase apply is unproven** — if RLS/Auth behave differently on hosted Supabase than the local shim, expect rework PRs.
2. **Credential vault (RISK-007)** gates ALL connectors.
3. **Invoice schema (status + period) + a monthly-snapshot cron** gate most reports AND license/spend cost.
4. **OMC data-migration** (Firestore → Postgres + Storage bytes + AI history) is bespoke and risky.
5. **Scheduler infra** (pg_cron vs external) is net-new.
6. **SSO/SCIM, connector long-tail, governance, custom-fields, allocation** are each multi-PR and conditional on OMC confirmation.

**This estimate must be revised** once §9 is filled with OMC-confirmed required workflows. Until then,
treat the high end as the planning assumption (do not plan around the optimistic floor).

---

## 9. Standing rule for future agents (obey)

- **Do not call OMC a pilot.** Do not say "pilot-ready" or "MVP pilot." OMC is a **paying production
  replacement** customer.
- **Do not optimize for a minimal viable pilot.** Optimize for **production-replacement parity** — no
  missing/broken workflows for a real OMC user.
- **Do not introduce product improvements before replacement parity** unless the difference is explicitly
  `better-approved` per §6 (documented, reviewed, accepted).
- **Do not close RISK-002 or RISK-016** unless tests **and** the product surface prove closure.
- **Do not claim readiness.** Cutover is a NO until every §5 box is true.
- **Fill the matrix from the running app, not from prior docs** — `unknown-needs-legacy-inspection` and
  `unknown-needs-OMC-confirmation` rows must be resolved with real evidence/confirmation, never invented.
- **Run the §9 OMC-confirmation list early** — it sizes the entire replacement (§8). Use
  [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md) as the working questionnaire/workshop/decision
  log; record confirmations there (with owner + date + evidence), then update the §4 rows + §5 checklist here.

### OMC confirmation list (resolve these to size + de-risk the cutover)
> **Work these through [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md)** — it expands each into a grouped questionnaire (§5), a workflow confirmation table (§6), an evidence checklist (§7), and a decision log (§8). Do not collect secrets/tokens during the pass (doc 18 §10).
1. **SAML SSO:** does OMC authenticate via SAML? (If yes → hard blocker; absent in v3.)
2. **SCIM provisioning:** does OMC provision login accounts and/or rosters via an IdP SCIM connector?
3. **Connected IdP feed:** is at least one IdP (Okta most likely) actually connected with matching rules? (If none → the People/identity/UAR area is data-empty and far lower risk; if yes → UAR/Critical-Risk/orphaned-spend are blockers.)
4. **Which connectors are configured** in OMC's tenant (Okta/Google/Slack confirmed live? any of the other ~48)? (Backend registers 53; UI labels 5; "Test All" is dead code.)
5. **Inbound channels:** how many email/API ingestors are live; is automated invoice email-forwarding in use?
6. **IDC platform billing:** confirm the real per-user rate (legacy hardcodes $1) + count basis; and whether the branded invoice PDF is actually sent to OMC or internal-only. *(Revenue-critical.)*
7. **Contract cost semantics:** legacy uses `monthlyCost` (annual = ×12); v3 has `total_cost` only, no monthly column. Which model do KPIs/reports rely on, and what is the canonical status set?
8. **Per-app cost allocation / chargeback:** does OMC split contract cost across linked apps by %?
9. **Daily auto-expire CRON:** does OMC rely on contracts auto-flipping to Expired?
10. **Group-scoped file visibility (legacy ABAC):** does OMC restrict any files to a subset of internal users? (If yes, v3's tenant-member read model is a regression.)
11. **AI enrichment model:** is v3's suggestions-only / human-review-and-apply acceptable vs legacy auto-write-on-upload?
12. **Audit granularity:** does OMC's compliance rely on field-level before→after change history? (v3 `0010` is coarser.)
13. **Hard delete vs archive:** does any workflow rely on hard-deleting apps/contracts/files/users/invoices? (v3 blocks hard delete; archive must be designed.)
14. **Governance/compliance attestations** (ISO 27001 / SOC 2 review types, cadence, signed history): in active use / audited against?
15. **Custom App/User fields + calc-expression engine:** does OMC rely on these?
16. **Legacy 'user' role mapping:** how should legacy `user` (group-only) accounts map to v3 org-only membership?
17. **Audit retention:** any compliance need for explicit log purge? (v3 is append-only.)
18. **Scheduled email reports + custom dashboards:** are any report schedules / dashboards active (check live `reportSchedules` + `dashboards`; `_home_dashboard` may back the home screen)?
19. **Reports/exports depth:** which reports does OMC actually run/export (CSV vs License-Analysis PDF), and which License-Analysis mode?
20. **Monthly summary emails:** opt-in mechanism on for any OMC user, or dormant/deprecated? (Two coexisting legacy mechanisms — do not build both.)
21. **API keys / Chrome plugin:** does OMC consume the programmatic API or Chrome plugin?
