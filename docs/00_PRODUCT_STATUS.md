# 00 · Product Status — ID Caddie v3

**Canonical source for: current status.** First doc to read. Last verified against the
repo on 2026-06-15 (git `ee59c6c`). Status words are defined in [10_DOCS_INDEX](./10_DOCS_INDEX.md#status-taxonomy).

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

## Current phase
**Phase 2 — auth + tenant/org context (in progress).** The secure data/RLS foundation
(Phase 1) is complete; the **auth/session skeleton** (login, server session via Proxy,
protected route group) and **read-only tenant/org context resolution** are now built. The
protected shell displays the resolved context. No product UI (inventory/contracts/etc.); no
tenant switching or user provisioning. Nothing is **applied to any hosted Supabase environment**.

## Merged PRs (verified from `git log` / `gh pr list`)
| PR | Commit | What it added |
|----|--------|---------------|
| #1 | `f7c5c75` | Org-scoped RLS foundation (`0002`) + related-org read model (`0003`) + the `org_rls_test.sql` suite. Closed two live-verified bugs: cross-tenant org-pointer leak and tenant-admin self-promotion. |
| #2 | `bfffb84` | `scripts/test-rls.sh` + `.github/workflows/rls-tests.yml` — applies all migrations to a throwaway Postgres and runs the RLS suite on every PR. |
| #3 | `ee59c6c` | Migration discipline: `migration-workflow.md`, `migration-checklist.md`, `scripts/check-migration-safety.sh`, `.github/workflows/migration-safety.yml`. |
| #4 | `b245209` | Clean-app operating system: canonical docs `00`–`10`, PR template, docs-drift + reviewer-aid CI (`review-discipline.yml`), `check-docs-updated.sh` / `pr-review-summary.sh`. |
| #5 | `a86fb37` | Vercel Web Analytics integration (`@vercel/analytics` in the root layout). Automated PR; not part of the v3 build sequence. |

Migration `0001` (core schema) predates the numbered PRs (rebuild starter pack).
PR #6 (this branch, auth/session skeleton) is **not yet merged**.

## Status of the foundation
| Item | Status |
|------|--------|
| Schema `0001`, org RLS `0002`, related-org read `0003` | `implemented` |
| RLS model (tenant isolation, steward writes, related-org reads, audit immutability, no admin self-promotion) | `implemented`, `verified-local` (152 assertions in `org_rls_test.sql`), `ci-enforced` (PR #2) |
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
| Product UI / app workflows (people, reports, writes) | `planned` (read-only apps + contracts + linked panels exist) |
| Read-only app-user roster (`/apps/[id]` "App users") | **`partial` — read-only only** (PR #21 — `0007` org-scoped `SELECT` on `app_users`, typed DAL `src/lib/data/app-users.ts`). Direct `app_users` columns only; org-only users see only users of apps they may read. **No** matching/provisioning/utilization/edit. `verified-local` (T29 + spot-check: org-only users see only related apps' users; cross-tenant + non-member → none) |
| Child-table read scope (canonical map: [02 §8](./02_SECURITY_AND_RLS.md), pinned by T27/T28/T29/T30) | `partial` — `app_contracts` (`0006`) + `app_users` (`0007`) + `app_user_identity_matches` (`0008`) now **org-scoped read**; **tenant-only** (`people`) + **default-deny** (`identity_accounts`/`license_*`/`files`/`invoices`) remain; org-only users read none of those. Org-scoped reads for the rest still `deferred` (RISK-002, narrowed not closed) |
| Read-only app-user **match status** (`/apps/[id]` "Match" column) | **`partial` — read-only status only** (PR #23 — `0008` org-scoped `SELECT` on `app_user_identity_matches`, typed DAL `src/lib/data/app-user-matches.ts`). Shows matched/unmatched (+ optional method/confidence) for app_users you may read; **no `person_id`, no person name, no identity-account details, no PII**. `verified-local` (T30 + spot-check). **No matching algorithm / merge / UAR / orphaned status / provisioning.** `people` tenant-only + `identity_accounts` default-deny (unchanged). RISK-002 + RISK-016 open |
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
- Do **not** edit `0001`/`0002`/`0003` — fix forward with a new migration.
- Do **not** cut OMC/Flywheel off legacy Firebase until all P0/P1 parity items are `verified` + signed off ([11](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md)).

## Can we…?
- **Deploy v3 today?** No. No UI, no hosted DB, legacy Firebase is still production.
- **Safely keep building on this foundation?** Yes — *after* `scripts/check-docs-updated.sh`,
  `check-migration-safety.sh`, and `test-rls.sh` pass. The RLS model is tested and CI-enforced.
- **Next safest build step?** A read-only app inventory page over `apps`, RLS-scoped, using
  the resolved tenant/org context — no data mutation. See [06_BUILD_SEQUENCE.md](./06_BUILD_SEQUENCE.md).

## Next recommended PRs
1. Read-only app inventory page (first real screen) over `apps`, RLS-scoped (build-sequence Stage 4).
2. First steward-only write surface (e.g. contracts), audited.

(These are `planned`. Each must follow [07_P0_REVIEW_CHECKLIST.md](./07_P0_REVIEW_CHECKLIST.md) and update [04](./04_RISK_REGISTER.md)/[05](./05_ENGINEERING_CHANGELOG.md).)
