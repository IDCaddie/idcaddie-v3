# 01 · Architecture

**Canonical source for: architecture & repo structure.** Security/RLS detail lives in
[02_SECURITY_AND_RLS.md](./02_SECURITY_AND_RLS.md) — this doc links there, never restates it.

## Stack
| Layer | Choice | Status |
|---|---|---|
| Frontend | Next.js App Router (TypeScript) | auth shell — `implemented` (login + protected group), product UI `planned` |
| Auth | Supabase Auth (`@supabase/ssr`) | skeleton `implemented` (email+password, server session via Proxy); `verified-local` (build); not hosted-exercised |
| Database | Supabase Postgres | schema `implemented`, `not-hosted-applied` |
| Authorization | Postgres Row-Level Security | `implemented`, `verified-local`, `ci-enforced` |
| Storage | Supabase Storage | `deferred` |
| Hosting | Vercel | `planned` |
| Tests | SQL/RLS assertions (`psql`), Playwright (future) | RLS lane `ci-enforced`; E2E `planned` |

Dependencies present (`package.json`): `@supabase/supabase-js`, `@supabase/ssr`, `zod`. No ORM — SQL + RLS are the contract.

## Repo structure
```
src/app/                 root layout · login/ · logout/ (route handler) · (authenticated)/ group
src/proxy.ts             Next.js 16 Proxy (renamed Middleware): session refresh + route guard
src/lib/supabase/        env · client (browser) · server (user-scoped) · proxy (session helper)
src/lib/auth/            session (current user) · tenant-context (Stage-3 placeholder)
supabase/migrations/     0001 core schema · 0002 org-scoped RLS · 0003 related-org read   (append-only)
supabase/tests/          org_rls_test.sql (66 assertions) · rls_test_plan.md
scripts/                 test-rls.sh · check-migration-safety.sh · check-docs-updated.sh · pr-review-summary.sh · check-auth-safety.sh
.github/workflows/       rls-tests.yml · migration-safety.yml · review-discipline.yml
docs/                    canonical docs 00–10 (this set) + design/legacy docs (see 10_DOCS_INDEX)
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
- **Server (Next.js, user-scoped):** `src/lib/supabase/server.ts` builds a Supabase client bound to the request's auth cookies (anon key only); all reads/writes flow through RLS. The login Server Action and `getSessionUser()` use it. — `implemented`.
- **Proxy (`src/proxy.ts`):** in Next.js 16, Middleware is renamed **Proxy** (`node_modules/next/dist/docs/.../16-proxy.md`). It refreshes the session and redirects unauthenticated requests off protected routes. It does **not** read app data or decide tenant/org access. — `implemented`.
- **Trusted server jobs (service-role):** isolated; only for operations RLS can't express (audit writes, license evaluation, future imports). Never reachable from the browser. — `deferred` (no such code exists yet).

## Current vs target
- **Current:** Postgres schema + RLS (tested locally + CI) + an auth/session skeleton (login, server session via Proxy, protected route group). No tenant/org context, no product UI.
- **Target (incremental, see [06](./06_BUILD_SEQUENCE.md)):** auth/session → tenant/org context → read-only inventory → contracts/people → writes → files/imports → connectors.

## What must exist before UI reads data
1. Auth/session wired to Supabase — `implemented` (skeleton; not hosted-exercised).
2. A user-scoped server Supabase client (RLS-bound) — `implemented` (`src/lib/supabase/server.ts`, no service-role in request paths).
3. Tenant/org context derived from membership rows (not client input) — `planned` (next PR; only a placeholder stub today).
RLS already guarantees that even a wrong query cannot cross tenants — but #3 must exist so
the app *uses* the foundation correctly.

## Intentionally missing today
Product UI · tenant/org context resolution · imports/exports · connectors/credentials ·
org-hierarchy traversal · child-table org scoping · hosted deployment. All tracked in
[04_RISK_REGISTER.md](./04_RISK_REGISTER.md) and sequenced in [06_BUILD_SEQUENCE.md](./06_BUILD_SEQUENCE.md).
