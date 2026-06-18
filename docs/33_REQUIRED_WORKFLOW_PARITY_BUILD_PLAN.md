# 33 · Required-Workflow Parity Build Plan

**Canonical buildable plan for doc 17 blocker-sequence item #3** ([30](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md)):
turn the [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) line-item matrix into a **ranked, buildable implementation
plan** for the required workflows that remain `missing` / `partial` / `blocked` / `unknown`. **Planning only —
this builds no feature.**

> ## ⚠️ STATUS BANNER (do not remove)
> - **Required-workflow parity build plan is prepared, not implemented.** This doc adds no code, route,
>   component, server action, DAL, migration, script, or test.
> - **No production project was touched. No staging data was mutated by this PR.** No hosted verification was
>   executed (items #1/#2 — docs [31](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)/[32](./32_STAGING_OMC_SHAPED_DATASET_AND_CRITICAL_FLOW_VALIDATION.md)
>   — remain prepared-not-run).
> - **No secrets, passwords, anon keys, cookies, or JWTs are recorded.**
> - **No doc 17 §5 box is ticked here.** **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not
>   automatically production-ready. Storage completion is necessary but not sufficient for cutover.**
> - **Full OMC parity is required by default** ([27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md)). A workflow that
>   does not exist is a **blocker**, not a "validation failure"; ranking it P1/P2 is a sequencing aid, **not**
>   approval to cut over without it (only `deprecated-approved` removes a row).

---

## 1. How this plan relates to the other cutover docs

- [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) = the **line-item matrix** (every row, status, evidence). ~169
  rows are `missing` (111) / `partial` (58) plus 40 `blocked-unknown` / 22 `blocked-data-migration` / 5
  `blocked-security`; this plan does **not** re-list them — it **groups + ranks + sequences** them.
- [30](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md) = the **blocker sequence** (the 6 ranked cutover steps); item #3
  is this build plan.
- [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) = the **binding go/no-go** (17 boxes; all must be true).
- This doc (33) = the **buildable plan**: 9 implementation tracks, P0/P1/P2 ranking, the P0 detail, and the next
  3 implementation PRs.

---

## 2. "Built but unverified" vs "not built" (explicit — Task 6)

| Surface | State | Note |
|---|---|---|
| Login / logout / session; read-only tenant/org context | **built — UNVERIFIED on hosted** | item #1 ([31](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)) prepares the hosted verification (not run) |
| `/apps` list, `/apps/[id]` detail (roster, match-status, account-summary) | **built (read-only) — UNVERIFIED on hosted** | DAL: apps, app-users, app-user-matches, app-account-intelligence |
| `/contracts` list + `/contracts/[id]` detail | **built (read-only) — UNVERIFIED on hosted** | DAL: contracts, links |
| Contract create/edit (`/contracts/new`, `/contracts/[id]/edit`) | **built — partial fields ([15]), UNVERIFIED on hosted** | DAL: contract-write; RLS `0004`; audit `0010` |
| App↔contract **link panels (read)** | **built (read-only) — UNVERIFIED on hosted** | link/unlink **write** NOT built |
| `contract-files` private bucket + object policies + helpers | **built AND hosted-verified** (staging+prod 14/14) | Storage boundary done; **app file surface NOT built** |
| `files`/`people`/`identity_accounts`/`license_*`/`invoices`/`audit_logs` schema + RLS | **schema built — NOT surfaced** | no DAL/route/UI |
| File **upload/action/UI**, signed-URL read, preview, file audit | **NOT built** | sits on the verified Storage boundary |
| PDF/AI extraction; imports/connectors + vault; license/ELU; invoices; reporting/exports; IDC billing; UAR/people directory; admin/settings UI; audit UI; link/unlink write; tenant switching | **NOT built** | the bulk of doc 27 `missing`/`blocked` |

**Built-but-unverified ≠ done:** a built surface is not parity-complete until it is **verified on hosted
staging** (items #1/#2) AND its doc 27 row carries recorded evidence. **Not-built ≠ failing:** it is a blocker
until built, then verified.

---

## 3. The 9 implementation tracks (grouped, ranked, mapped — Tasks 2/3)

| # | Track | Current state | Rank | doc 27 | doc 17 §5 |
|---|---|---|---|---|---|
| T1 | **Auth / session / tenant context** | built; **unverified on hosted** | **P0** | J, A | 5, 6, 8 |
| T2 | **Contracts** (read + create/edit, field parity) | built; partial fields; unverified | **P0** | A, B, C | 1, 2, 9 |
| T3 | **Files / upload / signed URLs / PDF validation** | Storage boundary done+verified; **app surface not built** | **P0** | H | 9, 13 |
| T4 | **Apps / app-contract relationships** | apps + link panels read built; **link/unlink write + cost allocation not built** | **P0** | A, B | 1, 9 |
| T5 | **App users / identity matching / people** | roster + match-status read built; **people directory not built** | **P0** (roster) / **P1** (directory) | A | 7, 9 |
| T6 | **Invoices / spend / license rules / evaluations** | **schema only; not built** | **P0** | E, M, F | 1 |
| T7 | **Reporting / export / import** | **not built** (imports = `blocked-security`) | **P0** | F, G | 1, 12 |
| T8 | **Admin / settings / audit / operations** | memberships+audit backend exist; **UI + ops not built** | **P0** | K, L, P | 14, 15, 16 |
| T9 | **Connectors / secrets / vault** | **design only ([19]); vault not built (RISK-007)** | **P0** | G | 11 |

**P1 (replacement blockers, must close pre-cutover unless reclassified with approval):** PDF/AI extraction
(suggestions-only, no silent overwrite — Track I); people directory + identity-matching UI; scheduled/emailed
reports; SAML SSO / SCIM **iff OMC confirms** ([17 §9](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) confirmation pass, doc [18]).
**P2 (post-cutover hardening, only if explicitly approved as P2):** UX polish (breadcrumbs/loading/empty
states), org-hierarchy traversal (RISK-004), telemetry expansion (RISK-013 review), admin niceties. **Default
is NOT P2** — every row is P0 until OMC-confirmed otherwise.

---

## 4. P0 gap detail (Task 4)

Each P0 track, with: **current evidence/status · why it blocks doc 17 · implementation work · RLS/security
work · tests · hosted staging validation · evidence before "done".**

### T1 — Auth / session / tenant context
- **Status:** built (email+password, `getUser()` server-validated session, read-only tenant/org resolver); **not yet verified on hosted Auth**.
- **Blocks:** §5 boxes 5/6/8 — the whole app runs as the signed-in user; if hosted Auth/RLS diverges from the shim, every surface is suspect (the `0015` grant gap proved divergence is real).
- **Impl:** none new to build; **run** the prepared item-#1 verification + Vercel-staging wiring.
- **RLS/security:** unchanged; `check-auth-safety.sh` green (no service-role on request paths).
- **Tests:** local `test-rls.sh` 222 (unchanged); the item-#1 automated checks A1–A3/R1–R5.
- **Hosted validation:** `scripts/verify-staging-auth-tenant-context.mjs` green + the doc 31 §3 manual UI steps.
- **Evidence:** recorded item-#1 run (no secrets) + the full RLS suite re-run against hosted Postgres/Auth.

### T2 — Contracts
- **Status:** read + create/edit built; **partial field parity** (gaps in [15] — commodity_*/validated/gantt); unverified on hosted.
- **Blocks:** §5 boxes 1/2/9 — contracts are a required workflow; partial fields = `partial` row (not `same`).
- **Impl:** complete the missing legacy contract fields per [15]/[27 Track C]; finish the contract detail surface.
- **RLS/security:** reuse `0004`/`0013` authority (tenant editor+ OR procurement-org manager; `paying_org` never writes); audit-on-write `0010`.
- **Tests:** extend `org_rls_test.sql` for any new field authority; field-parity comparison vs legacy.
- **Hosted validation:** item-#2 critical-flow steps 2–4 (create/edit with authority + audit) on the OMC-shaped dataset.
- **Evidence:** field-by-field legacy comparison + workflow test + reviewer initials in doc 27 Track C.

### T3 — Files / upload / signed URLs / PDF validation
- **Status:** Storage boundary **done + hosted-verified** (staging+prod 14/14); PDF validation core exists (`src/lib/files/pdf-validation.ts`, PR #40); **no upload action/UI, no signed-URL route, no preview, no file audit**.
- **Blocks:** §5 boxes 9/13 — legacy's **default** contract-create path is upload-PDF; missing today.
- **Impl:** server-side upload action (user-scoped client, files-row-first per `0013`, server-derived path `contracts/{tenant}/{file}.pdf`), validation/size gate, signed-URL read route, file list/detail/preview, file audit.
- **RLS/security:** **NO service-role on any request path**; rely on the applied `storage.objects` policies + `0013`/`0014`/`0015`; private bucket + short-lived signed URLs only; no public URLs.
- **Tests:** unit (validation/path) + the hosted Storage REST verifier (already 14/14) re-run after the action ships; RLS suite unchanged.
- **Hosted validation:** an authorized user uploads → row + object created → signed-URL read works → cross-tenant/anon denied (re-run `verify-staging-storage-rest.mjs`).
- **Evidence:** upload/read workflow test + the Storage REST evidence + reviewer initials (doc 27 Track H).

### T4 — Apps / app-contract relationships
- **Status:** apps read + link panels read built; **link/unlink write + cost allocation not built**.
- **Blocks:** §5 boxes 1/9 — legacy links/unlinks apps↔contracts and allocates cost.
- **Impl:** link/unlink **write** path (INSERT/soft-unlink only — no hard delete, no `FOR ALL`), cost allocation surface.
- **RLS/security:** same-tenant composite FK (`0006`); write authority gated; **no blind delete** (soft-unlink/deactivate).
- **Tests:** `org_rls_test.sql` for link/unlink authority + same-tenant integrity.
- **Hosted validation:** link/unlink a synthetic app↔contract; confirm same-tenant + authority + audit.
- **Evidence:** workflow test + RLS test + doc 27 Track A/B rows.

### T5 — App users / identity matching / people
- **Status:** roster + match-status read built; **people directory + identity-matching UI not built**.
- **Blocks:** §5 boxes 7/9 — UAR/identity is a core legacy workflow.
- **Impl (P0 roster / P1 directory):** surface the people directory + identity-match review; keep org-scoped read deferral (RISK-002) explicit.
- **RLS/security:** org-scoped reads (`0006`–`0008`); default-deny on `people`/`identity_accounts`; no cross-tenant leakage.
- **Tests:** `org_rls_test.sql` for people/identity read scoping.
- **Hosted validation:** roster + match-status render correctly per tenant on the OMC-shaped dataset.
- **Evidence:** read-scope RLS test + UI comparison + doc 27 rows.

### T6 — Invoices / spend / license rules / evaluations
- **Status:** **schema only; not built** (no ingestion, no ELU/waste, no proration, no surface).
- **Blocks:** §5 box 1 — license governance is the product's core value; **IDC billing is the ~$3.5k/mo revenue mechanism** (Track M).
- **Impl:** license-rule builder + evaluation engine (ELU/waste), invoice ingestion + spend, IDC billing cron + surface — each its own sequenced PR.
- **RLS/security:** RLS-scoped reads/writes; billing cron is an **isolated out-of-request job**, never service-role on a request path; no PII in telemetry (RISK-013).
- **Tests:** RLS tests per new table surface; billing reconciliation tests.
- **Hosted validation:** evaluation/report output comparison vs legacy; billing reconciliation vs OMC (Track M/N).
- **Evidence:** report-output comparison + billing reconciliation + OMC signoff.

### T7 — Reporting / export / import
- **Status:** **not built**; imports are `blocked-security`.
- **Blocks:** §5 boxes 1/12 — reports/exports + safe imports are required workflows.
- **Impl:** CSV/PDF export + report filters/permissions; **safe import** (preview → upsert → soft-delete/deactivate → audit → rollback) — **never blind-delete**.
- **RLS/security:** RLS-scoped export (no cross-tenant rows in a report); import writer non-destructive + audited.
- **Tests:** report-output comparison; import-safety workflow test (no blind delete).
- **Hosted validation:** report parity vs legacy; an import dry-run preview on the OMC-shaped dataset.
- **Evidence:** output comparison + import-safety test + doc 27 Track F/G.

### T8 — Admin / settings / audit / operations
- **Status:** memberships + append-only `audit_logs` + contract audit-on-write (`0010`) exist; **admin/settings UI, audit UI, and ops (deploy/rollback/monitoring/data-migration) not built**.
- **Blocks:** §5 boxes 14/15/16 — user/role/settings management, audit visibility, rollback rehearsal, data-migration + freeze plan.
- **Impl:** admin/settings UI (no self-promote), audit-log viewer (read append-only), deploy/promote CI + rehearsed rollback, post-cutover monitoring (ops = blocker-sequence ranks 4–6).
- **RLS/security:** role-gated admin; **no unsafe 90-day audit purge** unless `deprecated-approved`; no service-role on request paths.
- **Tests:** RLS tests for admin/role changes; audit-immutability tests (already enforced by `reject_audit_mutation()`).
- **Hosted validation:** admin flows on the OMC-shaped dataset; rollback rehearsal in staging.
- **Evidence:** RLS tests + UI comparison + rehearsed-rollback evidence + OMC signoff.

### T9 — Connectors / secrets / vault
- **Status:** **design only ([19]); credential vault not implemented (RISK-007)**.
- **Blocks:** §5 box 11 — the vault is a **prerequisite for ANY connector**; connectors/SCIM/sync are required workflows.
- **Impl:** the encrypted credential vault ([19]) **first**, then connectors (each its own PR); **never collect a real connector secret until the vault is implemented + tested + reviewed**.
- **RLS/security:** secrets never in a Postgres column/generated types/client/logs; access is a **future isolated out-of-request job**, never service-role on a request path (RISK-007).
- **Tests:** vault encryption/access tests; connector safe-sync tests.
- **Hosted validation:** vault + a connector against synthetic staging credentials only.
- **Evidence:** vault implemented+tested+reviewed (closes/narrows RISK-007) + connector workflow test.

---

## 5. The next 3 implementation PRs (Task 5)

**Gate:** these build on a **hosted-verified foundation** — items #1 + #2 (docs 31/32) must be **executed green +
recorded** first (foundation before features). Then, building on the **finished + verified Storage boundary**,
the first 3 implementation PRs are:

1. **Contract-file upload action + signed-URL read (Track T3, P0)** — server-side upload (user-scoped client,
   files-row-first per `0013`, server-derived path), validation/size gate, signed-URL read route. **No
   service-role.** Re-run `verify-staging-storage-rest.mjs` after. Cites doc 27 Track H rows.
2. **Files list + file detail/preview surface (Track T3, P0)** — the route/UI on top of upload (private bucket +
   signed URLs only; file audit). Cites Track H + A (files list/detail) rows.
3. **Contract field-parity completion + app-contract link/unlink write (Tracks T2/T4, P0)** — close the [15]
   contract-field gaps and add the soft link/unlink write path (no hard delete). Cites Track C + A/B rows.

Each implementation PR must: **cite its doc 27 row(s)**, carry **RLS tests** + **hosted staging validation**,
record **evidence** (reviewer initials, no secrets), tick **no** doc 17 §5 box on its own, and **not** close
RISK-001 or claim cutover.

---

## 6. Risk posture

**RISK-001 remains OPEN** — this is a build plan, not built work; it closes nothing. **RISK-002** (org-scoped
reads), **RISK-007** (vault), **RISK-013** (telemetry), **RISK-015/016** remain open. **Cutover remains
BLOCKED** ([17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) is binding; every box must be true).
**Upload is not automatically production-ready. Storage completion is necessary but not sufficient for
cutover.** No production/staging mutation, no hosted command, no secrets in this PR. OMC/Flywheel is a paying
production **replacement, not a pilot**.
