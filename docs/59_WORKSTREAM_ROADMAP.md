# 13 · Workstream roadmap (stable IDs + real PR numbers)

**Purpose.** This is the single "what shipped / what's in flight / what's next" list for the v3 rebuild, keyed by **stable
workstream IDs** and pinned to **real, merged GitHub PR numbers**. It replaces the six conflicting "next PRs" lists scattered
across the old parity docs. It is a planning + status doc — it does **not** change any gate. **RISK-007 remains OPEN; Phase C
remains BLOCKED; live connector sync has NOT run; production is untouched.**

Part of the 7-doc rebuild pack. Cross-references: current state → [55_REBUILD_STATUS.md](./55_REBUILD_STATUS.md); old-app
parity rows → [56_OLD_APP_PARITY_REGISTER.md](./56_OLD_APP_PARITY_REGISTER.md); connector parity →
[57_CONNECTOR_PARITY_REGISTER.md](./57_CONNECTOR_PARITY_REGISTER.md); AI parity →
[58_AI_FEATURE_PARITY_REGISTER.md](./58_AI_FEATURE_PARITY_REGISTER.md); anti-patterns →
[60_DO_NOT_COPY_FROM_OLD_APP.md](./60_DO_NOT_COPY_FROM_OLD_APP.md); the immediate plan →
[61_NEXT_3_DAYS_PLAN.md](./61_NEXT_3_DAYS_PLAN.md). Deeper evidence: risk criteria →
[04_RISK_REGISTER.md](./04_RISK_REGISTER.md) + [52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md](./52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md);
per-PR log → [05_ENGINEERING_CHANGELOG.md](./05_ENGINEERING_CHANGELOG.md); connector framework →
[54_CONNECTOR_FRAMEWORK_DESIGN.md](./54_CONNECTOR_FRAMEWORK_DESIGN.md); contract-PDF AI design →
[16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md).

> **Note (doc slot).** This file introduces the pack's slot **13**. An older, unrelated doc
> `13_CONTRACT_STEWARD_WRITE_DESIGN.md` still exists alongside it; the docs index
> ([10_DOCS_INDEX.md](./10_DOCS_INDEX.md)) needs reconciling so readers find the right "13". That is a docs-index defect, not a
> change to either document's content.

Today = **2026-07-07**. Repo HEADs at time of writing (FACT, from the canonical brief): `idcaddie-v3` main @ `768f91a`
(PRs through #270 merged); `idcaddie-connector-runner` main @ `84ecf6d`.

---

## 0. How to read this doc

**Acronyms, once.** **PR** = a GitHub pull request (the real, reviewable, merged unit of work). **RLS** = Row Level Security
(Postgres per-row access rules — the *sole* authorization boundary in v3). **DAL** = Data Access Layer (server-only modules
under `src/lib/data/*`). **RISK-007** = the governance risk gating real connector-secret handling and deletion. **Phase C** =
the gated live-connector-execution phase (in this doc, "Phase C" always means the roadmap-phase unblock = RISK-007 criterion
19; the connector-runner uses the same words for the ingestion runner, which is a different thing). **ECS/Fargate** = the AWS
one-shot container service the connector-runner executes in. **KMS** = AWS Key Management Service. **BYPASSRLS / NOLOGIN** =
Postgres role attributes; the `connector_runner` role bypasses RLS and cannot log in directly, which is *why* its write path
is guarded by SECURITY DEFINER functions rather than an RLS policy.

**Workstream IDs (stable, internal planning labels).**

| Prefix | Workstream | Meaning |
|---|---|---|
| **P** | Product / UI parity | New read-only pages + panels that rebuild old-app surfaces safely |
| **C** | Connectors / runner | The connector-runner data-sync track (vault, framework, live sync) |
| **R** | Risk / security | RISK-007 closure criteria + security gates |
| **M** | Migration-gated data surfaces | New surfaces that require a reviewed DB migration (invoices, licenses, …) |
| **A** | AI features | Contract/invoice extraction + analysis |
| **Q** | Quality / tests | Harnesses, boundaries, CI checks |

> **IDs are labels, not artifacts.** A workstream ID (e.g. `P-008`) is an internal planning handle. The real merged artifact
> is always a **GitHub PR number**. Where a PR has merged, this doc pins it. Where it has not, it reads **"GitHub PR: TBD."**
> Never treat a planning label as a PR number. (These P/C/R/M/A/Q IDs supersede the older parallel schemes — doc 41's E01–E27
> epics, doc 27's Tracks A–P, doc 33's T1–T9; the row-level crosswalk lives in
> [56_OLD_APP_PARITY_REGISTER.md](./56_OLD_APP_PARITY_REGISTER.md) and [57_CONNECTOR_PARITY_REGISTER.md](./57_CONNECTOR_PARITY_REGISTER.md).)

**The safe-rebuild pattern (proven by #257–#270).** Every completed **P**/**Q** item below followed the same shape: a **NEW
read-only page/section** + a **user-scoped RLS DAL** + a **pure helper** + **render/unit tests** — with **zero migration, no
service-role, no client-side tenant filter, ids-as-keys/booleans, fail-closed**. This is the pattern to keep copying. (FACT:
this pattern is what these PRs did; INFERENCE: that it stays the right default for the next **P** items.)

**"Safe before 2026-07-10" column.** This asks one question: *can this be done right now, under the safe-rebuild pattern,
without touching any RISK-007-gated surface, the live connector sync, permanent source-secret deletion, or production?*
`2026-07-10` matters because it is the earliest date RISK-007 **criterion 15** (permanent deletion of the staging source
Slack client secret) becomes actionable. Nothing in this doc should push live sync or Phase C ahead of its explicit human
gate.

**Status legend.** DONE (merged) · INERT (merged but off-by-default, nothing runs) · PLANNED (PR: TBD) · PENDING (identified,
not started) · BLOCKED / GATED (waiting on a date or an explicit human decision).

---

## 1. Completed workstream items (merged)

Summary first, full detail cards below.

| ID | Title | Status | GitHub PR | Repo | Safe before 2026-07-10? |
|---|---|---|---|---|---|
| P-001 | Dashboards as authenticated home | DONE | #257 | idcaddie-v3 | Yes (done) |
| P-002 | `/needs-attention` read-only surface | DONE | #258 | idcaddie-v3 | Yes (done) |
| P-003 | Dashboard spend + renewals | DONE | #259 | idcaddie-v3 | Yes (done) |
| P-004 | Contract renewal / attention flags | DONE | #260 | idcaddie-v3 | Yes (done) |
| P-005 | Apps inventory filters / flags | DONE | #261 | idcaddie-v3 | Yes (done) |
| Q-001 | UI render harness + route boundaries | DONE | #262 | idcaddie-v3 | Yes (done) |
| P-006 | Canonical app catalog (`/catalog`) | DONE | #263 | idcaddie-v3 | Yes (done) |
| P-007 | App-detail catalog mapping | DONE | #264 | idcaddie-v3 | Yes (done) |
| P-008 | Needs Attention alias backlog | DONE | #266 | idcaddie-v3 | Yes (done) |
| P-009 | Audit search / filter | DONE | #268 | idcaddie-v3 | Yes (done) |
| P-010 | Safe CSV export (apps + contracts) | DONE | #270 | idcaddie-v3 | Yes (done) |

> **Provenance caveat (INFERENCE-check).** These PR numbers are **FACT per the canonical PR map** in the project brief and
> mirror [05_ENGINEERING_CHANGELOG.md](./05_ENGINEERING_CHANGELOG.md). This doc was written **read-only** — no `git`/`gh` was
> run to re-verify against GitHub. Treat each number as a recorded claim to reconcile at review time, not as independently
> re-fetched here.

### P-001 — Dashboards as authenticated home
- **Status:** DONE (merged). · **GitHub PR:** #257 · **Repo:** idcaddie-v3
- **Scope:** New read-only `/dashboards` route, promoted to the authenticated home page; user-scoped RLS DAL + pure helper +
  render/unit tests. Zero migration.
- **Why:** The old app opened onto a dashboard; readers, reviewers, and future OMC users need a tenant-scoped landing surface
  instead of the bare auth shell.
- **Result:** Authenticated users land on a tenant-scoped dashboard home. (FACT: shipped per canonical PR map.)
- **Risk reduced:** Restores navigational parity with **no** write path and **no** migration; RLS stays the sole boundary.
- **Tradeoff:** Read-only aggregates are *display*, not authority; shipping this does **not** imply hosted/production apply
  (only migrations `0001–0015` + Storage reached production; `0016–0041` are staging-only).
- **Dependencies:** Auth shell; existing app/contract DALs.
- **Blocked-by:** None.
- **Safe before 2026-07-10:** Yes (done) — pure read-only, no gated surface touched.
- **Next step:** Add cards as parity rows close (see [56_OLD_APP_PARITY_REGISTER.md](./56_OLD_APP_PARITY_REGISTER.md)).

### P-002 — `/needs-attention` read-only surface
- **Status:** DONE (merged). · **GitHub PR:** #258 · **Repo:** idcaddie-v3
- **Scope:** New read-only `/needs-attention` page aggregating attention signals (e.g. upcoming renewals, unresolved items)
  via a user-scoped DAL + pure helper; render/unit tests; zero migration.
- **Why:** The old app surfaced "what needs looking at"; reviewers need a single consolidated view.
- **Result:** `/needs-attention` ships. (FACT.)
- **Risk reduced:** Consolidates derived signals with no write path and no new grants.
- **Tradeoff:** Flags are derived and read-only — no remediation actions are wired; a flag is a prompt, not a control.
- **Dependencies:** Existing contract/app DALs.
- **Blocked-by:** None.
- **Safe before 2026-07-10:** Yes (done).
- **Next step:** **P-008** landed (#266) — added the catalog-alias backlog section. Further sections track new signals (e.g. P-009+).

### P-003 — Dashboard spend + renewals
- **Status:** DONE (merged). · **GitHub PR:** #259 · **Repo:** idcaddie-v3
- **Scope:** Spend and renewal summary sections on the dashboard; user-scoped RLS DAL + pure aggregation helper + tests. Zero
  migration.
- **Why:** Spend/renewal visibility is core old-app value and a top reviewer question ("what's coming due / what do we pay").
- **Result:** Dashboard shows tenant-scoped spend + renewal summaries. (FACT.)
- **Risk reduced:** Adds a high-value read surface with the proven zero-migration pattern.
- **Tradeoff:** Figures are read-only reporting derived from existing rows; not an accounting/authority source; no export yet.
- **Dependencies:** P-001 (dashboard home).
- **Blocked-by:** None.
- **Safe before 2026-07-10:** Yes (done).
- **Next step:** **P-010** safe CSV export of these views; refine renewal windows against parity rows.

### P-004 — Contract renewal / attention flags
- **Status:** DONE (merged). · **GitHub PR:** #260 · **Repo:** idcaddie-v3
- **Scope:** Renewal + attention flags on contracts (booleans/derived states), feeding P-002/P-003; pure helper + tests. Zero
  migration.
- **Why:** Renewal risk is the highest-signal contract fact; needed a consistent, testable flag definition.
- **Result:** Contracts carry consistent renewal/attention flags surfaced across pages. (FACT.)
- **Risk reduced:** Centralizes flag logic in a pure, tested helper (ids-as-keys/booleans) rather than ad-hoc per-page logic.
- **Tradeoff:** Flags are computed from stored fields only; quality depends on contract data completeness.
- **Dependencies:** Contract DAL.
- **Blocked-by:** None.
- **Safe before 2026-07-10:** Yes (done).
- **Next step:** Feed the same flags into P-008/P-009 backlog + audit filters.

### P-005 — Apps inventory filters / flags
- **Status:** DONE (merged). · **GitHub PR:** #261 · **Repo:** idcaddie-v3
- **Scope:** Filters and flags on the `/apps` inventory (read-only), user-scoped DAL + pure filter helper + tests. Zero
  migration.
- **Why:** The old app's app inventory was filterable; reviewers need to slice inventory by state.
- **Result:** `/apps` supports read-only filtering/flagging. (FACT.)
- **Risk reduced:** Filtering happens server-side within RLS scope (no client-side tenant filter).
- **Tradeoff:** Read-only; no bulk actions; filter set is bounded to shipped fields.
- **Dependencies:** Apps DAL.
- **Blocked-by:** None.
- **Safe before 2026-07-10:** Yes (done).
- **Next step:** Extend filters as catalog mapping (P-007) enriches app metadata.

### Q-001 — UI render harness + route boundaries
- **Status:** DONE (merged). · **GitHub PR:** #262 · **Repo:** idcaddie-v3 · **Workstream:** Quality
- **Scope:** A render harness that mounts each route behind error boundaries, plus unit tests — catching route-level render
  regressions in CI. Zero migration.
- **Why:** As read-only routes multiplied (#257–#261), a broken page could ship silently; the harness makes render failures
  fail CI (fail-closed).
- **Result:** Every route is render-tested; route error boundaries in place. (FACT.)
- **Risk reduced:** Regressions in page render are caught before merge.
- **Tradeoff:** The harness proves pages **mount**; it does **not** prove hosted behavior or RLS enforcement — RLS and Storage
  policies are only provable on hosted staging (see [48_TEST_AND_EVIDENCE_INVENTORY.md](./48_TEST_AND_EVIDENCE_INVENTORY.md)).
  "Green CI" ≠ "hosted-verified."
- **Dependencies:** Existing routes.
- **Blocked-by:** None.
- **Safe before 2026-07-10:** Yes (done).
- **Next step:** Keep the harness updated as new routes (P-008+) land.

### P-006 — Canonical app catalog (`/catalog`)
- **Status:** DONE (merged). · **GitHub PR:** #263 · **Repo:** idcaddie-v3
- **Scope:** New read-only `/catalog` page presenting the canonical app catalog; user-scoped DAL + pure helper + tests. Zero
  migration.
- **Why:** A canonical catalog underpins app-detail mapping and future connector/parity work.
- **Result:** `/catalog` ships. (FACT.)
- **Risk reduced:** Adds the catalog surface with the proven zero-migration pattern.
- **Tradeoff:** Catalog is read-only reference data as surfaced today; not an editable admin catalog.
- **Dependencies:** P-005 (apps inventory).
- **Blocked-by:** None.
- **Safe before 2026-07-10:** Yes (done).
- **Next step:** P-007 mapping (below); tie catalog rows to connector parity in [57_CONNECTOR_PARITY_REGISTER.md](./57_CONNECTOR_PARITY_REGISTER.md).

### P-007 — App-detail catalog mapping
- **Status:** DONE (merged). · **GitHub PR:** #264 · **Repo:** idcaddie-v3
- **Scope:** Maps app-detail views onto the canonical catalog (P-006); user-scoped DAL + pure mapping helper + tests. Zero
  migration.
- **Why:** App detail should resolve to the canonical catalog entry, not a loose string.
- **Result:** App-detail pages map to catalog entries. (FACT.)
- **Risk reduced:** Consistent app identity across inventory, catalog, and detail.
- **Tradeoff:** Read-only mapping; unmatched apps still fall back gracefully (fail-closed, not error).
- **Dependencies:** P-006.
- **Blocked-by:** None.
- **Safe before 2026-07-10:** Yes (done).
- **Next step:** Use the mapping to seed connector parity rows.

---

## 2. Connector-runner data-sync gates (Phase 2a / 2b / 2c) + RISK-007 remaining criteria

This is the **gated** track. It lives mostly in the separate `idcaddie-connector-runner` repo (checked out at
`/Users/samvemuri/code/idcaddie-connector-runner`), with the DB write boundary in the `idcaddie-v3` app repo. **All runs are
staging-only** — the only permitted Supabase ref is `ycdpzduxugdsffjqyoai`; the production ref `dzbfxulvxchdemcettrx` is
hard-blocked at entrypoint, connection, and task-def. Read alongside
[52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md](./52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md),
[54_CONNECTOR_FRAMEWORK_DESIGN.md](./54_CONNECTOR_FRAMEWORK_DESIGN.md), and the runner's
`CONNECTOR_SYNC_PHASE_2_RUNBOOK.md` / `CONNECTOR_SYNC_PHASE_2C_RUNBOOK.md` / `STAGING_LIVE_RUN_EVIDENCE.md`.

> **PR-namespace warning.** `idcaddie-v3` (app-repo) PRs and `idcaddie-connector-runner` (runner-repo) PRs use **separate**
> numbering. "PR #33" below is a **runner** PR; "PR #255" is a **v3 app-repo** PR. Each is labelled with its repo. Do not
> cross-attribute.

| ID | Title | Status | GitHub PR | Repo | Safe before 2026-07-10? |
|---|---|---|---|---|---|
| C-2a | Runner DB write boundary (migration `0041`) | DONE (applied + verified on staging) | #255 | idcaddie-v3 | Done (staging only; prod hard-blocked) |
| C-2b | Runner live wiring (INERT-by-default) | DONE (merged, inert) | #33 | idcaddie-connector-runner | Done (inert; nothing runs) |
| C-2c | First hosted staging live read-only Slack sync | PLANNED — readiness-only, **NOT authorized** | TBD | idcaddie-connector-runner | **GATED** — needs explicit decisions (see below) |
| R-015 | Permanent deletion of staging source Slack **client** secret (criterion 15) | PENDING — date-gated | TBD | AWS op; evidence in idcaddie-v3 [docs/52](./52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md) | **No** — actionable **only after 2026-07-10** |
| R-018 | RISK-007 closure register PR (criterion 18) | PENDING — gated on 3–15 green | TBD | idcaddie-v3 | **No** — cannot draft until 15 is green |
| R-019 | Phase C unblock (criterion 19) | BLOCKED — separate human decision | TBD | governance decision | **No** — do **not** unblock Phase C |

### C-2a — Runner DB write boundary (migration `0041`)
- **Status:** DONE — applied + verified on hosted staging **2026-07-06** (runner evidence "Gate 2a"). · **GitHub PR:** #255
  (**idcaddie-v3** app repo) · **Repo:** idcaddie-v3
- **Scope:** Migration `0041` = three SECURITY DEFINER writer functions (`runner_open_connector_run` /
  `runner_finish_connector_run` / `runner_insert_discovery_fact`), **EXECUTE-only** grant to `connector_runner`, **REVOKE ALL**
  direct INSERT/UPDATE on `discovery_facts` + `connector_runs`, plus an idempotency unique index. Chosen over an RLS policy
  **because** `connector_runner` is BYPASSRLS/NOLOGIN (a policy would be ineffective).
- **Why:** Give the runner a narrow, auditable write path with **no** broad table grant and **no** service role.
- **Result:** Applied + verified on staging ref `ycdpzduxugdsffjqyoai`; production ref **not touched**. (FACT.)
- **Risk reduced:** Runner has no direct table write; least-privilege EXECUTE-only on three reviewed functions.
- **Tradeoff:** Staging-only. The write boundary **exists** but has **never been exercised by a live sync** — no row has been
  written through it yet.
- **Dependencies:** Connector-vault foundation (RISK-007 track).
- **Blocked-by:** None (done).
- **Safe before 2026-07-10:** Done — staging apply only; production hard-blocked throughout.
- **Next step:** C-2b (done, inert) → C-2c (gated).

### C-2b — Runner live wiring (INERT-by-default)
- **Status:** DONE — **merged but INERT-by-default** (synthetic path stays the default; no live run). · **GitHub PR:** #33
  (**idcaddie-connector-runner**, commit `b31dffb`) · **Repo:** idcaddie-connector-runner
- **Scope:** Live `ProviderHttpClient` real fetch + Bearer; reuse of the staging-proven
  `acquireRunnerDecryptCapability` / `runnerDecryptAndUse`; the `discovery_facts` writer adapter + `connector_runs` writer; the
  LIVE path is dynamic-imported **only after all guards pass**.
- **Why:** Assemble the full live-sync path behind guards so it can be reviewed *before* any live execution.
- **Result:** Merged and inert; synthetic remains the default; no live run has occurred. (FACT.)
- **Risk reduced:** The live path is off by default — nothing runs without explicit guards + the confirm phrase.
- **Tradeoff:** The code exists but is **unexercised**; a merged wiring PR is **not** a live sync.
- **Dependencies:** C-2a.
- **Blocked-by:** Merge — none; **live execution** — gated by C-2c.
- **Safe before 2026-07-10:** Done — inert; no execution occurs on merge.
- **Next step:** C-2c (gated).

### C-2c — First hosted staging live read-only Slack sync
- **Status:** PLANNED — **readiness-only / NOT authorized**. Not yet a merged runner PR. · **GitHub PR:** TBD · **Repo:**
  idcaddie-connector-runner
- **Scope:** `auth.test` + `users.list` + `usergroups.list` — **GET-only, no Slack writes, no `auth.revoke`** — emitting
  `app_user_account` + `group` facts to `discovery_facts` and tracking a `connector_runs` row. Reads an **already-minted**
  per-tenant bot token (the RUN GATE B `v2` `oauth_access`); does **no** new OAuth.
- **Why:** The first real end-to-end exercise of the runner write boundary — proves discovery on staging.
- **Result:** **NOT run.** No row has been written through the write boundary. (FACT.)
- **Risk reduced:** None until it runs; when run (under the gates) it validates the least-privilege write path end-to-end on
  staging.
- **Tradeoff / gating (load-bearing):** **Phase C IS "the connector data-sync,"** so even a staging read-only sync is the
  *first exercise of that path* — it does **not** auto-follow from 2a/2b. Requires **ALL** of: (1) `0041` applied + verified
  on staging — **DONE**; (2) runner write path verified (EXECUTE-only on the three functions, no direct table grants,
  `connector_secrets` grants + BYPASSRLS unchanged) — **DONE**; (3) an **explicit decision** that a staging live sync is
  acceptable **while RISK-007 is OPEN** — **PENDING (Sam)**; (4) a **separate per-run Sam GO** immediately before the run —
  **PENDING**; plus a synthetic-in-container smoke of the exact image, staging-only guards, the confirm phrase
  `RUN CONNECTOR SYNC LIVE STAGING` (with `--app-env staging`, prod-ref hard-block,
  `IDCADDIE_RUNNER_CONNECTOR_SYNC_ENABLED/CONFIRM` + `IDCADDIE_RUNNER_DB_ENABLED/CONFIRM = 1`), and redacted evidence capture
  to `STAGING_LIVE_RUN_EVIDENCE.md §14`. The token lives **only** in the Bearer header (never logged/persisted); response
  bodies are never logged (they carry PII); the post-run CloudWatch log scan must be **0 hits**.
- **Dependencies:** C-2a (done), C-2b (done).
- **Blocked-by:** Decision #3 + per-run GO #4; RISK-007 OPEN.
- **Safe before 2026-07-10:** **GATED — not a safe-rebuild item.** Do **not** run without decisions #3/#4. **Note (FACT):**
  criterion 15 is **not** a technical prerequisite for 2c (2c reads the per-tenant bot token, not the client secret), so 2c
  is not blocked *by the date* — but it remains blocked by the human decisions. A purely staging pre-closure proof under
  decision #3 is *allowed* but must be logged as a **pre-closure staging proof, NOT** as Phase C being unblocked.
- **Next step:** Obtain decision #3 → synthetic in-container smoke of the exact image → per-run GO → run + capture redacted
  evidence. See runner `CONNECTOR_SYNC_PHASE_2C_RUNBOOK.md`.

### R-015 — Permanent deletion of the staging source Slack **client** secret (criterion 15)
- **Status:** PENDING — **date-gated; actionable ONLY after 2026-07-10**. · **GitHub PR:** TBD (human operator action +
  evidence recording) · **Repo:** AWS Secrets Manager op; evidence recorded in
  [52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md](./52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md).
- **Scope:** Confirm **permanent deletion** of `/idcaddie/staging/slack/oauth-client-secret` after the recovery window
  (`delete-secret --recovery-window-in-days 7` scheduled **2026-07-03**; DeletionDate **2026-07-10**; already **proven
  unreadable**).
- **Why:** The **last technical** RISK-007 evidence item — removes the residual source client secret for good.
- **Result:** Not yet done; secret proven unreadable and scheduled. (FACT.)
- **Risk reduced:** Eliminates the residual staging source client secret.
- **Tradeoff / stop conditions:** **Metadata operations only — NEVER `get-secret-value`; do NOT force-delete before the
  window.** Its **existence** is a finding; its **contents must never be read**.
- **Dependencies:** Recovery window elapsing (**≥ 2026-07-10**).
- **Blocked-by:** Date gate.
- **Safe before 2026-07-10:** **No — explicitly not actionable before 2026-07-10.**
- **Next step:** After 2026-07-10, a human operator confirms permanent deletion and records evidence in the docs/52 tracker.

### R-018 — RISK-007 closure register PR (criterion 18)
- **Status:** PENDING — gated on criteria **3–15 all green**. · **GitHub PR:** TBD · **Repo:** idcaddie-v3
- **Scope:** Draft the closure-register update **only after** all required evidence (criteria 3–15) is recorded green. The
  docs/52 tracker is **explicitly NOT** this PR.
- **Why:** The formal governance artifact that would let RISK-007 be closed.
- **Result:** Not drafted. (FACT.)
- **Risk reduced:** Governance artifact (no runtime risk change).
- **Tradeoff:** **Must NOT flip RISK-007 to closed inside any run PR** — closure is its own reviewed step.
- **Dependencies:** R-015 (criterion 15) + criteria 3–14 green.
- **Blocked-by:** Criterion 15 (≥ 2026-07-10).
- **Safe before 2026-07-10:** **No** — cannot be prepared until 15 is green (post-2026-07-10).
- **Next step:** After R-015, draft the closure register.

### R-019 — Phase C unblock (criterion 19)
- **Status:** BLOCKED — a **separate explicit human decision AFTER RISK-007 closure**. · **GitHub PR:** TBD · **Repo:**
  governance decision (not a code PR).
- **Scope:** An explicit Sam GO to unblock Phase C — **never bundled** with a run and **never implied** by a green sync.
- **Why:** Phase C = the gated live-connector-execution phase; unblocking it is the highest-consequence decision on this
  track.
- **Result:** BLOCKED. (FACT.)
- **Risk reduced:** n/a.
- **Tradeoff:** **Never imply Phase C unblock from a green run.**
- **Dependencies:** R-018 (closure register) + RISK-007 formally closed.
- **Blocked-by:** RISK-007 OPEN.
- **Safe before 2026-07-10:** **No — do NOT unblock Phase C.**
- **Next step:** Only after RISK-007 closure; recommended sequence is **R-015 → R-018 → R-019**, then a sanctioned first
  data-sync.

---

## 3. Next candidates (PLANNED · GitHub PR: TBD)

These are identified, **not yet started**. Each is a candidate PR, not a commitment; PR numbers are **TBD** until merged.
Row-level parity backing lives in [56_OLD_APP_PARITY_REGISTER.md](./56_OLD_APP_PARITY_REGISTER.md) /
[57_CONNECTOR_PARITY_REGISTER.md](./57_CONNECTOR_PARITY_REGISTER.md) / [58_AI_FEATURE_PARITY_REGISTER.md](./58_AI_FEATURE_PARITY_REGISTER.md);
the immediate ordering lives in [61_NEXT_3_DAYS_PLAN.md](./61_NEXT_3_DAYS_PLAN.md).

| ID | Title | Workstream | Pattern | Safe before 2026-07-10? | Notes |
|---|---|---|---|---|---|
| C-2c | Hosted staging live sync | Connectors | **Gated** | **GATED** | See §2 — needs decisions #3/#4; RISK-007 OPEN |
| R-015 | RISK-007 criterion 15 | Risk | Human op | **No** (after 2026-07-10) | See §2 |
| R-018 | RISK-007 closure register | Risk | Governance PR | **No** | See §2 — gated on 3–15 green |
| R-019 | Phase C unblock | Risk | Governance decision | **No** | See §2 — BLOCKED |
| M-001 | Invoices RLS + read-only surface | Migration-gated | **Migration-first** | Yes, *with* review | Not the zero-migration pattern (see below) |
| M-002 | License / ELU RLS + read-only surface | Migration-gated | **Migration-first** | Yes, *with* review | Not the zero-migration pattern (see below) |
| A-001 | AI contract/file analysis **plan** | AI | Design doc only | **Yes** | Anchors on [doc 16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md); nothing built |
| A-002 | AI invoice extraction **plan** | AI | Design doc only | **Yes** | **No v3 design doc exists yet** (gap) |

### P-008 — Needs Attention alias backlog
- **Status:** DONE (merged). · **GitHub PR:** #266 · **Repo:** idcaddie-v3
- **Workstream:** Product · **Scope:** Extended `/needs-attention` (P-002) with a "Catalog aliases pending review" section —
  reuses the P-006 catalog DAL, filters aliases to `review_status = pending` (a bounded `0024` CHECK enum, so no guessing),
  and shows the alias value + product/vendor **names** linking to `/catalog`, via the pure builder + render/unit tests.
  **Zero migration.**
- **Why:** Aliases that don't resolve to a canonical app are exactly the kind of "needs a human" item the old app surfaced.
- **Result:** `/needs-attention` now includes **catalog aliases pending review**. Read-only — no alias confirm/reject/resolver
  write; those stay deferred (surfaced as "Not built yet" on `/catalog`).
- **Dependencies:** P-002, P-004 (flag helper), P-007 (catalog mapping). · **Blocked-by:** None.
- **Risk reduced:** Surfaces the catalog-graph review backlog in the cleanup queue without exposing any secret/PII/raw id
  (`reviewed_by`/`reviewed_at`/`provenance`/`source`/`normalized_name` never returned or rendered). **RISK-007 stays OPEN;
  Phase C stays BLOCKED; no live sync.**
- **Next step:** A future *write* workflow to resolve an alias (confirm/reject) — deferred; needs its own RLS-gated design.

### P-009 — Audit search / filter
- **Status:** DONE (merged). · **GitHub PR:** #268 · **Repo:** idcaddie-v3
- **Workstream:** Product · **Scope:** Added search + action/entity/window filters to the existing `/audit` read surface via a
  new **pure** filter helper (`audit-filter.ts`) + render/unit tests. **Zero migration.**
- **Why:** The `/audit` viewer already ships (read-only); a growing audit log is only useful if it's searchable. `audit_logs`
  is append-only.
- **Result:** `/audit` now has safe **search + action/entity/window filters**. The **audit DAL projection is UNCHANGED** —
  filtering runs server-side over the already-fetched, RLS-scoped rows and can only NARROW (no new query, no widening). Search
  is over the safe displayed fields (action + entity) only — no raw-JSON / before-after / actor / IP / user-agent search.
- **Risk reduced:** Makes the audit surface usable for reviewers without exposing any new field; an invalid `days` value fails
  safe to all-time (never falsely narrows). **RISK-007 stays OPEN; Phase C stays BLOCKED; no live sync.**
- **Dependencies:** Existing `/audit` surface + DAL. · **Blocked-by:** None.
- **Next step:** Deep/historical/paginated audit search + export are separate future items (see P-010 for export).

### P-010 — Safe CSV export (apps + contracts)
- **Status:** DONE (merged). · **GitHub PR:** #270 · **Repo:** idcaddie-v3
- **Workstream:** Product · **Scope (as shipped):** Client-side "Export CSV" on `/apps` and `/contracts` — a pure `to-csv.ts`
  serializer (RFC-4180 quoting, CRLF) + a small `"use client"` button per surface. **Zero migration.**
- **Result:** `/apps` and `/contracts` now have **safe client-side CSV export**.
- **Constraints (FACT):** **apps + contracts only** (dashboards/catalog/audit/needs-attention/reports/invoice/license export
  are NOT built); exports **only the already-rendered safe display columns** (`hasOwner`→Yes/No; nulls→""); **no server
  export route/handler**; **no re-query**; **no widened DAL projection** (`apps.ts`/`contracts.ts` untouched); the client
  button receives only pre-projected `{headers, rows, filename}`; **no raw ids/UUIDs or secrets** exported (asserted by
  tests). Apps exports the current filtered/sorted view; contracts the visible list.
- **Risk reduced:** A recurring old-app/reviewer ask, delivered with zero new data exposure and no new server surface.
  **RISK-007 stays OPEN; Phase C stays BLOCKED; no live sync.**
- **Dependencies:** P-005 (apps list) / P-004 (contracts list). · **Blocked-by:** None.
- **Next step:** The **pre-2026-07-10 read-only product queue (P-001–P-010, Q-001) is COMPLETE.** Deeper exports
  (dashboards/audit/paginated) are separate future items; the priority now shifts to the gated R-/C- track (below) on/after
  2026-07-10, plus an optional docs refresh of [00_PRODUCT_STATUS](./00_PRODUCT_STATUS.md) / [05_ENGINEERING_CHANGELOG](./05_ENGINEERING_CHANGELOG.md).

### M-001 — Invoices RLS + read-only surface *(migration-gated)*
- **Workstream:** Migration-gated data surfaces · **Scope:** A **new reviewed migration** adding the invoices table/columns
  with **RLS enabled and default-deny** (RLS on, **no** SELECT policy until a reviewed policy is added), a user-scoped DAL, a
  read-only surface, and RLS tests — *then* the read page.
- **Why:** Invoices are core old-app value (and the target of A-002 extraction), but they require schema that does not exist
  yet.
- **Tradeoff (important):** This is **NOT** the zero-migration safe-rebuild pattern. It requires **migration-first**
  discipline: reviewed migration, default-deny until the SELECT policy is reviewed, staging-apply only, **no production
  apply**, added to the RLS test suite. It does **not** depend on RISK-007.
- **Dependencies:** Reviewed migration + RLS policy review. · **Blocked-by:** Migration review (not a date, not RISK-007).
- **Safe before 2026-07-10:** **Yes, with migration-first review** — staging-apply only; production stays hard-blocked. Not a
  drop-in "safe-rebuild" item; treat with full migration discipline (see [03_DATABASE_AND_MIGRATIONS.md](./03_DATABASE_AND_MIGRATIONS.md)).
- **Next step:** Draft the migration + default-deny policy; add RLS tests before any read surface.

### M-002 — License / ELU RLS + read-only surface *(migration-gated)*
- **Workstream:** Migration-gated data surfaces · **Scope:** As M-001, for license / ELU (effective licensed users) data: a
  reviewed migration with RLS-enabled default-deny, user-scoped DAL, RLS tests, then a read-only surface.
- **Why:** License/spend visibility is a core old-app capability still missing in v3.
- **Tradeoff:** Same migration-first discipline and caveats as M-001. Independent of RISK-007.
- **Dependencies:** Reviewed migration + policy review. · **Blocked-by:** Migration review.
- **Safe before 2026-07-10:** **Yes, with migration-first review** — staging-only; production hard-blocked.
- **Next step:** Draft the migration + default-deny policy; add RLS tests first.

### A-001 — AI contract/file analysis **plan** *(design only)*
- **Workstream:** AI · **Scope:** A **planning/design** item (a doc, not code) that turns the existing contract-PDF extraction
  design ([16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)) into a buildable plan with a
  workstream ID. **Nothing is built** today beyond PDF-validation core (#40) + the Storage boundary — no extraction worker,
  completion handler, or review UI.
- **Why:** AI extraction is significant old-app value and needs a v3 plan tied to the parity register, not just a design.
- **Tradeoff / guardrails to carry forward:** suggestions-only (no silent autosave/overwrite), strict field allowlist,
  prompt-injection-aware, no service-role onFinalize worker — see the anti-pattern table in
  [60_DO_NOT_COPY_FROM_OLD_APP.md](./60_DO_NOT_COPY_FROM_OLD_APP.md) and doc 16 §0.
- **Dependencies:** Storage boundary (shipped), PDF validation (#40). · **Blocked-by:** None (planning only).
- **Safe before 2026-07-10:** **Yes** — a design doc only; no code, no migration, no secret, no connector surface.
- **Next step:** Write the plan; register the workstream against [58_AI_FEATURE_PARITY_REGISTER.md](./58_AI_FEATURE_PARITY_REGISTER.md).

### A-002 — AI invoice extraction **plan** *(design only)*
- **Workstream:** AI · **Scope:** A **planning/design** item for invoice extraction. **FACT:** unlike contracts, invoice
  extraction has **no v3 design doc yet** — this is a genuine gap. The old app did AI over **both** contracts and invoices
  (Document AI + Vertex/Gemini fallback); v3 has neither for invoices.
- **Why:** To make invoice-AI parity visible and buildable instead of an undocumented gap.
- **Tradeoff:** Depends on M-001 (invoices need a schema to write suggestions against) and on the same AI guardrails as A-001.
- **Dependencies:** A-001 (shared AI plan), M-001 (invoices surface). · **Blocked-by:** None for planning; build depends on
  M-001.
- **Safe before 2026-07-10:** **Yes** — design doc only.
- **Next step:** Draft the invoice-extraction design (it does not exist); flag the gap in
  [58_AI_FEATURE_PARITY_REGISTER.md](./58_AI_FEATURE_PARITY_REGISTER.md).

---

## 4. Sequencing and honest framing

- **Two independent tracks.** The **P/Q/M/A** product tracks and the **C/R** connector/risk track are largely independent.
  Product read-only surfaces (P-008/009/010, and the migration-gated M-001/002 with review) can proceed **now** without
  touching RISK-007, the live sync, or production. (INFERENCE: this parallelism is the reason product work should not wait on
  the connector gates.)
- **The connector/risk critical path is strictly ordered and human-gated:** C-2a (done) → C-2b (done, inert) →
  [decision #3] → C-2c (gated staging sync) ; and, on the governance side, **R-015 (≥ 2026-07-10) → R-018 (closure register)
  → R-019 (Phase C unblock)**. Nothing here shortcuts a gate.
- **What "shipped" does and does not mean.** ~13 authenticated read-only routes ship, but the app itself is **not** fully
  hosted-applied (only migrations `0001–0015` + Storage reached production; `0016–0041` are staging-only) and has never been
  hosted-exercised beyond a single staging Auth check. "Read-only surfaces ship" is **not** "hosted/production-ready." (FACT,
  from the docs audit; see [55_REBUILD_STATUS.md](./55_REBUILD_STATUS.md).)
- **Hard invariants (do not violate in any candidate).** RISK-007 stays **OPEN**; Phase C stays **BLOCKED**; **no** live sync
  before criteria 15/18/19 (label any such item a *gated exception*, logged as a pre-closure staging proof — never as Phase C
  unblocked); production ref `dzbfxulvxchdemcettrx` stays untouched; never copy the old app's unsafe patterns
  ([60_DO_NOT_COPY_FROM_OLD_APP.md](./60_DO_NOT_COPY_FROM_OLD_APP.md)); never print secret/key contents.

*Maintenance: when a candidate merges, move its row up to §1 (or §2), replace "PR: TBD" with the real merged PR number and
repo, and add the matching [05_ENGINEERING_CHANGELOG.md](./05_ENGINEERING_CHANGELOG.md) entry.*
