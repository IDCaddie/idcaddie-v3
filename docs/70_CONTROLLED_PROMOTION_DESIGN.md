# 70 — Reviewed discovery facts → controlled promotion / matching — design proposal

> **CURRENT CURSOR (2026-07-10):** `idcaddie-v3` main @ `1b21c69`. Governance (current): **RISK-007 is CLOSED at its
> staging-defined criteria; Phase C is UNBLOCKED as a governance state only.** The status-only **Sync Review** track is
> **CLOSED / functionally human-verified on staging** ([67–69](./69_SYNC_REVIEW_ROUTE_DESIGN.md)); only its deep hosted
> `pg_catalog` audit-metadata check remains deferred. **Production (`dzbfxulvxchdemcettrx`) untouched.**
>
> **THIS IS A DESIGN PROPOSAL ONLY.** No code, schema, migration, RLS/grant/policy, DAL, UI, hosted command, Supabase/AWS
> action, or connector run is created or performed by this doc. It runs no query and changes no leak-scan. It designs the
> **controlled promotion** track that would come *after* Sync Review and asks for the explicit approvals in §11 before any
> implementation. **Not a production-readiness or cutover claim; staging-safe and production-neutral.** Promotion is a
> **separate track** from Sync Review, and **this doc does not modify, reopen, or close the Sync Review track.**

---

## 0. Where this sits

Sync Review (67–69) lets a reviewer set `discovery_facts.review_status` to `confirmed` / `rejected` — **status only, no
promotion.** This doc designs the *next* step: how a `confirmed` fact could become a canonical `app_users` / `people` /
`app_user_identity_matches` row **under RLS, deterministically, idempotently, and reversibly-by-review** — with no
cross-tenant write, no duplicate identity, no silent overwrite, no destructive merge, and no automatic production-side
mutation.

**Ground truth this design is built on** (verified from migrations + `src/lib/server/connector-vault`, not assumed):

| Table | NOT-NULL essentials | Idempotency / natural key | Write RLS | Delete |
| --- | --- | --- | --- | --- |
| `people` (0001) | `tenant_id`, `primary_email` | `UNIQUE(tenant_id, lower(primary_email))` — 0036 (functional index) | editors (owner/admin/editor) | none |
| `app_users` (0001, +0040) | `tenant_id`, `app_id` | `UNIQUE(tenant_id, app_id, external_user_id)` — 0036 (NULL external_user_id ⇒ NULLs distinct) | editors | none |
| `app_user_identity_matches` (0001, +0027/0028) | `tenant_id`, `app_user_id`, `person_id`, `match_method` | `UNIQUE(tenant_id, app_user_id)` — 0028 (one person per app_user) **and** `UNIQUE(app_user_id, person_id)` — 0001 | `editors insert/update` via `has_tenant_role` (0027) | **no DELETE policy** |
| `discovery_facts` (0025, +0042) | `tenant_id`, `fact_type`, `review_status` (pending/confirmed/rejected/auto/needs_review) | partial idem `(tenant_id, source_provider, fact_type, signal_id)` | members read / editors insert+update; **no DELETE** | audit-on-write trigger (0042) |

Matching precedence is **already codified** in `src/lib/server/connector-vault/resolution.ts` (docs/42 §62/§72) as
*deterministic-first*: `exact_normalized_email` and `verified_external_id` may auto-assign; **everything else fails
closed to `human_review` and never auto-merges.** This design **reuses that posture** rather than inventing a new one.

> **Naming note:** the canonical app-user↔person table is **`app_user_identity_matches`**. `identity_accounts`
> (provider account → person) exists but is **out of scope** here. There is no table literally named `identity_matches`.

---

## 1. Scope and non-goals

**In scope (design only):** a deterministic, RLS-enforced, idempotent, human-gated path from a **`confirmed`**
`discovery_facts` row of the **narrowest useful type** into canonical data, with conflict routing and metadata-only
audit.

**Non-goals / hard nots (this doc asserts all of these as design invariants):**

- Promotion is a **separate track** from Sync Review; Sync Review stays **status-only** and **closed/unchanged**.
- **`confirmed` ≠ promoted.** Confirming a fact grants *eligibility*, never automatic promotion.
- **No production enablement**, no production deployment, no cutover, no production-readiness claim.
- **No live connector rerun**; no connector/provider API call; no `connector_secrets` / token / payload access.
- **No destructive merge**, **no canonical delete**, **no automatic mutation** of canonical records.
- **No row-body exposure** in any review/promotion UI — counts / status / conflict *metadata* only.
- **No promotion from `pending` / `rejected` / `needs_review` facts** — only `confirmed` (and, later, explicitly
  `auto`-confirmed) facts are eligible.
- **No service-role in app code**; **no caller-supplied `tenant_id` authority**; **no cross-tenant read or write.**

Phasing (§9) keeps every risky capability behind its own approval gate; nothing below P0 (this doc) is authorized here.

---

## 2. Source-to-target mapping

**Start with the narrowest useful slice: `fact_type = 'app_user_account'` only.** All other fact types are **NOT ready**
and are explicitly out of this design's promotion surface (they get their own mapping doc after separate approval — §9
P5). Defining one slice precisely beats defining five slices vaguely.

### 2.1 `app_user_account` → `app_users` (the only P1–P4 target)

| Aspect | Definition |
| --- | --- |
| **Canonical target** | `public.app_users` |
| **Tenant authority** | `discovery_facts.tenant_id` **as enforced by RLS on the read** — never a caller-supplied id. The promoting session is an `owner`/`admin`/`editor` of that tenant (verified via `resolveTenantContext()`), and RLS re-checks tenant on every write. |
| **Required target fields** | `tenant_id` (from the fact's row, RLS-scoped), `app_id` (resolved — see below), plus at least one identity anchor: `external_user_id` **or** `email`. A fact with neither is **not promotable** → `conflict: missing_required`. |
| **Optional fields** | `display_name`, `status`, `license_type`, `last_active_at`, `source` (set to a fixed marker e.g. `'promotion:app_user_account'`), `sync_status` (default `'active'`), `last_seen_at`. |
| **`app_id` resolution** | The fact must map to exactly one existing `apps` row **in the same tenant** (deterministic: `apps.UNIQUE(tenant_id, external_instance_id)` — 0036). If the app instance can't be resolved deterministically, **do not create an app** → `conflict: app_unresolved` (creating `apps` is a separate, later concern). |
| **Normalization** | `email` → `lower(trim(email))` for comparison/keying (mirrors `people_tenant_email_lower_key`); `external_user_id` compared verbatim (provider-stable, case-sensitive); whitespace-trim display fields; never normalize away a distinguishing instance discriminator. |
| **Idempotency key** | `UNIQUE(tenant_id, app_id, external_user_id)` (0036). Repeat promotion of the same fact resolves to the **same** row → **no-op** (see §4/§5). |
| **Duplicate detection** | Before insert: look up `(tenant_id, app_id, external_user_id)`. Found ⇒ candidate for **update-or-noop** (never a second row). Not found but `(tenant_id, app_id, lower(email))` matches a *different* `external_user_id` ⇒ `conflict: duplicate_email` (do **not** auto-merge two provider identities). |
| **Conflict behavior** | Any ambiguity fails closed to a **conflict state** (§6) for manual resolution. Never guess. |
| **Fields that may NEVER be auto-overwritten** | `id`, `tenant_id`, `app_id`, `external_user_id` (identity anchors), and any **human-edited** field. Promotion may **fill blanks** (null → value) and refresh explicitly-sync-owned fields (`last_seen_at`, `sync_status`, `status`), but must **never** clobber a non-null human-authored `display_name` / `license_type` / `email` with fact-derived data → such a difference is `conflict: field_divergence`, surfaced for review, not overwritten. |

### 2.2 Downstream (design-noted, **not** in the first slice)

`app_user_account` promotion **does not** create `people` or `app_user_identity_matches` rows. Person creation and
app_user→person matching are a **second slice** (§4 defines the matching precedence for when it is approved), because
they touch PII (`people.primary_email`) and the identity graph. Keeping the first slice to `app_users`-only means the
narrowest possible blast radius: no new PII rows, no identity-graph writes, until §9 P5 approval.

---

## 3. Promotion state model

**Do not overload `review_status`.** `review_status` (pending/confirmed/rejected/auto/needs_review) describes *review*,
not *promotion*; a fact can be `confirmed` yet unpromoted, promoted, or in promotion-conflict. Overloading it would
conflate two lifecycles and risk a confirm/reject action silently changing promotion state (or vice-versa).

**Proposed separate promotion lifecycle** (name TBD; e.g. `promotion_status`):

| State | Meaning | Entry condition |
| --- | --- | --- |
| `confirmed_unpromoted` | Eligible but not yet promoted (default for any `confirmed` fact) | `review_status='confirmed'` and no promotion attempted |
| `promotion_ready` | Passed the dry-run classifier (§9 P2): deterministic target resolved, no conflict | classifier says a single deterministic target/no-op |
| `promoted` | A canonical row now reflects this fact | successful insert/blank-fill/no-op |
| `conflict` | Needs manual resolution (§6) | any ambiguity / divergence / stale / already-promoted-elsewhere |
| `skipped` | Deliberately not promoted (reviewer choice or non-promotable type) | explicit skip or unsupported fact_type |
| `failed_reviewable` | A DB error / fail-closed abort; safe to retry after review | transaction error, constraint violation not otherwise classified |

> **STOP-AND-ASK (schema):** persisting this lifecycle requires **either** a new nullable `promotion_status` column on
> `discovery_facts` (+ CHECK constraint) **or** a new `promotion_events` table. **Both are migrations** and are **not
> done here** — they are P3+ and gated by §11. Until then, the classifier (P2) computes these states **in memory /
> read-only** and persists nothing. If a column is chosen, it is **additive, nullable, no backfill, no table rewrite**
> (like 0040) — but still a migration, still stop-and-ask.

---

## 4. Matching strategy

Reuse `resolution.ts`'s **deterministic-first, fail-closed** precedence. Evaluate in order; the **first** deterministic
hit wins; if none, route to conflict/manual review. **No fuzzy signal may auto-write a canonical record.**

**`app_user_account` → `app_users` (first slice):**

1. **Exact existing natural key** — `(tenant_id, app_id, external_user_id)` already exists ⇒ that row (update-or-noop).
2. **Exact provider + external stable id** — same key, not yet present ⇒ create.
3. Otherwise (no `external_user_id`, or app unresolved) ⇒ **`conflict`** (`missing_required` / `app_unresolved`).

**app_user → person matching (second slice, §9 P5 only):**

1. **Exact existing source-identity mapping** — an `app_user_identity_matches` row already links this app_user ⇒ no-op
   (respecting `UNIQUE(tenant_id, app_user_id)`).
2. **Exact normalized email within tenant** — `lower(email)` equals exactly one `people.primary_email` in the **same
   tenant** ⇒ deterministic match (`match_method='exact_normalized_email'`).
3. **Verified external id** — a provider-verified stable id maps to exactly one person ⇒ `verified_external_id`.
4. Otherwise ⇒ **`conflict` / human review**. Never auto-create-and-link on a fuzzy signal.

**Hard matching prohibitions (design invariants):**

- **No fuzzy / similarity matching may auto-write** a canonical record (fuzzy ⇒ review only).
- **No email-only matching across tenants** — every lookup is `tenant_id`-scoped; the same email in two tenants is two
  independent identities (mirrors the tenant-scoped natural keys — 0036).
- **No caller-supplied `tenant_id` authority** — tenant comes from the RLS-scoped fact row + `resolveTenantContext()`.
- **Multiple deterministic candidates ⇒ conflict, not a pick.** Determinism means *exactly one* candidate.

---

## 5. Safety invariants

Every promotion path MUST hold all of these (they are the acceptance bar for any future implementation):

- **Server-only, tightly-constrained boundary** — a `"use server"` action / server DAL importing the user-scoped
  anon-key client from `@/lib/supabase/server`. **No service-role**, ever, in app code (`check-auth-safety.sh` bans the
  literal).
- **RLS-enforced tenant isolation** — reads and writes both re-checked by RLS; **no cross-tenant lookup or write**; the
  editor/admin/owner write policies (0007/0027) are the boundary, not app logic.
- **Role gate** — only `owner`/`admin`/`editor` may promote (viewer is read-only), via `resolveTenantContext()`.
- **No promotion from `pending`/`rejected`/`needs_review`** — the eligible set is `review_status='confirmed'` (later
  optionally `auto`), enforced in the guarded query (`.eq('review_status','confirmed')`), fail-closed.
- **Idempotent** — repeat / stale promotion resolves to the same canonical row via the natural keys (0036/0028);
  duplicates are structurally impossible (unique index) and behaviourally a **no-op**.
- **No silent overwrite** — blank-fill only; any divergence on a human-authored field ⇒ `conflict`, never a clobber.
- **No canonical delete** — there is no DELETE policy on these tables and promotion introduces none.
- **Fail-closed** — any DB error / ambiguity / missing input ⇒ `failed_reviewable` or `conflict`; never a partial or
  optimistic write. Errors return a fixed error union (like `DataResult`), never raw DB text.
- **No body-field logging** — never log `fact_json`, `raw_payload`, emails, display names, or any row body; identifiers
  in logs/audit are **opaque ids/counts only**.
- **No secrets / connector payloads** — promotion reads only already-reviewed `discovery_facts` columns; it never
  touches `connector_secrets`, tokens, or provider APIs.
- **Audit every attempt and outcome** — see §7 (metadata-only, via a SECURITY DEFINER trigger — a migration, stop-and-ask).

---

## 6. Conflict handling

Conflicts are **first-class, human-resolved states** — never auto-resolved, never silently dropped. Each is
metadata-describable without any row body.

| Conflict | Trigger | Design resolution (manual) |
| --- | --- | --- |
| `duplicate_email` | `(tenant, app, lower(email))` matches a **different** `external_user_id` | reviewer decides: same identity (link/skip) or genuinely two accounts (keep both) — **never auto-merge** |
| `person_account_divergence` | app_user resolves to an existing person but a different app account than an existing match (second slice) | reviewer confirms which mapping is correct; respects `UNIQUE(tenant_id, app_user_id)` |
| `multi_canonical` | one source identity would map to **multiple** canonical records | fail closed — determinism violated; reviewer picks or splits |
| `missing_required` | no `external_user_id` **and** no `email`, or (second slice) `people.primary_email` absent | cannot promote; reviewer supplies/marks skipped |
| `provider_id_conflict` | conflicting provider identifiers for the same natural-key slot | reviewer reconciles; no overwrite of the identity anchor |
| `stale_source` | the fact's `source_run_id` predates a newer confirmed fact for the same natural key | prefer the newer; older ⇒ `skipped(stale)` (idempotent, no-op) |
| `already_promoted` | a canonical row already reflects this fact (natural key present) | **no-op** → `promoted`/`skipped(already)`; never a second write |
| `field_divergence` | fact value differs from a **human-authored** non-null canonical field | surface both (metadata: field name + "differs"), **do not overwrite** |
| `app_unresolved` | fact's app instance doesn't map to exactly one `apps` row in-tenant | cannot promote; app creation is out of scope |

All conflict metadata is **field-name + category + counts** — **never** the conflicting values themselves in any
surface that isn't an explicitly-approved detail view.

---

## 7. Audit model (metadata-only)

`audit_logs` is app-write-protected (no `authenticated` INSERT policy + no-mutation trigger); the sanctioned writer is a
**SECURITY DEFINER audit-on-write trigger** on the mutated table — exactly the 0010 (`contracts_audit_on_write`) / 0042
(`discovery_facts_audit_on_write`) pattern.

> **STOP-AND-ASK (migration):** the promotion audit trigger(s) are a **migration** (on `app_users`, and later
> `app_user_identity_matches`), plus possibly a `promotion_events` table. **Not created here** — P3+, gated by §11.

**Events** (action strings, metadata only): `promotion_attempted`, `promotion_succeeded`, `promotion_noop`,
`promotion_conflict`, `promotion_failed`.

**Safe to store** (metadata only): `actor_user_id = auth.uid()`, `tenant_id`, `discovery_fact_id`, `fact_type`,
`source_run_id` (opaque uuid), target table name, target canonical **id** (opaque uuid), the resolved **state**
(§3), the **conflict category** (§6, an enum label), a **field-name list** for `field_divergence` (names only),
timestamps, and small **counts** (e.g. rows created / filled / noop).

**Must NEVER appear in audit metadata:** `fact_json` / `raw_payload` / any row body; email addresses, display names, or
any PII; the **conflicting values** themselves; provider tokens / secrets / payloads / `connector_secrets`;
caller-supplied tenant ids; free-text derived from untrusted fact content.

---

## 8. UI concept (no implementation)

A **separate** promotion surface, kept off the read-only and status-only pages:

- **`/connectors` stays read-only** (ui-regression leak-scan + read-only-page tests unchanged — do not touch).
- **`/connectors/review` stays status-only** (confirm/reject; no promotion controls added).
- **New route (proposed): `/connectors/promotion`** (or a `/connectors/review/promotion` sub-route) — its own dedicated
  leak/no-body tests, **not** added to the scanned read-only `PAGES` array.
- **Shows only** count / status / conflict **metadata**: per-`app_id` and per-fact-type readiness counts, promotion
  state tallies (`confirmed_unpromoted` / `promotion_ready` / `promoted` / `conflict` / `skipped` / `failed_reviewable`),
  and conflict **categories** with counts. **No row bodies, no emails, no `fact_json`, no PII** — unless a *later,
  separately-approved* detail design explicitly permits a constrained field-name view.
- **Editor-only actions** (when approved, P3+): a `"use server"` form performing the guarded, idempotent promotion of a
  **scoped batch** (by `source_run_id` + `fact_type`), never by raw fact ids in the form, mirroring the Sync Review
  action shape (69 §3). Viewer sees read-only + a banner.

No implementation in this doc — this is the target shape only.

---

## 9. Rollout phases

| Phase | Scope | Writes? | Gate |
| --- | --- | --- | --- |
| **P0** | **This doc / design only** | none | — |
| **P1** | Read-only **readiness counts** (server DAL + metadata-only surface): how many `confirmed` `app_user_account` facts would resolve / conflict | **no** (read-only, in-memory classify) | approve P1 |
| **P2** | Server-only **dry-run classifier**: computes §3 states + §6 conflicts, persists **nothing** | **no** | approve P2 |
| **P3** | **Staging-only, single-fact-type** (`app_user_account` → `app_users`) promotion behind the editor action, with the audit trigger migration | **staging only** | approve P3 **+** the schema/trigger migration (§11) |
| **P4** | **Human verification** on staging (viewer/editor/owner matrix; idempotence; conflicts; stale; already-promoted; fail-closed) | staging only | record like 69 §8 |
| **P5** | **Wider fact types + person/matching slice** | staging only | **separate approval per type** |

**Production is not in any phase here.** P3–P5 are **staging-only**; production enablement is a distinct future decision,
explicitly **not** requested or implied by this doc.

---

## 10. Test plan

(For when implementation is approved — the RLS-level cases belong in `supabase/tests/org_rls_test.sql`, mirroring T31/T62; the DAL/UI cases in vitest.)

- **Tenant isolation** — a promoter in tenant A cannot read or write tenant B's facts or canonical rows (RLS).
- **Role boundaries** — viewer cannot promote (read-only); editor/admin/owner can; enforced by RLS, not app logic.
- **Pending/rejected/needs_review cannot promote** — guarded `.eq('review_status','confirmed')`; a non-confirmed fact is a 0-row no-op.
- **Idempotent repeat promotion** — promoting the same fact twice yields one canonical row and a `promotion_noop` on the second.
- **Duplicate email conflict** — two provider identities sharing an email in one tenant ⇒ `conflict: duplicate_email`, **no merge**, no second-identity clobber.
- **Cross-tenant same email isolation** — the same email in tenants A and B stays two independent rows; no cross-tenant match.
- **Stale source fact** — an older `source_run_id` for the same natural key ⇒ `skipped(stale)` no-op; newer wins.
- **Already-promoted no-op** — natural key already present ⇒ `promotion_noop`, no write.
- **No service-role** — `check-auth-safety.sh` (which bans the service-role literal anywhere in `src/`) passes; the
  promotion code uses only the user-scoped anon-key client.
- **No body-field logging** — assert no `fact_json` / `raw_payload` / email / display-name literal reaches logs or audit metadata.
- **Audit metadata-only** — the trigger writes only §7 safe fields; a leak-value seeded in `fact_json` never appears in `audit_logs` (T62-style assertion).
- **No canonical overwrite** — a human-authored non-null field is never clobbered; divergence ⇒ `conflict: field_divergence`.
- **Fail-closed DB errors** — an injected DB error yields `failed_reviewable` and **no partial write** (transactional).

---

## 11. Explicit stop-and-ask boundaries

**STOP and ask for explicit approval before any of the following** — none is authorized by this doc:

- any **migration** or **schema change** (the `promotion_status` column / `promotion_events` table / audit triggers);
- any new **grant / RLS policy** (e.g. a promotion audit trigger's privileges);
- any **hosted command** (`supabase db push`, SQL editor apply, etc.);
- any **Supabase / AWS / connector** action;
- any **production** action of any kind;
- any **promotion of existing staging rows** (including the C-2c `app_user_account=3` batch or any Sync Review fixture rows);
- any **connector rerun** or provider API call;
- any **UI implementation** (route, action, form) — §8 is a target shape only.

The first implementable step after approval is **P1 (read-only readiness counts)** — no writes, no schema, no migration.

---

*This is a design proposal only. No code, schema, migration, RLS/grant/policy, DAL, UI, hosted command, connector run,
promotion of any existing row, or production action is created or performed here. The **Sync Review** track (67–69)
remains **CLOSED and unchanged**; its deep `pg_catalog` audit-metadata check remains the only deferred item there. No
production-readiness or cutover is claimed or implied. RISK-007 remains CLOSED at its staging-defined criteria; Phase C
remains UNBLOCKED as a governance state only; **production (`dzbfxulvxchdemcettrx`) untouched.***
