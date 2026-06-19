# 05 · Engineering Changelog

**Canonical source for: what every PR changed and why.** Engineering/security log — not
product release notes. **Every PR must add an entry** (or justify omission per
[09_DOCS_UPDATE rules in 08](./08_CODE_AND_DOCS_STANDARD.md)). Newest first. Seeded only
from PRs verified via `git log` / `gh pr list`.

---

### PR #77 — Record contract-file attachment staging verification · 2026-06-19
- **Category:** ops evidence — **docs-only.** No src/migration/script/package change; **no hosted command run by this PR; no production/staging mutation; no secrets.** RLS unchanged + stays **222**; no doc 17 §5 box ticked; cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Contract-file attachment UI was manually verified on staging for the tested Tenant A happy path** (PR #76 / roadmap E09a — recorded in [41 §11](./41_FULL_PARITY_IMPLEMENTATION_ROADMAP.md)). A human ran it against the deployed staging app `https://idcaddie-v3.vercel.app` (staging `ycdpzduxugdsffjqyoai`) as the synthetic Tenant A editor `tenant-editor-a@idcaddie-staging.local` on the synthetic contract `cccca111-…a1`. **The test showed contract detail loading, attachment section rendering, PDF upload, file listing, and Open action availability.** The UI did not expose `storage_path` or a signed URL as visible page text; the page clearly states invoices are not shown yet and PDF/AI extraction is not built here.
- **Recorded honestly: Multiple synthetic-test.pdf pending rows were visible because the upload was repeated during testing** — each repeat created another `files` row at `upload_status='pending'` (no UPDATE/DELETE policy on the request path, by `0013` design; a future worker/admin reconciles). **No cleanup was performed by this PR** (this PR does not mutate staging); the synthetic pending rows remain until a human/worker cleans them up.
- **Scope (no overclaim):** verifies only the Tenant A contract-file attachment happy path on staging — not full old-app parity, not AI/PDF extraction, not invoices, not connectors; does not close RISK-001 or approve cutover. **Invoices remain not built. PDF/AI extraction remains not built. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Storage authorization remains necessary but not sufficient for cutover. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. Upload is not automatically production-ready. RISK-001 remains OPEN. Cutover remains BLOCKED.** Updated docs 41 (§11 + E09a note), 09, 00.
- **Validation (local, verified):** `npm test` 76/76; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated`/`pr-review-summary` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on all three scripts OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #76 — Add contract file attachment UI · 2026-06-19
- **Category:** feature (roadmap epic E09a) — **first implementation PR on the verified Storage boundary.** **No migration / no schema change** (reused `files` `0012`–`0015` + the private `contract-files` bucket + the existing RLS/Storage policies + `pdf-validation.ts`); RLS unchanged + stays **222**; `check-auth-safety` green; types 0-diff. **No service-role on any request/browser path; no hosted command; no production/staging mutation; no secrets; no public bucket; no broad/weakened policy.** No doc 17 §5 box ticked; **RISK-001 stays OPEN; cutover BLOCKED.**
- **Contract-file upload/download UI is partially implemented.** The contract detail page (`/contracts/[id]`) now has a **Files / Attachments** section: list existing files, upload a PDF, and open an attached file. Server-side only for every authorization decision:
  - **DAL `src/lib/data/contract-files.ts`** (user-scoped server client, never service-role): `list` (RLS tenant-member SELECT; DTO never exposes `storage_path`/signed URLs), `upload` (validate from **server-measured bytes** via `validateContractPdf` → resolve `tenant_id` **server-side** → **files-row-first** RLS INSERT (`can_write_contract`, `uploaded_by=auth.uid()`, server-derived path `contracts/{tenant_id}/{file_id}.pdf`, `sha256`) → then upload bytes to the private bucket (Storage policy `can_write_contract_file`)), and `getDownloadUrl` (RLS read first, then a **60-second** signed URL — generated only after authorization).
  - **Server actions** `file-actions.ts` (read bytes server-side from `FormData`); **client** `contract-files.tsx` (file-input state + loading/success/validation/failure states; opens the signed URL via `window.open` without rendering it).
- **Security:** cross-tenant denial is enforced by the existing RLS + Storage policies + the same-tenant composite FK (already proven by `org_rls_test.sql` **T34** + the hosted Storage REST verifier 14/14). Added app-layer tests (`contract-files.test.ts`, +9): non-PDF rejected before any DB call; server-derived tenant/path; files-row-first ordering (RLS-denied insert ⇒ no object upload); upload-failure handling; download not_found never signs; signed URL is 60 s; list DTO never leaks `storage_path`. No UPDATE/DELETE policy on the request path ⇒ a failed object upload leaves a `pending` row for a future worker (documented).
- **Storage authorization remains necessary but not sufficient for cutover. Upload is not automatically production-ready. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. RISK-001 remains OPEN. Cutover remains BLOCKED.** Updated docs 41 (E09 progress), 09, 00.
- **Validation (local, verified):** `npm test` **76/76**; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated`/`pr-review-summary` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on all three scripts OK; no `* 2.*`/`* 3.*` strays.

---

### PR #75 — Create full-parity implementation roadmap · 2026-06-19
- **Category:** cutover roadmap — **docs-only.** No src/migration/script/package change; **no hosted command; no production/staging mutation; no secrets.** RLS unchanged + stays **222**; **no doc 17 §5 box ticked; RISK-001 stays OPEN; cutover stays BLOCKED**; no feature built.
- **Adds [41_FULL_PARITY_IMPLEMENTATION_ROADMAP](./41_FULL_PARITY_IMPLEMENTATION_ROADMAP.md)** — sequences the doc 40 code-derived inventory into **27 dependency-ordered epics** (E01 core shell → E02 dashboards → E03/E04 apps/app-users → E05/E06 identity/matching → E07/E08 contracts/steward → E09 files/upload → E10 invoices → E11 spend/license → E12 UAR → E13 imports/exports → E14 reporting → E15 AI (contracts+invoices) → **E16 connector vault** → E17 connector framework → E18 connector providers → E19 SSO/SAML/OIDC → E20 SCIM → E21 admin/groups/permissions → E22 billing → E23 audit viewer → E24 browser extension → E25 migration → E26 rollback → E27 acceptance + doc-17 closure), each with scope · legacy evidence · v3 status · security/RLS/storage/Auth · dependencies · suggested PR range · acceptance criteria · cutover-blocker. Adds **connector waves** (identity/core → collaboration → CRM/support → developer/cloud/security → finance/import → long-tail) over the 52 connectors; a **critical path** (E16 vault → E17 framework → E18 waves is the connector chokepoint; serial cutover tail E25→E26→E27); **parallelizable workstreams** (once shell+RLS+vault exist); a **do-not-build-first** list (no connector before the vault — RISK-007; no reports before data; no migration before targets; no AI auto-apply; no service-role on request paths); **PR-count ranges** (min ~35–55 / realistic ~80–140 / worst ~180–260+); and a **next-10-PRs** sequence (hosted RLS run → files upload → vault → people/matching → contracts field-parity → apps → dashboard → dataset validation → connector framework+Wave 1).
- **This PR creates a full-parity implementation roadmap; it does not implement parity. OMC requires full old-app parity before cutover unless OMC explicitly waives a specific capability. The MVP subset framing is not sufficient for OMC cutover. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Cross-referenced docs 37/38/39/40; updated docs 10, 09, 00.
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated`/`pr-review-summary` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on all three scripts OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #74 — Create code-derived old-app inventory · 2026-06-19
- **Category:** cutover inventory — **docs-only.** No src/migration/script/package change; **no hosted command; no production/staging mutation; no secrets.** RLS unchanged + stays **222**; **no doc 17 §5 box ticked; RISK-001 stays OPEN; cutover stays BLOCKED**; no feature built; nothing inspected live.
- **Adds [40_CODE_DERIVED_OLD_APP_INVENTORY](./40_CODE_DERIVED_OLD_APP_INVENTORY.md)** — built from the **legacy codebase** (read-only, outside this repo: `frontend-v2/`, `webapp/functions/`, `extension/`, `DemoFeatures/`) since the live app is inaccessible. Inventories: **50+ frontend routes** (route/file/area/capabilities/v3-equiv/status/blocker) incl. a custom **dashboards builder**, IDCApps + insights (ELU/stale/UAR), contracts+gantt, files+inbound, invoices, people+risks+settings, company users/**groups**, admin (company/recompute/**sso**/billing), **7 report types**+schedules, logging viewer; **backend functions** by trigger type (callable/HTTP/Firestore/storage/scheduled/auth/SCIM) with data-touched + security-sensitive flags; **52 connectors/scrapers** + `DemoFeatures/IDCIngestor` (auth/token-security → vault prerequisite RISK-007); **AI/document processing** (`processFileWithAI`/`handleDocumentAICompletion`/`checkDocumentAIOperations`/`checkStuckAiProcessing`/`documentPrompts` — contract **and** invoice Doc-AI); **reports/exports** (monthly procurement, cost snapshot, monthly snapshot, user comparison, overlap, license analysis, IT spend, scheduled); and **admin/security/identity** (SSO/SAML/OIDC, SCIM, company users/groups, granular group permissions, billing, API keys/ingestion tokens, audit incl. the legacy 90-day purge, role checks). Each compared to v3 from **repo evidence only** (absent ⇒ Missing; partial foundation ⇒ Partial). Adds **top cutover blockers**, a **likely PR backlog by area**, and a **cannot-determine-without-live-access** section.
- **Honest scope:** **This inventory is derived from the legacy old-app codebase, not live old-app inspection. Live old-app inspection remains incomplete.** No screenshots, no user acceptance, no parity claim. The code reveals a far larger app than prior docs implied (52 connectors, full SSO/SCIM, dashboards builder, 7 reports, billing, Chrome extension) — consistent with doc 38's "dozens of PRs". **OMC requires full old-app parity before cutover unless OMC explicitly waives a specific capability. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Cross-referenced docs 37/38/39; updated docs 10, 09, 00.
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated`/`pr-review-summary` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on all three scripts OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #73 — Prepare old-app direct inspection inventory · 2026-06-18
- **Category:** cutover inspection packet — **docs-only.** No src/migration/script/package change; **no hosted command; no production/staging mutation; no secrets.** RLS unchanged + stays **222**; **no doc 17 §5 box ticked; RISK-001 stays OPEN; cutover stays BLOCKED**; no feature built; nothing inspected live.
- **Adds [39_OLD_APP_DIRECT_INSPECTION_INVENTORY](./39_OLD_APP_DIRECT_INSPECTION_INVENTORY.md)** — turns docs 27/37/38 into a concrete page-by-page / workflow-by-workflow / integration-by-integration **inspection packet**: a **14-field per-screen capture template** (old-app URL · persona · sees · create/edit/delete/export/import · filters/search/sort · empty/loading/error · permissions+tenant-boundary · data shown · AI/API behavior · v3 equivalent · v3 status · cutover-blocker · evidence · PR bucket); a **30-category inventory** covering every full-parity category (UI shell → OMC acceptance), seeded with the **real legacy `frontend-v2/` routes** from `current-product-map.md` + current v3 status; **capture instructions** (screenshots/field names/button labels/import-export formats/AI prompts/connector auth+token-security/role differences — with an explicit **do-not-capture secrets/tokens/credentials/customer-confidential** rule); an **OMC interview script**; a **full-parity gap ledger** (the future build backlog; every row = built-or-OMC-waived); and a **cannot-answer-from-repo-alone** list.
- **Honest status:** the old app is **not present in this repo** (separate Firebase app), so **the inspection packet is PREPARED but nothing was inspected live — direct old-app inspection is still required.** **This PR prepares direct old-app inspection; it does not complete old-app inspection. OMC requires full old-app parity before cutover unless OMC explicitly waives a specific capability. The MVP subset framing is not sufficient for OMC cutover. Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Cross-referenced docs 37 (§7 step 1) and 38 (§7 step 1); updated docs 10, 09, 00.
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated`/`pr-review-summary` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on all three scripts OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #72 — Record OMC full-parity scope decision · 2026-06-18
- **Category:** cutover scope decision — **docs-only.** No src/migration/script/package change; **no hosted command; no production/staging mutation; no secrets.** RLS unchanged + stays **222**; **no doc 17 §5 box ticked (doc 17 untouched); RISK-001 disposition unchanged (stays OPEN); cutover stays BLOCKED**; no feature built; nothing waived.
- **Adds [38_OMC_FULL_PARITY_SCOPE_DECISION](./38_OMC_FULL_PARITY_SCOPE_DECISION.md)** — decision of record resolving the doc 37 §6 MVP-vs-full-replacement tension: **OMC requires full old-app parity before cutover unless OMC explicitly waives a specific capability** (in writing, recorded as `removed-approved`/`deprecated-approved`/`not-used-by-OMC` in doc 27 with OMC signoff). **The MVP subset framing is not sufficient for OMC cutover.** AI, API/SaaS connectors, imports, exports, reporting, dashboards, old-app UI/UX, and all critical old-app workflows are **in scope** (cutover blockers) unless OMC-waived. Sections: the **full-parity cutover rule** (has-it→must-have-it / v3-lacks→blocker / OMC-doesn't-need→explicit-waiver / no implicit deferrals); the **27 required parity categories** with v3 status; an updated **full-parity next-PR sequence** (direct old-app inspection → master matrix → build core → AI/connectors → staging validation → migration/rollback rehearsal → OMC acceptance → checklist closure); and a **realistic PR-count warning** (full parity likely **dozens of PRs**, not the ~25–40 MVP figure — exact count needs direct old-app inspection).
- **Reconciliation (no silent contradiction):** annotated `v3-product-scope.md` as **superseded for cutover** (kept as history); doc 37 §6 tension row marked **RESOLVED** by doc 38; doc 30 §5 records full-parity as the cutover scope. **Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Updated docs 37, 30, 10, 09, 00, v3-product-scope. Doc 04 unchanged (decision tightens scope; does not change RISK-001 disposition).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated`/`pr-review-summary` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on all three scripts OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #71 — Audit existing parity documentation · 2026-06-18
- **Category:** cutover stocktake — **docs-only.** No src/migration/script/package change; **no hosted command; no production/staging mutation; no secrets.** RLS unchanged + stays **222**; **no doc 17 §5 box ticked (doc 17 untouched); RISK-001 disposition unchanged (stays OPEN); cutover stays BLOCKED**; no feature built.
- **Adds [37_EXISTING_PARITY_DOCS_AUDIT](./37_EXISTING_PARITY_DOCS_AUDIT.md)** — a pre-plan audit of all parity/cutover/readiness docs. Measured scale: **doc 17 §5 = 0/17 boxes ticked; doc 27 ≈ 111 `missing` / 58 `partial` / 67 `blocked` / ~11 `complete`+`deprecated-approved`.** Sections: (2) per-doc summary table (docs 11–36 + legacy lowercase: covers/current/type/executed/depends-future/RISK-001/parity); (3) **completed evidence** — staging+production Storage REST **14/14** (docs 25/29 → RISK-001 criteria 1–4), hosted Auth+tenant-context **PASSED** (doc 31 §7, advances §5 box 6), Auth cleanup (§8), built read/write surfaces (local 222), RLS unsafe-run gate prepared (doc 30 §6); (4) **planned-not-executed** — docs 32/33/34/35/36 + doc 18 confirmation pass + doc 19 vault + doc 16 PDF/AI + the RLS disposable-isolated run; (5) **missing/under-specified** parity areas mapped to the legacy feature list (dashboard, people/identity/UAR, file upload/AI, license/spend, imports/exports/reporting, connectors/vault, admin/audit-viewer); (6) **docs-drift/overlap** — parity tracked in 5 places (→ 27/17/33 canonical), MVP-scope-vs-full-replacement tension, restated RISK-001 narrative (→ doc 04 canonical); (7) a realistic **next-PR sequence** (OMC confirmation pass first to size scope); (8) **bottom-line**.
- **Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified. This PR audits existing parity documentation; it does not implement parity. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Updated docs 10 (index), 09 (handoff), 00 (status). Doc 04 left unchanged (audit clarifies but does not change RISK-001 disposition).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated`/`pr-review-summary` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on all three scripts OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #70 — Prepare hosted staging RLS verification runner · 2026-06-18
- **Category:** ops tooling — **script + docs only.** No src/migration/package change; **no hosted command run by this PR; no production/staging mutation; no secrets.** RLS unchanged + stays **222**; no doc 17 §5 box ticked; cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Adds `scripts/verify-staging-rls-suite.mjs`** — a staging-ref-guarded gate for the remaining doc 17 §5 boxes 5/8 sub-task (full `org_rls_test.sql` re-run against hosted). **Analysis:** the local suite's fixture setup is destructive (`truncate table` 17 core tables **incl. `public.audit_logs` restart identity cascade**, `delete from auth.users`, ~116 INSERT/~77 UPDATE/~70 DELETE, `set role`); `test-rls.sh` relies on a **disposable container**, not rollback. **Hosted staging RLS execution is prepared but not yet run. Raw `org_rls_test.sql` must not be run directly against hosted staging unless wrapped in a proven rollback-only, staging-ref-guarded runner** — and even rollback-only against the shared staging project is unsafe (`TRUNCATE` of `audit_logs` fires a statement-level event the row-level `reject_audit_mutation()` does not cover → would wipe append-only audit history; `delete from auth.users` touches the managed auth schema; ACCESS EXCLUSIVE locks on 17 live tables).
- **The runner:** hard-refuses unless linked ref is staging `ycdpzduxugdsffjqyoai`; hard-refuses if linked ref is production `dzbfxulvxchdemcettrx`; **detects the destructive statements and refuses the raw run against the shared staging project**. The script **connects to nothing** — even the explicit `RLS_RUN_TARGET=disposable-isolated` opt-in only **emits a rollback-only runbook** (snapshot key-table counts → `begin … rollback` → prove post==pre counts incl. `audit_logs` → dispose) for a human to run against a **separate disposable** project (never the shared staging project, never production). It handles no connection string and **prints no secrets/URLs** (a deliberate choice after adversarial review flagged an argv/stack secret-leak and a URL-spelling-not-identity guard on an in-script execution path). Safe alternate: a dedicated disposable Supabase project / branch DB. **Production must not be touched.**
- **No production project was touched. No secrets recorded.** This PR prepares the runner; it does not run it against hosted. **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Updated docs 30 (§6 analysis + runner), 31 (cross-ref), 04 (RISK-001 context), 09 (handoff), 00 (status).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on all three scripts OK; gate run locally → **REFUSE (exit 1)**, no hosted connection; no `* 2.*`/`* 3.*` strays.

---

### PR #69 — Record staging Auth tenant-context cleanup evidence · 2026-06-18
- **Category:** ops evidence — **docs-only.** No code/migration/script/src/package change; **no hosted command run by this PR; no production/staging mutation; no secrets.** RLS unchanged + stays **222**; no doc 17 §5 box ticked (doc 17 untouched); cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Hosted staging Auth tenant-context cleanup/disposition recorded** ([31 §8](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)): after the §7 verifier passed 8/8 + manual Tenant A/B, a human attempted cleanup of the synthetic staging fixtures. **Synthetic tenant/org access was removed** — `tenant_memberships`=0, `organization_memberships`=0 for the two synthetic users (no tenant/org access through the app). **Two synthetic profiles, two synthetic tenants, and two synthetic Auth users remain as audit anchors**, with **1** `audit_logs` row retained.
- **Audit log immutability prevented destructive cleanup and is working as intended** — deleting the linked `profiles`/Auth users (or the tenants) would attempt to mutate the append-only `audit_logs.actor_user_id`, which `reject_audit_mutation()` (`0002`) blocks; so the anchor rows are intentionally retained (mirrors the production cleanup posture, doc 29 §6).
- **No production project was touched. No service-role key was used. No secrets, passwords, anon keys, cookies, JWTs, or tokens are recorded.** This cleanup evidence does not approve cutover. **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Updated docs 31 (§8 + banner), 04 (RISK-001 context), 09 (handoff), 00 (status).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on both verifiers OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #68 — Record hosted staging Auth + tenant-context evidence · 2026-06-18
- **Category:** ops evidence — **docs-only.** No code/migration/script/src/package change; **no hosted command run by this PR; no production/staging mutation; no secrets.** RLS unchanged + stays **222**; no doc 17 §5 box ticked (doc 17 untouched); cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Hosted staging Auth + tenant-context verification PASSED** (blocker-sequence item #1 executed by a human — [31 §7](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)). **The deployed staging app `https://idcaddie-v3.vercel.app` was verified after Vercel env vars were corrected and redeployed:** the first app checks returned `GET /login`/`/`/`/logout` = **500** with runtime logs showing missing `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`; after the env was set to staging (`NEXT_PUBLIC_SUPABASE_URL` → `https://ycdpzduxugdsffjqyoai.supabase.co`; the staging publishable anon key — **no key value recorded**) and redeployed, `GET /login` = **200**, `GET /` = **307 → /login**, `GET /logout` = **303 → /login**.
- **`node scripts/verify-staging-auth-tenant-context.mjs` → 8/8 PASS** (A1 protected-redirect, A2 public-login, A3 logout-redirect, R1 login, R2 `role=authenticated` not `service_role`, R3 tenant-context resolves, R4 cross-tenant denied, R5 no `public.files` grant divergence). **The verifier used real hosted Supabase Auth with user-scoped JWTs; no service-role key was used by the verifier.** **Manual browser checks passed for Tenant A and Tenant B** (synthetic `@idcaddie-staging.local` users; tenant A shows tenant A only, tenant B shows tenant B only; no cross-tenant data; `/`, `/apps`, `/contracts` render after login; logout → `/login`). Synthetic fixture: 2 users / 2 tenants / 2 profiles / 2 memberships / 0 cross-org memberships.
- **No secrets, passwords, anon keys, cookies, JWTs, or tokens are recorded. No production project was touched.** This evidence advances doc 17 §5 boxes 5/6/8 only; the full RLS-suite-on-hosted re-run + OMC-shaped dataset/critical-flow validation + the remaining boxes are still open. **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Updated docs 31 (§7 + banner), 04 (RISK-001 criterion 5 context), 09 (handoff), 00 (status), 10 (index).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on both verifiers OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #67 — Document OMC acceptance signoff plan · 2026-06-18
- **Category:** cutover planning — **docs-only.** No acceptance/signoff recorded; no code/migration/script/test/env/package change; **no hosted command; no staging/production mutation; no real OMC data; no secrets.** RLS unchanged + stays **222**; no doc 17 §5 box ticked; cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Adds [36_OMC_ACCEPTANCE_SIGNOFF_PLAN](./36_OMC_ACCEPTANCE_SIGNOFF_PLAN.md)** for blocker-sequence item #6, the **final** item (doc 17 §5 box 17): defines OMC acceptance (the paying customer's go decision on top of a satisfied gate — full parity or explicitly-approved removals; the **last** box, not a shortcut); the **8 signoff domains**; **signers by role** (cutover commander · DBA · platform/Vercel owner · security owner [veto] · OMC owner · executive — no invented names; engineering does not self-accept; no agent signs); the **required evidence package** (doc 17 §5 checklist + doc 27 matrix + hosted Auth verification + dataset validation + migration reconciliation + rollback rehearsal + security/RLS + production-readiness); the **4 acceptance outcomes** (accept / accept-with-approved-removals / reject / defer); how **approved removals/deprecations** are recorded via the doc 27/17 `removed-approved`/`deprecated-approved`/`not-used-by-OMC` taxonomy with OMC approval + rationale (so "not built" never silently becomes accepted); the signoff format/location (`docs/evidence/`, no secrets, no real data); and the **hard rules** (no signoff on local-only tests / without hosted staging validation / without migration rehearsal / without rollback rehearsal / without P0-blocker disposition).
- **OMC acceptance/signoff plan is prepared, not executed.** **No OMC acceptance or signoff is recorded by this PR. No production project was touched. No staging data was mutated by this PR. No real OMC customer data is included. No secrets, passwords, anon keys, cookies, or JWTs are recorded. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** With this, all six doc 17 blocker-sequence items (#1–#6) now exist as prepared plans; the hosted runs, feature builds, rehearsals, and the actual acceptance remain human-executed. Updated docs 30 (item #6 → prepared), 10 (index), 09 (handoff), 00 (status).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on both verifiers OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #66 — Document cutover rollback rehearsal plan · 2026-06-18
- **Category:** cutover planning — **docs-only.** No rollback rehearsed; no code/migration/script/test/env/package change; **no DNS/Vercel/GitHub/Auth/Storage/DB change; no hosted command; no staging/production mutation; no real OMC data; no secrets.** RLS unchanged + stays **222**; no doc 17 §5 box ticked; cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Adds [35_CUTOVER_ROLLBACK_REHEARSAL_PLAN](./35_CUTOVER_ROLLBACK_REHEARSAL_PLAN.md)** for blocker-sequence item #5 (doc 17 §5 box 15): defines **rollback** for v3 replacing the **live** OMC app (return OMC to system-of-record, no data loss, bounded window; clean vs dirty rollback; point-of-no-return); the **8 rollback domains** (DNS/routing/Vercel · Supabase DB restore/PITR · Storage object preservation · Auth/session · legacy OMC freeze/unfreeze · migration replay-prevention via the idempotent legacy-id→v3-id mapping · customer comms · monitoring/incident); the **6 staging rehearsal phases** (tabletop → synthetic dry-run → Vercel preview/staging rollback sim → data restore sim → migration replay/idempotency rehearsal → evidence); the **7 production rollback triggers** (auth/session, tenant-isolation, data-count mismatch, file-access, RLS regression, performance, customer blocker); **hard-stop rules + named decision owners + PONR**; and the **box-15 evidence**.
- **Cutover rollback rehearsal plan is prepared, not executed.** **No rollback was rehearsed by this PR. No production project was touched. No staging data was mutated by this PR. No real OMC customer data is included. No secrets, passwords, anon keys, cookies, or JWTs are recorded. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Notes that post-cutover monitoring (a trigger-detection prerequisite) is still not built (doc 17 §3). Updated docs 30 (item #5 → prepared), 10 (index), 09 (handoff), 00 (status).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on both verifiers OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #65 — Document OMC legacy data migration plan · 2026-06-18
- **Category:** cutover planning — **docs-only.** No migration tooling added; no code/migration/script/test/env/package change; **no hosted command, no staging/production mutation, no real OMC data, no secrets.** RLS unchanged + stays **222**; no doc 17 §5 box ticked; cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Adds [34_OMC_LEGACY_DATA_MIGRATION_PLAN](./34_OMC_LEGACY_DATA_MIGRATION_PLAN.md)** for blocker-sequence item #4 (doc 17 §5 box 16 / §3 data-migration blocker): the legacy OMC sources (tenants/orgs/users/memberships/apps/contracts/links/app-users/people/identity/invoices/license/files+bytes/audit/settings/connectors) → v3 targets (the 17 tables; Auth users → Supabase Auth + `profiles`); the **blocked-until-built** set (migrate only built+verified surfaces — doc 33; file **bytes** gated on the upload path T3; **connector secrets never migrated** — RISK-007; never via `local_demo.sql` — RISK-015); 8 phases (discovery → mapping → dry-run transform → staging load → reconciliation → rollback rehearsal → production window → post-cutover); reconciliation checks (row counts by tenant/object, referential + same-tenant-FK integrity, **file byte counts + `sha256` checksum**, relationship counts, RLS spot checks, audit/history preservation); non-destructive rules (preview-before-overwrite, idempotent upserts, tenant-scoped boundaries, staged review, rollback); security/privacy (no secrets, no real data in repo, encrypted/time-boxed exports, least-privilege loader as an isolated out-of-request job — no service-role on a request path, migration audit trail); named tooling PRs (export/inventory, transform/mapping, staging-loader+reconciliation, rollback — **not created**); and the evidence required before box 16.
- **OMC legacy data migration plan is prepared, not executed.** **No production project was touched. No staging data was mutated by this PR. No real OMC customer data is included. No secrets, passwords, anon keys, cookies, or JWTs are recorded. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Updated docs 30 (item #4 → prepared), 10 (index), 09 (handoff), 00 (status).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on both verifiers OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #64 — Document required-workflow parity build plan · 2026-06-18
- **Category:** cutover planning — **docs-only.** No implementation added; no code/route/component/server-action/DAL/migration/script/test/env/package change; **no hosted command, no staging/production mutation, no secrets.** RLS unchanged + stays **222**; no doc 17 §5 box ticked; cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Adds [33_REQUIRED_WORKFLOW_PARITY_BUILD_PLAN](./33_REQUIRED_WORKFLOW_PARITY_BUILD_PLAN.md)** for blocker-sequence item #3: turns the doc 27 matrix (~169 `missing`/`partial` + `blocked` gap rows) into a ranked, buildable plan. **9 implementation tracks** (T1 auth/session/tenant-context · T2 contracts · T3 files/upload/signed-URLs/PDF · T4 apps/app-contract links · T5 app-users/identity/people · T6 invoices/spend/license · T7 reporting/export/import · T8 admin/settings/audit/ops · T9 connectors/secrets/vault), **P0/P1/P2 ranking**, per-P0 detail (current evidence · why it blocks doc 17 · impl work · RLS/security work · tests · hosted staging validation · evidence-before-done), an explicit **built-but-unverified vs not-built** separation table, and the **next 3 implementation PRs** (contract-file upload action + signed-URL read; files list/detail/preview; contract field-parity + app-contract link/unlink write — gated on items #1/#2 executed green).
- **Required-workflow parity build plan is prepared, not implemented.** **No production project was touched. No staging data was mutated by this PR. No secrets, passwords, anon keys, cookies, or JWTs are recorded. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Each future implementation PR must cite its doc 27 row(s), carry RLS tests + hosted staging validation + recorded evidence, and tick no §5 box on its own. Updated docs 30 (item #3 → prepared), 10 (index), 09 (handoff), 00 (status).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on both verifiers OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #63 — Prepare OMC-shaped staging dataset + critical-workflow validation · 2026-06-18
- **Category:** cutover planning — **docs-only runbook.** No code, migration, script, env, or hosted command; **no staging data mutated; no seed run; no Auth users/fixtures created; no production touched; no secrets.** RLS unchanged + stays **222**; no doc 17 §5 box ticked; cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Adds [32_STAGING_OMC_SHAPED_DATASET_AND_CRITICAL_FLOW_VALIDATION](./32_STAGING_OMC_SHAPED_DATASET_AND_CRITICAL_FLOW_VALIDATION.md)** for blocker-sequence item #2 (doc 17 §5 boxes 7/9, feeds 8): defines the synthetic **OMC-shaped** dataset (minimum entities per table → the surface each exercises → doc 27 rows + §5 boxes), the **implemented vs not-built/partial** workflow split, the critical-workflow validation steps **for currently-implemented surfaces only** (apps/contracts read, contract create/edit with `0004` authority + `0010` audit, link panels, app-user roster + match-status, org-scoped reads, cross-tenant isolation), RLS/tenant-isolation expectations, human setup/cleanup, and a **review-and-apply SQL template**.
- **Not-built flows (file upload/AI/imports/connectors/license/invoices/reporting/billing/link-unlink-write/UAR/people/admin/audit-UI) are recorded as `not-built` BLOCKERS, NOT validation failures** — a flow that does not exist cannot fail validation; its doc 27 row + §5 box stay open until built.
- **Runbook only — no committed runnable seed.** A bare staging-seed `.sql` has no runtime project guard (unlike the throwaway-container `seed-local-demo.sh` or the ref-guarded `.mjs` verifiers), so the seed is a template a human reviews + applies deliberately in the staging SQL editor after confirming the project ref (the hosted seed/runbook RISK-015 flagged to revisit — separate from `local_demo.sql`, which must never be hosted-applied). A flows `.mjs` was deemed premature (dataset not loaded; the item-#1 verifier already covers the hosted Auth/RLS layer).
- **OMC-shaped staging dataset and critical-workflow validation are prepared, not executed.** **No production project was touched. No staging data was mutated by this PR. No secrets, passwords, anon keys, cookies, or JWTs are recorded. RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Updated docs 30 (item #2 → prepared), 10 (index), 09 (handoff), 00 (status).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on both verifiers OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #62 — Prepare hosted staging Auth + tenant-context verification · 2026-06-18
- **Category:** tooling + runbook — **prepares** blocker-sequence item #1 (doc 17 §5 boxes 5/6/8). No migration, no Storage policy, no app/route/UI change, no env/hosted command, **no production touch, no secrets.** RLS stays **222**; cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Adds `scripts/verify-staging-auth-tenant-context.mjs`** — a **staging-only, user-scoped** verifier (anon-key-only, **no service-role**) that exercises real hosted Supabase Auth + RLS for synthetic staging users and the deployed staging app's routing. Automated checks: deployed app wired to staging-not-production (A1); protected page redirects unauth → `/login` (A2); public `/login` reachable (A3); `/logout` redirects (A4); login succeeds on hosted Auth (R1); issued JWT is `role=authenticated` not `service_role` (R2); tenant context resolves to the correct tenant (R3); cross-tenant access denied (R4); **hosted RLS/privilege divergence probe — no `public.files` grant gap (the `0015` lesson) (R5)**. **Refuses unless linked ref + `STAGING_SUPABASE_URL` are staging `ycdpzduxugdsffjqyoai` (errors on the production ref); requires `STAGING_SUPABASE_URL`/`STAGING_SUPABASE_ANON_KEY`/`STAGING_AUTH_TEST_USERS`/`STAGING_APP_URL` from local env; prints no tokens/passwords/cookies/JWTs/anon keys; exits non-zero on any failure.**
- **Adds [31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)** — the full plan (the 9 obligations), the verifier how-to + env-var names, the **manual/browser** steps for the app-session UI checks (authenticated-page reach + tenant render — not faithfully scriptable without `@supabase/ssr` cookie internals), the one-time **human** synthetic-user setup, and the no-secrets evidence template.
- **Hosted staging Auth + tenant-context verification is prepared, not executed.** **No production project was touched. No secrets, passwords, anon keys, cookies, or JWTs are recorded.** The verifier was NOT run (it correctly refuses without the staging env). **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for cutover.**
- **Updated** docs 30 (item #1 → prepared), 10 (index), 09 (handoff), 00 (status).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check` on both verifiers OK + the new verifier fail-loud (exit 2) verified; no `* 2.*`/`* 3.*` strays.

---

### PR #61 — Document doc 17 cutover blocker sequence · 2026-06-18
- **Category:** cutover planning — **docs-only blocker sequencing.** No code, migration, script, env, or hosted command; **no production/staging commands run;** no cutover executed. RLS stays **222**; cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Adds [30_DOC17_CUTOVER_BLOCKER_SEQUENCE](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md)** — a ranked sequence of the remaining [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) cutover blockers, bucketed into product/code · hosted-staging-verification · data-migration/OMC-parity · security/privacy · operational · customer/OMC-signoff, with the **next 3 PRs** before any cutover talk (1: hosted staging Auth + full RLS-suite-on-hosted verification, boxes 5/6/8; 2: OMC-shaped dataset + critical-workflow validation plan, boxes 7/9; 3: required-workflow parity build plan from doc 27, boxes 1/2).
- **The `contract-files` Storage path is marked COMPLETE but NOT sufficient for cutover** — it closes only the Storage authorization boundary (1 box's worth); **16 of 17 doc 17 §5 boxes remain unmet.** **RISK-001 remains OPEN** unless every documented closure criterion is satisfied (criterion 5 — the doc 17 §5 checklist — is not). **Cutover remains BLOCKED. Upload is not automatically production-ready.**
- **Updated** docs 10 (index), 09 (handoff pointer), 00 (status pointer).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check scripts/verify-production-storage-rest.mjs` OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #60 — Doc 17 cutover readiness review — refresh stale Storage status in the cutover docs · 2026-06-18
- **Category:** cutover-doc accuracy — **docs-only.** No code/migration/script/src/Supabase/Vercel/secret change; **no cutover executed; no production or staging mutation.** RLS stays **222**; cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Outcome of the doc 17 readiness review: cutover is a hard NO — all 17 doc 17 §5 go/no-go boxes remain unchecked.** Only the `contract-files` Storage boundary is hosted-applied + REST-verified (staging + production, 14/14); the broad cutover criteria (full RLS suite re-run against hosted Auth, Vercel-auth-tested, OMC-shaped dataset + critical-flow validation, files/AI/imports/connectors/license/invoices/reporting/billing/UAR/admin/audit-UI surfaces, data-migration plan, rehearsed rollback, OMC signoff) are **not met**. **No §5 box was ticked by this PR.**
- **Refreshed only the now-stale Storage status statements** the paper-trail had overtaken: doc 17 §3 (the "never applied to hosted Supabase" / "no staging verification" ops bullets → now "Storage path applied + REST-verified in staging+prod; RISK-001 materially reduced but OPEN; broad RLS-suite-on-hosted + Vercel-auth-tested + the rest still blocking"), and doc 27 (the readiness-assessment lines + 4 Track H rows that said "REST verify pending" → "PASSED 14/14 staging+prod"). The matrix stays mostly `missing`/`blocked`; RISK-001 stays OPEN.
- **RISK-001 remains OPEN unless every documented closure criterion is satisfied** — criteria (1)–(4) are met, but **(5) the doc 17 §5 cutover checklist is NOT** (17 unchecked boxes), so it is **not** closed. **Cutover remains BLOCKED unless doc 17 is fully satisfied. Upload is not automatically production-ready. No production mutation was performed.**
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check scripts/verify-production-storage-rest.mjs` OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #59 — Record production synthetic cleanup evidence · 2026-06-18
- **Category:** evidence — **docs-only.** No code, migration, script, src, Supabase policy, or generated-type change; **no hosted command run by this PR; no production mutation; no secrets.** RLS stays **222**; migrations stay **0001–0015**; cutover stays **BLOCKED**.
- **Records the production synthetic cleanup** (human-executed after the §4 production REST verification) in [29 §6](./29_PRODUCTION_STORAGE_APPLY_EVIDENCE.md). **Production synthetic cleanup completed. Synthetic Storage objects, Auth users, and business rows were removed.** Cleanup verification counts: `storage.objects`=0 (removed via the **safe Storage path**, not a direct `delete from storage.objects`), `files`=0, `contracts`=0, `organizations`=0, `organization_memberships`=0, `tenant_memberships`=0, `profiles`=0, synthetic Auth users=0; retained `retained_audit_anchor_tenants`=2, `audit_logs_for_synthetic_tenants`=3.
- **No synthetic Auth users remain. No synthetic Storage objects remain.** **Two synthetic tenant rows remain as audit anchors because `audit_logs` is append-only** — `audit_logs` DELETE is blocked by `reject_audit_mutation()` (migration `0002`), so the 3 audit rows can't be deleted and their 2 parent tenants are retained as anchors; the retained tenants are not active test users and are not tied to any remaining synthetic membership/file/contract/organization/Auth user (all 0). **No secrets, passwords, anon keys, or JWTs are recorded.**
- **Risk:** RISK-001 **may be materially reduced** by production apply + production verification + migration `0015` + this cleanup evidence, but **RISK-001 remains OPEN because the doc 17 §5 cutover checklist is still incomplete** (17 unchecked boxes — the only remaining closure criterion). Not marked closed; the risk register does not define all criteria as satisfied. **Production apply and verification do not approve cutover by themselves. Cutover remains BLOCKED until the doc 17 cutover checklist passes. Upload is not automatically production-ready.**
- **Updated** docs 04 (RISK-001 — cleanup recorded, materially reduced, stays OPEN), 09 (handoff), 00 (status), 10 (doc 29 index row).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` 0-diff; `node --check scripts/verify-production-storage-rest.mjs` OK; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #58 — Record production Storage REST verification evidence · 2026-06-18
- **Category:** evidence + schema codification. Adds **migration `0015`** + production evidence docs. **No hosted command run by this PR, no production mutation, no Storage policy change, no secrets.** RLS stays **222**; cutover stays **BLOCKED**; **RISK-001 stays OPEN** (closure criterion 5 unmet).
- **Records the human-executed PRODUCTION apply + verification** ([29_PRODUCTION_STORAGE_APPLY_EVIDENCE](./29_PRODUCTION_STORAGE_APPLY_EVIDENCE.md)): production `dzbfxulvxchdemcettrx` migrations `0001`–`0014` applied; private `contract-files` bucket (`public=false`, `file_size_limit=26214400`, `allowed_mime_types=[application/pdf]`); exactly 2 `{authenticated}` `storage.objects` policies (INSERT + SELECT), **0 unsafe**; 6 synthetic `@idcaddie-production.local` users + synthetic fixtures (tenants=2/profiles=6/tenant_memberships=3/orgs=5/org_memberships=3/contracts=3/files=0). **Production Storage REST authorization verification PASSED 14/14** via `scripts/verify-production-storage-rest.mjs`. **The production verifier used real Supabase Storage REST API calls with user-scoped JWTs; no service-role key was used by the verifier; no secrets, passwords, anon keys, or JWTs are recorded.**
- **Adds migration `0015_files_authenticated_grants.sql`** codifying the production-discovered grant `grant select, insert on public.files to authenticated` (idempotent). RLS gates which rows; the role still needs base SELECT/INSERT privilege — the local `test-rls.sh` harness masked the gap with a broad blanket grant, hosted production did not have it, so the verifier initially failed until the human applied it. Scope is minimal: **SELECT + INSERT only** (mirrors `0013`; no UPDATE/DELETE policy ⇒ no UPDATE/DELETE grant), **`authenticated` only** — **no `anon`, no `service_role`, not broadened, Storage policies untouched.** `test-rls.sh` still **222**; `gen-types` 0-diff (grants don't change types).
- **RISK-001 remains OPEN** — criteria (1)–(4) (staging apply + staging verify + production apply + production verify + evidence recorded) are now satisfied, but **(5) the [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) cutover checklist is NOT satisfied**, so the risk register does not state every closure criterion is met. **Production apply and verification do not approve cutover by themselves. Cutover remains BLOCKED until the doc 17 cutover checklist passes. Upload is not automatically production-ready.**
- **Updated** docs 04 (RISK-001 criteria 3/4 → DONE, stays OPEN), 28 (executed banner → doc 29), 09 (handoff), 00 (status), 10 (index: doc 29).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222** (now `0001`–`0015`); `gen-types-local.sh` 0-diff; `node --check scripts/verify-production-storage-rest.mjs` OK; no `* 2.*`/`* 3.*` strays.

---

### PR #57 — Add production Storage REST verifier · 2026-06-18
- **Category:** tooling — adds a **production-targeted** verifier (no migration, no Storage policy, no app/route/UI, no hosted mutation, no production touch, no secrets). RLS stays **222**; migrations stay **0001–0014**; cutover stays **BLOCKED**; **RISK-001 stays OPEN**.
- **Adds `scripts/verify-production-storage-rest.mjs`** — derived from `scripts/verify-staging-storage-rest.mjs` with **inverted, production-specific guardrails**: required linked ref `dzbfxulvxchdemcettrx`; **refuses** if the linked ref or URL is the staging ref `ycdpzduxugdsffjqyoai`; required `PRODUCTION_SUPABASE_URL` must include `dzbfxulvxchdemcettrx`; env vars `PRODUCTION_SUPABASE_URL` / `PRODUCTION_SUPABASE_ANON_KEY` / `PRODUCTION_STORAGE_TEST_USERS` (local only). It runs the **same 14 REST authorization checks** as staging (the check bodies are byte-identical), reuses the same synthetic fixture constants, prints clear PASS/FAIL, **exits non-zero on any failure**, reminds that check 15 is local `scripts/test-rls.sh` (not a REST check), and states a green run does **not** close RISK-001 or approve cutover.
- **User-scoped only — no service-role key in the verifier** (the production admin fixture is the separate doc 28 §H step). **Prints no tokens/passwords/anon keys/JWTs; fails loud** (exit 2) on a non-production link or missing/malformed env.
- **The verifier was NOT run** (the current link is staging; running it requires an approved production window + a production link). **No production mutation, no production apply, no production verification, no production synthetic users created, no secrets committed.** Production REST verification remains **PENDING**.
- **Updated** docs 28 §9 (points at the production verifier + its env vars; do not weaken the staging guard), 26 (cross-references the production variant), 04 (RISK-001 criterion 3: verifier exists, still NOT executed), 09 (handoff), 00 (status bookkeeping).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` no diff; `node --check` on the verifier OK + fail-loud (exit 2) verified; no `* 2.*`/`* 3.*` strays.

---

### PR #56 — Document contract-files production Storage apply runbook · 2026-06-18
- **Category:** ops runbook — **docs-only.** No app code, migration, script, test, generated-type, package, Supabase/Vercel config, or env change; **no hosted Supabase mutation; no production touch; no secrets.** RLS stays **222**; migrations stay **0001–0014**; cutover stays **BLOCKED**; RISK-001 stays **OPEN**.
- **Adds [28_PRODUCTION_STORAGE_APPLY_RUNBOOK](./28_PRODUCTION_STORAGE_APPLY_RUNBOOK.md)** — the exact reviewed, human-executed steps to apply + verify the private `contract-files` bucket + `storage.objects` policies in **production** (`dzbfxulvxchdemcettrx`), mirroring the verified staging apply ([22](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md)/[26](./26_STORAGE_REST_VERIFICATION_RUNBOOK.md)). 12 sections: production preflight; confirm-linked-project-is-production-only-when-intentionally-applying (+ re-link back to staging after); confirm staging evidence (PR #55) is green/recorded; production bucket create/verify (`public=false`, 25 MiB, `application/pdf`); production migration status through `0014`; helper-function verification; the production object-policy apply plan (same 2 `authenticated` INSERT/SELECT, 0 unsafe); structural verification; production Storage REST authorization verification plan (14/14, user-scoped JWTs, no service-role, synthetic data); stop/rollback rules; evidence-recording requirements; and that the doc 17 cutover checklist remains separate + required.
- **`production apply is not executed by this PR`** — it is a runbook a human follows later under explicit approval; an agent never executes a production apply/`db push --linked`/bucket-or-policy creation/the production verifier. **No production mutation in this PR; no secrets are recorded.**
- **`RISK-001 remains OPEN until production apply, production verification, and the doc 17 cutover checklist pass`** — staging is verified (PR #55), production is not. **`cutover remains BLOCKED`.** v3 is not production-ready, not upload-ready, not OMC-replacement-complete.
- **Updated** docs 04 (RISK-001 criteria 3/4 reference the production runbook, still pending), 09 (handoff), 00 (status), 10 (index), 22 (§8 points production promotion at doc 28).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` no diff; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #55 — Record passed staging Storage REST authorization verification · 2026-06-18
- **Category:** ops evidence — **docs-only.** No app code, migration, test, generated-type, package, Supabase/Vercel config, env, script, or workflow change; **no hosted Supabase mutation** in this PR; production untouched; no secrets. RLS stays **222**; migrations stay **0001–0014**; cutover stays **BLOCKED**.
- **Storage REST API authorization verification PASSED in hosted staging** ([25 §0.3](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md)): a human ran `node scripts/verify-staging-storage-rest.mjs` against the **staging** project `ycdpzduxugdsffjqyoai` → **14/14 REST checks passed** + the check-12 path-shape self-test; **check 15** = local `scripts/test-rls.sh` → **222** (re-run 2026-06-18). The verifier used **real Supabase Storage REST API calls with user-scoped JWTs**; **no service-role key was used by the verifier; no production project was touched; no secrets/passwords/anon keys/JWTs are recorded.**
- Verified obligations: tenant-editor own-prefix upload (+ cross-tenant deny); procurement-org manager allowed only where contract-write authority exists; paying-org/viewer/cross-org **denied**; tenant A↔B read/list/sign isolation; anon GET denied; upsert/move/copy/delete denied; signed URL single-object scoped (60s `expiresIn`); bad/traversal paths fail closed; `files` row as source of truth.
- **RISK-001 remains OPEN** — the existing risk register does **not** allow staging verification alone to close it: criteria (1) policies applied + (2) REST verification are now ✅, but (3) the **production apply** and (5) the [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) cutover checklist are still pending. **Cutover remains BLOCKED. Upload implementation is NOT automatically production-ready** (no upload route/action/UI, signed-URL route, or AI extraction shipped). Updated docs 25/26/04/09/00 (+ this entry); doc 10 index row for doc 26 refreshed (verifier run, passed).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` no diff; no `* 2.*`/`* 3.*` strays. Docs-only.

---

### PR #54 — Document full OMC legacy parity matrix · 2026-06-17
- **Category:** cutover-control docs — **docs-only.** No app code, route, component, server action, DAL, test, migration, generated-type, package, Supabase/Vercel config, env, script, or workflow change. **No hosted Supabase mutation; production untouched; no secrets.** RLS stays **222**; migrations stay **0001–0014**; cutover stays **BLOCKED**.
- **Adds [27_LEGACY_OMC_FULL_PARITY_MATRIX](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md)** — the row-level OMC production-replacement parity ledger under the [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) gate. 16 parity tracks (A routes/screens · B workflows · C fields · D lists/filters · E dashboard/metrics · F reporting/exports · G imports/connectors · H files/Storage · I AI extraction · J auth/roles/tenant-switching · K admin/settings · L audit · M billing/revenue · N data migration · O UX/navigation · P operations), each row carrying status / blocker level / required-evidence / security model. Defines exact statuses (`complete`/`partial`/`missing`/`deprecated-approved`/`blocked-security`/`blocked-data-migration`/`blocked-unknown-legacy-behavior`), blocker levels (P0/P1/P2/not-required), and evidence types.
- **Does NOT implement any feature, does NOT prove parity, does NOT close RISK-001, does NOT authorize cutover.** Records v3's real state honestly: apps/contracts surfaces + files-metadata/RLS + Storage structural staging apply are `partial`; the Storage REST verification is **pending** ([26]); **most legacy areas are `missing` or `blocked-unknown-legacy-behavior`** (full route inventory, reports/exports, imports/connectors, UAR/stale, billing, admin/settings, data migration, audit viewer, AI, upload/signed-URL). **Full legacy OMC parity is required by default**; a missing route/workflow/field/report/import/setting/billing/migration item is an **OMC blocker** unless explicitly `deprecated-approved`.
- **Control rule:** future feature PRs **must cite the matrix row(s) they close** with evidence; "better than legacy" / "contracts done" does not satisfy a row. Updated docs 00 (not OMC-ready; doc 27 is the master tracker), 09 (full-parity-by-default rule), 10 (index), 17 (references doc 27 as the detailed matrix under the gate).
- **Validation (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; `gen-types-local.sh` no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #53 — Add staging Storage REST API verification harness · 2026-06-17
- **Category:** tooling + ops runbook. Adds a **verifier** + a runbook; **no app/route/migration/test/generated-type/package/Supabase-config/env change**, **no hosted command run, no production touch, no service-role on any app/browser/request path.** RLS stays **222**; migrations stay **0001–0014**; routes unchanged; cutover stays **BLOCKED**; **RISK-001 stays OPEN**; Storage authorization is **NOT verified** (the verifier has not been run).
- **Adds `scripts/verify-staging-storage-rest.mjs`** — a **staging-only, user-scoped** harness that proves the `contract-files` `storage.objects` policies through the **real Supabase Storage REST API** (not `pg_policies` inspection). Asserts all 15 obligations: tenant-editor own-prefix upload (+ cross-tenant deny); procurement-org manager allowed only where contract-write authority exists; paying-org/viewer/cross-org **denied**; tenant A↔B read/list/sign isolation; anon GET denied; upsert/move/copy/delete denied; signed URL short-lived + single-object; server-derived `contracts/{tenant_id}/{file_id}.pdf` path; bad/traversal paths fail closed; `files` row as source of truth; `0013` RLS local-green (`test-rls.sh` 222).
- **Safety:** refuses to run unless `supabase/.temp/project-ref` **and** `STAGING_SUPABASE_URL` are the staging ref `ycdpzduxugdsffjqyoai` (and errors if the production ref `dzbfxulvxchdemcettrx` appears); **anon key + synthetic-user sign-in only — no service-role**; reads the anon key + synthetic-user passwords from **local env vars only** (never committed, never printed); fails loudly on missing env. Service-role appears **only** in the separate, clearly-marked one-time staging admin fixture step (doc 26 §5), human-run.
- **Adds [26_STORAGE_REST_VERIFICATION_RUNBOOK](./26_STORAGE_REST_VERIFICATION_RUNBOOK.md)** — how to run, the local env-var names (no values), the one-time admin fixture setup (synthetic users/tenants/orgs/contracts), the 15 obligations, and the evidence template.
- **The verifier has NOT been run** → **real Storage REST API authorization verification remains PENDING** (doc 25 §0.3). **RISK-001 remains OPEN; cutover remains BLOCKED; no production change; upload is NOT ready.** Updated docs 25/22/04 (verifier exists, not yet run) and 10 (index).
- **Acceptance (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (10 routes); `check-auth-safety`/`check-migration-safety`/`check-docs-updated` pass; `test-rls.sh` **222**; verifier `node --check` OK + fails loudly without env; no `* 2.*`/`* 3.*` strays.

---

### PR #52 — Record staging Storage object-policy apply evidence · 2026-06-17
- **Category:** ops evidence — **docs-only.** No app code, migration, test, generated-type, package, Supabase/Vercel config, or env change; **no hosted command run in this PR**; production untouched. Records a human-applied **staging-only** Storage object-policy apply (from `main` @ `795a50e`, PR #51 merged; linked project confirmed staging `ycdpzduxugdsffjqyoai` / `idcaddie-staging`).
- **Storage object policies applied in staging** ([25 §0.2](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md)): remote migrations now `0001`–`0014` (incl. `0014` helpers `can_write_contract_file` / `can_read_contract_file`); the private `contract-files` bucket re-confirmed (`public=false`, `file_size_limit=26214400`/25 MiB, `allowed_mime_types={application/pdf}`); two `storage.objects` policies — `contract_files insert (metadata + contract-write)` (INSERT, `{authenticated}`) and `contract_files select (readable metadata)` (SELECT, `{authenticated}`).
- **Structural policy verification passed:** object-path regex is the corrected canonical `contracts/{uuid}/{uuid}.pdf` (both UUIDs 8-4-4-4-12 lowercase hex); **unsafe-policy count = 0** (no UPDATE, no DELETE, no `ALL`/`FOR ALL`, no `anon`, no public).
- **Real Storage REST API authorization verification PENDING** (doc 21 §6 / doc 23 §4 — not yet run): tenant-editor own-prefix upload; procurement-org manager allowed only where contract-write authority exists; paying-org manager denied; tenant viewer denied; cross-org manager denied; tenant A cannot read/list tenant B prefix; tenant B cannot read/list/sign a tenant A object; anonymous/public GET denied; overwrite/upsert/move/copy/delete denied; signed URL short-lived + single-object scoped.
- **RISK-001 remains OPEN** (structural apply ≠ real-authz verification; criterion 1 satisfied, criterion 2 still pending — doc 04). **No production change. Upload is NOT ready. Storage authorization is NOT fully verified. Cutover remains BLOCKED.**
- **Updated** docs 25 (§0.1 superseded + new §0.2; banner), 04 (RISK-001), 00 (staging status), 09 (handoff), 10 (index).

---

### PR #51 — Add contract file Storage authorization helpers · 2026-06-17
- **Category:** migration — adds **`0014_contract_file_storage_auth_helpers.sql` only**. **No `storage.objects` policy applied, no hosted Supabase command, no bucket/policy creation, no production touch, no upload route/action/UI, no signed-URL/AI/OCR, no app/package change.** Migrations now `0001`–`0014`; `0001`–`0013` stay staged, **`0014` is `verified-local` + `ci-enforced` but NOT yet staged**; cutover stays **BLOCKED**; **RISK-001 stays OPEN**; Storage authorization is **NOT verified**.
- **Adds the two public-schema predicates docs/22 §5's staging `storage.objects` policies will call** (the helpers, not the policies):
  - `public.can_write_contract_file(target_file_id uuid, target_tenant_id uuid)` → a `files` row exists for `(file_id, tenant_id)` **AND** `public.can_write_contract(f.contract_id, f.tenant_id)` is true (tenant owner/admin/editor OR procurement-org manager; **never `paying_org` beyond what `can_write_contract` already allows**).
  - `public.can_read_contract_file(target_file_id uuid, target_tenant_id uuid)` → a `files` row exists **AND** `public.is_tenant_member(f.tenant_id)` is true.
  - Both **`SECURITY DEFINER`, `stable`, `search_path = public`** — definer bypasses `files`-SELECT RLS so an org-only manager (write-not-read, the `0013` asymmetry) still authorizes; `auth.uid()` is the caller; no recursion (`storage.objects` is never referenced by `files` policies). Both **fail closed** on a missing/wrong `(file_id, tenant_id)`.
- **RLS tests (T35, suite `205 → 222`)** prove: tenant owner/admin/editor pass write; procurement-org manager passes write when contract-write authority allows; **paying-org-only manager, tenant viewer, cross-org manager, and cross-tenant user are DENIED write**; tenant member (owner + viewer) passes read; org-only manager / cross-tenant / non-member are DENIED read; nonexistent file id and wrong tenant id **fail closed** for both helpers.
- `database.types.ts` adds only the two functions (1283 → 1291). **`storage.objects` policies remain NOT applied** (`pg_policies … contract% = 0`); the next sanctioned hosted mutation is the reviewed Storage object-policy apply (staging only, explicit human approval, doc 22 §5) **after `0014` is merged + applied to staging** — an agent does not run it. Production `dzbfxulvxchdemcettrx` untouched.
- **Updated** docs 00/01/02/03/04/09/14 (current-state counts → 222/T35, migration list → `0014`), docs 22/25 (helper migration now exists; object policies still pending), doc 04 RISK-001 (helpers landed, policies not applied — stays OPEN).
- **Tests run (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged, 10); `test-rls.sh` → **222** (`0001`–`0014`); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → only the two new functions; no `* 2.*`/`* 3.*` strays.

---

### PR #50 — Finalize staging Storage object policy apply plan · 2026-06-17
- **Category:** ops plan — **docs-only.** No hosted Supabase command run, no Storage policy applied, no production touch, no app/migration/test/generated-type/package/Supabase-config change, no upload UI. RLS stays **205**; migrations stay **0001–0013** in-repo; routes unchanged; `database.types.ts` unchanged (1283 lines); cutover stays **BLOCKED**; **RISK-001 stays OPEN**; Storage authorization is **NOT verified**.
- **Finalized the exact reviewed `storage.objects` policy plan for the staging `contract-files` bucket** in [22 §5](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md), mirroring the `0013` files-table authority with the `files` row as the source of truth:
  - **INSERT** allowed **only when the `files` metadata row exists AND the caller has contract-write authority** (`can_write_contract_file` = files-row-exists + `can_write_contract`; org-only procurement managers supported via `SECURITY DEFINER`; **paying-org/viewer/cross-org denied**; no orphan objects).
  - **SELECT/download** allowed **only when the caller can read the associated metadata** (`can_read_contract_file` = files-row-exists + `is_tenant_member`; org-scoped read still deferred).
  - **NO UPDATE policy, NO DELETE policy, NO `FOR ALL`, NO public/anon policy, NO cross-tenant access** — overwrite/upsert/move/copy/delete and anon access all deny (no matching policy); the path `tenant_id` is bound into the helper so tenant B can't write/read/overwrite tenant A's prefix. The `files` RLS (`0013`/T34) is unchanged.
  - **Apply order:** the two `SECURITY DEFINER` helpers land first as a **separate tested migration `0014`** (public-schema, locally RLS-testable); then the `storage.objects` policies are applied to **staging only** (not a migration — doc 21); then the doc 21 §6 verification is recorded.
- **Updated [25 §0.1](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md)** with a "pending object-policy apply" section (gap = `pg_policies` for `storage.objects` matching `contract%` is **0**), and pointed RISK-001 (doc 04) at the finalized-but-not-applied plan.
- **This PR applies/verifies nothing.** RISK-001 stays OPEN until: migration `0014` (helpers) → staging policy apply → doc 21 §6 verification recorded → production. The next sanctioned hosted mutation is the reviewed Storage object policies (staging, explicit human approval) — an agent does not run it. Production `dzbfxulvxchdemcettrx` untouched.
- **Tests run (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → **205** (local throwaway Postgres); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #49 — Clarify RISK-001 partial staging apply status · 2026-06-17
- **Category:** risk-register wording — **docs-only.** No app code, migration, test, generated-type, package, Supabase/Vercel config, or env change; no hosted Supabase mutation; production untouched; no Storage object policy applied. RLS stays **205**; migrations stay **0001–0013** in-repo; routes unchanged; `database.types.ts` unchanged (1283 lines); cutover stays **BLOCKED**.
- **Reworded [04 · RISK-001](./04_RISK_REGISTER.md)** to reflect the **partial** staging apply recorded in PR #47/#48 (doc 25 §0): it is **no longer "nothing applied to hosted Supabase"** — staging migrations `0001`–`0013` are applied to `ycdpzduxugdsffjqyoai` + the private `contract-files` bucket exists (`public=false`, 25 MiB, `application/pdf`) — but it is now **"hosted apply PARTIAL / INCOMPLETE"**: the Storage **object policies are NOT applied**, the doc 21 §6 **verification is NOT complete**, and **production is NOT touched** (`dzbfxulvxchdemcettrx`). **RISK-001 stays OPEN.** Its closure now requires **all** of: (1) reviewed Storage object policies applied to staging; (2) the doc 21 §6 Storage authorization verification completed + recorded; (3) production apply under doc 20 discipline; (4) evidence recorded; (5) the doc 17 §5 cutover checklist still satisfied.
- **Consistency:** updated the now-stale `not-hosted-applied` / `not staged` claims in docs 00 (foundation status table), 09 (state + risks-to-respect), and 10 (taxonomy "Today:" line) to **`staged`** (staging-applied, **not** `production-applied`) per the [10 taxonomy](./10_DOCS_INDEX.md#status-taxonomy).
- RISK-002/007/016 remain open; cutover BLOCKED; doc 17 stays the binding authority. The next sanctioned hosted mutation is the reviewed Storage object policies only (staging, explicit human approval, doc 22 §4/§5) — an agent does not run it.
- **Tests run (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → **205** (local throwaway Postgres); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #48 — Update staging bucket creation evidence (real staging apply, recorded) · 2026-06-17
- **Category:** ops evidence — **docs/evidence-only.** No hosted Supabase mutation **in this PR**, no `supabase db push --linked`, no Storage policy creation, no production change, no app/route/migration/package/generated-type/config change. RLS stays **205**; migrations stay **0001–0013** in-repo; routes unchanged; `database.types.ts` unchanged (1283 lines); cutover stays **BLOCKED**.
- **Records a real hosted action that already happened** (a human executed it **after PR #47 merged**, under doc 20/doc 22 discipline): **migrations `0001`–`0013` are now applied to the STAGING project `ycdpzduxugdsffjqyoai`**, and **the private `contract-files` Storage bucket now exists in staging** — verified values `public = false`, `file_size_limit = 26214400` (= 25 MiB = `MAX_CONTRACT_FILE_BYTES`), `allowed_mime_types = application/pdf` (matches `src/lib/files/pdf-validation.ts` + doc 16 §3). **Production `dzbfxulvxchdemcettrx` was NOT touched.**
- **Storage object policies are NOT yet applied** → the doc 21 §6 object-policy authorization checklist is **NOT complete**; **no upload route/action/UI, signed-URL flow, AI extraction, or OCR** was built/shipped; `files` stays not surfaced.
- **Updated [25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md):** added §0 recording the post-#47 human execution (the verified bucket values + the migration apply); the original PR #47 agent session (correctly NOT executed) is preserved as §1–§6 history.
- **RISK-001 stays OPEN** — the staging apply is **partial** (object policies + full Storage verification + production still pending; doc 04 closure criterion unmet). RISK-002/007/016 open. **The next sanctioned hosted mutation is the reviewed Storage object policies ONLY — staging only, after explicit human approval (doc 22 §4/§5), stop before production.**
- **Updated** docs 00/09/10 to reflect the staging migrations + bucket as recorded, the object-policies-pending state, and that the CLI is now re-linked to staging.
- **Tests run (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → **205** (local throwaway Postgres); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #47 — Record staging schema & contract-files storage apply evidence (hosted apply NOT executed) · 2026-06-17
- **Category:** ops evidence — **docs-only.** No hosted Supabase mutation, no `supabase db push --linked`, no bucket/policy creation, no production touch, no app/route/migration/package/generated-type change. RLS stays **205**; migrations stay **0001–0013**; routes unchanged; `database.types.ts` unchanged (1283 lines); RISK-001/002/007/016 stay **open**; cutover stays **BLOCKED**.
- **Outcome: the hosted staging apply was attempted and correctly NOT executed.** Creates [25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md) — an honest evidence record (filled from the [23](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md) template). **Blocker:** the local Supabase CLI was found **linked to PRODUCTION** (`dzbfxulvxchdemcettrx`), the **staging project `ycdpzduxugdsffjqyoai` is not reachable** from this environment, no staging credentials are present, and per [09](./09_AGENT_HANDOFF.md)/[20](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md) **an agent never runs a hosted apply** — so no hosted command was run against any project (**production NOT touched**). Migrations `0001`–`0013` were **NOT applied**, the `contract-files` bucket was **NOT created**, and staging was **NOT verified** — all marked NOT EXECUTED, pending a human execution. **No results were fabricated.**
- **Records the real verified state:** repo clean on `main` @ `53562c3`; `.env.local` not tracked; no `* 2.*`/`* 3.*` conflict files; the full local suite green (`npm test` 67/67, lint/tsc/build clean, `test-rls.sh` 205 against throwaway Postgres, `gen-types` 0-diff). Includes the **human remediation runbook** (re-link to staging + verify the ref BEFORE any `--linked` push, then doc 22 + doc 23) — redacted, no secrets.
- **RISK-001 stays OPEN** (nothing applied to hosted Supabase). Production untouched; cutover BLOCKED; doc 17 stays the binding authority.
- **Updated** docs 00/09/10/22 to point at doc 25 as the (blocked) first execution record.

---

### PR #44 — Document staging environment variable wiring checklist · 2026-06-17
- **Category:** ops inventory/checklist — **docs-only.** No real secrets, no real values, no Vercel mutation, no hosted Supabase mutation, no `supabase db push --linked`, no bucket/policy creation, no production deploy, no app/route/migration/package/generated-type change. RLS stays **205**; migrations stay **0001–0013**; routes unchanged; `database.types.ts` unchanged (1283 lines); RISK-001/002/007/016 stay **open**; cutover stays **BLOCKED**.
- **Creates [24_STAGING_ENVIRONMENT_VARIABLES_AND_WIRING_CHECKLIST](./24_STAGING_ENVIRONMENT_VARIABLES_AND_WIRING_CHECKLIST.md)** — the inventory of exactly which env vars must be set in Vercel + Supabase **staging** (names + classifications only, **no values**) before any hosted staging execution ([20](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)/[22](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md)), plus the wiring checklists. Grounded in the real code (`src/lib/supabase/env.ts` / `.env.example`): v3 uses exactly two **public** vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the publishable anon key, RLS is the boundary); the **service-role key is NOT used today** (deliberately absent from `src/`) and is **future/deferred — never on a request/browser path, never `NEXT_PUBLIC_`**; connector/vault vars are **BLOCKED by doc 19 / RISK-007**. Sections: status banner; environment model (local/staging/prod; staging-before-prod); the var inventory (public / server-only-secret / staging-only / future-deferred / blocked); redaction rules (never commit values; mask `set/not set`); Vercel staging wiring checklist (preview/staging-not-prod, no prod vars copied, no service-role to browser, `NEXT_PUBLIC_*` only public, server-only vars not `NEXT_PUBLIC_`); Supabase staging wiring checklist (staging ref, not prod, migrations-listed, hosted apply separately approved, Storage via docs 22/23); a no-values verification evidence template; non-goals; risk posture.
- **Configures NOTHING.** It is an inventory + checklist a human follows later; it sets no variable, links no project, and includes no secret/value. Does NOT close RISK-001 or imply v3 is production-replacement-ready; production untouched; cutover blocked; doc 17 stays the binding cutover authority.
- **Updated** docs 00/04/09/10/20/22/23 to reference doc 24 as the staging env-var inventory/wiring checklist.
- **Tests run (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → **205** (`0001`–`0013`, unchanged); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #43 — Add Storage staging apply evidence template · 2026-06-17
- **Category:** ops evidence template — **docs-only.** No hosted Supabase mutation, no `supabase db push --linked`, no bucket creation, no Storage policy creation, no upload action/route/UI, no signed-URL code, no service-role, no migration, no app code, no package, no generated-type change, no secrets. RLS stays **205**; migrations stay **0001–0013**; routes unchanged; `database.types.ts` unchanged (1283 lines); RISK-001/002/007/016 stay **open**; cutover stays **BLOCKED**.
- **Creates [23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md)** — the fill-in evidence-capture template a human uses **while executing [22](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md)** against a staging Supabase project: a **TEMPLATE ONLY — NOTHING APPLIED** banner; execution metadata (executor/reviewer/date/SHA/authorizing-PR/staging-ref + staging-not-prod / clean-tree / migrations-listed / approved-changes-only / no-secrets confirmations); a pre-apply checklist; an apply-evidence section (redacted placeholders, **no runnable mutating commands**); the **doc 21 §6 verification checklist reproduced as 20 fillable rows** (result/evidence/**reviewer initials**/notes — private bucket, public/unauth denied, cross-tenant read+overwrite/delete denied, upload only via contract-write authority [paying-org/viewer/cross-org denied], UPDATE/DELETE/`FOR ALL` denied, server-derived path, filename-not-in-path, `0013` still passes, no service-role, signed-URLs short-lived, no public URLs); a failure log; a rollback/disable section; and a final staging signoff with explicit gates (RISK-001 stays open unless [20 §9](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md) criteria are separately approved; upload action only in a later PR; production promotion is a separate PR/runbook/execution).
- **Authorizes/applies NOTHING.** It records an execution that a human performs later under explicit approval; it requires **reviewer evidence (not just executor claims)** for every proof, and mandates proof of cross-tenant denial, public-access denial, destructive-write denial, and no-service-role. Doc 17 stays the binding cutover authority; production untouched.
- **Updated** docs 00/04/09/10/20/21/22 to reference doc 23 as the evidence template/log.
- **Tests run (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → **205** (`0001`–`0013`, unchanged); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #42 — Add hosted-staging contract-files bucket apply runbook · 2026-06-17
- **Category:** ops runbook — **docs-only.** No hosted Supabase mutation, no `supabase db push --linked`, no bucket creation, no Storage policy creation, no upload route/action/UI, no signed-URL code, no service-role runtime path, no production deploy, no secrets, no migration, no RLS/type/route change. RLS stays **205**; migrations stay **0001–0013**; routes unchanged; `database.types.ts` unchanged (1283 lines); RISK-001/002/007/016 stay **open**; cutover stays **BLOCKED**.
- **Creates [22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md)** — the exact reviewed, human-executed **staging** apply + verification steps for the private `contract-files` Storage bucket + object policies (the gate before any contract PDF upload action ships). Defines the bucket spec (private only, no public URLs, path `contracts/{tenant_id}/{file_id}.pdf`, `tenant_id`/`file_id` server-derived only, mirrors the `0013` contract-write authority, no UPDATE/DELETE/`FOR ALL`); the **exact staged apply sequence** (confirm clean main → confirm linked **staging** project only → list migrations first → apply only the approved bucket/object-policy changes → verify schema/policies → run Storage API verification → **STOP before production**); an illustrative object-policy shape clearly marked staging-executor-finalized + §6-verified (not applied, not a migration, not locally tested per doc 21); the **verification checklist reproduced from doc 21 §6** (private bucket, no public read, tenant-prefix isolation, cross-tenant read/overwrite/delete denial, upload only via contract-write authority [`paying_org`/viewer denied], UPDATE/DELETE/`FOR ALL` denied, server-derived path, `0013` preserved, no service-role); stop/rollback rules; and the do-not-auto-promote-to-production rule.
- **Applies/creates NOTHING.** This is the runbook the human executor follows later against a staging project; it instantiates doc 20's apply discipline and executes doc 21 §6 against the real storage-api. The bucket + policies are hosted Storage objects (not `supabase/migrations/` — that would break the plain-Postgres harnesses, doc 21). The upload action/route/UI, signed-URL flow, and AI/OCR are **separate later PRs** that may ship only after §6 passes in staging.
- **Does NOT close any risk or authorize cutover.** RISK-001/002/016 stay open; doc 17 stays the binding gate; cutover BLOCKED.
- **Updated** docs 00/04/06/09/10/16/17/20/21 to reference doc 22 as the staging apply runbook for the bucket.
- **Tests run (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → **205** (`0001`–`0013`, unchanged); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #41 — Evaluate Supabase Storage local test harness (spike) · 2026-06-17
- **Category:** feasibility spike — **docs-only.** No migration, no Storage bucket, no Storage object policy, no `storage` shim, no upload action/UI/route, no signed-URL code, no AI/OCR, no service-role, no app code, no package, no generated-type change. RLS stays **205**; migrations stay **0001–0013**; routes unchanged; `database.types.ts` unchanged (1283 lines); RISK-001/002/007/016 stay **open**; cutover stays **BLOCKED**.
- **Outcome: B — real local Storage object-RLS testing is NOT feasible in this repo's pipeline right now.** **Empirically proven** against a fresh `postgres:16-alpine` (the exact harness `test-rls.sh`/`gen-types-local.sh` use, `auth` shim + `0001`–`0013`): `storage.objects` does not exist, `storage.foldername()` errors `schema "storage" does not exist`, and `create policy ... on storage.objects` errors the same. So a `0014` storage-policy migration would **break both plain-Postgres harnesses**; and even a hand-installed `storage` schema would only test the SQL predicate, **not** storage-api enforcement (public/private, owner, signed URLs) — i.e. faking safety.
- **No fake shim, no untestable policies.** The faithful local path is the real storage-api via `supabase start` (a ~13-service stack), which is a separate/heavier CI infra decision (not bolted onto the fast `test-rls.sh`); the repo is not even `supabase init`'d. Per the existing discipline, **Storage object-RLS is verified in HOSTED STAGING ([20](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)) before any upload action ships.**
- **Creates [21_STORAGE_LOCAL_HARNESS_FEASIBILITY](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md)** — the spike findings (the empirical probes), the verdict + rejected alternatives, the two faithful paths (hosted staging now; a future dedicated `supabase start` CI job deferred), and a **concrete hosted-staging Storage bucket/object-policy verification checklist** (private bucket, no public access, tenant-prefix isolation, cross-tenant denial, upload/read only via contract-write authority [`paying_org` denied], server-derived path, `0013` files RLS preserved, no service-role).
- **No migration added; no bucket created; object-RLS NOT tested** (it can't be, faithfully, here — that's the finding). The PR #40 `files` RLS (`0013`/T34) is untouched.
- **Updated** docs 00/04/06/09/10/16/17/20 to record the verdict + point at doc 21 for the hosted-staging verification.
- **Tests run (local, verified):** `npm test` 67/67; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → **205** (`0001`–`0013`, unchanged); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #40 — Add private contract-file Storage validation foundation · 2026-06-17
- **Category:** security / contract-file path — **app-lib + tests + docs.** The next safe step of [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md): the locally-testable core of the contract PDF upload path. **No migration, RLS, route, Storage bucket, upload action/UI, signed URL, AI/OCR, connector, or generated-type change.** RLS stays **205**; migrations stay **0001–0013**; routes unchanged; `database.types.ts` unchanged (1283 lines); RISK-001/002/007/016 stay **open**; cutover stays **BLOCKED**.
- **Implemented — `src/lib/files/pdf-validation.ts`** (pure, IO-free, server-only; no Supabase/service-role/network — the same pure/IO split as `contract-write.ts`):
  - **`validateContractPdf`** — server-side validation from the **actual uploaded bytes**: non-empty → max size (`MAX_CONTRACT_FILE_BYTES` = **25 MiB**) → `.pdf` extension → `application/pdf` MIME → `%PDF-` magic bytes; returns caller-safe labels.
  - **`buildContractFileObjectPath`** — the **server-derived, tenant-bound** object path `contracts/{tenant_id}/{file_id}.pdf`; **both components must be server-issued UUIDs** (a non-UUID/traversal value is rejected → a client-supplied tenant/path/filename can never reach the path).
  - **`sanitizeDisplayFilename`** — strips directory components + control chars; the original filename is **display metadata only**, never used for the path or any security decision.
  - **`CONTRACT_FILES_BUCKET = "contract-files"`** — the canonical **private** bucket name (reconciles doc 16's illustrative `contracts`).
- **16 unit tests** (`pdf-validation.test.ts`): valid PDF accepted; wrong extension / `.pdf.exe` / wrong MIME / missing-magic / empty / oversized rejected; dangerous filename can't affect the path; generated path matches `contracts/{tenant_id}/{file_id}.pdf`; client-supplied non-UUID tenant/path/file-id rejected (traversal impossible). Suite **51 → 67**.
- **Explicitly NOT implemented (honest scope):** **no Storage bucket created**, **no upload action/route/UI**, **no signed URLs**, **no file preview**, **no AI/OCR/extraction**, **no review/apply UI**, **no service-role**, **no hosted apply / deploy / secrets**, **no migration**, **no change to the `0013` files RLS** (file-row INSERT authority is still governed + tested by `0013`/**T34**). The Supabase Storage bucket + its object-RLS live in the `storage` schema, which the local harness (plain `postgres:16` + `auth` shim, no `storage` schema) **cannot host or test** — so they are deferred to the hosted path ([20](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)); adding a `storage` shim would test policies against a fake and **fake safety**, so it was not done.
- **Risk posture:** **RISK-001 open** (no hosted apply); **RISK-002 open** (`files` still not surfaced — these helpers are a building block, no DAL/route/UI touches `files`); **RISK-016 open**; **RISK-007 open**. Cutover stays BLOCKED.
- **Tests run (local, verified):** `npm test` **67/67**; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged, no new route — pure lib); `test-rls.sh` → **205** (`0001`–`0013`, unchanged); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays.

---

### PR #39 — Document staging + hosted apply & cutover discipline · 2026-06-17
- **Category:** operational discipline — **docs-only.** No migration, RLS, app code, route, Storage, connector, package, or generated-type change. RLS stays **205**; migrations stay **0001–0013**; routes unchanged; `database.types.ts` unchanged (1283 lines); RISK-001/002/007/016 stay **open**; cutover stays **BLOCKED**.
- **Creates [20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)** — the runbook-of-record for moving v3 from local-only verified code to hosted staging and (eventually) a production replacement: purpose/scope; environment model (local/staging/prod Supabase + Vercel, legacy, OMC target); branch+PR discipline; hosted-apply discipline (list→apply-expected-only→verify schema→smoke checks; never dirty tree / unknown-duplicate / type-drift / non-green-RLS / prod-first); **staging-first** rule; secrets discipline (no real connector creds until the [19](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md) vault is implemented+tested+reviewed+hosted-applied+verified; per-env secrets; never in docs/commits/logs/types/rows); Vercel discipline (preview≠prod; explicit staging; gated prod promotion; scoped env vars; rollback required); OMC cutover discipline; **ten verification checklists** (before/after PR, staging apply, prod apply, Vercel prod promotion, OMC cutover); **stop/rollback rules** (unexpected/duplicate migration, type drift, RLS failure, secret in logs/code, cross-tenant suspicion, destructive behavior, service-role on a request path, premature readiness claim); risk-register relationship; non-goals.
- **Applies/deploys/adds NOTHING.** No hosted Supabase apply, no `supabase db push --linked`, no staging/prod environment created, no production deploy, no secrets, no Storage/connector/PDF/AI code. The doc gates *how* an apply/deploy happens once the gate allows it — it never authorizes one by itself.
- **Does NOT close RISK-001.** RISK-001 moves to **"discipline documented, hosted apply still not done"** — closure requires an actual reviewed staging apply + post-apply RLS/schema verification. RISK-002/007/016 also stay open.
- **Gate stack reaffirmed:** doc 17 is the binding go/no-go cutover gate (17 wins); doc 18 feeds confirmations (existence/status only, no tokens); doc 19 gates connector credentials; **doc 20 gates hosted/staging/prod apply + deployment + cutover execution.** OMC = paying production replacement, **not a pilot.**
- **Updated** docs 00/04/06/09/10/17/19: RISK-001 = discipline-documented-not-closed; status = docs-only (no migrations/app/routes/RLS/secrets); a non-negotiable agent rule (no hosted Supabase mutation unless following doc 20 + explicit human approval); doc 17 Track A/B reference doc 20; doc 19 vault implementation gated also by doc 20's staging/hosted-apply discipline.
- **Tests run (local, verified):** `npm test` 51/51; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → 205 (`0001`–`0013`); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #38 — Document connector credential vault design (RISK-007) · 2026-06-17
- **Category:** security design — **docs-only.** No migration, RLS, app code, route, Edge Function, encryption code, connector code, package, or generated-type change. RLS stays **205**; migrations stay **0001–0013**; routes unchanged; `database.types.ts` unchanged; RISK-001/002/007/016 stay **open**; cutover stays **BLOCKED**.
- **Creates [19_CONNECTOR_CREDENTIAL_VAULT_DESIGN](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md)** — the safe future path for collecting/storing/using/rotating/deleting connector credentials (Okta/Google/Entra/Slack/SCIM/scrapers/inbound-API) **before any real secret is ever collected.** Sections: threat model (T1–T9); data-model direction (design-only `connector_integrations`/`connector_credentials`/`connector_credential_versions`/`connector_sync_runs`/`connector_sync_events`/`connector_sync_dry_runs`); secret-storage model (vault handle + redacted metadata, never the secret); key management (Supabase Vault / KMS / external secret manager, key separated from app DB role; why plain text/jsonb is unacceptable); authorization model (tenant connector-admin; **related-org/payor cannot manage credentials**); server-only OAuth/token flow (PKCE/state/nonce, no token in URL/logs/client); non-destructive sync (dry-run → diff → idempotent upsert → tombstone-requires-review; no destructive delete from remote absence); RLS/test plan; logging/redaction rules; connector-specific notes; relationship to docs 17/18; non-goals.
- **Inherits the v3 invariants:** RLS is the boundary (no app-layer filtering); **no service-role key on any request/browser path** (secret access is confined to a future isolated out-of-request job, never the request DAL, never the browser); composite same-tenant FK (`0005`); append-only audit (`0010`); no hard delete of evidence (`0004`). Raw secrets are **not stored in any RLS-readable column** — the row holds only an opaque `vault_ref` + redacted display (provider/status/`last_four`/`fingerprint`/timestamps), so a full row read leaks nothing and generated types never carry a readable token.
- **Does NOT close RISK-007.** There is no vault, connector table, encryption code, OAuth flow, sync worker, or migration in the repo. RISK-007 moves to **"design documented, implementation still open."** Implementation is gated on this design being reviewed + the §8 tests green + hosted-applied + verified.
- **No secrets, ever.** This PR collects/requests/stores no real tokens/keys/credentials; connector *existence* is confirmed (doc 18) name/status-only; credential collection waits for the implemented vault.
- **Updated** docs 00/04/06/09/10/17/18 to reference doc 19: RISK-007 = design-documented-not-closed; status = vault design documented only (no connectors/secrets implemented); a non-negotiable agent rule (do not collect real connector credentials until the vault is implemented); doc 18 reaffirmed name/status-only; doc 17 references the vault as a prerequisite for connector implementation.
- **Tests run (local, verified):** `npm test` 51/51; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → 205 (`0001`–`0013`); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #37 — Document OMC confirmation pass scaffolding · 2026-06-17
- **Category:** parity governance — **docs/process-only.** No app code, route, migration, RLS, Storage, connector, package, or generated-type change. RLS stays **205**; migrations stay **0001–0013**; routes unchanged; RISK-002 + RISK-016 stay **open**; cutover stays **BLOCKED**.
- **Creates [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md)** — the working process to confirm what OMC/Flywheel actually uses in the live app, so [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)'s `probably`/`unknown` rows can be resolved from evidence. Sections: purpose; a confirmation status taxonomy (`confirmed-required`/`-not-used`/`-better-approved`/`-removed-approved`, `needs-demo`/`-screenshot`/`-data-sample`/`-owner-confirmation`/`-security-review`, `unconfirmed-blocker`); stakeholder/owner table; workshop agenda; a grouped questionnaire (core/admin/auth, apps, contracts, people/identity, licenses/spend, imports/connectors, exports/reports, files/PDF/AI, production cutover); a ~33-row workflow confirmation table mirroring doc 17 §4; an evidence checklist; a decision-log template; the required outputs; and non-goals.
- **Doc 18 feeds doc 17; [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) remains the binding go/no-go gate.** Running the pass does NOT make v3 ready and does NOT remove blockers by itself — a blocker only changes status when evidence + owner sign-off are recorded (doc 18 §8) AND the doc 17 row is updated.
- **Unknown = blocker until confirmed.** Every workflow row starts `unconfirmed-blocker`/`needs-owner-confirmation`; a verbal "probably not used" is not enough for removal — removal needs a recorded owner + date + evidence.
- **No secrets, ever.** The pass explicitly forbids collecting tokens/API keys/credentials (no Okta/Slack/Google/connector tokens); connector *existence* is confirmed verbally/visually, credential handling is a separate later security-reviewed step (vault — RISK-007). Sample exports/reports must be redacted.
- **Updated doc 17** (opening, §2 requiredness semantics, §9 list) to reference doc 18 as the confirmation workflow; **updated** docs 00/06/09/10/11/14 to point at doc 18 and reaffirm: OMC is a production replacement (not a pilot); doc 17 is the binding gate; v3 is not production-replacement-ready; no risk closed.
- **Tests run (local, verified):** `npm test` 51/51; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → 205 (`0001`–`0013`); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #36 — Document OMC production replacement parity gate · 2026-06-17
- **Category:** parity governance — **docs-only.** No migration, RLS, app code, route, package, or generated-type change. RLS stays **205**; migrations stay **0001–0013**; routes unchanged; RISK-002 + RISK-016 stay **open**.
- **Creates [17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)** — the **canonical go/no-go gate** for replacing the live OMC/Flywheel production app with v3. If 11/14 and 17 disagree on cutover-readiness, **17 wins.** Sections: cutover principle, status taxonomy, hard blockers, the replacement parity matrix, the go/no-go checklist, the approved-difference process, the next-PR sequence, the honest estimate, and the standing rule for future agents.
- **Reframes OMC as a production replacement, not a pilot:** paying ~$3.5k/mo customer; v3 must replace the live app with no missing/broken workflows; improvements only after replacement via planned rollouts.
- **Grounded in a real legacy inspection** (not prior docs): read `…/IDCaddie_Repo-main` (`frontend-v2/src/app/(authenticated)/`, `webapp/functions/src/*`) across ~40 routes + the Cloud-Function subsystems (appScraping/scim/billing/reports/storage/email/scheduled/logging). The matrix has ~105 grounded workflow rows; the blocker list + OMC-confirmation list are evidence-based.
- **Honest estimate:** the prior rough ~20–35 PR figure is optimistic for full parity; the grounded inspection puts a from-#35 full replacement at **~70–110 PRs** (the actual number depends on the §9 OMC-confirmation pass — narrow OMC usage could compress toward ~25–40). **Not "a few PRs away."**
- **No risk closed.** RISK-002/RISK-016 stay open; the gate also tracks RISK-001 (no hosted apply), RISK-007 (no credential vault), RISK-012, RISK-009, RISK-013. **OMC/Flywheel cutover + new paid-customer onboarding stay BLOCKED; v3 is not production-replacement-ready.**
- **Updated:** docs 00/04/06/09/10/11/14 to point at doc 17 as the canonical replacement gate and reframe OMC as production-replacement (not pilot).
- **Tests run (local, verified):** `npm test` 51/51; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → 205 (`0001`–`0013`); `check-migration-safety`/`check-auth-safety`/`check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays. Docs-only diff.

---

### PR #35 — Add files RLS policies + tests · 2026-06-17
- **Category:** RLS / security — migration + SQL tests + docs. The §5 step of [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md): the first **tested** `files` RLS policies, so the table is no longer zero-policy. **No Storage bucket, upload route, signed URLs, scan/AI/OCR, Edge Function/worker, service-role, UI, or app DAL/route — `files` is still NOT surfaced.** No table/column change; the only generated-type change is the new policy helper function. RLS `org_rls_test.sql` **186 → 205**.
- **Migration `0013_files_rls_policies.sql` (forward-only, policies only):**
  - **SELECT** `members read tenant files` — `is_tenant_member(tenant_id)`: tenant-member-only read (org-scoped file read is a **later** step — docs/16 §5; deliberate asymmetry noted below).
  - **INSERT** `writers insert contract files` — `uploaded_by = auth.uid() AND can_write_contract(contract_id, tenant_id)`: the **same contract-write authority as `0004`** (tenant owner/admin/editor **OR** procurement-org manager of the linked contract). **`paying_org_id` grants NO file write.** The `0012` composite FK blocks cross-tenant contract attachment.
  - **Helper `can_write_contract(contract_id, tenant_id)`** — `SECURITY DEFINER`, `stable`, `search_path=public` (the established helper pattern): `has_tenant_role(tenant_id, ['owner','admin','editor']) OR (the contract's procurement_org_id is managed by the caller via has_org_role_in_tenant)`. It never references `paying_org_id`; `auth.uid()` still resolves to the caller; no recursion (contracts/membership policies don't reference files).
  - **NO UPDATE policy** (scan/extraction status transitions are a future worker/service design — docs/16 §6/§8, not a broad user UPDATE), **NO DELETE policy, NO `FOR ALL`** (files are evidence; archive is a separate future design — the `0004` posture).
- **Tests — new T34 (+ T33/T27 updated): 186 → 205 assertions.** T34: tenant member reads only their tenant's files; cross-tenant / non-member / org-only read **0** (read is tenant-member-only); tenant editor **and** procurement-org manager **can** insert a file for an in-tenant contract; **paying-org manager CANNOT** (paying ≠ write); tenant viewer + cross-org manager **denied**; **uploaded_by spoof denied**; cross-tenant attach rejected (FK); tenant-B positive control; **DELETE denied** (0 rows, row survives) and **UPDATE denied** (0 rows) for everyone. T33's `0012` "0 policies / tenant-member reads 0" checks were updated to the post-`0013` reality (SELECT+INSERT present, still 0 UPDATE/DELETE/FOR ALL; a tenant member now reads their file). T27's `files` default-deny line moved to the tenant-readable positive-control group.
- **Types:** `gen-types-local.sh` adds **only** `can_write_contract` to the `Functions` section — no table/column/Row/Insert/Update change; no app code references it (`tsc` clean).
- **Honest status:** `files` now has a tested read+write **authorization model**, but is **still not surfaced** — there is no Storage bucket, upload UI/route, signed-URL flow, scan/AI worker, file preview, or extraction UI, and no app DAL reads/writes `files`. **Deliberate asymmetry:** an org procurement-manager may now INSERT a file for their contract but cannot yet LIST files (read is tenant-member-only) — org-scoped file read is the next-after broadening (docs/16 §5).
- **Risk posture:** **RISK-002** narrows for `files` (tenant-member read + tested write authority) but **remains OPEN** (`identity_accounts`/`license_*`/`invoices` still default-deny; org-scoped file read deferred; no surface). **RISK-016 remains OPEN.** **OMC/Flywheel cutover + new paid-customer onboarding remain BLOCKED.**
- **Tests run (local, verified):** `npm test` 51/51; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (0001–0013, **205** assertions); `check-migration-safety` pass (`0013` forward-only); `check-auth-safety` pass (no service-role); `check-docs-updated` pass; `gen-types-local.sh` → only `can_write_contract`; no `* 2.*`/`* 3.*` strays.

---

### PR #34 — Add files metadata foundation · 2026-06-17
- **Category:** schema foundation — migration + types + a focused SQL test + docs. Implements the **first DB step** of the [16_CONTRACT_PDF_AI_EXTRACTION_DESIGN](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) plan. **No upload, Storage, bucket, signed URLs, scan/AI/OCR, Edge Function, UI, route, service-role, RLS policy, DELETE/FOR ALL, or hosted apply.** `files` stays RLS-enabled but **DEFAULT-DENY / not surfaced**.
- **Migration `0012_files_metadata_foundation.sql` (additive, forward-only):** `alter table public.files add column` — `contract_id uuid`, `storage_bucket text`, `content_type text`, `byte_size bigint`, `sha256 text` (all nullable) + `upload_status text not null default 'pending'`, `scan_status text not null default 'pending'`, `extraction_status text not null default 'not_started'`, `extraction_result_json jsonb`, `extraction_error text`, `updated_at timestamptz not null default now()`. **Safe for existing rows** (every column nullable or NOT NULL-with-default; Postgres backfills the default in place).
- **Integrity:** a **composite same-tenant FK** `(contract_id, tenant_id) → contracts(id, tenant_id)` (the `0005` pattern, reusing the existing `contracts_id_tenant_key`) — a tenant-B file can **never** be attached to a tenant-A contract (FK violation at write time, not merely hidden by RLS); MATCH SIMPLE keeps a NULL link valid; default ON DELETE (a composite FK can't `SET NULL` the NOT NULL `tenant_id`; contracts aren't hard-deletable — `0004`). **CHECK** constraints: `upload_status ∈ (pending,uploaded,failed)`, `scan_status ∈ (pending,passed,failed,skipped)`, `extraction_status ∈ (not_started,queued,processing,completed,failed)`, `byte_size is null or ≥ 0`, `sha256 is null or ~ '^[a-f0-9]{64}$'`. Tenant-scoped **indexes** on `(tenant_id, contract_id)` + `(tenant_id, {upload,scan,extraction}_status)` for future reads/job sweeps. **No `updated_at` trigger** — the schema has no standard moddatetime trigger (every table's `updated_at` is default-only, bumped by the writer); kept that convention, documented in the migration.
- **Tests — RLS `org_rls_test.sql` 177 → 186 (new T33, +9 assertions):** valid same-tenant file→contract attachment inserts with the right status defaults; a **cross-tenant** attachment is **rejected** (FK); each CHECK rejects an out-of-range value (1 FK + 5 CHECK = 6 rejections counted); well-formed metadata is accepted (checks not over-tight); **catalog** — `files` keeps **0 DELETE / 0 FOR ALL / 0 policies** with RLS still enabled; **behavioral** — a tenant member reads **0 files** even though file rows exist (default-deny / not surfaced). `npm test` 51/51 unchanged (no app code depends on the new columns yet).
- **Types:** `gen-types-local.sh` regenerates `database.types.ts` — **only** the 11 new `files` columns (Row/Insert/Update) + the `contract_id` same-tenant relationship; no other table changed.
- **Honest status:** this is the schema foundation only — **no file UI, no upload, no Storage bucket, no AI extraction, no signed URLs.** `files` remains **not surfaced / default-deny**. A future RLS PR (with its own tests) is required before any file read/write is exposed.
- **Risk posture (unchanged):** **RISK-002 + RISK-016 remain OPEN.** **OMC/Flywheel cutover + new paid-customer onboarding remain BLOCKED.**
- **Tests run (local, verified):** `npm test` 51/51; lint clean; `tsc --noEmit` clean (no source references the new columns); `next build` clean (routes unchanged); `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (0001–0012, **186** assertions); `check-migration-safety` pass (`0012` forward-only, additive); `check-auth-safety` pass; `check-docs-updated` pass; `gen-types-local.sh` → only the new `files` columns; no `* 2.*`/`* 3.*` strays.

---

### PR #33 — Design contract PDF upload and AI extraction · 2026-06-16
- **Category:** design / security plan — **docs only.** New [docs/16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md). **No code, no migration, no RLS change, no Storage bucket, no AI/OCR call, no Edge/Cloud Function, no file UI, no `database.types.ts` change, no hosted apply.** RLS stays **177**; routes unchanged; `npm test` 51/51 unchanged.
- **Legacy inspected first (the anti-patterns to NOT port):** read the legacy PDF/AI pipeline — `contracts/create` Upload-PDF tab, `contracts/[id]` `extractAndUpdate`, `utils/downloadFile.ts`, `webapp/functions/.../processFileWithAI.js`, `handleDocumentAICompletion.js`, `constants/documentTypes.js` (`documentPrompts`), `logging/fileOnWrite.js`. Legacy = **client-only MIME check** (no server validation/scan), **service-role Storage `onFinalize` Cloud Function**, **PDF fed to Gemini with no prompt-injection defense**, **all AI fields stored wholesale** (`{ ...parsedResponse }`), **auto-overwrite of contract fields** from extraction (no review), Firebase **tokenized download URLs** (public-with-token), and **app-layer audit** reading a forgeable actor. v3 keeps the *workflow*, replaces the *implementation*.
- **Design (all deferred):** upload is an **assistive panel** (not the primary create path); the **DB `files` row is the source of truth**, a **private** bucket with **server-derived tenant-bound paths** (`contracts/{tenant_id}/{file_id}.pdf`) and **short-lived signed URLs** (no public URLs); **server-side** extension + MIME + **magic-byte** + size validation behind a **`scan_status` gate** before extraction; AI returns **suggestions only**, parsed with a **strict allowlist (a safe SUBSET of the PR #30 writable fields** — the AI may not suggest `procurementOrgId`/`payingOrgId`, the org IDs that govern write authority) and re-run through `parseContractWriteInput` (PDF text + model output are **hostile** — prompt-injection defended, but the parser + RLS are the real boundary); the user **reviews + applies**, then **saves through the existing PR #30 RLS-gated action** (audited by `0010`). Future schema (`contract_id` same-tenant FK, `content_type`/`byte_size`/`sha256`/`scan_status`/`extraction_status`/`extraction_result_json`/…), future RLS (write = `0004` authority; `paying_org_id` never grants file write; default-deny + tests), and future DB-side file/extraction audit are all **specified, not built**.
- **Honest status:** PDF/AI extraction is **DESIGNED, NOT BUILT**; `files`/Storage remain **not surfaced** (default-deny). **No service-role app route**; any async worker must re-derive tenant authorization. A real implementation needs migrations + RLS + Storage + validation + an extraction worker + security tests, each its own PR.
- **Risk posture (unchanged):** **RISK-002 + RISK-016 remain OPEN.** **OMC/Flywheel cutover + new paid-customer onboarding remain BLOCKED.**
- **Tests run (local, verified):** `npm test` 51/51; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → **177** (`0001`–`0011`); `check-migration-safety` pass (no migration); `check-auth-safety` pass; `check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays.

---

### PR #32 — Add contract form parity fields · 2026-06-16
- **Category:** product surface + schema — closes the **low-risk, schema-backed** legacy contract-form gaps from PR #31. One forward migration `0011` (additive columns) + read/write/UI/test wiring. **No RLS/policy change, no service-role, no hosted apply, no DELETE/FOR ALL, no audit-trigger change.** RLS stays **177**. `database.types.ts` regenerated (schema changed).
- **Migration `0011_contract_form_parity_fields.sql`:** `alter table public.contracts add column` — `category text`, `procurement_date date`, `notes text`, `po_number text` (all nullable) + `auto_renew boolean not null default false`, `month_to_month boolean not null default false` (matching the `0001` boolean convention: `license_rules.active`, `license_evaluations.is_billable`). **Additive + non-destructive:** existing rows read NULL for the text/date columns and `false` for the two flags (Postgres backfills the default in place). The existing write authority (`0004`) and audit trigger (`0010`) govern the new columns automatically — no policy/trigger change. **Deliberately NOT added** (docs/15): legacy `commodity_software`/`commodity_leases` (hidden via `showif … && false`) and `validated` (legacy read-only / system-managed).
- **Read + write + UI wiring:** `ContractDetail` (+ `ContractSummary.category`) and the read DAL select/map now include the 6 fields; the create/edit form (`/contracts/new`, `/contracts/[id]/edit`) gains **Category** (`<select>` of the legacy options), **Procurement date**, **PO number**, **Notes** (textarea), **Auto renew** + **Month-to-month** (checkboxes); the detail page shows them and the list adds a **Category** column. The parser (`contract-write.ts`) handles the new nullable text/date (empty→null) and the two booleans (strict `=== true`, NOT NULL never written as null; create always sets, update PATCH-only). Still posts to the **PR #30** RLS-gated actions; `tenant_id` never sent; accepted saves audited by `0010`.
- **Tests — `npm test` 44 → 51 (7 new across `contract-write.test.ts` + `contract-form-shared.test.ts`):** create/update map the new fields; empty nullable→null; booleans default false / round-trip as real booleans / coerce a hostile non-boolean to false (never null); invalid `procurement_date` rejected; update PATCH touches only provided new fields; the hostile-keys test now also proves caller `actor_user_id`/`action`/`created_at` (audit fields) are never carried into the columns. **No new SQL** — the write authority + audit-once + no-DELETE are unchanged and already proven by `org_rls_test.sql` T9/T14/T20/T21/T31/T32; `test-rls.sh` re-applies `0001`–`0011` and stays **177**.
- **Parity still Partial (no overclaim):** more legacy fields now supported, but NOT Same — `commodity_*` + `validated` deliberately omitted; PDF-upload/AI extraction, **gantt**, **delete/archive**, app-contract **link/unlink**, files/invoices remain **not built**; legacy list-page inline-edit + bulk-delete not built. See [15](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)/[14](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md).
- **Risk posture (unchanged):** **RISK-002 + RISK-016 remain open.** **OMC/Flywheel cutover + new paid-customer onboarding remain blocked.**
- **Tests run (local, verified):** `npm test` 51/51; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged — `/contracts/new` + `/contracts/[id]/edit`); `test-rls.sh` → **177** (`0001`–`0011`); `check-migration-safety` pass (`0011` forward-only); `check-auth-safety` pass; `check-docs-updated` pass; `gen-types-local.sh` → `database.types.ts` updated with the 6 columns (no other drift); no `* 2.*`/`* 3.*` source strays.

---

### PR #31 — Add contract create and edit UI · 2026-06-16
- **Category:** product surface — **first user-visible contract WRITE workflow.** New `/contracts/new` + `/contracts/[id]/edit` routes, a shared form, a small RLS-scoped org-list read DAL, and pure form helpers + unit tests. **No migration, no RLS/policy change, no service-role, no hosted apply, no `database.types.ts` change.** RLS stays **177**.
- **Legacy inspected FIRST (no invented UI):** read the legacy sources before coding and recorded the workflow + the exact legacy→v3 field mapping + the not-ported anti-patterns in **new [docs/15_LEGACY_CONTRACT_FORM_INSPECTION.md](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)** (legacy `contracts/create/page.tsx`, `contracts/[id]/page.tsx`, `contracts/page.tsx`, `shared/fieldDefinitions.js`, `webapp/functions/.../contractOnWrite.js`). **Parity is Partial, not Same** (see below).
- **Routes / UI:** `/contracts` gains a **New contract** button; `/contracts/[id]` gains an **Edit** link. `/contracts/new` (server shell + RLS-scoped org options) and `/contracts/[id]/edit` (prefilled from the RLS-scoped read DAL; a contract you can't read → the same generic "not found" as a non-existent id — no enumeration). The form (`contract-form.tsx`, Client Component) posts to the **PR #30** `createContractAction` / `updateContractAction`; on success it redirects to `/contracts/[id]`; Cancel → `/contracts` (create) or `/contracts/[id]` (edit).
- **Supported fields (v3 columns only):** `contract_name`\* , `vendor_name`, `status` (legacy options Draft/Executed/Cancelled/Expired, default Draft), `total_cost` + `currency`, `start_date`, `renewal_date`, `end_date` ("Expiry / end date"), `renewal_responsibility`, and `procurement_org_id` (write anchor) + `paying_org_id` (read signal) via **RLS-scoped org `<select>`** (`listOrganizationsForCurrentUser` — relies only on the existing `organizations` read policies; no broad/cross-tenant reads, no service-role).
- **Authorization = RLS, not the UI:** affordances are shown to any viewer for usability (v3 does **NOT** port legacy's client-side `user.role` gate); the **server action + DAL + RLS** decide. A denied save → generic `not_allowed` ("you don't have permission, or it no longer exists"); `invalid_input` → inline field issues; never reveals whether a forbidden contract exists. `tenant_id` is never sent (resolved server-side). Accepted saves are audited by the **0010** trigger; the UI writes no audit rows and adds no service-role path.
- **NOT built (matches legacy gaps / out of scope):** PDF upload + AI extraction, **delete/archive**, app link/unlink + cost allocation, file/invoice attachments, groups, renewal **gantt**, import/export. Legacy form fields v3 **cannot** support yet (no column): `category`, `procurementDate`, `notes`, `poNumber`, `autoRenew`, `monthToMonth`, `commodity_*`, `validated` → **Partial** parity, tracked in [14](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md)/[15](./15_LEGACY_CONTRACT_FORM_INSPECTION.md). Legacy edited **inline**; v3 uses a dedicated `/edit` route (same workflow, different placement — documented).
- **Tests — `npm test` 36 → 44 (new `contract-form-shared.test.ts`, 8 cases):** pure form helpers — `emptyContractForm` defaults, `contractDetailToForm` (nulls→"", number→string, status preserved), `formToWriteInput` (1:1 camelCase map; carries no `tenant_id`/`id`), `statusOptionsForValue` (preserves an unknown current value), `writeErrorMessage` (generic, non-enumerating). No DOM/component tests (no brittle hosted-Supabase or testing-library dependency). **No new SQL** — the write authority + audit + no-DELETE are already proven by `org_rls_test.sql` T9/T14/T20/T21/T31/T32; the form posts through the same PR #30 path. RLS stays **177**.
- **Risk posture (unchanged):** **RISK-002 + RISK-016 remain open.** **OMC/Flywheel cutover + new paid-customer onboarding remain blocked** (Partial parity is not a cutover signal).
- **Tests run (local, verified):** `npm test` 44/44; lint clean; `tsc --noEmit` clean; `next build` clean — routes now include `/contracts/new` + `/contracts/[id]/edit`; `test-rls.sh` → **177** (unchanged); `check-migration-safety` pass (no migration); `check-auth-safety` pass (no service-role; client form imports only React/Next + the server actions + a type); `check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays.

---

### PR #30 — Add contract write server actions · 2026-06-16
- **Category:** backend / application write-path — **invisible to users.** New server-side DAL write functions + pure input helpers + `"use server"` actions + unit tests. **No migration, no RLS/policy change, no UI, no route, no field, no workflow, no service-role, no hosted apply, no `database.types.ts` change.** RLS stays **177** assertions (no new SQL).
- **Why:** add the safe server-side contract create/update **path** the future create/edit UI will call — the last missing piece before that UI. The write **RLS authority** (`0002`/`0004`) and **audit-on-write** (`0010`, PR #29) already exist; this PR adds only the *application path* that rides on them. Same product experience, better backend, no user-visible regression. See [13 §4](./13_CONTRACT_STEWARD_WRITE_DESIGN.md), [09](./09_AGENT_HANDOFF.md).
- **DAL (`src/lib/data/contracts.ts`):** `createContractForCurrentUser(input)` and `updateContractForCurrentUser(contractId, input)` use the **same user-scoped anon server client** (`@/lib/supabase/server`) as the reads — **never** a service-role/admin client. RLS (`0004`: tenant editor+ **or** procurement-org `manager`; `paying_org_id` never grants write; no `DELETE`/`FOR ALL`) is the authorization boundary; the app authorizes nothing beyond session/context resolution + input validation. Create stamps `tenant_id` from the actor's **server-resolved** context (`resolveTenantContext` → `resolveWriteContextTenantId`); update never sets `tenant_id` (row tenant is immutable via this path). Returns a typed `ContractWriteResult` — `invalid_input` (with issues), `not_authenticated`, `no_tenant`, `not_allowed`, `query_failed`, or `{ ok, id }`.
- **Pure helpers (`src/lib/data/contract-write.ts`, IO-free, unit-tested):** `parseContractWriteInput` (trust-boundary shape validation: required `contract_name`, empty→null for nullable columns, default-bearing `status`/`currency`/`renewal_responsibility` omitted when empty so DB defaults apply, date `YYYY-MM-DD` + UUID + finite-number checks, PATCH semantics on update with a "no fields to update" guard) — **never reads a caller `tenant_id`/`id`** (no such field; verified by test). `resolveWriteContextTenantId` (active tenant, or an org-only steward's single org tenant, else null). `classifyContractWriteError` (`42501`/`23514`/`23503` → `not_allowed`, indistinguishable from not-found so the path can't enumerate other tenants; any other code → `query_failed`, never swallowed as success).
- **Server actions (`src/app/(authenticated)/contracts/actions.ts`, `"use server"`):** `createContractAction` / `updateContractAction` — thin wrappers over the DAL, the RPC boundary the future UI will call. **Not wired to any UI** (an `actions.ts` file adds no route; `next build` routes unchanged: `/`, `/apps`, `/apps/[id]`, `/contracts`, `/contracts/[id]`, `/login`, `/logout`).
- **Audit inherited, not re-implemented:** an accepted insert/update is audited automatically by the `0010` `AFTER` trigger (`contract.created`/`contract.updated`, actor = caller). This code does **not** write `audit_logs` and adds **no** service-role audit route. A denied/failed write is never audited (trigger is `AFTER ROW`) — already proven by **T31** at the SQL layer.
- **Tests — `npm test` 12 → 36 (new `contract-write.test.ts`, 24 cases):** input shaping/validation (required name; empty→null; defaults omitted vs set; date/uuid/number validation; PATCH semantics; empty-update rejected; caller `tenant_id`/`id`/`owner_user_id` never carried into columns), error classification, and tenant resolution (member / single-org steward / multi-tenant-ambiguous → null). **No new SQL assertions:** the write authority + audit + no-DELETE/no-FOR-ALL are already proven by `org_rls_test.sql` **T9/T10/T14/T20/T21/T31/T32** (mapped in [13 §7](./13_CONTRACT_STEWARD_WRITE_DESIGN.md)); the app path issues the same RLS-gated `INSERT`/`UPDATE`, so duplicating them would add no coverage.
- **No-service-role guard:** `check-auth-safety.sh` scans `src/` for `service_role`/`SUPABASE_SERVICE_ROLE` (incl. the new files) — passes; the only Supabase client constructors remain the anon browser/server clients, and the server client's `next/headers` import keeps the write DAL out of any client bundle.
- **Still not built (no overclaim):** contract create/edit **UI** does **not** exist; contract create/edit **legacy parity is still missing**. No archive/soft-delete, no `app_contracts` writes, no hard delete. Next: the create/edit UI matching the legacy contract-form workflow, after exact legacy field/button/filter inspection ([14 §3/§9](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md)).
- **Risk posture (unchanged):** **RISK-002 + RISK-016 remain open.** Invisible backend improvement — **no user-visible workflow changed.** **OMC/Flywheel cutover + new paid-customer onboarding remain blocked.**
- **Housekeeping:** removed two stray untracked `* 2.*` sync-artifact duplicates from the working tree (`supabase/migrations/0010_… 2.sql`, byte-identical to the committed migration — it had been breaking `check-migration-safety`; and a stale `docs/14_… 2.md` superseded by the tracked file). Neither was tracked; no committed file changed.
- **Tests run (local, verified):** `npm test` 36/36; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (0001–0010, **177** assertions, unchanged); `check-migration-safety` pass (no migration added); `check-auth-safety` pass; `check-docs-updated` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays.

---

### PR #29 — Add contract audit-on-write trigger · 2026-06-16
- **Category:** backend/security — **invisible to users.** One forward migration `0010` (a trigger + its function) + new tests. **No UI, no route, no workflow, no field, no policy/authz change, no service-role, no hosted apply, no `database.types.ts` change.**
- **Why:** record every contract `INSERT`/`UPDATE` the DB accepts **before** any contract write UI/server action exists. `audit_logs` is append-only with **no `authenticated` INSERT policy**, so the only safe writer is a DB-side `SECURITY DEFINER` trigger — **never** a service-role app route (which would also bypass tenant RLS everywhere). See [13 §4](./13_CONTRACT_STEWARD_WRITE_DESIGN.md), [09](./09_AGENT_HANDOFF.md).
- **Migration `0010_contracts_audit_on_write.sql`:** function `public.audit_contract_write()` (`security definer`, `set search_path = public`, owned by the migration owner) + trigger `contracts_audit_on_write` `AFTER INSERT OR UPDATE ON public.contracts FOR EACH ROW`. Appends **one** `audit_logs` row per accepted write: `action` = `contract.created`/`contract.updated`, `resource_type` = `contract`, `resource_id` = `NEW.id`, `tenant_id` = `NEW.tenant_id`, `actor_user_id` = `auth.uid()`, and a **curated non-sensitive** allowlist in `after_json` (`contract_id`, `contract_name`, `operation`, `status`, `procurement_org_id`, `paying_org_id` — **no** costs/dates/notes/legal text, **no** full OLD/NEW dump; `before_json` left NULL).
- **Does NOT change authorization:** existing write RLS (`0002`/`0004` — tenant editor+ **or** procurement-org `manager`; `paying_org_id` never grants write) still decides who may write; **no** new policy, **no** `DELETE`, **no** `FOR ALL`, **no** `authenticated` INSERT on `audit_logs`.
- **Actor correctness under SECURITY DEFINER:** definer changes only the executing *role* (so it may append to the append-only table); it does **not** change session GUCs, so `auth.uid()` resolves to the **caller** (the writing user) — not the owner, not `service_role`. Proven by two writes with **different** actors (editor vs org-manager) both recording the exact writer.
- **AFTER, so failed/denied writes never audit:** RLS-denied writes affect 0 rows (trigger never fires); a cross-tenant org pointer is rejected by `enforce_owning_org_tenant` (raise, before AFTER) — no audit row in either case.
- **Tests — T31 (audit-on-write) + T32 (catalog), `153 → 177` assertions, T1–T32:** allowed tenant-editor INSERT and org-manager INSERT each audit exactly once with the correct actor; allowed UPDATE audits once (no duplicate create); a paying-org reader cannot UPDATE/INSERT (read ≠ write) and nothing audits; an unrelated org member's denied UPDATE adds no row; a cross-tenant pointer INSERT is rejected and **not** audited. T32 asserts straight from the catalog: contracts have **0 DELETE** and **0 `FOR ALL`** policies; `audit_logs` has **no** INSERT/UPDATE/DELETE/ALL policy; the function is **SECURITY DEFINER**; the trigger is **AFTER INSERT OR UPDATE**. (T6/T8 unchanged — still prove `authenticated` cannot directly write/forge an audit row.)
- **Generated types:** `database.types.ts` **unchanged** — a trigger function (returns `trigger`) is excluded from generated function types; `gen-types-local.sh` reproduces it byte-identically.
- **Still not built (no overclaim):** contract write **path** (server action) and contract create/edit **UI** do **not** exist; contract create/edit **parity is still missing**. Next: the write path/server action (land [13 §7](./13_CONTRACT_STEWARD_WRITE_DESIGN.md) tests **before** UI), then the create/edit UI matching the legacy contract-form workflow ([14 §3](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md)).
- **Risk posture (unchanged):** **RISK-002 + RISK-016 remain open.** Invisible backend improvement — **no user-visible workflow changed.** **OMC/Flywheel cutover + new paid-customer onboarding remain blocked.**
- **Tests run (local, verified):** `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (0001–0010, 177 assertions); `npm test` 12/12; lint clean; `tsc --noEmit` clean; `next build` clean (routes unchanged); `check-migration-safety` pass (0010 forward-only); `check-auth-safety` pass; `gen-types-local.sh` → no diff; no `* 2.*`/`* 3.*` strays.

---

### PR #28 — Document legacy UX and workflow parity map · 2026-06-16
- **Category:** product-readiness / parity contract — **docs only. No migration, no RLS change, no UI, no code, no `database.types.ts` change.** New doc [14_LEGACY_UX_WORKFLOW_PARITY_MAP](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md).
- **What:** the exact legacy→v3 parity contract so v3 becomes a **same-product-experience / better-backend replacement** with **no user-visible regression**. Defines the doctrine, a glossary (Same / Better-approved / Missing / Intentionally-removed / Cutover-blocker / Backend-only / User-visible / parity / exact-output-parity / approved-replacement), a **legacy route/screen parity table** (12 columns, ~26 legacy areas) and a **current v3 route parity table** (`/`, `/login`, `/logout`, `/apps`, `/apps/[id]`, `/contracts`, `/contracts/[id]`), the **release/cutover gate**, a new **PR review rule**, the **backend-improvement policy**, the **re-ranked implementation order** (parity map → contract audit-on-write → contract create/edit → link/unlink → import → UAR → stale → exports → license/spend/files/invoices → hosted apply), and an explicit **`needs legacy inspection`** unknowns list.
- **Honesty discipline:** the legacy source (`frontend-v2/`,`webapp/`,`extension/`) is **outside this repo**, so legacy *routes/goals* come from documented evidence ([11]) but **exact fields/button-labels/filters/sorts/export formats are marked `needs legacy inspection` — not invented**. No legacy workflow is yet **Same**; shipped v3 surfaces are **Partial** (read-only subsets).
- **Release rule recorded:** cutover is blocked on **workflow parity**, not backend/RLS readiness alone; an unapproved user-visible change is a blocking review finding; backend-only improvements are exempt from product approval but never copy a legacy backend anti-pattern.
- **Other docs:** `00` (parity doctrine), `07` (new P0 line — user-visible workflow changes need parity approval), `09` (next-task = contract audit-on-write, must preserve legacy parity), `10` (index), `11` (points to the detailed map), `06` (roadmap re-ranked around parity).
- **Risk posture (unchanged):** RISK-002 + RISK-016 **open**; hard delete blocked; contract writes/audit/UI not built; **OMC/Flywheel cutover + new paid-customer onboarding blocked**.
- **Tests run (local, verified):** `npm test` 12/12; lint/tsc/build clean; `test-rls.sh` → 153 (unchanged); `check-*`/`gen-types-local.sh` → no diff.

---

### PR #27 — Harden app-contract link read tenant binding · 2026-06-16
- **Category:** RLS hardening (defense-in-depth). Forward migration `0009` (replaces one SELECT policy) + one new test. **No schema/types change, no UI, no write path, no service-role, no hosted apply.**
- **Migration `0009_harden_app_contracts_read_tenant_bind.sql`:** `drop`+recreate the `0006` org-scoped `SELECT` policy `org members read related app_contracts`, now pinning `a.tenant_id = app_contracts.tenant_id` (app branch) and `c.tenant_id = app_contracts.tenant_id` (contract branch) explicitly — matching the standard already set by `0007` (app_users) and `0008` (matches). The policy is now **self-sufficient for tenant isolation** rather than relying solely on the `0005` same-tenant FKs. **SELECT only**; the tenant-member read and editor `INSERT`/`UPDATE` (`0004`) are untouched; **no `DELETE`, no `FOR ALL`**. `0006` is **not edited** (forward migration only). No other table changed (`people`/`identity_accounts`/`license_*`/`files`/`invoices` not broadened).
- **Behavior unchanged for valid data:** the `0005` FKs already force a link's `tenant_id` to equal its app's and contract's, so the added clause is always true for real rows. Confirmed empirically (valid links still read identically) and by **T28** staying green.
- **Tests:** **T28h** (1 assertion) plants a normally-impossible FK-bypassed corrupt cross-tenant link (tenant B, but `(app_id, contract_id)` point at a tenant-A App A1 + a tenant-A contract `mgr_a1` can read) and proves the explicit tenant-bind hides it — a weak-vs-hardened check confirmed the old `0006` policy would leak it (1) while `0009` denies it (0). T29 (app_users) + T30 (match status) + the valid T28 behavior all still pass. **152 → 153 assertions**, T1–T30.
- **Generated types:** `database.types.ts` **unchanged** — a policy is not schema; `gen-types-local.sh` reproduces it byte-identically.
- **RISK-002 / RISK-016:** **both remain open.** Hardening only — no read scope expanded, no risk closed. Hard delete blocked. Contract writes/audit/UI still **not built**. OMC/Flywheel cutover **blocked**.
- **Tests run (local, verified):** `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (0001–0009, 153 assertions); `npm test` 12/12; lint/tsc/build clean; `check-migration-safety` pass (0009 forward-only, 0006 byte-identical); `gen-types-local.sh` → no diff.

---

### PR #26 — Correct current-state docs after contract write design · 2026-06-16
- **Category:** docs/readiness correction — **docs only. No code, no migration, no RLS change, no `database.types.ts` change, no feature work.**
- **What:** a current-state truth pass. A deep review found no confirmed P0 / cross-tenant leak / service-role bypass / hard-delete regression; the live issue was **stale canonical docs**. A 4-agent audit found **30 stale claims** (built read-only surfaces described as "no product UI"; narrative frozen around PR #5/#6 while the status *tables* stayed current; stale counts/migration ranges). All fixed.
- **Fixed:** `00` (Current phase, Merged-PRs section, verified stamp `ee59c6c`→`84140b6`, Next-PRs, "Can we…?" + explicit paid-customer-onboarding-blocked); `01` (Frontend status, repo-structure block, "Current"/"Intentionally missing"); `06` (intro + stage table — read-only stages 4–6 now `implemented`); `09` (Current-repo-state header; migration range `0001`–`0003`/`0005`→`0001`–`0008`); `10` ("v3 product UI is planned"→ read-only UI implemented); `11` ("no product UI exists yet", §3 narrative, OMC acceptance rows, "66"→152 assertions); `03` (migration table extended `0006`/`0007`/`0008`); `04` (RISK-C03 "83"→full suite). New review note `docs/reviews/PR26_DOCS_TRUTH_PASS.md`.
- **Risk posture (unchanged):** RISK-001 / RISK-002 / RISK-016 **open**; hard delete blocked; OMC/Flywheel cutover **blocked**; new paid-customer onboarding **blocked**.
- **Go/no-go recorded:** contract audit-on-write = yes (next); contract write UI = no (audit first); OMC cutover = no; paid customer = no.
- **Tests run (local, verified):** `npm test` 12/12 (unchanged); lint/tsc/build clean; `test-rls.sh` → 152 assertions (unchanged); `check-*`/`gen-types-local.sh` → no diff.

---

### PR #25 — Document contract steward write design · 2026-06-16
- **Category:** security design / guardrail — **docs only. No migration, no RLS change, no UI, no audit, no write path, no `database.types.ts` change.** New doc [13_CONTRACT_STEWARD_WRITE_DESIGN](./13_CONTRACT_STEWARD_WRITE_DESIGN.md).
- **Verified finding (not a guess):** the contract write **RLS authority already exists** — shipped in `0002`, split into `INSERT`/`UPDATE` (no `DELETE`) by `0004`. A live `pg_policies` dump on a fresh `0001`–`0008` DB confirms: `editors insert/update contracts` (`has_tenant_role` owner/admin/editor) **+** `org managers insert/update org contracts` (`has_org_role_in_tenant(procurement_org_id, …, ['manager'])`), **0** `DELETE`/`ALL` policies, and the `enforce_owning_org_tenant` trigger covering `procurement_org_id`+`paying_org_id`. It already matches the recommended steward model.
- **What the doc designs (the real gap):** the **application write path** (server action on the anon user-scoped client — never service-role; input validation that is *not* authorization), **audit-on-write** (must be a DB-side `SECURITY DEFINER` trigger because `audit_logs` is append-only with no `authenticated` INSERT path — *not* a service-role route; a future migration, deferred), and **UI** (RLS is the boundary; no client-side filtering for authz). It documents who can/cannot write (procurement-org steward `manager` + tenant editor+; **`paying_org_id` = read only, not write**; read ≠ write), cross-tenant prevention (trigger + `WITH CHECK`), the no-hard-delete posture (no `FOR ALL`/`DELETE`), and the **exact tests** a future write PR must prove — mapping each to existing coverage (T21 paying-org-no-write, T14 cross-tenant write, T22/T23 trigger, T17/T24 hard-delete) and flagging the new ones (audit-event, explicit positive steward INSERT, a `pg_policies` 0-`DELETE`/`ALL` guard).
- **Out of scope:** contract archive/soft-delete (separate design), `app_contracts` link writes, files/invoices/license, identity/people.
- **Honest status:** contract write **UI/path/audit not implemented**; archive/soft-delete not implemented; hard delete blocked (`0004`) and stays blocked. RISK-002 **open**, RISK-016 / OMC parity **open**, OMC/Flywheel cutover **blocked**.
- **Tests run (local, verified):** `npm test` 12/12; lint/tsc/build clean; `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (152, unchanged); `check-*`/`gen-types-local.sh` → no diff.

---

### PR #24 — Add read-only app account intelligence summary · 2026-06-16
- **Category:** read-only product surface (derived data). **No migration, no RLS change, no schema/types change, no new policy.**
- **What:** a small "Account summary" card on `/apps/[id]`, computed **purely** from data the user can already read — the visible `app_users` roster (`0007`) and the visible `app_user_identity_matches` rows (`0008`). New **pure** helper `src/lib/data/app-account-intelligence.ts` (no DB, no imports, no service-role) + unit tests.
- **Shows:** visible accounts, matched, unmatched, match rate, status breakdown (active / inactive / unknown), and stale candidates (>90d from the account's own `last_active_at`). All counts derive from direct `app_users` columns + match-row existence.
- **Deliberately conservative (no overclaim):** "unmatched" = no visible match row for a visible account; "stale candidate" = the account's own `last_active_at` looks older than a fixed 90d threshold — **not** confirmed stale; status buckets come only from the app_user's own `status` text (null/unrecognized → "unknown", never inferred). **This is NOT UAR.** No "orphaned"/"deactivated"/"managed" label, no identity matching algorithm, no people merge, no license evaluation, no provisioning.
- **Does NOT read or expose:** `people`, `identity_accounts`, `license_*`, `files`, `invoices`, raw payloads, person ids, identity-account ids, IdP provider/status fields. The summary's `noPersonDataUsed`/`noIdentityAccountDataUsed` flags are literal `true`.
- **Tests:** `src/lib/data/app-account-intelligence.test.ts` (7 cases: empty roster, all-matched + dedup of multiple match rows, some-unmatched + stray-match-id guard, stale threshold, null `last_active_at` = unknown not stale, status null/unrecognized = unknown, needs only roster+matches). **`npm test` 5 → 12 tests.** **No RLS change → `test-rls.sh` stays at 152 assertions.**
- **RISK-002 / RISK-016:** **both remain open.** No table read scope changed. OMC/Flywheel cutover remains **blocked**.
- **Generated types:** unchanged (no schema change). No service-role, no hosted apply, no write/delete surface.
- **Tests run (local, verified):** `npm test` 12/12; lint/tsc/build clean (`ƒ /apps/[id]`); `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (152, unchanged); `gen-types-local.sh` → no diff.

---

### PR #23 — Add org-scoped read access for app-user matches · 2026-06-16
- **Category:** RLS narrowing + read-only product surface. Forward migration `0008` (one SELECT policy) + a minimal match-status column. Implements [12_IDENTITY_MATCHING_READ_SCOPE](./12_IDENTITY_MATCHING_READ_SCOPE.md) §5 (validated in PR #22).
- **Migration `0008_org_scoped_app_user_identity_matches_read.sql`:** `app_user_identity_matches` was **default-deny**; this adds ONE permissive `SELECT` policy `org members read related app_user_identity_matches` — read a match row iff you can already read the linked **`app_user`** (itself org-scoped by `0007`), via `EXISTS (select 1 from app_users au where au.id = ... and au.tenant_id = ...)` with an **explicit tenant-bind**. A tenant member reads all tenant matches transitively (they read all tenant app_users); an org-only user reads only matches of app_users they can read. **SELECT only**; no write policy (matching writes are service-role/definer); **no `DELETE`**. `people` and `identity_accounts` are **untouched**.
- **Tests:** **T30** (18 assertions): tenant owner reads all 3 tenant matches; org-only `mgr_a1` reads only App A1's match; `mgr_a2` reads App A-pay + App A2; `agency_u` reads only App A-pay; `owner_b` (other tenant) and a pure non-member read **0**; a match read grants **no** `people`/`identity_accounts` read (org-only still 0); org-only delete denied (no DELETE policy); `app_users` (T29) + `app_contracts` (T28) org-read still hold; and **T30h** plants an FK-bypassed corrupt cross-tenant match and proves the explicit tenant-bind hides it. Updated **T27 27a** / **T29 29f** (app_user_identity_matches dropped from their default-deny assertions). **136 → 152 assertions**, T1–**T30**.
- **Generated types:** `database.types.ts` **unchanged** — a policy is not schema; `gen-types-local.sh` reproduces it byte-identically.
- **Read-only UI:** `/apps/[id]` app-user roster gains a **"Match"** column (matched / unmatched, optional `match_method`/`confidence`) via new typed DAL `src/lib/data/app-user-matches.ts`. **Unmatched is derived server-side** by comparing the visible roster against visible match rows — never by reading `people`/`identity`. Shows **no** `person_id`, identity-account id, person name, IdP provider/email/status, or `raw_payload`.
- **RISK-002:** **narrowed, NOT closed** — `app_contracts` (PR #20), `app_users` (PR #21), and now `app_user_identity_matches` (PR #23) read are org-scoped. `people` stays tenant-only; `identity_accounts`/`license_*`/`files`/`invoices` stay default-deny.
- **Not built (honest):** no identity matching algorithm, no people merge, no UAR / orphaned / deactivated status, no provisioning/deprovisioning, no import/export, no write/review UI. `people` and `identity_accounts` org-read intentionally **not** added.
- **Security / service-role / hosted impact:** no service-role, no hosted apply, no `db push`/`--linked`. Read-only, tenant-bound (no cross-tenant leak — T30 + live spot-check). OMC/Flywheel cutover remains **blocked**.
- **Tests run (local, verified):** `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (0001–0008, 152 assertions); `npm test` 5/5; lint/tsc/build clean (`ƒ /apps/[id]`); `check-migration-safety` pass; `gen-types-local.sh` → no diff.

---

### PR #22 — Document identity matching read-scope design · 2026-06-16
- **Category:** security design / guardrail — **docs only. No migration, no schema/types change, no UI, no policy, no new test assertions.**
- **What:** a precise, evidence-based design for how identity / account / matching data may be safely **read** in future PRs, before any implementation. New doc [12_IDENTITY_MATCHING_READ_SCOPE](./12_IDENTITY_MATCHING_READ_SCOPE.md).
- **Decision (recommended safe model):** scope every identity/match view from the **app / app_user side** the user can already read — never from the `people` or `identity_accounts` side.
  - `people` stays **tenant-only** (a full HR directory; no honest owning-org column → not org-scopable). App-user views show the app_user's own `display_name`/`email`, never join to `people`.
  - `identity_accounts` stays **default-deny** (anchors to `person_id`, not to an app → no app-side path → org-scoping it would be a tenant-wide IdP leak).
  - The **only** future org-scoped identity read is `app_user_identity_matches`, gated on a **readable `app_user`** (one `SELECT` policy mirroring `0007`, with explicit tenant-bind; SELECT-only, no DELETE; writes via service-role/definer). It exposes match *status* (matched/unmatched, `match_method`, `confidence`), not person PII; `person_id` stays an opaque id.
  - "Managed vs orphaned" (needs `people`/`identity` status) should use a **`security_invoker` view** (caller RLS scopes it) by default; a `SECURITY DEFINER` function is allowed only when a tenant-only column is required, and then it **must re-derive the caller's scope explicitly** — the doc warns that a definer bypasses RLS.
  - The doc lists the **exact future policy shape** (§5) and the **exact tests** a future PR must pass **before any UI** (§7).
- **Adversarial review hardening:** an agent empirically validated the recommended §5 policy on a throwaway DB (correctly app-anchored, no people/identity leak, planted-corrupt-row denied) and caught a real gap in the §4 status-view guidance — a naive `SECURITY DEFINER` function ignores caller RLS and returned status for **all** tenant app_users (5) to an org-only user who should see 2. Fixed: §4 now defaults to a `security_invoker` view (empirically returns only the readable rows), warns about the definer trap, and §7.7 now requires an **exact readable-app_user-only count** (not just "no person columns"). Also corrected a §8 citation (29a is the owner baseline; org-only proof is 29b–29d).
- **Tests:** **none added** — the current guardrails are **already proven** by **T27 27a** (tenant owner reads 0 `identity_accounts`/`app_user_identity_matches`), **T27 27b**/**T29 29f** (org-only user reads 0 `people`/`identity_accounts`/`app_user_identity_matches`), and **T29 29a–29g** (`app_users`/`app_contracts` org-read). Doc 12 §8 + `rls_test_plan` map the guardrail to these instead of duplicating assertions. **136 assertions, T1–T29 (unchanged).**
- **Honest status:** identity matching **not implemented**; unmanaged-account/UAR/stale report **not implemented**; `identity_accounts` read **not implemented**; `people` org-read **not implemented**. RISK-002 **open** (narrowed only for `app_contracts`/`app_users`). RISK-016 / OMC parity **open**. OMC/Flywheel cutover **blocked**.
- **Impact:** no migration, no `database.types.ts` change, no service-role, no hosted apply, no product routes. Pure design + docs.
- **Tests run (local, verified):** `npm test` 5/5; lint/tsc/build clean; `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (136, unchanged); `check-*`/`gen-types-local.sh` → no diff.

---

### PR #21 — Add org-scoped read access for app users · 2026-06-16
- **Category:** RLS narrowing + read-only product surface. Forward migration `0007` (one SELECT policy) + read-only roster UI.
- **What:** unblocks a read-only **per-app user roster** by first making `app_users` org-scoped for **read**, then showing it on `/apps/[id]`.
- **Migration `0007_org_scoped_app_users_read.sql`:** adds ONE permissive `SELECT` policy `org members read related app_users` — an org-only user may read an `app_users` row iff they can already read the linked **app** under their existing related-org RLS (the `EXISTS (select 1 from apps ...)` subquery reuses `apps` RLS). The subquery **also pins `a.tenant_id = app_users.tenant_id` explicitly** (mirroring `0003`), so the policy is self-sufficient for tenant isolation rather than relying solely on the `0005` same-tenant FK (defense-in-depth raised in adversarial review). **SELECT only** — the tenant-member read and editor `INSERT`/`UPDATE` (`0004`) are unchanged; **no `DELETE`** added. No other table changed.
- **Tests:** **T29** (24 assertions): tenant owner reads all 4 tenant-A app_users; org-only `mgr_a1` (OrgA1) reads only App A1's 2 users; `mgr_a2` (OrgA2) reads App A-pay (responsible) + App A2; `agency_u` (OrgA3) reads only App A-pay (paying); `owner_b` (other tenant) reads only its own tenant-B user (0 tenant-A); a pure non-member (`nobody`) reads **0**; an org-only delete is denied (no DELETE policy — row survives); `people`/`identity_accounts`/`app_user_identity_matches`/`license_*`/`invoices`/`files` still read **0** for an org-only user (no broadening); `app_contracts` T28 behavior still holds; and **T29h** plants a normally-impossible FK-bypassed corrupt cross-tenant row and proves the explicit tenant-bind keeps it hidden. Updated **T27**/**T28** (app_users dropped from their tenant-only/default-deny-only assertions). **114 → 136 assertions**, T1–**T29**.
- **Generated types:** `database.types.ts` **unchanged** — a policy is not schema; `gen-types-local.sh` reproduces it byte-identically.
- **Read-only UI:** `/apps/[id]` gains an "App users" section via a new typed DAL `src/lib/data/app-users.ts` (`listAppUsersForApp`). Shows **direct `app_users` columns only** (name, email, external id, status, license type, last active) — `raw_payload`/`source` excluded. **No** identity matching, person/identity joins, license utilization, provisioning, deprovisioning, edit/remove, or import/export.
- **RISK-002:** **narrowed, NOT closed** — `app_contracts` (PR #20) and now `app_users` (PR #21) read are org-scoped. `people` stays tenant-only; `identity_accounts`/`app_user_identity_matches`/`license_*`/`files`/`invoices` stay default-deny.
- **Security / service-role / hosted impact:** no service-role, no hosted apply, no `db push`/`--linked`. Read-only, tenant-bound (proven no cross-tenant leak via T29 + a live spot-check). No write/delete/provisioning surface.
- **OMC/Flywheel:** cutover remains **blocked**.
- **Tests run (local, verified):** `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (0001–0007, 136 assertions); `npm test` 5/5; lint/tsc/build clean (`ƒ /apps/[id]`); `check-migration-safety` pass; `gen-types-local.sh` → no diff.

---

### PR #20 — Add org-scoped read access for app-contract links · 2026-06-16
- **Category:** RLS narrowing + read-only product surface. Forward migration `0006` (one SELECT policy) + read-only UI.
- **What:** unblocks read-only **linked apps / linked contracts** by first making `app_contracts` org-scoped for **read**, then using it.
- **Migration `0006_org_scoped_app_contracts_read.sql`:** adds ONE permissive `SELECT` policy `org members read related app_contracts` — an org-only user may read a link row iff they can already read the linked **app OR contract** under their existing related-org RLS (the `EXISTS` subqueries reuse `apps`/`contracts` RLS, granting nothing beyond "you can read one side"; `0005` same-tenant FKs keep it tenant-bound). **SELECT only** — the tenant-member read and editor `INSERT`/`UPDATE` (`0004`) are untouched; **no `DELETE`** added. No other table changed.
- **Tests:** **T28** (16 assertions): tenant owner reads all tenant links; org-only `mgr_a1` reads only L1+L3 (app-side), not unrelated L2; org-only `agency_u` reads only L2+L3 (contract-side), not L1; `owner_b` (other tenant) and a new `nobody` fixture (pure non-member) read **0**; and the default-deny/tenant-only tables (`app_users`/`identity_accounts`/`license_*`/`invoices`/`files`) still read **0** for an org-only user (no broadening leaked). Updated **T27** (app_contracts dropped from its tenant-only assertion). **98 → 114 assertions**, T1–**T28**.
- **Generated types:** `database.types.ts` **unchanged** — a policy is not schema; `gen-types-local.sh` reproduces it byte-identically.
- **Read-only UI:** `/contracts/[id]` gains a "Linked apps" section, `/apps/[id]` gains a "Linked contracts" section, via a new typed DAL `src/lib/data/links.ts` (`listAppsLinkedToContract`, `listContractsLinkedToApp`). Two RLS-filtered steps (read visible link rows → read those apps/contracts) so only readable rows render. **No linking/unlinking/editing.**
- **RISK-002:** **narrowed, NOT closed** — only `app_contracts` read is now org-scoped. `people`/`app_users` stay tenant-only; `identity_accounts`/`app_user_identity_matches`/`license_*`/`files`/`invoices` stay default-deny.
- **Security / service-role / hosted impact:** no service-role, no hosted apply, no `db push`/`--linked`. The new policy is read-only and tenant-bound (proven no cross-tenant leak via T28 + a live spot-check). No write surface, no invoice/file/license reads.
- **OMC/Flywheel:** cutover remains **blocked**.
- **Tests run (local, verified):** `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (0001–0006, 114 assertions); `npm test` 5/5; lint/tsc/build clean (`ƒ /contracts/[id]`, `ƒ /apps/[id]`); `check-migration-safety` pass; `gen-types-local.sh` → no diff.

---

### PR #19 — Add read-only contracts surfaces · 2026-06-16
- **Category:** product surface — **read-only** (`/contracts` + `/contracts/[id]`). No migration, no schema change.
- **What:** the next safe read surface, mirroring `/apps`. New typed server-only DAL `src/lib/data/contracts.ts` (`listContractsForCurrentUser`, `getContractDetailForCurrentUser`) returning explicit DTOs; new server-rendered routes `src/app/(authenticated)/contracts/page.tsx` and `contracts/[id]/page.tsx`; a `/contracts` link + badge on the authenticated home.
- **Data access:** reads **only direct `contracts` columns** via the user-scoped anon server client. RLS is the authorization boundary (tenant members + procurement/paying related-org union, `0002`/`0003`). No `tenant_id` from the caller; route `[id]` is a lookup key only — an unreadable id returns the same `not_found` as a missing one (no enumeration).
- **Intentionally NOT built (honest):** no create/edit/delete/archive, no import/export, no file upload, no invoices, **no linked-apps table** and **no app-contract linking UI**. The DAL queries **no** `app_contracts`, `invoices`, `files`, `license_rules`, `license_evaluations`, `identity_accounts`, or `app_user_identity_matches` — those child/link tables are tenant-only or default-deny and are not safe to surface (**RISK-002 stays open**).
- **Security / migration / service-role / hosted impact:** none beyond a new read surface. No migration (`0001`–`0005` untouched), `database.types.ts` unchanged, no service-role, no hosted apply, no RLS change, no child-read broadening.
- **OMC/Flywheel:** cutover remains **blocked** — this is a partial read-only slice, not contracts parity.
- **Tests run (local, verified):** `npm test` 5/5; lint/tsc/build clean (`ƒ /contracts`, `ƒ /contracts/[id]`); `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (98 assertions, unchanged); `gen-types-local.sh` → no diff. **RLS spot-check** (fresh migrated DB, my DAL's exact queries): owner_a `2|1|1`; org-only mgr_a1 `1|1|0` (procurement-org related); org-only agency_u `1|0|1` (paying-org related); owner_b (other tenant) `0|0|0`; member_x (non-member) `0|0|0`.

---

### PR #18 — Document and test child-table RLS read scope · 2026-06-16
- **Category:** security truth pass — **docs + tests only, no migration, no UI** (a guardrail before child read surfaces).
- **What:** an honest read-scope inventory of all 17 public tables, derived from **live `pg_policies`** on a fresh `0001`–`0005` DB (the SQL, not prose), plus a denial test that pins the current reality.
- **Key finding / correction:** docs were **overclaiming**. Old §8 / RISK-002 / test-plan called `files`/`invoices`/`license_rules`/`license_evaluations` "tenant-scoped" (implying readable) and said "org-only users may see tenant-wide child rows." Reality: those 6 tables are **default-deny** (RLS on, **no read policy** — `identity_accounts`, `app_user_identity_matches`, `license_rules`, `license_evaluations`, `files`, `invoices`); `people`/`app_users`/`app_contracts` are **tenant-only** (tenant members read, **org-only users read nothing**); only `apps`/`contracts`/`organizations` are org-readable. No table leaks cross-tenant.
- **Docs corrected:** `02 §8` rewritten as the **canonical read-scope inventory table** + explicit "`0005` is write-integrity only, not read authorization"; threat row #18 added; `04` RISK-002 reworded (kept **open**, the wrong "may see tenant-wide child rows" line removed); `06`/`07`/`09`/`11`/`rls_test_plan.md` de-conflated tenant-only vs default-deny; `11` invoices/identity/license rows no longer imply a verified read model.
- **Tests:** added **T27** (read-scope truth pass): 6 default-deny tables read **0** even by a tenant owner (despite seeded rows); 3 tenant-only tables read by owner but **0** by an org-only user; positive controls so the zeros are policy, not empty tables. **83 → 98 assertions**, T1–**T27**. Adds **no policy**, broadens **no** access.
- **RISK-002:** **open · clarified** — *not* closed (no org-scoped child read policies were implemented; this PR only documents + denial-tests the truth).
- **Generated types:** **unchanged** — no schema change (no migration); `gen-types-local.sh` reproduces the committed `database.types.ts` byte-identically.
- **Security / migration / service-role / hosted impact:** none — no migration, no policy change, no service-role, no hosted apply, no UI. Strictly documents and tests existing behavior.
- **Tests run (local, verified):** `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (0001–0005, T1–T27, 98 assertions); `npm test` 5/5; lint/tsc/build clean; `check-auth-safety`/`check-docs-updated`/`check-migration-safety` pass; `gen-types-local.sh` → no diff.

---

### PR #17 — Add same-tenant child integrity constraints · 2026-06-16
- **Category:** database / integrity hardening (no product UI).
- **What:** `0005_same_tenant_child_integrity.sql` — prevent cross-tenant child/link corruption at the
  constraint layer. Add `UNIQUE (id, tenant_id)` on 7 referenced parents (`apps`, `contracts`, `people`, `organizations`,
  `app_users`, `license_rules`, `files`) and 14 composite same-tenant FKs `(parent_ref, tenant_id) →
  parent(id, tenant_id)` on the child/link tables (`app_contracts`, `app_users`,
  `app_user_identity_matches`, `identity_accounts`, `license_rules`, `license_evaluations`, `invoices`).
- **Current integrity risk (closed — RISK-C08):** before this, a child row could claim `tenant_id = B`
  while pointing at a tenant-A parent; RLS hid it on read but the corrupt write succeeded.
- **What stayed deferred:** org-scoped child-table **reads** (RISK-002) and org-hierarchy
  **traversal/inheritance** (RISK-004) — this PR is write-integrity only (it makes `organizations.parent_org_id`
  stay in-tenant but adds no hierarchy visibility), not new read surfaces or product UI. `identity_accounts`
  gets a child FK (to `people`) but no `UNIQUE` (it is never a tenant-scoped parent).
- **Completeness:** an adversarial review caught two initially-omitted child references —
  `identity_accounts.person_id` and `organizations.parent_org_id` — both now covered (T26 proves each fails cross-tenant).
- **Migration impact:** new forward migration only (`0001`–`0004` untouched); **constraints only** — no
  table/column/RLS change, no data change. `MATCH SIMPLE` keeps nullable links valid; `ON DELETE NO ACTION`
  adds no cascade (PR #16 hard-delete protection intact).
- **Generated types impact:** **yes, verified** — composite FKs add FK Relationships metadata to
  `src/lib/database.types.ts` (+98 lines, Relationships-only; no Row/Insert/Update/column change). Regenerated
  via `gen-types-local.sh` and **included**.
- **RLS/test impact:** added **T26** (11 cross-tenant link inserts each rejected with `foreign_key_violation`;
  valid same-tenant + nullable links insert). RLS reads (T1/T25), hard-delete denial (T17/T24), audit
  immutability (T6) all still pass. 82 → **83 assertions**, T1–**T26**. Added license_rules/evaluations/files/invoices truncate entries.
- **Product / security / service-role / hosted impact:** none beyond stricter invalid-write prevention; `/apps`+`/apps/[id]` build/read unchanged; no service-role; hosted Supabase untouched.
- **Tests run (local, verified):** `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (0001–0005); `npm test` 5/5;
  `npm run lint`/`tsc --noEmit`/`build` exit 0; `check-migration-safety.sh`, `check-auth-safety.sh`, `check-docs-updated.sh` pass.
- **Docs updated:** `02` (§5b + threat T17 + non-negotiable), `03` (0005), `00`, `04` (RISK-C08 + RISK-002 scope note), `06`, `07`, `09`, `rls_test_plan.md`, `src/lib/database.types.ts`.

---

### PR #16 — Harden destructive delete policies · 2026-06-16
- **Category:** database / RLS hardening (no product UI).
- **What:** `0004_destructive_delete_hardening.sql` — remove normal authenticated **hard-delete** from
  the 6 core evidence tables that had `FOR ALL` policies (`organizations`, `apps`, `contracts`,
  `app_contracts`, `people`, `app_users`). For each, drop the broad `FOR ALL` manage policy (0001 tenant
  editors + 0002 org-manager stewards) and recreate it as explicit `INSERT` + `UPDATE` policies with the
  **same** `USING`/`WITH CHECK` — **no `DELETE` policy**, so `DELETE` affects 0 rows for every authenticated role.
- **Current delete risk (closed):** before this, an editor/owner/admin/org-manager could hard-delete
  evidence rows with no archive UI and no audit — RISK-C07.
- **What deletes remain:** `tenant_memberships`/`organization_memberships` keep delete (member removal is
  normal, reversible access admin). The other core tables (`identity_accounts`/`app_user_identity_matches`/
  `license_rules`/`license_evaluations`/`files`/`invoices`) had **no** policy = default-deny already.
- **Migration impact:** new forward migration only; **RLS-only, no schema/column change** —
  `gen-types-local.sh` left `src/lib/database.types.ts` byte-identical. **Service-role / hosted Supabase: none.**
- **RLS/test impact:** updated `org_rls_test.sql` — T17 own-org delete flips to denied; new **T24** (owner/admin
  deny; editor `UPDATE` still works, `DELETE` denied; rows survive across all 6 tables) and **T25** (`/apps`+`/apps/[id]`
  reads still valid). 66 → **82 assertions**, T1–**T25**. Added editor/person/app-user/app-contract seed rows.
- **Product impact:** none — no UI/routes; `/apps` and `/apps/[id]` build and read unchanged.
- **Tests run (local, verified):** `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (0001–0004 applied); `npm test` 5/5;
  `npm run lint`/`tsc --noEmit`/`build` exit 0 (`/apps`+`/apps/[id]` dynamic); `check-migration-safety.sh`,
  `check-auth-safety.sh`, `check-docs-updated.sh` pass; `gen-types-local.sh` → no type change.
- **Docs updated:** `02` (§4b + threats T14–16 + non-negotiable), `03` (0004), `00`, `04` (RISK-C07), `06`, `07`, `09`, `rls_test_plan.md`.
- **Follow-ups:** an audited admin/service break-glass delete + archive/soft-delete UI are **not built** (deferred).

---

### PR #15 — Add app CI and release hygiene hardening · 2026-06-16
- **Category:** CI / build / release hygiene (no product features).
- **What:**
  - **App CI** — `.github/workflows/app-ci.yml` runs `npm ci` → `npm run lint` → `npm test` →
    `npx tsc --noEmit` → `npm run build` on every PR (kept separate from the RLS Docker CI).
  - **Deterministic build** — removed `next/font/google` (Geist) from `src/app/layout.tsx`; fonts now
    come from a system stack in `globals.css` `@theme`. **No remote (Google) font fetch at build.**
  - **Metadata** — `src/app/layout.tsx` title `ID Caddie`, description "Contract-aware SaaS governance for complex organizations" (was Create-Next-App copy).
  - **README** — replaced the starter `README.md` with a short pointer to `README_START_HERE.md` (the canonical entry point).
- **Why:** make the app build/test path deterministic and CI-enforced before more product UI.
- **Audit:** `npm audit --audit-level=moderate` → 2 moderate, both in **`next`'s bundled `postcss`**
  (`node_modules/next/node_modules/postcss`, GHSA-qx2v-qp2m-jg93, build-time). The only `fix --force`
  path downgrades `next` to 9.3.3 (breaking) — **not** applied. Tracked as **RISK-017**.
- **Product impact:** none — no routes/pages/features. **Security/RLS/migration/service-role impact:** none — no DB/auth/schema change, hosted Supabase untouched, no secrets (CI build needs no env: data pages are dynamic).
- **Tests run (local, verified):** `npm ci` exit 0; `npm run lint` clean; `npm test` 5/5;
  `npx tsc --noEmit` exit 0 (clean fresh tree, no `.next`/`next-env.d.ts`); `npm run build` exit 0
  (builds with **no** env vars + **no** Google font); `check-auth-safety.sh`, `check-migration-safety.sh`,
  `check-docs-updated.sh` pass; `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED`.
- **Docs updated:** `00`, `01` (workflow list), `04` (RISK-017), `09`, `README_START_HERE`, `README.md`, this entry.
- **Follow-ups:** clear RISK-017 on the next safe `next` upgrade that bumps bundled postcss.

---

### PR #14 — Add read-only app detail · 2026-06-16
- **Category:** app / product UI.
- **What:** `src/app/(authenticated)/apps/[id]/page.tsx` — a server-rendered, **read-only** app detail
  page (name/vendor/category/status/created/updated + owning-org IDs), with safe not-found/no-access
  and generic-error states and **no** create/edit/delete. New typed DAL helper
  `getAppDetailForCurrentUser(appId)` in `src/lib/data/apps.ts` (`AppDetail` DTO + `AppDetailResult`).
  App names in `/apps` now link to the detail page.
- **Why:** restore the next legacy capability (app detail drill-down) while keeping v3 safer.
- **Route-param authorization:** the `[id]` param is **only a lookup key** — `getAppDetailForCurrentUser`
  does `where id = $1` and relies on RLS; a hidden/foreign row returns `not_found` (indistinguishable
  from non-existent, so the id can't enumerate other tenants' apps).
- **Data access / RLS impact:** reads only via the user-scoped DAL; RLS is the authority. **Verified**
  with the helper's exact query against the seeded fixture: owner reads all 3 app details; org-only
  Marketing reads only its 2 related (Salesforce, Slack); the unrelated app (Google Workspace) and a
  non-member → `not_found`/0.
- **Security impact:** read-only; no service-role; no browser storage; no secrets; no `tenant_id`/param as authz.
- **Migration impact:** **none**. **Service-role impact:** none.
- **Tests run (local, verified):** `npm test` 5/5; `npm run lint`/`build` exit 0 (`/apps/[id]` dynamic);
  `check-auth-safety.sh`, `check-migration-safety.sh`, `check-docs-updated.sh` pass; `test-rls.sh`
  → `ALL ORG-RLS ASSERTIONS PASSED`; `seed-local-demo.sh` + RLS detail spot-check (owner 3 / org-only 2 / unrelated 0 / non-member 0).
- **Docs updated:** `00`, `06` (Stage 4b ✅; Stage 5 contracts next), `09`, `11` (App-detail row → implemented metadata-only), `04` (RISK-006 narrowed), this entry.
- **Follow-ups:** org-name enrichment; then contracts (Stage 5). **Not built:** app-user roster, linked contracts/invoices/files, license rules, all edits/imports/exports.

---

### PR #13 — Add read-only app inventory · 2026-06-16
- **Category:** app / product UI (first product surface).
- **What:** `src/app/(authenticated)/apps/page.tsx` — a server-rendered, **read-only** Apps inventory
  list (name/vendor/category/status) consuming `listAppsForCurrentUser()` (PR #11 DAL), with safe empty
  and generic-error states and **no** create/edit/delete. Added a link to it from the protected shell
  and updated its status badges. The DAL was used **unchanged** (already returned the needed columns).
- **Why:** restore the first major legacy capability (app inventory) while keeping v3 safer.
- **Data access / RLS impact:** reads only via the user-scoped server DAL; **RLS is the authority**.
  No caller-supplied `tenant_id`, no client-side filtering. Verified with the DAL's exact query against
  the seeded fixture: tenant owner → all 3 apps; org-only Marketing user → only the 2 related apps
  (RLS `0003` org-union read); non-member → 0.
- **Security impact:** read-only; no service-role; no browser storage of role/tenant; no secrets.
- **Migration impact:** **none** (`check-migration-safety.sh` green). **Service-role impact:** none.
- **Tests run (local, verified):** `npm test` 5/5; `npm run lint`/`build` exit 0 (`/apps` dynamic);
  `check-auth-safety.sh`, `check-migration-safety.sh`, `check-docs-updated.sh` pass; `test-rls.sh`
  → `ALL ORG-RLS ASSERTIONS PASSED`; `seed-local-demo.sh` + RLS spot-check (3 / 2 / 0 apps).
- **Docs updated:** `00`, `06` (Stage 4 ✅, 4b next), `09`, `11` (App-inventory row + OMC #1 → partial), `04` (RISK-006 narrowed), this entry.
- **Follow-ups:** app detail (Stage 4b), then contracts (Stage 5); cost/license/user metrics + CSV export later. **Not done:** detail, contracts, people, imports, exports, reports, writes.

---

### PR #12 — Add legacy Firebase capability map and OMC parity checklist · 2026-06-16
- **Category:** docs / product control.
- **What:** `docs/11_LEGACY_PARITY_AND_OMC_CHECKLIST.md` — a legacy→v3 capability inventory (22 areas
  with legacy file-path evidence, v3 status, required stage, parity target, security improvement,
  status), an **OMC/Flywheel acceptance checklist** (go/no-go), a **hard cutover rule**, a P0/P1/P2/deferred
  gap list, and a roadmap mapping next PRs to parity. Links to (does not duplicate) `current-product-map.md`.
- **Why:** ensure v3 preserves the paying client's useful capabilities while improving security/RLS/audit —
  and that nobody cuts OMC over with gaps.
- **Verified, not invented:** evidence gathered from the legacy repo `/Users/samvemuri/Desktop/IDCaddie_Repo-main`
  (e.g. paying client = **Flywheel Digital**, an Omnicom agency — `webapp/.firebaserc`, `deploy-flywheeldigital.sh`;
  legacy import is **destructive** — deletes "outdated" users at `webapp/functions/src/files/onFileLinkedToApp.js:290`;
  audit `logs` are mutable + 90-day-purged — `cleanupOldLogs.js`). Uncertain items marked `needs-verification`.
- **Security/RLS/migration/service-role impact:** **none** — docs only; no code, no schema, no hosted Supabase.
- **Tests run:** `npm test` 5/5; `npm run lint`/`build` exit 0; `check-auth-safety.sh`, `check-migration-safety.sh`,
  `check-docs-updated.sh` pass; `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED`.
- **Docs updated:** new `11`; `00` (parity/cutover gate row + do-not-do-yet), `04` (RISK-016), `06`, `09`, `10` (index + reading paths).
- **Follow-ups:** each future product-surface PR updates `11` (status + OMC checklist) and links the PR.

---

### PR #11 — Add typed data access layer · 2026-06-16
- **Category:** app / data layer.
- **What:** generated `src/lib/database.types.ts` (the `Database` type) from the migrations;
  typed the server client (`createServerClient<Database>` in `src/lib/supabase/server.ts`); added a
  server-only, read-only DAL (`src/lib/data/apps.ts` — `listAppsForCurrentUser()` returning a typed
  `AppSummary` DTO with a structured `DataResult`). Added `scripts/gen-types-local.sh` to regenerate
  the types locally.
- **Type strategy:** types are **generated** (not hand-written) by `gen-types-local.sh`, which spins up
  its **own throwaway Postgres** (like `test-rls.sh`), applies the migrations, and runs
  `supabase gen types typescript --db-url <local>` — hosted-proof (no `--linked`/`--project-id`, no
  `supabase link`/`db push`, refuses remote args, no secrets). Committed so the build needs no generation step.
- **Hosted Supabase impact:** **none** — generation is local-only; no hosted apply.
- **Service-role impact:** **none** — the DAL uses the anon user-scoped server client; `check-auth-safety.sh` clean.
- **Migration impact:** **none** — no schema change (`check-migration-safety.sh` only scans `supabase/migrations/`).
- **Security/RLS impact:** RLS remains the authority. The DAL is server-only (imports `next/headers`
  via the server client; importing it client-side fails the build), read-only, and passes **no**
  caller-supplied `tenant_id` as an auth input — visibility is RLS-scoped.
- **Tests run (local, verified):** `gen-types-local.sh` → 1123-line types, clean teardown; `npm test`
  5/5; `npm run lint`/`build` exit 0 (build compiles against the typed client — proof the types are right);
  `check-auth-safety.sh`, `check-migration-safety.sh`, `check-docs-updated.sh` pass; `test-rls.sh`
  → `ALL ORG-RLS ASSERTIONS PASSED`.
- **Docs updated:** `00`, `01`, `06`, `09`, `README_START_HERE`, `04` (RISK-011 narrowed).
- **Follow-ups:** a CI types-drift check (regenerate + `git diff --exit-code`) keeps RISK-011 open;
  contracts/orgs DAL helpers follow the same shape when their screens land; first product UI is still not built.

---

### PR #10 — Add local/demo tenant fixture · 2026-06-16
- **Category:** dev tooling / fixtures (local-only).
- **What:** `supabase/fixtures/local_demo.sql` — a synthetic Demo Tenant + 4 organizations
  (Corporate/Marketing/IT/Procurement), 2 demo users (a tenant owner + an org-only user) with
  tenant/org memberships, 3 sample apps (Slack/Google Workspace/Salesforce) and 2 contracts with
  owning-org FKs + app↔contract links. `scripts/seed-local-demo.sh` loads it into a **throwaway
  local Postgres** (own Docker container, like `test-rls.sh`), applies it twice to prove idempotency,
  prints a summary, and tears down (`--keep` leaves a local DB on `127.0.0.1:55432`).
- **Why:** predictable, repeatable local data for tenant/org context and the upcoming Stage 4 inventory.
- **Hosted Supabase impact:** **none.** The script has no remote code path — it only ever uses its
  own container, refuses remote/`--linked` args, calls no Supabase CLI, runs no `db push`. The fixture
  lives outside `supabase/migrations/` (never in the apply path) and inserts `auth.users` (local shim only).
- **Service-role impact:** **none** — no service-role key; the seed runs as the local container's `postgres` superuser (not app code; `src/` unchanged).
- **Migration impact:** **none** — a fixture, not a migration (`check-migration-safety.sh` only scans `supabase/migrations/`).
- **Security impact:** all-synthetic data; no real customer names, no PII, no secrets. RLS untouched.
- **Tests run (local, verified):** `seed-local-demo.sh` → 1 tenant / 4 orgs / 1 tenant-membership /
  2 org-memberships / 3 apps / 2 contracts / 2 links, idempotent, clean teardown; refusal guards exit 2;
  `npm test` 5/5; `npm run lint`/`build` exit 0; `check-auth-safety.sh`, `check-migration-safety.sh`,
  `check-docs-updated.sh` pass; `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED`.
- **Docs updated:** `03` (fixture section), `00`, `06`, `09`, `README_START_HERE`, `04` (RISK-015).
- **Follow-ups:** none; consume the fixture when Stage 4 inventory lands.

---

### PR #9 — Add tenant and org context resolution · 2026-06-16
- **Category:** app / auth.
- **What:** `resolveTenantContext()` in `src/lib/auth/tenant-context.ts` reads the signed-in user's
  own `tenant_memberships` and `organization_memberships` (with embedded `tenants`/`organizations`)
  via the user-scoped server client, and derives an active tenant + org list. Pure logic split into
  `tenant-context-derive.ts` with vitest unit tests (`tenant-context-derive.test.ts`); added a `test`
  npm script. The protected shell (`(authenticated)/page.tsx`) now displays the resolved context with
  status badges. Replaced the prior placeholder stub.
- **Why:** build-sequence Stage 3 — let the app *use* the RLS foundation for real reads, without product UI.
- **Migration impact:** **none.** Existing RLS already permits a user to read their own memberships and
  the tenants/orgs those grant (`is_tenant_member` / `is_org_member` / `is_tenant_participant`); no schema
  change was needed (verified by `check-migration-safety.sh`; `test-rls.sh` unchanged + green).
- **Service-role impact:** **none** — anon, user-scoped server client only (enforced by `check-auth-safety.sh`).
- **Tenant/RLS impact:** RLS remains the sole authority. The resolver filters to the user's own rows and
  relies on RLS to scope visibility; only `status='active'` memberships resolve. No client-side filtering,
  no JWT claims as authorization, no browser storage of role/tenant state.
- **Behavior:** zero memberships → `no_membership` ("No tenant access configured yet"), safe, creates nothing;
  org-only → `no_tenant_membership`; multiple tenants → deterministic first, `tenantSwitchingRequired=true`
  (no switcher built); query error → safe generic message, no raw error surfaced.
- **Tests run (local, verified):** `npm test` 5/5; `npm run lint` clean; `npm run build` exit 0 (Proxy detected);
  `check-auth-safety.sh` 6/6 + scan clean; `check-migration-safety.sh` pass; `check-docs-updated.sh` 0/0;
  `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED`.
- **Docs updated:** `00`, `01`, `06` (Stage 3 done, Stage 4 next), `04` (RISK-012 narrowed to provisioning/switching), `09`.
- **Follow-ups:** tenant switcher + user provisioning/invites (RISK-012); not exercised against hosted Supabase (RISK-001).

---

### PR #8 — Connected agent governance · 2026-06-16
- **Category:** docs / governance.
- **What:** added a canonical **"Connected agent permissions"** policy ([09](./09_AGENT_HANDOFF.md#connected-agent-permissions))
  for connected coding agents/tools (Claude/Vercel/GitHub/Supabase) — allowed/not-allowed/required.
  Short audience-specific sections in [07](./07_P0_REVIEW_CHECKLIST.md) (reviewer), [08](./08_CODE_AND_DOCS_STANDARD.md)
  (discipline), and `README_START_HERE` (entry point) **link** to it, not restate it. Opened **RISK-014**.
- **Why:** make safe usage of connected automation explicit and reviewable — agents propose on branches; humans dispose on `main`.
- **Security impact:** none to runtime — docs only. Reinforces no-auto-merge, no-secrets, no-hosted-Supabase, no-service-role, human-review-before-merge.
- **Tests run (local, verified):** `npm run lint` clean; `npm run build` exit 0; `check-auth-safety.sh` 6/6 + clean;
  `check-docs-updated.sh` 0/0; `check-migration-safety.sh` pass; `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED`.
- **Docs updated:** `09` (canonical), `08`, `07`, `04` (RISK-014), `README_START_HERE`, this entry.
- **Follow-ups:** confirm GitHub branch protection on `main` (review + green CI required) matches the documented policy (RISK-014).

---

### PR #7 — Install Vercel Speed Insights · 2026-06-16
- **Category:** infra / telemetry (Vercel agent PR, reconciled per [08](./08_CODE_AND_DOCS_STANDARD.md)).
- **What:** added `@vercel/speed-insights@^2.0.0` and a bare `<SpeedInsights />` in the root
  layout (`src/app/layout.tsx`), alongside the existing `<Analytics />` (PR #5). 3 files only:
  `package.json`, `package-lock.json`, `layout.tsx`.
- **Why:** Vercel platform performance telemetry (Core Web Vitals).
- **Security/privacy impact:** none to DB / RLS / auth / service-role / DNS; **no custom events**;
  no PII/tenant/customer/business data sent. Platform telemetry only — not an audit/product/billing
  source of truth. Needs a production privacy review before customer traffic ([04 · RISK-013](./04_RISK_REGISTER.md)).
- **Tests run (local, verified):** `npm run lint` clean; `npm run build` exit 0; `check-auth-safety.sh`
  6/6 + scan clean; `check-migration-safety.sh` pass; `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED`;
  `check-docs-updated.sh` 0/0; `pr-review-summary.sh` pass.
- **Docs updated:** this reconciliation — `00`, `01` (platform-telemetry section), `04` (RISK-013),
  `07` (telemetry review section), `08` (vendor/bot PR rule), `09`, `README_START_HERE`, PR template checkbox.
- **Follow-ups:** production privacy/telemetry review (RISK-013); do not expand telemetry or add custom events.

---

### PR #6 — Add auth session skeleton · 2026-06-15
- **Category:** app / auth / security.
- **What:** `@supabase/ssr` clients — `src/lib/supabase/{env,client,server,proxy}.ts` (browser +
  user-scoped server, anon key only); `src/proxy.ts` (Next.js 16 **Proxy** — the renamed
  Middleware — for session refresh + protected-route redirect); routes `login/` (email+password
  Server Action), `logout/` (route handler), `(authenticated)/` group with a server-side guard;
  `src/lib/auth/{session,tenant-context}.ts` (tenant-context is a Stage-3 placeholder). Replaced
  the Create-Next-App starter `src/app/page.tsx` (it collided with the authenticated group's `/`).
  Added `scripts/check-auth-safety.sh` (+ selftest), wired into `review-discipline.yml`.
- **Why:** the minimum safe identity/session foundation future app UI builds on, without
  product UI, migrations, or service-role keys.
- **Security impact:** introduces the auth boundary. No service-role key anywhere in `src/`
  (enforced by `check-auth-safety.sh`); authorization over data remains RLS. Proxy does **not**
  make tenant/org decisions or read app data.
- **Tenant/RLS impact:** none to RLS. Tenant/org context is a placeholder; no data is read yet.
- **Migration impact:** none — no DB change (verified by `check-migration-safety.sh`; `test-rls.sh` still green).
- **Tests run (local, verified):** `npm run lint` clean; `npm run build` exit 0 (Proxy detected);
  `check-auth-safety.sh selftest` 6/6 + scan clean; `check-migration-safety.sh` pass; `test-rls.sh`
  → `ALL ORG-RLS ASSERTIONS PASSED`; `check-docs-updated.sh` / `pr-review-summary.sh` pass.
- **Docs updated:** `00`, `01`, `06`, `04` (closed RISK-005→C06, opened RISK-012), `09`, `README_START_HERE`.
- **Follow-ups:** not exercised against hosted Supabase Auth (RISK-001); Stage 3 tenant/org context next.

---

### PR #5 — Add Vercel Web Analytics integration · `a86fb37`
- **Category:** infra / analytics (automated PR, not part of the v3 build sequence).
- **What:** added `@vercel/analytics` and `<Analytics />` to the root layout (`src/app/layout.tsx`).
- **Why:** Vercel deployment analytics. Authored by the Vercel automation, not the build plan.
- **Security impact:** none to auth/RLS — client-side analytics only; no service-role, no data access.
- **Tests run:** none recorded on the automated PR; `npm run build` stays green with it present (verified in PR #6).
- **Docs updated:** none at merge time; back-filled here and in [00](./00_PRODUCT_STATUS.md) by PR #6 for an honest record.
- **Follow-ups:** none.

---

### PR #4 — Add ID Caddie clean-app operating system · 2026-06-15
- **Category:** docs / process / CI.
- **What:** Canonical doc set `docs/00`–`10`, true-entry `README_START_HERE.md`, PR template,
  `scripts/check-docs-updated.sh` + `pr-review-summary.sh`, `.docs-not-needed.template.md`,
  `.github/workflows/review-discipline.yml`. Reconciled (linked, not duplicated) the existing
  design/legacy/migration docs.
- **Bug fixed:** `check-docs-updated.sh` referenced a non-existent doc numbering
  (`12`/`13`/`03_DATABASE_AND_RLS`/`10_BUILD_SEQUENCE`), so its risk/changelog detections never
  matched the real `04`/`05`/`03`/`06` files — repointed to the canonical set.
- **CI hardening (fail-closed):** the docs-drift gate now runs with `REQUIRE_BASE=1` in
  `review-discipline.yml` and the workflow fetches the base branch (`fetch-depth: 0` + explicit
  fetch), so a missing merge-base FAILs loudly instead of silently passing. Local runs stay graceful.
- **Why:** make the repo self-explaining, self-checking, and not dependent on Sam's memory.
- **Security impact:** none to runtime; adds a P0 review framework ([07](./07_P0_REVIEW_CHECKLIST.md)) and a fail-closed docs-drift gate.
- **Tests run (local, verified):** `check-migration-safety.sh selftest` 6/6 + check passed;
  `test-rls.sh` → `ALL ORG-RLS ASSERTIONS PASSED` (exit 0, no container leftovers);
  `check-docs-updated.sh` 0 failures/0 warnings (and exits 2 on a missing required base);
  `pr-review-summary.sh` categorized the diff; `npm run lint` clean.
- **Docs updated:** this whole PR is docs/process.
- **Follow-ups:** none blocking; future PRs must keep [04](./04_RISK_REGISTER.md) and this file current.

---

### PR #3 — Document Supabase migration discipline · `ee59c6c`
- **Category:** docs / CI.
- **What:** `docs/migration-workflow.md`, `docs/migration-checklist.md`,
  `scripts/check-migration-safety.sh` (with `selftest`), `.github/workflows/migration-safety.yml`,
  README dev-workflow section.
- **Why:** prevent skipping local migration tests, mutating merged migrations, or pushing to hosted Supabase too early.
- **Security impact:** indirect — flags unsafe migration patterns; no RLS change.
- **Tests run:** safety selftest 6/6; real migrations pass; `test-rls.sh` green.
- **Docs updated:** migration workflow + checklist + README.
- **Follow-ups:** closed RISK-C04.

---

### PR #2 — Add repeatable RLS migration test runner · `bfffb84`
- **Category:** CI / tests.
- **What:** `scripts/test-rls.sh` (throwaway Postgres + Supabase-style `auth` shim, applies all
  migrations, runs `*_test.sql` with `ON_ERROR_STOP=1`, cleans up on failure) + `.github/workflows/rls-tests.yml`.
- **Why:** make RLS regressions impossible to merge unnoticed; one path local + CI.
- **Security impact:** makes the RLS guarantees continuously verified.
- **Tests run:** full suite passed (`ALL ORG-RLS ASSERTIONS PASSED`); negative check exits non-zero.
- **Docs updated:** README + `rls_test_plan.md`.
- **Follow-ups:** closed RISK-C03.

---

### PR #1 — Add org-scoped RLS foundation and adversarial tests · `f7c5c75`
- **Category:** database / security.
- **What:** `0002_org_scoped_rls.sql` (org helpers, steward writes, audit append-only trigger,
  `enforce_owning_org_tenant`, admin self-promotion fix) and `0003_org_access_union.sql`
  (related-org read model); `supabase/tests/org_rls_test.sql` (66 assertions, T1–T23).
- **Why:** enforce org_manager/org_viewer in Postgres and serve chargeback reads without
  over-granting writes.
- **Security impact:** large — tenant isolation + org scoping + audit immutability now enforced.
  Closed two live-verified bugs.
- **Tests run:** all assertions pass; cross-tenant exploit replayed and blocked.
- **Docs updated:** `v3-data-model.md`, `v3-security-model.md`, `rls_test_plan.md`.
- **Follow-ups:** closed RISK-C01, RISK-C02; opened the deferred items now tracked in [04](./04_RISK_REGISTER.md).

---

*Pre-PR history (legacy extraction docs, rebuild starter, `0001` core schema) is in
`git log` and the `docs/current-*` / `docs/v3-*` design docs.*
