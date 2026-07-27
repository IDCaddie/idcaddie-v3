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

The counts RPC (`product_directory_access_counts`) is **stale-agnostic** — it counts all rows (it declares no `p_include_stale`), so the
too-large pre-gate uses the **total** count (a safe, conservative upper bound: total ≥ the paged current-only graph, so the gate can only
fail-closed, never render an over-large graph). Two consequences, both intentional: (1) the **displayed** complete-view StatCard counts come
from the **paged rows** (which honor `includeStale`), not the RPC total, so the header matches the evaluated body; (2) a tenant with a large
number of **stale** rows can trip `too_large` in the default current-only view even if its current-only graph is small — fail-closed and
safe, but conservative. A stale-aware pre-count (to avoid that over-block) would require a migration and is deferred.

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

## Part 2 — search, filtering, pagination, drill-down, evidence (PR C)

**Filter contract (`access-filters.ts`).** One strict, pure, server-side (also browser-safe) normalizer parses ONLY allowlisted values off
`searchParams`: `query` (NFKC + lowercased + whitespace-collapsed + ≤200 chars), `severity`/`confidence`/`classification`/`subjectType`/
`catalogMatch`/`ruleId` (allowlist guards; invalid → null), `provider` (`^[a-z0-9_]{1,40}$`), `connectionId` (UUID), `includeStale`,
`staleEvidence` (tri-state), `page` (≥1), `pageSize` (clamped [1,100], default 50). A repeated param takes the first value; unknown params
are ignored — neither widens scope. `accessQueryString`/`accessHref` serialize a **canonical** URL (fixed key order, defaults omitted);
changing any filter resets to page 1. (`provider`/`connection`/`catalogMatch` are parsed + URL-preserved but their controls are deferred
until multi-provider/connection data exists — single provider/connection today.)

**Filtering semantics.** Filters/search run **server-side over the already-evaluated safe view models** — after Phase 13/14, never over
raw canonical rows and never before resolution, so a filter can never change effective-access or finding meaning. The overview still
evaluates the whole graph within the node/edge caps; the findings list filters `data.findings` and shows a filtered total ONLY when
`status: complete` (bounded/`too_large` keeps the truthful banner — never a false "no findings"). Detail pages filter the already-computed
per-entity relationships.

**Pagination.** Deterministic **offset** pagination (`paginate`) over the already-bounded, deterministically-sorted lists (the overview cap
bounds total findings; `SUBGRAPH_MAX_ROWS` bounds detail rows) — documented per docs/72. Findings keep the engine's severity-first order;
detail lists sort by display label then canonical id (stable tie-break). No cursor: the data is fully materialized and bounded, so a cursor
would add no safety. Page size default 50, max 100.

**Finding drill-down.** Each finding is an expandable native `<details>/<summary>` (zero client JS, natively accessible) revealing summary,
guidance, scope, structured evidence rows, the subject link, and the truthfulness disclaimer. No finding-detail route and no persistence —
findings are recomputed per request, so there is no finding-id enumeration surface.

**Return context (no open redirect).** Navigation context is an **allowlisted** contract, never a caller-supplied URL: `from` ∈
{overview, findings, identity, application}; `fromId` must be a UUID; `ret` is a bounded querystring **re-parsed through the same allowlist
parser** and re-serialized. `backLink` only ever emits a fixed `/access/...` path — a hostile `from`/`ret`/`fromId` (absolute URL,
protocol-relative, `javascript:`, traversal, oversized) falls back to the static "← Back to Access". Matches the existing fixed-target
`safeRedirect` posture; open redirect is structurally impossible.

**Evidence UX + bounds.** Identity/application detail show classification, per-app/-identity access-path evidence, group paths, and
current-vs-stale state. Group-path and assigned-group lists are bounded in the browser (`+N more`) so a fan-in-heavy entity can't render an
unbounded DOM. The overview adds severity filter-links and a findings search shortcut (counts only — never a risk/savings/utilization score).

**Accessibility.** GET forms with native labelled controls (no JS required for core function), `aria-current="page"` on pagination,
`role="status"` on completeness/bounded banners, `<details>` for disclosure. Asserted via testing-library role/name queries (no axe dep).

## Part 2 — bounded CSV export (PR D)

**Routes.** Three authenticated GET route handlers, one per exportable list: `/access/findings/export`, `/access/identities/[id]/export`,
`/access/applications/[id]/export`. Each is `dynamic = "force-dynamic"` and returns a CSV attachment; no POST, no side effects, no storage
bucket, no persisted file, no background job, no email.

**Authorization = page authorization.** Each route calls the SAME server-only loader as its page (`loadAccessOverview` /
`loadIdentityAccessDetail` / `loadApplicationAccessDetail`) — owner/admin gate via `accessGate` → the 0061 RPCs; canonical tables stay
deny-all; never a service-role client; no browser RPC. `forbidden → 403`; a foreign/missing/unauthorized entity id → the SAME `404` as the
page (no existence disclosure). Filters are parsed with the SAME `parseAccessFilters` and applied with the SAME `filterFindings` /
`filterIdentityApplications` / `filterApplicationIdentities`, so an export always matches what the page shows.

**Complete-only + bounded.** Findings export requires overview `status === "complete"` (else `409` — never a partial export claiming
completeness); detail exports refuse when the subgraph is `bounded` (`409`). Above **`EXPORT_ROW_CAP = 10,000`** data rows the route returns
a truthful `413` asking the user to narrow filters — it NEVER silently truncates.

**CSV safety.** `access-export.ts` projects the safe view models onto an EXPLICIT column allowlist and runs every cell (and header) through
`sanitizeCsvCell` (to-csv.ts), which prefixes a single quote when a cell begins — after optional whitespace — with a formula/command trigger
(`= + - @`) or a control char (TAB/CR/LF), neutralizing spreadsheet formula/DDE injection; `toCsv` then quotes commas/quotes/newlines
(RFC-4180). Columns — findings: `finding_id, severity, confidence, finding_type, title, summary, subject_type, subject_label,
stale_evidence, evidence_summary, review_guidance`; identity-access: `identity_label, application_label, provider, classification,
direct_assignment_count, inherited_group_count, inherited_group_labels, stale_evidence`; application-access: `application_label,
identity_label, provider, classification, direct_assignment_count, stale_evidence`. NEVER emitted: tenant/canonical/external id, raw payload,
credentials, settings, profiles, source endpoint, secret, raw JSON evidence, or a separate login/email column (labels are the same resolved
display strings shown on-screen). Responses are `text/csv; charset=utf-8` + `Content-Disposition: attachment` + `X-Content-Type-Options:
nosniff` + `Cache-Control: no-store, private`; filenames are a fixed prefix + date only (`access-findings-YYYY-MM-DD.csv`), no names/ids.
The pages surface an "Export CSV" link (carrying the current filters) only when there are rows to export.

## Future (Part 2, later PRs)
A guarded staging verification script + runbook, responsive/accessibility hardening, and operational diagnostics (PR E) — still excluding
remediation, access deletion, license/usage/savings claims, and production rollout.
