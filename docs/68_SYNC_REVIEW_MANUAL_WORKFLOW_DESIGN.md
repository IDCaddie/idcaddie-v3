# 68 — Sync Review: manual review workflow — design proposal

> **CURRENT CURSOR (2026-07-10):** `idcaddie-v3` main @ `1f91f69` (PRs through **#297**); `idcaddie-connector-runner`
> main @ `0d7dcfa`. Governance (current): **RISK-007 is CLOSED at its staging-defined criteria; Phase C is UNBLOCKED as
> a governance state only.** The C-2c staging sync ran on **staging only** (connector-runner PR #36) → `discovery_facts`
> `app_user_account=3`, `review_status=pending`. The count-only Sync Review card shipped (#297). **Production untouched.**
>
> **THIS IS A DESIGN PROPOSAL ONLY.** No code, schema, migration, mutation, or UI is created here; no query was run; the
> `/connectors` leak-scan is unchanged. It proposes the *manual review workflow* for pending discovery items and asks for
> the explicit approvals in §11 before any implementation. Not a production-readiness claim; staging-safe.

---

## 0. Grounding (verified from the repo, read-only)

- **`discovery_facts` (0025)** already has the review columns — `review_status` (`pending`/`confirmed`/`rejected`/`auto`/
  `needs_review`), `reviewed_by` (FK `profiles`), `reviewed_at`, `rejected_reason` — and RLS **`editors update
  discovery_facts`** (`has_tenant_role owner/admin/editor`), **members read**, **editors insert**, and **NO DELETE**
  (durable tombstone pattern). So a **review-status change needs no migration and no new column.**
- **Promotion target `app_users`** has an **org-scoped READ** policy (0007) but **no editor INSERT/UPDATE policy** for a
  reviewer-driven write (0027 covers `app_user_identity_matches`, not `app_users`). App-user rows are written by
  core/runner paths, and the deterministic **resolver pipeline already exists** (`src/lib/server/connector-vault/
  resolver-write.ts`, docs/42 §69: reads staged facts, auto-writes only a *deterministic* resolution, else marks
  "review"). **So promotion by a reviewer needs a validated write path → a migration.**
- **Audit** infra exists: `audit_logs` (0001), append-only lifecycle events, `src/lib/data/audit.ts`, and connector-vault
  audit writers.

---

## 1. What the reviewer needs to do with pending discovery items

A sync produces `discovery_facts` at `review_status='pending'` (or `needs_review`). The reviewer's job:

- **Triage the pending queue** for their tenant: decide each pending item (or a group of them) is either a **real
  managed record to keep** (→ confirm) or **noise / wrong / out-of-scope** (→ reject, with a reason).
- **Confirm** = accept the fact as reviewed; it becomes eligible to create/update a managed record (via the validated
  promotion path — §5; gated).
- **Reject** = mark the fact `rejected` + a `rejected_reason` (durable tombstone — never deleted, never promoted).
- **Never delete**, never edit the observed fact body, never bulk-approve blindly.

Design stance: the **first** manual slice is **triage of the review *status*** (confirm/reject), **decoupled from
promotion**. Promotion (turning confirmed facts into `app_users`/people) is a separate, migration-gated step.

---

## 2. Should the next UI show row-level discovery item details? — **Not in the first slice**

**Recommendation:** the first manual-review slice stays **body-free** — the reviewer acts on **counts grouped by
`source_run_id` + `fact_type` + `review_status`** (e.g. "3 pending `app_user_account` from the last Slack run →
Confirm all / Reject all"), with **no per-item row body**. This lets a human triage *volume, type, and provenance*
(is this run/type expected?) without exposing any personal data — and needs no new sanitized-field decision.

Per-item review (a later, separately-approved slice) would require a **minimal sanitized projection**. Exactly which
fields are allowed vs forbidden:

| Field | First slice | Per-item slice (later, gated) | Rationale |
|---|---|---|---|
| `fact_type` (enum) | ✅ allowed | ✅ | non-PII category |
| `review_status` (enum) | ✅ | ✅ | non-PII state |
| `source_provider` (label, e.g. "slack") | ✅ | ✅ | non-secret provider label |
| `source_run_id` (uuid) | ✅ (group key) | ✅ | opaque run id, not PII |
| `observed_at` / `created_at` | ✅ | ✅ | timestamps |
| `confidence` (0..1) | ✅ | ✅ | non-PII score |
| **counts** (per status/type) | ✅ | ✅ | aggregates only |
| `reviewed_by` / `reviewed_at` | via audit only | ✅ (as name/boolean, not raw id) | audit metadata |
| `fact_json` (body) | ❌ **forbidden** | ❌ **forbidden** | the raw normalized payload — emails/names/ids |
| `natural_key` | ❌ | ❌ **forbidden by default** | often an email / external id |
| `signal_id` / `source_record_id` | ❌ | ❌ | source-side identifiers |
| `provenance_json` | ❌ | ❌ | provenance blob — no per-item exposure |
| any email / display name / person id | ❌ | ❌ **unless a later privacy decision** | PII |

If a per-item slice genuinely needs a human-recognizable label, it must **derive a non-reversible, sanitized token**
(e.g. domain-only `@acme.com`, or a short opaque code) — **argued and approved separately** (§11). **No `fact_json`,
`natural_key`, or PII is surfaced by default**; the hard boundary holds.

---

## 3. How confirm / reject should work

- **Where:** server-only **Server Actions** (or route handlers) — never client-side DB writes; the write runs under the
  **user's RLS session** (anon key), authorized by the existing **`editors update discovery_facts`** policy
  (`owner/admin/editor`). No service-role, no `connector_runner` role, no caller-supplied `tenant_id`.
- **Confirm:** `review_status` `pending`→`confirmed`, set `reviewed_by = auth.uid()`, `reviewed_at = now()`. Confirming
  does **not** itself promote (that is §5, gated) — it only records the human decision.
- **Reject:** `review_status`→`rejected`, set `rejected_reason` (from a **fixed enum of reasons**, not free text with
  PII), `reviewed_by`/`reviewed_at`. **Tombstone — the row is never deleted** (0025 has no DELETE policy; keep it that way).
- **Scope of a first-slice action:** by `source_run_id` + `fact_type` (+ current `review_status='pending'`) — a bounded
  bulk update, not arbitrary ids. Idempotent (re-confirming an already-confirmed set is a no-op).
- **Concurrency / safety:** each action re-checks the row is still `pending` (guarded update `where review_status =
  'pending'`), so a double-submit or a race can't flip a confirmed row or resurrect a rejected one. Fail-closed
  (`DataResult`): on error, no partial state, a safe message, never a raw DB error or body.
- **No mutation buttons ship until §11 approval** — this section is the *design* of the writes, not their implementation.

---

## 4. Audit trail required

Every confirm/reject is an **append-only audited event** (reuse `audit_logs` + `src/lib/data/audit.ts`; do not invent a
new mechanism):

- **Record:** action (`discovery_review.confirm` / `discovery_review.reject`), the `discovery_facts` **id(s)** (or the
  run+type group + affected count), `review_status` transition (`from`→`to`), `reason_class` (for rejects), tenant,
  actor (`reviewed_by` = the acting profile), `occurred_at`.
- **On-row trail:** `reviewed_by` + `reviewed_at` on `discovery_facts` give a durable per-row "who/when" (already columns).
- **Forbidden in audit `after_json`:** `fact_json`, `natural_key`, PII, tokens, secrets — **metadata only** (ids,
  enums, counts, timestamps). Mirrors the connector-secret lifecycle audit discipline.
- **Immutable:** append-only; rejects are tombstones; nothing is deleted.

---

## 5. How confirmed items become / update `app_users` / people / managed records

**This is the highest-risk step and is gated (needs a migration — §7).** Design rules:

- **Never a direct reviewer write to `app_users`.** There is no editor INSERT/UPDATE RLS on `app_users`, and there
  should not be a broad one. Promotion must go through a **validated path**, one of:
  1. **Feed the existing deterministic resolver** (`resolver-write.ts` / docs/42 §69) — a confirmed fact becomes eligible
     for the same validated canonical-graph/app-user write the runner uses (idempotent, deterministic, `ON CONFLICT DO
     NOTHING`), OR
  2. **A new `SECURITY DEFINER` promotion function** (like the 0041 discovery writer) that validates tenant/fact
     ownership + `review_status='confirmed'` + a `fact_type` allowlist, then upserts the managed record — **EXECUTE
     granted to a narrow role only**, no broad table grant.
- **Idempotent upsert** keyed by (`tenant_id`, app, `natural_key`) — re-promoting a confirmed fact is a no-op; a
  re-sync + re-confirm does not duplicate.
- **`app_users` only in the first promotion slice.** **People / identity matching** (`app_user_identity_matches`,
  `people`) is **PII-heavy and deferred** — a separate design with its own privacy + RLS review (RISK-002 keeps `people`
  tenant-only; no UAR/merge here).
- **No production.** Promotion is staging-scoped until a separate production decision.

---

## 6. RLS / security rules that must hold

- **RLS is the sole authorization boundary.** No app-layer or client `tenant_id` filter; no service-role on any request
  path; the reviewer acts under their own session.
- **Reads:** `discovery_facts` `members read`; the review UI reads **counts/safe columns only** (§2) — never `fact_json`.
- **Writes (confirm/reject):** `editors update discovery_facts` (owner/admin/editor) — already in place; no widening.
- **No DELETE** on `discovery_facts` (tombstone stays).
- **Promotion writes** go only through the validated function/resolver (§5); no broad `app_users` write policy.
- **Cross-tenant:** every action must fail closed for a fact in another tenant (RLS rejects; a test asserts it).
- **Leak-scan:** `/connectors` page source stays free of `discovery_facts` / `fact_json` / `connector_secrets`; the DAL
  abstracts the table name. **Do not weaken, remove, or except the leak-scan.**

---

## 7. Existing schema enough, or migration needed?

| Capability | Migration? |
|---|---|
| **Confirm / reject** (review_status + reviewed_by/at + rejected_reason) | **NO** — 0025 `editors update` RLS + the columns already exist. |
| Read counts/safe columns for the queue | **NO** — RLS members-read exists. |
| Audit the transitions | **NO** — `audit_logs` exists. |
| **Promotion** (confirmed → `app_users`) | **YES** — no editor write authority on `app_users`; requires a validated `SECURITY DEFINER` promotion function (or resolver integration) + a narrow EXECUTE grant. |
| People / identity matching from facts | **YES + privacy review** — deferred. |

**Conclusion:** the review-**status** workflow (confirm/reject + audit) is buildable with **no migration** *except for the
audit trail* — because `audit_logs` is app-write-protected, the sanctioned audit path is a `SECURITY DEFINER`
audit-on-write trigger (like `contracts_audit_on_write`, 0010), which **is** a migration. The **promotion** step also
requires a migration. So per the standing rule, migrations are stop-and-ask.

> **Status — PR A (2026-07-10):** the **audit-trigger migration only** is prepared: `0042_discovery_facts_audit_on_write.sql`
> (a metadata-only `SECURITY DEFINER` `AFTER UPDATE OF review_status/reviewed_by/reviewed_at/rejected_reason` trigger,
> mirroring 0010) + RLS suite Test 62. **PR A does NOT implement or authorize the confirm/reject actions or any UI**, adds
> no policy/grant, keeps `audit_logs` app-write-protected, and is **prepared local-only — NOT applied** (no hosted
> Supabase). Building the confirm/reject actions + UI remains a separate, later, explicitly-approved step (§9/§11).

> **Staging apply evidence (2026-07-10) — migration 0042 only, staging only:** applied to **staging ref
> `ycdpzduxugdsffjqyoai`** via `supabase db push --linked` (linked project confirmed = staging; production ref
> `dzbfxulvxchdemcettrx` present in the org but **NOT linked/targeted**). Before apply: `0042` pending (Local only). After
> apply: `supabase migration list --linked` shows **`0042 | 0042 | 0042` (remote-applied)**; the push finished exit 0 with
> only the `drop trigger if exists` NOTICE (first-time create) — so the `CREATE FUNCTION … SECURITY DEFINER` + `CREATE
> TRIGGER … AFTER UPDATE OF review_status/reviewed_by/reviewed_at/rejected_reason` DDL committed (a failed DDL would abort
> and not record the migration). **Deep `pg_catalog` metadata assertions (prosecdef / tgtype / audit-policy) via direct
> SQL were NOT run — they require the DB password (a secret), which was not handled per the hosted-apply hard stops; those
> assertions run in the T62 RLS suite (CI / local disposable Postgres).** No confirm/reject action, no UI, no
> `/connectors` change, no connector run, no `get-secret-value`, no secret value printed. **Production untouched.**

---

## 8. Tests required before implementation

1. **Server-action DAL tests** (confirm/reject): editor-only (RLS), scoped by run+fact_type, **idempotent**, guarded
   update (`where review_status='pending'`), **tombstone** (no delete), **fail-closed** `DataResult`, **cross-tenant
   rejected**, **no `fact_json`/PII** read or written, sets `reviewed_by`/`reviewed_at`/`rejected_reason`.
2. **Audit test:** each action writes exactly one append-only audit row with metadata only (no `fact_json`/PII).
3. **UI tests:** the review controls render; **no row body / PII / forbidden literal** in output; empty + fail-closed
   states; **no mutation button ships** until approved.
4. **Leak-scan:** `ui-regression.test.ts` **unchanged** and still green with any new UI.
5. **RLS test matrix** (SQL, staging/local disposable only — never hosted): member-read, editor-write, non-editor
   denied, cross-tenant denied, default-deny elsewhere, no-delete.
6. **Promotion tests (later, with the migration):** validated-path only, idempotent upsert, no broad `app_users` grant,
   no PII leak, staging-only.
7. Full suite + `tsc` + lint + `scripts/check-no-real-tokens.sh --all` green.

---

## 9. Smallest safe implementation PR after this design

**PR: "Sync Review — confirm/reject (status-only, no promotion)"** — app/UI only, **no migration**, **no promotion**,
**no row bodies**:

- Server-only DAL actions `confirmPendingDiscovery({runId, factType})` / `rejectPendingDiscovery({runId, factType,
  reasonClass})` — editor RLS `UPDATE` of `discovery_facts.review_status` (guarded `where review_status='pending'`),
  set `reviewed_by`/`reviewed_at`(+`rejected_reason`), **idempotent, tombstone, fail-closed**, **audited**.
- `/connectors` Sync Review card gains **Confirm all / Reject all** controls **scoped to a run+type group**, counts-only,
  a fixed reject-reason enum, and confirmation copy — **still no per-item body, no PII**.
- Tests per §8 (1–5). Leak-scan unchanged.

Explicitly **out of this PR:** promotion to `app_users`/people (migration-gated), per-item detail/sanitized labels,
free-text reasons, any production action.

Follow-ups (each separate + gated): **PR-B** promotion via validated path (**needs a migration → stop-and-ask**);
**PR-C** per-item sanitized review (needs the §2 field approval); **PR-D** people/identity review (privacy review).

---

## 10. Hard-boundary compliance (this proposal)

- **No `fact_json` exposure.** The first slice surfaces **no row body at all**; any future per-item field is argued +
  gated (§2). No tokens, payloads, raw Slack bodies, secrets, emails, names, or natural keys are surfaced.
- **No mutations, no migrations, no code** are added by this doc. **No hosted Supabase / AWS / ECS / KMS / Secrets /
  Slack / Docker** command was run. **No production.**
- **Leak-scan unchanged** and must stay so; the DAL abstracts the table name.

---

## 11. Explicit approvals needed before implementation

1. **Build the status-only confirm/reject slice** (§9) — editor RLS `UPDATE`, audited, tombstone, **no promotion, no
   PII, no migration**? (the core go)
2. **Reject reasons = a fixed enum** (no free-text) — confirm the enum values.
3. **Promotion is a SEPARATE, migration-gated PR** — approval to *design* it now vs later; **implementation stop-and-ask
   because it needs a migration** (validated `SECURITY DEFINER` promotion function or resolver integration; no broad
   `app_users` write policy).
4. **Per-item detail stays OUT** until a later slice explicitly approves the minimal sanitized fields (§2).
5. **People / identity matching stays OUT** (PII; separate privacy review).
6. **Placement + scope** confirmed: `/connectors` Sync Review card, run+type-scoped bulk actions, staging-safe,
   production-neutral, leak-scan unchanged.

---

*Design proposal only. No code, schema, migration, mutation, promotion, or UI is created; no query was run; the
`/connectors` leak-scan is unchanged; production untouched. RISK-007 remains CLOSED at its staging-defined criteria;
Phase C remains UNBLOCKED as a governance state only; the C-2c sync ran on staging only; no production action is
authorized.*
