# 01 · Architecture

**Canonical source for: architecture & repo structure.** Security/RLS detail lives in
[02_SECURITY_AND_RLS.md](./02_SECURITY_AND_RLS.md) — this doc links there, never restates it.

## Stack
| Layer | Choice | Status |
|---|---|---|
| Frontend | Next.js App Router (TypeScript) | auth shell `implemented`; **read-only** product UI `implemented` (apps, app detail, contracts, contract detail, linked panels, app-user roster, match status, account summary); write UI `planned` |
| Auth | Supabase Auth (`@supabase/ssr`) | skeleton `implemented` (email+password, server session via Proxy); `verified-local` (build); not hosted-exercised |
| Database | Supabase Postgres | schema `implemented`, `not-hosted-applied` |
| Authorization | Postgres Row-Level Security | `implemented`, `verified-local`, `ci-enforced` |
| Storage | Supabase Storage | `deferred` |
| Hosting | Vercel | `planned` |
| Tests | SQL/RLS assertions (`psql`), Playwright (future) | RLS lane `ci-enforced`; E2E `planned` |

Dependencies present (`package.json`): `@supabase/supabase-js`, `@supabase/ssr`, `zod`,
`@vercel/analytics`, `@vercel/speed-insights`. No ORM — SQL + RLS are the contract.

## Platform telemetry (Vercel)
`@vercel/analytics` (Web Analytics, PR #5) and `@vercel/speed-insights` (Speed Insights, PR #7)
are installed; `src/app/layout.tsx` renders bare `<Analytics />` and `<SpeedInsights />` in the
root layout. They run as **Vercel platform telemetry** — anonymous page views and Core Web Vitals.
- **No custom events** (no `track()` calls); no PII, tenant IDs, user emails, app/contract names, spend data, tokens, or secrets are sent.
- They **must not** become a source of truth for product usage, billing, audit, security, authorization, customer reporting, or compliance. Those live in Postgres/RLS and the audit log.
- Needs a production privacy/telemetry review before any real customer traffic is pointed at v3 ([04 · RISK-013](./04_RISK_REGISTER.md)).

## Repo structure
```
src/app/                 root layout · login/ · logout/ · (authenticated)/ group: apps/ · apps/[id]/ · contracts/ · contracts/[id]/ (read-only product screens)
src/proxy.ts             Next.js 16 Proxy (renamed Middleware): session refresh + route guard
src/lib/supabase/        env · client (browser) · server (user-scoped, typed with Database) · proxy (session helper)
src/lib/auth/            session (current user) · tenant-context (RLS-scoped resolver) · tenant-context-derive (pure logic + tests)
src/lib/data/            server-only, read-only DAL (apps · contracts · links · app-users · app-user-matches · app-account-intelligence) — typed DTOs over the user-scoped client
src/lib/database.types.ts generated Supabase types (via scripts/gen-types-local.sh; do not hand-edit)
supabase/migrations/     0001 core schema · 0002 org RLS · 0003 related-org read · 0004 delete hardening · 0005 child integrity · 0006-0008 org-scoped child reads   (append-only)
supabase/tests/          org_rls_test.sql (152 assertions, T1-T30) · rls_test_plan.md
scripts/                 test-rls.sh · check-migration-safety.sh · check-docs-updated.sh · pr-review-summary.sh · check-auth-safety.sh · gen-types-local.sh
.github/workflows/       app-ci.yml (lint/test/tsc/build) · rls-tests.yml · migration-safety.yml · review-discipline.yml
docs/                    canonical docs 00-13 (this set) + design/legacy docs (see 10_DOCS_INDEX)
claude/                  agent rules + prompts
```
Full map + onboarding path: [10_DOCS_INDEX.md](./10_DOCS_INDEX.md).

## Authorization is in the database, not the app
RLS is the **single source of truth** for who can read/write which row. The app (and
any future UI) is a thin client that runs queries *as the authenticated user*; it never
decides access and never filters for security. This is the deliberate inversion of the
legacy Firebase pattern. The model: [02_SECURITY_AND_RLS.md](./02_SECURITY_AND_RLS.md).

## Domain model (entities)
`tenants` → `organizations` (agencies/BUs, self-referential hierarchy column present but
hierarchy traversal `deferred`) → `apps`, `contracts` (with owning-org FK columns) ·
`people`/`identity_accounts` ↔ `app_users` (identity matching) · `license_rules`/
`license_evaluations` · `files`/`invoices` · `audit_logs`. Membership: `tenant_memberships`
(owner/admin/editor/viewer) and `organization_memberships` (manager/viewer). Full schema:
[v3-data-model.md](./v3-data-model.md). Migrations: [03_DATABASE_AND_MIGRATIONS.md](./03_DATABASE_AND_MIGRATIONS.md).

## Why Firebase is not ported
| Legacy pattern | v3 replacement |
|---|---|
| Direct client→Firestore reads/writes | Server queries under RLS |
| Frontend filtering as authorization | RLS `USING`/`WITH CHECK` policies |
| Duplicated permission subcollections synced by triggers | live joins on membership tables |
| Roles in JWT custom claims (refresh lag) | role rows read live by RLS |
| Per-project tenant isolation | `tenant_id` column + RLS on every tenant row |
| Plaintext integration credentials in app docs | encrypted, service-role-only store (`deferred`, boundary reserved) |
| Mutable / 90-day-purged audit logs | append-only `audit_logs` (trigger-enforced) |

Rejected-pattern evidence: [current-security-risk-map.md](./current-security-risk-map.md).

## Server/client boundary
- **Client:** render only; calls server actions / route handlers; holds no secrets; never the service-role key. *(No interactive client components yet; `src/lib/supabase/client.ts` is the browser-client seam for future use.)* — partly `implemented`.
- **Server (Next.js, user-scoped):** `src/lib/supabase/server.ts` builds a Supabase client bound to the request's auth cookies (anon key only), **typed with the generated `Database`**; all reads/writes flow through RLS. The login Server Action, `getSessionUser()`, and the `src/lib/data/` DAL use it. — `implemented`.
- **Data access layer (`src/lib/data/`):** server-only (imports `next/headers` transitively), **read-only** typed helpers (e.g. `listAppsForCurrentUser()`) returning column-subset DTOs. They take **no** `tenant_id` from the caller — RLS scopes visibility. Never import them from Client Components. — `implemented` (apps, contracts, links, app-users, app-user matches, account-intelligence; same read-only column-subset shape; org/people-directory DALs follow when those screens land).
- **Proxy (`src/proxy.ts`):** in Next.js 16, Middleware is renamed **Proxy** (`node_modules/next/dist/docs/.../16-proxy.md`). It refreshes the session and redirects unauthenticated requests off protected routes. It does **not** read app data or decide tenant/org access. — `implemented`.
- **Trusted server jobs (service-role):** isolated; only for operations RLS can't express (audit writes, license evaluation, future imports). Never reachable from the browser. — `deferred` (no such code exists yet).

## Current vs target
- **Current:** Postgres schema + RLS (tested locally + CI) + an auth/session skeleton + read-only tenant/org context resolution (`src/lib/auth/tenant-context.ts`) + **read-only product surfaces** (apps, app detail, contracts, contract detail, linked panels, app-user roster, match status, account summary), all RLS-scoped. No tenant switching, **no write UI**, nothing hosted-applied.
- **Target (incremental, see [06](./06_BUILD_SEQUENCE.md)):** auth/session → tenant/org context → read-only inventory → contracts/people → writes → files/imports → connectors.

## What must exist before UI reads data
1. Auth/session wired to Supabase — `implemented` (skeleton; not hosted-exercised).
2. A user-scoped server Supabase client (RLS-bound) — `implemented` (`src/lib/supabase/server.ts`, no service-role in request paths).
3. Tenant/org context derived from membership rows (not client input) — `implemented` (`src/lib/auth/tenant-context.ts`, read-only, RLS-scoped; deterministic active tenant; no switching yet).
RLS already guarantees that even a wrong query cannot cross tenants — the context resolver just
lets the app *use* the foundation correctly. It reads only the user's own memberships via the
user-scoped server client (never service-role, never client-side filtering, never JWT claims).

## Intentionally missing today
Write UI / product workflows · tenant switching · user provisioning/invites · imports/exports · connectors/credentials ·
org-hierarchy traversal · remaining child-table org scoping (`people` stays tenant-only; `identity_accounts`/`license_*`/`files`/`invoices` default-deny) ·
contract write path/UI/audit · archive/soft-delete · hosted deployment. All tracked in
[04_RISK_REGISTER.md](./04_RISK_REGISTER.md) and sequenced in [06_BUILD_SEQUENCE.md](./06_BUILD_SEQUENCE.md).
