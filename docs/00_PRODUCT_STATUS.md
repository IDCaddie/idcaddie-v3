# 00 · Product Status — ID Caddie v3

**Canonical source for: current status.** First doc to read. Last verified against the
repo on 2026-06-16 (PRs through #28 merged; #29 adds contract **audit-on-write** `0010`). Status words are defined in [10_DOCS_INDEX](./10_DOCS_INDEX.md#status-taxonomy).

## What ID Caddie v3 is
An enterprise SaaS-governance platform: the source of truth for *what apps a company
uses, who owns/pays/renews each, which contract governs it, who has access, which
paid users are stale or unmanaged, and which costs charge back to which org/agency*.
Target customer: Omnicom/Flywheel (a holding company with many agencies). Product
scope detail: [v3-product-scope.md](./v3-product-scope.md).

## Why v3 exists (not a Firebase port)
The legacy Firebase/Firestore app is `legacy-production` and still serves users, but
its authorization was structurally unsafe: direct client→Firestore access, frontend
filtering as "security", duplicated permission documents, plaintext integration
credentials, mutable audit logs, and per-project (not per-row) tenant isolation.
Evidence: [current-security-risk-map.md](./current-security-risk-map.md),
[current-product-map.md](./current-product-map.md). v3 rebuilds the data + security
foundation on Postgres with RLS as the authorization source of truth. We **preserve
validated workflows, port no Firebase code**.

## Parity doctrine — same product, better backend
v3 is a **same-product-experience / better-backend replacement**, not a redesign. Users must feel
*"this is the same ID Caddie I know."* The backend improves (real tenant isolation, RLS, append-only
audit, non-destructive imports, same-tenant integrity, no hard deletes, better auth/session, safer
exports, cleaner schema), but the **user-facing workflow preserves legacy behavior unless a difference
is intentionally approved**. The per-workflow parity contract and the hard cutover gate live in
[14_LEGACY_UX_WORKFLOW_PARITY_MAP](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md): **cutover is blocked on
workflow parity, not on backend/RLS readiness alone.**

## Current phase
**Read-only governance foundation + contract write design.** The secure data/RLS foundation,
the auth/session skeleton, and read-only tenant/org context resolution are complete, and a set of
**read-only product surfaces** now ship on top of them (all RLS-scoped, no writes):
- `/apps` inventory (PR #13) and `/apps/[id]` app detail (PR #14)
- `/contracts` list and `/contracts/[id]` detail (PR #19)
- linked app↔contract panels on detail pages (PR #20)
- `/apps/[id]` app-user roster (PR #21), match-status column (PR #23), and account-summary card (PR #24)

**Design-only (docs, nothing built):** identity matching read-scope ([12](./12_IDENTITY_MATCHING_READ_SCOPE.md),
PR #22 — only the match-*status* slice is built) and the contract steward **write** path
([13](./13_CONTRACT_STEWARD_WRITE_DESIGN.md), PR #25 — the write *RLS authority* already exists in `0004`,
but the write path / UI / audit do **not**).

**Built (invisible backend):** contract **audit-on-write** — a DB-side `SECURITY DEFINER` `AFTER INSERT/UPDATE`
trigger on `contracts` (`0010`, PR #29) that appends one append-only `audit_logs` row per accepted write,
actor = `auth.uid()`. No policy/RLS/route/UI change; no user-visible effect.

**Not built:** anything applied to a **hosted Supabase environment**; contract write path/UI (the *audit* now exists — the write
*path* does not); archive / soft-delete; `app_contracts` writes; UAR / unmanaged-account report; identity matching *algorithm*;
`people` org-read (stays tenant-only); `identity_accounts` read (default-deny); license rules/evaluation;
spend/chargeback; files/invoices; people directory; provisioning; tenant switching; imports/exports;
connectors. **OMC/Flywheel cutover and new paid-customer onboarding remain blocked.**

## Merged PRs
**PRs #1–#28 are merged** (main @ `4a58857`); **PR #29 (contract audit-on-write `0010`) is this PR.** The full
per-PR engineering log is the canonical source — see [05_ENGINEERING_CHANGELOG](./05_ENGINEERING_CHANGELOG.md);
do not maintain a second PR table here (it drifts). Milestone summary:
- **Foundation / discipline:** RLS foundation + tests (#1/#2), migration discipline (#3), clean-app
  operating system + docs/CI (#4), app CI (#15).
- **Auth + data layer:** auth/session skeleton (#6), tenant/org context (#9), demo fixture (#10), typed read-only DAL (#11).
- **Security hardening (migrations):** destructive-delete hardening `0004` (#16), same-tenant integrity `0005` (#17),
  child-table read truth-pass (#18), org-scoped reads `0006`/`0007`/`0008` for app_contracts/app_users/app_user_identity_matches (#20/#21/#23),
  `app_contracts` read tenant-bind `0009` (#27), contract **audit-on-write** `0010` (#29).
- **Read-only surfaces:** app inventory (#13), app detail (#14), contracts list+detail (#19), linked panels (#20),
  app-user roster (#21), match status (#23), account summary (#24).
- **Design / parity docs (nothing user-facing built):** identity matching read-scope (#22), contract steward write design (#25), docs truth pass (#26), legacy UX/workflow parity map (#28).

Migration `0001` (core schema) predates the numbered PRs (rebuild starter pack).

## Status of the foundation
| Item | Status |
|------|--------|
| Migrations `0001`–`0010` (core schema, org RLS, related-org read, delete hardening, child integrity, org-scoped child reads + tenant-bind hardening, contract audit-on-write) | `implemented`, `verified-local`, `ci-enforced`; `not-hosted-applied` |
| RLS model (tenant isolation, steward writes, related-org reads, audit immutability, no admin self-promotion) | `implemented`, `verified-local` (177 assertions in `org_rls_test.sql`), `ci-enforced` (PR #2) |
| Contract **audit-on-write** (DB-side `SECURITY DEFINER` `AFTER INSERT/UPDATE` trigger → append-only `audit_logs`, actor = `auth.uid()`) | `implemented` (PR #29 — `0010`); `verified-local` (T31/T32: allowed writes audit once with the correct actor; denied/failed writes never audit; no direct `authenticated` audit insert; contracts keep 0 DELETE / 0 FOR ALL). Invisible backend; **write path/UI still not built** |
| No normal hard-delete of core evidence tables (`organizations`/`apps`/`contracts`/`app_contracts`/`people`/`app_users`) | `implemented` (PR #16 — `0004`; `FOR ALL` split into `INSERT`+`UPDATE`, no `DELETE`); `verified-local` (T17/T24/T25). Archive/soft-delete UI **not built** |
| Same-tenant child integrity (cross-tenant child/link writes fail at the DB) | `implemented` (PR #17 — `0005`; composite `(parent_ref, tenant_id)` FKs); `verified-local` (T26). Org-scoped child-table **reads** still deferred (RISK-002) |
| Migration safety (numbering, unsafe keywords) | `ci-enforced` (PR #3) |
| Migrations applied to hosted Supabase (staging/prod) | **not done** — `not-hosted-applied` |
| Auth/session skeleton (login, server session via Proxy, protected route group, no service-role) | `implemented` (PR #6); `verified-local` (build + `check-auth-safety.sh`); **not** exercised against hosted Supabase Auth |
| Tenant/org context resolution (read-only; memberships → active tenant + org list, RLS-scoped) | `implemented` (PR #9); `verified-local` (build + unit tests); **not** exercised against hosted Supabase |
| Tenant switching UI / user provisioning / invites | `planned` (not built; deterministic first tenant chosen — RISK-012) |
| Local/demo data fixture (synthetic; never hosted-applied) | `implemented` (PR #10 — `supabase/fixtures/local_demo.sql` via `scripts/seed-local-demo.sh`); local-only |
| Typed DB types + read-only data access layer (server-only) | `implemented` (PR #11 — generated `database.types.ts`, typed server client, `src/lib/data/apps.ts`); `verified-local` (typed build) |
| Read-only app inventory screen (`/apps`) | `implemented` (PR #13 — first product surface, server-rendered, typed DAL, RLS-scoped); `verified-local` (build + RLS query: owner sees all tenant apps, org-only user sees only related, non-member sees none) |
| Read-only app detail screen (`/apps/[id]`) | `implemented` (PR #14 — server-rendered, typed DAL, route id is lookup-only not authz); `verified-local` (RLS query: owner reads all 3 details, org-only reads only its 2 related, unrelated/non-member → not_found) |
| Read-only contracts list + detail (`/contracts`, `/contracts/[id]`) | **`partial` — read-only only** (PR #19 — server-rendered, typed DAL `src/lib/data/contracts.ts`, route id lookup-only, related-org RLS). Direct `contracts` columns; **linked apps now shown read-only (PR #20)**; invoices/files still NOT shown (default-deny — RISK-002). No create/edit/delete/import/export. `verified-local` (RLS spot-check: owner sees both tenant contracts; related-org user sees only its related; unrelated org-only + non-member → not_found) |
| Read-only linked apps ↔ contracts panels (`/contracts/[id]`, `/apps/[id]`) | **`partial` — read-only only** (PR #20 — `0006` org-scoped `SELECT` on `app_contracts`, typed DAL `src/lib/data/links.ts`). Shows only links to apps/contracts the user may read; **no linking/unlinking/editing**. `verified-local` (T28 + spot-check: org-only users see only related links; cross-tenant + non-member → none) |
| App CI (lint · vitest · `tsc --noEmit` · `next build`) + deterministic build (system fonts, no remote font fetch) | `implemented` + `ci-enforced` (PR #15 — `.github/workflows/app-ci.yml`); metadata/README hygiene fixed |
| Invoices · files · license surfaces · app-contract linking *writes* · contract writes | `deferred` (default-deny tables or write surfaces — not built; RISK-002 open for reads) |
| Product **write** workflows (create/edit/people directory/reports/imports/exports) | `planned` / `deferred` — **read-only** apps, app detail, contracts, contract detail, linked panels, app-user roster, match status, and account summary already ship (see rows above); no write UI yet |
| Read-only app-user roster (`/apps/[id]` "App users") | **`partial` — read-only only** (PR #21 — `0007` org-scoped `SELECT` on `app_users`, typed DAL `src/lib/data/app-users.ts`). Direct `app_users` columns only; org-only users see only users of apps they may read. **No** matching/provisioning/utilization/edit. `verified-local` (T29 + spot-check: org-only users see only related apps' users; cross-tenant + non-member → none) |
| Child-table read scope (canonical map: [02 §8](./02_SECURITY_AND_RLS.md), pinned by T27/T28/T29/T30) | `partial` — `app_contracts` (`0006`) + `app_users` (`0007`) + `app_user_identity_matches` (`0008`) now **org-scoped read**; **tenant-only** (`people`) + **default-deny** (`identity_accounts`/`license_*`/`files`/`invoices`) remain; org-only users read none of those. Org-scoped reads for the rest still `deferred` (RISK-002, narrowed not closed) |
| Read-only app-user **match status** (`/apps/[id]` "Match" column) | **`partial` — read-only status only** (PR #23 — `0008` org-scoped `SELECT` on `app_user_identity_matches`, typed DAL `src/lib/data/app-user-matches.ts`). Shows matched/unmatched (+ optional method/confidence) for app_users you may read; **no `person_id`, no person name, no identity-account details, no PII**. `verified-local` (T30 + spot-check). **No matching algorithm / merge / UAR / orphaned status / provisioning.** `people` tenant-only + `identity_accounts` default-deny (unchanged). RISK-002 + RISK-016 open |
| Read-only **account summary** (`/apps/[id]` "Account summary" card) | **`partial` — read-only, derived** (PR #24 — pure helper `src/lib/data/app-account-intelligence.ts`, unit-tested). Counts from **visible `app_users` + visible matches only**: visible/matched/unmatched/match-rate, status breakdown, stale candidates (>90d). **No migration / RLS change.** **NOT UAR** — no `people`/`identity_accounts`/license/files/invoices/PII; no orphaned/deactivated/managed label, no matching algorithm, no provisioning. RISK-002 + RISK-016 open |
| Contract **write** path (create/edit) | **`design` + audit only — no write surface built.** Write **RLS authority** exists (`0002`/`0004` — tenant editor+ **or** procurement-org `manager`; `paying_org_id`=read-only; **no `DELETE`/`FOR ALL`**; tenant-bound by trigger) and **audit-on-write is now implemented** (PR #29 — `0010`; DB-side `SECURITY DEFINER` trigger, never service-role). **Still not built:** write UI, server-action/DAL write path. No archive/soft-delete, no `app_contracts` writes, no hard delete. Design: [13_CONTRACT_STEWARD_WRITE_DESIGN](./13_CONTRACT_STEWARD_WRITE_DESIGN.md). RISK-002 + RISK-016 open; OMC cutover blocked |
| `resource_org_links` relationship table + org hierarchy | `deferred` |
| Imports/exports, integrations/connectors, credential vault | `deferred` |
| Legacy Firebase | `legacy-production` (still serving customers) |
| Legacy→v3 capability parity / OMC (Flywheel) cutover gate | tracked (PR #12 — [11_LEGACY_PARITY_AND_OMC_CHECKLIST](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md)); **no cutover until P0/P1 parity `verified` + signed off** |
| Vercel Web Analytics + Speed Insights (platform telemetry) | `implemented` (PR #5, PR #7); platform-only, see below |

## Platform telemetry (Vercel)
Vercel **Web Analytics** (`@vercel/analytics`, PR #5) and **Speed Insights**
(`@vercel/speed-insights`, PR #7) are integrated in the root layout. They are **platform
performance/traffic telemetry only** — page views and Core Web Vitals.
- They are **not** product analytics, audit logs, authorization, billing, customer reporting, or compliance evidence, and must never be used as a source of truth for any of those.
- **No custom tracking events** are implemented (the bare `<Analytics />` / `<SpeedInsights />` components only).
- No PII / tenant IDs / user emails / app or contract names / spend data / tokens / credentials are sent.
- **No production or custom-domain traffic is intentionally pointed at v3 yet**; legacy Firebase remains production.
- Architecture: [01 · Platform telemetry](./01_ARCHITECTURE.md#platform-telemetry-vercel). Open privacy review: [04 · RISK-013](./04_RISK_REGISTER.md).

## What is NOT verified
- Nothing has run against hosted Supabase. The shim used by `test-rls.sh` mimics
  Supabase's `auth.uid()`/roles but is not Supabase itself; first hosted apply is unproven.
- The GitHub-hosted CI run validates the Docker flow on `ubuntu-latest`; confirm it
  stays green (it is `ci-enforced`, not assume-green).
- The auth skeleton **compiles and passes static safety checks**, but login/logout have
  not been exercised against a live Supabase Auth instance (no hosted env). The end-to-end
  login → session → protected-route flow is unproven against real Supabase.

## Key decisions (ADR-lite)
One-line decisions; deep rationale in the linked canonical docs.
| Decision | Why | Revisit when | Where |
|---|---|---|---|
| Rebuild on Supabase/Postgres + RLS, not port Firebase | legacy authz unsafe & unportable | — (settled) | this doc, [02](./02_SECURITY_AND_RLS.md) |
| `tenant_id` on every tenant row = hard boundary | one provable isolation primitive | — | [02](./02_SECURITY_AND_RLS.md) |
| Steward-only **writes**, related-org **reads** (union of owning-org columns) | chargeback needs multi-org read; edits need one accountable org | multi-org sharing grows → `resource_org_links` | [02](./02_SECURITY_AND_RLS.md) |
| Audit logs append-only (trigger blocks update/delete for all roles) | tamper-evidence; legacy P0 was mutable logs | retention/archival design needed | [02](./02_SECURITY_AND_RLS.md), [04](./04_RISK_REGISTER.md) |
| Migrations append-only after merge; hosted apply is a separate reviewed step | deployed state must stay knowable | — | [03](./03_DATABASE_AND_MIGRATIONS.md) |
| No UI before the data/security foundation is proven | avoid building on unsafe authz | foundation `verified-local`+`ci-enforced` (now true) → UI may start read-only | [06](./06_BUILD_SEQUENCE.md) |
| Child-table org scoping deferred | not needed until those tables carry org-sensitive reads | a feature reads them per-org | [02](./02_SECURITY_AND_RLS.md), [04](./04_RISK_REGISTER.md) |

## Do-not-do-yet list
- Do **not** apply migrations to hosted Supabase (no reviewed deployment process exercised yet).
- Do **not** build UI that bypasses RLS or filters data in the client for "security".
- Do **not** use service-role keys outside trusted server/test paths.
- Do **not** add connectors/credential handling until the encrypted-credential boundary is designed.
- Do **not** edit a merged migration (`0001`–`0010`) — fix forward with a new migration.
- Do **not** cut OMC/Flywheel off legacy Firebase until all P0/P1 parity items are `verified` + signed off ([11](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md)).

## Can we…?
- **Deploy v3 to customers today?** No. Only **read-only** surfaces exist (no writes), **nothing is applied
  to a hosted Supabase environment**, and legacy Firebase is still production.
- **Cut OMC/Flywheel over to v3?** **No — blocked** until all P0/P1 parity items are `verified` + signed off ([11](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md)).
- **Onboard a new paid customer?** **No — blocked.** No hosted environment, no write/provisioning path, no UAR/reporting parity.
- **Safely keep building on this foundation?** Yes — *after* `scripts/check-docs-updated.sh`,
  `check-migration-safety.sh`, and `test-rls.sh` pass. The RLS model is tested and CI-enforced.

## Next recommended PRs (the read-only surfaces above are done; contract audit-on-write `0010` is now done — PR #29)
1. **Contract write path** — a server action on the anon client (never service-role; validation ≠ authz), gated by the **existing** RLS, landing [13 §7](./13_CONTRACT_STEWARD_WRITE_DESIGN.md) tests **before** UI. Audit-on-write (`0010`) already records every accepted write.
2. **Contract create/edit UI** — last, after the write path + tests; must **match the legacy contract-form workflow** ([14 §3](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md), fields/actions = `needs legacy inspection` first).
3. First reviewed **hosted-Supabase apply** (RISK-001 — still nothing applied to any hosted env).

(These are `planned`. Each must follow [07_P0_REVIEW_CHECKLIST.md](./07_P0_REVIEW_CHECKLIST.md) and update [04](./04_RISK_REGISTER.md)/[05](./05_ENGINEERING_CHANGELOG.md). Detailed ordering: [09_AGENT_HANDOFF](./09_AGENT_HANDOFF.md).)
