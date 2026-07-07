# 12 · AI Feature Parity Register

**Canonical source for: what AI features the old (legacy Firebase) app had, and how to rebuild each one
*safely* in the v3 rebuild.** This is a parity + planning register, not a design doc and not a build. It
belongs to the 7-doc rebuild pack and is a sibling of:

- [`55_REBUILD_STATUS.md`](./55_REBUILD_STATUS.md) — where the whole rebuild is *now*.
- [`56_OLD_APP_PARITY_REGISTER.md`](./56_OLD_APP_PARITY_REGISTER.md) — the full old-app-vs-v3 parity ledger (this doc is the AI slice of it).
- [`57_CONNECTOR_PARITY_REGISTER.md`](./57_CONNECTOR_PARITY_REGISTER.md) — the connector/sync parity slice (a *separate* track from AI; see §3).
- [`59_WORKSTREAM_ROADMAP.md`](./59_WORKSTREAM_ROADMAP.md) — the ranked build plan; the `A-###` AI workstream IDs used here are owned there.
- [`60_DO_NOT_COPY_FROM_OLD_APP.md`](./60_DO_NOT_COPY_FROM_OLD_APP.md) — the anti-pattern list; the AI anti-patterns in §6 below feed it.
- [`61_NEXT_3_DAYS_PLAN.md`](./61_NEXT_3_DAYS_PLAN.md) — the immediate next steps.

Deep-dive references (specialist docs, outside the pack): the AI extraction design
[`16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md`](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md), the code-derived old-app
inventory [`40_CODE_DERIVED_OLD_APP_INVENTORY.md`](./40_CODE_DERIVED_OLD_APP_INVENTORY.md) §4, the source-line
ledger [`43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md`](./43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md) §3.7, the
security/RLS model [`02_SECURITY_AND_RLS.md`](./02_SECURITY_AND_RLS.md), the risk register
[`04_RISK_REGISTER.md`](./04_RISK_REGISTER.md), and the roadmap epic **E15** in
[`41_FULL_PARITY_IMPLEMENTATION_ROADMAP.md`](./41_FULL_PARITY_IMPLEMENTATION_ROADMAP.md).

> **Status in one line (do not overclaim):** In v3, **no AI feature is built.** The only AI-adjacent code
> that exists is a server-side PDF *validation* core (`src/lib/files/pdf-validation.ts`, PR #40) plus the
> `files` metadata schema (migration `0012`) and its RLS policies (`0013`). There is **no extraction
> worker, no model call, no completion handler, no review UI, and no invoice AI.** AI is **deferred, not
> abandoned** (§2).

*Date of this register: 2026-07-07.*

---

## 1. How to read this doc

**Audience:** engineers, product, security reviewers, future AI coding agents, and non-specialists. We
explain acronyms on first use and separate *what is true today* from *what we recommend*.

**FACT vs INFERENCE — every claim is one of two kinds:**

- **FACT** = verifiable from the repo / the specialist docs cited (docs 16, 40, 43) / the legacy code they
  quote. The columns *old location*, *user value*, *input data needed*, *output shown*, and *new-app
  status* are FACT (code-derived).
- **INFERENCE** = a planning judgment made here. The columns *why not rebuilt yet*, *safety/privacy risk*,
  *safe before July 10?*, and *recommended rebuild path* are INFERENCE (reasoned, but not yet a reviewed
  design or a merged PR). Treat them as proposals for review, not commitments.

**Acronyms, first use:**
- **AI** — here, machine-learning models applied to documents (extraction and summarization).
- **PDF** — the contract/invoice document format the old app processed.
- **OCR** — Optical Character Recognition (turning a scanned image into text).
- **Document AI** — Google Cloud's document-parsing service the old app used for extraction.
- **Vertex / Gemini** — Google's large-language-model (LLM) service the old app used as a summarization/fallback path.
- **DTO** — Data Transfer Object: a server-shaped, already-authorized, already-redacted read model returned
  by the Data Access Layer. **Not** a raw database table row. (This distinction is load-bearing — see §5.)
- **RLS** — Row Level Security: Postgres per-row access policies; in v3 this is the *sole* authorization boundary.
- **DAL** — Data Access Layer: the server-only modules in `src/lib/data/*` that read data under RLS.
- **PII** — Personally Identifiable Information (names, emails, financial terms) — the sensitive content AI would touch.
- **RISK-007 / Phase C** — the governance risk and gated phase that cover *connector-secret handling*.
  **These do not gate AI** — see §3. RISK-007 is **OPEN**; Phase C is **BLOCKED**; this register does not
  change that.

**"PR #" numbers** in this doc are `idcaddie-v3` app-repo pull requests as recorded in
[`05_ENGINEERING_CHANGELOG.md`](./05_ENGINEERING_CHANGELOG.md). Where a merged PR is not the artifact, the
`A-###` labels are *internal planning IDs only* — the real artifact will be a GitHub PR number (TBD).

---

## 2. The headline: AI is DEFERRED, not abandoned

**FACT.** The legacy app had a real, shipping AI surface: it ran uploaded contract **and** invoice PDFs
through Google **Document AI** for structured field extraction, with a **Vertex/Gemini** summarization
path, a completion handler that wrote the extracted fields onto the record, a per-document-type prompt/
schema registry, a split-view review UI, and scheduled jobs to repair stuck AI operations (docs 40 §4,
43 §3.7). None of that is trivial and none of it is junk — the *workflow* (upload a PDF → AI suggests
fields → a human reviews → save) is worth keeping.

**FACT.** v3 has intentionally **not** rebuilt any of it yet. What exists is the *safe foundation for a
future* contract-PDF path only: server-side PDF validation (extension + MIME (Multipurpose Internet Mail
Extensions type) + magic-bytes + size cap), the `files` metadata columns, and `files` RLS — all designed
in [`16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md`](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md). The bucket,
upload action, extraction worker, model call, and UI are all unbuilt.

**Why deferred (INFERENCE):** AI is the *highest-blast-radius* feature to get wrong — it reads sensitive
tenant documents, it is steered by attacker-controllable input (the document text), and the legacy
implementation shipped several patterns v3 explicitly forbids (client-only validation, a service-role
worker on the write path, "extract ALL fields", silent auto-overwrite of user data — see §6). It is
correct to build the RLS-first read/write foundation, the file surface, and the audit story **first**, and
to add AI last, as an *assistive suggestion layer* on top of an already-safe base.

**The honest current state, in one paragraph (for a buyer/reviewer):** *AI extraction is designed for
contracts only (doc 16), and nothing is built beyond PDF validation and file metadata/RLS. Invoice AI and
document summarization are not even designed. The old app's AI touched contracts and invoices; v3's AI
parity is therefore ~0% shipped and should be planned as one of the last tracks, after the file surface is
hosted-applied and a suggestion-only, audited, DTO-based pattern is proven.*

---

## 3. Where AI sits relative to the connector / RISK-007 track (read this before §7's "July 10" column)

This is the single most misread boundary, so we state it plainly.

- **FACT.** RISK-007, Phase C, the connector vault, and the `2026-07-10` date all belong to the
  **connector-secret** track (see [`04_RISK_REGISTER.md`](./04_RISK_REGISTER.md),
  [`52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md`](./52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md), and
  [`57_CONNECTOR_PARITY_REGISTER.md`](./57_CONNECTOR_PARITY_REGISTER.md)). The `2026-07-10` date is
  RISK-007 **criterion 15** — the permanent deletion of a *staging Slack source secret* after its recovery
  window. **It has nothing to do with AI.**
- **INFERENCE / RULE.** AI features **must never touch** connector secrets, OAuth tokens, raw private
  keys, KMS material, or any unreviewed sensitive data. An AI worker's world is: (a) a tenant document the
  user chose to upload, and (b) already-safe, already-authorized DTOs. It never reads the connector vault,
  never reads `connector_secrets`, never sees a runner decrypt capability. If an AI feature is ever
  proposed to read anything in the vault, that is an automatic reject.
- **Consequence for the "safe before July 10?" column (§7):** because AI is a *separate track*, the
  July-10 RISK-007 gate is **not** the thing blocking AI. So "safe before July 10?" for an AI item means
  *"is it safe to design/begin this work right now, in the current gated window, without waiting on
  RISK-007?"* — and the real blocker (when there is one) is the **hosted file/Storage surface**
  (RISK-002 + RISK-016, both OPEN), not RISK-007. We answer each row on that basis and name the real
  blocker.

---

## 4. AI feature register — at a glance

Each row is one legacy AI capability (or, for `A-008`, a recommended *new* safe entry point that has no
old-app equivalent). Full detail per row is in §5. Columns *old location / user value / input / output /
status* are **FACT**; *safe-now? / workstream* are **INFERENCE**.

| ID | Feature | Old location (FACT) | New-app status (FACT) | Safe to start before Jul 10? (INFERENCE) |
|---|---|---|---|---|
| **A-008** | Read-only AI summaries over already-safe DTOs *(new safe entry point — no old-app equivalent)* | *(none — proposed)* | Not built / not designed | **Yes** — design + prototype; never reads raw tables/files/secrets |
| **A-005** | Document-type prompt + field-schema registry | `constants/documentTypes.js` (`documentPrompts`) | Not built (allowlist sketched in doc 16 §7) | **Yes** — pure code + config, no data, no model call |
| **A-001** | Contract-PDF field extraction (Document AI entities) | `storage/processFileWithAI.js`, `handleDocumentAICompletion.js` | Not built (PDF *validation* core only, PR #40) | **No to build/ship** — needs hosted file surface (RISK-002/016); design safe now |
| **A-002** | Invoice-PDF field extraction (Document AI entities) | same functions, `documentTypes` invoice schema | Not built; invoices unbuilt end-to-end | **No** — needs invoices surface (E10) *and* file surface first |
| **A-003** | Document summarization (Vertex/Gemini) | `processFileWithAI.js` Vertex path, `vertexAISummary` | Not built / not designed | **No to ship** — needs safe-storage decision for summaries; design safe now |
| **A-004** | Apply extracted fields to the record | `handleDocumentAICompletion.js` (auto-write) | Not built; **legacy auto-write is a forbidden pattern** (§6) | **Design-safe now**, build after A-001; **must be suggestion-only, never auto-apply** |
| **A-006** | AI extraction review UI (split-view) | `DocumentAIViewer.tsx` | Not built | **No** — depends on A-001 output existing; design safe now |
| **A-007** | Stuck-AI-job monitors / repair | `checkDocumentAIOperations.js`, `checkStuckAiProcessing.js` (scheduled) | Not built (no worker to monitor) | **No / N/A** — only meaningful once a worker (A-001) exists |

**Old-app AI covers contracts AND invoices** (FACT, doc 40 §4). v3 has the PDF-validation core + Storage
*boundary* only — so AI parity is effectively **0% shipped**. Roadmap epic **E15** (doc 41) owns this
track; **E15 can only start after E09 (file upload surface) lands** (doc 41 §critical-path).

---

## 5. Per-feature register (full columns)

The evidence bundle for this rebuild seeds one canonical old-app AI feature — *"Document AI entity
extraction — auto-pulls structured fields from contract and invoice PDFs"* — which the code-derived docs
(40 §4, 43 §3.7, 16 §0) resolve into the concrete capabilities below.

### A-001 · Contract-PDF field extraction (Document AI)
- **Old location (FACT):** `webapp/functions/src/storage/processFileWithAI.js` (Storage `onFinalize`
  trigger, ~337 lines) → `handleDocumentAICompletion.js` (~119 lines); prompt/fields from
  `constants/documentTypes.js`.
- **User value (FACT):** upload a contract PDF and have vendor, dates, cost, renewal terms, etc.
  pre-filled instead of typing them by hand.
- **Input data needed (FACT):** the uploaded contract PDF bytes (hostile/untrusted); the document text
  Document AI derives from it (also hostile).
- **Output shown (FACT):** structured suggested field values (vendor, total cost, currency, start/end/
  renewal dates, PO number, auto-renew, etc.) offered to the user.
- **New-app status (FACT):** **Not built.** Only the server-side validation core + path helpers exist
  (`validateContractPdf`, `buildContractFileObjectPath`, PR #40) and the `files` schema/RLS (`0012`/
  `0013`). No bucket, worker, model call, or UI.
- **Why not rebuilt yet (INFERENCE):** it depends on a hosted private Storage bucket + object policies +
  an upload action, none of which are built or hosted-applied (RISK-002 files default-deny, RISK-016 both
  OPEN). AI is deliberately the last layer on top of that.
- **Safety / privacy risk (INFERENCE):** high. Reads a sensitive tenant document; the PDF text can carry
  **prompt-injection** ("ignore previous instructions…"); a naive implementation can leak PII into logs,
  into durable raw-response storage, or across tenants.
- **Data / RLS / migration dependency (FACT+INFERENCE):** the `files` table (`0012`) + its RLS (`0013`);
  the hosted `contract-files` private bucket + object-RLS (hosted-only, cannot be tested in the local
  `postgres:16` harness — doc 16 §3); writes must route through the existing RLS-gated contract write
  action (PR #30) and be audited by `0010`. **No new AI-specific migration is required** if the design in
  doc 16 is followed (the `extraction_result_json` column already exists on `files`).
- **Safe before July 10? (INFERENCE):** **Design: yes. Build/ship: no** — and *not* because of RISK-007/
  July 10 (unrelated, §3), but because the hosted file surface must land first.
- **Recommended rebuild path (INFERENCE):** follow doc 16 exactly — server-side validation → scan-gate
  (`scan_status = passed`) → an **out-of-request** extraction worker that **re-derives tenant
  authorization** before writing → **strict allowlist** parse (only the doc-16 §7 field subset; drop
  everything else) → `parseContractWriteInput` (the same validator the form uses) → **suggestions only**,
  applied by an explicit human action through the RLS-gated write. Prefer a current Claude model via a
  structured-output schema (doc 16 §7); the provider does not change the trust model — output stays
  untrusted and allowlist-validated.
- **Workstream ID:** **A-001** (roadmap epic **E15**; GitHub PR: TBD).

### A-002 · Invoice-PDF field extraction (Document AI)
- **Old location (FACT):** same Storage/AI functions as A-001, driven by the **invoice** schema in
  `constants/documentTypes.js`; surfaced in the legacy `/IDCApps/[id]/invoices/[invoiceId]` "AI split-view
  extraction" screen (doc 40).
- **User value (FACT):** auto-extract vendor, amount, invoice number/date from an invoice PDF to build
  spend/chargeback evidence.
- **Input data needed (FACT):** the invoice PDF bytes + derived text (both hostile).
- **Output shown (FACT):** suggested invoice fields (amount, currency, invoice number, date, vendor).
- **New-app status (FACT):** **Not built — and neither is the surrounding invoice surface.** v3 has no
  invoices list/detail, no spend model, no invoice write path (roadmap **E10** Missing, doc 41).
- **Why not rebuilt yet (INFERENCE):** invoice AI is downstream of an entire unbuilt invoices/spend
  domain; there is nothing yet for extracted invoice fields to attach to.
- **Safety / privacy risk (INFERENCE):** high — same PDF/PII/prompt-injection risks as A-001, plus
  financial-figure integrity (a wrong extracted amount silently corrupting spend reporting).
- **Data / RLS / migration dependency (FACT+INFERENCE):** requires the invoices tables + RLS + write
  action (E10) **and** the file surface (as A-001) — a larger dependency chain than contract AI.
- **Safe before July 10? (INFERENCE):** **No** — blocked on the invoices domain (E10) and the file
  surface; unrelated to RISK-007.
- **Recommended rebuild path (INFERENCE):** build the invoices read/write surface first (E10), then reuse
  the A-001 worker pattern with an invoice allowlist schema. Same rules: suggestion-only, strict allowlist,
  RLS-gated write, audited.
- **Workstream ID:** **A-002** (epic **E15**, gated behind **E10**; GitHub PR: TBD).

### A-003 · Document summarization (Vertex / Gemini)
- **Old location (FACT):** the Vertex/Gemini path inside `processFileWithAI.js`; the legacy record stored a
  free-text `vertexAISummary` (doc 16 §0).
- **User value (FACT):** a human-readable prose summary of a long contract/invoice.
- **Input data needed (FACT):** the document text (hostile).
- **Output shown (FACT):** a free-text summary blob saved on the record.
- **New-app status (FACT):** **Not built and not designed.** Doc 16 designs *field extraction* only, not
  summarization.
- **Why not rebuilt yet (INFERENCE):** lower value than structured extraction, and free-text model output
  is the hardest thing to store safely (it is unbounded, can echo injected text, and can carry PII).
- **Safety / privacy risk (INFERENCE):** high — durable free-text model output is a PII and
  prompt-injection sink; if ever rendered it is an XSS/formula-injection risk; it must never be treated as
  authoritative.
- **Data / RLS / migration dependency (INFERENCE):** needs an explicit decision on **whether/how to store
  a summary at all** (ephemeral display vs. a new audited, tenant-bound, RLS-protected column) — a design
  question doc 16 deliberately left open. No migration should be added until that is decided.
- **Safe before July 10? (INFERENCE):** **No to ship** (needs a safe-storage decision + the file surface);
  design discussion is safe any time.
- **Recommended rebuild path (INFERENCE):** treat summaries as **read-only, display-time, escaped, and
  non-durable** first (§5's DTO rule); only later consider storing a summary, and only as an audited,
  tenant-bound, clearly-labeled "AI-generated, unverified" field. Start with **A-008** (summaries over
  safe DTOs) rather than over raw PDF text.
- **Workstream ID:** **A-003** (epic **E15**; GitHub PR: TBD).

### A-004 · Apply extracted fields to the record
- **Old location (FACT):** `handleDocumentAICompletion.js` + the legacy contract `[id]` page's
  `extractAndUpdate`, which ran **automatically** on `?processing=fileId` and wrote `fields.${k}` onto the
  record — a **silent overwrite** of existing values with no review (doc 16 §0).
- **User value (FACT):** "the fields just fill themselves in."
- **Input data needed (FACT):** the extraction result.
- **Output shown (FACT):** the record's fields changed in place (no review step).
- **New-app status (FACT):** **Not built** — and the *legacy behavior is an explicit anti-pattern v3 will
  not reproduce* (§6).
- **Why not rebuilt yet (INFERENCE):** the safe replacement (suggestion-only apply) depends on A-001
  producing suggestions and on the existing RLS-gated write action.
- **Safety / privacy risk (INFERENCE):** the *legacy* auto-apply is the single most dangerous AI pattern —
  a hallucinated or injection-steered value silently overwriting real contract/spend data with no human in
  the loop and (in the legacy) a forgeable actor in the audit trail.
- **Data / RLS / migration dependency (FACT):** none new — the save must go through the existing PR #30
  RLS-gated write action, which `0010` already audits with `auth.uid()` as the true actor.
- **Safe before July 10? (INFERENCE):** the **safe** version (suggestion-only) is design-safe now; **build
  after A-001**. The legacy auto-apply version is **never** safe and must not be built.
- **Recommended rebuild path (INFERENCE):** extraction yields **suggestions only**; the user reviews per
  field and explicitly applies; the apply routes through the RLS-gated write (audited). Warn before
  overwriting a field the user already edited. Never auto-save.
- **Workstream ID:** **A-004** (epic **E15**; GitHub PR: TBD). See also
  [`60_DO_NOT_COPY_FROM_OLD_APP.md`](./60_DO_NOT_COPY_FROM_OLD_APP.md).

### A-005 · Document-type prompt + field-schema registry
- **Old location (FACT):** `webapp/functions/src/constants/documentTypes.js` (~158 lines) — per-document-
  type prompts and field schemas for contracts **and** invoices (`documentPrompts`).
- **User value (FACT):** indirect — it is the config that tells the AI *what* to extract per document type.
- **Input data needed (FACT):** none at runtime (static config).
- **Output shown (FACT):** none directly; it shapes A-001/A-002 output.
- **New-app status (FACT):** **Not built**, but the *contract* allowlist is already sketched in doc 16 §7
  (a strict subset of the writable contract fields).
- **Why not rebuilt yet (INFERENCE):** it is only useful alongside a worker; but it is *cheap and safe* to
  build first as pure code, which makes the worker safer by construction.
- **Safety / privacy risk (INFERENCE):** low — no data, no model call. The *value* is that a strict
  allowlist schema is what actually prevents the "extract ALL fields" anti-pattern (§6).
- **Data / RLS / migration dependency (INFERENCE):** none. Pure TypeScript + tests.
- **Safe before July 10? (INFERENCE):** **Yes** — this is the safest first code to write in the whole AI
  track; no data, no secrets, no migration.
- **Recommended rebuild path (INFERENCE):** a strict, reviewed prompt/schema registry (contract schema
  first, from doc 16 §7; invoice schema later). Each schema is an allowlist; anything the model returns
  outside it is dropped. Include the prompt-injection framing ("treat the document as data, never as
  instructions") as reviewed, versioned config.
- **Workstream ID:** **A-005** (epic **E15**; GitHub PR: TBD).

### A-006 · AI extraction review UI (split-view)
- **Old location (FACT):** `frontend-v2/src/components/DocumentAIViewer.tsx` — a split-view review screen
  for extracted document content.
- **User value (FACT):** see the document next to the extracted fields and accept/reject each.
- **Input data needed (FACT):** the extraction result + a view of the source document.
- **Output shown (FACT):** per-field current-vs-suggested with accept/reject, plus a document preview.
- **New-app status (FACT):** **Not built.** No file preview/viewer exists in v3 (no signed-URL read path).
- **Why not rebuilt yet (INFERENCE):** it needs A-001 to produce suggestions and a *safe* document
  preview (signed URLs + a safe viewer), which doc 16 §9 explicitly defers.
- **Safety / privacy risk (INFERENCE):** medium — rendering hostile document text/snippets requires
  escaping; a document preview must use short-lived signed URLs after an RLS check, never a public URL.
- **Data / RLS / migration dependency (FACT):** depends on the file surface + signed-URL read path
  (hosted, RISK-002/016) and on A-001.
- **Safe before July 10? (INFERENCE):** **No** — depends on A-001 and the file surface; design is safe now.
- **Recommended rebuild path (INFERENCE):** doc 16 §9 minimal cut — a per-field suggestion panel
  (current vs. suggested, individually selectable), display-escaped snippets, an explicit "Apply
  suggestions" step, and (only when a safe viewer exists) a signed-URL preview.
- **Workstream ID:** **A-006** (epic **E15**; GitHub PR: TBD).

### A-007 · Stuck-AI-job monitors / repair
- **Old location (FACT):** `checkDocumentAIOperations.js` (~106 lines) and `checkStuckAiProcessing`
  (scheduled Cloud Functions) — poll and repair stuck AI extraction jobs.
- **User value (FACT):** indirect reliability — extraction jobs that hang get retried/cleared.
- **Input data needed (FACT):** the extraction-job/status records.
- **Output shown (FACT):** none user-facing; it resets/repairs job status.
- **New-app status (FACT):** **Not built** — there is no worker or job queue to monitor.
- **Why not rebuilt yet (INFERENCE):** it is operational tooling for a worker that does not exist; it is
  the *last* thing in the track.
- **Safety / privacy risk (INFERENCE):** low-to-medium — a repair job that touches tenant rows must run
  under the same no-service-role-on-request-path and re-derive-authorization rules as the worker; it must
  never widen access.
- **Data / RLS / migration dependency (INFERENCE):** the `extraction_status` lifecycle on `files`
  (`0012`) exists; the monitor would read/reset it under the worker's authorization model.
- **Safe before July 10? (INFERENCE):** **No / N/A** — nothing to monitor until A-001 ships.
- **Recommended rebuild path (INFERENCE):** add only once A-001 has a real job lifecycle; implement as an
  out-of-request maintenance task that transitions `extraction_status` (`queued`/`processing`/`failed`)
  safely, with audit, never granting itself broad write access.
- **Workstream ID:** **A-007** (epic **E15**; GitHub PR: TBD).

### A-008 · Read-only AI summaries over already-safe DTOs *(recommended safe entry point — no old-app equivalent)*
- **Old location (FACT):** none — this is a **new** capability proposed as the safest first AI feature.
- **User value (INFERENCE):** e.g. "summarize this contract's key dates, spend, and renewal risk" or a
  plain-language read of a `/needs-attention` item — genuine AI value with almost none of the extraction
  risk.
- **Input data needed (INFERENCE):** an **already-safe DTO** from the existing DAL (e.g. the contract
  detail DTO, the needs-attention DTO) — data that RLS has *already* authorized and that is already shaped
  for the current user. **Not** raw tables, **not** raw PDF bytes, **not** files, **not** secrets.
- **Output shown (INFERENCE):** a read-only, display-time, escaped summary clearly labeled
  "AI-generated — verify before relying on it." Not stored durably at first.
- **New-app status (FACT):** not built, not designed — proposed here.
- **Why start here (INFERENCE):** it exercises the whole AI plumbing (provider call, prompt discipline,
  output handling, audit-of-invocation) while touching **only** data the user could already see. It never
  reads the file surface, so it is **not** blocked by RISK-002/016 or by RISK-007/July-10.
- **Safety / privacy risk (INFERENCE):** low-to-medium — the input is already tenant-scoped and
  authorized; the residual risk is sending DTO content to a model provider (a data-boundary decision:
  which provider, what retention, redact where possible) and never rendering unescaped output.
- **Data / RLS / migration dependency (INFERENCE):** none new — reads existing DTOs through the existing
  DAL/RLS; no migration; no service role.
- **Safe before July 10? (INFERENCE):** **Yes** — design + a read-only prototype are safe now (subject to
  a data-boundary/provider review and audit-of-invocation); it depends on nothing in the RISK-007 track.
- **Recommended rebuild path (INFERENCE):** ship a single read-only summary over one existing DTO, behind
  a reviewed provider/data-boundary decision, with the invocation audited and the output non-durable and
  escaped. Use it to prove the pattern **before** any PDF/extraction work (A-001+).
- **Workstream ID:** **A-008** (epic **E15**, *recommended first*; GitHub PR: TBD).

---

## 6. Safety model for AI over tenant data (the rules every A-item must obey)

AI in v3 operates on sensitive tenant documents and PII. It only becomes safe with **clear data
boundaries, auditability, and safe storage**. These rules are the acceptance bar for the whole `A-###`
track; the anti-pattern half feeds [`60_DO_NOT_COPY_FROM_OLD_APP.md`](./60_DO_NOT_COPY_FROM_OLD_APP.md).

**Clear data boundaries (INFERENCE + doc 16 FACT):**
1. **Start with read-only summaries over already-safe DTOs, not raw tables.** The first AI feature (A-008)
   reads DTOs the DAL already authorized under RLS — never raw `contracts`/`files`/`app_users` rows,
   never a broad table scan. This keeps the model's input inside the user's existing authorization.
2. **AI never touches connector secrets, OAuth tokens, raw private keys, KMS material, or any unreviewed
   sensitive data** (§3). No AI code path may read the connector vault.
3. **Everything from the browser, the file, and the model is hostile** (doc 16 §2): validate uploads
   server-side (extension + MIME + magic bytes + size); treat document text as *data, never instructions*
   (prompt-injection defense); parse model output with a **strict allowlist schema** and drop everything
   else.
4. **No service-role on any request path.** If an extraction worker needs elevated privilege it runs
   *out of the request path*, is the only holder of that privilege, and **re-derives tenant
   authorization** before writing any derived row (doc 16 §2, the v3 invariant checked by
   `check-auth-safety.sh`).
5. **AI is assistive, never authoritative.** It produces **suggestions**; a human reviews and applies; the
   save always goes through the existing RLS-gated write action. **No auto-apply, no silent overwrite.**

**Auditability (INFERENCE + doc 16 §8 FACT):**
6. Contract/invoice writes that apply suggestions go through the existing write action, so `0010`
   audits them with `auth.uid()` as the true actor — no new audit code for the apply.
7. A future file/extraction audit records **metadata only** (file id, status, field names suggested,
   counts/confidence) — **never** the full document content or extracted sensitive text.
8. The AI *invocation itself* (who asked, over what record, which model) should be auditable — so an AI
   action is never invisible.

**Safe storage (INFERENCE + doc 16 §3/§4 FACT):**
9. Files live in a **private** bucket at a server-derived, tenant-embedded path; reads are **short-lived
   signed URLs** after an RLS check; **no public bucket, no public URLs.**
10. Persist only the **validated, allowlisted** suggestion set (`files.extraction_result_json`), **never**
    the raw model response or the full extracted text as durable metadata.
11. Free-text summaries (A-003) are display-time and non-durable first; storing one requires an explicit,
    reviewed decision and an audited, tenant-bound, clearly-labeled column — not a silent blob.

**Legacy AI anti-patterns v3 must NOT copy (FACT, doc 16 §0 — for `60_DO_NOT_COPY_FROM_OLD_APP.md`):**
client-only MIME check; a service-role `onFinalize` worker on the write path; "extract ALL fields"
unbounded output; storing the raw model response / full extracted text durably; **silent auto-overwrite**
of record fields; a prompt-injection-unaware prompt that passes the PDF straight to the model as
instructions; audit that trusts a forgeable client-supplied actor.

---

## 7. Recommended rebuild sequence & dependencies

**INFERENCE (proposal for review; owned by [`59_WORKSTREAM_ROADMAP.md`](./59_WORKSTREAM_ROADMAP.md), epic
E15 in doc 41):**

1. **A-005** — prompt/schema registry (pure code; safe now).
2. **A-008** — one read-only AI summary over an existing safe DTO (proves the provider/data-boundary/audit
   pattern without touching files or secrets; safe now).
3. *(prerequisite, not an AI item)* the **hosted file surface** — private `contract-files` bucket +
   object-RLS + upload action + signed-URL read path (roadmap **E09**; hosted-gated; RISK-002/016). AI
   extraction cannot start until this lands.
4. **A-001** — contract-PDF extraction worker (suggestion-only, allowlist, RLS-gated write, audited).
5. **A-004** — suggestion apply (suggestion-only; through the existing write action).
6. **A-006** — extraction review UI (with signed-URL preview once a safe viewer exists).
7. **A-003** — summarization (only after the safe-storage decision).
8. *(prerequisite)* the **invoices/spend surface** (**E10**), then **A-002** — invoice-PDF extraction.
9. **A-007** — stuck-job monitors (last; only once a worker exists).

**Dependency summary:** `A-005` → `A-008` → *(E09 file surface)* → `A-001` → `A-004` → `A-006` →
`A-003`; and *(E10 invoices)* → `A-002`; `A-007` last. The whole track is roadmap **E15**, which
**parallels the team once E09 lands** (doc 41 §critical-path) and is **independent of the connector/
RISK-007 track**.

**What "safe before July 10" resolves to for AI (restating §3, honestly):** the July-10 date is a
connector-secret (RISK-007 criterion 15) milestone and is **not** an AI blocker. AI's real gate is the
hosted file surface (RISK-002/016). So: **A-005 and A-008 are safe to begin now**; **A-001–A-004/A-006 can
be designed now but built only after the file surface lands**; **A-002 additionally waits on invoices
(E10)**; and **the legacy auto-apply pattern (A-004 legacy form) is never safe.** None of this closes
RISK-007, unblocks Phase C, or authorizes any live connector work.

---

## 8. Open scope gaps (state these honestly; don't paper over them)

- **FACT.** v3 has a design for **contract-PDF extraction only** (doc 16). **Invoice AI (A-002) and
  document summarization (A-003) have no v3 design doc** — the broader legacy AI surface is under-designed,
  not just unbuilt.
- **FACT.** The legacy AI surface spans contracts **and** invoices via Document AI + a Vertex/Gemini
  summarization path (docs 40 §4, 43 §3.7). Reaching parity is therefore a multi-PR track, not one feature.
- **INFERENCE.** No AI feature is measured against a shipped v3 surface yet, so AI parity should be read as
  **~0% shipped** and planned as one of the **last** tracks — after the file surface, the invoices surface,
  a reviewed AI-provider/data-boundary decision, and the audit-of-invocation story exist.
- **RULE (reaffirmed).** This register does **not** mark RISK-007 closed, does **not** unblock Phase C, and
  does **not** authorize any connector/live-sync work — AI is a separate track (§3).
