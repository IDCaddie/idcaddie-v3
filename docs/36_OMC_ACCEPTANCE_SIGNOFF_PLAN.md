# 36 · OMC Acceptance & Signoff Plan

**Canonical plan for doc 17 blocker-sequence item #6** ([30](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md), the final
item): how OMC formally **accepts or rejects** v3 cutover readiness — satisfying
[17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) box **17** ("OMC acceptance signoff recorded").
**Planning only — this records no acceptance, runs no test, and approves nothing.**

> ## ⚠️ STATUS BANNER (do not remove)
> - **OMC acceptance/signoff plan is prepared, not executed.** **No OMC acceptance or signoff is recorded by
>   this PR.**
> - **No production project was touched. No staging data was mutated by this PR.** **No real OMC customer data
>   is included.** **No secrets, passwords, anon keys, cookies, or JWTs are recorded.**
> - **No doc 17 §5 box is ticked here.** **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not
>   automatically production-ready. Storage completion is necessary but not sufficient for cutover.**
> - **Signoff is the LAST gate, not a shortcut.** It is recordable only **after** every other doc 17 §5 box is
>   true; it does not substitute for the other 16 boxes. An agent never records a signoff.

---

## 1. What OMC acceptance/signoff means (Task 1)

**OMC acceptance = the paying customer/owner formally accepts that v3 is a complete production replacement** —
either **full legacy parity** ([27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md)) or parity with **explicitly-approved
removals/deprecations** (§6) — backed by a **complete evidence package** (§4), **before** any cutover. It is the
**final** doc 17 §5 box (17). It is **not** a developer/engineering signoff and **not** a substitute for the
other 16 boxes; it is the customer's go decision on top of a satisfied gate. Acceptance is **recorded, dated,
and attributable** (§7).

---

## 2. Signoff domains (Task 2)

Each domain is accepted against its **evidence doc**; all must be accepted (or its gaps `removed-approved`/
`deprecated-approved` — §6) before the final approval:

| Domain | Accepted against |
|---|---|
| **Workflow parity** | [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) (every required row `complete`/`deprecated-approved`) + [33](./33_REQUIRED_WORKFLOW_PARITY_BUILD_PLAN.md) |
| **Data migration / reconciliation** | [34](./34_OMC_LEGACY_DATA_MIGRATION_PLAN.md) (green dry-run + staging reconciliation; production-window plan) |
| **Auth / session / tenant context** | [31](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md) (hosted verification green) |
| **Security / RLS / privacy** | hosted RLS suite + isolation evidence; no service-role on request paths (`check-auth-safety.sh`); RISK-002/007/013 disposition |
| **File / Storage** | the Storage REST evidence ([25](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md)/[29](./29_PRODUCTION_STORAGE_APPLY_EVIDENCE.md)) **+ the built+verified upload/read surface** (doc 33 T3 — not yet built) |
| **Rollback rehearsal** | [35](./35_CUTOVER_ROLLBACK_REHEARSAL_PLAN.md) (green staging rehearsal + restore/PITR proven) |
| **Operational monitoring / support** | post-cutover monitoring + incident response + support model (doc 17 §3 — **not built**) |
| **Final executive / customer approval** | the customer's recorded go decision (§5/§7), on top of all the above |

---

## 3. Who must sign off — by ROLE (Task 3)

Roles already used across the cutover docs (no invented individuals):

| Role | Accepts |
|---|---|
| **Cutover commander** | the overall go/no-go + that every doc 17 §5 box is true |
| **DBA** | data migration + reconciliation + DB restore/PITR (docs 34/35) |
| **Platform / Vercel owner** | deploy/rollback path, env wiring, DNS readiness (docs 24/35) |
| **Security owner** | RLS/tenant-isolation/privacy + no-service-role-on-request-path (**holds a veto**) |
| **OMC owner (customer)** | workflow parity acceptance + approved removals + the final customer go |
| **Executive approver** | the final business approval to cut over a paying customer |

Engineering prepares evidence; **engineering does not self-accept** customer readiness. **No agent is a signer.**

---

## 4. Required evidence package before signoff (Task 4)

Signoff is recordable **only** when this package is complete (names + pass/fail + dates; **no secrets, no real
data in the repo**):

1. **doc 17 §5 checklist** — all 17 boxes true (with each box's evidence linked).
2. **doc 27 parity matrix** — every **required** row `complete` or `deprecated-approved` (no `partial`/`missing`/
   `blocked`/`unknown` required row remains).
3. **Hosted staging Auth verification** — item-#1 ([31](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)) green + manual UI steps.
4. **OMC-shaped dataset validation** — item-#2 ([32](./32_STAGING_OMC_SHAPED_DATASET_AND_CRITICAL_FLOW_VALIDATION.md)) critical-flow validation green.
5. **Migration dry-run / reconciliation** — item-#4 ([34](./34_OMC_LEGACY_DATA_MIGRATION_PLAN.md)) green staging reconciliation (counts/integrity/file byte+`sha256`/relationships/RLS/audit).
6. **Rollback rehearsal** — item-#5 ([35](./35_CUTOVER_ROLLBACK_REHEARSAL_PLAN.md)) green staging rehearsal + restore proven.
7. **Security / RLS evidence** — hosted RLS suite re-run + isolation spot checks + `check-auth-safety.sh` green + risk dispositions.
8. **Production-readiness evidence** — production apply + REST verification ([29](./29_PRODUCTION_STORAGE_APPLY_EVIDENCE.md)) **for shipped surfaces**, monitoring/support in place, and the freeze/cutover window plan.

A missing or red item = **not eligible for signoff** (§8).

---

## 5. Acceptance outcomes (Task 5)

| Outcome | Meaning |
|---|---|
| **Accept** | Full readiness; every box true; every required parity row `complete`; cutover may be scheduled. |
| **Accept with explicitly-approved removals/deprecations** | Readiness **conditioned** on specific rows recorded as `removed-approved`/`deprecated-approved`/`not-used-by-OMC` (§6) — each with rationale + OMC approval. **Never** an implicit acceptance of "not built". |
| **Reject** | Not ready; named blockers must be resolved; no cutover. |
| **Defer pending blockers** | Decision paused until specific blockers (with owners + target evidence) are closed; re-review required. |

Default when the package is incomplete is **defer/reject**, never accept.

---

## 6. Recording approved removals/deprecations (Task 6)

So **"not built" never silently becomes accepted**:
- A dropped/deferred legacy capability is acceptable **only** if recorded in [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md)
  as **`removed-approved`** / **`deprecated-approved`** / **`not-used-by-OMC`** / **`better-approved`** (the
  existing [17 §6](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) taxonomy) — **with the OMC owner's explicit
  approval + a recorded rationale + reviewer initials**.
- A `partial`/`missing`/`blocked`/`unknown` **required** row is **never** auto-accepted — it must either become
  `complete` or be explicitly reclassified by OMC. "Better than legacy" alone does not waive a required behavior.
- The signoff record (§7) must **list every approved removal/deprecation** it relies on; an acceptance that
  rests on an unrecorded gap is invalid.

---

## 7. Signoff evidence format + storage (Task 7)

When the package is complete + accepted, a human records the signoff (this PR records **none**):
- **Location:** a dated doc under `docs/evidence/` (e.g. `docs/evidence/omc-signoff-<date>.md`), or a
  [23](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md)-style record — **in-repo, no secrets, no real customer
  data** (use references/links to the evidence, not pasted data).
- **Contents:** date · the §3 signers (role + name/initials) · the outcome (§5) · links to each §4 evidence
  item · the list of approved removals/deprecations (§6) · the residual-risk statement · the explicit "cutover
  approved/not-approved" line.
- **Attributable + immutable-by-convention:** recorded once, not edited after signoff (corrections add a new
  dated record). No secrets/tokens/passwords/JWTs ever pasted.

---

## 8. Hard rules (Task 8)

Signoff is **invalid** if any holds:
- **No signoff based on local-only tests** — the local `test-rls.sh` (222) + unit tests are necessary but **not**
  acceptance; hosted validation is required.
- **No signoff without hosted staging validation** — items #1/#2 ([31](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)/[32](./32_STAGING_OMC_SHAPED_DATASET_AND_CRITICAL_FLOW_VALIDATION.md)) executed green + recorded.
- **No signoff without migration rehearsal** — item #4 ([34](./34_OMC_LEGACY_DATA_MIGRATION_PLAN.md)) dry-run + staging reconciliation green.
- **No signoff without rollback rehearsal** — item #5 ([35](./35_CUTOVER_ROLLBACK_REHEARSAL_PLAN.md)) green staging rehearsal + restore proven.
- **No signoff without P0-blocker disposition** — every P0 ([33](./33_REQUIRED_WORKFLOW_PARITY_BUILD_PLAN.md)) is `complete` or explicitly `removed-approved`/`deprecated-approved`; **no undispositioned P0 remains**.

Any one of these failing = **no signoff**; the gate stays a NO.

---

## 9. Risk posture

**RISK-001 remains OPEN** — an acceptance *plan*, not an acceptance. **No OMC acceptance or signoff is recorded
by this PR.** Several evidence inputs do not yet exist (hosted runs not executed; upload surface, monitoring,
and most required workflows not built — docs 31/32/33/34/35). **Cutover remains BLOCKED. Upload is not
automatically production-ready. Storage completion is necessary but not sufficient for cutover.** RISK-002/007/
013/015/016 remain open. No production/staging mutation, no hosted command, no real OMC data, no secrets in
this PR. OMC/Flywheel is a paying production **replacement, not a pilot**.
