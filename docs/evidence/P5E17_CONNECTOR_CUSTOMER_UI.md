# P5E17 — customer connector UI (evidence)

**Status: the customer-facing connector experience (marketplace → Okta detail → simulated connect wizard → preview management) is
built, tested, and GREEN as a PREVIEW.** Date 2026-07-17. **No live connector run, no credential, no OAuth, no token, no Okta API
call, no ECS task, no schedule, no canonical promotion, no production access — none.** Okta and Microsoft Entra remain
`certificationOnly` and non-runnable; RISK-007 OPEN; Phase C BLOCKED. No DB migration (the preview writes only browser
`sessionStorage`).

Canonical experience + safety: [`../CONNECTOR_CUSTOMER_EXPERIENCE.md`](../CONNECTOR_CUSTOMER_EXPERIENCE.md). Okta flow:
[`../OKTA_CUSTOMER_CONNECTION_FLOW.md`](../OKTA_CUSTOMER_CONNECTION_FLOW.md). Runner dormancy: `idcaddie-connector-runner`
`docs/evidence/P5E17_OKTA_UI_DORMANCY.md`.

## Phase 0 baseline (verified)

v3 branch `feat/customer-connector-ui` off `main` == `87eac23…`; runner branch `docs/customer-connector-ui-state` off
`main` == `ce59ffe…`; both worktrees clean at start. No live connector wiring touched; provider registry reports every provider
non-ready (fail-closed) — unchanged.

## What was built (v3, all preview-only)

- **Central mapping** — `src/lib/customer-connectors/`: `catalog.ts` (server-only internal→customer mapping; 12 curated providers;
  `canSync`/`canSchedule` always false; `canConnect` = Okta-only AND registry-not-ready), `catalog-types.ts` (client-safe types +
  category constants), `okta-content.ts` (customer copy + SSRF-safe `validateOktaOrgHost`, no network), `demo-store.ts`
  (`sessionStorage`-only preview state), `use-demo-connection.ts` (reactive `useSyncExternalStore` reads), `view.ts` (label/tone/CTA
  derivation).
- **Marketplace** — `/connectors` server shell + `<ConnectorMarketplace/>` island (search + status + category filters, responsive
  card grid, empty state) + `<ConnectorCard/>`. `<ConnectorIcon/>` renders a safe local monogram (no remote logo fetch).
- **Detail** — `/connectors/[provider]` + `<ConnectorDetailCta/>` (Okta shows the full reads/never-access experience; others show
  a preview/coming-soon detail).
- **Wizard** — `/connectors/[provider]/connect` (guarded to connectable providers) + `<OktaConnectWizard/>` (5-step simulated flow;
  no redirect; success writes only the `sessionStorage` preview connection; failed writes nothing).
- **Management** — `/connectors/[provider]/status` + `<ConnectorStatusView/>` (data access, sync settings, security; Run supervised
  first sync DISABLED; Pause/Resume/Reconnect/Disconnect touch only preview state).
- Nav note updated ("read-only metadata" → "preview"); marketplace footer preserves the operator sync-review link.

## Two correctness/safety fixes made during the build

1. **RSC boundary** — the client marketplace imported the *value* `CUSTOMER_CATEGORIES` from `catalog.ts`, which statically imports
   the server-only `provider-registry` (its browser sentinel throws when `window` is defined). That would have pulled the
   server-only registry into the client bundle and thrown in the real browser. Fixed by splitting the pure types + category
   constant into client-safe `catalog-types.ts`; the client tree no longer imports `catalog.ts` at all.
2. **`useSyncExternalStore` stability** — `useDemoConnection` used a `getSnapshot` that returned a fresh object every call
   (`JSON.parse`), violating the stable-snapshot contract and risking an infinite render loop. Fixed to derive the per-provider
   read from the stable raw-string snapshot via `useMemo`.

## Safety guards (Phase 12)

- `customer-connectors-safety.test.ts` — static scan of the whole customer-connector UI surface: no `fetch(`/XHR/axios, no
  `access_token`/`refresh_token`/`client_secret`/`id_token`, no OAuth authorize endpoint or real Okta host path, no
  `RunTask`/ECS/`scheduleExpression`/cron, no `supabase`/`service_role`/`getSecretValue`/`process.env`; only `catalog.ts` (server,
  never `use client`) imports the provider registry; **no OAuth callback route added** under the customer connector routes; page
  shells are server components, interactivity is in labelled client islands; demo store persists only to `sessionStorage` (never
  `localStorage`/DB).
- `no-client-import.test.ts` — the existing client/server guard still holds; the customer-connector client islands do not import
  the server-only vault/registry modules. (The guard now excludes `*.test.*` files, which may legitimately `vi.mock` a server-only
  module; shipped-bundle safety is unchanged.)
- Runtime component tests assert the wizard performs **no** navigation to Okta (`router.push` never called), has **no**
  password/token/secret field and **no** anchor to any Okta/authorize/`http` URL, and writes the `sessionStorage` preview state
  only on success (nothing on failure).

## Validation (all green)

- `tsc --noEmit` — exit 0.
- `npm run lint` — 0 errors (63 pre-existing warnings, none in P5E17 files).
- `npx vitest run` (full suite) — **1396 passed, 22 skipped, 0 failed** (74 of these are the new P5E17 tests:
  marketplace, detail + CTA, wizard flow + SSRF + no-redirect + no-token-field, management, catalog invariants + defense-in-depth,
  `validateOktaOrgHost` accept/reject table, demo-store server no-op, safety scan).
- `next build` — compiled successfully; all four new routes emitted (`/connectors`, `/connectors/[provider]`,
  `/connectors/[provider]/connect`, `/connectors/[provider]/status`); `/connectors/oauth/callback` and `/connectors/review`
  preserved. No server-only-in-client-bundle error (RSC boundary clean).

## Existing tests updated (design intent, not a weakened safety property)

- `connectors.ui.test.tsx` — rewritten for the new marketplace (the old page was replaced). The secret/PII column scan in
  `manual-sync-runs.test.ts` still passes; its "no interactive element in `page.tsx`" assertion was reworded to "page shell is a
  server component; interactivity is delegated to the `<ConnectorMarketplace/>` client island" (the obsolete "Not built yet" chip
  assertion was removed — those chips were the exact internal-diagnostic design this phase replaces).
- `page.test.ts` — the connectors page keeps the shared "← Back → /dashboards" convention.

## Residual posture

Preview only. The connector runner, credential vault, and provider registry are untouched and still gated. Okta and Microsoft
Entra remain `certificationOnly`; RISK-007 OPEN; Phase C BLOCKED; no production access.
