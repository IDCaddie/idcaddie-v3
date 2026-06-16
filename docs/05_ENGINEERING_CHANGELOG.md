# 05 · Engineering Changelog

**Canonical source for: what every PR changed and why.** Engineering/security log — not
product release notes. **Every PR must add an entry** (or justify omission per
[09_DOCS_UPDATE rules in 08](./08_CODE_AND_DOCS_STANDARD.md)). Newest first. Seeded only
from PRs verified via `git log` / `gh pr list`.

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
