# 72 — Access Product Surface Design (Phase 15 Part 1, PR B)

The first reviewed customer-facing consumer of the canonical directory access graph: a read-only `/access` route group that explains
effective application access and surfaces governance findings. Server-only, owner/admin-gated, truthful, no mutations.

## Read path (no browser DB access)
Browser → server component → server-only loader (`src/lib/data/access-loaders.ts`) → server-only repository
(`src/lib/data/access-repository.ts`) → the migration-0061 authenticated `SECURITY DEFINER` RPCs. The six canonical tables stay
**deny-all**; no browser component queries a canonical table or invokes an RPC directly. The repository uses ONLY the user-scoped,
cookie-bound, RLS-governed server client (`@/lib/supabase/server`) — never a service-role/admin client.

## Authorization (owner/admin only)
`accessGate()` resolves the authenticated user + active tenant via the trusted `resolveTenantContext()` (RLS-backed; never a JWT claim,
never a caller-supplied tenant_id) and verifies the caller's role ∈ {owner, admin}. The verified tenant id is passed to every RPC, which
**re-verifies** via `has_tenant_role` — the authoritative boundary. Editors, viewers, non-members, and anon get a not-found-equivalent
empty/null result. Navigation is display-only; authorization lives server-side. A foreign, missing, or unauthorized entity id all render
the byte-identical "Not found" block (no existence disclosure).

## Graph assembly + engine reuse
`access-graph-assembly.ts` maps validated RPC rows into the Phase-14 `GovernanceGraph`, **injecting the verified tenant id** into every
node/edge scope (the RPCs omit tenant_id; without injection the engine's scope-keyed traversal would drop every edge). It reuses:
- **Phase 13** `resolveEffectiveAccess` / `resolveAllEffectiveAccess` for DIRECT / GROUP / BOTH effective access (never reimplemented);
- **Phase 14** `evaluateGovernance` / `evaluateIdentityGovernance` for findings (never reimplemented).
`detectedAt` is injected explicitly (the engines never call `Date.now`).

## Runtime validation + privacy
`access-rpc-types.ts` parses every RPC response with strict zod schemas (unknown keys are stripped, malformed rows dropped) — defense in
depth so a prohibited column (`external_id`/`raw_payload`/…) can never reach the graph or UI. View models (`access-view-models.ts`) carry
ONLY safe display labels, integer counts, the bounded `syncStatus` enum, and canonical row-id UUIDs used **solely as href params, never as
visible text**. Never emitted: `external_id`, `raw_payload`, `normalized_*`, credentials, settings, profiles, `source_endpoint`,
`last_discovery_run_id`, secrets, or a foreign tenant id. Display fallback is `display_name → login → email → "Unnamed identity"` (group
`name`, app `label → name`) — never a UUID or external id as a human label.

## Completeness model (no silent truncation)
The engines need the whole tenant graph. `loadAccessOverview` first reads counts; if any node kind > 2,000 or any edge kind > 5,000 it
returns `status: "too_large"` and renders a truthful "too large to evaluate in this view" banner (counts still shown, no partial findings).
Otherwise it pages every list RPC (deterministic id cursor, page cap 100) under a defensive backstop, assembles the graph, and evaluates
once → `status: "complete"`. It NEVER shows "No findings" when evaluation did not complete. Entity detail pages use the single-call
subgraph RPCs (always complete for that entity's neighborhood).

## Routes
- `/access` — overview: counts, effective-access breakdown, governance summary, top-10 findings preview, truthfulness disclaimer.
- `/access/findings` — full findings list with server-side severity filter (strict allowlist); "View access details" only, no mutation.
- `/access/identities/[id]` — one identity's effective applications (DIRECT/GROUP/BOTH + group paths) + its findings.
- `/access/applications/[id]` — one application's effective identities + assigned groups + its findings.
Each has `loading.tsx` (PageSkeleton) + `error.tsx` (safe copy + digest only, never `error.message`). Not-found is handled inline (no
`not-found.tsx`, `notFound()` is never called).

## Caching
No route segment config; `createClient()` awaits `cookies()`, forcing per-request dynamic rendering. Per-tenant reads are NEVER wrapped in
`unstable_cache` / `use cache` / a module memo (those key on args, not on the caller's cookies/tenant). Tenant isolation is enforced by RLS
+ `has_tenant_role`. No public API endpoint — server components call the loaders directly.

## Truthfulness boundary
This surface shows access **topology** represented in the connected directory. It does NOT claim application usage, license state, cost,
savings, employee inactivity, last-login, orphaned subscriptions, shadow IT, compliance, over-provisioning, or safe removal. Finding copy
comes from the exhaustive `governance-presenter.ts` (every rule mapped; scanned for forbidden terms; severity never "critical"). Static
page disclaimers may name the unsupported claims ONLY in negation ("does not show application usage…"). "Potentially redundant" access is
flagged for review, never as "safe to remove".

## No mutation / no persistence
No write, no server action, no access-removal control, no export, no finding persistence, no connector-runner change, no hosted task, no
schedule. Findings are computed per request. RISK-007 remains OPEN; Phase C remains BLOCKED; production untouched.

## Future (Part 2)
Richer search/filtering, findings drill-down, bounded CSV export, broader accessibility/UAT — still excluding remediation, access
deletion, license/usage/savings claims, and production rollout.
