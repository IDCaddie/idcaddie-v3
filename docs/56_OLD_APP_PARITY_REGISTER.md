# 10 · Old-App → New-App Parity Register

> **CURRENT CURSOR (updated 2026-07-08):** `idcaddie-v3` main @ `7f7d050`, PRs merged **through #284**.
> `idcaddie-connector-runner` main @ `84ecf6d`. **The `768f91a` / "through #264" figures below are this register's
> original 2026-07-07 snapshot — historical, not current.** The per-row PR/workstream tags below remain accurate for the
> rows they cite. Governance (current, 2026-07-10): RISK-007 is CLOSED at its staging-defined criteria; Phase C is UNBLOCKED as a governance state only (C-2c staging live sync completed 2026-07-10 (staging-only; production untouched; connector-runner PR #36)); production untouched; the C-2c connector live data-sync ran on staging only (connector-runner PR #36, 2026-07-10) (earlier hosted staging RISK-007 proof steps occurred under gated procedures, but those were
> not Phase C live data-sync); old-app parity is NOT complete.

**One-line purpose:** a single, honest, row-by-row map of what the **old ID Caddie app** (legacy Firebase app) let a user do, versus what the **new app** (this repo, `idcaddie-v3`) actually ships today — with, for every row, whether it is **safe to build before 2026-07-10**, what it would require (a database change, a live connector run, a privacy review), how risky it is, and the single next action.

**Audience:** everyone on the team — engineers, product, security reviewers, non-specialists, and future AI coding agents. This doc is written to be read cold. Acronyms are expanded on first use.

**Date of this register:** 2026-07-07. **Repo state (FACT):** `idcaddie-v3` main at commit `768f91a`, GitHub PRs through **#264** merged.

> ### Governance banner — read before acting (FACT)
> - **RISK-007 is OPEN.** RISK-007 is the governance risk that gates all handling and deletion of real third-party connector secrets. Its remaining criteria are **15** (permanent deletion of the staging source Slack secret — actionable **only after 2026-07-10**), **18** (the closure-register write-up), and **19** (the decision to unblock Phase C). See `04_RISK_REGISTER.md` and `52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md`.
> - **Phase C is BLOCKED.** "Phase C" is the gated phase in which live connector syncs run against real customer data. **No live connector sync has ever run.** Everything connector-related is staging-only, inert-by-default, behind a vault boundary.
> - **Staging only.** The only permitted Supabase project is the staging reference `ycdpzduxugdsffjqyoai`; migration `0041` is applied there read-only. The production reference `dzbfxulvxchdemcettrx` is **hard-blocked and untouched**.
> - This register **does not** close RISK-007, **does not** unblock Phase C, and **does not** propose any live sync before criteria 15/18/19 are met. Any such item is labelled a **gated exception**.

---

## How to read this register

### FACT vs INFERENCE
- **FACT** = something verified directly in this repo during the audit (a route file exists, a Data Access Layer module reads a given table, a migration enables Row Level Security). These are stated plainly and tagged **(FACT)** where it matters.
- **INFERENCE** = a judgement or a claim taken from another document — most old-app behavior is *code-derived*, not confirmed against the live old app (which is inaccessible). Old-app rows and status opinions are **(INFERENCE)** unless tagged otherwise. PR numbers are claims from the project's own records, not re-verified against GitHub here.

### Key terms (expanded once)
- **RLS = Row Level Security** — Postgres per-row access rules. In the new app, RLS is the **only** authorization boundary: a signed-in user sees a row only if a reviewed policy lets them.
- **DAL = Data Access Layer** — the server-only modules in `src/lib/data/*` that run every read. No browser code queries the database directly.
- **default-deny table** — a table with RLS switched **on** but with **no SELECT (read) policy**. Nothing in it is readable by anyone until a reviewed migration adds a policy. This is a *safe* default, not a bug.
- **migration** — a versioned SQL change file in `supabase/migrations/`. "Migration-first" means schema/policy changes land as a reviewed migration before any UI reads them.
- **connector-runner** — a *separate* worker repo (`idcaddie-connector-runner`) that will eventually run connector syncs behind the vault boundary. It is inert by default.

### Status vocabulary
| Status | Meaning |
|---|---|
| **complete** | The old capability is fully matched by a safe new-app equivalent. |
| **partial** | A safe slice ships; meaningful parts of the old capability are still missing. |
| **missing** | No new-app equivalent yet. |
| **intentionally-deferred** | Deliberately not built yet for a stated safety/privacy/governance reason — *not* an oversight. |
| **unsafe-do-not-copy** | The old app's implementation is a security anti-pattern; the new app must rebuild the *outcome* differently, never copy the pattern. See `60_DO_NOT_COPY_FROM_OLD_APP.md`. |

### The three gating flags (per row)
- **Migration?** — needs a reviewed database migration (usually to add a read policy to a default-deny table) before it can ship.
- **Live-sync / token / ECS?** — needs a real third-party token, a live connector sync, or the hosted ECS/Fargate runner — i.e. it touches the **RISK-007 / Phase C** gate and cannot proceed while that is blocked.
- **Privacy / security review?** — surfaces new personal or sensitive data (people, spend, secrets, exports) and needs an explicit privacy/security sign-off before shipping.

### "Safe before Jul 10?"
This column answers: *can this be safely advanced in the window before 2026-07-10 under the current freeze?*
- **Yes** = fits the **proven safe read-only rebuild pattern** (PRs #257–#264): a new read-only page + a user-scoped RLS DAL + a pure helper + render/unit tests, **zero migration, no service-role, no client-side tenant filter, fail-closed**.
- **Yes (migration-gated)** = safe to build, but only as **migration-first** with a privacy review — it exposes a default-deny table.
- **No** = depends on a gated capability (live connector sync, a real token, the hosted runner, or Phase C). Blocked by RISK-007 regardless of the calendar date.

### Workstream IDs
Internal planning labels (stable): **P** = product/UI parity, **C** = connectors/runner, **R** = risk/security, **M** = migration-gated data surfaces, **A** = AI features, **Q** = quality/tests. An ID is a planning label; the **real artifact is a merged GitHub PR number**. Completed work cites its PR; future work is written `Workstream X-0NN (GitHub PR: TBD)`.

### The other six docs in this pack (cross-references)
- `55_REBUILD_STATUS.md` — the current-state snapshot and merged-PR ledger this register aligns to.
- `57_CONNECTOR_PARITY_REGISTER.md` — the deep connector/runner parity story (owns every connector row's detail).
- `58_AI_FEATURE_PARITY_REGISTER.md` — the AI-feature parity story (owns every AI row's detail).
- `59_WORKSTREAM_ROADMAP.md` — the ordered plan that turns this register's "next actions" into sequenced work.
- `60_DO_NOT_COPY_FROM_OLD_APP.md` — the anti-pattern catalog behind every **unsafe-do-not-copy** tag.
- `61_NEXT_3_DAYS_PLAN.md` — the immediate slice of the roadmap.

---

## Master parity table

Compact view. Full per-row detail (what the user could do, why the status, gating, risk, tradeoff, next action) is in **Row details** below, keyed by the same number. Old-app locations are code-derived **(INFERENCE)**; new-app routes/DALs are verified **(FACT)**.

<div style="overflow-x:auto">

| # | Old feature (area) | Old location (code-derived) | New-app equivalent + route | Status | Safe before Jul 10? | Workstream |
|---|---|---|---|---|---|---|
| 1 | Home dashboard (metric cards/widgets) | `(authenticated)/page.tsx` | Read-only home summary · `/dashboards` | partial | Yes | P-001 (PR #257) |
| 2 | Custom dashboard builder | `dashboards/`, `/create`, `/[id]` | none | intentionally-deferred | Yes | P (PR: TBD) |
| 3 | Apps inventory | `IDCApps/page.tsx` | Apps list + filters/flags · `/apps` | partial | Yes | P-005 (PR #261) |
| 4 | App detail | `IDCApps/[id]/page.tsx` | App detail (read) · `/apps/[id]` | partial | Yes | P-007 (PR #264) |
| 5 | App settings / custom fields | `IDCApps/settings/page.tsx` | none | missing | Yes | P (PR: TBD) |
| 6 | Canonical app catalog | (new; ~`IDCApps` + custom fields) | Canonical catalog (read) · `/catalog` | complete (as scoped) | Yes | P-006 (PR #263) |
| 7 | Contracts (list/detail/create/edit) | `contracts/`, `/[id]`, `/create` | Contracts + write + file attach · `/contracts …/new …/edit` | partial | Yes | P-004 (PR #260) |
| 8 | Contract PDF AI extraction | `contracts` + `storage/processFileWithAI` | none (design only, `16_…`) | missing | No | A (PR: TBD) |
| 9 | Invoices / spend / chargeback | `invoices/`, `IDCApps/[id]/invoices` | none · table `invoices` is **default-deny** | intentionally-deferred | Yes (migration-gated) | M (PR: TBD) |
| 10 | License analysis / ELU | `IDCApps/insights/elu` | none · `license_rules`/`license_evaluations` **default-deny** | intentionally-deferred | Yes (migration-gated) | M (PR: TBD) |
| 11 | People / users directory | `people/page.tsx` | Accounts + match status · `/people` (NOT the directory) | partial | Yes (migration-gated for full) | M / R (PR: TBD) |
| 12 | People risk / UAR / stale | `people/risks`, `IDCApps/insights/{uar,stale}` | none | missing | Yes (migration-gated) | M / A (PR: TBD) |
| 13 | Files (inventory + detail) | `files/`, `files/[fileId]` | Files metadata (read) + contract-scoped upload · `/files` | partial | Yes | P (PR: TBD) |
| 14 | Inbound files / email / API-token ingest | `files/inbound`, `api/v1/ingest`, inbound tokens | none | unsafe-do-not-copy | No | C / R (PR: TBD) |
| 15 | Reports (7+ types) | `reports/*` (8 routes) | RLS-scoped counts summary · `/reports` | partial | Yes | P / M (PR: TBD) |
| 16 | Monthly procurement report | `email/monthlyProcurementReport` | none | missing | Yes | P (PR: TBD) |
| 17 | Scheduled / emailed reports | `email/*`, `scheduledJobs/*`, `reports/schedules` | none | missing | Yes | P (PR: TBD) |
| 18 | Exports (CSV / download) | per-report download | none | missing | Yes (privacy-reviewed) | P / M (PR: TBD) |
| 19 | Audit / logging viewer | `logging/`, `logging/[logId]` | Audit viewer (read) · `/audit` | partial | Yes | P (PR: TBD) |
| 20 | Admin / company settings | `admin/company`, `admin/recompute` | Read-only account context · `/admin` | partial | Yes | P / R (PR: TBD) |
| 21 | SSO / SAML / OIDC + SCIM | `admin/sso`, `scim/*` | none (password login only) | missing (some unsafe-do-not-copy) | No | R (PR: TBD) |
| 22 | Billing | `admin/billing`, `companies/billing` | none | intentionally-deferred | Yes (migration-gated) | M (PR: TBD) |
| 23 | Connectors (metadata + sync status) | `IDCApps/scraping`, `appScraping/*` | Read-only connector metadata + Slack sync status · `/connectors` | partial | Yes (read only) | C (PR: see `11_…`) |
| 24 | Connector scraping / config (52 providers) | `appScraping/scrapers/*` (52) | Framework designed; 1 provider (Slack), inert | missing | No | C (PR: see `11_…`) |
| 25 | Slack / Okta / IdP / SCIM sync surfaces | `appScraping/{slack,okta,…}`, `scim/*` | Slack: vault + framework, staging-only inert · `/internal/slack-sync`, `/connectors/oauth/callback` | partial (Slack) / missing (others) | No | C (PR: see `11_…`) |
| 26 | AI file / contract / invoice analysis | `storage/processFileWithAI`, `handleDocumentAICompletion`, `DocumentAIViewer` | none (PDF-validation core only) | missing (some unsafe-do-not-copy) | No | A (PR: see `12_…`) |
| 27 | DemoFeatures / IDCIngestor inbound ingest | `DemoFeatures/IDCIngestor/*`, `IDC_uploader.sh` | none | unsafe-do-not-copy | No | C / R (PR: TBD) |

</div>

---

## Row details

Each card carries the full field set the register requires. **User could do** and old locations are code-derived **(INFERENCE)**; new routes/DALs/migrations are **(FACT)**.

### 1 · Home dashboard — partial
- **User could do (old):** land on a home page of metric cards and widgets summarizing the SaaS estate.
- **New equivalent (FACT):** `/dashboards` is the authenticated home (`src/app/(authenticated)/dashboards/page.tsx`), backed by `dashboard-overview.ts` / `dashboard.ts` DALs that return RLS-scoped counts of apps/contracts and renewal/spend attention signals.
- **WHY partial:** it is a safe read-only summary of data the user may already see, not the old configurable widget surface.
- **Gating:** migration? No · live-sync/token/ECS? No · privacy/security review? No.
- **Risk:** Low. **Tradeoff:** less flexible than the old widget home, but ships now with zero new data exposure.
- **Workstream / next action:** P-001 (PR #257) shipped the home; P-003 (PR #259) added spend/renewals tiles. **Next:** none required for the safe slice; broaden tiles as underlying data surfaces (rows 9/10) land.

### 2 · Custom dashboard builder — intentionally-deferred
- **User could do (old):** create/edit personal dashboards from widgets.
- **New equivalent:** none.
- **WHY deferred:** a builder is high-effort UI with no safety value until the underlying spend/license/identity data surfaces exist; sequencing it after those avoids building charts over data we cannot yet read.
- **Gating:** migration? No (builder itself) · live-sync? No · privacy review? No.
- **Risk:** Low. **Tradeoff:** power users lose custom views; everyone keeps the fixed safe home (row 1).
- **Workstream / next action:** P (PR: TBD). **Next:** defer until rows 9/10/12 land; then scope a minimal saved-view feature in `59_WORKSTREAM_ROADMAP.md`.

### 3 · Apps inventory — partial
- **User could do (old):** browse all SaaS apps with cost, license utilization, and user metrics; filter and sort.
- **New equivalent (FACT):** `/apps` with `apps-inventory.ts` / `apps.ts` DALs; filters and attention flags shipped.
- **WHY partial:** app identity, names, and basic flags render, but cost/license-utilization columns depend on the still-deferred spend (row 9) and license (row 10) surfaces.
- **Gating:** migration? No (current slice) · live-sync? No · privacy review? No.
- **Risk:** Low. **Tradeoff:** inventory is browsable now; the money/utilization columns wait on migration-gated data.
- **Workstream / next action:** P-005 (PR #261) shipped filters/flags. **Next:** add cost/utilization columns only after rows 9/10.

### 4 · App detail — partial
- **User could do (old):** open one app to see its user roster, invoices, compliance reviews, and linked contracts/documents.
- **New equivalent (FACT):** `/apps/[id]` with `apps.ts`, `app-account-intelligence.ts`, `app-user-matches.ts`; app-detail catalog mapping shipped.
- **WHY partial:** roster (via `app_users`), linked contracts, and catalog mapping render; invoices and compliance reviews are not surfaced (invoices default-deny, row 9).
- **Gating:** migration? No (current slice) · live-sync? No · privacy review? No.
- **Risk:** Low. **Tradeoff:** a usable detail view now; spend/compliance panels wait on migrations.
- **Workstream / next action:** P-007 (PR #264) shipped catalog mapping. **Next:** add invoices panel after row 9.

### 5 · App settings / custom field definitions — missing
- **User could do (old):** define custom fields on apps.
- **New equivalent:** none.
- **WHY missing:** low-priority configuration surface; the canonical catalog (row 6) covers the more valuable "what app is this really" need first.
- **Gating:** migration? Likely (custom-field schema) · live-sync? No · privacy review? No.
- **Risk:** Low. **Tradeoff:** less per-tenant customization short-term.
- **Workstream / next action:** P (PR: TBD). **Next:** scope after core read surfaces; likely needs a reviewed schema migration.

### 6 · Canonical app catalog — complete (as scoped)
- **User could do (old):** the old app had per-app custom fields but no single canonical catalog; this is a **new safe capability**.
- **New equivalent (FACT):** `/catalog` with `catalog.ts` / `catalog-view.ts` DALs reading `vendors`, `app_products`, `app_aliases` (RLS-scoped).
- **WHY complete-as-scoped:** the read-only canonical catalog and its app-detail mapping are fully shipped for their defined scope.
- **Gating:** migration? No (tables already present) · live-sync? No · privacy review? No.
- **Risk:** Low. **Tradeoff:** none material; adds structure the old app lacked.
- **Workstream / next action:** P-006 (PR #263) + P-007 (PR #264). **Next:** none for the current scope.

### 7 · Contracts (list / detail / create / edit) — partial
- **User could do (old):** list/detail/create/edit contracts, attach PDFs, link contracts to apps, see renewals; a daily CRON flagged renewals/expiry.
- **New equivalent (FACT):** `/contracts`, `/contracts/[id]`, `/contracts/new`, `/contracts/[id]/edit`; DALs `contracts.ts`, `contract-write.ts` (the **only** write workflow), `contract-files.ts` (upload), `contract-attention.ts` + `links.ts`. Migrations `0010` (audit-on-write), `0011` (form-parity fields).
- **WHY partial:** full list/detail/create/edit + file attach + renewal/attention flags ship; PDF **AI** extraction (row 8) and the contract gantt/timeline view do not.
- **Gating:** migration? No (already applied on staging) · live-sync? No · privacy review? No.
- **Risk:** Low–Medium (it is a write path; it is audited append-only and RLS-scoped). **Tradeoff:** manual data entry until AI extraction lands.
- **Workstream / next action:** P-004 (PR #260) shipped renewal/attention flags. **Next:** field-parity check vs `15_LEGACY_CONTRACT_FORM_INSPECTION.md`; AI extraction tracked under row 8 / `12_…`.

### 8 · Contract PDF AI extraction — missing
- **User could do (old):** upload a contract PDF and have AI (Google Document AI + Vertex/Gemini) auto-extract fields.
- **New equivalent:** none. Only the server-side PDF-validation core exists (PR #40); the extraction design lives in `16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md`.
- **WHY missing:** the AI worker, completion handler, and review UI are unbuilt; the required security model (suggestions-only, no silent overwrite, prompt-injection allowlist) is designed but not implemented.
- **Gating:** migration? Possibly · live-sync/token/ECS? Yes (out-of-request AI worker + model access) · privacy/security review? **Yes**.
- **Risk:** High (hostile file + hostile model-output boundaries). **Tradeoff:** manual entry (row 7) is safe but slower.
- **Workstream / next action:** A (PR: TBD). **Next:** owned by `58_AI_FEATURE_PARITY_REGISTER.md`; do **not** copy the old service-role onFinalize worker or "extract ALL fields / silent autosave" pattern (`14_…`).

### 9 · Invoices / spend / chargeback — intentionally-deferred
- **User could do (old):** review invoices per app, dispute, and run monthly billing/chargeback with FX conversion.
- **New equivalent (FACT):** none. The `invoices` table exists and has **RLS enabled but NO SELECT policy** — it is **default-deny** (verified: only a delete-hardening policy in `0004`, no read policy).
- **WHY deferred:** invoices are sensitive spend data; nothing may read them until a reviewed read policy migration is added deliberately.
- **Gating:** **migration? Yes** (add a reviewed SELECT policy, migration-first) · live-sync? No · **privacy/security review? Yes**.
- **Risk:** Medium. **Tradeoff:** no spend visibility yet; the safe default prevents accidental exposure.
- **Workstream / next action:** M (PR: TBD). **Next:** write the reviewed read-policy migration, then a read-only `/invoices` surface following the #257–#264 pattern.

### 10 · License analysis / ELU (Effective License Utilization) — intentionally-deferred
- **User could do (old):** see effective license utilization and waste per app.
- **New equivalent (FACT):** none. `license_rules` and `license_evaluations` exist but are **default-deny** (RLS on, no SELECT policy — verified).
- **WHY deferred:** same as row 9 — a reviewed read policy must be added before any license surface reads them.
- **Gating:** **migration? Yes** · live-sync? No · **privacy/security review? Yes** (cost + entitlement data).
- **Risk:** Medium. **Tradeoff:** no waste insight yet; prevents premature exposure of entitlement/cost data.
- **Workstream / next action:** M (PR: TBD). **Next:** migration-first read policy → read-only ELU surface. Feeds rows 3/4 columns and row 12.

### 11 · People / users directory — partial
- **User could do (old):** browse a unified people directory (identity-provider + app-only), drill into each person's app accounts.
- **New equivalent (FACT):** `/people` with `people.ts` reads **only** `app_users` (org-scoped read `0007`) + match status from `app_user_identity_matches` (`0008`). It **deliberately does not** read the `people` table or `identity_accounts`.
- **WHY partial (and a deliberate privacy deferral):** the `people` table **is** tenant-member-readable (it has RLS policies — verified), but the route intentionally exposes **no person PII** — only the app account's own fields plus a matched/unmatched status. The full directory read (`people` / `identity_accounts`) stays deferred under RISK-002. Note `identity_accounts` is itself **default-deny** (RLS on, no SELECT policy — verified).
- **Gating:** migration? No for the current slice; **Yes** to expose `identity_accounts` for the full directory · live-sync? No · **privacy/security review? Yes** for the full directory.
- **Risk:** Low (current slice) / Medium (full directory). **Tradeoff:** users see accounts + match status now, not resolved identities — which avoids implying a match/merge the system has not actually made.
- **Workstream / next action:** M / R (PR: TBD). **Next:** decide (privacy review) whether/how to surface the full directory; if yes, migration-first for `identity_accounts`.

### 12 · People risk / UAR / stale users — missing
- **User could do (old):** see Unmanaged Account Ratio (UAR = share of app accounts with no matched managed identity), orphan/shadow-IT risk tiers, and stale (sync-inactive) users.
- **New equivalent:** none.
- **WHY missing:** UAR/stale depend on the identity graph plus license/last-active data (rows 10/11) and on real connector sync freshness (rows 23–25) — the inputs are not all readable yet.
- **Gating:** migration? Yes (identity/license reads) · live-sync/token/ECS? Partly (freshness needs real syncs) · privacy/security review? Yes.
- **Risk:** Medium–High. **Tradeoff:** no shadow-IT/risk insight yet; building it on incomplete inputs would mislead.
- **Workstream / next action:** M / A (PR: TBD). **Next:** sequence after rows 10/11; freshness metrics wait on connector data (gated).

### 13 · Files (inventory + detail) — partial
- **User could do (old):** browse a document inventory with per-file detail and AI-processing status.
- **New equivalent (FACT):** `/files` with `files.ts` reads file **metadata** (tenant-member scope, migrations `0012`/`0013`); contract-scoped upload exists via `contract-files.ts` (`0014`–`0016`).
- **WHY partial:** a metadata list + contract-attached upload ship; a standalone per-file detail page, AI-status column, and download-all do not.
- **Gating:** migration? No (current slice) · live-sync? No · privacy/security review? Yes for any download/egress surface.
- **Risk:** Low (metadata) / Medium (file download/egress). **Tradeoff:** users see file metadata now; bulk download deferred (row 18).
- **Workstream / next action:** P (PR: TBD). **Next:** file-detail read page; hold download behind a privacy review.

### 14 · Inbound files / email / API-token ingest — unsafe-do-not-copy
- **User could do (old):** ingest files via inbound email addresses and HTTP API tokens; configure ingest channels.
- **New equivalent:** none.
- **WHY unsafe-do-not-copy:** the old app used **id-as-secret** inbound/email tokens and stored ingest credentials insecurely; copying that pattern would reintroduce a credential-leak vector. The outcome must be rebuilt behind the vault, never the old pattern.
- **Gating:** migration? Yes · **live-sync/token/ECS? Yes** (credential handling) · **privacy/security review? Yes**.
- **Risk:** High. **Tradeoff:** no inbound ingest yet; avoids re-creating a leak-prone token surface.
- **Workstream / next action:** C / R (PR: TBD). **Next:** design under the vault model (`42_…`) and the anti-pattern list (`14_…`); gated behind RISK-007.

### 15 · Reports (7+ types) — partial
- **User could do (old):** run 7+ report types (cost snapshot, IT spend, license analysis, monthly snapshot, user comparison, overlap analysis, etc.).
- **New equivalent (FACT):** `/reports` with `reports.ts` returns **RLS-scoped counts only** (apps/contracts/files visible, accounts matched/unmatched) — `head:true` counts, no row data. It **invents no report**: every number is a count of rows the user may already read.
- **WHY partial:** a safe counts summary ships; none of the 7 analytical report types do (they need spend/license/identity data, rows 9–12).
- **Gating:** migration? Yes for the real reports · live-sync? No · privacy/security review? Yes (aggregated spend).
- **Risk:** Low (counts) / Medium (real reports). **Tradeoff:** a trustworthy summary now instead of rich-but-unbuildable reports.
- **Workstream / next action:** P / M (PR: TBD). **Next:** build individual reports as their data surfaces land (rows 9/10/11).

### 16 · Monthly procurement report — missing
- **User could do (old):** receive a monthly procurement report (rendered + emailed).
- **New equivalent:** none.
- **WHY missing:** depends on spend/license data (rows 9/10) and an email/report-rendering pipeline that does not exist.
- **Gating:** migration? Yes · live-sync? No · privacy/security review? Yes (emailed spend data leaves the app).
- **Risk:** Medium. **Tradeoff:** no automated procurement summary yet.
- **Workstream / next action:** P (PR: TBD). **Next:** after rows 9/10; treat email egress as a privacy-reviewed step.

### 17 · Scheduled / emailed reports — missing
- **User could do (old):** schedule reports to generate and email on a cadence (CRON runners, saved configs).
- **New equivalent (FACT of adjacency):** none for *reports*. Note a `/api/internal/slack-scheduler` route exists, but that is **connector-sync scheduling**, not report scheduling — do not conflate.
- **WHY missing:** no report engine (row 15) and no report-delivery pipeline.
- **Gating:** migration? Yes · live-sync? No · privacy/security review? Yes (scheduled egress).
- **Risk:** Medium. **Tradeoff:** manual/on-demand only until the report engine exists.
- **Workstream / next action:** P (PR: TBD). **Next:** deferred until row 15 matures.

### 18 · Exports (CSV / download) — missing
- **User could do (old):** export/download per-report CSVs.
- **New equivalent:** none.
- **WHY missing:** export is a **data-egress** surface; it must be scoped and privacy-reviewed, not bolted on.
- **Gating:** migration? No (if exporting already-readable data) · live-sync? No · **privacy/security review? Yes** (egress).
- **Risk:** Medium. **Tradeoff:** no bulk export yet; prevents unreviewed data leaving the app.
- **Workstream / next action:** P / M (PR: TBD). **Next:** design a privacy-reviewed export of already-RLS-readable data only.

### 19 · Audit / logging viewer — partial
- **User could do (old):** view an audit log with before/after diffs across document types; the old app also ran a **90-day destructive purge**.
- **New equivalent (FACT):** `/audit` with `audit.ts` reads `audit_logs` (append-only, migration `0010`).
- **WHY partial:** a read-only viewer of write-audit events ships; full before/after diffing across all document types is not complete. The old **90-day purge is intentionally NOT copied** — the new audit log is append-only (a *removed-approved* deviation).
- **Gating:** migration? No · live-sync? No · privacy/security review? No.
- **Risk:** Low. **Tradeoff:** append-only storage grows unbounded but is tamper-evident and complete — a deliberate, safer choice than the old purge.
- **Workstream / next action:** P (PR: TBD). **Next:** enrich diffs as more write paths land.

### 20 · Admin / company settings — partial
- **User could do (old):** edit company profile, domain rules, API keys; manually recompute derived fields.
- **New equivalent (FACT):** `/admin` shows a **read-only** account context (signed-in email + active tenant/org **names and roles**, never raw ids). No writes, no invitations, no role changes, no billing, no API-key/SSO/SCIM/retention management — each shown explicitly as "Not built yet".
- **WHY partial:** the context viewer ships; all administration writes are deliberately absent.
- **Gating:** migration? Yes for any admin write surface · live-sync? No · privacy/security review? Yes for writes.
- **Risk:** Low (viewer) / Medium (future writes). **Tradeoff:** transparency now, no admin power yet.
- **Workstream / next action:** P / R (PR: TBD). **Next:** scope any admin write as its own reviewed workstream.

### 21 · SSO / SAML / OIDC + SCIM — missing (some unsafe-do-not-copy)
- **User could do (old):** enterprise sign-in (SAML/OIDC) and SCIM (System for Cross-domain Identity Management) provisioning via tokens.
- **New equivalent:** none — the new app is **password login only** (`/login`).
- **WHY missing / unsafe:** SSO/SCIM are enterprise-auth surfaces not yet built; the old app's **SCIM token = id-as-secret** pattern is an anti-pattern to avoid.
- **Gating:** migration? Yes · **live-sync/token? Yes** (identity-provider integration) · **privacy/security review? Yes**.
- **Risk:** High. **Tradeoff:** no enterprise auth yet; blocks some cutover scenarios (tracked in `04_RISK_REGISTER.md`).
- **Workstream / next action:** R (PR: TBD). **Next:** design SSO first; never copy the old SCIM token model (`14_…`).

### 22 · Billing — intentionally-deferred
- **User could do (old):** subscription billing of identity-provider users; monthly billing calculation.
- **New equivalent:** none.
- **WHY deferred:** billing depends on spend/license data (rows 9/10) and is out of scope for the current safe read-only phase.
- **Gating:** migration? Yes · live-sync? No · privacy/security review? Yes.
- **Risk:** Medium. **Tradeoff:** no billing yet; correctly sequenced after spend surfaces.
- **Workstream / next action:** M (PR: TBD). **Next:** deferred until rows 9/10.

### 23 · Connectors (metadata + sync status) — partial
- **User could do (old):** view scraper/connector config and sync status per app.
- **New equivalent (FACT):** `/connectors` with `connectors.ts` + `manual-sync-runs.ts` + `slack-sync-display.ts` renders **Tier-1 metadata only** (provider, label, status, safe scopes, timestamps, latest-run status + safe counters). It **never** queries `connector_secrets` — no ciphertext, keys, tokens, or webhook secrets. Connecting/credentials/OAuth/sync/disconnect are shown as "not built".
- **WHY partial:** the safe read-only status surface ships; nothing live runs.
- **Gating:** migration? No (read surface) · **live-sync/token/ECS? Yes** for any real sync · privacy/security review? Yes for live.
- **Risk:** Low (metadata read) / High (live). **Tradeoff:** users see status honestly, including the gap, without any secret exposure.
- **Workstream / next action:** C — detail owned by `57_CONNECTOR_PARITY_REGISTER.md`. **Next:** none for the read surface; live sync is gated (row 24).

### 24 · Connector scraping / config (52 providers) — missing
- **User could do (old):** 52 connectors scraped app/user inventory + usage; config + scheduled sync per provider.
- **New equivalent:** a **connector framework is designed** (`54_CONNECTOR_FRAMEWORK_DESIGN.md`): reviewed provider manifests interpreted by one generic executor in the connector-runner. Slack v1 manifest exists; the generic executor, per-item schema registry, membership fan-out, and live sync are **unbuilt**. **Zero connectors are live.**
- **WHY missing:** this is the largest gap and is chokepointed on RISK-007. Even a staging read-only sync (Phase 2c) is **readiness-only / not authorized**.
- **Gating:** migration? Yes (writer boundary `0041`, staging-only) · **live-sync/token/ECS? Yes** · **privacy/security review? Yes**.
- **Risk:** High. **Tradeoff:** honest "1-of-52, executor not built, live sync not running" instead of an unsafe rush.
- **Workstream / next action:** C — owned by `11_…`. **Next (gated exception, do not act early):** only after criteria 15 → 18 → 19, per `52_…`.

### 25 · Slack / Okta / IdP / SCIM sync surfaces — partial (Slack) / missing (others)
- **User could do (old):** per-provider identity/app sync (Slack, Okta, other identity providers, SCIM).
- **New equivalent (FACT):** Slack is the one provider with vault + framework work. `/internal/slack-sync` (dev/test scaffold) and `/connectors/oauth/callback` exist. On **staging only**, a real per-tenant Slack bot token has been stored envelope-only, decrypted/used, and rotated (RUN GATE A/B) — all inert-by-default. Okta and other providers: none.
- **WHY partial/missing:** Slack proves the vault path on staging; no live customer sync has run; other providers are unbuilt.
- **Gating:** migration? Yes (staging) · **live-sync/token/ECS? Yes** · **privacy/security review? Yes**.
- **Risk:** High. **Tradeoff:** one provider proven safely on staging; broad IdP parity remains far off.
- **Workstream / next action:** C — owned by `11_…`. **Next:** honest-scope caveat — RUN GATE B rotated the vault version but wrapped the **same** underlying Slack token; provider-side rotation/revoke is deferred. Do not read staging success as production-ready.

### 26 · AI file / contract / invoice analysis — missing (some unsafe-do-not-copy)
- **User could do (old):** AI-extract structured fields from contract **and invoice** PDFs (Google Document AI + Vertex/Gemini), reviewed in a split-view UI.
- **New equivalent:** none built; only PDF-validation core (PR #40) + the Storage boundary. Contract-side design is `16_…`; **non-contract AI (invoices, multiple document types) has no v3 design doc**.
- **WHY missing / unsafe:** no extraction worker/completion-handler/review UI. The old **service-role onFinalize worker**, "extract ALL fields" unbounded output, and **silent autosave overwrite** are anti-patterns.
- **Gating:** migration? Possibly · **live-sync/token/ECS? Yes** (out-of-request AI) · **privacy/security review? Yes**.
- **Risk:** High. **Tradeoff:** manual entry is safe but slow; correctness/security first.
- **Workstream / next action:** A — owned by `58_AI_FEATURE_PARITY_REGISTER.md`. **Next:** design invoice/other AI; enforce suggestions-only + prompt-injection allowlist (`14_…`).

### 27 · DemoFeatures / IDCIngestor inbound ingest — unsafe-do-not-copy
- **User could do (old):** push app/user data in via connector scripts and an inbound API ingestor (`IDC_uploader.sh`, `create_IDC_api.sh`, per-provider demo scrapers).
- **New equivalent:** none.
- **WHY unsafe-do-not-copy:** shell-script token ingestion with plaintext credentials is a security anti-pattern; the outcome (bulk inbound data) must be rebuilt as **non-destructive upsert + preview** behind the vault, never via the old scripts.
- **Gating:** migration? Yes · **live-sync/token/ECS? Yes** · **privacy/security review? Yes**.
- **Risk:** High. **Tradeoff:** no quick demo-style ingest; avoids reintroducing plaintext-credential handling.
- **Workstream / next action:** C / R (PR: TBD). **Next:** fold into the vault-gated connector/import design; gated behind RISK-007.

---

## Appendix A · Default-deny tables (verified) — why several rows say "requires a migration"

**FACT (verified in `supabase/migrations/0001_core_schema.sql` + `0002_org_scoped_rls.sql`):** the following tables have **Row Level Security enabled but no SELECT (read) policy** — they are **default-deny**. Nothing can read them until a reviewed migration deliberately adds a read policy. This is why rows 9, 10, and the full-directory part of 11 are gated on a **migration-first** step plus a privacy review, not just on UI work.

| Table | State | Blocks which row(s) |
|---|---|---|
| `invoices` | RLS on, no SELECT policy (only a delete-hardening policy in `0004`) | 9 (invoices/spend), 4 (app-detail invoices panel), 15/16 (spend reports) |
| `license_rules` | RLS on, no SELECT policy | 10 (ELU), 3 (utilization columns), 15 (license report) |
| `license_evaluations` | RLS on, no SELECT policy | 10 (ELU), 12 (UAR inputs) |
| `identity_accounts` | RLS on, no SELECT policy | 11 (full people directory) |

**Contrast — `people` is members-read, deferred by choice, not by default-deny (FACT):** the `people` table **does** have RLS read policies (tenant-member scope). It is **not** default-deny. The `/people` route nonetheless **deliberately** reads only app-account fields + match status and exposes no person PII — a **privacy deferral** under RISK-002, reversible only via an explicit privacy review, not merely a migration. Do not confuse "deferred for privacy" (people) with "default-deny, needs a read policy" (identity_accounts/invoices/license_*).

## Appendix B · The proven safe rebuild pattern (why so many rows are "Yes, safe before Jul 10")

PRs #257–#264 established a repeatable, low-risk recipe (FACT — these routes/DALs/tests exist in the repo): **a new read-only page + a user-scoped RLS DAL in `src/lib/data/*` + a pure helper + render/unit tests, with zero migration, no service-role, no client-side tenant filter, ids-as-keys/booleans only, fail-closed.** Any row marked **Yes** in "Safe before Jul 10?" can follow this recipe. Rows marked **Yes (migration-gated)** follow the same recipe but must first land a reviewed read-policy migration (Appendix A) and a privacy review. Rows marked **No** depend on the RISK-007 / Phase C gate and must not be advanced early.

## Appendix C · Honest current-state summary (one paragraph)

The new app ships roughly a dozen **read-only** product surfaces plus **one write workflow** (contracts). Everything shipped follows the safe RLS-first pattern and exposes only data the signed-in user is already permitted to read. The big remaining gaps are all deliberate: **spend/license/identity data** sit behind default-deny tables awaiting reviewed migrations + privacy review (rows 9–12); **connectors/AI** sit behind the RISK-007 governance gate with **no live sync ever run** (rows 24–26); and several old surfaces are **unsafe-do-not-copy** anti-patterns to be rebuilt differently (rows 14, 21, 27). "Read-only surfaces ship" does **not** mean "production-ready": only migrations `0001`–`0015` + Storage reached production; `0016`–`0041` are staging-only, and the production Supabase project is untouched. Sequencing and next steps are owned by `59_WORKSTREAM_ROADMAP.md` and `61_NEXT_3_DAYS_PLAN.md`; connector and AI row detail live in `57_CONNECTOR_PARITY_REGISTER.md` and `58_AI_FEATURE_PARITY_REGISTER.md`; the anti-patterns behind every unsafe tag are catalogued in `60_DO_NOT_COPY_FROM_OLD_APP.md`; and the overall status snapshot is `55_REBUILD_STATUS.md`.
