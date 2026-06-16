# 05 · Engineering Changelog

**Canonical source for: what every PR changed and why.** Engineering/security log — not
product release notes. **Every PR must add an entry** (or justify omission per
[09_DOCS_UPDATE rules in 08](./08_CODE_AND_DOCS_STANDARD.md)). Newest first. Seeded only
from PRs verified via `git log` / `gh pr list`.

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
