# 41 · Full-Parity Implementation Roadmap

**Purpose:** turn "full old-app parity" ([38](./38_OMC_FULL_PARITY_SCOPE_DECISION.md)) into an ordered set of
implementation **epics**, dependency gates, connector waves, and realistic PR-count ranges, grounded in the
code-derived inventory ([40](./40_CODE_DERIVED_OLD_APP_INVENTORY.md)). **This PR creates a full-parity
implementation roadmap; it does not implement parity.**

> ## ⚠️ STATUS BANNER (do not remove)
> - **This PR creates a full-parity implementation roadmap; it does not implement parity.** No feature built.
> - **OMC requires full old-app parity before cutover unless OMC explicitly waives a specific capability. The MVP
>   subset framing is not sufficient for OMC cutover.**
> - **Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete.**
> - **Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified.**
> - **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage
>   completion is necessary but not sufficient for cutover.** No doc 17 §5 box ticked.

---

## 1. Current known state (from docs 37–40)

- **Done + verified:** staging+production Storage REST 14/14 (docs 25/29); hosted Auth/session/tenant-context
  (doc 31 §7). **Built (read/write, local-verified, hosted-flows unverified):** apps read, contracts read +
  create/edit (`0004`/`0010`), app-users + match-status read, Storage **boundary** (no upload UI). Local RLS **222**.
- **Code-derived legacy scale (doc 40):** 50+ frontend routes, backend functions across 20+ modules, **52
  connectors** + ingestor, AI Doc-processing for **contracts and invoices**, **7 report types**, SSO/SAML/OIDC +
  SCIM, groups + granular permissions, billing, Chrome extension. **Almost everything is Missing in v3.**
- **Scope is decided (doc 38):** full parity unless OMC waives in writing; **doc 17 §5 = 0/17 boxes.**

---

## 2. Acceptance criteria — applies to EVERY epic (Task 3)

Unless noted otherwise, an epic is "done" only when: it reaches **legacy parity** for its rows (or those rows are
OMC-`waived` in writing — doc 38 §5); each PR **cites its [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) row(s)**;
carries **RLS tests** (`org_rls_test.sql`) + **hosted staging validation** + recorded **evidence**; uses **no
service-role on any request path** (`check-auth-safety.sh` green); writes are **audited** where sensitive; and it
**ticks no doc 17 §5 box on its own**. Per-epic specifics are in the tables below.

## 3. Epic roadmap — the "what" (dependency-ordered)

| # | Epic | Scope | Legacy evidence | v3 status |
|---|---|---|---|---|
| E01 | Core shell / nav / UI parity | authenticated shell, nav, breadcrumbs, loading/empty/error, table primitives | `(authenticated)/layout.tsx`, `components/`, `hooks/useTable*` | Partial |
| E02 | Dashboard / home / custom dashboards | home metrics + the custom **dashboards builder** | `/page.tsx`, `/dashboards*` | Missing |
| E03 | Apps inventory / detail parity | list (cost/util/user metrics), detail (roster/invoices/compliance/linked) | `/IDCApps`, `/IDCApps/[id]` | Partial |
| E04 | App users parity | per-app roster, status, bulk | `IDCApps/[id]` roster, `listUsers` | Partial |
| E05 | Identity users / employees parity | people directory (IdP + app-only), drill-down | `/people`, `rebuildPeople`, `companies/people` | Missing |
| E06 | App-user identity matching parity | matching rules, merge, match status | `/people/settings`, `syncIdpAssignments`, `0008` | Partial |
| E07 | Contracts list/detail/create/edit parity | full field parity + gantt/timeline | `/contracts*`, `CONTRACT_FIELD_ORDER`, doc 15 | Partial |
| E08 | Contract steward / write workflow parity | authority, audit, delete/archive, link/unlink | `updateContract`, `0004`/`0010` | Partial |
| E09 | Files / upload / download parity | upload action, signed-URL read, preview, file↔app/contract links, inbound | `/files*`, `files/*`, Storage (done boundary) | **Partial — contract attachments (upload + signed-URL open) shipped PR #76 (E09a); files-page/preview/inbound/links remain** |
| E10 | Invoices parity | invoice inventory/detail, chargeback | `/invoices*`, `companies/billing` | Missing |
| E11 | Spend / license / account intelligence | ELU/waste, spend, account-intel | `IDCApps/insights/elu`, invoice AI | Partial/Missing |
| E12 | Shadow IT / unmanaged accounts | UAR, stale users, orphan/shadow risk | `insights/uar`,`stale`, `/people/risks` | Missing |
| E13 | Imports / exports / ingestion | non-destructive upsert + preview; CSV; inbound | `/files/inbound`, `api/v1`, `IDCIngestor`, `runMigration` | Missing |
| E14 | Reporting / scheduled reports | 7 report types + scheduler + email + export | `/reports/*`, `email/*`, `scheduledJobs` | Missing |
| E15 | AI document processing (contracts + invoices) | extraction worker, completion handler, review UI | `storage/processFileWithAI`, `handleDocumentAICompletion`, `documentPrompts` | Missing |
| E16 | **Connector vault / token security foundation** | encrypted credential vault (prerequisite for all connectors) | `setAppPrivateData`, `PRIVATE_CREDENTIALS_SCHEMA`, doc 19 | Missing (RISK-007) |
| E17 | Connector framework | scraper-config schema, scheduler, run/test/log, sync model | `appScraping/automatedScrapingService`, `scraperConfigManager` | Missing |
| E18 | Connector provider batches (52) | per-provider scrapers in waves (§4) | `appScraping/scrapers/*` (52) | Missing |
| E19 | SSO / SAML / OIDC parity | enterprise SSO + callback | `/admin/sso`, `services/samlAuth`,`oidcAuth`, `/sso-callback` | Missing |
| E20 | SCIM parity | SCIM provisioning + token mgmt | `scim/*`, `generateScimToken` | Missing |
| E21 | Admin / company / users / groups / permissions | admin screens, groups, granular permissions, recompute | `/admin/*`,`/company/*`, `groups/*` | Partial/Missing |
| E22 | Billing / admin parity | subscription billing, monthly billing, FX | `/admin/billing`, `calculateMonthlyBilling`, currency | Missing |
| E23 | Audit / logging parity | audit viewer + before/after diff (keep append-only; **no 90-day purge**) | `/logging*`, `logging/*`, `0002`/`0010` | Partial |
| E24 | Browser extension / discovery parity | Chrome extension discovery/ingest | `extension/`, `chromePluginFunction` | Missing |
| E25 | OMC-shaped data migration | execute doc 34 (Firestore→v3) | doc 34 | Planned |
| E26 | Rollback rehearsal | execute doc 35 in staging | doc 35 | Planned |
| E27 | OMC acceptance / signoff + final doc 17 closure | record doc 36 signoff; close the 17 §5 boxes | docs 36/17 | Planned |

## 3b. Epic roadmap — the "execution" (security · deps · PRs · acceptance · blocker)

| # | Security / RLS / storage / Auth | Dependencies | PR range | Acceptance specifics | Blocker |
|---|---|---|---|---|---|
| E01 | RLS unchanged; no service-role | — | 2–4 | shell+nav parity; a11y basics | Yes |
| E02 | RLS-scoped reads; per-tenant metrics | E01, E03/E11 (data) | 3–6 | dashboards render per tenant; builder saves | Yes |
| E03 | org-scoped reads (`0006`–`0008`) | E01 | 3–6 | counts/metrics match legacy | Yes |
| E04 | org-scoped reads | E03 | 2–4 | roster parity per tenant | Yes |
| E05 | default-deny `people`/`identity` reads | E01; identity data (E13/E18) | 4–8 | directory parity; no cross-tenant leak | Yes |
| E06 | match read grants no collateral read | E05 | 3–6 | matching parity; isolation tests | Yes |
| E07 | `0004` authority; `paying_org` no write | E01 | 4–8 | field-by-field legacy parity | Yes |
| E08 | soft delete only (no hard delete); audit `0010` | E07 | 3–6 | write/link/delete authority + audit | Yes |
| E09 | **no service-role**; private bucket + signed URLs; files-row-first (`0013`) | Storage boundary (done) | 4–8 | upload→row+object; cross-tenant/anon denied (re-run REST verifier) | Yes |
| E10 | RLS-scoped; audit writes | E03, E13 | 3–6 | invoice/chargeback parity | Yes |
| E11 | RLS-scoped; no PII in telemetry (RISK-013) | E03, E10, E18 | 5–10 | ELU/spend output matches legacy | Yes |
| E12 | org-scoped; default-deny | E05, E11 | 3–6 | UAR/stale parity | Yes |
| E13 | **non-destructive** upsert+preview; tenant-scoped; no blind delete | E03/E05 targets | 4–8 | import-safety (no blind delete); export formats | Yes |
| E14 | RLS-scoped export (no cross-tenant rows) | E03/E05/E11 data | 6–12 | per-report parity; scheduled send | Yes |
| E15 | out-of-request worker; **no service-role on request path**; suggestions-only | E09 (upload) | 4–8 | extraction parity; no silent overwrite | Yes |
| E16 | **secrets never in a column/types/logs**; vault (Supabase Vault/KMS); isolated access | doc 19; RISK-007 | 3–6 | encrypt/store/rotate/access tests; closes/narrows RISK-007 | **Yes (gates E17/E18)** |
| E17 | least-privilege sync job; never service-role on request path | **E16** | 4–8 | config/run/test/log + safe-sync tests | Yes |
| E18 | per-provider token via vault; safe sync | **E16, E17** | **8–52+** (by wave §4) | per-connector inventory+user parity | Yes (per OMC waivers) |
| E19 | SSO security review; session integrity | E01, Auth | 4–8 | SSO login parity; no auth bypass | Yes |
| E20 | SCIM token security; provisioning audited | E05, E19 | 3–6 | SCIM provisioning parity | Yes |
| E21 | RLS role model; **no self-promote**; granular perms | E01; RLS | 6–12 | admin/group/permission parity + tests | Yes |
| E22 | RLS-scoped; billing cron out-of-request | E10, E11 | 3–6 | billing reconciliation vs legacy | Yes |
| E23 | append-only (`0002`); **no destructive purge** (`removed-approved`) | E01 | 2–4 | audit viewer parity; immutability tests | Yes |
| E24 | extension auth; no token leakage | E16, E03 | 2–5 | discovery/ingest parity | Yes (or waive) |
| E25 | migrate only built+verified; never `local_demo.sql` (RISK-015) | **all build epics** | 4–8 | doc 34 reconciliation green | Yes |
| E26 | restore-point first; staging only | E25 | 2–4 | doc 35 rehearsal green | Yes |
| E27 | no self-accept; OMC signoff | **everything** + items #1/#2 evidence | 2–4 | doc 36 outcome recorded; 17 §5 = 17/17 | Yes |

---

## 4. Connector batching — waves (Task 5; from doc 40's 52)

Final membership depends on OMC's confirmed connector list (waivers, doc 18). Build **only after E16 vault + E17
framework**.

- **Wave 1 — Identity / core admin** (highest value; feeds identity/matching/UAR): `okta · google · microsoft365 ·
  auth0 · workday · aws`.
- **Wave 2 — Collaboration / productivity:** `slack · asana · notion · figma · dropbox · egnyte · zoom · dialpad ·
  lucidchart · wrike · productboard · contentful · n8n · zapier · retool`.
- **Wave 3 — CRM / support:** `salesforce · hubspot · salesloft · apollo · marketo · gong · intercom · zendesk ·
  freshworks · greenhouse · servicenow`.
- **Wave 4 — Developer / cloud / security:** `github · githubEnterprise · circleci · datadog · pagerduty ·
  launchdarkly · cloudflare · dockerhub · databricks · datarobot · mongodb · astronomer · octopus · meraki ·
  alicloud`.
- **Wave 5 — Finance / procurement / import-style:** `genericApi` + the `IDCIngestor` inbound API (1password,
  databricks-prism, intercom, atlassian) + CSV/invoice ingestion (overlaps E13).
- **Wave 6 — Long-tail / analytics:** `sigma · domo · tableau · mixpanel` + any remaining/low-usage → strongest
  candidates for OMC **waiver**.

---

## 5. Critical path (Task 6)

`E16 vault → E17 framework → E18 Wave 1` is the **chokepoint for the entire connector sub-program** (and for
identity data that E05/E06/E12/E11/E14 depend on). In parallel-ish but each gated: `Storage boundary (done) →
E09 files-upload → E15 AI`. The **cutover tail is strictly serial:** all build epics → **E25 migration → E26
rollback → E27 acceptance + doc 17 closure**. You cannot migrate into surfaces that don't exist (doc 34
blocked-until-built), cannot rehearse rollback before migration, and cannot accept before everything is built +
hosted-verified.

## 6. Parallelizable workstreams (Task 7)

Once **E01 shell + the RLS role model + E16 vault** exist, these run in parallel **without breaking security**
(each is independently RLS-scoped): E09 files-upload, E07/E08 contracts, E02 dashboards, E14 reports (read-only),
E05/E06 people/matching, E21 admin/groups, E23 audit viewer, E10 invoices. **Connector providers (E18) parallelize
across the team once E16+E17 exist.** E15 AI parallels once E09 upload lands. **Guardrail:** anything touching
secrets waits for E16; anything writing waits for its RLS authority + audit.

## 7. Do NOT build first (Task 8)

- **No connector (E18) before E16 vault** — collecting a real connector token without the vault is the exact
  RISK-007 hazard. Hard stop.
- **No reports/exports (E14) before the underlying data surfaces** (E03/E05/E11) — nothing to report on.
- **No SCIM (E20) before the identity/people model (E05)**; **no SSO auto-provision before audit (E23)**.
- **No migration (E25) before target surfaces are built + verified** (doc 34); **no rollback rehearsal before
  migration**; **no OMC acceptance before everything is built + hosted-verified**.
- **No billing (E22) before invoices/spend (E10/E11).**
- **No AI auto-apply** — AI (E15) ships **suggestions-only** behind a review UI; never silent overwrite.
- **No service-role on any request path, ever** — not as a shortcut for any epic.

---

## 8. Realistic PR-count ranges (Task 9)

Indicative, not a commitment — exact count needs the live walkthrough + OMC waivers:
- **Minimum (aggressive batching + OMC waives the long-tail connectors + some reports/dashboards):** **~35–55 PRs.**
- **Realistic (full parity; connectors batched by family; all 7 reports; AI; SSO+SCIM; admin/groups; migration +
  rehearsals + acceptance):** **~80–140 PRs.**
- **Worst case (every one of the 52 connectors its own PR; every report + UI edge case separate; per-provider
  SSO/SCIM):** **~180–260+ PRs.**

Consistent with [38 §8](./38_OMC_FULL_PARITY_SCOPE_DECISION.md): **full parity likely means dozens-to-hundreds of
PRs; the 52-connector sub-program dominates.** Do not treat the minimum as the plan-of-record.

---

## 9. Next 10 PRs — recommended sequence (Task 10)

Dependency-sound, building on the verified Storage boundary + Auth. (1 and 9 are human-run **evidence** PRs; the
rest are build PRs that each cite doc 27 rows + carry RLS tests + hosted validation + evidence.)

1. **Execute the hosted-staging RLS suite** (disposable-isolated, doc 30 §6) → evidence PR → closes the hosted
   half of doc 17 §5 boxes 5/8.
2. **E09a — contract-file upload action + signed-URL read** (sits on the done Storage boundary; no service-role). **→ SHIPPED (PR #76): contract attachment UI on `/contracts/[id]` — list/upload/open, files-row-first, server-derived path, 60 s signed URL, no service-role; `partial` (files page/preview/inbound/links remain). Manually verified on staging for the Tenant A happy path (§11). Upload finalization hardened in PR #78 (§12): migration `0016` uploader-finalize policy → success='uploaded', failure='failed', Open only for finalized rows.**
3. **E09b — files list / detail / preview surface** (private bucket + signed URLs + file audit).
4. **E16 — connector credential vault foundation** (RISK-007) — unblocks the whole connector program; build early.
5. **E05/E06 — people/identity directory read + match-status surface** (org-scoped, default-deny).
6. **E07/E08 — contract field-parity + app↔contract link/unlink write + soft delete/archive.**
7. **E03 — apps inventory/detail parity** (cost/util/user metrics views).
8. **E02 — dashboard/home metrics surface.**
9. **Execute OMC-shaped dataset + critical-flow validation** (doc 32) → evidence PR → validates what's built (box 7
   + partial 9).
10. **E17 — connector framework** on the vault → then **E18 Wave 1** (okta/google/microsoft365).

---

## 10. Cross-references + risk posture

Builds on [37](./37_EXISTING_PARITY_DOCS_AUDIT.md) (docs audit), [38](./38_OMC_FULL_PARITY_SCOPE_DECISION.md)
(scope decision), [39](./39_OLD_APP_DIRECT_INSPECTION_INVENTORY.md) (live-inspection packet),
[40](./40_CODE_DERIVED_OLD_APP_INVENTORY.md) (code-derived inventory); each build PR also advances
[33](./33_REQUIRED_WORKFLOW_PARITY_BUILD_PLAN.md) and folds into [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md). The
cutover tail uses docs [34](./34_OMC_LEGACY_DATA_MIGRATION_PLAN.md)/[35](./35_CUTOVER_ROLLBACK_REHEARSAL_PLAN.md)/[36](./36_OMC_ACCEPTANCE_SIGNOFF_PLAN.md).

**This PR creates a full-parity implementation roadmap; it does not implement parity.** No feature built, no
hosted command, no secrets. **OMC requires full old-app parity before cutover unless OMC explicitly waives a
specific capability. The MVP subset framing is not sufficient for OMC cutover. Old-app parity is not complete.
UI/UX parity is not complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not
automatically production-ready. Storage completion is necessary but not sufficient for cutover.** OMC/Flywheel is
a paying production **replacement, not a pilot**.

---

## 11. E09a — contract-file attachment UI: staging verification evidence (2026-06-19)

**Contract-file attachment UI was manually verified on staging for the tested Tenant A happy path.** A human ran
it; the agent ran nothing. **No secrets, passwords, anon keys, cookies, JWTs, or tokens are recorded. No
production project was touched.** All identifiers below are **synthetic** staging test fixtures, not real
customer data.

| Field | Value |
|---|---|
| Date | 2026-06-19 |
| Staging project ref | `ycdpzduxugdsffjqyoai` |
| Production project ref (untouched) | `dzbfxulvxchdemcettrx` — **NOT touched** |
| Deployed app URL tested | `https://idcaddie-v3.vercel.app` |
| Tested account (synthetic) | `tenant-editor-a@idcaddie-staging.local` |
| Tenant (synthetic) | Storage Verifier Tenant A |
| Contract tested (synthetic) | Storage Test Contract A1 — `cccca111-0000-0000-0000-0000000000a1` |
| Tested URL | `https://idcaddie-v3.vercel.app/contracts/cccca111-0000-0000-0000-0000000000a1` |

**Result: PASSED for the Tenant A happy path. The test showed contract detail loading, attachment section
rendering, PDF upload, file listing, and Open action availability.** Observed, as the authorized Tenant A editor:
- The contract detail page loaded; the **Files / Attachments** section rendered.
- A PDF attachment upload worked; the uploaded file appeared in the attachment list; an **Open** action was
  present for it.
- The UI did **not** expose `storage_path` as visible page text.
- The UI did **not** expose a signed URL as visible page text.
- The page clearly states **invoices are not shown yet** and **PDF/AI extraction is not built here**.

**Known state (recorded honestly): Multiple synthetic-test.pdf pending rows were visible because the upload was
repeated during testing.** Each repeat created another `files` row at `upload_status='pending'` (the request
path has **no UPDATE/DELETE policy** by design — PR #76 / `0013` — so the app cannot transition or remove them;
a future worker/admin step reconciles). **No cleanup was performed by this PR**, and this PR does not mutate
staging — the synthetic pending rows remain in staging until a human/worker cleans them up.

**Scope / does NOT overclaim.** This verifies **only** the tested contract-file attachment happy path for Tenant
A on staging. It does **not** prove full old-app parity, AI/PDF extraction, invoices, or connector parity, and it
does **not** close RISK-001 or approve cutover. **Invoices remain not built. PDF/AI extraction remains not
built. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete.
Storage authorization remains necessary but not sufficient for cutover. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. Upload is not automatically production-ready. RISK-001 remains
OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this evidence.

---

## 12. E09a — upload finalization hardening (PR #78, from the §11 staging finding)

**The §11 staging finding (recorded, NOT mutated by this PR):** for contract `cccca111-…a1` there were **3
`public.files` rows**, **2** with matching `storage.objects` and **1 orphan** metadata row with no Storage
object (`68006ec4-8292-439a-a03c-643ad86ff3cf`, `has_storage_object=false`); the 2 uploaded rows
(`1a14edc4-2187-4d5d-a24f-b93706080eae`, `aad70c32-dd19-4454-94ad-fb7a7b196361`) had objects. **All 3 stayed
`upload_status='pending'`** with `content_type`/`byte_size`/`storage_bucket` NULL. The repeated `synthetic-test.pdf`
rows came from repeated manual uploads. (Those staging rows are **not** mutated by this PR; the app cannot
delete/transition them — no DELETE policy — so a human/worker cleans them up later.)

**Root cause:** PR #76 inserted the `files` row FIRST (forced by the Storage policy), then uploaded the object —
but `0013` had **no UPDATE policy** and `0015` granted only SELECT/INSERT, so the app could never flip a row off
`pending`. **The existing schema truly could not finalize without an UPDATE capability**, so PR #78 adds the
narrow migration `0016`.

**Fix (PR #78):** **Contract-file upload finalization is hardened.** A narrow `0016` UPDATE policy lets the
**uploader** finalize ONLY their OWN row's `upload_status` (uploader-only, `can_write_contract`, no reassignment —
proven by T36; the privilege surface is corrected + proven by T37, §13). The DAL now sets `upload_status='uploaded'`
on a successful upload (**successful uploads no longer remain ambiguous pending rows**) and `upload_status='failed'`
on a failed object upload (**failed uploads are explicitly dispositioned**, or — if even that UPDATE is denied —
documented as blocked by current policy and shown distinctly); download only signs finalized rows; the UI labels
Uploaded / Pending / Failed and shows **Open only for finalized files**. **No DELETE/`FOR ALL`, no Storage-policy
change, no public bucket, no service-role.** **Storage authorization remains necessary but not sufficient for
cutover. Upload is not automatically production-ready. Invoices remain not built. PDF/AI extraction remains not
built. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete.
RISK-001 remains OPEN. Cutover remains BLOCKED.**

---

## 13. E09a — `0016` privilege-grant correction (staging caught a broad grant before merge)

**Staging verification (after applying the first cut of `0016`) caught a privilege bug before merge** — the
PR claim of a narrow grant was wrong. `has_table_privilege('authenticated','public.files', …)` returned **true
for `delete`, `truncate`, AND `update`**, and `information_schema.column_privileges` showed UPDATE on **every**
`public.files` column for `authenticated`. **Root cause:** `grant update (upload_status)` is **additive** — it
never removed the BROAD DELETE/TRUNCATE/UPDATE `authenticated` already held (no migration granted these; hosted
setup did). **TRUNCATE is especially unacceptable — it bypasses row-level logic.** The local `test-rls.sh`
harness had **masked** this: its blanket `grant … on all tables … to authenticated` re-broadened `files` *after*
the migrations, so no local test could detect it.

**Correction (this PR, before merge):** `0016` now `revoke update, delete, truncate on public.files from
authenticated` then `grant update (upload_status)` — after it `authenticated` holds EXACTLY
`SELECT, INSERT, UPDATE(upload_status)` (no DELETE, no TRUNCATE; idempotent; SELECT/INSERT and `service_role`
untouched; the UPDATE RLS policy unchanged). The harness now re-asserts the migration-intended `files` grants so
the suite reflects the real hosted surface. New **T37** proves it (`has_table_privilege` no DELETE / no TRUNCATE;
`has_column_privilege` UPDATE only on `upload_status`, denied on every immutable column) and **T34c** now asserts
DELETE is denied at the privilege layer. RLS suite **222 → 248**. **A human must re-apply the corrected `0016`
privilege SQL to staging** (the first cut was already applied there) — not done by this PR. **RISK-001 remains
OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready.**
