# 69 — Sync Review route (`/connectors/review`) — design proposal

> **CURRENT CURSOR (2026-07-10):** `idcaddie-v3` main @ `0bbd3c7` (PRs through **#301**). Building blocks already in
> place: the 0042 `discovery_facts_audit_on_write` trigger (applied on staging, #299/#300), the count-only DAL
> `src/lib/data/sync-review.ts` (#297), and the **server-only** status actions `src/lib/data/sync-review-actions.ts`
> (#301: `confirmPendingReview` / `rejectPendingReview`). This doc extends the manual-workflow design in
> [68_SYNC_REVIEW_MANUAL_WORKFLOW_DESIGN.md](./68_SYNC_REVIEW_MANUAL_WORKFLOW_DESIGN.md).
>
> **DESIGN + STATUS.** Sections 0–7 are the original design proposal (the §7 items were approved). The route was
> subsequently **implemented** — `/connectors/review` (**#303**) plus a navigation-only CTA from `/connectors` (**#304**) —
> and a **staging human test** is recorded in **§8** below: the **viewer**, **confirm**, **reject**, and
> **stale / repeat-no-op** paths **PASSED**, and **persistence-after-action PASSED**; only **deep audit** (pg_catalog /
> audit metadata) verification remains **DEFERRED / not tested** (see §8). No
> migration in this design (0042 was applied separately). Staging-safe, production-neutral; no production-readiness claim.

---

## 0. Why a *separate* route

`/connectors` is, and must stay, **read-only** — enforced by two guards that must not be weakened:
- **ui-regression leak-scan** (`ui-regression.test.ts`) forbids `"use server"` / `.insert(` / `.update(` / `.upsert(`
  and the leak literals on the pages in its `PAGES` array (including `connectors/page.tsx`).
- **the read-only-page test** (`manual-sync-runs.test.ts`) forbids `<form>` / `<button>` / `action=` / `onClick` /
  `"use client"` on `connectors/page.tsx`.

An interactive confirm/reject surface needs a `<form action={serverAction}>`, which those guards correctly reject.
**Resolution:** put the interactive surface on a **dedicated new route `/connectors/review`** that is *not* in the
`/connectors` read-only `PAGES` scan, and give it its **own** dedicated leak/no-body tests (§6). `/connectors` keeps its
read-only count-only card (#297) unchanged; it may add a plain `<Link href="/connectors/review">` (a link is not an
interactive mutation, so it does not break the read-only-page test — to be confirmed against that test's exact rules, or
the link is omitted).

---

## 1. Route and access

- **Route:** `src/app/(authenticated)/connectors/review/page.tsx` → **`/connectors/review`** (a server component).
- **Who may load it:** **authenticated tenant members only** (the authenticated route group already gates auth; the
  count reads are RLS `members read discovery_facts`). No caller-supplied `tenant_id` — **RLS is the sole authority**.
- **Who may mutate:** **editors only** (`has_tenant_role owner/admin/editor`), enforced by the existing 0025
  `editors update discovery_facts` RLS via the #301 helpers. No new policy, no widening.
- **Viewer behavior — explicit:** a **viewer** (tenant member, non-editor) sees the **read-only counts/groups** but is
  **not offered the actions** — the confirm/reject controls are rendered **only for editors** (a server-side role check).
  Defense-in-depth: even if a viewer forced a submit, the editor RLS makes it a **0-row no-op** (the helper returns
  `updated: 0`), never an error leak. So viewer = **read-only**; editor = read + act.
- **Server-side role check:** a small server-only helper (e.g. `currentUserCanReviewDiscovery()`) reads the caller's
  tenant role via an existing RLS-safe path (no `tenant_id` from the caller). Buttons render only when it returns true.

---

## 2. Data shown

- **Status/count-only, first slice — no individual rows.** The page shows the review queue as **aggregates grouped by
  `source_run_id` + `fact_type`** plus the tenant-wide status totals (reusing `getSyncReviewCounts` + a new count-only
  `getSyncReviewGroups()` — a `head:true`/`group by` read, still bodies-free; DAL only, page never names the table).
- **Allowed fields (all non-PII):** counts (per status / per group) · `fact_type` (enum, shown as a human label) ·
  `review_status` (enum → label) · `source_provider` (e.g. "slack") · `source_run_id` (opaque uuid) · timestamps
  (`created_at` / latest `reviewed_at`) · `confidence` **only if surfaced as an aggregate** (e.g. min/avg per group) —
  never a per-row value.
- **Forbidden — never read, never rendered:** `fact_json` · `natural_key` · `signal_id` · `source_record_id` ·
  `provenance_json` · names · emails · Slack IDs · raw payloads · tokens · secrets · any PII.
- **Individual rows: EXCLUDED from the first UI slice.** No per-item list, no drill-down, no row bodies. A per-item
  view (with a *sanitized, separately-approved* projection) is a later slice — see [docs/68 §2](./68_SYNC_REVIEW_MANUAL_WORKFLOW_DESIGN.md).

---

## 3. Actions

Wired to the **existing server-only helpers** from #301 (`confirmPendingReview` / `rejectPendingReview`) — the route adds
**no new mutation logic**, only a thin server-action wrapper + `revalidatePath("/connectors/review")`:

- **Confirm** pending items in a group → `confirmPendingReview({ sourceRunId, factType })` → `pending → confirmed`.
- **Reject** pending items in a group → `rejectPendingReview({ sourceRunId, factType }, reason)` → `pending → rejected`,
  `reason` from the **fixed enum** (`REVIEW_REJECT_REASONS`) only — free text is impossible (a `<select>` of the enum).
- **Pending-only transitions** (helper guards `where review_status='pending'`); **no undo to pending**; **no delete**;
  **no promotion** to `app_users`/people/identity_matches/managed records.
- **Audit** is produced by the **0042 DB trigger** on the UPDATE — the route/app **never inserts `audit_logs`**.
- **Fail closed** via the helpers' `ReviewActionResult` (`not_authenticated` / `invalid_reason` / `update_failed`).
- **Idempotent / no-op**: a re-submit or an already-reviewed group transitions 0 rows and reports "no changes" — never
  an error, never a double effect.

---

## 4. Interaction model

**Recommended smallest safe first slice: batch by `source_run_id` + `fact_type`.**
- The page lists each **(run, type)** group with its pending count and **"Confirm pending" / "Reject pending"** controls
  scoped to that group. This maps exactly to the #301 helper's `{ sourceRunId, factType }` scope and needs no per-item
  ids in the UI.
- **Explicit opaque fact IDs: NOT exposed in the first slice.** The helper *supports* `factIds`, but surfacing per-item
  ids edges toward row-level detail; keep the UI batch-only. Per-id selection is a later slice (needs §7 approval).
- **`<form>` per action:** each control is a progressive-enhancement `<form action={serverAction}>` + a `<button>` (the
  reject form also carries a `<select name="reason">` of the fixed enum + a hidden `sourceRunId`/`factType`). No client
  JS required.

**Result / UI states:**
- **Loading:** a `loading.tsx` skeleton (reuse the shared skeleton) while counts/groups load.
- **Success:** after the action + `revalidatePath`, the group's pending count drops; a status line "Confirmed N items" /
  "Rejected N items (reason)".
- **Partial / no-op:** `updated: 0` (already reviewed, or a viewer) → "No pending items changed."
- **Stale state:** because counts are re-read server-side after each action (`revalidatePath`), a stale group simply
  shows the fresh count; a submit against a now-empty group is a safe 0-row no-op.
- **Error (fail-closed):** helper returns `{ ok: false }` → "Could not update review items right now. Please try again."
  — never a raw DB error, id, or body.
- **No optimistic mutation.** Server-rendered truth only (re-read after the write); optimistic UI is unjustified for a
  low-frequency governance action and would risk showing an unconfirmed state as done.

---

## 5. Security invariants

- **`/connectors` remains read-only** — untouched; its `PAGES` leak-scan + read-only-page test stay **unchanged**.
- **New route has its OWN dedicated tests** (§6) — it is deliberately interactive, so it is **not** added to the
  `/connectors` read-only `PAGES` scan (which bans mutations); instead it gets a focused leak/no-body test.
- **Page source exposes no forbidden field/literal** — the DAL abstracts the table; the page imports neutral names
  (`getSyncReviewCounts` / `getSyncReviewGroups` / `confirmPendingReview` / `rejectPendingReview`) and renders only
  counts + safe labels. No `discovery_facts` / `fact_json` / `connector_secrets` literal in page source.
- **User-scoped Supabase only** (`@/lib/supabase/server`); **no service-role/admin client**; **no `tenant_id` from the
  caller**; **no direct `audit_logs` insert** (trigger-produced); **existing RLS remains the sole authority**.

---

## 6. Test plan

New tests for the route (existing `/connectors` read-only tests stay **unchanged**):
1. **Route auth/access:** unauthenticated → redirected/denied; a tenant member loads counts; **no caller `tenant_id`**.
2. **Viewer vs editor:** editor sees the action controls; **viewer sees read-only counts, no controls** (and a forced
   submit is a 0-row no-op).
3. **No forbidden page-source literals:** a dedicated static scan (like the #297/#301 tests) asserting the route page has
   **no** `discovery_facts` / `fact_json` / `connector_secrets` / body-column literal, and renders **no** PII/body/id.
4. **Confirm/reject integration:** the server-action wrappers call `confirmPendingReview` / `rejectPendingReview` with a
   `{ sourceRunId, factType }` scope and surface the count-only result.
5. **Fixed reject enum:** the reject `<select>` offers only `REVIEW_REJECT_REASONS`; an out-of-enum value fails closed
   (`invalid_reason`, no DB write) — reuses the #301 helper test.
6. **Pending-only transitions:** confirmed/rejected groups no-op (covered by the #301 helper + the T62 RLS suite).
7. **Audit trigger coverage:** asserted by the **T62 RLS suite** (0042) — an editor review writes one metadata-only
   audit row; no forbidden field (already merged; runs in CI/Docker).
8. **Stale / no-op behavior:** a submit against an empty/already-reviewed group returns `updated: 0` → "No changes".
9. **No promotion:** the route imports nothing that writes `app_users`/people/identity_matches; a static scan asserts it.
10. **No cross-tenant mutation:** RLS denies; asserted by the T62 suite (cross-tenant 0-row) — the route adds no bypass.
11. **`/connectors` read-only tests unchanged** and still green (a regression guard).

---

## 7. Explicit approvals required before implementation

1. **Dedicated `/connectors/review` route** (a new interactive page separate from the read-only `/connectors`)?
2. **Batch scope = `source_run_id` + `fact_type`** for the first slice (Confirm/Reject pending per group)?
3. **Viewer behavior = read-only** (sees counts, no action controls; RLS no-op as backstop)?
4. **Explicit opaque fact IDs: excluded** from the first UI slice (helper supports them; UI stays batch-only)?
5. **No row-detail first slice** (counts/groups only; no per-item bodies)?
6. **`/connectors` stays read-only** (its leak-scan + read-only-page test unchanged; the new route gets its own tests)?

On those GOs, implementation is a small PR: the route `page.tsx` + `loading.tsx` + a `"use server"` `actions.ts` wrapping
the #301 helpers + a count-only `getSyncReviewGroups()` DAL + the §6 tests. **No migration** (0042 applied; helpers exist),
**no `/connectors` change**, **no promotion**, **no row bodies**, leak-scan unchanged.

---

## 8. Staging human-test evidence (2026-07-10)

A **partial** end-to-end human test of `/connectors/review` on **staging only**. **Environment:** staging ref
`ycdpzduxugdsffjqyoai`; app URL `https://idcaddie-v3.vercel.app`; **production ref `dzbfxulvxchdemcettrx` never linked,
targeted, queried, or changed.** No connector run; no production action; no code changes; **no row bodies / PII inspected**
(counts and safe metadata only).

**A. Viewer — PASS.** Account `tenant-viewer-a@idcaddie-staging.local` (Storage Verifier Tenant A · **viewer**):
- Grouped counts render; **Pending 3**.
- **No** confirm/reject controls shown.
- Read-only banner ("read-only access — reviewing requires an editor role") visible.
- No row details / PII shown. `/connectors` remained read-only.

**B/C. Editor + Confirm — PASS.** Account `tenant-editor-a@idcaddie-staging.local` (Storage Verifier Tenant A · **editor**):
- **Pre-action (counts/metadata only):** one pending batch — provider **slack**, type **App user accounts**, opaque
  source run id **`25bda7ae`** (truncated), **Pending 3**. No individual rows / explicit fact IDs displayed; confirm +
  reject controls present.
- **Confirm action:** success message **"Confirmed 3 items."**; **Pending 3 → 0**; **Confirmed 0 → 3**; the batch
  **disappeared from the pending list**. Counts only — no row bodies inspected.

**D. Reject — PASS (2026-07-10).** A new synthetic pending batch was seeded via the staging-only, **human-applied** fixture
`supabase/fixtures/staging_sync_review_reject_verification.sql` (provider **test_fixture**, fact type **app_user_account**,
opaque run id **`5a9d0000`**, **exactly 2 pending rows**, synthetic-only data — no PII / real external identifiers).
- **Pre-reject (counts only):** Pending **2**, Confirmed **3**, Rejected **0**; one synthetic pending batch visible.
- **Reject action** (reason **"Not a real account"**): success message **"Rejected 2 items."**; **Pending 2 → 0**;
  **Rejected 0 → 2**; Confirmed **remained 3**; the batch **disappeared from the pending list**. No row details / PII
  shown; no promotion, delete, connector run, or production action.
- **Persistence-after-action: PASS** — confirmed during the stale test (§E): after the route reloaded, the post-action
  counts persisted (Pending 0 / Confirmed 3 / Rejected 4).

**E. Stale / repeat-no-op — PASS (2026-07-10); persistence-after-action — PASS.** A fresh synthetic pending batch was
seeded via the staging-only, **human-applied** fixture `supabase/fixtures/staging_sync_review_stale_verification.sql`
(provider **test_fixture**, fact type **app_user_account**, opaque run id **`5a9e0000`**, **exactly 2 pending rows**,
synthetic-only — no PII). Pre-test (counts only): Pending **2**, Confirmed **3**, Rejected **2**; the batch was opened in
**two browser tabs before any action**.
- **Tab A (reject once):** success **"Rejected 2 items."**; **Pending 2 → 0**; **Rejected 2 → 4**; Confirmed **stayed 3**;
  the batch disappeared from the pending list.
- **Tab B (stale — same batch, tab NOT refreshed):** reject clicked → **"No pending items changed."**; Pending **stayed
  0**, Confirmed **stayed 3**, Rejected **stayed 4**; no batch reappeared. This proves the **guarded stale / repeat action
  is a 0-row no-op** (the `.eq("review_status","pending")` guard matches nothing once the batch is already rejected).
- **Persistence — PASS:** after the route reloaded, the post-action state persisted (Pending **0** / Confirmed **3** /
  Rejected **4**).

No row details / PII shown; no promotion, delete, connector run, production action, or live-run change.

**F. Deep audit verification — DEFERRED.** Verifying the 0042 audit rows on staging via direct SQL requires the DB
password (a secret); per the hosted-apply hard stops that was **not** performed. The 0042 audit is asserted metadata-only
by the **T62 RLS suite** (CI). **No secret value was read or printed.**

**G. Regression.** `/connectors` stayed read-only; `/connectors/review` showed no forbidden data (counts/safe metadata
only); no promotion occurred; no connector run; production untouched.

**Net:** **viewer, confirm, reject, and stale / repeat-no-op paths PASSED on staging, and persistence-after-action
PASSED;** only **deep audit (pg_catalog / audit-metadata) verification remains DEFERRED / not tested** (do not read the
deep-audit item as having passed — it is covered metadata-only by the T62 RLS suite in CI). Production untouched.

---

*Sections 0–7 are the design; §8 records a partial staging human test. `/connectors` stays read-only; no promotion; no
row bodies/PII; no migration in this doc; no production action. RISK-007 remains CLOSED at its staging-defined criteria;
Phase C remains UNBLOCKED as a governance state only; the C-2c sync ran on staging only; production untouched; no
production action is authorized.*
