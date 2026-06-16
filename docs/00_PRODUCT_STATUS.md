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
**Phase 2 — auth/session skeleton (in progress).** The secure data/RLS foundation
(Phase 1) is complete; the **auth/session skeleton** is now built (login, server-side
session via Proxy, protected route group) but tenant/org context resolution is **not**
wired yet. No product UI exists. Nothing is **applied to any hosted Supabase environment**.

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
| RLS model (tenant isolation, steward writes, related-org reads, audit immutability, no admin self-promotion) | `implemented`, `verified-local` (66 assertions in `org_rls_test.sql`), `ci-enforced` (PR #2) |
| Migration safety (numbering, unsafe keywords) | `ci-enforced` (PR #3) |
| Migrations applied to hosted Supabase (staging/prod) | **not done** — `not-hosted-applied` |
| Auth/session skeleton (login, server session via Proxy, protected route group, no service-role) | `implemented` (PR #6); `verified-local` (build + `check-auth-safety.sh`); **not** exercised against hosted Supabase Auth |
| Tenant/org context resolution (memberships → scoped reads) | `planned` (next; placeholder stub only — `src/lib/auth/tenant-context.ts`) |
| Product UI / app workflows | `planned` (auth shell only; no inventory/contracts/etc.) |
| Child-table org scoping (`app_users`, `files`, `invoices`, `license_*`, `app_contracts`) | `deferred` (still tenant-scoped) |
| `resource_org_links` relationship table + org hierarchy | `deferred` |
| Imports/exports, integrations/connectors, credential vault | `deferred` |
| Legacy Firebase | `legacy-production` (still serving customers) |

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

## Can we…?
- **Deploy v3 today?** No. No UI, no hosted DB, legacy Firebase is still production.
- **Safely keep building on this foundation?** Yes — *after* `scripts/check-docs-updated.sh`,
  `check-migration-safety.sh`, and `test-rls.sh` pass. The RLS model is tested and CI-enforced.
- **Next safest build step?** Tenant/org context resolution (read-only) on top of the
  auth skeleton — no data mutation, RLS already covers reads. See [06_BUILD_SEQUENCE.md](./06_BUILD_SEQUENCE.md).

## Next recommended PRs
1. Tenant/org context resolution (read-only): derive memberships server-side from the
   membership tables, proving an RLS-scoped read end-to-end. Replaces the placeholder stub.
2. Read-only app inventory page (first real screen) over `apps`, RLS-scoped.
3. First steward-only write surface (e.g. contracts), audited.

(These are `planned`. Each must follow [07_P0_REVIEW_CHECKLIST.md](./07_P0_REVIEW_CHECKLIST.md) and update [04](./04_RISK_REGISTER.md)/[05](./05_ENGINEERING_CHANGELOG.md).)
