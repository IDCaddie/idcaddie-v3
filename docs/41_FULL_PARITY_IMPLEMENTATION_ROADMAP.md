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
| E01 | Core shell / nav / UI parity | authenticated shell, nav, breadcrumbs, loading/empty/error, table primitives | `(authenticated)/layout.tsx`, `nav.tsx`/`nav-items.ts` | **Partial — persistent shell + full-parity nav (active state, tenant/user context, unbuilt areas marked "Not built yet") shipped PR #81 (§16); breadcrumbs/loading-skeletons/table primitives remain** |
| E02 | Dashboard / home / custom dashboards | home metrics + the custom **dashboards builder** | `/dashboards`, dashboard summary DAL | **Partial — read-only `/dashboards` summary (RLS-scoped visible-to-you counts: apps/contracts/files/accounts/matched/unmatched/recent-audit, linking to implemented pages) shipped PR #96 (§30); custom dashboard builder / charts / connector-spend / AI insights / export / scheduled delivery remain not built** |
| E03 | Apps inventory / detail parity | list (cost/util/user metrics), detail (roster/invoices/compliance/linked) | `/apps`, `/apps/[id]` | **Partial — inventory now shows RLS-scoped linked-contract + app-user counts; detail has summary/ownership/linked-contracts/account-intel insight + "Not built yet" actions (PR #83, §18); cost/util metrics, invoices, compliance remain** |
| E04 | App users parity | per-app roster, status, bulk | `/apps/[id]` roster, app-users DAL | **Partial — read-only roster + match status (PR #83/§18); write/bulk/provisioning remain** |
| E05 | Identity users / employees parity | people directory (IdP + app-only), drill-down | `/people`, app-users DAL | **Partial — read-only `/people` identity-ACCOUNTS view (app_users + app + match status, no person PII) shipped PR #85 (§20); the person/employee DIRECTORY (people/identity_accounts) stays deferred (RISK-002)** |
| E06 | App-user identity matching parity | matching rules, merge, match status | `/people` match status, `0008` | **Partial — read-only matched/unmatched STATUS surfaced on `/people` + app detail (PR #85/§20); matching rules / manual match-unmatch / merge / resolution workflow remain not built** |
| E07 | Contracts list/detail/create/edit parity | full field parity + gantt/timeline | `/contracts*`, `CONTRACT_FIELD_ORDER`, doc 15 | Partial |
| E08 | Contract steward / write workflow parity | authority, audit, delete/archive, link/unlink | `updateContract`, `0004`/`0010` | Partial |
| E09 | Files / upload / download parity | upload action, signed-URL read, preview, file↔app/contract links, inbound | `/files`, `files/*`, Storage (done boundary) | **Partial — contract attachments (upload + signed-URL open) shipped PR #76 (E09a); read-only `/files` list (safe metadata + contract link, no storage path/signed URL) shipped PR #94 (§28); standalone upload/open-download/delete/export/preview/inbound remain** |
| E10 | Invoices parity | invoice inventory/detail, chargeback | `/invoices*`, `companies/billing` | Missing |
| E11 | Spend / license / account intelligence | ELU/waste, spend, account-intel | `IDCApps/insights/elu`, invoice AI | Partial/Missing |
| E12 | Shadow IT / unmanaged accounts | UAR, stale users, orphan/shadow risk | `insights/uar`,`stale`, `/people/risks` | Missing |
| E13 | Imports / exports / ingestion | non-destructive upsert + preview; CSV; inbound | `/files/inbound`, `api/v1`, `IDCIngestor`, `runMigration` | Missing |
| E14 | Reporting / scheduled reports | 7 report types + scheduler + email + export | `/reports`, summary DAL | **Partial — read-only `/reports` summary counts (apps/contracts/accounts/matched/unmatched/files, RLS-scoped "visible to you") shipped PR #90 (§24); generation / 7 report types / scheduler / email / export / CSV-PDF / AI insights / connector-driven reporting remain not built** |
| E15 | AI document processing (contracts + invoices) | extraction worker, completion handler, review UI | `storage/processFileWithAI`, `handleDocumentAICompletion`, `documentPrompts` | Missing |
| E16 | **Connector vault / token security foundation** | encrypted credential vault (prerequisite for all connectors) | `setAppPrivateData`, `PRIVATE_CREDENTIALS_SCHEMA`, doc 19 | Missing (RISK-007) |
| E17 | Connector framework | scraper-config schema, scheduler, run/test/log, sync model | `appScraping/automatedScrapingService`, `scraperConfigManager` | Missing |
| E18 | Connector provider batches (52) | per-provider scrapers in waves (§4) | `appScraping/scrapers/*` (52) | Missing |
| E19 | SSO / SAML / OIDC parity | enterprise SSO + callback | `/admin/sso`, `services/samlAuth`,`oidcAuth`, `/sso-callback` | Missing |
| E20 | SCIM parity | SCIM provisioning + token mgmt | `scim/*`, `generateScimToken` | Missing |
| E21 | Admin / company / users / groups / permissions | admin screens, groups, granular permissions, recompute | `/admin`, tenant-context resolver | **Partial — read-only `/admin` (account context: email + active tenant name/role + org memberships, NO raw ids; module status; "Not built yet" capability list) shipped PR #92 (§26); invitations / role mgmt / SSO / SCIM / vault / billing / API keys / retention / security-setting writes + tenant switching remain not built** |
| E22 | Billing / admin parity | subscription billing, monthly billing, FX | `/admin/billing`, `calculateMonthlyBilling`, currency | Missing |
| E23 | Audit / logging parity | audit viewer + before/after diff (keep append-only; **no 90-day purge**) | `/audit`, audit DAL, `0001`/`0002`/`0010` | **Partial — read-only `/audit` viewer (recent entries: action/entity/timestamp + "actor recorded" label, RLS-scoped tenant-member read; NO tenant id / actor id / ip-ua / before-after diff blobs) shipped PR #90 (§24); before/after diff, search/filter/export remain; append-only by design (no mutation/delete)** |
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

---

## 14. E09a — PR #78 staging verification evidence (2026-06-19, post-merge)

PR #78 merged at `33053dc`. A human (a) repaired the staging `public.files` privileges that the first cut of
`0016` had left over-broad, then (b) verified a new upload end-to-end. **The agent ran nothing. No secrets,
passwords, anon keys, cookies, JWTs, or tokens are recorded. No production project was touched** (`dzbfxulvxchdemcettrx`);
**no staging data was mutated by this PR.** All identifiers are **synthetic** staging test fixtures.

### 14.1 Staging privilege repair — verified

Staging privilege repair was performed **before merge** (the first applied `0016` left `authenticated` with broad
`public.files` mutation privileges — doc §13). Verified on staging (`ycdpzduxugdsffjqyoai`):
- **Authenticated no longer has DELETE or TRUNCATE on public.files in staging** — `DELETE`=false, `TRUNCATE`=false.
- `SELECT`=true, `INSERT`=true. **Authenticated has UPDATE only on public.files.upload_status in staging** (column
  privilege exists for `upload_status` only).
- `public.files` policies are: **members read tenant files** (SELECT), **writers insert contract files** (INSERT),
  **uploader finalizes own file** (UPDATE).
- The linked ref remained `ycdpzduxugdsffjqyoai`; **production was not touched.**

### 14.2 New-upload finalization — verified

**Contract-file upload finalization was verified on staging for a new upload after PR #78.** A human uploaded a
PDF on the deployed staging app as the Tenant A editor:

| Field | Value |
|---|---|
| Tested URL | `https://idcaddie-v3.vercel.app/contracts/cccca1cc-0000-0000-0000-0000000000cc` |
| Tenant (synthetic) | Storage Verifier Tenant A |
| Contract (synthetic) | Storage Test Contract A Central |
| Uploaded file (synthetic) | `Invoices from Insight Canada Inc (3).PDF` |

Observed DB result: `upload_status='uploaded'`, `scan_status='pending'`, `extraction_status='not_started'`,
`storage_bucket='contract-files'`, `content_type='application/pdf'`, `byte_size=53826`, `has_storage_object=true`.

**The new upload finalized as uploaded, stored storage_bucket, content_type, byte_size, and had a matching private
Storage object.** New uploads now finalize successfully — **new uploads no longer remain ambiguous pending rows** —
and the **Open** action is available for the uploaded file. `scan_status`/`extraction_status` correctly stay
`pending`/`not_started` (scanning + AI extraction are not built).

### 14.3 Historical rows + scope

**Existing pre-fix synthetic-test.pdf pending/orphan rows remain as historical staging evidence** (the §11/§12
pending rows + the one orphan metadata row from before PR #78 — the request path has no DELETE policy by design,
so the app cannot remove them). **No cleanup was performed in this PR**; this PR does not mutate staging.

**Scope — no overclaim.** This verifies PR #78's new upload finalization path on staging. It does **not** prove
invoices, PDF/AI extraction, or old-app parity, and it does **not** close RISK-001 or approve cutover.
**Invoices remain not built. PDF/AI extraction remains not built. Old-app parity is not complete. UI/UX parity is
not complete. AI/API connector parity is not complete. Storage authorization remains necessary but not sufficient
for cutover. Upload is not automatically production-ready. RISK-001 remains OPEN. Cutover remains BLOCKED.** No
doc 17 §5 box is ticked by this evidence.

---

## 15. E09a — pre-fix staging row cleanup attempt: safely BLOCKED (2026-06-19)

A human attempted to clean up the §11/§12/§14 historical synthetic-test.pdf staging rows by deleting the old
Storage objects directly from `storage.objects` and then deleting the matching `public.files` rows. **The agent
ran nothing. No production project was touched** (`dzbfxulvxchdemcettrx`); **no staging data was mutated by this
PR.** All identifiers are synthetic staging test fixtures.

**Result — the attempt was rejected:** **Direct SQL cleanup of storage.objects was safely blocked by Supabase
Storage protections** — *"Direct deletion from storage tables is not allowed. Use the Storage API instead."* The
direct SQL cleanup **failed safely**, so **no cleanup was performed** and the old pre-fix rows remain. This is a
**good** signal: it confirms direct `storage.objects` DELETE is **not** an acceptable cleanup path — consistent
with v3's whole posture (no direct `storage.objects` manipulation; private bucket + signed URLs + RLS).
**Future cleanup must use an approved Storage API/admin/worker path, not direct storage.objects DELETE.**

**Current staging file state for Tenant A after the blocked cleanup:**

| Rows | State | Note |
|---|---|---|
| **1 good finalized upload** | `upload_status='uploaded'`, `storage_bucket='contract-files'`, `content_type='application/pdf'`, `byte_size=53826`, `has_storage_object=true` | `Invoices from Insight Canada Inc (3).PDF` on *Storage Test Contract A Central* (the §14 post-PR #78 upload) — **valid + openable** |
| **4 old pre-fix `synthetic-test.pdf` rows** | all `pending`; **2** have matching Storage objects, **2** are metadata-only **orphan** rows | created **before** PR #78 fixed upload finalization/disposition; historical staging evidence |

**The finalized post-PR #78 upload remains valid and openable.** **Pre-fix staging contract-file rows remain as
historical evidence.** The app **request path still does not provide DELETE cleanup** (no DELETE policy by
design — `0013`/`0016`), so removing the old rows + objects is a deliberate human/worker step via the Storage
API, not this PR.

**Scope — no overclaim.** **No cleanup was performed.** This records a blocked staging cleanup attempt only; it
does **not** prove production cleanup, does **not** close RISK-001, and does **not** approve cutover. **Storage
authorization remains necessary but not sufficient for cutover. Upload is not automatically production-ready.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this disposition.

---

## 16. E01 — authenticated shell / navigation (PR #81)

**Core shell/navigation UI parity is improved but not complete.** A persistent authenticated sidebar
(`(authenticated)/nav.tsx` + the pure, tested `nav-items.ts`, wired into `(authenticated)/layout.tsx`) now wraps
every authenticated route, with navigation groups across the full old-app parity areas (Home/Dashboards · Apps /
Connectors / AI / Analysis · Contracts / Files · People / Identity matching · Reports / Audit · Admin / Settings),
**active state** (`usePathname`), the signed-in **email + active tenant name/role** (never the tenant id), and
sign-out.

**Unbuilt old-app areas remain clearly marked as not built.** Only the **3 implemented routes** (`/`, `/apps`,
`/contracts`) are linkable; everything else is a **disabled "Not built yet"** item. **No placeholder routes were
added** (no backend, no new page routes); **no unbuilt module is implied to work** (a test fences that only real
routes are linkable). The home page copy now states what is implemented vs not.

**Scope.** UI only — no migration, no RLS/Storage policy, no data model, no DB write, no AI/connectors/imports/
exports/reports/invoices, no hosted command. The session guard is unchanged; the nav carries no authorization
itself (RLS governs all data); no secrets / signed URLs / Storage paths / tokens / connector credentials / JWTs /
service-role details are exposed. **Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Storage authorization remains necessary but not sufficient for cutover. Upload is not
automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked.

---

## 17. E01 — PR #81 shell/navigation staging verification (2026-06-19)

**Authenticated shell/navigation was manually verified on staging.** A human ran it; the agent ran nothing. **No
secrets, passwords, anon keys, cookies, JWTs, or tokens are recorded. No production project was touched**
(`dzbfxulvxchdemcettrx`); **no staging data was mutated by this PR.** All identifiers are synthetic staging test
fixtures.

| Field | Value |
|---|---|
| Date | 2026-06-19 |
| Staging project ref | `ycdpzduxugdsffjqyoai` |
| Deployed app URL tested | `https://idcaddie-v3.vercel.app` |
| Tested account (synthetic) | `tenant-editor-a@idcaddie-staging.local` |
| Tenant (synthetic) / role | Storage Verifier Tenant A / `editor` |

**Result: PASSED.** Observed after login:
- The **persistent sidebar is visible**; it shows the **signed-in email** + the **active tenant name and role**.
  **The sidebar shows signed-in email, active tenant name, and role.**
- The **Home active state** is visible; **Apps and Contracts are enabled; unbuilt old-app areas are clearly
  marked Not built yet.** Navigation groups render for **Workspace · Applications · Contracts & Files · People &
  Identity · Insights · Administration**, plus a visible **Sign out** button.
- **The sidebar does not expose signed URLs, storage paths, API tokens, connector secrets, JWTs, cookies, or
  service-role details.**
- The page clearly states the product is a skeleton and that unbuilt old-app parity areas remain.

**Follow-up (recorded honestly, not hidden):** the sidebar/nav **chrome** does not expose raw tenant IDs, **but
the Home page main content still displays a raw tenant UUID** (the active tenant slug + UUID) from the older
skeleton/debug content. **The Home page main content still displays a raw tenant UUID from the older
skeleton/debug content and should be cleaned up in a future UI polish PR.** (PR #81 deliberately kept the tenant
id out of the new chrome but left the pre-existing debug display on the Home page body.)

**Scope — no overclaim.** This verifies PR #81's shell/navigation staging behavior only. It does **not** prove
full UI/UX parity, old-app parity, or that AI/connectors/reports/admin are built; and it does **not** close
RISK-001 or approve cutover. **Core shell/navigation UI parity is improved but not complete. Old-app parity is
not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted Auth/tenant-context
is verified, but old-app replacement is not yet verified. Upload is not automatically production-ready. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this evidence.

---

## 18. E03 / E04 — apps inventory & detail parity (PR #83)

**Apps inventory/detail parity is improved but not complete**, using only the existing RLS-backed read surfaces
(no migration, no policy change, no writes).

- **Inventory (`/apps`):** each app now shows its **RLS-scoped linked-contract count + app-user count** — honest
  "visible to you" tallies (only rows the user may read under `app_contracts` `0006` / `app_users` `0007`, never
  an absolute total), via a new server DAL `listAppsWithCountsForCurrentUser()` (reads `apps` + the visible
  `app_contracts`/`app_users` `app_id`s, tallied in app code) + clearer empty-state copy. No caller tenant_id, no
  service-role, no embedded joins.
- **Detail (`/apps/[id]`):** keeps the app summary, ownership org IDs (pre-existing display, unchanged), linked
  contracts, the account-intelligence insight (matched/unmatched/stale — roster + match status only, no PII), and
  the app-users roster with match status; **adds a clear "Not built yet" Actions section** (link/unlink, edit/
  archive, connector sync, AI app/license analysis, export) so the gaps are explicit.

**Scope.** Read-only — RLS is the authorization boundary (cross-tenant denial proven by `org_rls_test.sql` T25/
T28/T29); no app write/edit/delete, no connector sync, no AI, no imports/exports/reports/invoices, no fake data,
no raw tenant IDs added, no signed URLs / Storage paths / tokens / secrets exposed. **App write/edit/delete
workflows remain not built. Connector sync remains not built. AI app/license intelligence remains not built.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. Upload is not automatically
production-ready. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked.

---

## 19. E03 / E04 — apps populated-path staging verification (PR #84, synthetic Tenant A fixture)

> **⚠️ SUPERSEDED / CORRECTED by PR #86 (2026-06-19) — DO NOT read this section as live fact.** New live
> staging evidence contradicts the populated-path claims below: logged in as
> `tenant-editor-a@idcaddie-staging.local` (tenant **Storage Verifier Tenant A · editor**) at
> `https://idcaddie-v3.vercel.app/apps`, the page still shows **“No apps to show.”** **Therefore the populated
> `/apps` and `/apps/[id]` path is NOT currently verified for this account; only the empty-state path is
> verified.** The PR #83 code merged and local validation passed; the `/apps` empty-state staging verification
> passed; **Apps inventory/detail parity is improved in code, but populated hosted verification remains
> incomplete.** **The `/apps/[id]` populated detail path is not currently verified; the `/people` populated path
> is not currently verified.** **The synthetic fixture below is either not present, not visible through RLS, or
> not associated with this account/tenant in hosted staging — the exact root cause remains unverified** (no
> hosted query was run to determine it). This original record is **retained, not deleted**, for the audit trail.
> **No production data was touched. No hosted commands were run. No RLS policies were changed. No migrations were
> added. Old-app parity is not complete. RISK-001 remains OPEN. Cutover remains BLOCKED.** See [05 PR #86] +
> §19.5 below.

PR #83's manual staging check (doc 41 §16/§17 chain) only covered the **empty** `/apps` path because Tenant A had
no visible apps. A human applied a **tiny, clearly-synthetic, staging-only** fixture to Tenant A
(`ycdpzduxugdsffjqyoai` — linked-ref confirmed; production `dzbfxulvxchdemcettrx` NOT touched) and verified the
populated paths. **The agent ran nothing: no hosted command, no staging mutation, no secrets.** All IDs/names are
synthetic. *(Superseded — see the banner above: this populated-path result is NOT currently reproducible.)*

### 19.1 The synthetic fixture (reviewed; applied to staging by a human, NOT by the agent)

Minimal, idempotent (`on conflict do nothing`), all in Tenant A `aaaa1111-1111-1111-1111-111111111111`, all in an
obvious synthetic `5a9a0000-…` id namespace + "Staging Apps Verification" names. Applied as the privileged role
in the staging SQL editor (RLS bypassed for seed only; the app's RLS still governs every read). **No migration,
no RLS-policy change, no Storage, no `storage.objects`.** The match needs a `people` row (`person_id` NOT NULL);
the match read helper surfaces **status only — no person PII**.

```sql
-- STAGING-ONLY synthetic fixture for apps inventory/detail verification. NEVER apply to production
-- (dzbfxulvxchdemcettrx). Idempotent. Tenant A = aaaa1111-1111-1111-1111-111111111111.
insert into public.apps (id, tenant_id, name, vendor_name, category, status) values
  ('5a9a0000-0000-0000-0000-000000000a01','aaaa1111-1111-1111-1111-111111111111',
   'Staging Apps Verification — App','Synthetic Vendor','Verification','active')
on conflict (id) do nothing;

-- Link the synthetic app to an EXISTING Tenant A contract (same-tenant composite FK, 0005).
insert into public.app_contracts (app_id, contract_id, tenant_id) values
  ('5a9a0000-0000-0000-0000-000000000a01','cccca111-0000-0000-0000-0000000000a1',
   'aaaa1111-1111-1111-1111-111111111111')
on conflict (app_id, contract_id) do nothing;

-- 2 synthetic app users on the app.
insert into public.app_users (id, tenant_id, app_id, email, display_name, status, license_type, last_active_at) values
  ('5a9a0000-0000-0000-0000-000000000e01','aaaa1111-1111-1111-1111-111111111111','5a9a0000-0000-0000-0000-000000000a01',
   'verify-user-1@staging-apps-verification.local','Staging Apps Verification User 1','active','Pro', now() - interval '5 days'),
  ('5a9a0000-0000-0000-0000-000000000e02','aaaa1111-1111-1111-1111-111111111111','5a9a0000-0000-0000-0000-000000000a01',
   'verify-user-2@staging-apps-verification.local','Staging Apps Verification User 2','inactive','Free', now() - interval '200 days')
on conflict (id) do nothing;

-- 1 synthetic person + 1 match (user 1 ↔ person) so the roster shows one matched + one unmatched.
insert into public.people (id, tenant_id, primary_email, full_name) values
  ('5a9a0000-0000-0000-0000-000000000f01','aaaa1111-1111-1111-1111-111111111111',
   'verify-person-1@staging-apps-verification.local','Staging Apps Verification Person 1')
on conflict (id) do nothing;

insert into public.app_user_identity_matches (id, tenant_id, app_user_id, person_id, match_method, confidence) values
  ('5a9a0000-0000-0000-0000-000000000d01','aaaa1111-1111-1111-1111-111111111111',
   '5a9a0000-0000-0000-0000-000000000e01','5a9a0000-0000-0000-0000-000000000f01','email', 95.00)
on conflict (app_user_id, person_id) do nothing;
```

### 19.2 Verification — PASSED *(⚠️ SUPERSEDED by §19.5 — this populated-path result is NOT currently reproducible; see the §19 banner)*

**Apps inventory/detail populated-path staging verification passed for a synthetic Tenant A fixture.** A human
logged in to `https://idcaddie-v3.vercel.app` as `tenant-editor-a@idcaddie-staging.local` and verified:
- **`/apps`:** the list loads; the synthetic app row appears with its **linked-contract count (1)** and
  **app-user count (2)**; the row is clickable. **Counts are RLS-scoped/visible-to-user counts, not absolute
  tenant-wide totals.**
- **`/apps/[id]`:** the app summary loads; the **Linked contracts** section shows the linked Tenant A contract;
  the **App users / roster** section shows both synthetic users; the **identity match** column shows User 1
  *matched* (method `email`, confidence 95) and User 2 *unmatched*; the **Actions** section clearly says
  **Not built yet** for link/unlink, edit/archive, connector sync, AI analysis, and export.
- **No tenant IDs, tokens, signed URLs, storage paths, service-role details, connector secrets, JWTs, or cookies
  were visible** on either page.

**The empty /apps path was already verified separately** (doc 41 §17). **The synthetic fixture exercised
visible app rows, linked-contract counts, app-user counts, app detail, linked contracts, app users/roster, and
Not built yet actions.** **Cross-tenant isolation** (Tenant B cannot see Tenant A's synthetic app/app_users/links)
is already proven by `org_rls_test.sql` **T25/T28/T29** + the hosted Auth verifier **R4** (cross-tenant denial),
so no separate manual Tenant B check was run.

### 19.3 Disposition

**Preferred + chosen: leave the synthetic rows in staging as verification fixtures.** They are harmless, clearly
synthetic (the `5a9a0000-…` namespace + "Staging Apps Verification" names + `…staging-apps-verification.local`
emails), and a populated Tenant A app benefits future UI verification. **The synthetic fixture is staging-only and
must not be treated as customer data.** No cleanup is required; **no direct `storage.objects` / storage-table
manipulation was used or needed** (apps fixtures involve no Storage).

### 19.4 Scope / guardrails

**No production data was touched. No production commands were run. No RLS policies were changed. No migrations
were added** (the existing schema + the `0006`/`0007`/`0008` read policies already support this; none unavoidable).
This verifies only the apps populated-path staging behavior. **App write/edit/delete workflows remain not built.
Connector sync remains not built. AI app/license intelligence remains not built. Old-app parity is not complete.
UI/UX parity is not complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is verified, but
old-app replacement is not yet verified. Upload is not automatically production-ready. RISK-001 remains OPEN.
Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this evidence.

### 19.5 Correction (PR #86, 2026-06-19) — populated path NOT currently verified

**The §19 populated-path result above is superseded / corrected, not deleted.** New live staging evidence: logged
in as `tenant-editor-a@idcaddie-staging.local` (tenant **Storage Verifier Tenant A · editor**) at
`https://idcaddie-v3.vercel.app/apps`, the page still shows **“No apps to show”**; the page itself states app
visibility and counts are RLS-scoped. **What is true:** PR #83 code merged successfully and local validation
passed; **the `/apps` empty-state staging verification passed**; **Apps inventory/detail parity is improved in
code, but populated hosted verification remains incomplete.** **What is NOT currently verified:** **populated-path
staging verification is currently NOT reproducible for `tenant-editor-a@idcaddie-staging.local` because `/apps`
still shows “No apps to show”**; **the `/apps/[id]` populated detail path is not currently verified**; **the
`/people` populated path is not currently verified.** **Root cause:** the synthetic fixture (§19.1) is **either not
present, not visible through RLS, or not associated with this account/tenant in hosted staging — the exact root
cause remains unverified** (this corrective PR ran no hosted query). **No production data was touched. No hosted
commands were run in this corrective PR. No RLS policies were changed. No migrations were added. Old-app parity is
not complete. RISK-001 remains OPEN. Cutover remains BLOCKED.** Re-verifying the populated path requires a human to
confirm (via the hosted app or a hosted query) that the fixture exists and is visible to this account, then re-run
the manual `/apps` + `/apps/[id]` check — not done here.

> **UPDATE (PR #89, 2026-06-20) — RESOLVED, now PASSES.** After a human applied the §21 fixture to staging
> `ycdpzduxugdsffjqyoai`, all three populated paths were re-verified on live staging and **PASS** — recorded in
> **§23**. `/apps` now lists the synthetic app with RLS-scoped counts (Contracts 1, Users 2). **The §86 correction
> above was accurate when written** (the fixture had not yet been applied/visible to this account at that time);
> this UPDATE does not erase it — it records the resolution. The fixture remains synthetic; this does not close
> RISK-001 or approve cutover.

---

## 20. E05 / E06 — People / Users + identity-matching read parity (PR #85)

**People / Users read-only parity is improved but not complete.** A read-only **`/people`** route + server DAL
`listIdentityAccountsForCurrentUser()` shows the **identity ACCOUNTS** the user may read across visible apps —
each with its app (linked), the account's own fields (display name / email / status / license / last-active), and
a matched/unmatched STATUS — plus a summary (accounts, distinct apps, matched, unmatched). The **People / Users**
sidebar item is now enabled → `/people`.

**It reuses only surfaces already proven safe + surfaced on app detail** — `app_users` (`0007`), `apps` (name),
match status from `app_user_identity_matches` (`0008`). It reads **`app_users`/`apps`/`matches` only — never
`people`/`identity_accounts`** — so it exposes **no person PII** (no `people` row, no `person_id`, no IdP
provider/email/status); the org-scoped people/identity directory read stays **deferred (RISK-002)**. Accounts are
a **flat list, not grouped/merged** — it never implies a resolution the system hasn't made.

**Identity Matching read-only parity is improved but not complete** — read-only match STATUS is surfaced on
`/people` (and app detail), but a dedicated matching/resolution surface + the workflow remain not built, so the
**Identity matching** nav item stays "Not built yet". **Manual match/unmatch workflows remain not built. Bulk
identity resolution remains not built. SCIM/IdP import remains not built. Connector sync remains not built.
AI-assisted identity matching remains not built. Exports remain not built.**

**Scope.** Read-only — RLS is the authorization boundary (no cross-tenant — `org_rls_test.sql` T29/T30); no
write/edit/delete, no migration, no RLS-policy change, no fake data, no raw tenant IDs, no signed URLs / Storage
paths / tokens / secrets; auth guard preserved. The DTO carries no tenant id / person id (tested). **Old-app
parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. Upload is not automatically
production-ready. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked.

---

## 21. E03–E06 — staging Apps/People populated-path FIXTURE PROCESS (PR #87, human-run)

**A repeatable staging-only Apps / People populated-path fixture process now exists.** After #84/#86 (the populated
path was recorded then corrected because `/apps` showed “No apps to show”), this PR adds a **reviewed, guarded,
human-run** way to seed a tiny synthetic Tenant A fixture in staging and verify the populated paths. **The process
is human-run and was not executed by the agent.** **The current live populated-path verification remains incomplete
until a human applies the fixture and verifies `/apps`, `/apps/[id]`, and `/people`.**

### 21.1 Purpose
Make `/apps`, `/apps/[id]`, and `/people` have visible Tenant A data on staging so a human can verify the populated
paths repeatably. **The fixture is synthetic and must not be treated as customer data.**

### 21.2 Exact tables touched (INSERT only)
`public.apps`, `public.app_contracts`, `public.app_users`, `public.people`, `public.app_user_identity_matches`.
**No Storage / `storage.objects`, no RLS-policy change, no migration.** Reviewed file:
`supabase/fixtures/staging_apps_people_verification.sql` (idempotent `on conflict do nothing`).

### 21.3 Exact synthetic IDs / names (Tenant A `aaaa1111-1111-1111-1111-111111111111`)
| Row | ID (`5a9a0000-…` namespace) | Name / value |
|---|---|---|
| app | `5a9a0000-0000-0000-0000-000000000a01` | Staging Apps Verification — App |
| app_contract | → existing contract `cccca111-0000-0000-0000-0000000000a1` | Storage Test Contract A1 |
| app_user 1 (matched) | `5a9a0000-0000-0000-0000-000000000e01` | Staging Apps Verification User 1 |
| app_user 2 (unmatched) | `5a9a0000-0000-0000-0000-000000000e02` | Staging Apps Verification User 2 |
| person | `5a9a0000-0000-0000-0000-000000000f01` | Staging Apps Verification Person 1 |
| match (user 1 ↔ person) | `5a9a0000-0000-0000-0000-000000000d01` | method `email`, confidence 95 |

### 21.4 Exact human command to run it
A human (never the agent) runs the guarded launcher — it **fails closed unless the linked ref is exactly staging
`ycdpzduxugdsffjqyoai`, prints the linked ref, refuses production `dzbfxulvxchdemcettrx` explicitly, and requires
the confirmation phrase `SEED STAGING APPS FIXTURE`**. It uses **no service-role key**; by default it only prints
the fixture + SQL-editor instructions (connects to nothing):
```
cat supabase/.temp/project-ref     # must print ycdpzduxugdsffjqyoai
bash scripts/seed-staging-apps-fixture.sh "SEED STAGING APPS FIXTURE"
```
Then paste `supabase/fixtures/staging_apps_people_verification.sql` into the **staging** Supabase SQL editor and run
it (or, only if the human exports a `STAGING_DB_URL` that itself references the staging ref, the script applies it
via `psql`). **The agent does none of this.**

### 21.5 Verification checklist (after a human applies the fixture), signed in as `tenant-editor-a@idcaddie-staging.local`
**Expected `/apps`:** the **synthetic app row is visible** (“Staging Apps Verification — App”); the **linked
contract count is visible as RLS-scoped / visible-to-you** (1); the **app-user count is visible as RLS-scoped /
visible-to-you** (2); the row is clickable.
**Expected `/apps/[id]`:** the **summary is visible**; the **linked contract is visible** (Storage Test Contract
A1); the **app users / roster is visible** (User 1, User 2); the **“Not built yet” actions are visible**
(link/unlink, edit/archive, connector sync, AI analysis, export).
**Expected `/people`:** the **app-user accounts are visible** (2 across 1 app); the **matched/unmatched status is
visible** (User 1 matched, User 2 unmatched); **no `tenant_id` / `person_id` is exposed**; **manual / bulk matching
are still not built**.

### 21.6 Cleanup / disposition
**Preferred: leave the clearly-synthetic rows in staging for repeatable verification** (they are harmless and
obviously synthetic). A human may intentionally remove them using the documented **OPTIONAL CLEANUP** block at the
bottom of the fixture file (commented-out `delete` statements that target EXACTLY the `5a9a0000-…` rows — **no
unrelated rows**).

### 21.7 Warnings
**Never apply to production** (`dzbfxulvxchdemcettrx`) — the script refuses it and the fixture header says so.
**Fixture data is not customer data.** **Fixture verification does not close RISK-001.** **Fixture verification
does not approve cutover.**

### 21.8 Scope / status
**No production data was touched. No hosted commands were run by the agent. No RLS policies were changed. No
migrations were added** (the fixture uses the existing schema + the `0006`/`0007`/`0008` read policies; none
unavoidable). **Apps inventory/detail code parity is improved, but populated hosted verification remains
incomplete. People / Users read-only code parity is improved, but populated hosted verification remains incomplete.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. Upload is not automatically
production-ready. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this process.

---

<!-- §22 is reserved for the separate PR #88 "/apps inventory readable-app listing" fix. -->

## 23. E03–E06 — Apps/People populated-path staging verification PASSED (PR #89, synthetic Tenant A fixture)

This resolves the §19/§19.5 chain (recorded → corrected → fixture process → now verified). **Apps populated-path
staging verification passed for the synthetic Tenant A fixture. People populated-path staging verification passed
for the synthetic Tenant A fixture.** **The fixture was applied manually by a human to staging project
ycdpzduxugdsffjqyoai.** Via the §21 process, a human then verified the three live routes signed in as
`tenant-editor-a@idcaddie-staging.local`. **The agent ran nothing — no hosted command, no staging mutation, no
secrets.** **No production data was touched. No production commands were run.**

### 23.1 `/apps` — `https://idcaddie-v3.vercel.app/apps` — PASS
1 app visible to `tenant-editor-a@idcaddie-staging.local`: **Staging Apps Verification — App** · vendor **Synthetic
Vendor** · category **Verification** · status **active** · **Contracts count 1** · **Users count 2**. The page
states the counts are “visible to you” / RLS-scoped. **Counts are RLS-scoped / visible-to-you, not absolute
tenant-wide totals.**

### 23.2 `/apps/[id]` — `…/apps/5a9a0000-0000-0000-0000-000000000a01` — PASS
**The app detail page shows linked contract, two app users, one matched account, one unmatched account, and Not
built yet actions.** Specifically: the app loads; **linked contract** = Storage Test Contract A1 — Storage Test
Vendor A1; **visible accounts 2 · matched 1 · unmatched 1 · match rate 50% · stale candidates 1**; User 1 = matched
· email (95); User 2 = unmatched; the **Not built yet** Actions are Link/unlink contracts, Edit/archive app,
Connector sync, AI app/license analysis, Export. The page states it does not expose person names, identity-account
details, license rules/utilization, invoices, files, the identity-matching algorithm, merge, provisioning,
deprovisioning, or an unmanaged-account report.

### 23.3 `/people` — `https://idcaddie-v3.vercel.app/people` — PASS
**The People page shows two app-user accounts, one matched and one unmatched, without exposing person/IdP directory
details.** Accounts visible to you **2** · across apps **1** · matched **1** · unmatched **1**; identity shows
matched for User 1 and unmatched for User 2. The page states the account fields are app-account values (not
person/IdP directory data) and that identity shows only whether a match exists, not who it matched. The old-app
capabilities are all marked Not built yet.

### 23.4 Scope / guardrails
**The fixture remains synthetic and must not be treated as customer data. The fixture verification does not close
RISK-001. The fixture verification does not approve cutover.** Read-only — no write workflow was exercised.
**Manual matching remains not built. Bulk identity resolution remains not built. Connector sync remains not built.
SCIM / IdP import remains not built. AI-assisted matching remains not built. Exports remain not built. People
directory / employee records remain not built. UAR remains not built.** **Old-app parity is not complete. UI/UX
parity is not complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is verified, but
old-app replacement is not yet verified. Upload is not automatically production-ready. RISK-001 remains OPEN.
Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification. (This confirms the §86-recorded
mismatch is resolved: with the §21 fixture applied + visible, `/apps` lists the app under the current code with
working RLS-scoped counts — consistent with the earlier empty state being the fixture not yet applied/visible to
this account.)

---

## 24. E14 / E23 — Reports + Audit/Logs read-only parity (PR #90)

Two read-only surfaces built on existing RLS-backed reads — no new query power, no write workflow, no generation.

### 24.1 Audit / Logs (`/audit`, E23)
**Audit / Logs read-only parity is improved but not complete.** `audit_logs` already has a safe **tenant-member
SELECT** policy (`is_tenant_member(tenant_id)`, `0001`) and is **append-only** (`reject_audit_mutation`, `0002` —
no UPDATE/DELETE), so a read-only viewer is safe without any policy change. DAL `listRecentAuditEntriesForCurrentUser()`
returns the most recent ≤50 entries the user may read, projected to a **deliberately minimal DTO**: `action`,
`resourceType` (entity/table), `createdAt`, and a boolean **"actor recorded"** label. It **never** selects or
exposes `tenant_id`, the raw `actor_user_id`, `resource_id`, `ip_address`, `user_agent`, or the
`before_json`/`after_json` diff blobs (a test asserts the exact key set + that those columns are absent). The
sidebar **Audit / Logs** item is now enabled → `/audit`. **Audit mutation/delete remains not built.** (Append-only
by design.) Before/after diff, search/filter, and the legacy retention/purge controls remain not built.

### 24.2 Reports (`/reports`, E14)
**Reports read-only parity is improved but not complete.** `/reports` shows simple **"visible to you"** summary
counts from existing RLS-backed reads — apps / contracts / files via RLS-scoped `head:true` exact counts (no row
data fetched), and app-user accounts + matched/unmatched via the existing tested people helper (which dedups
matched accounts; no person/IdP PII). Each count is `number | null` ("—" when its read fails — best-effort, never
fatal); the DTO is integers/nulls only (no ids, no row contents). It **invents no report capability**:
**Exports remain not built. Scheduled reports remain not built. CSV/PDF report generation remains not built. AI
report insights remain not built. Connector-driven spend/license reporting remains not built.** (The page lists
these explicitly as "Not built yet".) The sidebar **Reports** item is now enabled → `/reports`.

### 24.3 Scope / guardrails
Read-only — RLS is the authorization boundary; no service-role, no writes, no migration, no RLS-policy change, no
exports/downloads, no fake data, no raw tenant IDs / secrets / tokens / signed URLs / storage paths. DTOs carry no
tenant id or sensitive internals (tested); both routes inherit the `(authenticated)` auth guard; +6 tests (104
total) + the nav test now asserts the two new enabled items map to implemented routes. **Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is
verified, but old-app replacement is not yet verified. Upload is not automatically production-ready. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 25. E14 / E23 — Reports + Audit/Logs read-only staging verification (PR #91)

**Reports read-only staging verification passed. Audit / Logs read-only staging verification passed.** A human
verified the §24 (PR #90) surfaces on the deployed staging app `https://idcaddie-v3.vercel.app` signed in as
`tenant-editor-a@idcaddie-staging.local` (tenant **Storage Verifier Tenant A**). **The agent ran nothing — no
hosted command, no staging mutation, no secrets. No production data was touched.**

### 25.1 `/reports` — `https://idcaddie-v3.vercel.app/reports` — PASS
Reports nav item enabled; the route is deployed and loads. Observed "visible to you" counts: **Apps visible 1 ·
Contracts visible 2 · App-user accounts visible 2 · Accounts matched 1 · Accounts unmatched 1 · Files visible 5**.
**Reports counts are RLS-scoped / visible-to-you, not absolute tenant-wide totals** (the page states this).
Marked **Not built yet**: Export / download (CSV, PDF), Scheduled reports, Emailed reports, AI report insights,
Connector-driven spend / license reporting, the legacy report types. **Exports remain not built. Scheduled reports
remain not built. CSV/PDF report generation remains not built. AI report insights remain not built. Connector-driven
spend/license reporting remains not built. Legacy report types remain not built.**

### 25.2 `/audit` — `https://idcaddie-v3.vercel.app/audit` — PASS
Audit / Logs nav item enabled; the route is deployed and loads. **2 recent audit entries visible.** **Audit / Logs
shows only action, entity, timestamp, and a safe actor indicator.** Observed e.g. `contract.created / contract /
2026-06-18 12:10`. **Audit / Logs does not expose tenant_id, actor_user_id, IP address, user_agent, before_json,
after_json, tokens, secrets, signed URLs, storage paths, connector credentials, JWTs, cookies, or service-role
details.** The page states the log is append-only. **Before/after audit diff remains not built. Full audit
search/filter/export remains not built. Legacy audit retention/purge controls remain not built. Audit
mutation/delete remains not built.**

### 25.3 Scope / guardrails
This verifies only the read-only Reports + Audit staging behavior for the synthetic Tenant A account — not full
parity. **No production data was touched. No hosted commands were run by the agent. No RLS policies were changed.
No migrations were added.** **Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity
is not complete. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. Upload is not
automatically production-ready. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this
verification.

---

## 26. E21 — Admin / Settings read-only parity (PR #92)

**Admin / Settings read-only parity is improved but not complete.** A read-only **`/admin`** route reuses the
existing RLS-scoped tenant-context resolver (`resolveTenantContext` → `deriveContext`) — **no new DAL, no
service-role, no new DB read.** A pure mapper `toAdminContextView()` projects the resolved context to a SAFE view
that exposes ONLY the **signed-in email + active tenant NAME/role + organization membership NAMES/roles**, plus a
read-only "implemented modules" overview. **No raw tenant / organization / user IDs are exposed on the page** (the
mapper drops every id; a test asserts the projected view contains none of the source ids — the home/debug page
keeps showing the tenant id, this page does not). The sidebar **Admin / Settings** item is now enabled → `/admin`.

**Explicit "Not built yet" capability list** (read-only — nothing is writable here): **Tenant switching remains
deferred / not built. User invitations remain not built. Role management remains not built. SSO/SAML/OIDC remains
not built. SCIM/IdP import remains not built. Connector credential vault remains not built. Billing remains not
built. API keys / ingestion tokens remain not built. Data retention controls remain not built. Security settings
remain not built.**

**Scope / guardrails.** Read-only — RLS is the authorization boundary (the reused resolver is user-scoped, no
service-role, no cross-tenant); no admin writes, no invitation/role/tenant-switch/billing/connector/API-key
workflow; no migration, no RLS-policy change; no raw tenant IDs / secrets / tokens / signed URLs / storage paths;
the route inherits the `(authenticated)` auth guard. +4 tests (108 total) — the safe-projection (no id leak) + the
capability list + the nav test now asserts the new enabled item maps to an implemented route. **Old-app parity is
not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is
verified, but old-app replacement is not yet verified. Upload is not automatically production-ready. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 27. E21 — Admin / Settings read-only staging verification (PR #93)

**Admin / Settings read-only staging verification passed.** A human verified the §26 (PR #92) surface on the
deployed staging app `https://idcaddie-v3.vercel.app/admin` signed in as `tenant-editor-a@idcaddie-staging.local`
(tenant **Storage Verifier Tenant A**). **The agent ran nothing — no hosted command, no staging mutation, no
secrets. No production data was touched.**

### 27.1 Observed — PASS
The Admin / Settings nav item is enabled and the `/admin` route is deployed and loads. **The Admin / Settings page
shows signed-in email, active tenant name, role, tenant membership count, organization membership summary,
implemented modules, and explicit Not built yet administration capabilities.** Organization memberships are shown
without raw organization IDs. **Raw tenant IDs and raw organization IDs are intentionally not shown on the Admin /
Settings page.** Every administration capability is marked Not built yet: **Tenant switching remains deferred /
not built. User invitations remain not built. Role management remains not built. SSO/SAML/OIDC remains not built.
SCIM/IdP import remains not built. Connector credential vault remains not built. Billing remains not built. API
keys / ingestion tokens remain not built. Data retention controls remain not built. Security settings remain not
built.** **No tokens, secrets, API keys, connector credentials, JWTs, cookies, signed URLs, storage paths, or
service-role details are visible.**

### 27.2 Scope / guardrails
This verifies only the read-only Admin / Settings staging behavior for the synthetic Tenant A account — not full
parity, and nothing here is writable. **No production data was touched. No hosted commands were run by the agent.
No RLS policies were changed. No migrations were added.** **Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is verified, but old-app replacement
is not yet verified. Upload is not automatically production-ready. RISK-001 remains OPEN. Cutover remains
BLOCKED.** No doc 17 §5 box is ticked by this verification.

---

## 28. E09 — Files / Documents read-only list (PR #94)

**Files / Documents read-only parity is improved but not complete.** A read-only **`/files`** route + DAL
`listFilesForCurrentUser()` lists the contract files the current user may read (RLS-scoped — `files` SELECT =
`is_tenant_member(tenant_id)`, `0013`), each with safe metadata: **file name, related contract (linked when
separately readable), upload status, content type, size, added date.** It reuses the same discipline as the proven
contract-files DAL: the user-scoped client (no service-role), an explicit safe column subset, and a DTO that
**deliberately never selects or exposes `storage_path`, `storage_bucket`, the raw object name, `sha256`,
`tenant_id`, `uploaded_by`, the extraction blobs, or any signed URL** (a test asserts the exact key set + the
absence of every forbidden internal). The sidebar **Files / Documents** item is now enabled → `/files`.

**Open path + not-built scope.** **Standalone open/download remains not built** (the existing safe download helper
is **not** reused standalone here — keeping the PR narrow and avoiding any signed-URL surface on `/files`); a file
links to its contract, where the existing verified open flow lives. **Contract-level file attachment remains the
implemented upload path.** **Standalone file upload remains not built. Standalone file delete remains not built.
Standalone file export remains not built.** No connector ingestion, no AI document analysis, no new Storage
authorization. **No raw storage paths, signed URLs, bucket internals, tenant IDs, tokens, secrets, service-role
details, JWTs, cookies, connector credentials, or API keys are exposed.**

**Scope / guardrails.** Read-only — RLS is the authorization boundary (no cross-tenant; reads only `files` +
`contracts`, both tenant-member SELECT); no writes, no migration, no RLS-policy change; existing contract-file
behavior is unchanged (contract-files.ts + the contract detail page are untouched); the route inherits the
`(authenticated)` auth guard. +6 tests (114 total): the safe-projection (no storage-path/bucket/sha256/tenant-id/
uploaded-by leak), status formatting (uploaded/failed/pending), size formatting, contract-name mapping (incl.
null), empty state, fail-closed; + the nav test asserts the new enabled item maps to an implemented route.
**Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. Upload is not automatically
production-ready. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 29. E09 — Files / Documents read-only staging verification (PR #95)

**Files / Documents read-only staging verification passed.** A human verified the §28 (PR #94) surface on the
deployed staging app `https://idcaddie-v3.vercel.app/files` signed in as `tenant-editor-a@idcaddie-staging.local`
(tenant **Storage Verifier Tenant A**). **The agent ran nothing — no hosted command, no staging mutation, no
secrets. No production data was touched.**

### 29.1 Observed — PASS
The Files / Documents nav item is enabled and the `/files` route is deployed and loads; **5 files visible** to the
user. **The Files / Documents page shows file names, related contract links, upload status, content type, size,
and added dates for files visible to the signed-in user.** **The uploaded PDF row is visible and linked to Storage
Test Contract A Central.** Observed: `Invoices from Insight Canada Inc (3).PDF` · Storage Test Contract A Central
· Uploaded · `application/pdf` · 52.6 KB · 2026-06-20. **Pending synthetic-test.pdf rows are visible and marked
Pending — not yet openable.** **The page instructs users to open files from the related contract using the
verified contract-level open path.** **No storage paths, object names, or signed URLs are shown.**

Every standalone capability is marked Not built yet: **Standalone upload remains not built. Standalone
open/download remains not built. Delete remains not built. Export remains not built. Connector ingestion remains
not built. AI document analysis remains not built.** **No raw storage paths, signed URLs, bucket internals, tenant
IDs, tokens, secrets, service-role details, JWTs, cookies, connector credentials, or API keys are visible.**
**Contract-level file attachment remains the implemented upload/open path.**

### 29.2 Scope / guardrails
This verifies only the read-only Files / Documents staging behavior for the synthetic Tenant A account — not full
parity, and nothing here is writable. **No production data was touched. No hosted commands were run by the agent.
No RLS policies were changed. No migrations were added.** **Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is verified, but old-app replacement
is not yet verified. Upload is not automatically production-ready. RISK-001 remains OPEN. Cutover remains
BLOCKED.** No doc 17 §5 box is ticked by this verification.

---

## 30. E02 — Dashboards read-only summary (PR #96)

**Dashboards read-only parity is improved but not complete.** A read-only **`/dashboards`** route + a thin DAL
`getDashboardSummaryForCurrentUser()` that **composes two already-verified, already-tested helpers** —
`getReportsSummaryForCurrentUser()` (apps/contracts/files/account counts) + `listRecentAuditEntriesForCurrentUser()`
(a recent-activity COUNT only) — into a numbers-only summary. **No new DB read, no new query power, no new RLS
policy, no service-role.** The page shows stat cards (apps, contracts, files, app-user accounts +
matched/unmatched, recent audit entries, reports) — **Dashboard counts are RLS-scoped / visible-to-you, not
absolute tenant-wide totals** (each `number | null`, "—" when its underlying read failed). **Dashboard links only
to implemented read-only pages.** Those are `/apps`, `/contracts`, `/files`, `/people`, `/audit`, `/reports`. The sidebar
**Dashboards** item is now enabled → `/dashboards`.

**Not built (read-only — no builder/charts/analytics/AI/export):** **Custom dashboard builder remains not built.
Connector-driven spend/license dashboards remain not built. AI dashboard insights remain not built. Dashboard
exports remain not built. Scheduled dashboard delivery remains not built.** (Charts/visualizations are also not
built — the dashboard adds no new data logic.)

**Scope / guardrails.** Read-only — RLS is the authorization boundary (the reused helpers are user-scoped, no
cross-tenant, no service-role); no writes, no migration, no RLS-policy change; the existing reports/audit/people/
files helpers are unchanged (pure reuse); the DTO is integers/nulls only — **no tenant IDs, organization IDs,
storage paths, signed URLs, raw audit JSON, `actor_user_id`, IP/user-agent, tokens, secrets, service-role,
connector credentials, JWTs, cookies, or API keys** (a test asserts the numbers-only key set); the route inherits
the `(authenticated)` auth guard. +3 tests (117 total): the composition + numbers-only DTO, the degraded
(null) recent-activity case, and the degraded reports pass-through; + the nav test asserts the new enabled item
maps to an implemented route. **Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified.
Upload is not automatically production-ready. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is
ticked by this PR.

---

## 31. E02 — Dashboards read-only staging verification (PR #97)

**Dashboards read-only staging verification passed.** A human verified the §30 (PR #96) surface on the deployed
staging app `https://idcaddie-v3.vercel.app/dashboards` signed in as `tenant-editor-a@idcaddie-staging.local`
(tenant **Storage Verifier Tenant A**). **The agent ran nothing — no hosted command, no staging mutation, no
secrets. No production data was touched.**

### 31.1 Observed — PASS
The Dashboards nav item is enabled and the `/dashboards` route is deployed and loads. **Dashboard counts are
RLS-scoped / visible-to-you, not absolute tenant-wide totals** (the page states this). Observed counts: **Apps
visible 1 · Contracts visible 2 · Files visible 5 · App-user accounts visible 2 · 1 matched / 1 unmatched · Recent
audit entries 2**; the Reports card is visible. **Dashboard links only to implemented pages.** **Recent audit
entries are count-only and do not expose audit detail, actor identity, IP address, or raw audit data.** **No tenant
IDs, actor IDs, raw audit JSON, storage paths, signed URLs, tokens, secrets, service-role details, connector
credentials, JWTs, cookies, or API keys are visible.**

Every dashboard capability is marked Not built yet: **Custom dashboard builder remains not built. Charts /
visualizations remain not built. Connector-driven spend/license dashboards remain not built. AI dashboard insights
remain not built. Dashboard export remains not built. Scheduled dashboard delivery remains not built.**

### 31.2 Scope / guardrails
This verifies only the read-only Dashboards staging behavior for the synthetic Tenant A account — not full parity,
and nothing here is writable. **No production data was touched. No hosted commands were run by the agent. No RLS
policies were changed. No migrations were added.** **Old-app parity is not complete. UI/UX parity is not complete.
AI/API connector parity is not complete. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. Upload is not automatically production-ready. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17
§5 box is ticked by this verification.

---

## 32. CHECKPOINT — Read-only visible parity wave (PRs #80–#97)

**Read-only visible parity wave through PR #97 is complete and staging-verified.** **This is not full old-app
parity. This is not cutover readiness.** It is a milestone: every implemented v3 surface in the wave is read-only,
RLS-scoped (RLS is the sole authorization boundary — no service-role on request paths, no new policies, no
broadened access), staging-verified by a human, and built by reusing existing verified read surfaces with DTOs
deliberately stripped of sensitive internals. Staging ref `ycdpzduxugdsffjqyoai`; production ref
`dzbfxulvxchdemcettrx` (never touched). After #97: **RLS suite 248 green · 117 tests · 16 build routes.**

### 32.1 What is implemented + staging-verified in this wave
| Surface | Build PR | Staging verification |
| --- | --- | --- |
| Shell / navigation (E01) | #81 | #82 (verified) |
| Contract files attach/open/finalize (E09a) | #76, #78 | #77, #79 (#80 blocked-cleanup recorded) |
| Apps inventory — empty + populated (E03) | #83 (#88 defensive count-read hardening was closed UNMERGED) | #84→#86 corrected→#89 (populated PASS) |
| App detail — populated (E04) | #83 | #89 (verified) |
| People / Users — populated (E05/E06) | #85 | #89 (verified) |
| Reports (E14) | #90 | #91 (verified) |
| Audit / Logs (E23) | #90 | #91 (verified) |
| Admin / Settings (E21) | #92 | #93 (verified) |
| Files / Documents (E09) | #94 | #95 (verified) |
| Dashboards (E02) | #96 | #97 (verified) |

The synthetic staging Apps/People **fixture process exists and was human-run** (§21; ref-guarded, confirmation-
phrase, no service-role). **No production data was touched. No hosted commands were run by the agent. No RLS
policies were changed. No migrations were added.**

### 32.2 What remains NOT built
**Connectors remain not built. AI / Analysis remains not built. Identity matching workflow remains not built.
Imports remain not built. Exports remain not built. Billing remains not built. SSO/SAML/OIDC remains not built.
SCIM/IdP import remains not built. Connector credential vault remains not built.** Also not built: tenant
switching, user invitations, role management, API keys / ingestion tokens, connector-driven spend/license
reporting, a real report builder / CSV / PDF / scheduled delivery, AI document/app/license intelligence, and
production cutover.

### 32.3 Next fork — pick ONE design PR (do NOT build the capability directly)
**The next strategic fork is connector vault versus identity matching workflow.** Both are write/secret surfaces
that the read-only wave deliberately avoided; each needs a **separate design PR before any implementation**.

**Option A — Connector credential vault**
- Needed before any real connector.
- Requires security design first.
- Must handle secrets, encryption, rotation, audit, least privilege, no browser exposure.
- Higher risk.

**Option B — Identity matching workflow**
- Needed before UAR and identity resolution parity.
- Requires write/RLS design first.
- Must handle manual match/unmatch, audit, reversible changes, no cross-tenant leakage.
- Medium-high risk.

**Recommendation.** **Recommended next step is connector credential vault only after a separate security design
PR, or identity matching workflow only after a separate RLS/write design PR.** Do not start connectors directly.
Do not start AI directly. Do not start imports/exports directly. Do either: (1) a connector vault security design
PR, or (2) an identity matching workflow RLS/write design PR.

### 32.4 Posture (unchanged by this checkpoint)
**The read-only parity wave is a milestone, not cutover approval. RISK-001 remains OPEN. Cutover remains BLOCKED.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is
not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified.** No doc 17 §5 box is ticked by this checkpoint.

---

## 33. DESIGN — Connector credential vault (PR #99, Option A)

**Connector credential vault design is drafted but not implemented. Connector implementation remains blocked until
the vault design is reviewed and accepted.** This is the §32.3 Option-A design PR — docs-only, the prerequisite
for any connector work and for **RISK-007** (connector secrets). The full design is
[42_CONNECTOR_CREDENTIAL_VAULT_DESIGN](./42_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md).

**The five load-bearing decisions.** (1) **Two-tier split** — metadata (name/provider/status/last-sync) in
RLS-readable tables; secret material (tokens/keys) in a store with **no `authenticated` grant and RLS deny-all**, so
no SQL a logged-in user runs returns a secret. (2) **Envelope encryption** — per-secret DEK under AEAD, DEKs wrapped
by a KEK in a managed KMS (never repo/env/browser), AAD binding ciphertext to `{tenant_id, connector_id,
secret_kind, version}`. (3) **Server-only secret use** — decrypt only inside a server-side runner covered by
`check-auth-safety`; the client contract is a safe-metadata DTO and nothing else. (4) **Re-authorized execution** —
every action re-derives tenant context server-side from the JWT and verifies membership **and** admin/steward role;
no blanket service-role, client `tenant_id` never trusted. (5) **Auditable / reversible / killable** — append-only
audit (reuse `reject_audit_mutation`), versioned + revocable secrets, per-tenant/per-connector/global kill-switch.

**Threat model (malicious Tenant-A user) → control:** read Tenant-B creds → secret tier has no authenticated path;
trigger Tenant-B sync → runner re-checks target-tenant membership+role; exfiltrate tokens / browser-leak → secrets
never serialized, log/error redaction deny-list; service-role exploit → none on request paths (existing gate),
runner uses a narrow dedicated identity; refresh replay → single-flight + refresh-token rotation; callback abuse →
single-use CSRF `state` bound to initiating user+tenant+PKCE/nonce; viewer→admin elevation → server-side role check
every action; stale/deleted creds → versioned active-pointer + tombstone, runner refuses revoked; audit/run
poisoning → append-only + server-written-only.

**Schema/RLS are conceptual only — no migration, table, policy, or encryption code in this PR.** Carries the
`0016`/T37 lesson: `REVOKE` broad + `GRANT` narrow for the secret tables and assert the privilege surface
(`has_table_privilege`) in the RLS suite. Sequencing is gated on design acceptance (step 0); rollout is staging-only
(`ycdpzduxugdsffjqyoai`), feature-flagged, human-verified, never production (`dzbfxulvxchdemcettrx`) until accepted
+ the doc 17 §5 gate. **No connector credentials are stored by this PR. No connector sync is implemented by this PR.
No production data was touched. No hosted commands were run. No migrations were added. No RLS policies were changed.
No service-role access was added. Connectors remain not built. AI / Analysis remains not built. Imports remain not
built. Exports remain not built. Billing remains not built. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains
BLOCKED.** No doc 17 §5 box is ticked by this design PR.

---

## 34. ACCEPTANCE — Connector vault design baseline + gated sequence (PR #100)

**Connector credential vault design is accepted as the design baseline.** The doc 42 §1–§18 design is the agreed
shape future vault work builds against; §19–§23 add the acceptance status + gated implementation sequence so future
work **cannot skip straight into connector implementation**. **The vault is not implemented. Connectors remain not
built. No connector credentials are stored. No connector sync is implemented.**

**Gated implementation sequence (doc 42 §20 — none of these PRs exist yet):** **PR A** vault schema migration (no
execution path) → **PR B** RLS + deny-all secret tests → **PR C** server-only access wrapper + no-browser-import
guard → **PR D** audit/run lifecycle model → **PR E** connector metadata UI only → **PR F** OAuth callback skeleton
with state/nonce validation (no provider token storage until tested) → **PR G** first low-risk connector, only
after vault tests + audit pass. **Hard gates (§21):** no connector credentials before vault schema + deny-all
tests; **no connector secret of ANY kind (OAuth token, API key, PAT, webhook secret) stored before
encryption-wrapper tests**; no connector credential write or sync before the run/audit model; no browser exposure
of secrets ever; no production credential migration before staging verification.

**Acceptance does NOT mean** (doc 42 §23): not approval to implement, not production approval, does not close
RISK-001, not cutover approval, does not permit connector sync. Open questions (KMS provider, envelope library,
local dev secret handling, rotation/revocation UX, provider OAuth callback routing, audit retention, rate-limit
store) must be resolved in the relevant gated PR before that step proceeds. **Connector implementation remains
blocked until the gated vault implementation PRs are complete. No production data was touched. No hosted commands
were run. No migrations were added. No RLS policies were changed. No service-role access was added. Old-app parity
is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this acceptance PR.

---

## 35. IMPLEMENTATION — Connector vault schema foundation, PR A (PR #101, migration `0017`)

**Connector vault schema foundation is added.** The first gated implementation PR (doc 42 §20 PR A, shipped with
its PR B deny-all tests; doc 42 §24). Migration `0017_connector_vault_schema_foundation.sql` creates the docs/42 §4
tables — `public.connectors` (Tier-1 metadata) + `public.connector_runs` (Tier-1 safe run summaries) +
`public.connector_secrets` (Tier-2 secret material) — with the two-tier RLS/grant posture; audit reuses the
existing append-only `audit_logs` (no separate table).

**Connector vault is still not usable. Connector secret material is not readable by authenticated users:**
`connector_secrets` is RLS-enabled with **zero policies** (default deny-all) and `authenticated`/`anon` hold **zero
privilege** — there is no SQL a logged-in user can run to read/write/delete a secret. Tier-1 metadata is
tenant-member READ-only (no request-path write — that is a later gated PR). Proven by `org_rls_test.sql` **T38**
(tenant-scoped metadata read + no-write) + **T39** (secret deny-all at runtime + privilege-surface + no-secret-
column structural check); suite **248 → 292**; `test-rls.sh` re-asserts the secret-table revoke after its blanket
grant (the `0015`/`0016` masking lesson); same-tenant integrity via composite `(connector_id, tenant_id)` FKs (the
`0005` pattern); `database.types.ts` regenerated.

**Schema/RLS/tests only — no execution path.** **Connector implementation remains blocked. No connector credentials
are stored. No connector sync is implemented. No encryption/decryption wrapper is implemented. No provider connector
is implemented. No OAuth callback is implemented. No connector UI is implemented. No service-role request path is
added.** The next gate is **PR C** (server-only encrypt/decrypt wrapper + no-browser-import guard) — no secret of
any kind is stored until its tests pass. A human must apply `0017` to staging then production in a future step (an
agent never runs hosted commands). **No production data was touched. No hosted commands were run. Old-app parity is
not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 36. HARDENING — Connector vault metadata/run grants, migration `0018` (PR #102)

**Staging verification of 0017 found broad metadata/run table grants that must be hardened before the connector
sequence continues** (doc 42 §25). A human applied `0017` to staging (`ycdpzduxugdsffjqyoai`); `connector_secrets`
was correct (RLS enabled, zero policies, no `anon`/`authenticated` privilege), but `connectors` + `connector_runs`
carried broad `anon`/`authenticated` `INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/SELECT` — because `0017`
did `grant select` but never `revoke`d the hosted-default grants (the `0015`/`0016` masking lesson; the local
harness re-assert had only revoked the per-DML privileges, masking it). **Connector secret material remained
inaccessible to anon and authenticated users** (the bug was only on the Tier-1 metadata/run tables).

**Connector metadata/run grants are being hardened to least privilege.** Migration
`0018_harden_connector_vault_grants.sql` does `revoke all` from `anon` + `authenticated` on all three vault tables,
then `grant select` back to `authenticated` on `connectors` + `connector_runs` only — after it the `authenticated`
surface is EXACTLY `connectors=SELECT`, `connector_runs=SELECT`, `connector_secrets=(none)`; `anon=(none)`
everywhere (no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER for any request-path role). No write policy added;
`service_role` untouched; idempotent. Proven by `org_rls_test.sql` **T40** (exact per-role privilege arrays +
TRUNCATE/REFERENCES/TRIGGER negatives + tenant-scoped SELECT still works + cross-tenant SELECT still RLS-denied);
the harness re-assert now mirrors `0018`; suite **292 → 318**; types 0-diff (grant-only).

**Connector vault is still not usable. Connector implementation remains blocked. No connector credentials are
stored. No connector sync is implemented. No encryption/decryption wrapper is implemented. No provider connector is
implemented. No OAuth callback is implemented. No connector UI is implemented. No service-role request path is
added. No production data was touched. No hosted commands were run by the agent** (a human re-applies `0018` to
staging then production later; next gate is still PR C, the encrypt/decrypt wrapper). **Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 37. STAGING VERIFICATION — `0018` connector vault grant hardening (PR #103)

**Connector vault grant hardening has been applied and verified on staging** (doc 42 §26). A human applied `0018`
to staging (`ycdpzduxugdsffjqyoai`) via `db push` and queried the live privilege/policy surface. **Migration 0018
is present on staging.** The table-privilege query returned **exactly two rows** — `authenticated | connector_runs
| SELECT` and `authenticated | connectors | SELECT` — with **no anon rows, no connector_secrets rows, and no
INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER grant for anon or authenticated.** `pg_policies` returned exactly
the two tenant-member SELECT policies (connectors / connector_runs); **connector_secrets had no policies.** Linked
ref remained `ycdpzduxugdsffjqyoai`.

Confirmed live: **Connector metadata tables expose authenticated SELECT only. Connector secret material remains
inaccessible to anon and authenticated users. Anon has no connector vault table privileges. No broad INSERT,
UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER grants remain on connector vault tables for anon or
authenticated.** The `0017` broad hosted-default grants are gone (resolving the §36 finding); the secret tier was
never exposed. **The agent ran nothing — no hosted command, no staging mutation; production untouched.**

**Connector vault is still not usable. Connector implementation remains blocked. No connector credentials are
stored. No connector sync is implemented. No encryption/decryption wrapper is implemented. No provider connector is
implemented. No OAuth callback is implemented. No connector UI is implemented. No service-role request path is
added. No production data was touched.** A human re-applies `0018` to production later; next gate is still PR C.
**Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is
not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.

---

## 38. IMPLEMENTATION — PR C: server-only connector vault crypto wrapper (PR #104)

**Server-only connector vault crypto wrapper is implemented and tested** (doc 42 §27) — the §20 PR C gate, the
reviewed envelope-encryption boundary the §21 hard gates require **before any connector secret may be stored**.
`src/lib/server/connector-vault/crypto.ts` exposes `encryptConnectorSecret` / `decryptConnectorSecret` over an
injected `ConnectorVaultKeyProvider` (KMS abstraction). Pure AEAD — **no database access, no Supabase client
import, no service-role, no `process.env`** (a test asserts the only import is `node:crypto`). AES-256-GCM, a
per-secret DEK wrapped by the provider's KEK, a structured payload (`v/alg/kekId/wrappedDek/iv/ciphertext/tag/
aadDigest`), and **AAD binding `{tenant_id, connector_id, secret_kind, version}`** so decryption fails closed on
any swap; plaintext only ever leaves `decryptConnectorSecret`; DEK zeroed after use; typed `ConnectorVaultCryptoError`
with no plaintext/key bytes in messages.

**Server-only boundary:** under `src/lib/server/`, a runtime browser-sentinel, and a static guard test
(`no-client-import.test.ts`) asserting no `"use client"`/`src/app` file imports it. **The wrapper uses test-only
key material in tests only** (an in-memory provider in the test file — random KEKs, no checked-in keys, no env
secrets); **no real KMS is integrated.** +19 tests (117 → 136): round-trip; ciphertext ≠ / contains-no plaintext;
tenant/connector/kind/version-swap fail; tampered ciphertext/tag fail; wrong KEK fails; redacted errors; input
validation; all five secret kinds; purity + server-only guards.

**No real connector credentials are stored. No connector secret material is inserted, updated, or deleted. No
connector sync is implemented. No provider connector is implemented. No OAuth callback is implemented. No connector
UI is implemented. No service-role request path is added. No production data was touched. No hosted commands were
run.** No migration; RLS suite unchanged (318); types 0-diff. **Connector vault is still not usable for real
credentials until the remaining gated PRs are complete** (PR D audit/run model → PR E metadata UI → PR F OAuth
callback → PR G first connector). **Connector implementation remains blocked. Old-app parity is not complete. UI/UX
parity is not complete. AI/API connector parity is not complete. Upload is not automatically production-ready.
Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 39. IMPLEMENTATION — PR D: connector run/audit lifecycle foundation (PR #105)

**Connector run/audit lifecycle foundation is added** (doc 42 §28) — the §20 PR D gate, the safe run/audit model
required before any connector execution or credential storage. **No connector execution is implemented. No provider
connector is implemented.** Two pieces:

- **Migration `0019_connector_run_audit_lifecycle.sql`** widens `connector_runs` (`0017`) to the **six-state**
  lifecycle (`queued/running/succeeded/failed/canceled/timed_out`), renames `finished_at→completed_at`,
  `items_seen→records_seen`, `error_class→failure_code`, and adds safe `records_imported`/`records_failed` +
  `failure_label`. Safe metadata only (no secret/token/key/payload). **Grants UNCHANGED** — `authenticated`
  `[SELECT]` only, `anon` none, **no write policy** (run writes remain future server-only/runner work). Audit
  reuses the **append-only `audit_logs`** (no new connector audit table). No `connector_secrets` change.
- **`src/lib/server/connector-vault/run-lifecycle.ts`** (server-only, PURE — NO imports, no DB/Supabase/
  service-role/`process.env`): typed states + valid transitions, the conceptual audit actions
  (`connector.run.created/.started/.completed/.failed`, `connector.credential.created/.revoked`), and pure
  builders that VALIDATE then return the safe shape a future runner would persist (no DB write), with a redaction
  guard that rejects any secret-shaped field name / credential-shaped value / unsafe failure label.

+16 app tests (136 → 151) + **T41** (RLS suite **318 → 327**): lifecycle/transition validation, safe-labels-only,
secret-field rejection, module purity + server-only guard; T41 proves the six states accepted + out-of-set status
rejected + renamed/added columns present (old names gone) + no secret column + grant shape unchanged + no
request-path write. Types regenerated. **No connector credentials are stored. No connector secret material is
inserted, updated, or deleted. No connector sync is implemented. No OAuth callback is implemented. No connector UI
is implemented. No service-role request path is added. No production data was touched. No hosted commands were
run.** A human applies `0019` to staging then production later; next gate is **PR E** (read-only connector metadata
UI). **Connector vault is still not usable for real credentials until the remaining gated PRs are complete.
Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API
connector parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is
verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17
§5 box is ticked by this PR.

---

## 40. STAGING VERIFICATION — `0019` connector run/audit lifecycle (PR #107)

**Connector run/audit lifecycle migration 0019 has been applied and verified on staging** (doc 42 §29). A human
applied `0019` to staging (`ycdpzduxugdsffjqyoai`): the remote migration list showed `0019` absent before push,
`supabase db push --linked` applied it, the list then showed `0019` **present** on Remote; linked ref remained
`ycdpzduxugdsffjqyoai`. The live `connector_runs_status_check` returned the six lifecycle states — **`connector_runs`
supports queued, running, succeeded, failed, canceled, and timed_out.** The table-privilege query returned
**exactly two rows** (`authenticated | connector_runs | SELECT` and `authenticated | connectors | SELECT`) with no
anon rows and no connector_secrets rows; `pg_policies` returned exactly the two tenant-member SELECT policies and
**`connector_secrets` has no policies.** **Connector metadata tables expose authenticated SELECT only. Anon has no
connector vault table privileges. Connector secret material remains inaccessible to anon and authenticated users.
No broad INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER grants remain on connector vault tables for anon
or authenticated.** The six-state lifecycle landed and the `0018` least-privilege surface is intact (matching T41).

**The agent ran nothing — no hosted command, no staging mutation; production untouched. Connector vault is still
not usable. Connector implementation remains blocked. No connector credentials are stored. No connector sync is
implemented. No provider connector is implemented. No OAuth callback is implemented. No connector UI is
implemented. No service-role request path is added. No production data was touched.** A human re-applies `0019` to
production later; next gate is still **PR E** (read-only connector metadata UI). **Old-app parity is not complete.
UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically production-ready.
Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this verification.

---

## 41. IMPLEMENTATION — PR E: read-only connector metadata UI (PR #108)

**Read-only connector metadata UI is added** (doc 42 §30) — the §20 PR E gate, the first connector *surface*.
**Only safe connector and connector run metadata is shown. Connector secret material is not queried or
displayed.** A new authenticated route `/connectors` (route count 16 → 17) + the nav "Connectors" item flipped
from "Not built yet" to `/connectors`; it mirrors the read-only `/files`/`/reports`/`/admin` pattern
(user-scoped client, RLS is the authority, fail-closed).

- **`src/lib/data/connectors.ts`** (server-only, READ-ONLY): `listConnectorsForCurrentUser()` does two
  RLS-scoped reads of the **Tier-1 tables only** — `connectors` (safe subset: provider/display_name/status/
  granted_scopes_safe/timestamps) + `connector_runs` (latest run per connector: status/timestamps/safe
  failure_code+label/safe counters). It **never queries `connector_secrets`** and never selects `tenant_id`,
  `organization_id`, `connected_by`, `health`, or `last_sync_at`. No service-role, no write. Fails closed on
  the connectors read; a failed runs read is non-fatal (lastRun null).
- **Page `/connectors`**: the safe table + empty state + an explicit **"Not built yet"** list (connect a
  provider, store credentials, OAuth callback, API key / PAT entry, run sync, provider connectors,
  disconnect / revoke, manual run, scheduled run, real connector health). No credential form, no
  connect/reconnect/disconnect button, no sync button.

+7 app tests (151 → 158; build 16 → 17 routes; RLS suite unchanged **327**, no migration, types 0-diff):
empty/fail-closed/safe-DTO (every forbidden column provably absent)/latest-run/non-fatal-runs/status
helpers + the nav "Connectors is linkable" assertion + a static scan proving no `connector_secrets` query and
no secret-shaped column string in the page/data code (reads only `connectors`/`connector_runs`). **No
connector credentials are stored. No connector sync is implemented. No provider connector is implemented. No
OAuth callback is implemented. No credential form is implemented. No connect/reconnect/disconnect action is
implemented. No manual or scheduled run action is implemented. No service-role request path is added. No
production data was touched. No hosted commands were run. Connector vault is still not usable for real
credentials until the remaining gated PRs are complete** (next: PR F OAuth callback skeleton → PR G first
connector). **Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 42. IMPLEMENTATION — PR F: OAuth callback validation skeleton (PR #109)

**OAuth callback skeleton is added. OAuth state/nonce validation is implemented** (doc 42 §31) — the §20 PR F
gate, CSRF/replay validation infrastructure only. **No OAuth code is exchanged for tokens. No access token is
stored. No refresh token is stored.** No provider is contacted; the vault stays not usable for real
credentials.

- **`src/lib/server/connector-vault/oauth-state.ts`** (server-only, PURE — only import `node:crypto`): a
  stateless **HMAC-SHA256-signed** `state` binds `{tenant_id, provider, connector_id?, subject?,
  redirect_intent, nonce, exp}`. `createOAuthState` mints it; `validateOAuthState` verifies the HMAC over the
  exact signed bytes **before** trusting any field (constant-time), then nonce/expiry/optional
  tenant-provider-connector binding/optional single-use replay — returning a safe reason CODE only (never a
  secret/nonce/token/code). The signing key is an **injected signer** (server-only secret / KMS in prod — NOT
  here; test-only in-memory signer in tests). Single-use replay via an injected `ConsumedNonceStore` (in-memory
  in tests); the **production DB-backed `oauth_pending` replay store remains a gate** (no DB write here).
- **Inert route `/connectors/oauth/callback`** (route count 17 → 18): parses provider/code/state/error, builds
  the signer from a server-only env secret **this PR does not set** (so it is inert "not configured" by
  default), and returns a **safe plain-text inert response**. It **never exchanges the `code`** (value never
  read/returned/logged), never calls a provider endpoint, never writes `connector_secrets`, never marks a
  connector connected, never persists query params.

+26 app tests (158 → 184; build 17 → 18 routes; RLS suite unchanged **327**, no migration, types 0-diff):
valid/tampered/wrong-tenant/wrong-provider/wrong-connector/expired/missing-nonce/wrong-key/missing-malformed/
replay (+ rejected state does not burn the nonce); results carry no secret/nonce; the handler rejects
missing/tampered state, does not exchange the code, and returns inert statuses; a static scan proving the
module + route do no `fetch`/`createClient`/`process.env`(module)/`connector_secrets`/`service_role`/
`access_token`/`refresh_token`/`token_endpoint`/`grant_type`; the no-client-import guard now covers oauth-state
(the inert route is the only allowed `src/app` importer); and the connector metadata UI still queries no
`connector_secrets`. **No OAuth code is exchanged for tokens. No access token is stored. No refresh token is
stored. No connector credentials are stored. No connector secret material is inserted, updated, or deleted. No
connector sync is implemented. No provider connector is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is implemented. No manual or scheduled run action is implemented. No
service-role request path is added. No production data was touched. No hosted commands were run. Connector
vault is still not usable for real credentials until the remaining gated PRs are complete** (next: PR G first
connector — only after the production signer/KMS secret + the single-use `oauth_pending` replay store are wired
and tested). **Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 43. DECISION RECORD — KMS / OAuth-signer / local-dev secrets / `oauth_pending` replay store (PR #110)

**KMS/key-provider decision is recorded. OAuth state signer decision is recorded. OAuth replay-store design is
recorded** (doc 42 §32). Docs/design-decision PR resolving the remaining §17 open questions that gate any real
credential storage — **it implements nothing.** No migration (the `oauth_pending` schema is conceptual/design-only).

- **KMS/key-provider (§32.1):** the production `ConnectorVaultKeyProvider` is backed by an **external managed KMS**
  (default AWS KMS / GCP KMS) holding the KEK; **Supabase Vault/pgsodium is rejected** for the KEK (it co-locates
  key + ciphertext). KEK owned by the server-only runner identity (KMS `GenerateDataKey`/`Decrypt` only, never a
  request-path role); `kekId` = a non-sensitive KMS handle stored per wrapped DEK; rotation by alias (no mass
  re-encryption); unwrap failure **fails closed** (typed error, no key/plaintext, run marked `failed`); local-dev
  uses the in-memory test provider — **no committed keys, no prod secret read in tests**.
- **OAuth signer secret (§32.2):** a **server-only ≥32-byte HMAC secret** from the host secret store (read via
  `CONNECTOR_OAUTH_STATE_SECRET`), never in repo/migration/client; rotation accepts {current, previous} keys for a
  grace window = max state TTL (≤10 min); the `state` carries only the signature, never the key; failures return a
  safe reason code only.
- **`oauth_pending` replay store (§32.3, design-only):** a Tier-2 table (`tenant_id`, provider, connector_id?,
  subject?, `state_jti`, `nonce_hash` [sha256, raw nonce never stored], `expires_at`, `consumed_at?`, `created_at`,
  safe attempt/reason metadata) with `UNIQUE(state_jti)`/`UNIQUE(nonce_hash)`; **single-use consume = one atomic
  UPDATE** (server-only path); **RLS deny-all + zero anon/authenticated privilege** (mirrors `connector_secrets`);
  constant-time hash compare; scheduled expiry sweep; `connector.oauth.state.created/.consumed/.expired/.rejected`
  into the append-only `audit_logs` (safe metadata only).
- **Gates (§32.4):** no real OAuth token storage before the replay store is implemented+tested; no real credential
  storage before the production KMS provider is implemented+tested; no provider connector before replay store + key
  provider + audit path are complete; no browser credential form until the secret write path is explicitly
  reviewed; no production credential storage before staging verification.

**No real connector credential storage is implemented. No OAuth token exchange is implemented. No access token is
stored. No refresh token is stored. No connector secret material is inserted, updated, or deleted. No connector
sync is implemented. No provider connector is implemented. No credential form is implemented. No connect/reconnect/
disconnect action is implemented. No manual or scheduled run action is implemented. No service-role request path is
added. No production data was touched. No hosted commands were run. Connector vault is still not usable for real
credentials until the remaining gated PRs are complete** (next: PR G first connector — only after §32.1 KMS
provider + §32.3 `oauth_pending` replay store are implemented and tested). **Connector implementation remains
blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete.
Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is
not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 44. IMPLEMENTATION — `oauth_pending` single-use replay store (PR #111)

**OAuth pending replay store schema is added** (doc 42 §33) — migration `0020_oauth_pending_replay_store.sql`
lands the §32.3 design, the §32.4 gate-1 prerequisite before any real OAuth token storage. **The oauth_pending
table is not readable or writable by anon or authenticated users. OAuth replay-store implementation remains
server-only.** Table + deny-all RLS/grant + a pure server-only helper only — no consume function, no route, no
token exchange, no credential storage; `connector_secrets` untouched.

- **`public.oauth_pending`** (`tenant_id`, `organization_id?`, `connector_id?`, provider, `subject?`,
  `state_jti`, `nonce_hash` [sha256 — raw nonce never stored], `intent`, `expires_at` NOT NULL, `consumed_at?`,
  `created_at`, `attempt_count`, `last_rejected_code?` [CHECK = safe reason set]). **Single-use:**
  `UNIQUE(state_jti)` + `UNIQUE(nonce_hash)`. **Same-tenant:** composite `(connector_id, tenant_id)` FK
  (MATCH SIMPLE; skipped when connector_id null). **No raw nonce/state/code/token/secret column.**
- **RLS deny-all (mirrors `connector_secrets`):** RLS-enabled + ZERO policies + `revoke all` from anon +
  authenticated (no grant). After `0020`, authenticated + anon hold EXACTLY zero privilege. The future
  server-only consume path (runner / `SECURITY DEFINER`, a later PR) does the atomic single-use UPDATE.
  `test-rls.sh` re-asserts the `oauth_pending` revoke after its blanket-grant crutch.
- **Server-only helper** `src/lib/server/connector-vault/oauth-pending.ts` (PURE — only `node:crypto`):
  `hashOAuthValue` (deterministic sha256) + `buildOAuthPendingRecord` (validates + returns the safe row,
  hashing the raw nonce and never returning it, rejecting secret-shaped fields). No DB/token-exchange/
  `connector_secrets`/service-role; server-only (sentinel + no-client-import guard).

**T42** (RLS suite **327 → 352**): deny-all (runtime + catalog exact-zero-privilege) + structural (RLS,
zero policies, no secret column, `expires_at` NOT NULL, UNIQUE single-use rejects duplicates, composite-FK
cross-tenant block) + `connector_secrets`/Tier-1 grants unchanged. **+9 app tests** for the helper; types
regenerated (includes `oauth_pending`). **No OAuth code is exchanged for tokens. No access token is stored. No
refresh token is stored. No connector credentials are stored. No connector secret material is inserted,
updated, or deleted. No connector sync is implemented. No provider connector is implemented. No credential
form is implemented. No connect/reconnect/disconnect action is implemented. No manual or scheduled run action
is implemented. No service-role request path is added. No production data was touched. No hosted commands were
run. Connector vault is still not usable for real credentials until the remaining gated PRs are complete**
(next: the §32.1 KMS-backed key provider → the server-only consume path → PR G first connector; a human
applies `0020` to staging then production later). **Connector implementation remains blocked. Old-app parity
is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not
automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 45. STAGING VERIFICATION — `0020` oauth_pending replay store (PR #112)

**OAuth pending replay store migration 0020 has been applied and verified on staging** (doc 42 §34). A human
applied `0020` to staging (`ycdpzduxugdsffjqyoai`): the remote list showed `0020` absent before push, `supabase
db push --linked` applied it, the list then showed `0020` **present**; linked ref remained
`ycdpzduxugdsffjqyoai`. The live RLS query returned `connector_secrets rls_enabled = true` and `oauth_pending
rls_enabled = true` — **Oauth_pending RLS is enabled.** The table-privilege query returned **exactly two rows**
(`authenticated | connector_runs | SELECT` and `authenticated | connectors | SELECT`) with no anon rows, no
connector_secrets rows, and no oauth_pending rows; `pg_policies` returned exactly the two tenant-member SELECT
policies and **`connector_secrets` has no policies** and **Oauth_pending has no policies.** **Oauth_pending is
not readable or writable by anon or authenticated users. Connector secret material remains inaccessible to anon
and authenticated users. Connector metadata tables expose authenticated SELECT only. Anon has no connector
vault table privileges. No broad INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER grants remain on
connector vault tables for anon or authenticated.** The deny-all replay store landed and the `0018`
least-privilege metadata surface is intact (matching T42).

**The agent ran nothing — no hosted command, no staging mutation; production untouched. No OAuth code is
exchanged for tokens. No access token is stored. No refresh token is stored. No connector credentials are
stored. No connector secret material is inserted, updated, or deleted. No connector sync is implemented. No
provider connector is implemented. No credential form is implemented. No connect/reconnect/disconnect action is
implemented. No manual or scheduled run action is implemented. No service-role request path is added. No
production data was touched.** A human re-applies `0020` to production later; next is the §32.1 KMS-backed key
provider → the server-only consume path → PR G first connector. **Connector vault is still not usable for real
credentials until the remaining gated PRs are complete. Connector implementation remains blocked. Old-app
parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not
automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.

---

## 46. IMPLEMENTATION — KMS-backed `ConnectorVaultKeyProvider` skeleton (PR #113)

**KMS-backed ConnectorVaultKeyProvider skeleton is added. The KMS adapter is server-only** (doc 42 §35) — the
§32.1 production key-provider boundary, the §32.4 gate-2 prerequisite before any real credential storage. It
stores nothing. **Tests use mocked or test-only key material only; no real KMS credentials are required in
tests.**

- **Dependency-free KMS boundary (no SDK):** a tiny `KmsClient` interface (`generateDataKey(kekId)` +
  `decrypt(wrappedDek, kekId)`) that maps 1:1 to AWS KMS `GenerateDataKey`/`Decrypt` (GCP KMS equivalent).
  **No AWS/GCP SDK is added** — a real KMS-backed client is a later PR (the only place an SDK would land,
  mocked in tests); a test-only in-memory fake stands in here.
- **Adapter** `createKmsKeyProvider(config)` implements the PR C `ConnectorVaultKeyProvider` over the injected
  `KmsClient` + `{ currentKekId, previousKekIds? }`, and exposes non-secret `currentKekId`/`allowedKekIds`
  metadata. New secrets wrap **only under the current KEK**; `unwrapDataKey` accepts current OR previous
  (rotation grace window — rotate by alias, no re-encryption); an unknown key id is rejected before any KMS
  call; **fails closed** when unconfigured (`createKmsKeyProvider` throws on missing client/current-KEK;
  `kmsKeyProviderConfigFromEnv` returns null when `CONNECTOR_VAULT_KMS_KEY_ID` is unset). **Redacted errors**
  — wrap/unwrap/invalid-DEK failures throw a typed `ConnectorVaultKeyProviderError` with no plaintext/key/
  wrapped/ciphertext bytes (the KmsClient's error is swallowed); nothing logs. Server-only (sentinel +
  no-client-import guard; only the erased `./crypto` type import).

+11 app tests (193 → 204; RLS suite unchanged **352**, no migration, types 0-diff): wrap/unwrap; rotation
(previous-KEK row still unwraps, new wrap under retired KEK refused); wrong/unknown key id fails; missing
config fails closed; unwrap/wrap-failure errors carry no key bytes; invalid-length DEK fails closed; env
helper null-when-unset; **the crypto wrapper round-trips THROUGH the KMS-backed provider** (no real KMS);
module purity + the no-client-import guard now covers `kms-key-provider`. **No OAuth code is exchanged for
tokens. No access token is stored. No refresh token is stored. No connector credentials are stored. No
connector secret material is inserted, updated, deleted, or read. No connector sync is implemented. No
provider connector is implemented. No credential form is implemented. No connect/reconnect/disconnect action
is implemented. No manual or scheduled run action is implemented. No service-role request path is added. No
production data was touched. No hosted commands were run. Connector vault is still not usable for real
credentials until the remaining gated PRs are complete** (next: a reviewed real KMS-backed `KmsClient` + the
server-only `oauth_pending` consume path → PR G first connector). **Connector implementation remains blocked.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload
is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not
yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 47. IMPLEMENTATION — real AWS KMS client adapter skeleton (PR #114)

**Real KMS client adapter skeleton is added. The adapter is server-only** (doc 42 §36) — the concrete
`KmsClient` (PR #113 boundary) for the §32.1 chosen provider, **AWS KMS**:
`src/lib/server/connector-vault/aws-kms-client.ts`. It stores nothing. **Tests use mocked KMS responses only;
no real KMS credentials are required in tests; no live KMS calls are made in tests.**

- **AWS KMS command-shape mapping (still SDK-free):** the adapter emits the exact AWS KMS commands —
  wrap → `GenerateDataKey { KeyId, KeySpec: "AES_256" }` → `{ Plaintext (DEK), CiphertextBlob (wrapped) }`;
  unwrap → `Decrypt { KeyId, CiphertextBlob }` → `{ Plaintext (DEK) }` (passing `KeyId` makes KMS enforce the
  blob was wrapped under that key) — through an **injected `AwsKmsCommandSender`**. **NO `@aws-sdk/client-kms`
  dependency is added**; wiring a real SDK-backed sender (`new KMSClient({region}).send(...)`) is the **next
  gate** (the one PR where the SDK is introduced, mocked in its tests). So this adapter's tests need no AWS
  credentials and make no live call — a mock sender returns canned responses + records the command shapes.
- **`createAwsKmsClient({ send, region })`** implements `KmsClient`; **fails closed** on missing `send` /
  missing-or-garbage `region` (AWS region format checked); `awsKmsConfigFromEnv()` returns null when
  `CONNECTOR_VAULT_AWS_KMS_REGION` is unset/invalid and binds no sender (inert by default). **Redacted
  errors** — failures throw a typed `AwsKmsError` with no plaintext/key/blob/region/SDK detail (the sender's
  error is swallowed); a missing/short `Plaintext` fails closed; nothing logs. Server-only (sentinel +
  no-client-import guard; only the erased `./kms-key-provider` type import). Wired to nothing — reached only
  via `createKmsKeyProvider` later.

+11 app tests (204 → 215; RLS suite unchanged **352**, no migration, types 0-diff): missing-config fail-closed;
wrap→GenerateDataKey + unwrap→Decrypt command-shape mapping; mocked-success returns DEK/wrapped only through
the contract; KMS/SDK error redacted; malformed/missing response fails closed; wrong KeyId on Decrypt fails
closed; env helper null-when-unset; **the AWS adapter composes through `createKmsKeyProvider` + the crypto
wrapper round-trip** (no real KMS); module purity + the no-client-import guard now covers `aws-kms-client`.
**No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No connector
credentials are stored. No connector secret material is inserted, updated, deleted, or read. No connector sync
is implemented. No provider connector is implemented. No credential form is implemented. No connect/reconnect/
disconnect action is implemented. No manual or scheduled run action is implemented. No service-role request
path is added. No production data was touched. No hosted commands were run. Connector vault is still not usable
for real credentials until the remaining gated PRs are complete** (next: the SDK-wiring gate — a reviewed real
`@aws-sdk/client-kms`-backed sender — + the server-only `oauth_pending` consume path → PR G first connector).
**Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete.
AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context
is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No
doc 17 §5 box is ticked by this PR.

---

## 48. IMPLEMENTATION — AWS KMS SDK sender wiring (PR #115)

**AWS KMS SDK sender wiring is added. The AWS KMS sender is server-only** (doc 42 §37) — the SDK-wiring gate:
the concrete `@aws-sdk/client-kms`-backed implementation of the `AwsKmsCommandSender` seam (PR #114),
`src/lib/server/connector-vault/aws-kms-sdk-sender.ts`. Stores nothing; wired to nothing (no connector/OAuth/
route/credential-write). **Tests mock AWS KMS responses only; no real AWS or KMS credentials are required in
tests; no live KMS calls are made in tests.**

- **Dependency:** adds **`@aws-sdk/client-kms`** (`^3.x`) — the single dependency the §32.1/§36 plan reserved
  for this gate, and the only place it is imported. The 2 moderate `npm audit` advisories are PRE-EXISTING
  `next`→`postcss` transitive issues, **not** from the AWS SDK; `audit fix --force` is not run (it would
  downgrade Next). The SDK import is server-only (sentinel + no-client-import guard + `next build` confirm no
  client/route reaches it → not bundled into a browser route).
- **`awsKmsSenderFromClient(client)`** (testable core) builds the real `GenerateDataKeyCommand { KeyId,
  KeySpec: "AES_256" }` / `DecryptCommand { KeyId, CiphertextBlob }`, calls `client.send(command)`, and maps
  the SDK output to our `AwsKmsResponse`. Tests inject a MOCK `{ send }` → no SDK construction, no network, no
  credentials. **`createAwsKmsSdkSender({ region })`** validates the region (fails closed before any client)
  and constructs `new KMSClient({ region })` (credentials via the runner's IAM default provider chain — never
  hardcoded). **`createAwsKmsSdkSenderFromEnv()`** returns null unless `CONNECTOR_VAULT_AWS_KMS_REGION` is set
  (this PR sets no env — inert). **Redaction** — send failure / malformed response throws a typed
  `AwsKmsSdkError` (fixed message; the raw AWS error is swallowed; nothing logs); the §36 adapter re-validates.

+10 app tests (215 → 225; RLS suite unchanged **352**, no migration, types 0-diff): fail-closed config/no
client; wrap→GenerateDataKeyCommand + unwrap→DecryptCommand shape mapping (real SDK Command instances via a
mock client — no live call); raw AWS error swallowed; malformed/missing-Plaintext response fails closed; env
helper null-when-unset; **the mocked SDK sender composes through `createAwsKmsClient` + `createKmsKeyProvider`
+ the crypto wrapper round-trip** (no real KMS); module scope + the no-client-import guard now covers
`aws-kms-sdk-sender`. **No OAuth code is exchanged for tokens. No access token is stored. No refresh token is
stored. No connector credentials are stored. No connector secret material is inserted, updated, deleted, or
read. No connector sync is implemented. No provider connector is implemented. No credential form is
implemented. No connect/reconnect/disconnect action is implemented. No manual or scheduled run action is
implemented. No service-role request path is added. No production data was touched. No hosted commands were
run. No environment variable is added to production or staging. Connector vault is still not usable for real
credentials until the remaining gated PRs are complete** (next: the server-only `oauth_pending` consume path →
PR G first connector — only after the runner IAM/KMS grant + a real KEK alias are provisioned and
staging-verified by a human). **Connector implementation remains blocked. Old-app parity is not complete. UI/UX
parity is not complete. AI/API connector parity is not complete. Upload is not automatically production-ready.
Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN.
Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.

---

## 49. IMPLEMENTATION — server-only `oauth_pending` consume path (PR #116)

**Server-only oauth_pending consume path is added. The consume path performs atomic single-use consumption**
(doc 42 §38) — the §16/§32.3 single-use consume, the last replay-store prerequisite before a first connector
can be sketched: `src/lib/server/connector-vault/oauth-pending-consume.ts`. Stores nothing; wired to nothing
(no connector/OAuth-route/credential-write). **Oauth_pending remains not directly readable or writable by anon
or authenticated users.**

- **Deny-all preserved, no migration, no service-role request path.** `oauth_pending` is Tier-2 deny-all
  (`0020`, T42), so a request-path client cannot touch it. The module ships the PURE consume LOGIC +
  classification and delegates the privileged write to an **injected `OAuthPendingConsumer`** (the
  runner-identity-backed executor — a real DB impl, backed by a `SECURITY DEFINER` accessor / the runner's
  connection, never reachable from request/browser code, is a later gated PR). **No browser-accessible
  service-role path is added; RLS suite stays 352.**
- **Atomic single-use.** The executor's `runAtomicConsume` runs ONE statement (documented reference SQL:
  `update … set consumed_at=$now where state_jti/nonce_hash/tenant_id/provider match, connector_id is not
  distinct from $connector_id, consumed_at is null, expires_at > $now returning …`). Success = exactly one row
  changed; a second callback consumes nothing. On 0 rows, `consumeOAuthPending` does a READ-ONLY classify (by
  the unique `state_jti`) → a safe reason code (not_found / already_consumed / expired / tenant / provider /
  connector / nonce mismatch / malformed_input), never mutating again.
- **Redaction.** A result is a safe reason CODE + non-secret metadata (`stateJti`, `consumedAt`) — never a raw
  nonce/state/code/secret. Pure (NO imports), server-only (sentinel + no-client-import guard).

+16 app tests (225 → 241; RLS suite unchanged **352**, no migration, types 0-diff): consume-exactly-one (+ one
atomic mutation); second-consume `already_consumed`; fresh-connect (null) consume; every failure → its safe
reason; malformed never reaches the mutation; missing-consumer throws typed; failure echoes no raw value;
module purity; **the OAuth callback route still exchanges no code and stores no token**; the T42/T39/T40
deny-all proofs unchanged. **No OAuth code is exchanged for tokens. No access token is stored. No refresh
token is stored. No connector credentials are stored. No connector secret material is inserted, updated,
deleted, or read. No connector sync is implemented. No provider connector is implemented. No credential form
is implemented. No connect/reconnect/disconnect action is implemented. No manual or scheduled run action is
implemented. No browser-accessible service-role path is added. No production data was touched. No hosted
commands were run. Connector vault is still not usable for real credentials until the remaining gated PRs are
complete** (next: PR G — a first low-risk connector — only after the runner-identity-backed executor + the
IAM/KMS grant + a real KEK alias are provisioned and staging-verified by a human). **Connector implementation
remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not
complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app
replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked
by this PR.

---

## 50. PROVISIONING PLAN — runner identity / DB grants / OAuth consume / KMS-IAM / staging verification (PR #117)

**Runner identity provisioning plan is recorded. KMS/IAM provisioning plan is recorded. OAuth consume
execution plan is recorded** (doc 42 §39). Docs/design-only provisioning PR — it implements nothing (no
migration, no env secret, no code). It records what the built code primitives (PR #101–#116) require before
any real credential storage or provider connector. **No runner identity is implemented by this PR. No runner
DB grants are added by this PR. No real KMS/IAM grant is configured by this PR.**

- **Runner identity (§39.1):** a single dedicated server-side "connector runner" principal (a worker/job, NOT
  a request handler) executes the privileged vault actions — reached ONLY from server-only
  `connector-vault/*` modules via the runner entrypoint, NEVER a browser/route/server-action. It is a
  **narrow dedicated identity** (its own DB role + a narrow AWS IAM identity), NOT the broad `service_role`
  on a request path; the user request path stays RLS-deny-all on `oauth_pending`/`connector_secrets`.
- **DB privileges (§39.2, least privilege, none added here):** runner = `oauth_pending`
  SELECT+INSERT+UPDATE(consumed_at)+expiry-sweep; `connector_secrets` INSERT+SELECT+UPDATE(is_active/revoked)
  (no DELETE — tombstone/version); `connectors`/`connector_runs` narrow metadata write (the `authenticated`
  `[SELECT]`-only surface unchanged). **No anon, no normal-authenticated direct access, no
  TRUNCATE/REFERENCES/TRIGGER**; every privileged action audits to append-only `audit_logs` (safe metadata
  only).
- **OAuth consume (§39.3):** runner-only atomic single-use consume (PR #116); expired/reused/mismatched fail
  closed; raw nonce/state/code never persisted/logged; no token exchange until the consume path is implemented
  + staging-verified.
- **KMS/IAM (§39.4):** per-env KEK alias (`alias/idcaddie-connector-vault-kek-{staging,prod}`); region from a
  server-only env var; the runner IAM identity granted ONLY `kms:GenerateDataKey`+`kms:Decrypt` scoped to the
  single KEK (no `kms:*`, no `Resource: *`); rotation by alias; staging/prod separation; **no committed
  credentials** (prefer an IAM role via the default provider chain → no AWS keys in app env at all).
- **Env/config (§39.5):** server-only conceptual vars (`CONNECTOR_VAULT_AWS_KMS_REGION`,
  `CONNECTOR_VAULT_KMS_KEY_ID`/`_PREVIOUS_KEY_IDS`, `CONNECTOR_OAUTH_STATE_SECRET`/`_KEY_ID`, the runner DB
  connection) — never in a client bundle (no `NEXT_PUBLIC_*`), fail-closed when missing (every reader already
  returns null/throws). **This PR sets none.**
- **Staging verification (§39.6, human-executed):** apply the future runner-grant migration to staging first;
  verify `oauth_pending`/`connector_secrets` still inaccessible to anon/authenticated; verify the runner role
  holds EXACTLY the §39.2 privileges; verify no browser path invokes runner ops; verify the KMS path with a
  staging-safe/non-production key; record evidence (a docs-only verification PR) before any connector work.
- **Gates (§39.7):** no real credential storage before runner DB grants + KMS IAM are implemented +
  staging-verified; no provider connector before runner consume + KMS path are implemented + staging-verified;
  no production credential flow before the production migration + IAM/KMS are applied + verified; RISK-001
  stays OPEN until the full flow is built/verified and the doc 17 §5 cutover criteria are met.

RLS suite unchanged (**352**), no migration, no code, no env secret. **No OAuth code is exchanged for tokens.
No access token is stored. No refresh token is stored. No connector credentials are stored. No connector secret
material is inserted, updated, deleted, or read. No connector sync is implemented. No provider connector is
implemented. No credential form is implemented. No connect/reconnect/disconnect action is implemented. No
manual or scheduled run action is implemented. No browser-accessible service-role path is added. No production
data was touched. No hosted commands were run. Connector vault is still not usable for real credentials until
the remaining gated PRs are complete. Connector implementation remains blocked. Old-app parity is not complete.
UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app
replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked
by this PR.


---

## 51. IMPLEMENTATION — connector_runner DB grant foundation (PR #118)

**Runner DB grant foundation is added. Runner privileges are least-privilege and not granted to anon or
authenticated users** (doc 42 §40) — migration `0021_connector_runner_grants.sql`, the §39.2 grant foundation:
a dedicated server-side `connector_runner` DB principal with the minimum grant the OAuth `oauth_pending`
consume (PR #116) needs, and nothing else. No app request path wired to the runner; no credential stored.

- **Role:** `create role connector_runner nologin bypassrls` (idempotent). NOLOGIN (a privilege role, not a
  login). BYPASSRLS justified + constrained (§39.1): `oauth_pending` is RLS deny-all so a plain grant alone
  is RLS-denied; the runner is the trusted server principal whose tenant-bound query contract (PR #116)
  excludes cross-tenant rows in the WHERE; it is NOT the broad `service_role`, reached only from the runner
  entrypoint (no `src/`/`src/app` reference).
- **Grants (least privilege, oauth_pending only):** `SELECT` + a column-level `UPDATE (consumed_at,
  attempt_count, last_rejected_code)`. No INSERT, no row delete/purge, no REFERENCES, no TRIGGER, no UPDATE on
  the immutable identity columns. **DEFERRED (no grant here):** `connector_secrets` (secret read/write is a
  later PR — tombstone/version) and `connectors`/`connector_runs` (lifecycle write is a later PR).
- **Browser roles unchanged:** `anon`/`authenticated` deny-all on `oauth_pending`/`connector_secrets`
  preserved (re-asserted), `[SELECT]`-only on the Tier-1 tables, no browser-role policy added; **no
  browser-accessible service-role path is added.**

**T43** (RLS suite **352 → 387**, grant-only — types 0-diff, no app change): proves the runner exists,
BYPASSRLS+NOLOGIN, EXACTLY SELECT + the 3-column UPDATE (no INSERT/DELETE/TRUNCATE/REFERENCES/TRIGGER, no
identity-column UPDATE), ZERO on connector_secrets/connectors/connector_runs; functionally can consume
(SELECT + set consumed_at) but not delete/insert/update-identity/read-secrets; anon/authenticated deny-all
unchanged (a normal authenticated user still cannot consume oauth_pending or touch connector_secrets). A human
applies `0021` to staging then production later + records the §39.6 verification before connector work. **No
OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No connector
credentials are stored. No connector secret material is inserted, updated, deleted, or read by app code. No
connector sync is implemented. No provider connector is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is implemented. No manual or scheduled run action is implemented. No
production data was touched. No hosted commands were run. Connector vault is still not usable for real
credentials until the remaining gated PRs are complete. Connector implementation remains blocked. Old-app
parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not
automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 52. STAGING VERIFICATION — `0021` connector_runner DB grants (PR #119)

**Connector runner DB grant migration 0021 has been applied and verified on staging** (doc 42 §41). A human
applied `0021` to staging (`ycdpzduxugdsffjqyoai`): the remote list showed `0021` absent before push,
`supabase db push --linked` applied it, the list then showed `0021` **present**; linked ref remained
`ycdpzduxugdsffjqyoai`. The role query confirmed `connector_runner` with `rolcanlogin = false` /
`rolbypassrls = true` — **Connector_runner is NOLOGIN. Connector_runner has BYPASSRLS only for the narrow
runner consume path.** The table-privilege query returned **exactly three rows** (`authenticated |
connector_runs | SELECT`, `authenticated | connectors | SELECT`, `connector_runner | oauth_pending | SELECT`)
— no anon rows, no connector_secrets rows, no connector_runner privilege on connectors/connector_runs:
**Connector_runner has SELECT on oauth_pending. Connector_runner has no connectors or connector_runs
privileges.** The column-privilege query returned **UPDATE only on `consumed_at`, `attempt_count`, and
`last_rejected_code`** (+ SELECT on the consume-classification columns) — **Connector_runner has column-scoped
UPDATE only on consumed_at, attempt_count, and last_rejected_code. Connector_runner has no connector_secrets
privileges.** `pg_policies` = exactly the two tenant-member SELECT policies; **`connector_secrets` has no
policies** and **Oauth_pending has no policies.** **Oauth_pending remains not directly readable or writable by
anon or authenticated users. Connector secret material remains inaccessible to anon and authenticated users.
Connector metadata tables expose authenticated SELECT only. Anon has no connector vault table privileges. No
broad INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER grants remain on connector vault tables for
anon or authenticated** — matching T43.

**The agent ran nothing — no hosted command, no staging mutation; production untouched. No OAuth code is
exchanged for tokens. No access token is stored. No refresh token is stored. No connector credentials are
stored. No connector secret material is inserted, updated, deleted, or read. No connector sync is implemented.
No provider connector is implemented. No credential form is implemented. No connect/reconnect/disconnect action
is implemented. No manual or scheduled run action is implemented. No browser-accessible service-role request
path is added. No production data was touched.** A human re-applies `0021` to production later; next are the
runner-identity-backed executors + the KMS/IAM provisioning → PR G. **Connector vault is still not usable for
real credentials until the remaining gated PRs are complete. Connector implementation remains blocked. Old-app
parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not
automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this verification.
---

## 53. IMPLEMENTATION — runner-only `oauth_pending` executor wiring (PR #120)

**Runner-only oauth_pending executor wiring is added. The executor is server-only. The executor is not exposed
to browser request paths** (doc 42 §42). `src/lib/server/connector-vault/oauth-pending-executor.ts` — the
concrete `OAuthPendingConsumer` (PR #116) backed by an INJECTED `RunnerDbClient` (the future runner's
server-only `connector_runner` connection — `0021`, T43, staging-verified §52). Wired to nothing here.

- **`createOAuthPendingExecutor(client)`** fails closed if the client is missing; `runAtomicConsume` issues
  ONE parameterized statement (match tenant/provider/state_jti/nonce_hash/connector_id null-safe + `consumed_at
  is null` + `expires_at > now`, set ONLY `consumed_at`); `readPendingState` is the read-only classify lookup.
  Composed with the pure `consumeOAuthPending`, that is the single-use consume. **No global service-role client
  is created; the runner client is explicitly injected; tests mock it (no live DB call, no credentials).**
- **Redaction:** DB errors throw a fixed safe message — never a raw nonce/state/code/token/secret/DB body; the
  nonce HASH + ids are bound params; nothing logs. Server-only (sentinel + `no-client-import` guard; only the
  consume TYPES imported). **No app route/server action/browser path calls it** (the callback route stays
  inert — static scan). **Oauth_pending remains not directly readable or writable by anon or authenticated
  users. Connector secret material remains inaccessible to anon and authenticated users.**

**+12 app tests (241 → 253; RLS unchanged 387, no migration, no dependency, types 0-diff):** fail-closed on a
missing client; the consume UPDATE shape + bound params; the classify SELECT; the full chain through
`consumeOAuthPending` with a mock that models the atomic single-use semantics; both DB errors redacted; module
purity; the OAuth callback route still inert. A future PR wires the real `RunnerDbClient` + the IAM/KMS grant →
PR G. **No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No
connector credentials are stored. No connector secret material is inserted, updated, deleted, or read. No
connector sync is implemented. No provider connector is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is implemented. No manual or scheduled run action is implemented. No
browser-accessible service-role request path is added. No production data was touched. No hosted commands were
run. Connector vault is still not usable for real credentials until the remaining gated PRs are complete.
Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API
connector parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is
verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc
17 §5 box is ticked by this PR.
---

## 54. HOSTED PROVISIONING PLAN — runner DB / AWS KMS wiring + no-real-token staging verification (PR #121)

**Hosted runner/KMS wiring plan is recorded** (doc 42 §43). Docs/design-only — implements nothing (no hosted
runner, no IAM/KMS grant, no migration, no env secret, no code). Records what a human must provision + verify
before any real provider connector or real token storage. **No hosted runner is implemented by this PR. No
real KMS/IAM grant is configured by this PR.**

- **(§43.1) Hosted runner DB wiring:** the runner (a server-only worker, NOT a request handler) opens a direct
  Postgres connection AS `connector_runner` (filling the PR #120 `RunnerDbClient`); its connection secret
  lives ONLY in the runner host's secret manager, never the repo/app env/client bundle; reached only from the
  runner entrypoint, never a route — NOT a browser/request service-role path. It can ONLY consume
  `oauth_pending` (SELECT + the 3-column UPDATE — `0021`); it cannot INSERT/DELETE `oauth_pending` or touch
  `connector_secrets`/`connectors`/`connector_runs`.
- **(§43.2) Hosted AWS KMS wiring:** per-env KEK alias (`alias/idcaddie-connector-vault-kek-{staging,prod}`),
  staging/prod separation, the runner host's IAM role granted ONLY `kms:GenerateDataKey`+`kms:Decrypt` scoped
  to the single KEK (no `kms:*`, no `Resource: *`), no static AWS keys in the repo, no AWS keys in any
  browser/client env.
- **(§43.3) Env/config:** server-only conceptual vars (already §39.5), staging/prod separation, fail-closed
  when missing; this PR sets none.
- **(§43.4) No-real-token staging verification (human-executed):** runner DB can consume `oauth_pending` only;
  `oauth_pending`/`connector_secrets` stay deny-all to anon/authenticated; a KMS mock/staging-safe dry-run
  wrap/unwrap WITHOUT a provider token; no token exchange; no credential storage; no browser path invokes
  runner ops; no KMS SDK bundle in the browser. Record evidence before connector work.
- **(§43.5) Gates before the first connector:** runner DB wiring implemented + staging-verified; AWS
  KMS/IAM/KEK staging path implemented + staging-verified; the no-real-token full vault chain verified
  end-to-end; THEN a first low-risk connector skeleton may be started.
- **(§43.6) Explicit non-approval:** does NOT approve real token storage / connector sync / production; does
  NOT close RISK-001; does NOT unblock cutover.

RLS suite unchanged (**387**), no migration, no code, no env secret. **No OAuth code is exchanged for tokens.
No access token is stored. No refresh token is stored. No connector credentials are stored. No connector secret
material is inserted, updated, deleted, or read. No connector sync is implemented. No provider connector is
implemented. No credential form is implemented. No connect/reconnect/disconnect action is implemented. No
manual or scheduled run action is implemented. No browser-accessible service-role request path is added. No
production data was touched. No hosted commands were run. Connector vault is still not usable for real
credentials until hosted runner/KMS verification is complete. Connector implementation remains blocked.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload
is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not
yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 55. TOOLING — connector-vault staging dry-run verifier (PR #122)

**Hosted runner/KMS no-real-token verifier is added. The verifier is human-run only. The agent did not run
hosted commands** (doc 42 §44). `scripts/verify-staging-connector-vault-dry-run.mjs` — the executable §43.4
checklist a human runs to prove the hosted runner DB connection (as `connector_runner`) + the AWS KMS path
work WITHOUT storing any real credential. Same safety model as `verify-staging-rls-suite.mjs`: connects to
NOTHING, prints NO secret values, performs NO hosted mutation — the confirmed path only PRINTS a runbook.

- **The verifier refuses production**; requires staging (`ycdpzduxugdsffjqyoai`) via the linked file or
  `--ref`; requires an explicit confirmation phrase before emitting the runbook (default refuses; `--help`
  prints usage); requires hosted secrets/config via ENV (names only — never read/printed); **the verifier
  does not use real provider tokens** (only the synthetic sentinel `synthetic-vault-dry-run-not-a-token`).
- **Runbook proves (human-run):** consume one synthetic `oauth_pending` row exactly once as `connector_runner`;
  second consume + every mismatch → 0 rows; runner DENIED on `connector_secrets`; `oauth_pending`/
  `connector_secrets` deny-all to anon/authenticated; KMS wrap/unwrap of the synthetic payload (GenerateDataKey
  + Decrypt only); narrow cleanup; no browser route involved.
- **+13 tests (253 → 266; RLS unchanged 387, no migration, no dependency, types 0-diff):** mocks only, no
  hosted call — refuses production / off-staging / no confirmation / missing env; emits the runbook only when
  confirmed + staging + env (still opens no connection); redacts secrets; synthetic payload only; no
  `connector_secrets` write printed; `--help` exits 0; source imports only `node:fs`.

A human runs this on staging next + records the evidence; the agent runs only `node --check` + the mock tests.
**The verifier does not exchange OAuth codes for tokens. The verifier does not store access tokens. The
verifier does not store refresh tokens. The verifier does not store connector credentials. The verifier does
not insert, update, delete, or read connector secret material. The verifier does not implement connector sync.
The verifier does not implement provider connectors. The verifier does not implement credential forms. The
verifier does not add connect/reconnect/disconnect actions. The verifier does not add manual or scheduled run
actions. The verifier does not add browser-accessible service-role request paths. No OAuth code is exchanged
for tokens. No access token is stored. No refresh token is stored. No connector credentials are stored. No
connector secret material is inserted, updated, deleted, or read. No connector sync is implemented. No provider
connector is implemented. No credential form is implemented. No connect/reconnect/disconnect action is
implemented. No manual or scheduled run action is implemented. No browser-accessible service-role request path
is added. No production data was touched. No hosted commands were run by the agent. Connector vault is still
not usable for real credentials until the human-run staging dry run is executed and recorded. Connector
implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5
box is ticked by this PR.
---

## 56. OPERATOR PROCEDURE — human-run connector-vault staging dry run (PR #123)

**Human-run staging dry-run procedure is recorded** (doc 42 §45). Docs-only — the exact ordered checklist a
human operator follows to run the §44 verifier (`scripts/verify-staging-connector-vault-dry-run.mjs`) on
staging and capture the no-real-token evidence (the §43.5 gate before a first connector). **No hosted commands
were run by the agent. No production data was touched.**

1. **Confirm staging ref is `ycdpzduxugdsffjqyoai`** (`cat supabase/.temp/project-ref`).
2. **Confirm production is NOT linked** (not `dzbfxulvxchdemcettrx`; the verifier also hard-refuses it).
3. **Provision the runner DB connection as `connector_runner`** outside the repo (server-only; secret in the
   runner host's secret manager, never committed).
4. **Provision the staging AWS IAM/KMS/KEK alias** outside the repo (KEK
   `alias/idcaddie-connector-vault-kek-staging`; IAM = `kms:GenerateDataKey`+`kms:Decrypt` only, scoped to
   the KEK; no static keys).
5. **Export the required env vars locally without committing them** (`CONNECTOR_RUNNER_DB_URL`,
   `CONNECTOR_VAULT_AWS_KMS_REGION`, `CONNECTOR_VAULT_KMS_KEY_ID`; optional setup/state vars).
6. **Run the verifier with the confirmation phrase** (`CONNECTOR_VAULT_DRY_RUN_CONFIRM="RUN CONNECTOR VAULT
   STAGING DRY RUN"`) and execute the printed runbook against staging, synthetic payload only.
7. **Capture evidence:** verifier refused production; verifier confirmed staging; runner consume succeeds
   once; second consume fails; mismatch cases fail safely; `connector_secrets` remains inaccessible; no real
   provider token used; no OAuth code exchanged; no access token stored; no refresh token stored; no connector
   sync ran; no browser route invoked runner operations.
8. **Record the evidence in the next docs-only verification PR.**

RLS suite unchanged (**387**), no migration, no code, no env secret. **No real provider token is used. No OAuth
code is exchanged for tokens. No access token is stored. No refresh token is stored. No connector credentials
are stored. No connector secret material is inserted, updated, deleted, or read. No connector sync is
implemented. No provider connector is implemented. No credential form is implemented. No browser-accessible
service-role request path is added. Connector implementation remains blocked until human-run staging dry-run
evidence is recorded. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is
not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app
replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked
by this PR.
---

## 57. STAGING DRY-RUN PREFLIGHT — BLOCKED on IPv6-only DB host (PR #124)

**Human-run staging dry-run preflight was attempted** (doc 42 §46). Docs-only — records the operator's attempt
to run the §45 procedure against staging (`ycdpzduxugdsffjqyoai`; production `dzbfxulvxchdemcettrx` not
touched; main `46254e9` / PR #123) and the network blocker hit before any dry-run step. **No production data
was touched. No hosted commands were run by the agent.**

- **Provisioned (staging only):** **connector_runner_login was created on staging. connector_runner_login is
  LOGIN and NOINHERIT. connector_runner_login is not BYPASSRLS. connector_runner remains NOLOGIN and
  BYPASSRLS. connector_runner_login is granted connector_runner** (the login role `set role`s to the narrow
  consume privileges; NOINHERIT = no ambient inheritance; the login role itself holds no direct privilege and
  is not BYPASSRLS).
- **Blocker:** **The staging direct DB host resolves only to IPv6 from the operator environment**
  (`db.ycdpzduxugdsffjqyoai.supabase.co` has no IPv4 A record, only an IPv6 AAAA record). **The Supabase IPv4
  add-on was not enabled.** psql connectivity from the operator Mac is blocked by DNS/network reachability.
- **The dry-run was not executed.** No dry-run oauth_pending seed was inserted; no runner consume was executed
  (nor second-consume / mismatch checks); no KMS dry-run was executed; no connector_secrets access was
  attempted. **No real provider token was used. No OAuth code was exchanged for tokens. No access token was
  stored. No refresh token was stored. No connector credentials are stored. No connector secret material was
  inserted, updated, deleted, or read. No connector sync was implemented. No provider connector was
  implemented.**
- **Resolution: the dry-run must be executed from an IPv6-capable runner host or environment** (a runner box /
  CI / cloud shell with IPv6 to the DB host, or the pooler/IPv4 add-on if the operator opts in later), then
  record the evidence in the next docs-only verification PR. The verifier, runner role model, and deny-all
  posture are unchanged.

RLS suite unchanged (**387**), no migration, no code. **Connector implementation remains blocked** until the
no-real-token dry run is executed from an IPv6-capable runner host and the evidence is recorded. **Old-app
parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not
automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 58. STAGING DRY-RUN — PASS (no-real-token evidence) (PR #125)

**Human-run no-real-token staging dry run was executed** and PASSED (doc 42 §47). Docs-only — records the
operator's successful run of the §44/§45 runbook against staging (`ycdpzduxugdsffjqyoai`; production
`dzbfxulvxchdemcettrx` not touched; main `d3a5289` / PR #124). **No production data was touched. No hosted
commands were run by the agent.**

- **IPv6 resolved:** **The dry run was executed from an IPv6-capable EC2 host. The staging DB IPv6
  connectivity blocker (§57) was resolved by running from the EC2 host** — it resolved the DB AAAA record and
  connected to `db.ycdpzduxugdsffjqyoai.supabase.co:5432` (EC2 `i-00335d464d6f7c299`; role
  `arn:aws:sts::833822972703:assumed-role/idc-runner-role/i-00335d464d6f7c299`).
- **Runner DB — PASS:** **connector_runner_login connected successfully. connector_runner_login successfully
  SET ROLE connector_runner. connector_runner_login had zero direct table grants. connector_runner was denied
  access to connector_secrets.** **A synthetic oauth_pending row was inserted for Tenant A**
  (`aaaa1111-1111-1111-1111-111111111111`; state_jti `dryrun-state-jti-tenant-a`, provider `dryrun`, sentinel
  `synthetic-vault-dry-run-not-a-token`). **The first connector_runner consume returned exactly one row. The
  second connector_runner consume returned zero rows. The synthetic dry-run oauth_pending row was cleaned up.**
- **KMS — PASS (least privilege):** alias `alias/idcaddie-staging-connector-vault`. **KMS GenerateDataKey
  succeeded from the EC2 runner role. KMS Decrypt succeeded from the EC2 runner role. KMS DescribeKey was
  denied from the EC2 runner role as expected least-privilege behavior** (policy allows only GenerateDataKey +
  Decrypt). Synthetic envelope round trip passed (`PASS_DEK_UNWRAP`, `PASS_SYNTHETIC_PAYLOAD_ROUNDTRIP`,
  `PASS_KMS_SYNTHETIC_NO_REAL_TOKEN_DRY_RUN`).

**First low-risk connector skeleton is now unblocked, but real token storage remains gated until a
provider-specific connector PR is reviewed and verified.** RLS suite unchanged (**387**), no migration, no
code. **No real provider token was used. No OAuth code was exchanged for tokens. No access token was stored.
No refresh token was stored. No connector credentials are stored. No connector secret material was inserted,
updated, deleted, or read. No connector sync was implemented. No provider connector was implemented. No
production data was touched. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box
is ticked by this PR.
---

## 59. IMPLEMENTATION — connector provider registry skeleton (PR #126)

**Connector provider registry skeleton is added. The registry is generic for future SaaS app connectors.
Slack is added as the first inert provider skeleton** (doc 42 §48). The first connector implementation step
after the §58 no-real-token dry-run gate cleared — the provider abstraction for many future SaaS connectors,
proven now with ONE inert entry. **No provider connector is functional yet.**
`src/lib/server/connector-vault/provider-registry.ts` is PURE, SAFE METADATA only.

- **Definition** (safe display/metadata only): id / displayName / category / authKind (oauth2|api_key, a
  label) / capabilities (read_users/read_apps/read_groups/read_audit/read_usage, display) / status
  (skeleton/not_connected/disabled/future) / reviewGate / riskLevel / requiredScopes (DISPLAY-ONLY) /
  helpCopy / enabled (default false). No token/secret/authorize-URL field. Generic id space (slack,
  google_workspace, okta, microsoft_entra, zoom, atlassian, github); one DEFINED entry now.
- **Slack (inert):** `slack` / Slack / collaboration / oauth2 / skeleton / enabled:false / low /
  reviewGate:provider-specific-reviewed-pr; capabilities + scopes metadata only; no OAuth URL, no exchange,
  no storage, no API call.
- **Helpers:** listConnectorProviders / getConnectorProvider / isSupportedConnectorProvider /
  getProviderCapabilities / isConnectorProviderReady. **Fail closed:** unknown id → null/[]/false; no
  connect/exchange/sync/store function exists; `isConnectorProviderReady` is true ONLY for enabled +
  not_connected (every entry is inert skeleton → false). **Real token storage remains gated behind a later
  provider-specific reviewed PR.**

**+7 tests (266 → 273; RLS unchanged 387, no migration, no dependency, types 0-diff):** safe-metadata-only;
Slack inert; supported-check + capabilities; unknown fails closed; none ready; module purity; callback route
still inert. Server-only (sentinel + no-client-import guard, zero imports); no UI change (the `/connectors`
page already says "coming soon / not built"); not imported by any app route. **No OAuth code is exchanged for
tokens. No access token is stored. No refresh token is stored. No connector credentials are stored. No
connector secret material is inserted, updated, deleted, or read. No connector sync is implemented. No
provider API call is made. No credential form is implemented. No connect/reconnect/disconnect action is
implemented. No browser-accessible service-role request path is added. No production data was touched. No
hosted commands were run. Connector implementation remains blocked. Old-app parity is not complete. UI/UX
parity is not complete. AI/API connector parity is not complete. Upload is not automatically production-ready.
Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN.
Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 60. IMPLEMENTATION — Slack OAuth authorize/callback skeleton (PR #127)

**Slack OAuth authorize/callback skeleton is added. The Slack provider remains non-functional for real
connections** (doc 42 §49). The first provider-specific connector module —
`src/lib/server/connector-vault/providers/slack-oauth.ts` — builds the Slack authorize-redirect URL and
classifies the Slack callback, integrating the existing `oauth-state` signer + `oauth_pending` replay shape +
the registry (§59). No code exchange, no token/credential storage, no `connector_secrets`, no Slack API call,
no connector marked connected.

- **`buildSlackAuthorizeUrl`** → `{ ok, url, stateJti, nonceHash, expiresAt } | { ok:false, reason }`:
  `https://slack.com/oauth/v2/authorize?client_id&scope&redirect_uri&state` with a SIGNED state
  (`createOAuthState`). client_id INJECTED (never hardcoded / env-read here); redirect_uri validated
  (HTTPS-only); scopes default to the registry's display scopes. Returns oauth_pending alignment hashes
  `stateJti=sha256(state)`, `nonceHash=sha256(nonce)` (one-way; raw nonce/state never persisted). The Slack
  token endpoint is never built/called. Fail-closed reasons on bad config.
- **`classifySlackCallback`** → safe outcome (`provider_error`/`not_configured`/`invalid[reason]`/`received`).
  Validates the signed state via `validateOAuthState`; checks `code` PRESENCE only (value never read); **NO
  token exchange, NO Slack call, NO connector_secrets write, NO connector marked connected.** `received`
  returns only the future-consume keys (one-way hashes).

**+15 tests (273 → 288; RLS unchanged 387, no migration, no dependency, types 0-diff):** authorize URL
host/path + safe params; state/nonce bound via the existing signer + alignment hashes; fail-closed on missing
config / unsafe redirect_uri / non-slack provider; callback valid-but-no-exchange; error/cancel safe;
fail-closed on missing code / missing/invalid/tampered state / wrong provider; module purity; callback route
still inert. Server-only (sentinel + no-client-import guard); the live `/connectors/oauth/callback` route is
unchanged + inert; no connect button / no UI change; the registry still lists Slack inert (skeleton,
enabled:false). **No Slack OAuth code is exchanged for tokens. No Slack access token is stored. No Slack
refresh token is stored. No connector credentials are stored. No connector secret material is inserted,
updated, deleted, or read. No Slack API call is made. No connector sync is implemented. No credential form is
implemented. No connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role
request path is added. Real token storage remains gated behind a later provider-specific reviewed PR. No
production data was touched. No hosted commands were run. Connector implementation remains blocked. Old-app
parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not
automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 61. IMPLEMENTATION — Slack authorize-time oauth_pending persist (PR #128)

**Slack authorize-time oauth_pending persistence is added. Slack authorize creates a replay-protection row
for a future callback consume step** (doc 42 §50). `src/lib/server/connector-vault/providers/slack-authorize-pending.ts`
composes the §60 Slack authorize-URL builder with the `oauth_pending` replay shape — at authorize-time it
creates the single-use row a future callback PR consumes exactly once. **Slack remains non-functional for
real connections.** No code exchange, no token/credential storage, no `connector_secrets`, no Slack API call,
no connector marked connected, no sync run. Library-only (no route / server action / connect button).

- **Injected INSERT seam (no migration, no service-role client):** `oauth_pending` is deny-all to anon/
  authenticated (`0020`) and `connector_runner` has SELECT+UPDATE but NOT INSERT (`0021` deferred it), so the
  privileged INSERT is delegated to an injected `SlackPendingInserter` (the runner-identity-backed inserter +
  its future INSERT grant is a later PR); tests inject a mock (no live DB write, no credentials). RLS suite
  unchanged **387**.
- **`persistSlackAuthorizePending(input, inserter)`** → `{ ok, url, stateJti, expiresAt } | { ok:false,
  reason }`: validates inserter present / provider supported / tenant context (tenant required; org/subject
  optional, nullable per `0020`); builds the authorize URL (validating clientId/redirectUri[https]/signer/
  scopes); inserts ONE row `{ tenant_id, organization_id?, provider:'slack', connector_id?, subject?,
  state_jti=sha256(state), nonce_hash=sha256(nonce), intent:'connect', expires_at }`. **Raw nonce is not
  stored. Raw state is not stored** (the raw nonce is never materialized — the builder returns only hashes).
- **Fail closed:** missing inserter / unsupported provider / missing tenant(org/subject) / bad config / unsafe
  redirect / duplicate(state_jti|nonce_hash) → duplicate_pending / DB error → persist_failed; no partial row.

**+12 tests (288 → 300; RLS unchanged 387, no migration, no dependency, types 0-diff):** persists exactly one
row (provider slack, ids, intent, hashes); stores state_jti/nonce_hash never raw state/nonce; fresh-connect
null vs re-auth connector_id; fail-closed on duplicate/DB-error/missing-inserter/missing-tenant/missing-config/
unsafe-redirect; module purity; callback route still inert. Server-only (sentinel + no-client-import guard);
the live `/connectors/oauth/callback` route UNCHANGED + inert; no connect button / no UI change; the registry
still lists Slack inert (skeleton, enabled:false). **No Slack OAuth code is exchanged for tokens. No Slack
access token is stored. No Slack refresh token is stored. No connector credentials are stored. No connector
secret material is inserted, updated, deleted, or read. No Slack API call is made. No connector sync is
implemented. No credential form is implemented. No connect/reconnect/disconnect action is exposed to users. No
browser-accessible service-role request path is added. Real token storage remains gated behind a later
provider-specific reviewed PR. No production data was touched. No hosted commands were run. Connector
implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box
is ticked by this PR.
---

## 62. IMPLEMENTATION — connector_runner oauth_pending INSERT grant (PR #129)

**connector_runner oauth_pending INSERT grant is added. The grant is limited to authorize-time replay
protection rows** (doc 42 §51). Migration `0022_connector_runner_oauth_pending_insert.sql` grants
`connector_runner` a COLUMN-LEVEL INSERT on `public.oauth_pending` — ONLY the 9 §50 authorize-time columns —
the grant `0021` deliberately deferred, so the future runner-backed inserter (PR #128 seam) can create the
single-use replay row. No Slack code / app change.

- **Grant (least privilege):** `grant insert (tenant_id, organization_id, connector_id, provider, subject,
  state_jti, nonce_hash, intent, expires_at) on public.oauth_pending to connector_runner`. The runner supplies
  ONLY those 9 columns; a non-granted column (consumed_at/attempt_count/last_rejected_code) on INSERT is
  permission-denied. Existing surface unchanged: SELECT + the 3-column UPDATE; still no DELETE/row-purge/
  REFERENCES/TRIGGER.
- **Not granted (unchanged):** **connector_runner still has no connector_secrets privileges. connector_runner
  still has no connectors or connector_runs privileges. Anon and authenticated roles still have no
  oauth_pending write access. Anon and authenticated roles still have no connector_secrets access. No
  oauth_pending policy is added. No connector_secrets policy is added** (both stay RLS-on zero-policy
  deny-all; the secret-table deny-all is re-asserted defensively).

**T44** (RLS suite **387 → 413**, grant-only — types 0-diff, no app change): the INSERT column grant is
EXACTLY the 9 authorize-time columns; the runner can INSERT them but not consumed_at/attempt_count/
last_rejected_code; functionally inserts an authorize-time row but a non-granted column on INSERT is
permission-denied; SELECT kept; UPDATE columns still EXACTLY the 3 consume columns; still no DELETE/TRUNCATE/
REFERENCES/TRIGGER; ZERO on connector_secrets/connectors/connector_runs; anon/authenticated deny-all + zero
policies unchanged. (T43's stale "no INSERT" assertions are updated.) A human applies `0022` to staging then
production later + records verification before wiring the real runner inserter. **No Slack OAuth code is
exchanged for tokens. No Slack access token is stored. No Slack refresh token is stored. No connector
credentials are stored. No connector secret material is inserted, updated, deleted, or read. No Slack API call
is made. No connector sync is implemented. Real token storage remains gated behind a later provider-specific
reviewed PR. No production data was touched. No hosted commands were run. Connector implementation remains
blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete.
Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement
is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 63. STAGING VERIFICATION — `0022` connector_runner oauth_pending INSERT grant (PR #130)

**Migration 0022 was applied and verified on staging. connector_runner oauth_pending INSERT grant is
staging-verified** (doc 42 §52). A human applied `0022` to staging (`ycdpzduxugdsffjqyoai`; production
`dzbfxulvxchdemcettrx` not touched) and queried the live surface: `supabase migration list --linked` shows
`0022` present on Local and Remote; linked ref remained `ycdpzduxugdsffjqyoai`. **No production data was
touched. No hosted commands were run by the agent.**

- Roles unchanged: `connector_runner` remains NOLOGIN + BYPASSRLS; `connector_runner_login` remains LOGIN +
  NOINHERIT, not BYPASSRLS; **connector_runner_login has no direct table grants.**
- **The INSERT grant is column-level, not table-level. connector_runner does not have table-level INSERT on
  oauth_pending. connector_runner_login does not have table-level INSERT on oauth_pending. connector_runner can
  INSERT only authorize-time replay columns** — EXACTLY {connector_id, expires_at, intent, nonce_hash,
  organization_id, provider, state_jti, subject, tenant_id}. **connector_runner cannot INSERT consumed_at,
  attempt_count, or last_rejected_code.** `connector_runner` keeps table-level SELECT on `oauth_pending`;
  **connector_runner can UPDATE only consumed_at, attempt_count, and last_rejected_code.**
- **connector_runner still has no connector_secrets privileges. connector_runner still has no connectors or
  connector_runs privileges.** `authenticated` still has SELECT on `connectors`/`connector_runs` only.
  **Anon and authenticated roles still have no oauth_pending write access. Anon and authenticated roles still
  have no connector_secrets access. No oauth_pending policy is added. No connector_secrets policy is added**
  (`pg_policies` zero on both; the metadata tables retain only tenant-member SELECT policies). Matches T44.

A human re-applies `0022` to production later + wires the real runner inserter only in a later reviewed PR.
RLS suite unchanged (**413**), no migration, no code. **No Slack OAuth code is exchanged for tokens. No Slack
access token is stored. No Slack refresh token is stored. No connector credentials are stored. No connector
secret material is inserted, updated, deleted, or read. No Slack API call is made. No connector sync is
implemented. Real token storage remains gated behind a later provider-specific reviewed PR. No production data
was touched. Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 64. PRODUCTION VERIFICATION — connector-vault migrations 0016–0022 (PR #131)

**Production was behind from migration 0016 through 0022. Migrations 0016 through 0022 were applied to
production. Production migration list shows 0001 through 0022 present** (doc 42 §53). A human applied the
connector-vault backlog to PRODUCTION (`dzbfxulvxchdemcettrx`; staging `ycdpzduxugdsffjqyoai`), then returned
the local repo to staging. Before the push production had `0001`–`0015` and was missing `0016`–`0022`; the
human applied 0016/0017/0018/0019/0020/0021/0022 in order; after, `supabase migration list --linked` showed
`0001`–`0022` on Local and Remote. **No production data was touched. The agent ran nothing hosted.**

- **Production connector_runner oauth_pending INSERT grant is verified.** Production `connector_runner` is
  NOLOGIN + BYPASSRLS; **Production connector_runner_login was created as LOGIN and NOINHERIT, is not
  BYPASSRLS**, is granted `connector_runner`, and **has no direct table grants**.
- **The production INSERT grant is column-level, not table-level. Production connector_runner does not have
  table-level INSERT on oauth_pending. Production connector_runner_login does not have table-level INSERT on
  oauth_pending. Production connector_runner can INSERT only authorize-time replay columns** — EXACTLY
  {connector_id, expires_at, intent, nonce_hash, organization_id, provider, state_jti, subject, tenant_id}.
  `connector_runner` keeps table-level SELECT on `oauth_pending`; **Production connector_runner can UPDATE only
  consumed_at, attempt_count, and last_rejected_code.**
- **Production connector_runner still has no connector_secrets privileges. Production connector_runner still
  has no connectors or connector_runs privileges.** Production `authenticated` has SELECT on `connectors`/
  `connector_runs` only. **Production anon and authenticated roles still have no oauth_pending write access.
  Production anon and authenticated roles still have no connector_secrets access. No oauth_pending policy is
  added. No connector_secrets policy is added** (`pg_policies` zero on both; metadata tables retain only
  tenant-member SELECT policies). Matches T44.
- **No production dry-run seed was inserted. No production runner consume was executed. No production KMS
  dry-run was executed.** No production `connector_secrets` read/written — schema/grant alignment only.

RLS suite unchanged (**413**), no migration, no code. **Production schema/grants are now aligned for the
connector-vault foundation, but production connector use remains blocked.** **No Slack OAuth code is exchanged
for tokens. No Slack access token is stored. No Slack refresh token is stored. No connector credentials are
stored. No connector secret material is inserted, updated, deleted, or read. No Slack API call is made. No
connector sync is implemented. Real token storage remains gated behind a later provider-specific reviewed PR.
No production data was touched. Connector implementation remains blocked. Old-app parity is not complete. UI/UX
parity is not complete. AI/API connector parity is not complete. Upload is not automatically production-ready.
Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN.
Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 65. IMPLEMENTATION — runner-backed Slack oauth_pending seams (PR #132)

**Runner-backed Slack oauth_pending seams are wired** (doc 42 §54). `src/lib/server/connector-vault/runner-db-client.ts`
connects the PR #128 `SlackPendingInserter` + the PR #120/#116 `OAuthPendingConsumer` to a real runner DB
execution boundary, using the verified `0021`/`0022` `connector_runner` grants. **Slack remains non-functional
for real connections.** No code exchange, no token/credential storage, no `connector_secrets`, no Slack API,
no sync. Library/server-only (no route / connect button / browser path).

- **The runner DB client uses connector_runner_login with SET ROLE connector_runner.** The connection (a
  server-only Postgres session bound to `connector_runner_login`, LOGIN+NOINHERIT) is INJECTED via a
  `RunnerConnection` seam — no DB-driver dependency, no global/service-role client; tests inject a mock.
  `createRunnerDbClient`/`createRunnerPendingInserter`/`createRunnerOAuthPendingConsumer` fail closed
  (`RunnerDbError`) on a missing connection.
- **The authorize-time inserter uses only column-level oauth_pending INSERT grants** — SET ROLE then a
  parameterized INSERT naming EXACTLY the 9 `0022` columns {tenant_id, organization_id, connector_id,
  provider, subject, state_jti, nonce_hash, intent, expires_at}. **The authorize-time inserter does not insert
  consumed_at, attempt_count, or last_rejected_code.** Fail closed: duplicate → `duplicate`; other → `db_error`.
- **The callback consumer uses the existing connector_runner consume grant** — reuses the §38 executor over
  the SET-ROLE-wrapping client (SELECT + the consumed_at/attempt UPDATE only; atomic single-use + classify;
  safe labels). No code exchange, no token storage, no Slack call.

**+13 tests (300 → 313; RLS unchanged 413, no migration, no dependency, types 0-diff):** inserter SET ROLE +
9-column parameterized INSERT (never the 3 consume columns); duplicate/DB-error fail-closed + redacted; missing
connection fails closed; run-client SET-ROLE + redaction; the FULL authorize-persist → runner-consume chain
(consume exactly once, second → already_consumed, duplicate persist → duplicate_pending) over a mock in-memory
connection; consumer issues SET ROLE; module purity; callback route still inert. Server-only (sentinel +
no-client-import guard); the live `/connectors/oauth/callback` route UNCHANGED + inert; no connect button / no
UI change; the registry still lists Slack inert (skeleton, enabled:false). A FUTURE hosted PR provides the real
`RunnerConnection` (a `connector_runner_login` Postgres pool) + the token-exchange step. **No Slack OAuth code
is exchanged for tokens. No Slack access token is stored. No Slack refresh token is stored. No connector
credentials are stored. No connector secret material is inserted, updated, deleted, or read. No Slack API call
is made. No connector sync is implemented. No credential form is implemented. No connect/reconnect/disconnect
action is exposed to users. No browser-accessible service-role request path is added. Real token storage
remains gated behind a later provider-specific reviewed PR. No production data was touched. No hosted commands
were run. Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 66. ARCHITECTURE — app discovery connectors + app-graph normalization (PR #133)

**App discovery connector architecture is recorded. Discovery connectors are modeled separately from deep
provider sync runners. App graph normalization is the bridge between discovery signals and ID Caddie app
records** (doc 42 §55). Shifts the connector roadmap from one-provider Slack plumbing to the broader
"connect many apps quickly" discovery architecture. **Discovery connectors are intended to discover many SaaS
apps quickly through identity and core systems; deep provider sync runners remain provider-specific and will
be added one at a time. The old scraper model is being replaced with discovery connectors plus provider sync
runners.** Safe metadata / types + a pure helper ONLY — no provider is functional.

- **Three layers:** (1) discovery connectors (kinds: identity_provider_discovery / spend_invoice_discovery /
  import_source / browser_extension_discovery / manual_source; discovery capabilities discover_apps /
  discover_assigned_users / discover_groups / discover_login_activity / discover_domains / discover_owners /
  discover_sso_metadata / discover_usage_signals / discover_spend_signals / import_app_inventory); (2)
  app-graph normalization (the bridge → NormalizedAppCandidate); (3) deep provider sync runners
  (deep_provider_sync, one reviewed PR at a time; Slack is the first skeleton).
- **Registry taxonomy (`provider-registry.ts`):** `ConnectorProviderDefinition` gains `kind` +
  `discoveryCapabilities`. **Okta is added as an inert future identity-provider discovery connector. Google
  Workspace is added as an inert future identity-provider discovery connector. Microsoft Entra is added as an
  inert future identity-provider discovery connector** (status `future`, disabled, NO code/URL/token/API).
  Slack stays a deep-sync skeleton. Helpers fail closed: listDiscoveryProviders / listDeepSyncProviders /
  getProviderDiscoveryCapabilities / isDiscoveryProvider / isDeepSyncProvider. No provider is ready.
- **Normalization (`app-discovery.ts`):** types (DiscoveredAppSignal / AppMatchStatus / NormalizedAppCandidate)
  + ONE pure helper `normalizeDiscoveredAppSignals` (groups by domain-else-name, merges sources/ids, naive
  confidence + match status). **Writes NO DB / no app-graph row, calls NO provider, stores NO credential.**

**+12 tests (313 → 325; RLS unchanged 413, no migration, no dependency, types 0-diff):** the 3 inert
identity-discovery entries; discovery vs deep-sync classified separately + disjoint; Slack stays a
non-functional deep-sync skeleton; no provider ready; safe-metadata-only; unknown fails closed; the normalizer
merges/keeps-distinct/fail-soft, imports nothing, writes no DB; registry purity. Server-only (sentinel +
no-client-import guard); not imported by any app route. **No Okta connector is functional. No Google Workspace
connector is functional. No Microsoft Entra connector is functional. No OAuth code is exchanged for tokens. No
access token is stored. No refresh token is stored. No connector credentials are stored. No connector secret
material is inserted, updated, deleted, or read. No provider API call is made. No connector sync is
implemented. No app graph write is implemented. No credential form is implemented. No connect/reconnect/
disconnect action is exposed to users. No browser-accessible service-role request path is added. Real token
storage remains gated behind later provider-specific reviewed PRs. No production data was touched. No hosted
commands were run. Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is
not complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 67. IMPLEMENTATION — graph-scale discovery indexes (PR #134)

**Graph-scale discovery indexes are added. The indexes are schema-grounded against the current 0001 core
graph tables** (doc 42 §56). Migration `0023_graph_scale_discovery_indexes.sql` adds 36 indexes preparing the
core graph tables for high-volume Okta/Google/Microsoft discovery data before those connectors write real
volume — index plumbing only (no column/schema change, no grant, no policy, no RLS-behavior change).

- **The indexes support tenant-scoped RLS hot paths** (tenant_memberships + every graph table's
  tenant/status). **The indexes support high-volume app_users discovery data.** **The indexes support
  app-user and identity-account matching** on person_id — **the app_user_identity_matches model is app_user
  to person, not app_user to identity_account.** **The indexes support case-insensitive email matching through
  lower(email) and lower(primary_email).** **The indexes support vendor/app-name normalization through
  lower(vendor_name) and lower(name).** Plus owning-org joins + invoices/app_contracts/license rollups.
- **Schema-grounded:** no organization_id on graph tables (apps use procurement_owner_org_id/paying_org_id/
  responsible_org_id; contracts use procurement_org_id/paying_org_id); **No identity_account_id column is
  introduced**; `app_user_identity_matches` already has UNIQUE(app_user_id, person_id) so only tenant +
  person_id indexes are added. **No canonical vendor/app registry is implemented in this PR. No app graph
  write is implemented.**
- **Concurrency note:** plain (non-CONCURRENT) CREATE INDEX is correct here (tables near-empty, lands before
  volume); if ever deferred until after discovery data loads, a future index migration MUST use CREATE INDEX
  CONCURRENTLY (cannot run in a transaction block).

**T45** (RLS suite **413 → 424**; types 0-diff, 1553 lines, migration-safety passes): re-asserts a
representative sample of the 36 indexes exists + the lower() functional indexes + the schema-grounding guards
(no identity_account_id; app_user → person; identity_accounts → person via person_id). No app/UI/route change.
**No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No connector
credentials are stored. No connector secret material is inserted, updated, deleted, or read. No provider API
call is made. No connector sync is implemented. No credential form is implemented. No connect/reconnect/
disconnect action is exposed to users. No browser-accessible service-role request path is added. Real token
storage remains gated behind later provider-specific reviewed PRs. No production data was touched. No hosted
commands were run. Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is
not complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 68. STAGING VERIFICATION — graph-scale discovery indexes `0023` (PR #135)

**Graph-scale discovery indexes are applied and verified on staging** (doc 42 §57). A human applied `0023`
to staging (`ycdpzduxugdsffjqyoai`; local/main `b8acc06` — PR #134): `0023` was missing before the push,
`supabase db push --linked` applied it, and **Staging is aligned through migration 0023** (`migration list
--linked` shows `0001`–`0023` aligned, Local + Remote). **All 36 expected graph-scale indexes were present on
staging after verification** (the lower(email)/lower(primary_email)/lower(name)/lower(vendor_name) functional
indexes, the `*_person_idx` app_user→person + identity_account→person match indexes, the tenant/status RLS
hot-path indexes, the owning-org joins, and the invoices/app_contracts/license rollups). **The indexes support
tenant-scoped RLS hot paths, high-volume discovery, and app/user/account matching.** Matches T45.

Local validation before the apply: 325 tests passed; RLS migration tests passed (assertions **424**); lint/
typecheck/build/auth-safety/migration-safety passed; generated types remained 1553 lines. **The agent ran
nothing hosted. No production migration was run. Production is not verified for 0023** (a human applies it to
production in a future step). RLS suite unchanged (**424**), no migration, no code. **No app code changed. No
schema changed in this verification PR. No connector behavior changed. No provider API call was made. No OAuth
code was exchanged for tokens. No access token was stored. No refresh token was stored. No connector
credentials were stored. No connector secret material was inserted, updated, deleted, or read. No connector
sync was implemented. No credential form was implemented. No connect/reconnect/disconnect action was exposed
to users. No browser-accessible service-role request path was added. No production data was touched. Connector
implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box
is ticked by this PR.
---

## 69. PRODUCTION VERIFICATION — graph-scale discovery indexes `0023` (PR #136)

**Graph-scale discovery indexes are applied and verified on production** (doc 42 §58). A human applied `0023`
to PRODUCTION (`dzbfxulvxchdemcettrx`; staging `ycdpzduxugdsffjqyoai`; local/main `76c68fe` — PR #135), then
relinked local back to staging. **The production apply and verification were human-run; this PR only records
the evidence — the agent did not touch production and ran no hosted command.**

- `0023` was MISSING on production before the push; `supabase db push --linked` applied it successfully;
  **Production is aligned through migration 0023** (`migration list --linked` shows production aligned through
  `0023`). **All 36 expected graph-scale indexes were present on production after verification** (the
  production index-verification query returned `expected_index_count = 36`). **The indexes support
  tenant-scoped RLS hot paths, high-volume discovery, and app/user/account matching.** Matches the §68 staging
  verification + T45.
- **Local Supabase link was returned to staging after production verification. Final linked ref was
  ycdpzduxugdsffjqyoai.**

Production + staging are now schema-aligned through `0023`. RLS suite unchanged (**424**), no migration, no
code. **No app code changed. No schema changed in this verification PR. No migration changed in this
verification PR. No connector behavior changed. No provider API call was made. No OAuth code was exchanged for
tokens. No access token was stored. No refresh token was stored. No connector credentials were stored. No
connector secret material was inserted, updated, deleted, or read. No connector sync was implemented. No
credential form was implemented. No connect/reconnect/disconnect action was exposed to users. No
browser-accessible service-role request path was added. Connector implementation remains blocked. Old-app
parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not
automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet
verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked
by this PR.
---

## 70. DESIGN — canonical vendor/product/app-instance graph (PR #137)

**Canonical vendor/product/instance graph design is added. This is net-new moat work, not old-app parity
restoration** (doc 42 §59). Migration `0024_canonical_app_instance_graph.sql` adds the first schema/design
foundation for canonical vendor → product → app-instance modeling. **The old app was also flat at the
app-document level. The old app had manual overlap-analysis grouping, not automatic canonical app resolution**
(old manual overlap groups may need inventory/port later if OMC depends on them — separate future task).

- **Hierarchy:** vendor → canonical app/product → app instance/site/workspace → users/contracts/invoices/
  license facts/metrics. **apps remains the operational app instance/site/workspace row. Distinct app
  instances must not be collapsed into one app row. Canonical matching groups related apps for roll-up
  reporting without erasing instance boundaries.**
- **Schema (`0024`):** three tenant-scoped tables (same-tenant integrity, RLS = members read + editors INSERT/
  UPDATE, no DELETE) — `vendors`, `app_products` (canonical), `app_aliases` (provenance + the audit/review
  fields reusing the app_user_identity_matches pattern: confidence/review_status/reviewed_by/reviewed_at).
  **Structured instance identity fields are added to apps:** nullable `canonical_app_id` + `instance_domain` +
  `external_instance_id` + `instance_url`. **instance_domain and external_instance_id are future merge/no-merge
  discriminators.** Indexes for the new tables + apps canonical/instance fields.
- **Multi-instance (Atlassian):** Atlassian → Jira/Confluence/Bitbucket → Jira/Flywheel, Jira/Perpetua,
  Confluence/Flywheel — separate apps rows under one canonical product. **Existing app_contracts already
  supports one contract linked to many app instances. No replacement for app_contracts is added. One-invoice-
  split-across-orgs is documented as future work only.**
- **Metrics + resolver (documented, NOT implemented):** **Canonical user rollups must count distinct person_id
  after identity matching, not sum app_users naively. Canonical rollups depend on the app_user to person
  matching engine.** Future resolver = deterministic keys first (instance_domain/external_instance_id/domain/
  provider-app-id/oauth-client-id/sso-app-id), owner/paying/responsible org influences merge, same product but
  different instance discriminator stays separate apps, low confidence → human review, unmerge by repointing
  aliases/canonical_app_id (not rewriting history). **No automatic resolver is implemented.**

**T46** (RLS suite **424 → 446**; types 1553 → 1744; migration-safety passes): the 3 new tables RLS-enabled
with {SELECT, INSERT, UPDATE} only; functional tenant isolation; the apps canonical/instance columns exist;
app_contracts unchanged; **No identity_account_id is introduced**; connector_secrets untouched. **No app graph
writes are implemented. No provider API call is made. No OAuth code is exchanged for tokens. No access token is
stored. No refresh token is stored. No connector credentials are stored. No connector secret material is
inserted, updated, deleted, or read. No connector sync is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role request path is
added. No production data was touched. No hosted commands were run. Connector implementation remains blocked.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload
is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not
yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is
ticked by this PR.
---

## 71. STAGING VERIFICATION — canonical app graph `0024` (PR #138)

**Canonical app graph schema is applied and verified on staging** (doc 42 §60). A human applied `0024` to
staging (`ycdpzduxugdsffjqyoai`; local/main `400eafa` — PR #137): `0024` was missing before the push,
`supabase db push --linked` applied it, and **Staging is aligned through migration 0024** (`migration list
--linked` shows staging aligned through `0024`). **The staging apply and verification were human-run; this PR
only records the evidence — the agent did not touch staging and ran no hosted command.**

Staging verification confirmed: **The vendors table is present on staging. The app_products table is present
on staging. The app_aliases table is present on staging. apps.canonical_app_id is present on staging.
apps.instance_domain is present on staging. apps.external_instance_id is present on staging. apps.instance_url
is present on staging.** Matches the §70 design + T46. **apps remains the operational app instance/site/
workspace row. The canonical graph groups related apps without erasing instance boundaries. Distinct app
instances must not be collapsed into one app row. Existing app_contracts remains the contract-to-app-instance
linking model.**

Local validation before the apply: 325 tests passed; RLS migration tests passed (assertions **446**); lint/
typecheck/build/auth-safety/migration-safety passed; generated database types updated to 1744 lines. RLS suite
unchanged (**446**), no migration, no code, no generated-types change. **No resolver is implemented. No app
graph writes are implemented. No production migration was run for 0024. Production is not verified for 0024** (a
human applies it to production in a future step). **No app code changed. No schema changed in this verification
PR. No migration changed in this verification PR. No connector behavior changed. No provider API call was made.
No OAuth code was exchanged for tokens. No access token was stored. No refresh token was stored. No connector
credentials were stored. No connector secret material was inserted, updated, deleted, or read. No connector
sync was implemented. No credential form was implemented. No connect/reconnect/disconnect action was exposed to
users. No browser-accessible service-role request path was added. No production data was touched. Connector
implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains
BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 72. PRODUCTION VERIFICATION — canonical app graph `0024` (PR #139)

**Canonical app graph schema is applied and verified on production** (doc 42 §61). A human applied `0024` to
PRODUCTION (`dzbfxulvxchdemcettrx`; staging `ycdpzduxugdsffjqyoai`; local/main `deb7fb2` — PR #138), then
relinked local back to staging. **The production apply and verification were human-run; this PR only records
the evidence — the agent did not touch production and ran no hosted command.**

- `0024` was MISSING on production before the push; `supabase db push --linked` applied it successfully;
  **Production is aligned through migration 0024** (`migration list --linked` shows production aligned through
  `0024`). Production verification confirmed: **The vendors table is present on production. The app_products
  table is present on production. The app_aliases table is present on production. apps.canonical_app_id is
  present on production. apps.instance_domain is present on production. apps.external_instance_id is present on
  production. apps.instance_url is present on production.** **Staging and production are aligned through
  migration 0024.** Matches the §71 staging verification + T46.
- **Local Supabase link was returned to staging after production verification. Final linked ref was
  ycdpzduxugdsffjqyoai.**

**apps remains the operational app instance/site/workspace row. The canonical graph groups related apps without
erasing instance boundaries. Distinct app instances must not be collapsed into one app row. Existing
app_contracts remains the contract-to-app-instance linking model.** The schema now exists on production, but
nothing populates it yet. RLS suite unchanged (**446**), no migration, no code, no generated-types change.
**No resolver is implemented. No app graph writes are implemented. No app code changed. No schema changed in
this verification PR. No migration changed in this verification PR. No connector behavior changed. No provider
API call was made. No OAuth code was exchanged for tokens. No access token was stored. No refresh token was
stored. No connector credentials were stored. No connector secret material was inserted, updated, deleted, or
read. No connector sync was implemented. No credential form was implemented. No connect/reconnect/disconnect
action was exposed to users. No browser-accessible service-role request path was added. No production data was
touched. Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not
complete. AI/API connector parity is not complete. Upload is not automatically production-ready. Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. RISK-007
remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 73. DESIGN — resolver + identity-matching engine (PR #140)

**Resolver and identity-matching design is recorded** (doc 42 §62). **The canonical graph schema exists, but
the resolver does not exist yet. Nothing populates apps.canonical_app_id yet.** **The resolver is the moat
engine that will assemble validated discovery signals into the canonical app graph.** Design + pure
types/helpers only (`resolution.ts`): **No live resolver job is implemented. No app graph writes are
implemented. No canonical_app_id write is implemented. No app_alias write is implemented. No app_user to person
match write is implemented.**

- **Future flow (none runs yet):** validated discovery signals → deterministic resolver → low-confidence human
  review → canonical_app_id assignment → app_user→person matching → baseline metrics → canonical/vendor/product
  rollups → recommendations.
- **Resolver matching is deterministic-first and probabilistic-second.** Deterministic keys (instance_domain,
  external_instance_id, instance_url, provider app id, OAuth client id, SSO app id, known domain, explicit
  vendor/product identifiers) may auto-assign; fuzzy similarity (vendor/product/domain/contract-vendor) never
  auto-merges. **Low-confidence matches route to human review.** Unknown/ambiguous fails closed to
  `human_review`.
- **Idempotency:** **Discovery re-runs must be idempotent. Runners must upsert on natural keys, not blindly
  insert.** **instance_domain and external_instance_id are future merge/no-merge keys. Same vendor/product does
  not mean same operational app instance. Distinct app instances must not be collapsed into one app row.
  Atlassian/Jira/Flywheel and Atlassian/Jira/Perpetua must remain distinct app instances.**
- **Identity matching:** **app_user_identity_matches links app_user_id to person_id. There is no
  identity_account_id on app_user_identity_matches. No identity_account_id is introduced.** Deterministic-first
  (exact normalized email / verified external id) then secondary hints → review. **Canonical user rollups must
  count distinct person_id after identity matching, not sum app_users naively. Per-instance counts may use
  app_users.**

Pure helpers (`classifyResolutionConfidence`/`explainResolutionDecision`/`sameOperationalInstance`/
`identityMatchSignals`) tested (deterministic > name-similarity; distinct instance_domain → no auto-merge;
unknown → human_review; no identity_account_id; no client imports; no provider API/fetch; no connector_secrets).
No migration, no schema change → RLS suite **446** and generated types **1744** unchanged. **No provider API
call is made. No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No
connector credentials are stored. No connector secret material is inserted, updated, deleted, or read. No
connector sync is implemented. No credential form is implemented. No connect/reconnect/disconnect action is
exposed to users. No browser-accessible service-role request path is added. No production data was touched. No
hosted commands were run. Connector implementation remains blocked. Old-app parity is not complete. UI/UX
parity is not complete. AI/API connector parity is not complete. Upload is not automatically production-ready.
Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN.
RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 74. SCHEMA — discovery signal / standard fact contract (PR #141)

**Discovery signal fact schema is added. The schema is versioned** (doc 42 §63). `discovery-facts.ts` adds the
first versioned standard-fact contract via zod (already a dependency; no new dependency). **The schema defines
standardized inputs for discovery connectors, deep sync runners, contract intelligence, invoice/spend imports,
and future browser/import sources. The schema is the future input contract for the resolver. The resolver
remains non-live.**

- **Core fields** (every fact): schema_version (required) / signal_id / tenant_id / source_type /
  source_provider / source_run_id? / source_record_id? / observed_at / confidence / provenance? /
  review_status? / raw_source_ref?. **13 fact categories** via the `fact_type` discriminator (app discovery,
  app instance identity, vendor/product, app user/account, person identity candidate, license, usage/activity,
  role/admin, group/team membership, contract, invoice/spend, risk/completeness, recommendation evidence).
- **Safe by construction:** every schema is STRICT → token/secret/credential keys are REJECTED at `safeParse`.
  **Signal facts must not contain token or connector secret material.** **Unknown or ambiguous source data
  fails closed to review** (unknown `source_type` → `unknown_source`; unknown `fact_type` fails parse;
  distinct instance_domain/external_instance_id stay separate instance candidates; invoice carries only a
  candidate app linkage). **Old scraper behavior is a reference to verify, not a source of truth.** No LLM on
  the runtime ingestion hot path.

Tested (valid fixture per category; missing schema_version fails; unknown source → review; token/
connector_secrets rejected; distinct instance_domain separate; contract source_clause_text; invoice no final
linkage; no Supabase/client imports; no fetch/provider API; no DB writes; no service-role). No migration, no
schema change → RLS suite **446** and generated types **1744** unchanged. **No signal ingestion job is
implemented. No database write is implemented. No app graph write is implemented. No canonical_app_id write is
implemented. No app_alias write is implemented. No app_user to person match write is implemented. No provider
API call is made. No OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored.
No API key is stored. No connector credentials are stored. No connector secret material is inserted, updated,
deleted, or read. No connector sync is implemented. No credential form is implemented. No
connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role request path is
added. No production data was touched. No hosted commands were run. Connector implementation remains blocked.
Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload
is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not
yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is
ticked by this PR.
---

## 75. IMPLEMENTATION — fact ingestion staging boundary (PR #142)

**Fact ingestion staging boundary is added** (doc 42 §64). Migration `0025_discovery_facts_staging.sql` adds a
tenant-scoped `discovery_facts` table + a server-only ingestion helper (`discovery-fact-staging.ts`) — the
first safe, RLS-backed write path for validated discovery facts.

- **Only safeParse-validated facts may be staged. Invalid facts are rejected before persistence. Token-bearing
  facts are rejected before persistence. Secret-bearing facts are rejected before persistence.** The helper
  runs the token/secret deny-list then PR #141 `safeParse`, binds the row to the authenticated tenant, and
  inserts through an injected store backed by the user-scoped (authenticated, RLS) DAL — **No service-role
  client is added.**
- **The staged fact table is tenant-scoped. The staged fact table is RLS-protected.** RLS = members read +
  editors INSERT + editors UPDATE, **NO DELETE** (durable review records); indexes on tenant_id +
  (tenant_id, fact_type/source_provider/review_status/natural_key) + source_run_id; review_status default
  `pending`; fact_json NOT NULL; **no `connector_runner` grant**.
- **Staged facts are reviewable inputs for the future resolver. The live resolver is not implemented. No
  canonical app graph write is implemented. No apps.canonical_app_id write is implemented. No app_alias write
  is implemented. No app_user to person match write is implemented.**

**T47** (RLS suite **446 → 458**; types 1744 → 1828; migration-safety passes): RLS-enabled {SELECT, INSERT,
UPDATE}-only; tenant isolation for read/insert/update (tenant A cannot touch tenant B); staging columns +
defaults; connector_secrets untouched; no connector_runner grant. Helper tests: valid fact stages (mock DB);
invalid/token/secret/wrong-tenant rejected before insert; staged row never carries canonical/alias/match
fields. **No provider API call is made. No OAuth code is exchanged for tokens. No access token is stored. No
refresh token is stored. No API key is stored. No connector credentials are stored. No connector secret
material is inserted, updated, deleted, or read. No connector sync is implemented. No credential form is
implemented. No connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role
request path is added. No production data was touched. No hosted commands were run. Connector implementation
remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not
complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app
replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No
doc 17 §5 box is ticked by this PR.
---

## 76. STAGING VERIFICATION — discovery facts staging `0025` (PR #143)

**Discovery facts staging table is applied and verified on staging** (doc 42 §65). A human applied `0025` to
staging (`ycdpzduxugdsffjqyoai`; local/main `06e552a` — PR #142): `0025` was missing before the push,
`supabase db push --linked` applied it, and **Staging is aligned through migration 0025** (`migration list
--linked` shows staging aligned through `0025`). **The staging apply and verification were human-run; this PR
only records the evidence — the agent did not touch staging and ran no hosted command.**

**The discovery_facts table is present on staging** (its `0025` columns confirmed). **The discovery_facts table
is tenant-scoped and RLS-protected.** Matches the §75 design + T47. **The fact ingestion boundary stages only
safeParse-validated facts. Invalid facts are rejected before persistence. Token-bearing facts are rejected
before persistence. Secret-bearing facts are rejected before persistence. Staged facts are reviewable inputs
for the future resolver.** The staging table exists, but nothing resolves facts into the canonical graph yet.

Local validation before the apply: 384 tests passed; RLS migration tests passed (assertions **458**); lint/
typecheck/build/auth-safety/migration-safety passed; generated database types updated to 1828 lines. RLS suite
unchanged (**458**), no migration, no code, no generated-types change. **The live resolver is not implemented.
No canonical app graph write is implemented. No apps.canonical_app_id write is implemented. No app_alias write
is implemented. No app_user to person match write is implemented. No production migration was run for 0025.
Production is not verified for 0025** (a human applies it to production in a future step). **No app code
changed. No schema changed in this verification PR. No migration changed in this verification PR. No connector
behavior changed. No provider API call was made. No OAuth code was exchanged for tokens. No access token was
stored. No refresh token was stored. No API key was stored. No connector credentials were stored. No connector
secret material was inserted, updated, deleted, or read. No connector sync was implemented. No credential form
was implemented. No connect/reconnect/disconnect action was exposed to users. No browser-accessible
service-role request path was added. No service-role client was added. No production data was touched.
Connector implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API
connector parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is
verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover
remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 77. PRODUCTION VERIFICATION — discovery facts staging `0025` (PR #144)

**Discovery facts staging table is applied and verified on production** (doc 42 §66). A human applied `0025` to
PRODUCTION (`dzbfxulvxchdemcettrx`; staging `ycdpzduxugdsffjqyoai`; local/main `9f4b8b6` — PR #143), then
relinked local back to staging. **The production apply and verification were human-run; this PR only records
the evidence — the agent did not touch production and ran no hosted command.**

- `0025` was MISSING on production before the push; `supabase db push --linked` applied it successfully;
  **Production is aligned through migration 0025** (`migration list --linked` shows production aligned through
  `0025`). **The discovery_facts table is present on production. The discovery_facts table columns are present
  on production** (id, tenant_id, schema_version, fact_type, source_type, source_provider, source_run_id,
  source_record_id, signal_id, natural_key, observed_at, confidence, review_status, reviewed_by, reviewed_at,
  fact_json, provenance_json, rejected_reason, created_at, updated_at). **Staging and production are aligned
  through migration 0025.** Matches the §76 staging verification + T47. **The discovery_facts table is
  tenant-scoped and RLS-protected.**
- **A transient Supabase CLI/login-role 504 occurred during verification and the verification was retried
  successfully** (a transient login-role read; the column verification was retried and returned the full
  column set — no data affected).
- **Local Supabase link was returned to staging after production verification. Final linked ref was
  ycdpzduxugdsffjqyoai.**

**The fact ingestion boundary stages only safeParse-validated facts. Invalid facts are rejected before
persistence. Token-bearing facts are rejected before persistence. Secret-bearing facts are rejected before
persistence. Staged facts are reviewable inputs for the future resolver.** The staging table exists on
production, but nothing resolves facts into the canonical graph yet. RLS suite unchanged (**458**), no
migration, no code, no generated-types change. **The live resolver is not implemented. No canonical app graph
write is implemented. No apps.canonical_app_id write is implemented. No app_alias write is implemented. No
app_user to person match write is implemented. No app code changed. No schema changed in this verification PR.
No migration changed in this verification PR. No connector behavior changed. No provider API call was made. No
OAuth code was exchanged for tokens. No access token was stored. No refresh token was stored. No API key was
stored. No connector credentials were stored. No connector secret material was inserted, updated, deleted, or
read. No connector sync was implemented. No credential form was implemented. No connect/reconnect/disconnect
action was exposed to users. No browser-accessible service-role request path was added. No service-role client
was added. No production data was touched. Connector implementation remains blocked. Old-app parity is not
complete. UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 78. IMPLEMENTATION — discovery fact request adapter (PR #145)

**Discovery fact request adapter is added** (doc 42 §67). `discovery-fact-adapter.ts` is the reviewed
server-only seam wiring the existing pieces — SafeParse contract (#141) → staging helper (#142) → read-only
resolver preview (#140). No migration, no schema change.

- **The adapter stages only SafeParse-validated facts. Invalid facts are rejected before persistence.
  Token-bearing facts are rejected before persistence. Secret-bearing facts are rejected before persistence.
  The adapter uses the authenticated user-scoped/RLS path** (the injected `DiscoveryFactStagingStore`). **No
  service-role client is added. No browser-accessible service-role request path is added. No unauthenticated
  public fact ingestion route is added** — no HTTP route lives here; a future authenticated handler injects the
  store.
- **A read-only resolver preview may be returned. Resolver preview output is not persisted.** It predicts
  action/confidence/reasons in memory from the fact's own content, writes no graph, never auto-assigns, and
  fails closed to `human_review` without a deterministic instance key.

Tested (valid fact stages via mocked authenticated store; invalid/token/secret/wrong-tenant rejected before
store; deterministic instance → read-only preview; ambiguous → human_review; preview persists nothing + no
canonical-graph field; adapter imports only sibling server-only modules — no createClient/service-role/
connector_secrets/fetch/route). No migration, no schema change → RLS suite **458** and generated types **1828**
unchanged. **The live resolver write path is not implemented. No canonical app graph write is implemented. No
apps.canonical_app_id write is implemented. No app_alias write is implemented. No app_user to person match
write is implemented. No provider API call is made. No OAuth code is exchanged for tokens. No access token is
stored. No refresh token is stored. No API key is stored. No connector credentials are stored. No connector
secret material is inserted, updated, deleted, or read. No connector sync is implemented. No credential form is
implemented. No connect/reconnect/disconnect action is exposed to users. No production data was touched. No
hosted commands were run. Connector implementation remains blocked. Old-app parity is not complete. UI/UX
parity is not complete. AI/API connector parity is not complete. Upload is not automatically production-ready.
Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN.
RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 79. IMPLEMENTATION — resolver read path for staged facts (PR #146)

**Resolver read path for staged facts is added** (doc 42 §68). `discovery-fact-read.ts` is a server-only
READ-ONLY preview over already-staged `discovery_facts` rows — wiring the staged table (#142) to the pure
resolver logic (#140). No migration, no schema change.

- **The resolver preview reads staged discovery_facts** through the injected user-scoped (authenticated,
  RLS-enforced) `DiscoveryFactReadStore` — never service-role. Tenant scoping comes from the authenticated
  context + RLS, not a trusted payload tenant_id: the read functions return `[]` WITHOUT querying when there is
  no authenticated tenant.
- **Resolver preview output is read-only. Resolver preview output is not persisted.** The read store has no
  write/update method; the preview updates no review_status and writes no graph. **Unknown or ambiguous staged
  facts route to human_review** (a row with no deterministic instance key, or a malformed `fact_json`, fails
  closed).

Functions: `listStagedDiscoveryFactsForCurrentUser` / `mapDiscoveryFactRowToResolutionInput` /
`previewDiscoveryFactResolutionFromRows` / `previewStagedDiscoveryFacts`. Tested (reads via injected store; no
store call without tenant context; deterministic → preview; ambiguous/malformed → human_review; preview
persists nothing + no canonical-graph field; imports only `./resolution`). No migration, no schema change →
RLS suite **458** (existing T47 covers `discovery_facts` SELECT isolation) and generated types **1828**
unchanged. **The live resolver write path is not implemented. No canonical app graph write is implemented. No
apps.canonical_app_id write is implemented. No app_alias write is implemented. No app_user to person match
write is implemented. No provider API call is made. No OAuth code is exchanged for tokens. No access token is
stored. No refresh token is stored. No API key is stored. No connector credentials are stored. No connector
secret material is inserted, updated, deleted, or read. No connector sync is implemented. No credential form is
implemented. No connect/reconnect/disconnect action is exposed to users. No browser-accessible service-role
request path is added. No production data was touched. No hosted commands were run. Connector implementation
remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not
complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified, but old-app
replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No
doc 17 §5 box is ticked by this PR.
---

## 80. IMPLEMENTATION — deterministic resolver write path (PR #147)

**Deterministic resolver write path is added. This is the first canonical graph mutation path** (doc 42 §69).
Migration `0026` (alias natural key) + `resolver-write.ts` read staged `discovery_facts`, run the pure #140
logic, and write ONLY deterministic outputs.

- **Only deterministic resolver outputs may write. Probabilistic matches do not auto-write. Ambiguous matches
  do not auto-write. Low-confidence matches remain reviewable. False splits are safer than false merges.** A
  missing instance discriminator, a probabilistic/name-only signal, or a conflict → review (never overwrite).
- **Resolver writes are idempotent. Repeated staged fact runs do not create duplicate app_alias rows. Repeated
  staged fact runs do not create duplicate vendor/product/app records. Runners must upsert on natural keys, not
  blindly insert.** (`0026` adds `UNIQUE(tenant_id, alias_type, alias_value)`; vendor/product keys from `0024`.)
  **Arrival order must not change persisted resolver state.**
- **Distinct app instances must not be collapsed into one app row. Jira Flywheel and Jira Perpetua remain
  separate app rows. Slack multi-source facts converge without duplicate aliases when deterministic evidence is
  sufficient. A weak signal followed by deterministic evidence must not create a parallel app.**
- **Unmerge/repoint is modeled for deterministic assignments. Unmerge/repoint does not delete historical users,
  contracts, or invoices** (`revertCanonicalAppAssignment` / `repointAppAlias` repoint only).

The only DB access is the injected user-scoped (RLS) write store — **No service-role client is added**; tenant
scoping is from the authenticated context + RLS. **No app_user to person match write is implemented.** T48
(RLS **458 → 478**; types 1828 0-diff) proves persisted-state idempotency on real Postgres + the Flywheel ≠
Perpetua split + non-destructive unmerge/repoint; helper tests prove deterministic-only/conflict→review/
convergence/order-independence/weak-then-deterministic/tenant-isolation. **No provider API call is made. No
OAuth code is exchanged for tokens. No access token is stored. No refresh token is stored. No API key is
stored. No connector credentials are stored. No connector secret material is inserted, updated, deleted, or
read. No connector sync is implemented. No credential form is implemented. No connect/reconnect/disconnect
action is exposed to users. No browser-accessible service-role request path is added. No production data was
touched. No hosted commands were run. Connector implementation remains blocked. Old-app parity is not complete.
UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 81. STAGING VERIFICATION — resolver natural key `0026` (PR #148)

**Resolver natural-key constraint is applied and verified on staging** (doc 42 §70). A human applied `0026` to
staging (`ycdpzduxugdsffjqyoai`; local/main `99f68ee` — PR #147): `0026` was missing before the push,
`supabase db push --linked` applied it, and **Staging is aligned through migration 0026** (`migration list
--linked` shows staging aligned through `0026`). **The staging apply and verification were human-run; this PR
only records the evidence — the agent did not touch staging and ran no hosted command.**

- **The app_aliases table is present on staging. The app_products table is present on staging. The vendors
  table is present on staging. The discovery_facts table is present on staging.** **The
  app_aliases_tenant_type_value_key constraint is present on staging. The app_aliases natural key is UNIQUE
  (tenant_id, alias_type, alias_value).** Surrounding constraints (alias_type CHECK, review_status CHECK,
  same-tenant app FK, same-tenant product FK) present. **The database enforces tenant-scoped alias idempotency.**
- **The resolver write helper uses the same natural-key model.** **Local persisted-state fixture tests prove
  repeated deterministic resolver runs do not increase vendors, products, or aliases. Deterministic resolver
  writes are idempotent for the staged fixture cases. Probabilistic-only facts do not write canonical graph
  data. Ambiguous/name-only facts do not write canonical graph data. Conflicting canonical assignments are not
  overwritten. Jira Flywheel and Jira Perpetua remain separate app rows. Unmerge/repoint is non-destructive.
  The deterministic resolver write path exists in code.**

Local validation before the apply: 425 tests passed; RLS migration tests passed (assertions **478**); lint/
typecheck/build/auth-safety/migration-safety passed; generated database types remained 1828 lines. RLS suite
unchanged (**478**), no migration, no code, no generated-types change. **The deterministic resolver write path
is not yet verified on production. Production is not verified for 0026. No production migration was run for
0026** (a human applies it to production in a future step). **No app_user to person match write is implemented.
No provider API call was made. No OAuth code was exchanged for tokens. No access token was stored. No refresh
token was stored. No API key was stored. No connector credentials were stored. No connector secret material was
inserted, updated, deleted, or read. No connector sync was implemented. No credential form was implemented. No
connect/reconnect/disconnect action was exposed to users. No browser-accessible service-role request path was
added. No production data was touched. Connector implementation remains blocked. Old-app parity is not complete.
UI/UX parity is not complete. AI/API connector parity is not complete. Upload is not automatically
production-ready. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001
remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.** No doc 17 §5 box is ticked by this PR.
---

## 82. PRODUCTION VERIFICATION — resolver natural key `0026` (PR #149)

**Resolver natural-key constraint is applied and verified on production** (doc 42 §71). A human applied `0026`
to PRODUCTION (`dzbfxulvxchdemcettrx`; staging `ycdpzduxugdsffjqyoai`; local/main `d9b9f5e` — PR #148), then
relinked local back to staging. **The production apply and verification were human-run; this PR only records
the evidence — the agent did not touch production and ran no hosted command.**

- `0026` was MISSING on production before the push; `supabase db push --linked` applied it successfully;
  **Production is aligned through migration 0026** (`migration list --linked` shows production aligned through
  `0026`). **The app_aliases_tenant_type_value_key constraint is present on production. The app_aliases natural
  key is UNIQUE (tenant_id, alias_type, alias_value). The database enforces tenant-scoped alias idempotency on
  production.** **Staging and production are aligned through migration 0026.**
- **Local Supabase link was returned to staging after production verification. Final linked ref was
  ycdpzduxugdsffjqyoai.**
- **The resolver write helper uses the same natural-key model. Local persisted-state fixture tests prove
  repeated deterministic resolver runs do not increase vendors, products, or aliases. Deterministic resolver
  writes are idempotent for the staged fixture cases. This is not a claim that all resolver behavior is
  complete. Probabilistic-only facts do not write canonical graph data. Ambiguous/name-only facts do not write
  canonical graph data. Conflicting canonical assignments are not overwritten. Jira Flywheel and Jira Perpetua
  remain separate app rows. Unmerge/repoint is non-destructive.**

Local validation after the #148 merge: 425 tests passed; RLS migration tests passed (assertions **478**); lint/
typecheck/build/auth-safety/migration-safety passed; generated database types remained 1828 lines. RLS suite
unchanged (**478**), no migration, no code, no generated-types change. **No app_user to person match write is
implemented. No app code changed. No schema changed in this verification PR. No migration changed in this
verification PR. No connector behavior changed. No provider API call was made. No OAuth code was exchanged for
tokens. No access token was stored. No refresh token was stored. No API key was stored. No connector
credentials were stored. No connector secret material was inserted, updated, deleted, or read. No connector
sync was implemented. No credential form was implemented. No connect/reconnect/disconnect action was exposed to
users. No browser-accessible service-role request path was added. No production data was touched. Connector
implementation remains blocked. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector
parity is not complete. Upload is not automatically production-ready. Hosted Auth/tenant-context is verified,
but old-app replacement is not yet verified. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains
BLOCKED.** No doc 17 §5 box is ticked by this PR.
