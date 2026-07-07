# 15 — Next 3 Days Plan (2026-07-07 → 2026-07-10)

**This is the short-horizon "what do we do right now?" page.** It covers the three
working days from **2026-07-07 to 2026-07-10** and hands off to the full plan in
`docs/59_WORKSTREAM_ROADMAP.md` for anything beyond that.

It is written for the whole team — engineers, product, security reviewers, future AI
coding agents, and non-specialists.

- **Date of this plan:** 2026-07-07 (FACT — the day it was written).
- **How to read the labels:** every load-bearing claim is tagged **FACT** (something we
  can point to in the repo, a merged pull request, or recorded evidence) or **INFERENCE**
  (a reasonable conclusion from those facts, not itself a recorded artifact).
- **Workstream IDs vs. PR numbers (FACT):** an ID like `P-008` is an *internal planning
  label*, not a shipped artifact. The real, merged artifact is a **GitHub pull request
  (PR) number** like `#264`. Work that has not merged yet is written as
  "**P-008 (GitHub PR: TBD)**". We never invent a "PR #8"-style number for unmerged work.
- **Acronyms** are spelled out on first use and collected in the Glossary.

> **Standing safety rules for this page (do not violate):** This plan must never mark
> RISK-007 as closed, never declare Phase C unblocked, never schedule a live connector
> sync before RISK-007's remaining criteria are met, and never print the contents of any
> secret or key. Any item that would touch live credential handling before RISK-007 closes
> is labelled a **gated exception** and is explicitly deferred here. These are governance
> rules, not stylistic ones.

**This is document 15 of a 7-document pack.** The others:
`docs/55_REBUILD_STATUS.md` (start-here status), `docs/56_OLD_APP_PARITY_REGISTER.md`
(product parity), `docs/57_CONNECTOR_PARITY_REGISTER.md` (connector parity),
`docs/58_AI_FEATURE_PARITY_REGISTER.md` (AI parity), `docs/59_WORKSTREAM_ROADMAP.md` (the
full canonical plan), and `docs/60_DO_NOT_COPY_FROM_OLD_APP.md` (unsafe patterns to avoid).

---

## 1. The plan in one line

**FACT + INFERENCE:** For **2026-07-07 → 2026-07-09**, keep building **safe, read-only
product surfaces** on the proven pattern — **P-008**, then **P-009**, and **P-010 only if
there is time** — because those are the highest-value things we are actually *allowed* to
do right now with zero governance risk. **On/after 2026-07-10**, the RISK-007 closure track
becomes actionable and takes priority: **R-015 → R-018 → R-019**, and only after those,
the first sanctioned connector sync **C-2c**. Nothing on the connector/live-sync track can
legitimately start before 2026-07-10.

---

## 2. Ground rules for this window (what makes a task "this-window-safe")

**FACT — the proven safe rebuild pattern** (the same recipe behind every PR from #257 to
#264, described in `docs/55_REBUILD_STATUS.md` §3). A task is safe to build in this window
if, and only if, it is **all** of the following:

- a **new read-only page or section** (it reads data; it does not write it);
- backed by a **user-scoped Data Access Layer (DAL)** — a server-only module that relies on
  **Row Level Security (RLS)**, the database's per-row access control, for tenant isolation
  (never a filter written in browser/client code);
- built on a **pure helper** (small, testable logic with no side effects);
- covered by **render tests and unit tests**;
- with **zero database migration**, **no service-role/admin database key on any request
  path**, IDs-and-booleans as keys, and **fail-closed** behaviour (when in doubt, show
  nothing rather than leak).

**INFERENCE:** Anything that needs a *new table*, a *new column*, or a *new RLS policy* is
**out of scope for this window** — it is a migration-gated change (the `M-` workstream) that
must go through migration-first discipline and a security review, which is deliberately
slower. Section 7 lists the specific things that fall on the wrong side of this line and why.

---

## 3. What is already done (recap)

**FACT — the eight most recent merged PRs (#257–#264), all on the safe pattern above.**
Full detail and the old-app parity mapping are in `docs/55_REBUILD_STATUS.md` §4.1 and
`docs/56_OLD_APP_PARITY_REGISTER.md`.

| Workstream | Delivered | GitHub PR |
|---|---|---|
| **P-001** | Dashboards became the authenticated home page | **#257** |
| **P-002** | "Needs Attention" list | **#258** |
| **P-003** | Dashboard spend + renewals summary | **#259** |
| **P-004** | Contract renewal / attention flags | **#260** |
| **P-005** | Apps inventory filters + flags | **#261** |
| **Q-001** | UI render-test harness + route error boundaries | **#262** |
| **P-006** | Canonical app catalog (`/catalog`) | **#263** |
| **P-007** | App-detail ↔ catalog mapping | **#264** |

Because **P-006** (a canonical catalog of apps) and **P-007** (mapping each app's detail
page to that catalog) just landed, the app now has a clean notion of a "canonical app" and
the **aliases** that resolve to it. That is exactly what makes **P-008 (below)** a small,
natural next step rather than new infrastructure.

---

## 4. What to build next, in order (the 2026-07-07 → 2026-07-09 window)

All three items below follow the Section 2 pattern: read-only, RLS-scoped DAL, pure helper,
tests, **no migration, no service role**. Each is written as a workstream ID with **GitHub
PR: TBD** because none has merged yet. Ordering rationale and dependencies also appear in
`docs/59_WORKSTREAM_ROADMAP.md`.

### P-008 — "Needs Attention" alias backlog (GitHub PR: TBD)
- **What:** Add a read-only section to the existing "Needs Attention" surface (shipped as
  P-002/#258) that lists **app aliases that have not yet been resolved to a canonical app** —
  the housekeeping backlog created now that the canonical catalog (P-006) and alias mapping
  (P-007) exist. It answers "which incoming app names still need a human to map them?"
- **Why now (INFERENCE):** It reuses the catalog/alias data that #263/#264 just made
  available, closes an obvious loop for the OMC-style workflow, and needs **no new data** —
  only a read + a pure "is this alias unmapped?" helper.
- **Shape (FACT-of-pattern):** new read-only section + RLS-scoped DAL reading the existing
  alias/catalog tables + pure helper + render/unit tests. **Zero migration.**
- **Explicitly not in P-008:** any *write* to resolve an alias. Resolving is a future write
  workflow (see `docs/59_WORKSTREAM_ROADMAP.md`); P-008 only *surfaces the backlog*.

### P-009 — Audit log search / filter (GitHub PR: TBD)
- **What:** Add search and filter controls to the existing read-only **audit-log viewer**
  (the `/audit` surface). Let a reviewer narrow the log by actor, action type, and date
  range instead of scrolling the whole list.
- **Why now (INFERENCE):** The audit viewer already ships and is already RLS-scoped, so this
  is pure presentation logic over rows the caller is *already* entitled to see. It materially
  improves the security-reviewer and admin experience with no new exposure.
- **Shape (FACT-of-pattern):** filter/search is a **pure helper** over the DAL's
  already-RLS-scoped result set (the database still decides which rows exist; the filter only
  narrows what is already permitted). Render/unit tests. **Zero migration, no service role.**
- **Guardrail:** the filter must never widen scope — it can only *narrow* the RLS-permitted
  set. Fail-closed on any unrecognised filter input.

### P-010 — Safe CSV export (GitHub PR: TBD) — **only if scope is tight and time remains**
- **What:** Let a user export data they can *already see* (e.g. the app inventory or the
  contract/renewal view) as a CSV (comma-separated values) file.
- **Why it is optional (INFERENCE):** It adds real user value but touches file-generation and
  formatting details that can eat a day. If P-008 and P-009 take the window, **drop P-010** to
  next window rather than rush it.
- **Why it is still "safe":** the export is generated **server-side from the same RLS-scoped
  DAL** that already backs the on-screen view — it exposes **nothing** the user cannot already
  read on the page. No new data path, no new table, no service role.
- **Guardrails (FACT-of-pattern):** export exactly the columns already shown; generate on the
  server from the RLS-scoped read (never a broad/service-role read); fail-closed (an empty or
  denied read produces an empty file, never someone else's rows); render/unit tests on the pure
  CSV-serialisation helper. **Zero migration.**

---

## 5. The exact next recommended item — and why

**RECOMMENDATION (INFERENCE, from the facts below): the single next thing to pick up is
`P-008` (the "Needs Attention" alias backlog).**

Why P-008 and not anything on the connector/RISK-007 track:

- **It is actionable *today* (FACT).** It fits the Section 2 safe pattern end-to-end and needs
  no migration, no security review, and no human governance decision.
- **The RISK-007 / connector items literally cannot start yet (FACT).** The next technical
  item on that track, **R-015** (RISK-007 **criterion 15**, permanent deletion of the staging
  source Slack client secret), is **date-gated and only actionable *after* 2026-07-10** — it
  sits behind a recovery window (see `docs/52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md` and
  `docs/04_RISK_REGISTER.md`). Trying to "get ahead" on it before the window is not possible
  and must not be forced.
- **It builds directly on what just merged (FACT).** P-006/P-007 created the canonical-app +
  alias structure; P-008 is the smallest useful surface that uses it.

**INFERENCE:** After P-008, take **P-009**; take **P-010 only if the window still has room.**
When 2026-07-10 arrives, the connector/RISK-007 track (Section 6) becomes the priority and
should preempt further `P-` work.

---

## 6. On/after 2026-07-10 — the RISK-007 → Phase C → live-sync track

These items are the *reason* live connector sync is still blocked. They are **gated** — each
depends on the one before it, and several depend on an explicit human decision, not just code.
None can legitimately begin before **2026-07-10**. The authoritative per-criterion detail is
in `docs/52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md`; the connector context is in
`docs/57_CONNECTOR_PARITY_REGISTER.md`.

**Reminder (FACT):** **RISK-007 is OPEN** and **Phase C is BLOCKED.** Nothing below changes
that until it is actually done and recorded green. This plan does not close RISK-007 and does
not unblock Phase C.

### R-015 — RISK-007 criterion 15: permanent source-secret deletion (GitHub PR: TBD)
- **FACT:** The staging app-level Slack **client secret** was scheduled for deletion behind a
  recovery window; its **DeletionDate is 2026-07-10**. On/after that date a **human operator**
  must confirm **permanent** deletion.
- **Hard rules (FACT):** metadata operations only — **never** read the secret value, and **do
  not** force-delete early. This is the last remaining *technical* criterion.

### R-018 — RISK-007 criterion 18: closure register PR (GitHub PR: TBD)
- **FACT:** The closure register PR may be drafted **only after** all required evidence
  (criteria 3–15) is recorded green — i.e., **after R-015**. The tracker doc
  `docs/52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md` is explicitly **not** that PR, and RISK-007
  must **never** be flipped to "closed" inside any run PR.

### R-019 — RISK-007 criterion 19: Phase C unblock decision (GitHub PR: TBD)
- **FACT:** Unblocking Phase C is a **separate, explicit human decision made after RISK-007
  closure** — never bundled into a run PR and never implied by a green sync. Until this
  decision is taken, Phase C stays BLOCKED.

### C-2c — first hosted staging live read-only Slack sync (GitHub PR: TBD, connector-runner repo)
- **FACT — what it is:** the first **hosted staging** live sync: GET-only Slack reads
  (`auth.test`, `users.list`, `usergroups.list`), **no Slack writes, no `auth.revoke`**, using
  an already-minted per-tenant bot token. It emits discovery facts through the Phase 2a write
  boundary (migration 0041) and records a connector-run row.
- **FACT — it is NOT authorized and has NEVER run.** No row has ever been written through the
  write boundary. Preconditions still outstanding: (3) an **explicit decision** that a staging
  live sync is acceptable **while RISK-007 is OPEN** — PENDING; and (4) a **separate, per-run
  human "GO"** immediately before the run — PENDING; plus a synthetic in-container smoke test of
  the exact image and the staging-only guards/confirm phrase.
- **Honest sequencing nuance (FACT):** C-2c is *technically* independent of R-015 — it reads a
  per-tenant **bot** token, not the deleted **client** secret. But the **recommended, sanctioned
  order** (per the connector-runner Phase 2c runbook §6) is **R-015 → R-018 → R-019 → C-2c**, so
  the first data-sync happens *after* closure and *after* the Phase C unblock decision.
- **Gated-exception caveat (FACT — do not skip):** running C-2c on staging *before* RISK-007
  closes is possible only as a deliberately-logged **pre-closure staging proof** under decision
  (3) + a per-run GO, and it must be recorded **explicitly as a pre-closure staging proof, NOT as
  Phase C being unblocked.** This plan does **not** recommend taking that shortcut in this window;
  it recommends walking the sanctioned R-015 → R-018 → R-019 → C-2c order.

---

## 7. What we are deliberately NOT doing before 2026-07-10 (and why)

Each of these is a real old-app capability we *will* need eventually. We are choosing *not* to
start it in this window, for a specific, honest reason. Deferring is a decision, not an oversight.

### We are NOT building invoices yet
- **Why (FACT):** Invoices are a **new data surface** — the app has no invoice table today.
  Adding one requires a **database migration**, and a new table starts **default-deny** (RLS is
  enabled but there is **no SELECT policy**, so *nothing* is readable) until a specifically
  **reviewed RLS SELECT policy** is added. That is a migration-first, security-reviewed `M-`
  workstream change — the opposite of a zero-migration read-only add.
- **Tradeoff:** invoices are valuable (and the old app tied AI extraction to them), but rushing a
  new table + RLS policy into a 3-day window is exactly where tenant-isolation bugs get
  introduced. It waits for proper migration-first + review. See `docs/56_OLD_APP_PARITY_REGISTER.md`
  and `docs/59_WORKSTREAM_ROADMAP.md`.

### We are NOT building license / ELU (entitlement & license-usage) tracking yet
- **Why (FACT):** Same reason as invoices — license/ELU is another **new default-deny data
  surface**. It needs a **migration plus a reviewed RLS policy** before a single row can be shown
  safely, so it is a migration-gated (`M-`) item, not a safe read-only `P-` add.
- **Tradeoff (INFERENCE):** license/seat/usage reporting is high-value for the SaaS-management
  story, but building it correctly (correct grain, correct RLS scope) matters more than building
  it fast. Deferred to the migration-first track in `docs/59_WORKSTREAM_ROADMAP.md`.

### We are NOT running a live connector sync before RISK-007 closes
- **Why (FACT):** A live sync — even a **staging read-only** one — is the **first real exercise
  of the gated connector-execution path**. **RISK-007 is OPEN**, **Phase C is BLOCKED**, and the
  C-2c preconditions (explicit "acceptable while OPEN" decision + per-run GO) are **PENDING**.
  Criterion 15 (R-015) is not even actionable until after 2026-07-10.
- **Tradeoff:** the vault lifecycle has already been proven on staging (RUN GATE A/B, decrypt/use
  — recorded, redacted), so the *temptation* to "just run it" is real. We do not, because the
  governance sequence (R-015 → R-018 → R-019) exists precisely to make the first live sync a
  reviewed, deliberate event rather than a side effect. See Section 6 and
  `docs/52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md`.

### We are NOT rebuilding all 51 remaining connectors first
- **Why (FACT):** The old app had **52+ hand-written connectors/scrapers**. Reproducing 51 more
  one-off scrapers would be a large, unsafe, unmaintainable effort, and each would need its own
  security review. The chosen design instead is **one generic executor** that interprets
  **reviewed, declarative manifests** (data files describing how to talk to a provider — **no
  secrets, no code**), proven first on **Slack v1**. See `docs/57_CONNECTOR_PARITY_REGISTER.md`
  and `docs/54_CONNECTOR_FRAMEWORK_DESIGN.md`.
- **Tradeoff (INFERENCE):** the manifest framework is "1 provider, engine not yet generalized"
  today, so it *looks* slower than porting a handful of scrapers. But the reusable-engine approach
  is what lets the remaining providers become small, reviewed manifests instead of 51 bespoke,
  individually-risky integrations. Near-term connector effort belongs on **finishing and proving
  the framework + Slack**, not fanning out.

### We are NOT bulk-building AI features — AI needs a staged rebuild
- **Why (FACT):** The old app's AI patterns are on the **do-not-copy** list
  (`docs/60_DO_NOT_COPY_FROM_OLD_APP.md`, and `docs/16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md` §0):
  it did client-only file-type checks, ran a **service-role** "on file finalize" worker, asked the
  model to "extract **ALL** fields" with unbounded output, and let AI output **silently overwrite**
  saved data with prompt-injection-unaware prompts.
- **The staged rebuild (FACT/INFERENCE):** doing AI **safely** means building it in layers, one
  proven at a time — (1) secure upload + **server-side** PDF validation (the validation core is
  designed and partly built), then (2) a **bounded, allowlisted** extraction worker that treats the
  document text as **hostile**, then (3) a **suggestions-only** review UI where **a human confirms**
  before anything is written — **never** silent autosave.
- **Tradeoff (FACT):** the old app's *broader* AI surface (invoices, multiple document types,
  summarization) has **no v3 design yet**, so it cannot be built until it is designed. Trying to
  reproduce all of it at once would re-import the exact unsafe patterns we are rebuilding to escape.
  Status and staging detail: `docs/58_AI_FEATURE_PARITY_REGISTER.md`.

---

## 8. Day-by-day sketch (INFERENCE — a suggestion, not a contract)

- **2026-07-07 (Mon-equivalent):** Start and land **P-008** (alias backlog). Begin **P-009**
  (audit search/filter).
- **2026-07-08:** Finish **P-009**. If scope is tight, stop here and carry P-010 forward.
- **2026-07-09:** **P-010** (safe CSV export) *only if* P-008 + P-009 are done and tested;
  otherwise polish/tests and pre-stage the RISK-007 track paperwork (read-only prep for R-018,
  no early action on R-015).
- **2026-07-10:** The recovery window clears. **R-015** becomes actionable — a human operator
  confirms permanent deletion of the staging source secret (metadata only). Then the track
  continues **R-018 → R-019 → C-2c** per Section 6, on the sanctioned order.

**INFERENCE:** If any `P-` item slips, prefer shipping fewer items cleanly over rushing three.
The window's value is *safe* progress, not item count.

---

## 9. Definition-of-done checklist (applies to P-008, P-009, P-010)

Before any of the `P-` items in this window is considered done (FACT-of-standard, from
`docs/08_CODE_AND_DOCS_STANDARD.md`):

- [ ] Read-only surface only — **no write path** introduced.
- [ ] Reads go through an **RLS-scoped DAL**; **no tenant filter in client code**.
- [ ] **No database migration**; **no service-role/admin key** on any request path.
- [ ] Logic lives in a **pure helper** with **unit tests**; the surface has **render tests**.
- [ ] **Fail-closed**: denied/empty reads show nothing, never another tenant's rows.
- [ ] Ran the **smallest-safe-version pass** (do not simplify away safety, RLS, audit, tests, or
      migration-first discipline) before opening the PR.
- [ ] The changelog and the roadmap (`docs/59_WORKSTREAM_ROADMAP.md`) are updated with the real
      merged PR number when it lands.

For the **R-** and **C-2c** items, the "definition of done" is *not* a code checklist — it is the
per-criterion evidence in `docs/52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md` plus the explicit human
decisions named in Section 6. Do not treat green code or a green sync as closure.

---

## 10. Glossary

- **RLS (Row Level Security):** PostgreSQL's per-row access control; in the new app it is the
  **sole** authorization boundary — the database decides who sees each row.
- **DAL (Data Access Layer):** server-only modules that read/write data and rely on RLS for tenant
  isolation, never on a client-side filter.
- **default-deny:** a table with RLS enabled but **no SELECT policy** — nothing is readable until a
  specifically reviewed policy is added. New data surfaces (invoices, license/ELU) start here, which
  is why they need a migration + review, not a quick read-only add.
- **migration:** a versioned change to the database schema. New tables/columns/policies require one;
  read-only surfaces over existing data do not.
- **Phase C:** the **gated live-connector-execution phase**. Currently **BLOCKED**; unblocked only
  by RISK-007 criterion 19 (workstream **R-019**), a separate human decision.
- **RISK-007:** the governance risk gating real connector-secret handling and deletion. Currently
  **OPEN** (remaining criteria 15/18/19 → workstreams R-015/R-018/R-019).
- **connector-runner:** a **separate repository and worker program** that will run connector syncs
  from behind the credential-vault boundary. **Inert by default**; does nothing live without gates
  and a human GO. C-2c lives here.
- **manifest connector:** a **reviewed, declarative connector definition** (a data file, no secrets,
  no code) interpreted by one generic executor — the alternative to 51 one-off scrapers.
- **Workstream ID vs. GitHub PR number:** an ID (`P-008`, `R-015`, `C-2c`, …) is an internal
  planning label; the **PR number** (`#264`) is the real merged artifact. Unmerged work is written
  "**X-000 (GitHub PR: TBD)**" — never a made-up PR number.

---

*Cross-references used by this page:* `docs/55_REBUILD_STATUS.md`,
`docs/04_RISK_REGISTER.md`, `docs/08_CODE_AND_DOCS_STANDARD.md`,
`docs/56_OLD_APP_PARITY_REGISTER.md`, `docs/57_CONNECTOR_PARITY_REGISTER.md`,
`docs/58_AI_FEATURE_PARITY_REGISTER.md`, `docs/59_WORKSTREAM_ROADMAP.md`,
`docs/60_DO_NOT_COPY_FROM_OLD_APP.md`, `docs/16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md`,
`docs/52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md`, `docs/54_CONNECTOR_FRAMEWORK_DESIGN.md`.
