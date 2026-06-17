# 06 · Build Sequence

**Canonical source for: build order and "what not to build yet".** Each stage maps to legacy→v3
capability parity and the OMC cutover gate in [11_LEGACY_PARITY_AND_OMC_CHECKLIST](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md#6-updated-roadmap-next-prs-to-parity).

> **The grounded, canonical replacement-PR sequence (Track A security/file path + Track B parity build-out) + the honest ~70–110-PR estimate now live in [17 §7/§8](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md).** OMC/Flywheel is a paying **production replacement, NOT a pilot** — build for full parity, no regressions; improvements only after replacement (17 §9). **Before sizing/sequencing, run the OMC-confirmation pass via [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md)** (the questionnaire/workshop/decision-log that resolves doc 17's `probably`/`unknown` rows and narrows the estimate). This doc is the staged build-order view; 17 §7 is the replacement plan of record.
Each stage is gated on
the previous. Status uses the [taxonomy](./10_DOCS_INDEX.md#status-taxonomy). Stages 1–3 are
`implemented`/`verified-local`/`ci-enforced`; Stages 4–6 ship **read-only** surfaces (`implemented`,
`verified-local`) with **writes deferred**; Stages 7+ are `planned`/`deferred`. Nothing is hosted-applied.

> **Parity-driven next-PR order (PR #28):** the *near-term* implementation order is now re-ranked around
> the legacy→v3 parity contract — see [14_LEGACY_UX_WORKFLOW_PARITY_MAP §8](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md#8-next-implementation-order-re-ranked-around-parity)
> (parity map → contract audit-on-write → contract create/edit parity → link/unlink → import → UAR →
> stale → exports → license/spend/files/invoices → hosted apply). Every user-facing stage must preserve
> the legacy workflow or get the difference approved (doc 14 §6). **Cutover is gated on workflow parity,
> not on completing these stages' backends.**

Global "done" for every stage: code + tests + docs updated, `04_RISK_REGISTER` and
`05_ENGINEERING_CHANGELOG` updated, [07_P0_REVIEW_CHECKLIST](./07_P0_REVIEW_CHECKLIST.md)
passed, CI green.

| # | Stage | Status |
|---|-------|--------|
| 1 | Clean-app operating system (docs/CI/foundation) | `implemented` |
| 2 | Auth/session skeleton | `implemented` (PR #6) |
| 3 | Tenant/org context (read-only) | `implemented` (PR #9) |
| 4 / 4b | Read-only app inventory + detail | `implemented` / `verified-local` (PR #13/#14) |
| 5 | Contracts (read-only list + detail; create/edit write) | `partial` — read-only `implemented` (PR #19); write **backend path** `implemented` (PR #30); **create/edit UI** `implemented` (PR #31); **parity fields** `0011` `implemented` (PR #32 — category/procurement_date/notes/po_number/auto_renew/month_to_month). **Partial** legacy parity (doc 13/15) |
| 5b | Linked app↔contract panels (read-only) | `implemented` (PR #20) |
| 6a–6d | App-user roster + match status + account summary (read-only) | `implemented` / `verified-local` (PR #21/#23/#24); `people` reads + app-user writes still `planned` |
| 6b | Identity / matching read-scope design | `design` only (PR #22; match-status slice built PR #23) |
| 7 | License rules / evaluations | `deferred` (default-deny) |
| 8 | Files / invoices | `deferred` (default-deny) |
| 9 | Audit-on-write + audit log UI | contract audit-on-write `implemented` (PR #29 — `0010` `SECURITY DEFINER` trigger); audit log **UI** still `planned` |
| 10 | Reports / exports | `deferred` |
| 11 | Import flows | `deferred` |
| 12 | Integrations / connectors | `deferred` |
| 13 | Org hierarchy / `resource_org_links` | `deferred` |
| 14 | Billing / pricing | `deferred` (only if needed) |

---

### Stage 1 — Clean-app operating system ✅
- **Goal:** repo is self-explaining, self-checking, RLS-tested. **Done:** docs 00–10, RLS
  suite + safety + docs-drift CI all green.

### Stage 2 — Auth/session skeleton ✅ (PR #6)
- **Goal:** Supabase Auth login + server-side session + route protection. No business data. **Done.**
- **Built:** `@supabase/ssr` browser + user-scoped server clients (anon key only); `src/proxy.ts`
  (Next.js 16 Proxy) for session refresh + protected-route redirect; `login/` (email+password
  Server Action), `logout/` route handler, `(authenticated)/` group with a server-side guard;
  `src/lib/auth/` session + tenant-context placeholder.
- **Verified:** `npm run build` + lint clean; `scripts/check-auth-safety.sh` (no service-role /
  no hardcoded keys / no client-side role storage). **Not** exercised against hosted Supabase Auth.
- **Deliberately not built:** business reads/writes, tenant switching UI, signup/tenant creation,
  OAuth/SAML/SCIM, tenant/org context resolution.

### Stage 3 — Tenant/org context (read-only) ✅ (PR #9)
- **Goal:** derive the user's tenant + org memberships server-side; expose read-only context. **Done.**
- **Built:** `resolveTenantContext()` reads own `tenant_memberships`/`organization_memberships` (+
  embedded `tenants`/`organizations`) via the user-scoped server client — RLS-scoped, no service-role,
  no client filtering, no JWT claims. Active tenant = deterministic first (no switcher). Pure derivation
  in `tenant-context-derive.ts` with unit tests; resolved context shown in the protected shell.
- **Zero-membership:** safe — `no_membership` / `no_tenant_membership` states, "No tenant access
  configured yet", no crash, nothing created.
- **No migration** (existing RLS already permits these reads). **Not built:** tenant switching, provisioning.

### Stage 4 — Read-only app inventory ✅ (PR #13)
- **Goal:** first real screen — list `apps` the user may read. **Done.**
- **Built:** `src/app/(authenticated)/apps/page.tsx` — server-rendered, consumes `listAppsForCurrentUser()`
  (PR #11 DAL), shows name/vendor/category/status, with safe empty + generic error states and no
  create/edit/delete. A link to it from the protected shell. No new queries, no client-side filtering.
- **Verified (RLS query against the seeded fixture):** tenant owner sees all 3 demo apps; the org-only
  Marketing user sees only the 2 apps related to their org (RLS `0003` org-union read); a non-member sees 0.
- **Don't build yet:** edit/create, app detail, contracts UI, imports/exports.

### Stage 4b — Read-only app detail ✅ (PR #14)
- **Goal:** drill-down for one app (read-only). **Done.**
- **Built:** `src/app/(authenticated)/apps/[id]/page.tsx` + `getAppDetailForCurrentUser(id)` (typed DAL).
  Shows name/vendor/category/status/timestamps + owning-org IDs; app names in `/apps` link here. The
  `[id]` route param is a **lookup key only** — RLS decides; hidden rows → `not_found` (no enumeration).
- **Verified (RLS query):** owner reads all 3 demo app details; org-only Marketing reads only its 2
  related, and the unrelated app + non-member → 0 (not_found).
- **Deferred (documented):** org-name enrichment (IDs shown for now); app-user roster, linked contracts,
  invoices, files, license rules, and all edits — **not** built.

### Stage 5 — Contracts (read-only slice) 🟡 (PR #19)
- **Goal:** read-only contract visibility from the `contracts` table only. **Read-only slice done; writes + linked surfaces deferred.**
- **Built:** `src/app/(authenticated)/contracts/page.tsx` + `contracts/[id]/page.tsx` + typed DAL `src/lib/data/contracts.ts` (`listContractsForCurrentUser`, `getContractDetailForCurrentUser`). Direct `contracts` columns only; `[id]` is a lookup key (RLS decides; hidden → `not_found`). `/contracts` linked from the shell.
- **Verified (RLS spot-check):** tenant owner sees both demo contracts; org-only users see only their related contract (procurement/paying org union, `0003`); unrelated org-only + non-member → `not_found`.
- **Intentionally NOT built (this slice):** create/edit/delete/archive, import/export, file upload, invoices. **OMC/Flywheel contracts cutover stays blocked.**

### Stage 5b — Read-only linked apps ↔ contracts 🟡 (PR #20)
- **Goal:** show linked apps on a contract and linked contracts on an app, **read-only**, after making `app_contracts` org-scoped for read. **Done.**
- **Built:** migration `0006` (one org-scoped `SELECT` policy on `app_contracts` — read a link iff you can read the linked app OR contract; no DELETE), DAL `src/lib/data/links.ts`, "Linked apps" on `/contracts/[id]` + "Linked contracts" on `/apps/[id]`. No linking/unlinking/editing.
- **Verified:** **T28** + live spot-check — org-only users read only links tied to apps/contracts they can read; cross-tenant + non-member read none.
- **Still NOT surfaced:** `people` (tenant-only), `invoices`/`files`/`license_*`/`identity_*` (default-deny). RISK-002 **narrowed, not closed**.

### Stage 6a — Read-only app-user roster 🟡 (PR #21)
- **Goal:** show a per-app account roster on `/apps/[id]`, **read-only**, after making `app_users` org-scoped for read. **Done.**
- **Built:** migration `0007` (one org-scoped `SELECT` policy on `app_users` — read a row iff you can read the linked app; no DELETE), DAL `src/lib/data/app-users.ts`, "App users" section on `/apps/[id]` (direct columns only). No edit/remove/provision; no identity matching, license utilization, or imports.
- **Verified:** **T29** + live spot-check — org-only users read only users of apps they can read; cross-tenant + non-member read none; org-only delete denied (no DELETE policy).
- **Still NOT surfaced:** `people` (tenant-only), `identity_accounts`/`license_*`/`files`/`invoices` (default-deny). RISK-002 **narrowed, not closed**. OMC/Flywheel cutover stays **blocked**.

### Stage 6b — Identity / matching read-scope DESIGN 📐 (PR #22, design only — nothing built)
- **Goal:** decide the safe read model for identity/account/matching **before** building it. Recorded in [12_IDENTITY_MATCHING_READ_SCOPE](./12_IDENTITY_MATCHING_READ_SCOPE.md). **No migration, no policy, no UI, no tests added.**
- **Decision:** keep `people` **tenant-only** and `identity_accounts` **default-deny** (no app anchor). The only future org-scoped identity read is `app_user_identity_matches`, gated on a **readable `app_user`** (mirror `0007`; SELECT-only; exposes match *status*, not person PII). Any unmanaged/UAR classification is computed **from the app side**, via a definer view returning only a status enum — never tenant-wide `people`/`identity` reads.
- **A future implementing PR must** land the exact policy (doc 12 §5) and the exact tests (doc 12 §7) **before any UI**, and be re-reviewed for tenant-wide leakage. Current guardrails already pinned by T27 27a/27b + T29 29f.

### Stage 6c — Read-only app-user match status 🟡 (PR #23)
- **Goal:** show a minimal matched/unmatched status per app_user on `/apps/[id]`, **read-only**, after making `app_user_identity_matches` org-scoped for read (per doc 12 §5). **Done.**
- **Built:** migration `0008` (one org-scoped `SELECT` on `app_user_identity_matches` — read a match iff you can read the linked app_user; explicit tenant-bind; no DELETE), DAL `src/lib/data/app-user-matches.ts`, a "Match" column on the roster. Unmatched derived server-side; status only, **no person/identity PII**.
- **Verified:** **T30** + live spot-check — org-only users read only matches of app_users they can read; cross-tenant + non-member read none; a match read grants no `people`/`identity_accounts` read; org-only delete denied; planted corrupt cross-tenant match hidden by the tenant-bind.
- **Still NOT built:** identity matching algorithm, people merge, UAR/orphaned/deactivated status, provisioning. `people` tenant-only + `identity_accounts` default-deny (unchanged). RISK-002 **narrowed, not closed**. OMC/Flywheel cutover stays **blocked**.

### Stage 6d — Read-only account summary 🟡 (PR #24)
- **Goal:** a small "Account summary" card on `/apps/[id]`, derived **purely** from already-visible data. **Done. No migration, no RLS change.**
- **Built:** pure helper `src/lib/data/app-account-intelligence.ts` (+ unit tests) computing counts from the visible `app_users` roster + visible match rows: visible / matched / unmatched / match-rate, status breakdown (active/inactive/unknown), stale candidates (>90d from the account's own `last_active_at`). Card rendered above the App users table.
- **Conservative by design — NOT UAR:** "unmatched" = no visible match row; "stale candidate" = own `last_active_at` older than 90d (not confirmed stale); null/unrecognized `status` → "unknown" (never inferred). **No `people`/`identity_accounts`/license/files/invoices/PII; no orphaned/deactivated/managed label; no matching algorithm; no provisioning.**
- **Verified:** unit tests (7 cases); `test-rls.sh` unchanged at 152 (no policy change). RISK-002 + RISK-016 open. OMC/Flywheel cutover stays **blocked**.

### Stage 5b — Contract steward write DESIGN 📐 (PR #25, design only — nothing built)
- **Goal:** decide the safe contract **write** model **before** any create/edit UI. Recorded in [13_CONTRACT_STEWARD_WRITE_DESIGN](./13_CONTRACT_STEWARD_WRITE_DESIGN.md). **No migration, no RLS change, no UI, no audit, no write path.**
- **Verified finding:** the write **RLS authority already exists** (`0002`/`0004`): INSERT/UPDATE for tenant owner/admin/editor **or** procurement-org `manager`; **`paying_org_id` = read only** (read ≠ write); **no `DELETE`/`FOR ALL`**; tenant-bound by the `enforce_owning_org_tenant` trigger. Matches the recommended steward model.
- **What a write PR must add (gated by that RLS):** a server-action write path on the **anon user-scoped client** (never service-role; validation is not authorization); and UI (RLS is the boundary, no client-side authz filtering). Land doc 13 §7 tests **before** UI. `paying_org_id` must never grant write.
- **Out of scope:** contract archive/soft-delete (separate design), `app_contracts` link writes, files/invoices/license. OMC/Flywheel cutover stays **blocked**.

### Stage 5b′ — Contract audit-on-write ✅ (PR #29, `0010` — invisible backend)
- **Goal:** record every accepted contract `INSERT`/`UPDATE` **before** any write surface exists. A DB-side `SECURITY DEFINER` `AFTER INSERT OR UPDATE` trigger `contracts_audit_on_write` appends one append-only `audit_logs` row per accepted write (`actor = auth.uid()`, curated non-sensitive `after_json`). Required because `audit_logs` is append-only with **no `authenticated` INSERT** — so audit MUST be DB-side, **never** a service-role route.
- **Invisible:** **no** policy/authz change (existing RLS still decides writes), **no** UI/route/workflow change, **no** `DELETE`/`FOR ALL`, **no** service-role, **no** `database.types.ts` change. `AFTER`, so denied/failed writes never audit.
- **Verified:** `test-rls.sh` 153 → **177** (T31 audit-on-write, T32 catalog). [13 §4](./13_CONTRACT_STEWARD_WRITE_DESIGN.md), [02 §4a](./02_SECURITY_AND_RLS.md). RISK-002 + RISK-016 open; cutover stays **blocked**. **Next: the write path, then create/edit UI matching legacy.**

### Stage 5b″ — Contract write PATH ✅ (PR #30 — backend write path, no UI)
- **Goal:** the safe server-side contract create/update **path** the future create/edit UI will call — gated by the existing RLS, never bypassing it. **No migration, no RLS/policy change, no UI, no route, no service-role, no `database.types.ts` change.** RLS stays **177**.
- **DAL (`src/lib/data/contracts.ts`):** `createContractForCurrentUser` / `updateContractForCurrentUser` on the **user-scoped anon server client** (the same client as reads). RLS (`0004`) authorizes; the app does only session/context resolution + input validation (validation ≠ authz). `tenant_id` is resolved **server-side** (`resolveTenantContext` → `resolveWriteContextTenantId`), **never** taken from the caller; update never sets `tenant_id`. Typed `ContractWriteResult`; a denied/missing row collapses to `not_allowed` (no enumeration).
- **Pure helpers (`src/lib/data/contract-write.ts`, unit-tested):** `parseContractWriteInput` (required `contract_name`, empty→null, default-bearing columns omitted when empty, date/uuid/number checks, PATCH semantics), `resolveWriteContextTenantId`, `classifyContractWriteError`. **Server actions (`contracts/actions.ts`, `"use server"`):** thin wrappers, **not wired to UI** (no route added).
- **Audit inherited:** an accepted write is audited by the `0010` `AFTER` trigger automatically — **no** audit code, **no** service-role audit route.
- **Verified:** `npm test` 12 → **36** (`contract-write.test.ts`, 24 cases). No new SQL — the authority + audit + no-DELETE/no-FOR-ALL are already proven by `org_rls_test.sql` **T9/T14/T20/T21/T31/T32** ([13 §7](./13_CONTRACT_STEWARD_WRITE_DESIGN.md)). RISK-002 + RISK-016 open; cutover stays **blocked**. **Next: the create/edit UI (PR #31, below).**

### Stage 5b‴ — Contract create/edit UI 🟡 (PR #31 — first write workflow, Partial parity)
- **Goal:** the first **user-visible** contract write workflow, matching the legacy contract form as far as v3's schema allows. Legacy inspected **first** ([15_LEGACY_CONTRACT_FORM_INSPECTION](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)) — no invented UI. **No migration, no RLS/policy change, no service-role, no `database.types.ts` change.** RLS stays **177**.
- **Built:** routes `/contracts/new` + `/contracts/[id]/edit`; a **New contract** button on `/contracts` and an **Edit** link on `/contracts/[id]`; a shared Client-Component form (`contract-form.tsx`) posting to the PR #30 `createContractAction`/`updateContractAction`; pure form helpers (`contract-form-shared.ts`, unit-tested); and an RLS-scoped org-list read DAL (`src/lib/data/organizations.ts`) for the procurement/paying org `<select>`s (no broad/cross-tenant reads, no service-role).
- **Authorization = RLS, not the UI:** affordances shown to any viewer (v3 does **NOT** port legacy's client `user.role` gate); the server action + DAL + RLS decide. Denied save → generic `not_allowed` (no enumeration); `tenant_id` never sent (server-resolved); accepted saves audited by `0010`; create→/contracts/[id], edit→/contracts/[id], cancel→list/detail.
- **Partial parity (honest):** v3 supports only its own columns (`contract_name`, `vendor_name`, `status`, `total_cost`+`currency`, `start_date`, `renewal_date`, `end_date`, `renewal_responsibility`, `procurement_org_id`, `paying_org_id`). Legacy `category`/`procurementDate`/`notes`/`poNumber`/`autoRenew`/`monthToMonth`/`commodity_*`/`validated` + PDF-upload/AI-extraction have **no v3 column/surface** → not built; legacy edited **inline**, v3 uses a dedicated `/edit` route. **No delete/archive, no link/unlink, no files, no gantt.**
- **Verified:** `npm test` 36 → **44** (`contract-form-shared.test.ts`, 8 cases); `next build` shows `/contracts/new` + `/contracts/[id]/edit`; `check-auth-safety` pass. RISK-002 + RISK-016 open; **cutover stays blocked** (Partial parity is not a cutover signal).

### Stage 5b⁗ — Contract form parity fields 🟡 (PR #32, `0011` — closes schema-backed gaps)
- **Goal:** close the **low-risk, schema-backed** legacy field gaps from PR #31 by adding the columns + form fields v3 can safely support now. Legacy re-read first ([15](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)). **No RLS/policy change, no service-role, no audit-trigger change, no DELETE/FOR ALL.** RLS stays **177**.
- **Migration `0011`:** additive `alter table public.contracts add column` — `category text`, `procurement_date date`, `notes text`, `po_number text` (nullable) + `auto_renew boolean not null default false`, `month_to_month boolean not null default false`. Non-destructive (existing rows read NULL / false). Existing write authority (`0004`) + audit (`0010`) govern the new columns automatically.
- **Built:** read DAL (`ContractDetail` + `ContractSummary.category`), the form (Category `<select>`, Procurement date, PO number, Notes textarea, Auto renew + Month-to-month checkboxes), the detail page (+ a Category column on the list). Parser handles new nullable text/date (empty→null) + booleans (strict `=== true`, never null).
- **Still NOT built (Partial parity):** `commodity_*` (hidden in legacy) + `validated` (read-only) deliberately omitted; PDF/AI, gantt, delete/archive, link/unlink, files, list-page inline-edit — not built.
- **Verified:** `npm test` 44 → **51** (+7 unit tests); `next build` routes unchanged; `test-rls.sh` re-applies `0001`–`0011` → **177**; `gen-types-local.sh` updates `database.types.ts` with the 6 columns. RISK-002 + RISK-016 open; **cutover stays blocked**. **Next: PDF/AI design (PR #33, below), then implement, then remaining gaps.**

### Stage 5b⁵ — Contract PDF upload + AI extraction DESIGN 📐 (PR #33, design only — nothing built)
- **Goal:** plan the **secure** contract PDF upload + AI extraction workflow **before** building any of it. Legacy pipeline inspected first ([16 §0](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)) — the legacy anti-patterns (client-only MIME check, service-role Storage Cloud Function, no prompt-injection defense, wholesale AI fields, auto-overwrite of contract fields, tokenized public URLs) are documented to **NOT port**. **No code, no migration, no RLS, no Storage bucket, no AI call, no UI, no `database.types.ts` change.**
- **Design (deferred):** assistive upload panel (not the primary create path); DB `files` row = source of truth; **private** bucket, **server-derived tenant-bound** object paths, **short-lived signed URLs** (no public URLs); **server-side** extension/MIME/magic-byte/size validation + a **`scan_status` gate** before extraction; AI returns **suggestions only**, parsed with a **strict allowlist (a safe SUBSET of the PR #30 writable fields** — not the authority-bearing `procurementOrgId`/`payingOrgId`) and re-validated by `parseContractWriteInput`; the user **reviews + applies**, then **saves through the existing PR #30 RLS-gated action** (audited by `0010`). Future `files` columns, RLS (write = `0004`; `paying_org_id` never grants file write; default-deny + tests), and DB-side file/extraction audit are specified in [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md).
- **Hard nots:** no AI auto-save; **no service-role app route** (any async worker re-derives tenant authz out of the request path); PDF text + AI output are **untrusted**. RISK-002 + RISK-016 open; **cutover + onboarding stay blocked**. **Next: implement per [16 §10](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) — migration → RLS+tests → Storage+validation → extraction worker → UI → audit, each its own PR.**

### Stage 5b⁶ — Files metadata foundation 🟡 (PR #34, `0012` — schema only, table NOT surfaced)
- **Goal:** the **first DB step** of the [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) plan — add the metadata columns the future PDF/AI workflow needs, **without surfacing the table**. **No upload, Storage, bucket, signed URLs, scan/AI, Edge Function, UI, route, service-role, or RLS policy.** `files` stays RLS-enabled but **DEFAULT-DENY / not surfaced**.
- **Migration `0012` (additive):** `files` gains `contract_id`, `storage_bucket`, `content_type`, `byte_size`, `sha256` (nullable) + `upload_status`/`scan_status` (default `pending`), `extraction_status` (default `not_started`), `extraction_result_json`, `extraction_error`, `updated_at`. Composite **same-tenant FK** `(contract_id, tenant_id) → contracts(id, tenant_id)` (the `0005` pattern); **CHECK** constraints on the status enums + `byte_size ≥ 0` + 64-hex `sha256`; tenant-scoped indexes. No `updated_at` trigger (schema convention — default-only). Safe for existing rows (nullable / NOT NULL-with-default).
- **Tests:** RLS `org_rls_test.sql` **177 → 186** (new **T33**, +9): same-tenant attachment OK, cross-tenant attachment rejected (FK), each CHECK rejects out-of-range values, catalog `files` = 0 DELETE / 0 FOR ALL / 0 policies with RLS on, and a tenant member reads 0 files (default-deny). `gen-types` adds only the 11 `files` columns; `npm test` 51/51 (no app code uses them yet).
- **Still NOT built:** file UI, upload, Storage bucket, signed URLs, scan jobs, AI extraction, RLS surfacing. RISK-002 + RISK-016 open; **cutover + onboarding stay blocked**. **Next: the `files` RLS PR (§5 of doc 16) with its own tests.**

### Stage 5b⁷ — Files RLS policies 🟡 (PR #35, `0013` — tested authorization, table NOT surfaced)
- **Goal:** the §5 step of [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) — the first **tested** `files` RLS policies, so the table is no longer zero-policy. **Policies only:** no Storage bucket, upload route, signed URLs, scan/AI/OCR, Edge Function/worker, service-role, UI, or app DAL. No table/column change.
- **Migration `0013`:** **SELECT** `is_tenant_member(tenant_id)` (tenant-member read; org-scoped read deferred) + **INSERT** `uploaded_by = auth.uid() AND can_write_contract(contract_id, tenant_id)` — the `0004` contract-write authority (tenant editor+ OR procurement-org manager; **`paying_org_id` grants no write**). New `SECURITY DEFINER` helper `can_write_contract` (mirrors the existing helpers; never references `paying_org_id`; no recursion). **NO UPDATE** (status transitions = a future worker — docs/16 §6/§8), **NO DELETE, NO `FOR ALL`**.
- **Tests (T34 + T27/T33 updated):** tenant-member read isolation (cross-tenant / non-member / org-only read 0); editor + procurement-manager insert allowed; **paying-org manager / tenant viewer / cross-org manager denied**; **uploaded_by spoof denied**; cross-tenant attach rejected (FK); DELETE + UPDATE denied. RLS suite **186 → 205**; `gen-types` adds only `can_write_contract`; `npm test` 51/51; routes unchanged.
- **Deliberate asymmetry / still NOT built:** an org procurement-manager can now INSERT a file for their contract but cannot yet LIST files (read is tenant-member-only — org-scoped read is the next broadening). No Storage/upload/signed-URL/scan/AI/UI; `files` is **still not surfaced**. RISK-002 narrows for `files`, stays OPEN; RISK-016 open; **cutover + onboarding stay blocked**. **Next: private Storage bucket + server-side validation (docs/16 §3), then the extraction worker / UI.**

### Stage 5 (writes) · Stage 6 — People · Stage 7 — License rules/evaluations · Stage 8 — Files/invoices
- **Goal:** the source-of-truth surfaces, read first then writes (steward-only). **Contract write model: [13](./13_CONTRACT_STEWARD_WRITE_DESIGN.md).**
- **P0 risks:** writes outside RLS; child tables **not org-scoped for reads** — `people` is **tenant-only**, and `identity_accounts`/`license_rules`/`license_evaluations`/`files`/`invoices` are **default-deny** (no read policy). (`app_contracts` — `0006` — `app_users` — `0007` — and `app_user_identity_matches` — `0008` — are now org-scoped read.) Add org-scoped read policies + tests **before** any further per-org surface ships (RISK-002; canonical map [02 §8](./02_SECURITY_AND_RLS.md)). Also: destructive edits without audit; no identity matching / license eval / provisioning yet.
- **Delete guardrail (PR #16 / `0004`):** core evidence tables have **no hard-delete** policy — write surfaces add `INSERT`/`UPDATE` only; never re-add `FOR ALL`/`DELETE`. **Hard delete + archive/soft-delete UI are deferred** to a future audited admin/break-glass path (not built — RISK-C07).
- **Integrity guardrail (PR #17 / `0005`):** child/link writes that reference a cross-tenant parent fail at the DB (composite same-tenant FKs). New child tables must add the same `(parent_ref, tenant_id) → parent(id, tenant_id)` FK. Org-scoped child-table **reads** are still deferred (RISK-002).
- **Tests:** steward write allowed, non-steward denied, related-org read works; audit row written on change.
- **Done:** each surface read-then-write under RLS, audited.

### Stage 9 — Audit log UI
- **Goal:** read-only audit viewer. **P0 risks:** exposing secrets in logged fields; any write path to `audit_logs`.
- **Tests:** no UI write path; safe fields only. **Done:** read-only, append-only respected.

### Stage 10 — Reports/exports (deferred)
- **Rule:** exports MUST be tenant-scoped; never export credentials/secrets; no cross-tenant rows. **Done:** scoped + audited export with tests.

### Stage 11 — Import flows (deferred)
- **Rule (pre-committed):** preview before write · upsert + soft-delete (no blind full-replace, no hard delete) · provenance + idempotency · row-level audit · duplicate detection. Ties to legacy findings ([current-security-risk-map.md](./current-security-risk-map.md)). **Done:** non-destructive, audited, tested import.

### Stage 12 — Integrations/connectors (deferred)
- **Rule:** credentials encrypted + service-role-only (never app tables/browser/logs/exports); dry-run; scoped tokens; no destructive deactivation without approval. Gated on a credential-vault design (RISK-007). **Done:** one connector behind the vault, idempotent, tested.

### Stage 13 — Org hierarchy / `resource_org_links` (deferred)
- **Goal:** parent→child org inheritance and/or relationship-based access replacing column union (RISK-003/004). **Done:** migration + RLS + tests; column model superseded intentionally.

### Stage 14 — Billing/pricing (deferred, only if needed)
- Build only if the product requires in-app billing beyond chargeback reporting.
