# 67 — Sync Review Card (count-only) — design proposal

> **CURRENT CURSOR (2026-07-10):** `idcaddie-v3` main @ `5db1b14`; `idcaddie-connector-runner` main @ `0d7dcfa`.
> Governance (current): **RISK-007 is CLOSED at its staging-defined criteria; Phase C is UNBLOCKED as a governance state
> only.** The C-2c staging live sync ran on **staging only** (connector-runner PR #36) and produced `discovery_facts`
> (`app_user_account=3`, `review_status=pending`); **production (`dzbfxulvxchdemcettrx`) untouched.**
>
> **THIS IS A DESIGN PROPOSAL ONLY.** No code, schema, migration, DAL, or UI is created by this doc. It changes no
> leak-scan and runs no query. It proposes a **count-only** "Sync Review" card and asks for the explicit approval named
> in §9 before any implementation. Not a production-readiness claim; staging-safe and production-neutral.

---

## 1. Purpose / the gap

After the first sanctioned connector sync (C-2c), `discovery_facts` rows are created with `review_status = 'pending'`,
but **nothing in the app surfaces them.** A user sees the run as "Succeeded · N seen · N imported" (per the shipped
run-counts change) yet has no way to see **"N discovery items are pending review from the last sync."** This proposal
adds a **count-only** summary of that pending queue — aggregates only, never item bodies.

It deliberately stops short of review **actions** (confirm/reject) — those are writes and a separate, later step (§8).

---

## 2. Exact data source + RLS boundary

- **Table:** `public.discovery_facts` (migration **0025**; runner write boundary hardened in **0041**).
- **Columns (for context — the card reads NONE of the sensitive ones):**
  - Aggregate/safe: `review_status` (`pending` | `confirmed` | `rejected` | `auto` | `needs_review`), `fact_type`
    (allowlisted enum, e.g. `app_user_account`, `group`), `source_provider`, `tenant_id`, `source_run_id`, timestamps.
  - **Sensitive — NEVER read by this card:** `fact_json` (the normalized item body — may contain emails/names/ids),
    `natural_key`, `signal_id`, and any row body.
- **RLS (already in place — no migration needed):** `discovery_facts` has RLS **enabled** with policy
  **`members read discovery_facts` → `for select using (public.is_tenant_member(tenant_id))`**. So an authenticated
  tenant member may already SELECT their own tenant's rows; **RLS is the sole authorization boundary** — the card adds
  no app-layer or client tenant filter. Supporting index exists: `discovery_facts (tenant_id, review_status)`.
- **Writer isolation (unchanged):** `connector_runner` is `nologin BYPASSRLS` and writes `discovery_facts` **only**
  through the 0041 SECURITY DEFINER functions (validated). This proposal touches none of that; the app path is a
  **read-only, RLS-scoped, count-only** SELECT under the *user's* session (anon key), never the runner role.

---

## 3. Why count-only is safe (and where the line is)

**Safe — what the card does:**
- Issues **count-only** reads: `supabase.from("discovery_facts").select("id", { count: "exact", head: true })` with an
  `.eq("review_status", …)` (and optionally `.eq("fact_type", …)`). **`head: true` transfers ZERO rows** — only an
  integer count. No `fact_json`, `natural_key`, `signal_id`, or any body is selected.
- Reveals only **tenant-scoped aggregates the tenant already owns** (e.g. "3 pending", "3 app_user_account"). RLS
  guarantees no cross-tenant count. `fact_type` and `review_status` are low-sensitivity enums, not PII.
- Fails closed as a `DataResult<T>` (on error → `{ ok: false }`, render a safe "couldn't load" line, never a partial/raw leak).

**Not safe — explicitly excluded (would require a separate, gated design):**
- Selecting or displaying `fact_json` / `natural_key` / `signal_id` / any row body (can carry emails, display names, external ids).
- A per-item review **table/list** (rows → bodies) or any drill-down into an individual fact.
- Any **write** (confirm/reject/auto-approve) — mutations are out of scope here.
- Reading via the runner role or bypassing RLS.

**Net:** a `head:true` count grouped by `review_status` (± `fact_type`) is safe because it exposes only owner-scoped
aggregate metadata with no bodies; the risk lives entirely in the row bodies, which the card never touches.

---

## 4. What strings would appear in the UI

Card on `/connectors` (or `/needs-attention` — see §9 open question). Counts + safe labels only:

- **Title:** `Sync review`
- **Lead (non-zero):** `3 items pending review from the last sync` (pluralized; number from the count).
- **Status chips (counts):** `Pending 3` · `Needs review 0` · `Confirmed 0` · `Rejected 0` (labels map from
  `review_status`; `auto` → `Auto`).
- **Optional by-type line:** `App user accounts 3` (human label for `fact_type`; never the raw enum).
- **Empty state:** `No items awaiting review.`
- **Error state:** `Could not load the sync review summary right now. Please try again later.`
- **Safety caption (verbatim intent):** `Counts only — no item details, personal data, payloads, tokens, or secrets
  are shown or stored here. Confirm / reject happens on the separate review page (this page stays read-only).`
  > **Update (2026-07-10):** this proposal originally noted confirm / reject was "not built yet." It is now built on the
  > separate `/connectors/review` route (#303), reached via a navigation-only CTA (#304); `/connectors` stays read-only.
  > The caption above matches the shipped copy. See [69 §8–§9](./69_SYNC_REVIEW_ROUTE_DESIGN.md).

**Critical UI-source rule:** the **page source must contain none of the leak-scan forbidden literals**
(`discovery_facts`, `fact_json`, `connector_secrets`, `ciphertext`, `getSecretValue`). The page imports a
neutrally-named helper (e.g. `getSyncReviewCounts` + type `SyncReviewCounts` from `@/lib/data/sync-review`) and renders
plain strings like "Pending 3". The literal `discovery_facts` appears **only inside the server-only DAL**, which the
page leak-scan does not scan (see §6).

---

## 5. What tests would be required

1. **DAL no-leak test** (`sync-review.test.ts`): mock the Supabase client; assert the query is **count-only**
   (`head: true`, selects only `"id"` / count — **never** `fact_json`/`natural_key`/`signal_id`), is tenant-scoped via
   RLS (no client `.eq("tenant_id", …)` injected), and **fails closed** (`DataResult` error path). Assert the returned
   object carries only integers, no row bodies.
2. **Pure label test:** `review_status` → label and `fact_type` → human label (known values + unknown pass-through).
3. **Card UI test** (`*.ui.test.tsx`, jsdom): renders non-zero counts, the empty state, and the error state; asserts the
   rendered HTML contains **no** forbidden literal and **no** email/name/id shape (a leak assertion, like the other UI tests).
4. **ui-regression leak-scan MUST still pass** with the card added to `/connectors` — i.e. the page file still contains
   none of the forbidden literals. This is the gate that keeps the abstraction honest.
5. Full suite + `tsc` + lint green; `scripts/check-no-real-tokens.sh --all` clean.

---

## 6. Should the forbidden-literal leak-scan stay unchanged? — **YES**

- **Keep it exactly as-is.** The `ui-regression.test.ts` PAGES scan forbids `discovery_facts` / `fact_json` /
  `connector_secrets` / `ciphertext` / `getSecretValue` in **page** source. The card is designed to satisfy that
  unchanged: the page renders plain count strings and imports a neutrally-named DAL, so the forbidden literal never
  appears in page source.
- **Do NOT weaken, remove, or add exceptions to the leak-scan.** The scan targets **page files**; the server-only DAL
  (`sync-review.ts`) legitimately contains `discovery_facts` because it queries it, and that DAL is **not** in the PAGES
  array — so no change is needed and none should be made. Weakening the scan to "allow discovery_facts on a page" would
  be the wrong move; the correct pattern is abstraction (DAL) + the scan staying strict.
- If desired, a **complementary** guard could be added (not a relaxation): a DAL-level test asserting `sync-review.ts`
  never selects `fact_json`. That strengthens, not weakens, the posture.

---

## 7. Data-flow summary (proposed, if approved)

```
discovery_facts (0025; RLS members-read; runner-written via 0041 SECURITY DEFINER)
  → [server-only DAL sync-review.ts]  head:true COUNT by review_status (± fact_type), user session / anon key, RLS-scoped
    → SyncReviewCounts { pending, needsReview, confirmed, rejected, auto, byType }   (integers only — no bodies)
      → /connectors "Sync review" card   (plain count strings; page has NO forbidden literal)
```

---

## 8. Non-goals (for the proposed card)

- **No review actions** (confirm / reject / auto-approve) — those are writes; a separate gated design.
- **No per-item list / drill-down / `fact_json` / row bodies / emails / names / ids.**
- **No migration, no RLS change, no leak-scan change, no runner change.**
- **No production query**; **no production readiness claim.** Staging-safe, RLS-scoped, read-only.

---

## 9. Explicit approval needed before implementation

Because `discovery_facts` is deliberately on the leak-scan forbidden list, surfacing it **at all** — even count-only —
is a product/security decision, not a mechanical polish. Before writing PR code, an explicit Sam GO is required on:

1. **Surface count-only `discovery_facts` aggregates in the app UI?** (yes/no) — the core decision.
2. **DAL may read `discovery_facts` server-side, count-only** (`head:true`, never `fact_json`/bodies), under the user's
   RLS session (anon key; never the runner role). (confirm)
3. **Leak-scan stays unchanged**; the page abstracts the literal via the DAL (confirm — no relaxation).
4. **Placement:** the card lives on **`/connectors`** or **`/needs-attention`** (choose one for the first PR).
5. **Scope confirmed:** read-only, counts only, **no review actions/writes**, no migration; staging-safe, production-neutral.

On that GO, this becomes a single small PR (DAL `sync-review.ts` + a `SyncReviewCounts` type + label helpers + the card +
the four tests in §5), mirroring the existing `manual-sync-runs.ts` + `StatCard`/`Badge` pattern.

---

*Design proposal only. No code, schema, migration, DAL, UI, or leak-scan change is made here; no query was run; production
untouched. RISK-007 remains CLOSED at its staging-defined criteria; Phase C remains UNBLOCKED as a governance state only;
the C-2c sync ran on staging only; no production live sync is authorized.*
