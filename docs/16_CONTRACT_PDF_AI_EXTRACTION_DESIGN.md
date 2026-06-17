# 16 · Contract PDF Upload + AI Extraction — Design & Security Plan

**Canonical source for: how secure contract PDF upload + AI extraction *will* work — before any of
it is built.** This is a **DESIGN-ONLY** doc (PR #33). **Nothing here is implemented:** no upload, no
storage bucket, no `files`/extraction migration, no RLS policy, no AI/OCR call, no Edge/Cloud Function,
no file UI. It defines the workflow, the trust boundaries, the future schema/RLS, and the
not-to-be-ported legacy anti-patterns so a later implementation PR starts from a safe plan.

Related: contract write design ([13](./13_CONTRACT_STEWARD_WRITE_DESIGN.md)), legacy contract-form
inspection ([15](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)), security/RLS model ([02](./02_SECURITY_AND_RLS.md)),
risks ([04](./04_RISK_REGISTER.md) — **RISK-002 files/invoices default-deny: OPEN**, RISK-016: OPEN).
**OMC/Flywheel cutover + new paid-customer onboarding remain BLOCKED. No hosted apply.**

> **Status (do not overclaim):** PDF upload / AI extraction is **DESIGNED, NOT BUILT.** `files`,
> Storage, and AI integration are **not surfaced**. **`0012` (PR #34) added the `files` metadata columns
> (§4) — schema foundation only; the table is still default-deny / not surfaced.** The remaining steps
> each need their own PR(s) with tests: RLS policies, a Storage bucket, server-side validation, an
> extraction worker, the UI, and a security review. This doc unblocks *planning* + the schema; not shipping.

---

## 0. Legacy inspection (evidence — read before designing; not ported)
Legacy sources read (read-only, outside this repo, **not** ported):
`frontend-v2/src/app/(authenticated)/contracts/create/page.tsx` (Upload-PDF tab),
`…/contracts/[id]/page.tsx` (`extractAndUpdate`, processing monitor),
`frontend-v2/src/utils/downloadFile.ts` (upload metadata),
`webapp/functions/src/storage/processFileWithAI.js` (the AI Cloud Function),
`…/storage/handleDocumentAICompletion.js`, `…/storage/onDeleteStorageFile.js`,
`…/constants/documentTypes.js` (`documentPrompts`), `…/logging/fileOnWrite.js` (file audit).

| Legacy behavior | What it does | v3 verdict |
|---|---|---|
| **Upload surface** | `contracts/create` "Upload PDF" tab (default) + an "Upload File" control on the detail page; drag-drop or click | Re-surface as an *assistive* panel; do **not** make upload the default/primary create path |
| **Type validation** | **Client-only** `file.type === 'application/pdf'` (browser, trivially spoofable). No server MIME / magic-byte / size check | **Anti-pattern.** v3 must validate server-side: extension + MIME + magic bytes + size cap |
| **Malware scan** | None — Storage accepts the file and AI runs immediately | **Anti-pattern.** v3 must gate extraction behind a `scan_status` |
| **Storage** | Firebase Storage path `files/{fileId}` (single-tenant, **no tenant_id in path**); fileId is a Firestore auto-id; reads via long-lived `getDownloadURL()` tokenized URLs (effectively public-with-token) | **Anti-pattern.** v3 path must embed `tenant_id` + server-issued `file_id`; reads via **short-lived signed URLs** after an RLS check; no public bucket |
| **Extraction trigger** | Storage `onFinalize` **Cloud Function with admin/service-role** runs Document AI (batch) + Vertex/Gemini (immediate) on every upload | **Anti-pattern to copy blindly.** Any async worker must **re-derive tenant authorization** before writing a derived result; never a service-role *app request* path |
| **Prompt** | `documentPrompts.contract` asks Gemini to summarize → JSON; the **PDF is passed straight to the model as content** with no "treat the document as data / ignore embedded instructions" guard | **Anti-pattern.** PDF text is **hostile/untrusted**; v3 prompt must treat it as data and defend against prompt injection |
| **AI output handling** | Vertex result stored as `{ ...parsedResponse }` — **"extract ALL fields, not just predefined ones"** (unbounded) + raw `vertexAISummary` + `documentAIEntities` saved on the file doc | **Anti-pattern.** v3 must parse AI output with a **strict allowlist schema** (the PR #30 write parser fields only); drop everything else; do not store the raw response/extracted text as durable metadata |
| **Apply to contract** | The `[id]` page `extractAndUpdate` runs **automatically** on `?processing=fileId` and writes `fields.${k}` to the contract doc — **silent overwrite** of existing values, no review/apply | **Anti-pattern.** v3: extraction yields **suggestions only**; the user explicitly reviews + applies; the save goes through the existing **PR #30 RLS-gated write action** |
| **Audit** | App-layer Firestore `fileOnWrite` / `contractOnWrite` triggers read the actor from forgeable doc metadata (`uploadedBy`); log create/update/**delete** | **Anti-pattern.** v3 audit is DB-side `SECURITY DEFINER` with `auth.uid()` ([0010](../supabase/migrations/0010_contracts_audit_on_write.sql)); never trust client-supplied actor |

**Net:** v3 keeps the legacy *workflow* (upload a PDF → AI suggests fields → user reviews → save) but
replaces the *implementation*: server-side validation, tenant-bound storage, signed URLs, strict-schema
AI parsing, suggestion-not-autosave, RLS-gated writes, DB-side audit.

---

## 1. Product scope
- A user uploads a contract **PDF** from the contract **create/edit** flow.
- AI extracts **suggested** contract field values from the PDF.
- The user **reviews** the suggestions and chooses what to apply.
- **AI never writes to `contracts` directly.** The save always goes through the existing PR #30
  RLS-gated write action (`createContractAction` / `updateContractAction`).
- **No automatic / destructive update.** Extraction never overwrites a user-entered or existing field
  without an explicit user "apply".
- **Extraction is assistive, not authoritative** — a convenience to pre-fill the form, nothing more.

## 2. Trust boundaries (everything from the browser/file/model is hostile)
- The **browser is untrusted** — never trust a client-sent `tenant_id`, `contract_id`, `file_id`,
  `storage_path`, `content_type`, `byte_size`, or `uploaded_by`. Resolve/verify all server-side.
- The **uploaded file is hostile** — its bytes, **filename**, **extension**, and **declared MIME** are
  attacker-controlled. Validate server-side (extension allowlist + MIME + **magic bytes** + size cap),
  store the filename as inert metadata only, and never use it to build a storage path or a shell/SQL string.
- The **extracted text is hostile** — a PDF can contain text crafted to attack downstream consumers
  (prompt injection, XSS if ever rendered, formula injection if ever exported). Treat as data; escape on display.
- The **AI output is untrusted** — it must be parsed with a **strict allowlist schema** and then run
  through the **same PR #30 write parser** (`parseContractWriteInput`) before anything reaches the DB.
  The model can hallucinate, return extra/forbidden keys, or be steered by injected instructions.
- **Storage object paths must not be caller-authoritative** — the server derives the path from the
  resolved `tenant_id` + a server-issued `file_id`; the client never names the object.
- **Tenant / org / contract IDs are server-resolved or RLS-checked** — `tenant_id` comes from the
  resolved context (as in PR #30); a `contract_id` link is accepted only if RLS proves the caller may
  read+write that contract.
- **Service-role isolation** — if an *async background worker* ever needs elevated privilege (e.g. to
  read the object and write an extraction result), it must run **out of the request path**, be the only
  thing holding that privilege, and **re-derive tenant authorization** (look up the file's `tenant_id`
  and validate it) before writing any derived row. **No service-role on a normal user request route**,
  ever (this is the v3 invariant — `check-auth-safety.sh`).

## 3. Storage model (design options — none created here)
- **Bucket:** a single **private** Supabase Storage bucket for contract documents (e.g. `contracts`).
  **No public bucket, no public URLs.** Reads are via **short-lived signed URLs** issued only after an
  RLS authorization check; writes via signed upload URLs or a server-mediated upload, never a public PUT.
- **Source of truth = the DB `files` row**, not the Storage object. The object is opaque bytes; all
  authorization, status, and metadata live in Postgres under RLS.
- **Object path pattern (server-derived, not user-controlled):**
  `contracts/{tenant_id}/{file_id}.pdf` — `tenant_id` from resolved context, `file_id` a server-issued
  UUID. The original filename is **never** in the path (stored as `original_filename` metadata only).
  A Storage RLS policy / path convention then scopes objects to their tenant prefix as defense-in-depth.
- **Validation before the bytes are trusted:** extension allowlist (`.pdf` only at first), declared
  **MIME** (`application/pdf`), and **magic bytes** (`%PDF-` header) — all checked server-side; a
  **max size** cap (e.g. 25 MB, TBD). Reject anything else.
- **Scan gate:** a `scan_status` (`pending` → `passed` / `failed` / `skipped`; column live in `0012`).
  **Extraction must not run until `scan_status = passed`.** The actual scanner (ClamAV/queued service)
  is out of scope here — the *status field + gate* is the design contract.
- **No public preview** until signed-URL auth + a safe viewer are designed (§9).

## 4. Database model (metadata columns ADDED in `0012` / PR #34; table still NOT surfaced)
**Current `files` table (`0001`, RLS-enabled but DEFAULT-DENY — RISK-002):**
`id uuid pk`, `tenant_id uuid not null → tenants`, `storage_path text not null`,
`original_filename text not null`, `file_type text`, `document_type text`,
`uploaded_by uuid → profiles`, `processing_status text not null default 'pending'`, `created_at`.

**What's already enough:** tenant binding (`tenant_id` + cascade), `storage_path`, `original_filename`,
`document_type` (can hold `'contract'`), `uploaded_by`, a coarse `processing_status`, `created_at`.

**Metadata columns — ADDED in `0012` (PR #34), additive + nullable/defaulted, table NOT surfaced:**
| Column | Why |
|---|---|
| `contract_id uuid null` — **composite same-tenant FK** `(contract_id, tenant_id) → contracts(id, tenant_id)` (the `0005` pattern, reusing `contracts_id_tenant_key`) | link a file to its contract, tenant-bound at the DB (a tenant-B file can never attach to a tenant-A contract). A `contract_files` link table remains the alternative if many-to-many is ever needed |
| `storage_bucket text null` | which bucket (future-proofing multiple buckets) |
| `content_type text null` | server-validated MIME (distinct from legacy free-text `file_type`) |
| `byte_size bigint null` (`check is null or ≥ 0`) | enforce/record the size cap |
| `sha256 text null` (`check is null or ~ '^[a-f0-9]{64}$'`) | integrity + dedupe + tamper detection |
| `upload_status text not null default 'pending'` (`pending`/`uploaded`/`failed`) | upload lifecycle distinct from AI |
| `scan_status text not null default 'pending'` (`pending`/`passed`/`failed`/`skipped`) | malware gate (§3) |
| `extraction_status text not null default 'not_started'` (`not_started`/`queued`/`processing`/`completed`/`failed`) | extraction lifecycle |
| `extraction_result_json jsonb null` | the **validated, allowlisted** suggestions (NOT raw model output; NOT full PDF text) |
| `extraction_error text null` | a safe error label (no sensitive content) |
| `updated_at timestamptz not null default now()` | last-modified; default-only (no moddatetime trigger — schema convention), bumped by the writer |

**Not added (deliberate):** `file_kind` — the existing `document_type` column already distinguishes
contract docs (`'contract'`); no need for a second discriminator yet.

**Constraints (live in `0012`):** every column **tenant-bound**; the `contract_id` link is a composite
same-tenant FK (no cross-tenant linkage); status columns use the `check` constraints above; **no hard
delete / no RLS policy** added — `files` stays default-deny / not surfaced. `extraction_result_json` (by
*future* design) must hold only the allowlisted field set (§7), never the raw response — `0012` only
defines the column; the worker that fills it is future work.

## 5. RLS design (future policies — NOT implemented here; default-deny stays until tested)
`files` stays **default-deny** until a future PR adds *tested* policies. Designed shape:
- **READ:** a tenant member may read `files` for their tenant (`is_tenant_member(tenant_id)`).
  *Org-scoped* read of a contract-attached file (an org-only user reading a file iff they can read the
  linked contract) is a **later, separate** broadening — start **tenant-member-only** to keep the blast
  radius small (mirrors how `app_contracts`/`app_users` were tenant-only before `0006`/`0007`).
- **WRITE (insert/update):** limited to the **same contract write authority** (`0004`):
  - tenant **owner/admin/editor** (`has_tenant_role(tenant_id, ['owner','admin','editor'])`), **OR**
  - **procurement-org manager** of the linked contract's `procurement_org_id`
    (`has_org_role_in_tenant(procurement_org_id, tenant_id, ['manager'])`).
  - **`paying_org_id` must NOT grant file write** (read ≠ write; mirrors the contract rule, [13 §3](./13_CONTRACT_STEWARD_WRITE_DESIGN.md)).
- **File read and file write may differ** (read can be broader than write later); both **default-deny**
  until each is tested. **No `FOR ALL`. No normal `authenticated` DELETE.**
- A **same-tenant integrity** guard (the `0005` composite-FK pattern) so a file can never reference a
  cross-tenant contract.
- **Future RLS tests required (before any file surface ships):**
  - tenant **editor** upload **allowed**; **procurement-org manager** upload **allowed**;
  - **paying-org** reader **denied** upload; **unrelated org** member **denied** read *and* write;
  - **cross-tenant** contract↔file linkage **rejected** (FK + policy);
  - **non-member** sees nothing; **no DELETE** policy; **no `FOR ALL`**;
  - (and, once org-scoped read is added) an org reader sees a file **iff** they can read the linked contract.

## 6. Upload flow design (suggestion-first, save-through-RLS)
**Create manually or upload first?** — Recommended: the contract create/edit form stays primary;
upload is an **optional assistive panel** ("Upload a PDF to pre-fill fields"). The user can always
create/edit a contract with no file.

Safe flow:
1. From `/contracts/new` or `/contracts/[id]/edit`, the user opens the **"Upload PDF for extraction"** panel.
2. Upload creates a `files` metadata row in `upload_status='pending'` / `scan_status='pending'` (server-issued `file_id`, tenant-bound).
3. The object is stored at the server-derived tenant path; the server validates extension + MIME + magic bytes + size.
4. **Extraction runs only after `scan_status='passed'`** (and validation passed).
5. The extraction worker returns **structured suggestions** (validated, allowlisted — §7); they are shown to the user.
6. The user **explicitly applies** chosen suggestions to the form (never silent; never overwrites a field the user already filled without confirmation).
7. The user **saves through the existing PR #30 write action** — RLS authorizes, `0010` audits.

**Hard "nots":** no AI auto-save; no AI direct `contracts` update; no silent overwrite of user-entered
fields; the file upload does not itself create/finalize a contract.

## 7. AI extraction design (strict schema; PDF + model output are hostile)
- Extraction returns **structured suggestions only** — never a write.
- **Allowlist schema (a safe SUBSET of the PR #30 writable contract fields — nothing else accepted):**
  `contractName`, `vendorName`, `status`, `category`, `totalCost`, `currency`, `startDate`, `endDate`,
  `renewalDate`, `procurementDate`, `poNumber`, `autoRenew`, `monthToMonth`, `notes`. Any other key the
  model returns is **dropped** (no "extract all fields" — the legacy anti-pattern). This is a deliberate
  **subset**, not all of `ContractWriteInput`: the AI is intentionally **NOT** allowed to suggest the
  relationship/config columns `procurementOrgId` / `payingOrgId` (the org IDs that govern *write
  authority* under `0004` — those are a human/RLS decision, never a model output), nor
  `renewalResponsibility` / `noticeDeadline` / `billingFrequency` (left to the user for now). Document-level
  fields a contract PDF describes are extractable; authority-bearing references are not.
- After the allowlist filter, suggestions are run through **`parseContractWriteInput`** (the same PR #30
  validator the form uses) before anything is offered as a save. To be precise about what that validator
  does vs. what the review UI does:
  - **Parser (`parseContractWriteInput`) enforces:** empty→null for nullable fields; **dates must be
    `YYYY-MM-DD`** and **`total_cost` must be a finite, in-range number** — an invalid date/cost is a
    **hard reject** of the whole input (`{ ok:false, issues }`), not a silent coercion; booleans are
    strict; `status` / `currency` / `category` are accepted **as-is with no value-validation** (free text).
  - **Review UI adds (a separate design item, not parser behavior):** per-field accept/reject, and
    surfacing a suspicious value (e.g. a `status` outside the legacy set, an unparseable date the model
    guessed) **for user review** rather than applying it blindly. The parser is the *hard* gate; the
    review panel is the *soft* gate — neither silently writes a bad value.
- **Confidence / source snippet** attached per field where available (e.g. Document AI entity confidence
  + the page/text span) so the user can judge each suggestion. Snippets are display-escaped (hostile text).
- **Prompt-injection defense (the PDF text is hostile):**
  - The model prompt treats the **document as data, not instructions** — an explicit system instruction
    that any "ignore previous instructions / change the rules" text inside the PDF is **content to
    extract from, never a command to obey**.
  - The model is asked to return **only** the allowlisted JSON shape; output is parsed with a strict
    schema and the allowlist filter — so even a fully-compromised model response cannot introduce a
    forbidden field, a `tenant_id`, or a write.
  - The **security boundary is the parser + RLS, not the prompt** — the prompt reduces noise; the
    allowlist + `parseContractWriteInput` + the RLS-gated write are what actually keep the system safe.
- **Provider note:** when implemented, prefer the latest Claude models via the Vercel AI Gateway with a
  strict structured-output schema; the provider choice does not change the trust model — output stays
  untrusted and allowlist-validated regardless of model.

## 8. Audit design (extend the DB-side model; never an app service-role route)
- `0010` already audits **accepted `contracts` row writes** (`contract.created`/`contract.updated`,
  actor = `auth.uid()`). Applying suggestions saves through the PR #30 action, so **that write is
  already audited** with no new code — no separate "suggestions applied" contract-audit row is needed
  beyond the normal `contract.updated`.
- A **future file/extraction audit** (separate design, DB-side) would record lifecycle events:
  `file.uploaded`, `file.scan_passed` / `file.scan_failed`, `extraction.started`,
  `extraction.completed` / `extraction.failed`, and (optionally) `extraction.suggestions_applied`.
- **Rules:** do **not** manually insert contract `audit_logs` rows from an app route; do **not** use a
  service-role route for normal user writes; the audit writer stays a DB-side `SECURITY DEFINER` trigger
  (the `0010` pattern). The **extraction-result audit records metadata only** — file id, status, field
  names suggested, counts/confidence — **never** the full PDF content or extracted sensitive text.

## 9. UI design (minimal first cut)
- An **"Upload PDF" panel** on `/contracts/new` and `/contracts/[id]/edit` (the existing PR #31 form).
- Visible **status states:** `not uploaded` → `uploading` → `scanning` → `extracting` →
  `suggestions ready` → `failed` (each maps to the `upload_status`/`scan_status`/`extraction_status` fields).
- A **suggestion review panel** — per-field suggested value + confidence/snippet, each individually
  selectable; the user sees current vs suggested and chooses.
- An **"Apply suggestions"** button (fills the form fields; never auto-saves; warns before overwriting a
  field the user already edited).
- **"Save contract"** continues to use the normal PR #30 contract form action (unchanged).
- **No** file library, **no** bulk upload, **no** drag-and-drop unless trivially simple and safe; **no**
  public preview URL until signed-URL auth + a safe viewer are designed.

## 10. Explicitly out of scope (this PR and the first implementation)
- **No PDF/AI implementation in this PR** (design only).
- No Storage bucket; no OCR; no malware scanner; no file preview/viewer.
- No app-contract **link/unlink**; no **invoice** upload; no renewal **gantt**; no **archive/delete**.
- No service-role app route; no RLS policy change; no migration; **no hosted apply.**
- **Next steps (each its own PR, with tests):** ~~(a) forward migration for the `files` columns (§4) +
  `gen-types`~~ — **DONE (`0012` / PR #34)**; (b) RLS policies + the §5 tests (default-deny until green)
  ← **next**; (c) private Storage bucket + server-side validation; (d) the extraction worker
  (out-of-request, tenant-re-deriving) + strict-schema parsing; (e) the minimal UI (§9); (f)
  file/extraction audit. **RISK-002 + RISK-016 stay OPEN; OMC/Flywheel cutover + new paid-customer
  onboarding stay BLOCKED** until the file surface is built, tested, and reviewed. `0012` adds metadata
  columns ONLY — `files` is still **not surfaced** (no upload/Storage/AI/UI/signed-URL/RLS).
