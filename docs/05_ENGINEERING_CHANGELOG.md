# 05 · Engineering Changelog

**Canonical source for: what every PR changed and why.** Engineering/security log — not
product release notes. **Every PR must add an entry** (or justify omission per
[09_DOCS_UPDATE rules in 08](./08_CODE_AND_DOCS_STANDARD.md)). Newest first. Seeded only
from PRs verified via `git log` / `gh pr list`.

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
