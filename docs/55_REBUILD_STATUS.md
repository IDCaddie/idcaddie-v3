# 00 — Rebuild Status (Whole-Project, Plain English)

> **CURRENT CURSOR (updated 2026-07-08):** `idcaddie-v3` main @ `7f7d050`, PRs merged **through #284** (latest = P-018a,
> `/connectors` status badges + leak-scan). `idcaddie-connector-runner` main @ `84ecf6d`. **The `768f91a` / "through #264"
> figures below are this page's original 2026-07-07 snapshot — historical, not current.** Governance unchanged: RISK-007
> remains OPEN; Phase C remains BLOCKED; production untouched; connector live data-sync has not run (earlier hosted
> staging RISK-007 proof steps occurred under gated procedures, but those were not Phase C live data-sync); old-app
> parity is NOT complete.

**This is the "where are we right now?" page for the ID Caddie rebuild.**
It is written to be read by everyone on the team: engineers, product, security
reviewers, future AI coding agents, and non-specialists. If you read only one
document, read this one first, then follow the cross-references.

- **Date of this snapshot:** 2026-07-07 (FACT — this is the date the page was written).
- **How to read the labels:** Every load-bearing claim is tagged **FACT** (something
  we can point to in the repo, a merged PR, or recorded evidence) or **INFERENCE**
  (a reasonable conclusion drawn from those facts, but not itself a recorded artifact).
- **Acronyms** are spelled out the first time and collected in the Glossary at the bottom.

> **Standing safety rules for this page (do not violate):** This document must never
> mark RISK-007 as closed, never declare Phase C unblocked, never propose running a
> live connector sync before RISK-007's remaining criteria are met, and never print
> the contents of any secret or key. These are governance rules, not stylistic ones.

**This pack has 7 documents. This is document 00. The other six are:**

- `docs/56_OLD_APP_PARITY_REGISTER.md` — line-by-line "what the old app did vs. what the new app does" register.
- `docs/57_CONNECTOR_PARITY_REGISTER.md` — connector-by-connector status (old app had 52+; where each stands).
- `docs/58_AI_FEATURE_PARITY_REGISTER.md` — AI/document-extraction features: what existed, what is designed, what is built.
- `docs/59_WORKSTREAM_ROADMAP.md` — the single canonical plan: workstreams, ordering, and what to build next.
- `docs/60_DO_NOT_COPY_FROM_OLD_APP.md` — the explicit list of old-app patterns that are unsafe and must not be reproduced.
- `docs/61_NEXT_3_DAYS_PLAN.md` — the short-horizon action plan.

---

## 1. What ID Caddie is (in plain English)

ID Caddie is a **software-as-a-service (SaaS) product that helps an organization keep
track of the outside software apps it pays for, the contracts and renewals attached to
those apps, and the people who have accounts in them.** Think of it as a single place
where a company can answer questions like: "Which apps are we paying for?", "When does
this contract renew?", "Who still has an account in an app they left the company months
ago?", and "What needs my attention this week?"

- **FACT:** The new app today ships a set of authenticated, read-only reporting pages
  (dashboards, an app inventory, a contract/renewal view, a "needs attention" list, a
  people/accounts view, a files view, reports, an audit-log viewer, an app catalog, and
  administrative read views). These are described in detail in `docs/56_OLD_APP_PARITY_REGISTER.md`.
- **INFERENCE:** The intended long-term product is a full replacement for the old app,
  including the ability to make changes (writes), not just read data. Most of that write
  and automation capability is not built yet (see Section 6).

---

## 2. What the old app was

- **FACT (from the code-derived inventory, `docs/56_OLD_APP_PARITY_REGISTER.md` and the
  legacy inventories it draws on):** The old ("legacy") ID Caddie app was built on Google
  Firebase. It had a web front end, a set of cloud functions (server code), and a large
  library of **52+ connectors** — small integrations that logged into third-party systems
  (Slack, Okta, Google, Microsoft 365, and many more) to pull in lists of users, apps, and
  usage. It also had AI-assisted document extraction (pulling structured fields out of
  contract and invoice PDFs).
- **FACT:** The old app is the source of our "parity" list — the catalog of capabilities the
  new app is expected to preserve. That capability catalog lives in `docs/56_OLD_APP_PARITY_REGISTER.md`
  (product/UI), `docs/57_CONNECTOR_PARITY_REGISTER.md` (connectors), and
  `docs/58_AI_FEATURE_PARITY_REGISTER.md` (AI features).
- **Important nuance (FACT):** The old app is treated as **evidence of what to build, not as
  a pattern to copy.** Several of its security and architecture choices were unsafe. Those
  are called out explicitly in `docs/60_DO_NOT_COPY_FROM_OLD_APP.md` and summarized in
  Section 8 below.

---

## 3. Why we are rebuilding safely instead of copying

We are **not** porting the old code. We are rebuilding on a different, safer foundation.
The single most important reason is the **authorization model**.

- **FACT:** In the new app, the sole authorization boundary is **Row Level Security (RLS)** —
  a PostgreSQL database feature where the database itself enforces, row by row, which tenant
  (customer organization) and which user is allowed to see or change each record. Access
  control does not live in the front-end code, and it does not depend on the application
  "remembering" to filter by customer. The database refuses to return rows the caller is not
  entitled to.
- **FACT:** The old app's security failures (documented in the legacy security map that feeds
  `docs/60_DO_NOT_COPY_FROM_OLD_APP.md`) are the direct justification for this RLS-first design.
- **FACT — the proven safe rebuild pattern:** Every recent product page was built the same
  careful way, and it is worth stating because it is the pattern we keep using:
  - a **new read-only page or section**, plus
  - a **user-scoped Data Access Layer (DAL)** — a server-only module that reads data and
    relies on RLS (never on a filter written in client code) to keep tenants separate, plus
  - a **pure helper** (small, testable logic with no side effects), plus
  - **render tests and unit tests**,
  - with **zero database migration**, **no service-role/admin database key on any request
    path**, **no tenant filtering done in the browser**, values keyed by IDs and booleans,
    and **fail-closed** behavior (if in doubt, show nothing rather than leak).
- **INFERENCE:** This pattern is deliberately conservative. It means new product surfaces can
  ship quickly and safely without touching the database schema or the credential/secret
  machinery, which are governed separately and far more strictly.

---

## 4. Current new-app state (repo: idcaddie-v3)

- **FACT — commit at this snapshot (SHA; historical — current cursor is `7f7d050` / #284, see banner at top):**
  `idcaddie-v3` `main` was at **`768f91a`**, with GitHub
  pull requests (PRs) merged **through #264**. (SHA quoted as the recorded canonical value
  for 2026-07-07; this page was written under a read-only, no-git constraint and did not
  re-derive it from the repository.)
- **FACT:** The app ships roughly a dozen authenticated, read-only routes (pages). These are
  reporting/inventory surfaces — you can look, but the app does not yet let you change most of
  the underlying data through them.
- **Honesty note (INFERENCE, drawn from the risk register `docs/04_RISK_REGISTER.md`):**
  "Read-only surfaces ship" should **not** be read as "the product is hosted/production-ready."
  The application has been exercised primarily in local and staging environments; the full set
  of database migrations has not been applied to the production database (see Section 12). A
  reader should treat product-surface progress and production-readiness as two separate meters.

### 4.1 The recently completed PRs (#257–#264)

These are the eight most recent merged product/quality PRs — the read-only surface expansion.
Each is shown with its **internal workstream ID** and its **real GitHub PR number**. (See the
Glossary for why those are two different things and why the PR number is the one that "counts.")

| Workstream ID | What it delivered | GitHub PR |
|---|---|---|
| **P-001** | Dashboards became the authenticated home page | **#257** |
| **P-002** | "Needs Attention" list | **#258** |
| **P-003** | Dashboard spend + renewals summary | **#259** |
| **P-004** | Contract renewal / attention flags | **#260** |
| **P-005** | Apps inventory filters + flags | **#261** |
| **Q-001** | UI render-test harness + route error boundaries | **#262** |
| **P-006** | Canonical app catalog (`/catalog`) | **#263** |
| **P-007** | App-detail ↔ catalog mapping | **#264** |

- **FACT:** `P-` is the product/UI-parity workstream; `Q-` is the quality/tests workstream.
- **FACT:** All eight followed the safe rebuild pattern in Section 3 (new read-only surface +
  RLS-scoped DAL + pure helper + tests, no migration, no service role).
- The per-row mapping of these surfaces back to specific old-app capabilities lives in
  `docs/56_OLD_APP_PARITY_REGISTER.md`; the forward plan lives in `docs/59_WORKSTREAM_ROADMAP.md`.

---

## 5. Current connector-runner state (repo: idcaddie-connector-runner)

The **connector-runner** is a **separate repository and a separate worker program.** Its job is
to (eventually) run connector syncs — logging into third-party systems and pulling in data —
from behind a strict credential/secret boundary. It is deliberately **inert by default**: it
does nothing live unless a very specific set of gates is satisfied.

- **FACT — current commit (SHA):** `idcaddie-connector-runner` `main` is at **`84ecf6d`**
  (Phase 2a/2b live wiring merged, plus Phase 2c readiness documentation). SHA quoted as the
  recorded canonical value for 2026-07-07.
- **FACT — Phase 1 (framework):** merged and **inert**. It established the connector manifest
  contract, a strict executor, and a synthetic (fake, non-live) sync task.
- **FACT — Phase 2a (the database write boundary):** **DONE.** This is app-repo migration
  **0041**, which creates three `SECURITY DEFINER` writer functions
  (`runner_open_connector_run`, `runner_finish_connector_run`, `runner_insert_discovery_fact`),
  grants the runner **EXECUTE-only** on them, and **revokes** all direct INSERT/UPDATE on the
  underlying tables. It was applied and verified on **staging** on 2026-07-06.
  *(Why functions instead of an RLS policy? Because the runner's database role is
  BYPASSRLS/NOLOGIN, an RLS policy on it would be ineffective — a narrow, EXECUTE-only function
  boundary is the correct control. This is exactly the kind of nuance the connector parity
  register `docs/57_CONNECTOR_PARITY_REGISTER.md` records.)*
- **FACT — Phase 2b (runner live wiring):** merged, but **INERT by default.** The live code path
  exists (real outbound HTTP with a Bearer token, reuse of the staging-proven decrypt capability,
  the discovery-fact and connector-run writer adapters) but the **synthetic path stays the
  default**; no live run happens on merge.
- **FACT — Phase 2c (first hosted staging live read-only Slack sync):** **readiness documentation
  only — NOT authorized and NOT run.** It would perform GET-only Slack reads (`auth.test`,
  `users.list`, `usergroups.list`), no Slack writes, using an already-minted per-tenant bot token.
  It requires an explicit human "GO" and a synthetic in-container smoke test of the exact image
  first. It has not been given that GO.
- **FACT:** No row has ever been written through the Phase 2a write boundary. See Section 11
  (live-sync status).

---

## 6. What is complete / partial / missing / deferred / blocked

This is the honest scorecard. It intentionally distinguishes "we can look at it" from
"it is fully done and production-proven." The authoritative per-item detail lives in the
parity registers (`docs/10_`, `docs/11_`, `docs/12_`); this is the summary.

### Complete (built and merged, on the safe pattern)
- **FACT:** The RLS-first authorization foundation and the read-only reporting surface:
  dashboards-as-home, needs-attention, app inventory + filters, contract/renewal view, people/
  accounts view, files (metadata) view, reports, audit-log viewer, app catalog + detail mapping,
  and admin read pages (PRs through #264).
- **FACT:** The connector-runner framework, the Phase 2a database write boundary (migration
  0041, staging-verified), and the Phase 2b live wiring (inert).
- **FACT:** On staging, the credential-vault lifecycle has been exercised end-to-end and
  recorded (RUN GATE A: first real Slack OAuth exchange, token stored envelope-only; the
  decrypt/use step; RUN GATE B: vault-version rotation/supersede/revoke) — see Section 9's
  honest-scope caveat.

### Partial (started, not finished)
- **FACT:** The connector program. A single provider (Slack v1, users + a "group" fact) is
  designed and its write boundary is staged, but the **generic multi-provider executor, the
  per-item schema registry, membership fan-out, and any live sync are not built.** Against the
  old app's 52+ connectors, this is roughly "1 of 52+, engine not yet generalized." Detail:
  `docs/57_CONNECTOR_PARITY_REGISTER.md`.
- **INFERENCE:** Several read-only surfaces show data that will eventually need matching write
  and automation workflows to be truly at parity; today they are report-only.

### Missing (not built)
- **FACT:** AI / document-extraction features. Contract-PDF extraction is **designed only**
  (`docs/16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md`); there is no extraction worker, completion
  handler, or review UI, and the old app's broader AI surface (invoices, multiple document
  types, summarization) has **no v3 design yet**. Detail: `docs/58_AI_FEATURE_PARITY_REGISTER.md`.
- **FACT:** Most write/edit workflows, imports/exports, and the automation the old app had.

### Intentionally deferred (a choice, not a gap)
- **FACT:** Live connector execution is deliberately deferred behind the credential-vault
  governance (RISK-007) and Phase C. This is by design; the runner is inert on purpose.
- **INFERENCE:** Non-contract AI features are deferred until the safer contract-PDF path is
  built and proven, and until a design exists.

### Blocked (cannot proceed until a gate clears)
- **FACT:** **Phase C** (live connector data-sync as a sanctioned phase) is **BLOCKED** on the
  closure of RISK-007 plus an explicit human decision (Section 10).
- **FACT:** The production database is **hard-blocked** for the connector work (Section 12).

---

## 7. Current commit SHAs (quick reference)

- **FACT:** `idcaddie-v3` — `main` @ **`768f91a`** (PRs merged through **#264**).
- **FACT:** `idcaddie-connector-runner` — `main` @ **`84ecf6d`** (Phase 2a/2b live wiring + 2c
  readiness docs).

*(Both SHAs are quoted as the recorded canonical values for 2026-07-07; this page was produced
under a read-only, no-git constraint and did not re-run git to confirm them.)*

---

## 8. What is unsafe to copy from the old app

The old app is our capability reference, **not** our code reference. Several of its patterns are
unsafe and must never be reproduced. The full, authoritative list — with the safe replacement for
each — is in **`docs/60_DO_NOT_COPY_FROM_OLD_APP.md`.** In summary (FACT, drawn from that doc and
the AI design doc `docs/16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md`):

- **Do not** rely on the front end / client code to enforce which customer sees which data.
  (New rule: the database enforces it via RLS.)
- **Do not** run request-path code with a service-role / admin database key that bypasses RLS.
- **Do not** use client-only file-type (MIME) checks; validate server-side.
- **Do not** build a service-role "on file finalize" background worker.
- **Do not** ask an AI model to "extract ALL fields" with unbounded output; use a strict allowlist.
- **Do not** let AI output silently overwrite saved data; AI produces **suggestions**, a human
  confirms. Prompts must be written assuming the document text is hostile (prompt-injection aware).

---

## 9. RISK-007 status

- **What RISK-007 is (FACT):** RISK-007 is the governance risk that gates real connector-secret
  handling and deletion — i.e., the risk we must close before we are allowed to treat live
  connector-credential handling as a normal, sanctioned operation.
- **Status (FACT):** **RISK-007 is OPEN.** It must not be marked closed on this page or anywhere
  else until its remaining criteria are recorded green and a closure register PR is drafted.
- **Remaining criteria (FACT, from the closure tracker `docs/52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md`):**
  - **Criterion 15** — permanent deletion of the staging source Slack **client** secret. It is
    scheduled behind a recovery window and is **actionable only after 2026-07-10**; a human
    operator must then confirm permanent deletion (metadata operations only; never read the secret
    value; do not force-delete early). This is the last remaining *technical* item.
  - **Criterion 18** — the RISK-007 **closure register PR**, which may only be drafted *after* all
    required evidence (criteria 3–15) is recorded green. The tracker doc is explicitly **not** that PR.
  - **Criterion 19** — the **Phase C unblock decision**, which is a separate, explicit human decision
    *after* closure (see Section 10). BLOCKED.
- **Criteria 3–14 (FACT):** recorded as DONE on **staging**.
- **Honest-scope caveat you must carry (FACT):** RUN GATE B rotated the vault *version*, but the new
  version (v2) wraps the **same underlying Slack token** as v1 (identical fingerprint — Slack
  re-issued it). So a provider-side token rotation was **not** forced, and a provider-side
  `auth.revoke` is **deferred** (revoking now would kill the active token). The decision on record
  is that vault-version rotation is *sufficient for staging closure*, and provider-side rotation is
  *future hardening*. Do not describe rotation/revocation as if it were provider-side.

---

## 10. Phase C status

- **What Phase C is (FACT):** Phase C is the **gated live-connector-execution phase** — the point at
  which running real connector data-syncs becomes a sanctioned, normal operation rather than a
  one-off gated exception.
- **Status (FACT):** **Phase C is BLOCKED.** It is unblocked only by RISK-007 **criterion 19**,
  which is a **separate, explicit human decision made after RISK-007 closure** — never bundled into a
  run PR, and never implied by a green sync.
- **Terminology warning (FACT):** Older design docs sometimes use "Phase C" to mean the hosted-runner
  secret-*ingestion* step (parts of which have happened on staging). This page uses "Phase C" only in
  the governance/roadmap sense above: the gated live-execution phase, which remains BLOCKED. If you
  see "Phase C" elsewhere meaning "the ingestion runner ran," that is a different, narrower usage.

---

## 11. Staging, production, and live-sync status

### Staging (FACT)
- The only permitted Supabase staging reference is **`ycdpzduxugdsffjqyoai`**.
- Migration **0041** (the connector-runner write boundary) has been applied and verified on staging.
- The credential-vault run gates (A and B), the decrypt/use step, and the replay/state-reuse denial
  checks were all exercised on staging and recorded (redacted, no plaintext) in the runner repo's
  staging live-run evidence.

### Production (FACT)
- The production Supabase reference is **`dzbfxulvxchdemcettrx`**. For the connector work it is
  **HARD-BLOCKED and untouched** — the runner entrypoint, the database connection, and the task
  definition all hard-block the production reference so it cannot appear as a target, identity,
  config, or log line.
- **INFERENCE (from the risk register `docs/04_RISK_REGISTER.md`):** More broadly, the newer database
  migrations have not been applied to production, and the app has not been meaningfully exercised
  against hosted production beyond a single staging Auth/tenant-context check. Treat "production
  hosted-apply" as an open, separately-tracked item, not as done.

### Live sync (FACT)
- **A live connector sync has NEVER run.** The runner is inert by default; no row has been written
  through the Phase 2a write boundary. The first hosted staging read-only Slack sync (Phase 2c) is
  documented as *readiness only* and requires: (1) migration 0041 applied+verified — done; (2) the
  runner write path verified — done; (3) an explicit decision that a staging live sync is acceptable
  **while RISK-007 is OPEN** — PENDING; and (4) a separate, per-run human "GO" immediately before the
  run — PENDING. Until (3) and (4) are given, **do not run it.** Any such run before RISK-007 closure
  must be logged as a *pre-closure staging proof*, explicitly **not** as Phase C being unblocked.

---

## 12. One-paragraph honest summary (for a buyer or reviewer)

**FACT + INFERENCE, stated plainly:** The new ID Caddie ships about a dozen authenticated,
read-only reporting pages on a genuinely safer foundation (RLS is the sole authorization boundary,
no service-role on request paths, fail-closed, every surface tested), and the connector credential
vault has been exercised end-to-end on staging. **At the same time**, the product cannot yet make
most of the changes the old app could, only one connector of the old 52+ is even partway designed,
AI extraction is design-only, no live sync has ever run, RISK-007 is OPEN, Phase C is BLOCKED, and
production is hard-blocked/untouched for the connector work. "Read-only surfaces ship" is real
progress; it is not the same as "hosted, production-ready, or at parity." The path to close that gap
is `docs/59_WORKSTREAM_ROADMAP.md`, and the immediate next steps are in `docs/61_NEXT_3_DAYS_PLAN.md`.

---

## 13. Glossary

- **RLS (Row Level Security):** A PostgreSQL feature that enforces, per row, which tenant and user
  may read or write each record. In the new app it is the **sole** authorization boundary — the
  database, not the app code, decides who sees what.
- **DAL (Data Access Layer):** Server-only modules (in `src/lib/data/*`) that read and write data.
  They rely on RLS for tenant isolation and never filter by tenant in client/browser code.
- **default-deny:** A table that has RLS enabled but **no SELECT policy** — nothing is readable until
  a specifically reviewed policy is added. The safe starting posture for sensitive tables.
- **Phase C:** The **gated live-connector-execution phase** — the point at which live connector
  data-syncs become a sanctioned, normal operation. Currently **BLOCKED** (unblocked only by RISK-007
  criterion 19, a separate human decision). Note the terminology warning in Section 10.
- **RISK-007:** The **governance risk that gates real connector-secret handling and deletion.**
  Currently **OPEN** (remaining criteria 15, 18, 19). Must never be shown as closed until its closure
  register PR is drafted against green evidence.
- **connector-runner:** A **separate repository and worker program** that will run connector syncs
  from behind the credential-vault boundary. It is **inert by default** and does nothing live without
  explicit gates and a human GO.
- **manifest connector:** A **reviewed, declarative connector definition** (a data file describing how
  to talk to a provider, containing no secrets and no code), interpreted by one generic executor —
  as opposed to a one-off hand-written scraper like the old app used.
- **Workstream ID vs. GitHub PR number:** A **workstream ID** (e.g. `P-007`, `Q-001`, `C-`, `R-`,
  `M-`, `A-`) is an **internal planning label** for a stream of work — it is *not* a shipped artifact
  and *not* a PR number. The **GitHub PR number** (e.g. `#264`) is the **real, merged artifact.** When
  a piece of planned work has not merged yet, write it as, e.g., "Workstream P-008 (GitHub PR: TBD)" —
  never invent a "PR #8"-style number.
- **envelope-only (storage of a secret):** A secret is stored only as an encrypted envelope (encrypted
  with a per-secret key, bound to its tenant/connector/kind/version); the app can save it but only the
  runner-only role can decrypt it. The plaintext is never persisted or logged.
- **SECURITY DEFINER writer function:** A database function that runs with the privileges of its
  definer and is the *only* way the runner may write certain tables. The runner gets EXECUTE-only on
  it; direct INSERT/UPDATE on the tables is revoked. This is the Phase 2a write boundary (migration 0041).

---

*Cross-references used by this page:* `docs/04_RISK_REGISTER.md`,
`docs/56_OLD_APP_PARITY_REGISTER.md`, `docs/57_CONNECTOR_PARITY_REGISTER.md`,
`docs/58_AI_FEATURE_PARITY_REGISTER.md`, `docs/59_WORKSTREAM_ROADMAP.md`,
`docs/60_DO_NOT_COPY_FROM_OLD_APP.md`, `docs/61_NEXT_3_DAYS_PLAN.md`,
`docs/16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md`, `docs/52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md`.
