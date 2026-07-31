# Phase 16A — Design Review of `docs/74_ACCESS_REVIEW_PRODUCT_SPEC.md`

**Review type:** design review only. No code, SQL, migration, TypeScript, or PR was produced.
**Method:** the spec was read in full, then reviewed against repo ground truth (migrations `0001`–`0061`, `src/lib/data/access-*`,
`src/lib/auth/tenant-context*`, `docs/71`–`73`, `docs/v3-security-model.md`, `docs/CONNECTOR_PILOT_RETENTION_AND_DELETION.md`,
`docs/04`/`59`/`65`) by six independent expert lenses — IGA/product parity, security & authorization, audit/compliance/legal,
data model & scalability, formal state-machine analysis, enterprise UX & reporting — each followed by an adversarial refutation
pass, then a completeness critic. 96 candidate findings; 10 refuted; **86 survived**, plus 3 found in direct review.
**Verdict:** **NOT READY** (§20).

---

## 1. Executive assessment

The spec chooses the right *primitives*. Frozen evidence over live-graph review, immutable decisions with explicit supersession,
and a remediation wall expressed as a data-model property rather than a policy promise are the three decisions that would have been
expensive or irrecoverable to get wrong, and all three are right. As a **product vision** document it is strong and would be
recognizable to an Entra/Okta/SailPoint buyer.

It is not, however, an implementable specification, for one systemic reason: **it specifies a product for a platform that does not
exist yet, and asserts inheritance from Phase 15 that Phase 15 cannot provide.** Phase 15 is a read-only, owner/admin-only,
zero-persistence, zero-write, whole-tenant-capped surface. Phase 16 is a multi-role, write-heavy, durably-persisting,
time-driven, per-item-scoped system. The spec repeatedly writes "inherits the Phase-15 guarantee" where the Phase-15 guarantee is
structurally inapplicable:

| §  | The spec assumes | Repo reality |
|---|---|---|
| §4/§14 | Reviewer, Approver, Observer are principals | `tenant_memberships.role CHECK ('owner','admin','editor','viewer')` — `0001:27`. None of the three exists, and there is **no way to create a tenant member in-product** (`admin-view.ts:52-53`) |
| §15/§17.4 | Reviewers follow evidence links into `/access` | `/access` is owner/admin at two layers (`access-repository.ts:31`, plus `has_tenant_role` inside every `0061` RPC). A reviewer gets the byte-identical "This doesn't exist" |
| §7.1/§11 | Launch freezes a snapshot per in-scope item | Above `MAX_NODES=2000`/`MAX_EDGES=5000` the engine computes **nothing** (`access-loaders.ts:21,70`). There is no queue, no job runner, and §3 forbids building one |
| §7.1/§7.2/§9.7/§18 | A `scheduler`/`system` actor fires six transitions | No cron/queue/scheduler exists. A sessionless actor has no `auth.uid()`, so `has_tenant_role` is false — it must be service-role, which §13 forbids |
| §11/§13 | The snapshot "inherits the Phase-15 privacy boundary" | Phase 15's boundary is a **transport** boundary — it persists nothing (`docs/72`). Snapshots are the product's first durable copy of connector-derived PII, against a DB-enforced `retention_days CHECK 1..90` (`0047:74`) |
| §12 | The audit trail "reconciles with existing conventions" | `audit_logs`'s only policy is `is_tenant_member` (`0001:323`) — every viewer reads every row — and it has **no authenticated INSERT**; every existing write is a definer trigger or a role grant |
| §23 | "verifier-style acceptance defined" | Nothing is defined, and `docs/73 §6` binds the only verifier to read-only. The verified fixture yields **exactly one review item** and has no owner/admin member |

The document's closing line — *"Ready for Phase 16B implementation"* — is not supportable. §24 lists eleven questions as if
co-equal; **seven of them determine the physical schema or the authorization model**, and three are simultaneously *decided* in
§20/§26 and *deferred* in §24, so a reader cannot tell which sections are binding.

**The single highest-value change is subtractive.** Almost every blocking finding disappears if 16A is re-scoped to what the
platform supports today: owner/admin attestation only, an explicit campaign-size cap, no scheduler, no notifications, no approver
sub-machine, no recurrence, no drift indicator, and five decision types instead of seven. That is a smaller, shippable, genuinely
defensible product. The current document is a v3 roadmap presented as a v1 spec.

---

## 2. Strengths

1. **Frozen evidence over live-graph review (§11, §26.2)** — correct and non-obvious. The connector marks absent rows stale on
   every complete run (`0053:387-391`), so the live graph genuinely shifts under a reviewer mid-decision. Freezing at *launch*
   rather than at first open is the stricter, correct choice.
2. **Immutable decisions with supersession (§10, §26.3)** — matches regulator expectation, and the enforcement primitive already
   exists in-tree (no UPDATE/DELETE policy + the `audit_logs_no_mutation` reject trigger, `0002:262-265`).
3. **The remediation wall (§22)** stated as a *data-model* property ("no field that triggers one", downstream-reader-only) rather
   than as policy. This is the one thing that would be irrecoverable if got wrong, and it is the correct construction.
4. **A separate `/reviews` surface (§26.1)** rather than bolting attestation onto `/access` — keeps two very different
   authorization models from being conflated.
5. **Fresh snapshots per recurring cycle with no auto-carry (§9.7, §24 Q6)** — avoids roll-forward rubber-stamping, the most
   common access-certification audit finding.
6. **`export.generated` is itself audited (§12)** — evidence egress logging is something auditors ask for and most products omit.
7. **Rationale required on every judgement decision (§10)** — stronger than the Entra/SailPoint default.
8. **Explicit refusal of ML/auto-decisions (§3, §26.7)** — keeps every attestation attributable to a named human.

---

## 3. Weaknesses (blocking, deduplicated)

Severity: **B** = must be resolved *before* 16B begins, because it determines physical schema, the authorization model, the
scalability envelope, or a contractual/legal commitment.

### B1 — Reviewer, Approver and Observer are principals that do not exist, and cannot be created
§4/§13/§14 · `0001:27`, `admin-view.ts:52-53`, `tenant-context.ts:24-25`

`has_tenant_role` can only test `owner|admin|editor|viewer`. §24 Q2's leaning ("assignments layered on membership") therefore means
every reviewer is onboarded as a **viewer or editor** — which is not inert. A viewer's `is_tenant_member` grant carries blanket
SELECT on `people` (incl. `department`, `title`, `manager_email`, `raw_payload` — `0001:100-112`, policy `0001:312`), `audit_logs`
in full (`0001:323`), `apps`/`contracts` with cost data (`0001:294,300`), and more; an editor additionally gets the confirm/reject
write path on the sync-review queue (`connectors/review/page.tsx:18`). §13's "a reviewer can see and decide only items assigned to
them" is true of the new tables and false of the tenant.

Separately and independently: **there is no product mechanism to create a reviewer at all.** "User invitations" and "Role
management" are listed as not built (`admin-view.ts:52-53`); the only supported procedure is `docs/73 §4`'s synthetic-user recipe —
create the auth user in the Supabase dashboard, hand-apply a membership row in the SQL editor. A 60-reviewer campaign is 60 manual
dashboard operations plus 60 hand-written INSERTs.

**Required:** close §24 Q2 in 16A. Either (a) restrict 16A reviewers to existing owner/admin members — and correspondingly cut §4's
"business/application/manager" persona, §5's per-application assignment story, and the Observer column — or (b) specify a new
low-privilege membership role *plus* the migration narrowing every `is_tenant_member` SELECT policy listed above, with the
blast-radius table enumerated and independently reviewed. Add a §23 criterion: *a principal holding only a reviewer assignment can
read no tenant table outside the review domain.* Declare reviewer onboarding an explicit precondition, and define launch behaviour
when an assignment names a principal with no active membership (refuse; never silently create the item).

### B2 — The reviewer cannot open the evidence the attestation screen links to
§11/§15/§17.4 · `access-repository.ts:31`, `access-loaders.ts:103,133`, `access/identities/[id]/page.tsx:36-39`

§15's closing sentence and §17.4's evidence panel both route the reviewer to `/access` for depth. `/access` is owner/admin-gated at
two layers, and a denied caller renders the byte-identical *"Not found — This doesn't exist or you don't have access to it."* By
construction the personas §14 defines as distinct from owner/admin are exactly the ones who will click.

The same gate silently breaks §11's drift indicator, and its failure mode is worse than an error: a `0061` read by a non-owner/admin
returns **empty**, which is deliberately indistinguishable from "no differences". The reviewer would be told the live graph matches
when in fact they simply cannot read it. Computing it with elevated privileges instead hands a reviewer post-snapshot **live** graph
state — more than the snapshot they were authorized for.

Note also that the snapshot itself materializes owner/admin-only graph data into a table a lower-privileged reviewer reads. That may
well be the right call, but it is a deliberate relaxation of the `0061` boundary and the spec must say so and own it.

**Required:** decide in 16A. Preferred: declare the review surface **evidence-self-sufficient** — the frozen snapshot is the
complete evidence; `/access` cross-links render only when the caller passes the owner/admin gate and are otherwise absent, not
broken; and the drift indicator is owner/admin-only or **cut** (close §24 Q9 as "not built"). If a reviewer-scoped canonical read is
intended instead, that is a new authorization surface over deny-all tables and needs its own independent review *before* 16B starts.

### B3 — Campaign launch cannot execute at enterprise scale, has no size bound, and has no failure path
§7.1/§9.3/§11/§17.2/§21 · `access-loaders.ts:21,24,70`, `0061:165`, `docs/72:44-46`

§11 requires snapshots to reuse the Phase-13/14 outputs at launch. That path returns `status:"too_large"` with **no effective access
and no findings computed** above `MAX_NODES=2000`/`MAX_EDGES=5000`. The gate is **whole-tenant and pre-scope**, so a campaign scoped
to five applications is still refused; and because the counts RPC is stale-agnostic (`docs/72:44-46`), stale row volume alone can
block a tenant whose current-only graph is small. The only alternative is one `product_identity_access_subgraph` call per identity
(`0061:165`) — 10,000 sequential round trips for a 10,000-identity tenant, inside a single request, with no queue and §3 forbidding
one.

Even *inside* the legal envelope the caps bound the **graph**, not the **item count**: one group with 2,000 members assigned to 5
applications yields 10,000 items. §17.2's "N items will be generated" is advisory copy, not a gate. §7.1 makes launch atomic and
irreversible (`Rollback: none`) with no `Launching` state, no idempotency key, and no failure edge — a half-launched campaign has no
representation.

**Required:**
- State an explicit `MAX_CAMPAIGN_ITEMS` and refuse **at preview** with the same fail-closed posture as the export path's 413
  (`access-export.ts:11` — refuse, never truncate). Recommend `MAX_CAMPAIGN_ITEMS = EXPORT_ROW_CAP = 10,000` so a campaign's
  completion report is always exportable whole — and state plainly in §1/§2 that this caps one campaign at roughly 500–700
  identities. **That number, not the graph cap, is the product's real scalability envelope.**
- Add a non-terminal `Launching` state and a failure edge back to Draft with a recorded, truthful reason ("scope too large to
  freeze"). Give ReviewItem a deterministic natural key `(campaign_id, connection_id, subject_kind, subject_id, application_id)`
  with a unique index, so a retry cannot double-create.
- Launch must be **fail-closed on completeness**: it may proceed only from a provably complete enumeration of its scope; if the
  scope cannot be completely enumerated, the launch is refused and **no** items are generated.
- §17.8 must define the "this scope cannot be launched" state.

### B4 — Six state transitions name a `system`/`scheduler` actor that does not and cannot exist
§7.1/§7.2/§9.7/§18 · `0044:289`, `0047:290`, `docs/73:170-173`, §3

Auto-launch at start date, `item.expired`, the cancel cascade, recurrence, "due soon", and "overdue" all require a time-driven
actor. None exists; §3 forbids the infrastructure to build one; `docs/73` records that even read-only diagnostics were deferred for
want of an approved sink. A sessionless actor has no `auth.uid()`, so `has_tenant_role` is false and every RLS-gated review write
fails — **unless it runs as service-role**, which §13 forbids and §23 makes an acceptance criterion. Auto-launch is the worst case:
it would perform the privileged freeze with no human actor to attribute it to.

Of §18's six notification events, exactly four are consequences of a user action and can fire. The two that cannot — **due-soon and
overdue** — are precisely the two that make a deadline mean anything.

§7.2 additionally names "campaign due date" as the expiry trigger while §20 gives ReviewItem its own `due_at` — two clocks, one
rule, no precedence stated.

**Required:** classify every transition as (a) user-actioned and written synchronously with the acting user as actor, (b) a
**derived predicate** computed on read and never persisted, or (c) an explicitly-invoked admin sweep — following this repo's own
no-scheduler precedent (`admin_expire_stale_authorizations` `0044:289`, `admin_expire_stale_pilots` `0047:290`). Recommended: make
Expired and Overdue derived (`state ∈ {Pending,InReview} AND now() > due_at`), state explicitly that a past-due item is still
decidable, drop `item.expired` from §12's catalogue, redefine §9.4 completion accordingly, cut auto-launch, and make recurrence
"the owner clicks *Start next cycle* with the prior config prefilled."

### B5 — Decision terminality is self-contradictory, and everything downstream inherits it
§7.2/§8.5/§9.4/§10/§14/§17/§19/§21

§7.2 defines exactly one decision edge — `InReview → Decided`, no per-type exception. §8.5 says Deferred "does not close the item";
§10 says Needs Investigation "keeps the item open". So `recordDecision(Deferred)` has two mutually exclusive outcomes *in the same
document*. §10's table declares seven types and specifies terminality for **none**. Defer is modelled three separate times — a
decision type (§10), a capability (§14), and an operation (§21 `deferReviewItem`) — with no statement of whether it writes a
Decision row.

Downstream: §17.1's pending count and §16's badge (is a deferred item pending?), §17.3's decided/pending/overdue dashboard, §9.4's
completion rule (*"complete when every item is terminal (Decided or Expired)"* — a deferred item is neither, so **a campaign with
one deferral can never auto-complete**), and §19's distribution and completed-review reports. An item can also accumulate two
non-superseded live decisions (a follow-up to a Deferred is not a reopen) with no link, no ordering rule, and no audit event.

**Required:** add an explicit `terminal?` column covering all seven types, and split §7.2's decision row by terminality with a
distinct audit event for the non-terminal case. Recommended minimal shape: Keep / Remove Recommended / Insufficient Evidence /
Needs Investigation / False Positive are terminal; **cut Deferred from the decision enum entirely** and model defer as an item
annotation (`defer_until` + reason) with an `item.deferred` event and no Decision row. That removes the triple-modelling and the
contradiction at the root. Every progress figure must then be reported as three numbers (attested / open / not attested), never a
single "% decided".

### B6 — No transition carries a precondition, and there is no concurrency model
§7.1/§7.2/§21 · `0044:75,276,403,415-431`, `0046:177`, `0047:283,356`

Both tables give From→To, actor, trigger and event — and no precondition assertion and no concurrency rule. §21 lists 18 write
operations with neither. Every other control plane in this repo enforces transitions as a compare-and-set inside the database
(`where id=p_id and status='draft' and expires_at > now()`), with fencing generations and partial unique indexes as DB-level
backstops. Spec 74 inherits none of that discipline, so both machines are advisory: two owners can complete concurrently, a
reviewer can decide into a cancelled campaign, and launch can race itself.

**Required:** add a **precondition** column to both §7 tables stating the exact `(current_state, actor_relation)` each transition
asserts. §21 must state that every write is a single conditional UPDATE on that precondition, that zero matched rows returns an
explicit conflict carrying the current state (never a silent no-op), and that the state change and its audit event are written in
one transaction. `launchCampaign` needs a DB-level idempotency guarantee.

### B7 — The approval step has events, APIs and a persona, but no states and no entity
§5/§7/§9.4/§12/§14/§17.7/§20/§21

§12 defines `approval.requested/granted/returned`; §21 defines three operations; §14 grants the Approver read on "in-approval
campaigns" — **a state §7.1 does not define**. §7.1's `Completed → Archived` row carries no approval precondition (and lets a
nonexistent "retention job" archive straight past the gate). §20 has no Approval entity, so *"is this campaign approved, by whom,
over which decision set?"* is answerable only by folding the audit log. Granularity is mixed: `approveCampaign` is per-campaign
while §5/§17.7 send items back per item. Nothing invalidates an approval — §7.2 lets an owner reopen a Decided item after
`approval.granted`, leaving a sign-off covering a decision set that no longer exists.

**Required:** either **cut the approver from 16A** (recommended — it is over-built for a tenant whose only roles are owner and
admin), or add `PendingApproval` to §7.1 with explicit rows for request/grant/return, add an `Approval` entity to §20
(`{campaign, approver, requested_by, requested_at, decided_at, outcome, rationale, decision_set_ref}`), add
`approval.invalidated` to §12, and remove "retention job" from §7.1's archive row.

### B8 — The audit trail has no decided home, and as specified it is forgeable
§12/§13/§20/§24 Q3 · `0001:207,323`, `0010`, `0031:30`, `0042`, `connectors/review/actions.ts:6-7`, `src/lib/data/audit.ts`

§12 ("reconciles with existing audit-log conventions"), §13 ("no service-role, ever") and §24 Q3 ("leaning: standard RLS") cannot
all hold. `audit_logs`'s only policy is `is_tenant_member` (`0001:323`) — **every tenant member of every role, including viewer,
reads every audit row**, which flatly contradicts §13's reviewer scoping. There is no authenticated INSERT: every existing audit
write is a `SECURITY DEFINER` trigger (`0010`, `0042`) or a four-column grant to `connector_runner` (`0031:30`), and the app's own
server actions explicitly never insert audit rows. "Standard RLS + no service-role" implies an authenticated INSERT on an audit
table — i.e. **a client-forgeable audit trail**.

Two further points the lenses could not see, found in direct review:
- **An `/audit` surface already exists** (`src/app/(authenticated)/audit/`) and its deliberately-safe DTO exposes only
  `action / resource_type / created_at` plus `actorRecorded: boolean` — it **withholds the actor by design**. §12 requires the
  opposite ("UI never presents a decision without its actor + timestamp"). §17.6 therefore cannot reuse the existing loader or its
  privacy posture, and duplicates an existing route that §16 does not mention.
- **§12 never names the repo's established write pattern**: server action → user-scoped DAL → RLS write → **audit-on-write DB
  trigger** with `actor = auth.uid()` and a curated allowlist into `after_json` (`0010:39-61`). This is the pattern that makes the
  trail unbypassable — application code that forgets to log cannot break it. §21 cites only the Phase-15 *read* path.

Additionally, §12 asserts the log is **"tamper-evident"** while nothing in the design can detect tampering: `prior_ref` is a
pointer, not a hash chain, and there is no signature or WORM guarantee. The honest claim is *append-only, enforced by RLS and a
reject trigger, with no delete path exposed at any layer*.

**Required:** review audit events live in a **new review-domain table, explicitly not `public.audit_logs`**, with a read policy
scoped to owner/admin/observer plus own-assignment for reviewers — never `is_tenant_member` alone. Every state transition executes
inside a `SECURITY DEFINER` RPC that writes the domain row and its audit event in one transaction, sets `actor`/`occurred_at`
server-side, and re-verifies `has_tenant_role` in the body exactly as the `0061` reads do. No INSERT/UPDATE/DELETE grant to
`authenticated` on any review table. Downgrade "tamper-evident" to what the design can prove.

### B9 — Attester attribution is destroyed by ordinary offboarding
§10/§20/§23 · `0001:207-209`, `0001:26`, `profiles.id → auth.users(id) ON DELETE CASCADE`

§10 and §20 record `reviewer`/`actor`/`assigned_by` as bare references and never say attribution is denormalized. In this schema an
actor reference resolves to `profiles(id) → auth.users(id) ON DELETE CASCADE`, and the existing audit table uses
`ON DELETE SET NULL`. Nothing forbids `ON DELETE CASCADE` on the Decision FK. Nothing captures the attester's **role at decision
time** — `tenant_memberships.role` is mutable and the membership row is deletable, so authority-at-the-time is unreconstructable.

The failure is routine, not exotic: the reviewer leaves the company, IT deletes the account, and a supposedly immutable attestation
either vanishes or loses its attester. Entra and SailPoint denormalize attester name/UPN/role into the certification record for
exactly this reason.

**Required:** state that every review-domain actor reference is (i) a NULLABLE FK with `ON DELETE SET NULL` — `ON DELETE CASCADE`
is **forbidden** on any Decision/AuditEvent/Assignment/Campaign actor column — and (ii) accompanied by immutable, write-time
denormalized attribution: `actor_display_label`, `actor_principal_ref`, `actor_tenant_role_at_time`. Add a §23 criterion:
*deleting the reviewer's auth user leaves every decision row present and fully attributable.* Note `actor_principal_ref` is
personal data and falls under B11.

### B10 — The snapshot has no provenance, no schema version, and no evaluation context
§11/§20/§25 · `0053:45`, `0059:40,80`, `0061:11`, `docs/72:30`, `access-loaders.ts:70`

- **`as_of_ref` is undefined and unobtainable.** The only run provenance on canonical rows is `last_discovery_run_id`, and `0061`
  **explicitly excludes it from every product read RPC**. So `as_of_ref` can only be the wall-clock time IDCaddie read its own
  database — which evidences nothing about when the provider was enumerated, by which run, whether it succeeded, or whether it was
  full or incremental. This fails the auditor's Information-Produced-by-the-Entity test.
- **No `snapshot_schema_version`**, on a payload that is immutable, retained indefinitely (§9.6), and rendered by view models that
  change every release — under a runtime-validation convention where unknown keys are stripped and malformed rows are **dropped**
  (`docs/72`). A snapshot frozen today must render correctly forever, with no marker telling the renderer which shape it is.
- **Evaluation context is not frozen.** The policy, evaluation status, and scope are omitted, so a tenant above the caps produces a
  snapshot that silently contains **zero findings** — indistinguishable from "no findings". Frozen finding ids are also not
  comparable to live ones (see W5).

**Required:** add `snapshot_schema_version` to §20 *before the table exists*, and state in §11 that the snapshot payload is a
frozen, independently-versioned contract — not a reuse of the live `/access` view models. Add a §23 criterion: *a snapshot written
under version N renders byte-identically under version N+1.* For provenance, choose explicitly: either expose a per-connection
provenance triple to the product read path (a reviewed migration that changes the read boundary) and freeze it as an evidence
header printed in every export — or **delete "as-of reference"** and replace it with the honest statement that the snapshot is
IDCaddie's read of its own store at `frozen_at`, carrying per-edge freshness but no source-system run reference, and add that
limitation to §25.

### B11 — Immutable personal data collides with a DB-enforced retention promise and the erasure scope
§9.6/§10/§11/§12/§13/§19/§20 · `0047:74,159`, `docs/CONNECTOR_PILOT_RETENTION_AND_DELETION.md`, `docs/72`

The claim that snapshots "inherit the Phase-15 privacy boundary" is **invalid**: Phase 15 persists nothing, so its boundary is a
*transport* boundary, not a storage one. Phase 15's display-label fallback is `display_name → login → email` (`docs/72`), so a
frozen label is frequently a work email address. Meanwhile §9.6/§12/§23 make the review domain append-only and "retained for audit"
with **no deletion path at all**, against a DB-enforced `retention_days CHECK 1..90` on pilot enrollments (`0047:74`) and a
`customer_scoped` erasure scope (`0047:159`) whose table list knows nothing about review-domain tables.

**Free-text comments are the sharper edge.** §10 makes `comment` required for five of seven decision types, with **no maximum
length**, no export decision, and no coverage anywhere: §13's privacy boundary covers only snapshots and views ("safe display
labels + bounded enums + integer counts"); §12 claims audit payloads carry "only safe fields" while `decision.recorded` must
obviously carry the comment or the trail is not defensible — a direct self-contradiction. This is unbounded free text a human types
**about a named person**, on rows declared immutable and undeletable, exportable by every owner/admin/observer/approver as CSV.
That is an HR-data export surface with no redaction path.

**Required:** §11/§20 must state a snapshot retention bound and its source (it cannot exceed the enrollment's `retention_days` for
connector-derived content); add every review-domain table explicitly to the `0047` `customer_scoped` erasure scope; and resolve the
immutability-vs-erasure conflict *in the spec* — recommended: snapshots and comments are erasable/redactable via tombstoning
supersession while the decision, actor, timestamp and hash survive as a non-identifying record. §10/§13 must declare the comment a
distinct data class with a hard maximum length, decide it is **not** a CSV column (exports carry decision_type/actor/timestamp/
snapshot ref only), and fix §12's contradiction. Close §24 Q8; do not defer it — it is contractual, not technical.

### B12 — Referential integrity to canonical rows is undefined, and both FK options are wrong
§11/§17.8/§20/§25 · `0053:61`, `0056:56`, `0059:58`, `0053:387-391`

§20 says review rows "reference canonical graph rows by id" without saying whether that is a foreign key or what happens when the
row disappears. `identity_accounts` carries `foreign key (connection_id, tenant_id) references connectors (id, tenant_id) ON DELETE
CASCADE`, which cascades to memberships and assignments. A review FK with CASCADE would **destroy the attestation record**;
RESTRICT would make a connector permanently undeletable, breaking the `0047` erasure commitment.

**Required:** state explicitly that subject references are plain unconstrained `uuid` columns with **no foreign key**, carried
alongside `connection_id` and `provider`; that the frozen snapshot label is what renders, so an item stays readable after its
canonical row is gone; and add an evidence state `subject_no_longer_present`, distinct from not-found, which suppresses the drift
indicator rather than failing it. State also that the normal sync outcome is `stale`, **not** deletion (`0053:387-391`), so
staleness is a drift signal on the snapshot and never an item state change — otherwise 16B will conflate the two.

### B13 — Multi-tenant reviewers' assignments are silently unreachable
§13/§15/§16/§17.8 · `tenant-context-derive.ts:60-73`, `tenant-context.ts:24-25`, `admin-view.ts:51`

`resolveTenantContext` returns exactly one `activeTenant`, chosen as the **alphabetically-first** membership, and the source states
plainly at line 63: *"Tenant switching UI is NOT built (deferred)."* §4's Observer/Auditor (compliance, internal audit) and §4's
Reviewer (external business manager) are precisely the principals most likely to hold more than one tenant membership. Their
assignments in every non-alphabetically-first tenant are unreachable — and would be reported as "not attested".

**Required:** state the reviewer active-tenant contract in §13/§15 and choose one of: (a) a tenant switcher is a hard 16B
prerequisite; (b) launch refuses to assign a principal holding >1 active tenant membership; (c) the review-item route derives the
tenant from the campaign row and re-authorizes against it, never from the alphabetical default. Add a §23 invariant: *an
unreachable assignment can never be reported as "not attested".*

### B14 — There is no acceptance instrument, and no fixture that can exercise a campaign
§23 · `docs/73 §2,§4,§5,§6`

§23's final bullet asserts "verifier-style acceptance defined" and defines nothing — no checks, no oracles, no exit codes, no
partial-run semantics. The instrument it alludes to is bound by `docs/73 §6`: *"The verifier calls ONLY the 0061 read RPCs … It
performs no insert/update/delete, no mutation"* — a reviewed safety property, not an implementation detail. **Every functional
criterion in §23 requires a write.** And because §12/§13 forbid delete "at any layer", every row a verification run creates is
permanent, while `docs/73 §5` already treats fixture drift as a stop condition.

The fixture cannot exercise the product either. 1 identity / 2 groups / 2 applications / 1 membership / 1 direct assignment / **0
group assignments** yields **exactly one review item** under §24 Q1's recommended default, and can generate no GROUP or BOTH item at
all — i.e. none of the group-path provenance §11 makes the centrepiece of the evidence. The same tenant has only editor+viewer
members, so **no principal there can create a campaign.** §23 asserts "reviewer scoping holds" with no fixture capable of
falsifying it: proving reviewer A cannot see reviewer B's item requires two reviewers with disjoint items.

**Required:** define the acceptance instrument before 16B — its write authorization (who approves a *mutating* staging verifier
given `docs/73`'s explicit read-only charter), its target (a dedicated verification tenant, **not** the canonical fixture tenant
`aaaa1111…`), and the disposition of verifier-created rows. Specify the minimum review fixture as a named precondition with an
owner: ≥1 owner/admin member, ≥2 reviewer principals, ≥2 identities, ≥1 group→app assignment, ≥1 item per reviewer, ≥1 item
assigned to neither — plus the negative controls. Building that fixture is a staging-data change requiring its own authorization
and cannot be discovered mid-16B.

### B15 — The surface is unsupportable by construction
§3/§12/§13/§14/§17.8 · `docs/73:170-173`

Three inherited properties compose into unsupportability: not-found indistinguishability means a denied read renders one identical
block regardless of cause; there is no approved telemetry sink and §3 forbids building one; and "no service-role, ever" means no
support engineer can read a tenant's review data. §17's eight screens contain no owner-facing diagnostic, and the audit trail
records `assignment.set` — the **intent** — never the outcome of a read. A reviewer who reports "I can't see my items" produces
zero evidence for anyone.

**Required:** add an owner/admin-only per-item assignment-health view that distinguishes causes without breaking cross-tenant
indistinguishability (assigned principal's display label, membership active/inactive, whether an `item.opened` event was ever
emitted, current assignment generation), plus a support procedure document — the `docs/73` analogue this spec lacks. If that is
unacceptable in 16A, §3 must say plainly that the surface is unsupportable and therefore staging-only, and §23 must stop claiming
acceptance of flows nobody can troubleshoot.

### B16 — No rollout gate, and §24's open questions are not classified
§3/§16/§23/§24/§26/line 516 · `docs/73` "Sunset condition", `nav-items.ts:57-66`

§3 says reviews "target the same isolated staging/validation posture until separately authorized" but never names the gate, its
criteria, or its authorizer. `docs/73`'s sunset condition states isolated-v3 mode must be removed or re-reviewed before *"V3
becomes customer-facing … real customer data is introduced."* §1's deliverable — a named accountable human attesting to real access
— **is by definition** customer-facing use of customer data, so the product's first genuine use trips a documented re-review the
spec never mentions. Conversely, everything obtainable under §3 (a synthetic user attesting to a synthetic single-item fixture) has
zero audit value. §16 meanwhile adds "Reviews" to the shared authenticated nav for every tenant and role with no enablement
mechanism and no empty-state contract.

And §24 presents eleven questions as co-equal while **seven determine physical schema or the authorization model**, and three are
simultaneously decided elsewhere and deferred here: §26.5 states *"Chose configurable, default per-relationship"* while Q1 lists
granularity as open; §26.6 and §20 already write "standard RLS" into the design while Q3 defers it to independent review; §9.7
asserts Q6's leaning as fact. A reader cannot tell which sections are binding — and the document nonetheless closes *"Ready for
Phase 16B implementation."*

**Required:** name the rollout gate explicitly (what must be true, and who authorizes it, before any real reviewer records an
attestation), state §16's enablement mechanism and empty-state contract, and classify §24 as below (§19).

---

## 4. Missing concepts

| Missing | Why it matters |
|---|---|
| **Reviewer-scope resolution of any kind** | No manager, department, app-owner, group-owner or business-unit attribute is exposed by `0061`. §5's "auto-assign by a designated access owner" has no data source: the only owner columns (`apps.technical_owner_user_id`/`business_owner_user_id`, `0001:59-61`) sit on the legacy catalog with no join path, since `0057` deliberately leaves `directory_applications.catalog_product_id` NULL/unmatched. 100% of assignment is manual, and the spec never says so. |
| **`scope_spec` definition** | §20's `scope_spec` is undefined and §5's flagship example ("Finance applications") is **not expressible** — the graph has no category, tag or business-unit attribute. |
| **`assignment_rule` + `fallback_reviewer` on Campaign** | §9.1 and §17.2 both name an "assignment rule"; §20's Campaign has no field for it. §8.1 requires every item to have an Assignment at launch, but §7.2 has no `Unassigned` state — an unmapped in-scope item has undefined behaviour and silently expires with no one to escalate to. |
| **An `Approval` entity and a `PendingApproval` state** | See B7. |
| **The attestation statement itself** | The design records a decision *enum* but never the assertion the reviewer is bound to ("I confirm this access is required for this person's current role"), nor which version of that wording they were shown. Legally, the enum value alone is not an attestation. |
| **Group-membership review as a first-class unit** | The graph carries `directory_group_memberships`, and group membership is where entitlement actually accrues. §24 Q1 offers identity/application/relationship/finding — not membership. |
| **A "no decision by close" policy declared at campaign creation** | Every comparable product forces this choice up front (keep / flag / expire-as-not-attested). Here, "Completed" is indistinguishable from "100% expired". |
| **Retention, disposition and legal-hold policy** | See B11. §24 Q8 mentions retention only in passing, as a storage question. |
| **The four artifacts an auditor actually asks for** | §19 lists seven progress dashboards and none of: a sign-off certificate / attestation letter, an exception report, per-application certification status for an app owner, and a per-item evidence pack. |
| **Reviewer onboarding, delegation, out-of-office** | B1; §24 Q7 defers the three mechanisms that keep a manually-assigned campaign from stalling. |
| **Subject-centric review history** | The `/access` ↔ `/reviews` link is one-way, so the same finding is re-escalated and re-attested every cycle with no memory. |

---

## 5. Workflow problems

1. **Deferred/Needs-Investigation deadlock** — a campaign containing one deferral can never satisfy §9.4's auto-completion trigger
   (B5). A `defer_until` beyond the due date has no defined interaction with expiry at all.
2. **Cancel repudiates recorded attestations** — §7.2's `Pending/InReview/Decided/Expired → Cancelled | system | parent campaign
   cancelled` transitions **already-Decided** items to Cancelled, irreversibly (`Rollback: none`). A completed attestation is
   destroyed by an unrelated administrative act. Decided items must be exempt from the cancel cascade.
3. **Extend is outside the machine** — §9.4 offers "Extend (new due date)" but §7.1 has no such transition, and extending cannot
   un-expire the items it exists to rescue.
4. **`Reopened` is a phantom** — §7.2 declares it a state, then treats it as a pass-through with no table row, no exit actor, no
   exit event, and no inclusion in cancellation.
5. **Reopen has no parent-campaign precondition** — an **Archived** campaign, declared read-only, can be mutated by reopening one of
   its items.
6. **`Draft` delete has no operation and cannot be represented** — §7.1 authorizes a hard delete while §21 has no operation for it
   and §12 cannot represent it. `Draft/Scheduled → Cancelled` is also not a transition, so a Scheduled campaign has no exit.
7. **Terminal taxonomy is ambiguous** — `Active → Completed` and `Active → Expired` describe the same owner act; "Overdue" is used
   as a state that does not exist; auto-completion has no authorized actor.
8. **Three competing state authorities** — an in-place column (§20), "nothing is edited in place" (§7), and "the log is the
   authoritative history" (§12). 16B cannot proceed until one wins.
9. **Recurrence conflates "on completion" with "at cadence"**, has no series identity, and is a §23 acceptance criterion that
   cannot be met (B4).
10. **Reassignment never revokes** — §20 models Assignment as append-only ("reassignment = new row"), so unless the read predicate
    keys on the *latest* assignment, the previous reviewer retains access. That predicate is unstated.
11. **Preview-vs-freeze divergence** — the launch preview is computed at T0 and the freeze happens at T_launch, with no
    reconciliation; under auto-launch nobody ever observes the actual population.

---

## 6. Security concerns

- **B1** (principals don't exist; onboarding grants collateral tenant-wide reads), **B2** (evidence link denial + drift indicator
  fails open to "no differences"), **B8** (forgeable audit trail; `is_tenant_member` readership), **B13** (unreachable
  multi-tenant assignments) — all above.
- **Snapshot as privilege escalation.** The snapshot materializes owner/admin-only graph data into a table a lower-privileged
  reviewer reads. Defensible, but it is a deliberate relaxation of the `0061` boundary and must be stated, scoped, and reviewed.
- **Observer over-reach.** §14 grants Observer whole-tenant read of *every* snapshot — exactly the graph data Phase 15 denies to
  everyone below owner/admin, for a persona §4 defines as external to the tenant's operations.
- **IDOR on a new, stable, enumerable id space.** Phase 15 had no stable ids to enumerate (findings are content hashes recomputed
  per request, `docs/71`). Campaign, item, decision and snapshot ids are persisted and guessable. The spec defines
  not-found-indistinguishability for reads (§17.8) but **no write-side not-found contract** — a write against a foreign id must be
  indistinguishable from a write against a nonexistent one. §19's reports are additionally scoped by *caller-supplied filters*
  (`getReport(kind, filters)`) with no statement that the tenant and role scope are re-derived server-side.
- **Every write-side control is net-new and unspecified.** Phase 15 had zero writes. No transport is named, no CSRF posture, no
  idempotency, no double-submit guard, and `export.generated` is an audited **GET** (a side effect on a safe method).
- **Reopen laundering.** In a tenant whose only roles are owner and admin, one principal can be reviewer, approver, reopener and
  completer of the same item, and §7.2 requires no reason on reopen.
- **Self-review is undetectable.** §13 promises the owner is "warned on self-review assignment" and §25 leans on SoD as the
  anti-rubber-stamping mitigation. There is **no verified linkage** between an IDCaddie auth user and a directory identity
  (`identity_accounts.person_id` is nullable, unexposed by `0061`, and `docs/71` forbids the legacy `people` model). The only way to
  build it — email matching — crosses a PII boundary and is unreliable. Either specify the linkage as its own reviewed schema, or
  delete both claims and state plainly that SoD is a process control the campaign owner enforces.

---

## 7. Audit concerns

- **B8** (home, readership, forgeability, "tamper-evident" overclaim), **B9** (attribution durability), **B10** (provenance,
  versioning, evaluation context), **B14** (no acceptance instrument, unusable fixture) — above.
- **No completeness-of-population attestation.** An auditor's first question is *"prove this campaign covered all in-scope
  access."* §19's coverage reports count the campaign's own items against themselves — a self-referential denominator. The Campaign
  row must persist a population attestation frozen at launch: scope predicate, enumeration completeness status, in-scope
  relationship count, items generated, and the provenance ref — rendered on §17.3 and printed in every completion report and export.
- **`Completed` overstates attestation.** A campaign where every item expired undecided reaches "Completed"; §24 Q11 leaves bulk
  keep undecided. The completion artifact must report three numbers, and if bulk keep is allowed at all, Decision needs a batch
  reference so the auditor can see that 400 items shared one rationale.
- **The event catalogue is not a function of the transitions.** §7 says "all transitions emit an immutable audit event"; §12's
  catalogue omits roughly ten of them (extend, un-claim, scope change, approval invalidation, launch failure, …).
- **`export.generated` is the only egress event** — there is no read-audit for the item screen, so "who saw this person's access"
  is unanswerable.
- **Legal exposure from a recorded, un-actioned recommendation.** §22's wall guarantees that "Remove Recommended" is provably never
  acted upon. The organization is then on record as knowing about access it deemed inappropriate and not removing it. This is a
  *real* consequence of the correct architecture, not a reason to change it — but §25 must name it, and the UI copy and the export
  must make the reviewer's and the organization's obligation explicit.

---

## 8. UX concerns

- **B2** (the evidence link that renders "This doesn't exist") — above.
- **Throughput.** §17.4 is a single-item attestation screen and §24 Q11 leaves bulk decisions open. A reviewer with 1,200 items and
  14 days needs roughly 40 decisions a working day; at one full-page load, one required comment and one confidence selection each,
  the product is unusable and the rational response is rubber-stamping — the exact outcome §25 says it is mitigating.
- **Submit mechanism unspecified.** §15 mandates the Phase-15 zero-JS GET-form pattern for a screen whose entire purpose is a
  POST. No submit contract, no record-and-next, no keyboard flow (the single biggest reviewer-productivity feature in Entra and
  SailPoint), no double-submit guard, and no statement of what happens to unsaved work.
- **The reviewer queue has no model** — no ordering, no grouping (by application? by identity?), no filter allowlist. Grouping is
  also foreclosed by the undecided snapshot storage question (§24 Q8).
- **Provenance is truncated in the browser.** Phase 15 bounds group-path lists with `+N more` (`docs/72`). Inheriting that on the
  attestation screen means **the reviewer attests to evidence they were never shown** — acceptable on a read-only explorer,
  not acceptable as the basis of a signed attestation.
- **No accessibility contract for the write path.** Phase 15's a11y posture was built for a read-only surface and §15 claims to
  inherit it wholesale. A decision form needs error semantics, focus management on validation failure, and a screen-reader
  announcement that the decision was recorded. Neither §15/§17 nor §23 mentions any of it.
- **The "My Reviews" badge** is unspecified in placement, cost, cacheability and role-awareness; the approver, who needs the same
  affordance, has neither a queue nor a campaign state to build one from.
- **Copy risk.** Reviewers will believe "Remove Recommended" removes access. §25's mitigation (explicit copy) is necessary but not
  sufficient — the label itself should carry the semantics (e.g. *"Flag for removal (no change is made)"*), and the confirmation and
  the export should repeat it.

---

## 9. Reporting concerns

- The **10,000-row, complete-only** export cap (`access-export.ts:11`) means the completion report and audit-trail export **cannot
  be produced for any realistically-sized campaign** — the deliverable the whole product exists to generate. Aligning
  `MAX_CAMPAIGN_ITEMS` to `EXPORT_ROW_CAP` (B3) resolves this by construction.
- §19 lists seven progress dashboards and **none of the four artifacts an auditor asks for** (§4).
- No export carries an **as-of stamp** or the population attestation, so an exported report cannot be tied to what was in scope.
- **Trend reports are not computable as specified.** They key on canonical row ids that a connector re-create replaces, silently
  reporting 100% churn; and they cannot key on finding id at all, since findings are content-hashed and recomputed per request.
  Recommend cutting trend reports from 16A.
- **Decision distribution is meaningless until B5 is resolved** — a "Deferred" that is simultaneously a decision and not a decision
  cannot be counted.
- Comments must be excluded from CSV (B11), which changes what "completed reviews (with decision + reviewer + timestamp)" can show.

---

## 10. State-machine concerns

See **B4, B5, B6, B7** and §5 (Workflow problems) — 11 further defects enumerated there. In aggregate: two coupled machines are
specified with no preconditions, no concurrency rules, six transitions attributed to a nonexistent actor, one phantom state, one
missing sub-machine, one transition (Extend) outside the machine entirely, a decision model whose terminality contradicts itself,
and three competing authorities for where state lives. **The state machine must be rewritten as a complete transition table with a
precondition column before 16B starts** — it is the cheapest artifact to fix now and the most expensive to fix later.

---

## 11. Campaign concerns

- `scope_spec` is undefined and the flagship example is inexpressible (§4).
- No `assignment_rule`, no `fallback_reviewer`, no `Unassigned` state (§4, §5).
- No size bound, no `Launching` state, no failure edge, no idempotency (B3).
- Scope-freeze at launch is correct (§2), but the pre-launch window lacks a `campaign.scope_changed` event.
- Recurrence has no series identity and no schedulable actor (B4).
- Completion semantics overstate attestation (§7).
- No campaign template concept, so the manual assignment work of §4 is repeated in full every cycle.

---

## 12. Decision concerns

- **Terminality (B5)** is the blocking one.
- **Seven decision types is 2–3× every comparable product.** "Custom note" has no defined semantic and no reporting treatment;
  "Needs Investigation" and "Insufficient Evidence" drive identical behaviour and differ only in narrative. Every extra type is a
  permanent reporting and audit-interpretation cost. Recommend five: Keep · Remove Recommended · Needs Investigation ·
  False Positive · Insufficient Evidence — with Deferred demoted to an item annotation.
- **Two live decisions with no link** — a follow-up to a Deferred is not a reopen, so `supersedes_decision_id` does not apply and
  nothing orders them.
- **Required free-text comment is an unbounded PII channel** (B11) with no length bound.
- **No attestation statement** (§4) — the enum alone is not what a reviewer should be bound to.
- Bulk-keep semantics (§24 Q11) must be decided now, because auditability requires a batch reference **on the Decision row**.

---

## 13. Evidence concerns

**B10** (no provenance, no schema version, no evaluation context) and **B12** (undefined referential integrity) are blocking.
Additionally:

- **The drift indicator is unbuildable as specified and dangerous as designed** (B2): a reviewer-privileged fresh read returns
  empty, which the design would render as "no differences". If retained at all it must be owner/admin-only and must render
  *"cannot compare"* — never *"no differences"* — whenever the read is empty, `too_large`, or `bounded`.
- **Drift is shown but not recorded** — the reviewer sees live information that is not in the record their decision is bound to,
  which is precisely the coupling §11 was designed to prevent.
- **Snapshot size and duplication.** A campaign of thousands of items each freezing overlapping group-path evidence has no size
  bound (§24 Q8, unresolved), and no statement about whether shared provenance is normalized or duplicated per item.
- **Finding-anchored features rest on unstable ground.** The per-finding review unit (§24 Q1), the "False Positive" decision type
  (which "attaches to the specific finding in the snapshot"), and "high-risk findings campaigns" all key on content-hash ids with
  no stored row and no cross-request stability — and per `docs/71` the only `high`-severity rules are non-entity **graph
  diagnostics** (`assignment_missing_identity`, `cross_scope_edge_ignored`, …), which are exactly the wrong subjects for a
  business-reviewer campaign.

---

## 14. Immutability concerns

- **"Tamper-evident" is asserted and unbacked** (B8) — `prior_ref` is a pointer, not a hash chain; there is no signature and no
  WORM guarantee. State what the design can prove: append-only, RLS + reject-trigger enforced, no delete path at any layer.
- **Immutability is already self-contradicted** by §7.1's Draft hard-delete (§5.6), by §7.2's cancel cascade over Decided items
  (§5.2), and by the retention/erasure obligation (B11).
- **`ReviewItem` carries mutable denormalized pointers** (`current_decision`, `assignment`, `due_at`) over append-only 1—N
  children, with no derivation rule and no concurrency control — the classic way an append-only model silently loses its guarantee.
- **`Notification.read_at` is the design's only genuinely mutable row**, for a feature with no delivery mechanism (§15).
- **Immutability makes verification unrepeatable** (B14) — no-delete means every acceptance run permanently pollutes the fixture.

---

## 15. Notification concerns

Four of §18's six events can fire; the two that carry the entire escalation loop cannot (B4). Beyond that: **cut the persisted
`Notification` entity from §20 for 16B.** It is a second enumeration surface and an unbounded fan-out write inside the launch
transaction, in exchange for a badge that is a `COUNT` over the reviewer's own open items — derivable with no table, no rows, and no
mutable `read_at`. Keep §18 as the *event model* it says it is; add the entity when an approved delivery abstraction exists.

---

## 16. Scalability concerns

**B3** is the headline: as written, the product cannot launch a campaign for any tenant above the Phase-15 caps, and has no bound
below them. Concretely, for a 10,000-identity × 200-application tenant: the whole-tenant path computes nothing; the per-entity path
is 10,000 sequential RPC round trips (each capped at 100 rows) inside one request with no job runner; and the resulting item count
is on the order of 10⁵–10⁶, each with its own frozen snapshot.

The honest statement — which §1/§2 should carry — is that **one campaign is capped at roughly 500–700 identities** if
`MAX_CAMPAIGN_ITEMS` is aligned to the 10,000-row export cap so the completion report is always exportable whole. That is a
defensible v1 envelope. What is not defensible is a spec that implies enterprise scale and specifies no bound at all.

Secondary: the `is_tenant_member`-wide badge query on every page render; snapshot storage duplication; and the per-render cost of a
drift comparison if it is retained.

---

## 17. Multi-provider concerns

- **The review unit is identity-account-keyed, not person-keyed.** The same human with an Okta identity today and an Entra identity
  tomorrow is reviewed twice, with no correlation and no way for a reviewer to see the whole person. §20's `subject_ref` has no
  person dimension, and `identity_accounts.person_id` is nullable and unexposed by `0061`. The spec's "provider-neutral" claim is
  true of the *schema* and false of the *review experience*. State this limitation explicitly, or specify the correlation key.
- **Cross-provider campaign scoping is undefined** — can one campaign span two connections? Two providers? §20's `scope_spec` is
  silent, and B12's requirement to carry `connection_id`/`provider` alongside every subject ref makes the answer a schema decision.
- **Connector re-create breaks cross-cycle continuity** — canonical row ids change, so trend reports and any "what did we decide
  last quarter?" lookup silently report total churn (§9).
- **Provider-specific evidence has no home.** Okta group types, Entra role assignments and future Slack/GitHub semantics do not
  reduce cleanly to `{DIRECT, GROUP, BOTH}`; the snapshot payload needs a versioned, provider-extensible shape (B10) rather than a
  fixed projection of today's view models.

---

## 18. Implementation risks

| Risk | Consequence | Mitigation |
|---|---|---|
| §24 left open at 16B kickoff | Seven of eleven questions determine physical schema or authorization; discovering them mid-build means a migration rewrite | Close the seven listed in §19 before kickoff |
| Reviewer role resolved late | The authorization model is the schema; a late answer invalidates every RLS predicate | Close §24 Q2 first, in 16A |
| Launch built optimistically | Works on the 1-item fixture, fails on the first real tenant, with no failure state to fall back to | `MAX_CAMPAIGN_ITEMS` + `Launching` + preview-gate before any launch code |
| Audit written from application code | A code path that forgets to log breaks the trail silently | Mandate the `0010`/`0042` definer-trigger precedent (B8) |
| Snapshot shipped without a version field | Unfixable later — the rows are immutable and undeletable | Add `snapshot_schema_version` before the table exists |
| Acceptance discovered late | `docs/73`'s verifier cannot write; the fixture cannot exercise a campaign; both need separate authorization | Specify the instrument and the fixture as 16B preconditions with named owners |
| "Ready for implementation" taken at face value | 16B starts against a spec with 24 blocking gaps | This review |
| Scope creep into remediation | Correctly identified in §25; §22's architectural framing is the right mitigation and should be preserved verbatim | — |

---

## 19. Open design questions

**§24 must be classified in the document.** The following seven **must close before 16B begins**:

| Q | Why it cannot wait |
|---|---|
| **Q1** granularity | Determines `subject_ref` polymorphism, the item uniqueness key, and every cross-campaign lookup. §26.5 already answers it — reconcile or delete Q1 |
| **Q2** roles' home | *The* authorization decision; determines whether `0001:27`'s CHECK changes and the RLS predicate on every new table (B1) |
| **Q3** RLS vs definer-RPC | §20 and §26.6 already assert "standard RLS" while Q3 defers it. As written it implies an authenticated INSERT on an audit table (B8) |
| **Q4** approver required/optional; reviewer==approver | Determines whether the approval sub-machine and entity exist at all (B7) |
| **Q8** snapshot storage | **Is** the schema — plus a size bound and a retention bound that is contractual, not technical (B11) |
| **Q9** drift surfacing | Not a UX question: the drift read is a canonical-graph read the reviewer is **not authorized** to perform (B2) |
| **Q11** bulk decisions | Auditability requires a batch reference **on the Decision row**; it cannot be added later without a migration |

May safely remain open into 16B: **Q5** (self-review policy — but only after §13/§25's undeliverable SoD claims are corrected),
**Q6** (carry-forward — already decided in §9.7; delete the question), **Q7** (delegation — close as "owner reassignment only in
16A"), **Q10** (notification delivery — moot once the entity is cut).

**Further questions this review raises, for the principal to decide:**

1. If reviewer onboarding stays out of scope, 16A reduces to *"owner/admin attests to their own tenant's access."* Is that still the
   product, and does §4's five-persona model survive that reduction?
2. Is a real, defensible attestation obtainable at all before `docs/73`'s isolated-v3 sunset condition is resolved — and if not,
   what is 16B's success criterion other than "the code exists"?
3. What is the acceptable target for a *mutating* acceptance verifier, and who authorizes creating it, given `docs/73`'s read-only
   charter?
4. Does immutability apply to verification-origin rows, or does every review row need an origin discriminator — and does the
   existence of such a discriminator itself weaken the immutability claim?
5. Who is the accountable support role for a stuck campaign, in an environment with no service-role, no telemetry sink and no
   impersonation?
6. Is the person-level correlation across providers (§17) a 16A concern or an explicit deferred limitation?

---

## 20. Specific recommended changes

**Correction of record (found in direct review, not by the lenses):** §1/§22/§23/§27 assert *"RISK-007 remains OPEN, Phase C
remains BLOCKED"* as a hard invariant, and §23 makes it a **testable acceptance criterion**. `docs/04:17` and `docs/59:6` state
*"RISK-007 is CLOSED at its staging-defined criteria (R-018/#291); Phase C is UNBLOCKED as a governance state only (R-019/#292)"*,
while `docs/55`, `docs/73` and `docs/security/OKTA_CONNECTOR_THREAT_MODEL.md` say OPEN/BLOCKED (accurately, for the Entra/Okta
live paths). The spec's blanket phrasing is conservative but not precise, and as an acceptance criterion it is **unverifiable**.
Restate as something 16B can actually verify: *"Phase 16 neither closes nor reopens any RISK-007 criterion and does not change the
Phase C authorization state; Okta and Entra remain `certificationOnly`; production remains untouched."*

**Ordered change list — all must land in `docs/74` before 16B may begin.**

*Authorization and principals*
1. Close §24 Q2 in-document: name the concrete tenant role behind every §14 column, or scope 16A to owner/admin attestation and cut
   the Reviewer/Approver/Observer personas from §4/§5/§14 accordingly. Enumerate the collateral grants if a lower role is used. (B1)
2. Declare reviewer onboarding an explicit precondition; define launch behaviour for an assignment naming a principal with no active
   membership. (B1)
3. State the active-tenant contract for `/reviews` and pick one of the three remedies in B13.
4. Declare the review surface evidence-self-sufficient; render `/access` cross-links only for owner/admin; cut the drift indicator
   (close Q9 as "not built") or make it owner/admin-only with mandatory "cannot compare" copy. (B2)
5. State that the snapshot is a deliberate, reviewed relaxation of the `0061` owner/admin boundary. (B2)

*Scale and launch*
6. Add `MAX_CAMPAIGN_ITEMS` (recommend 10,000 = `EXPORT_ROW_CAP`), enforced **at preview**, fail-closed, never truncating; state the
   resulting ~500–700-identity envelope in §1/§2. (B3)
7. Add a `Launching` state, a launch failure edge, an `expected_item_count` reconciliation, and a deterministic item natural key
   with a unique index. (B3)
8. Make launch fail-closed on enumeration completeness and persist a **population attestation** on the Campaign row. (B3, §7)

*State machine*
9. Rewrite §7 as a complete transition table with a **precondition** column and a compare-and-set concurrency rule per the
   `0044`/`0046`/`0047` precedent. (B6)
10. Add a `terminal?` column to §10; cut Deferred from the decision enum and model it as an item annotation; split §7.2's decision
    row by terminality; restate §9.4 completion and every progress figure as three numbers. (B5)
11. Exempt Decided items from the cancel cascade; add Extend to the machine; resolve `Reopened`; add a parent-campaign precondition
    to reopen; add `Draft/Scheduled → Cancelled`; delete the Draft hard-delete. (§5)
12. Either cut the approver from 16A or add `PendingApproval`, the `Approval` entity, and `approval.invalidated`. (B7)
13. Reclassify all six time-driven transitions as user-actioned, derived, or admin-sweep; cut auto-launch and automatic recurrence.
    (B4)

*Evidence, audit and data*
14. Specify a **new** review-domain audit table with a role- and assignment-scoped read policy; mandate transition-by-definer-RPC
    writing row + event in one transaction with server-set actor/timestamp; forbid `authenticated` DML on review tables; downgrade
    "tamper-evident"; name the existing `0010` audit-on-write precedent and the existing `/audit` route's conflicting DTO. (B8)
15. Mandate `ON DELETE SET NULL` plus write-time denormalized `actor_display_label` / `actor_principal_ref` /
    `actor_tenant_role_at_time` on every actor column. (B9)
16. Add `snapshot_schema_version`; freeze policy, evaluation status and scope into the snapshot; resolve `as_of_ref` (expose real
    run provenance, or delete the claim and record the limitation in §25). (B10)
17. Add a retention/disposition/legal-hold section; bound snapshot retention by the enrollment's `retention_days`; add every
    review-domain table to the `0047` `customer_scoped` erasure scope; make comments and labels redactable via tombstoning
    supersession. (B11)
18. Declare `comment` a distinct data class with a hard length bound, exclude it from CSV, and fix §12's self-contradiction. (B11)
19. State that subject references are unconstrained `uuid` + `connection_id` + `provider` with **no** FK; add
    `subject_no_longer_present`; state that stale ≠ deleted. (B12)

*Product completeness*
20. Define `scope_spec`; add `assignment_rule` + `fallback_reviewer` to Campaign; add an `Unassigned` state or forbid launch while
    any in-scope item is unmapped; delete "auto-assign by a designated access owner" or specify the mapping entity. (§4)
21. Add the attestation statement and its version to the Decision record. (§4)
22. Reduce §10 to five decision types. (§12)
23. Add the four auditor artifacts to §19; add an as-of stamp and the population attestation to every export; cut trend reports.
    (§9)
24. Delete §13's self-review warning and §25's SoD mitigation, or specify the user↔identity linkage as its own reviewed surface.
    (§6)
25. Specify the submit mechanism, record-and-next, keyboard flow, and the write-path accessibility contract; state that group-path
    provenance must be **complete** on the attestation screen (no `+N more`). (§8)
26. Cut the `Notification` entity; derive the badge. (§15)
27. Add an owner/admin assignment-health diagnostic and a support runbook, or state plainly that the surface is staging-only until
    a diagnostics sink exists. (B15)
28. Name the rollout gate and its authorizer; state §16's enablement mechanism and empty-state contract. (B16)
29. Specify the acceptance instrument, its write authorization, its target tenant, and the minimum review fixture — with named
    owners. (B14)
30. Classify §24 per §19 above; reconcile §26.5/§26.6/§20 with §24 Q1/Q3/Q6 so it is unambiguous which sections are binding; remove
    line 516 until the above are closed.

---

## Verdict

# NOT READY

`docs/74_ACCESS_REVIEW_PRODUCT_SPEC.md` is **NOT READY** for Phase 16B implementation.

**Justification.** The spec is a strong product vision with the right architectural primitives, and its remediation wall, frozen
evidence, and supersession model should be preserved verbatim. But it cannot be implemented as written:

- **24 blocking defects**, each of which determines physical schema, the authorization model, the scalability envelope, or a
  contractual/legal commitment — the four categories that cannot be deferred into implementation.
- **The three principals the product is built for do not exist** in the tenant role model, cannot be created by any product
  surface, and — if onboarded via the roles that do exist — receive blanket read access to employee HR attributes, contract costs,
  and the entire tenant audit log.
- **The core screen links the reviewer to a surface that renders "This doesn't exist"** to them.
- **Campaign launch cannot execute**: above the Phase-15 caps the engine computes nothing, below them no item bound exists, there is
  no job runner, and §3 forbids building one. There is no failure state for a half-launched campaign.
- **Six declared state transitions have no possible actor**, and the two notification events that make a deadline meaningful cannot
  fire.
- **The decision model contradicts itself** on the terminality of two of its seven types, and the completion rule, progress
  dashboard, reviewer badge and every report inherit that contradiction.
- **The audit trail has no decided home**; the candidate home is readable by every viewer and, under the spec's own "standard RLS +
  no service-role" leaning, would be client-forgeable. "Tamper-evident" is asserted with nothing behind it.
- **An immutable, undeletable store of employee personal data** is specified against a DB-enforced `retention_days CHECK 1..90` and
  a `customer_scoped` erasure commitment, with required unbounded free-text comments that no privacy, export or retention boundary
  in the document covers.
- **Attestations lose their attester** on ordinary offboarding.
- **§23 claims a verification story that does not exist**, against a verifier contractually barred from writing and a fixture that
  can generate exactly one review item in a tenant with no owner or admin.
- **§24's eleven "open questions" are not equal**: seven determine schema or authorization, and three are simultaneously decided in
  §20/§26 and deferred in §24 — so the document contradicts itself about what is binding, while closing with "Ready for Phase 16B
  implementation."

**Path to READY.** Apply the 30 changes in §20 — most of which *remove* scope rather than add it. The fastest credible route is to
re-scope 16A to what the platform supports today: owner/admin attestation only, a hard campaign-size cap aligned to the export cap,
no scheduler, no notifications entity, no approver sub-machine, no recurrence, no drift indicator, and five decision types. That
version is small, internally consistent, defensible, and buildable against the current schema — and it leaves every deferred concept
addable later without a migration rewrite. Once §24's seven schema/authorization questions are closed in-document and the state
machine is rewritten with preconditions, this spec becomes ready.

---
---

# Part II — Disposition against the revised specification

**Added:** 2026-07-27, after `docs/74` was re-scoped to **Access Attestations v1** (owner/admin only).
**Scope of this part:** the disposition of every required change from Part I, plus the blockers found during the revision itself.

**Disposition codes**
- **CHANGED** — the revised spec resolves the defect by design change.
- **DE-SCOPED** — the capability that carried the defect is now a §4 non-goal *and* appears in the §22 deferred roadmap with a named
  blocking dependency. The defect cannot occur because the feature does not exist.
- **DEFERRED** — accepted as real and still required, but explicitly scheduled outside 16A/16B with a named owner or gate.
- **REJECTED** — the finding is declined, with rationale. (Part I was largely correct; four items are rejected, three of them as
  factually imprecise and one as out-of-scope-by-design.)

## II.1 — Part I blocking findings

| # | Part I finding | Disposition | Where / rationale |
|---|---|---|---|
| B1 | Reviewer/Observer principals do not exist and cannot be created | **DE-SCOPED** | No new role type. Every principal is an existing `owner`/`admin` (§8). Roles, onboarding, invitations → §22 with the policy-narrowing migration and `admin-view.ts:52-53` named as dependencies |
| B2 | Reviewer cannot open the evidence the screen links to | **DE-SCOPED + CHANGED** | The persona that would be denied no longer exists; the surface is declared evidence-self-sufficient and the drift indicator is cut (§12.6). Drift → §22 |
| B3 | Launch cannot execute at scale; no bound; no failure path | **CHANGED** | `MAX_ATTESTATION_ITEMS = 500`, two explicit completeness gates, fail-closed refusal generating zero items, a stated envelope in-product (§16, §9 S3). 16B-3 must *measure* the freeze cost and confirm or lower 500 |
| B4 | Six transitions name a scheduler that cannot exist | **CHANGED** | Every time-driven transition removed. No due dates, expiry, recurrence, auto-launch, or auto-completion (§9, §10). Scheduling → §22 |
| B5 | Decision terminality self-contradictory | **CHANGED** | Five types, **all terminal**; `Deferred` cut; `False Positive` collapsed into `Not Applicable` (§11) |
| B6 | No transition preconditions; no concurrency model | **CHANGED** | Precondition column on both machines; §10.1 two-step guarded write with a per-write-kind guard table |
| B7 | Approval sub-machine missing | **DE-SCOPED** | No approver in v1 (§4). → §22 |
| B8 | Audit home undecided; forgeable; "tamper-evident" unbacked | **CHANGED** | New dedicated table, never `public.audit_logs` (§14.1, citing the `is_tenant_member` readership and the actor-withholding `/audit` DTO); definer-RPC-only writes with zero request-role DML (§14.4); the tamper-evidence claim **withdrawn** (§14.5). Hash chaining → §22 with a trigger condition |
| B9 | Attester attribution destroyed by offboarding | **CHANGED** | No FK anywhere; write-time actor snapshot split across row types (§13) |
| B10 | Snapshot has no provenance, version, or evaluation context | **CHANGED (version, context) + REJECTED in part (engine versions)** | `snapshot_schema_version` added; the evaluation policy pinned and recorded (§12.1). **Provenance is disclaimed rather than built** (§12.5) — the only run reference is `last_discovery_run_id`, which `0061` deliberately excludes. **Engine/policy version pinning is REJECTED for v1**: it would require adding an exported constant to the Phase 13/14 modules, which §4 forbids. → §22 |
| B11 | Immutable PII vs retention and erasure | **CHANGED** | Five data classes with a subject/object split, three redaction acts, read-time bound enforcement, one flat retention number (§15) |
| B12 | Canonical `subject_ref` integrity undefined | **CHANGED** | Plain `uuid`, **no FK**, tenant consistency by the §8.1 row predicate, `subject_no_longer_present`, and stale ≠ deleted (§12.3) |
| B13 | Multi-tenant reviewers unreachable | **CHANGED** | One rule: `p_tenant_id` is always the caller's active tenant; anything else is not-found (§8.2). The limitation is stated, not hidden. Tenant switching → §22 |
| B14 | No acceptance instrument; fixture cannot exercise a campaign | **CHANGED (designed) + DEFERRED (built)** | §20.2 specifies the write-acceptance workflow, its dedicated synthetic tenant, the fixture it needs (incl. the ≥1 group→application assignment the Phase-15 fixture lacks), and the `is_synthetic` marker as a 16A schema decision. **Implementation is explicitly a separately-authorised step** (§27) |
| B15 | Unsupportable by construction | **CHANGED** | Two-persona scope means the only actor is an owner/admin who can read their own tenant's full history (§17 screen 9, §19). Stated as the reason v1 is supportable where the multi-role design was not |
| B16 | No rollout gate; §24 open questions unclassified | **CHANGED** | §20.1 adds a concrete five-item rollout gate naming the `docs/73` isolated-v3 sunset condition and the authoriser, plus nav/enablement and empty-state contracts. All eleven original questions closed in §25 |

## II.2 — Findings raised in Part I outside the blocking set

| Theme | Disposition | Where |
|---|---|---|
| No reviewer-scope resolution; `scope_spec` undefined; no `assignment_rule`/`fallback_reviewer` | **DE-SCOPED** | Scope is an explicit selection from Phase 15 lists; there is no rule engine and no assignment (§7, §17 screen 2) |
| Self-review / SoD undetectable | **CHANGED to a disclosure** | v1 makes no SoD claim; the attesting and accountable party are the same by design, disclosed in §19 and made a §20.1 gate item. Enforcement → §22 |
| Reassignment does not revoke; reopen laundering | **DE-SCOPED** | No assignment model and no approver |
| Finding-anchored features unstable | **CHANGED** | `False Positive` collapsed; finding ids are not stored; the reason is stated accurately in §11 |
| `ReviewItem` denormalised mutable pointers | **CHANGED** | The current decision is **derived**, not stored (§10) |
| IDOR on a new stable id space; no write-side not-found contract | **CHANGED** | §10.1 step 1 gives one uniform not-found on every write path; §19 states it; a §23 criterion tests it |
| CSRF / idempotency / audited GET | **CHANGED** | Server actions for state changes; guarded writes for idempotency; the export keeps its GET route handler (headers require it) with a mandatory same-origin check before its audit write (§18) |
| Export cap blocks the audit deliverable | **CHANGED** | `MAX_ATTESTATION_ITEMS = 500 ≪ EXPORT_ROW_CAP = 10,000`, so a v1 export is always whole (§16.1) |
| Reporting missing the four auditor artifacts | **DE-SCOPED, and disclosed** | v1 ships one export and states plainly it is a **decision register, not a complete audit artifact**, because rationales are withheld as PII (§1, §18). Auditor artifacts → §22 |
| Reviewer queue model; submit mechanism; provenance truncated in the browser | **CHANGED** | No queue exists; the submit contract is specified (§17 screen 6); truncation is always rendered "N of M" and never called complete (§16.2, §17 screen 5) |
| No write-path accessibility contract | **CHANGED** | §17 specifies error, focus, and announcement semantics for the decision form |
| Completion overstates attestation; bulk keep undecided | **CHANGED** | Completion requires **every** item `Decided`; bulk decisions are not permitted in v1 (§4, §11) |
| Cancel repudiates attestations | **CHANGED** | Cancellation leaves every `Decided` item `Decided`; S6 additionally refuses on any set that was ever completed (§9) |
| `Reopened` phantom; `Extend` outside the machine; event catalogue incomplete; state authority undecided; recurrence underspecified | **CHANGED / DE-SCOPED** | `Reopened` is a real state with one exit; `Extend` and recurrence do not exist; §14.3 carries a full mapping table and an explicitly **non-bijective** claim; the state column is the present and the trail the history, written in one transaction (§10) |
| Notification entity; trend reports | **DE-SCOPED** | Both cut (§4) |
| Drift shown but not recorded | **DE-SCOPED** | No comparison is performed (§12.6) |

## II.3 — Findings from Part I that are REJECTED

| # | Claim | Rejection rationale |
|---|---|---|
| R1 | *"`retention_days` CHECK 1..90 is a DB-enforced retention promise that an immutable snapshot store would breach."* | **Factually imprecise, and materially so.** `retention_days` is a **nullable** column on `connector_pilot_enrollments` (`0047:53,74`), scoped per enrollment, and the table carries `check (environment = 'staging')` (`0047:67`) — so **no production tenant can hold an enrollment at all**. It binds staging pilot discovery artifacts, not a tenant. The revised §15.1.1 records this and sets v1's own flat `ATTESTATION_PII_RETENTION_DAYS = 400` instead of coupling to a constraint that cannot reach the relevant population |
| R2 | *"16B must add every attestation table to the `0047` `customer_scoped` deletion-scope enumeration."* | **Not actionable — the artifact does not exist.** `customer_scoped` is one of two values of a text CHECK (`0047:159`) on a workflow that is metadata-only and *"still deletes nothing"*. There is no table list to add to. §15.3 now states plainly that v1 has **no** tenant-scoped customer erasure workflow and defers one to §22, rather than carrying an unfalsifiable acceptance checkbox |
| R3 | *"Governance findings have no cross-request stable identity."* | **Imprecise.** `docs/71` defines a deterministic content-hash identity that is byte-identical for the same input and policy. The accurate statement — now in §11 — is that the id is *derived from the graph and therefore changes when the graph changes*, which is why it is not a durable cross-cycle anchor. The conclusion (no finding-anchored review unit in v1) is unchanged; the reasoning is corrected |
| R4 | *"Add a reviewer-scoped canonical read path so reviewers can open `/access` evidence."* | **Out of scope by design.** Part I offered this as one of two options; v1 takes the other. Building a new authorization surface over deny-all canonical tables is precisely the kind of unreviewed expansion the re-scope exists to avoid. Deferred (§22) behind the role work |

## II.4 — Blockers found *during* the revision, and their disposition

These were not in Part I. They were found by adversarial review of the revised draft itself, across two further rounds.

| # | Defect in the revised draft | Disposition | Fix |
|---|---|---|---|
| N1 | The write RPC's compare-and-set carried **no tenant predicate**, so an owner/admin of tenant A could write tenant B's rows. `SECURITY DEFINER` bypasses RLS, so the read policy gave no protection, and the cited `0044` CAS precedent has no tenant dimension | **CHANGED** | §8.1 mandates the in-body role check **and** `tenant_id = p_tenant_id` on every statement, following `0061:172` rather than `0044`; the RLS-bypass fact is stated explicitly; a cross-tenant write test is a §23 criterion and a §20.2 check |
| N2 | Identifying actor PII sat on the audit table, which carries a blanket reject trigger — making it permanently un-redactable while §15 claimed that table held none | **CHANGED** | §13 splits the actor snapshot: opaque id + role on audit rows, labels only on decision rows where a column-scoped trigger permits redaction |
| N3 | `reason` was **unbounded free text on that same un-redactable table** — and the redaction act itself required one | **CHANGED** | §14.2.1 makes `reason_code` a bounded enum on the event; every free-text note, title, and purpose lives on a domain row with a redaction path. No audit event row contains free text |
| N4 | The evaluation policy (`include_stale`) was never pinned, leaving the item population undefined and two decision types unreachable | **CHANGED** | §12.1 pins `include_stale = false`, removes the unreachable `stale_only` field, rewrites the `Insufficient Evidence` triggers, and discloses the excluded population |
| N5 | Retention was bound to `min(tenant retention, connector retention_days)` — unimplementable (deny-all tables, staging-only enrollments) and referencing an undefined term | **CHANGED** | §15.1.1's single flat number makes read-time enforcement a pure timestamp comparison |
| N6 | The export was specified as a POST server action that also set CSV response headers — **structurally impossible** | **CHANGED** | §18 restores the GET route handler (the only thing that can set the headers) and adds a mandatory same-origin check before the audit write |
| N7 | `MAX_SNAPSHOT_BYTES = 16 KB` was **smaller than the largest snapshot its own truncating caps permit**, so a fully in-bounds item would fail-close | **CHANGED** | Raised to 64 KB with the arithmetic shown (§16.1) |
| N8 | §14.3 asserted a false event↔transition bijection; §14.5 asserted a no-UPDATE absolute that every state transition falsifies | **CHANGED** | A full mapping table and an explicitly non-bijective, checkable property (§14.3); §14.5 scoped to decisions and audit events |
| N9 | Class-B redaction erased the **object** of the attestation (which application) along with the subject | **CHANGED** | §15.2 splits B-subject (redacted) from B-object (retained); §12.4 records the verified fact that makes this sound — `governance-presenter.ts` exposes `RuleProse` as a **static per-rule table with no subject interpolation**, so frozen finding text carries no personal data |
| N10 | An item whose subject evidence was suppressed remained decidable and still blocked completion | **CHANGED** | §10: such an item cannot receive a new decision and is excluded from the completion precondition |
| N11 | Definer-function ownership, `search_path`, and EXECUTE grants were unspecified despite citing `0044`/`0047` | **CHANGED** | §14.4 specifies all three plus the `0045` default-privileges regression assertion |
| N12 | `actor.redacted` was per-set, but an attester's erasure obligation spans every set they decided in | **CHANGED** | §15.3 makes it tenant-wide for one `actor_user_id` |
| N13 | The 500-item envelope was asserted, never derived; the preview was claimed identical to the open across a live graph | **CHANGED** | §16.3 states 500 is a conservative reviewed starting value with a named 16B-3 measurement gate, and that the **preview is advisory, the open authoritative** |

## II.5 — Accepted limitations of v1, disclosed rather than fixed

These are real weaknesses that v1 keeps. Each is stated in the product, not buried.

1. **No separation of duties.** The attester and the accountable party are the same person, and self-attestation is undetectable
   (§19). Disclosure to the customer is a §20.1 gate item.
2. **The export is a decision register, not a complete audit artifact** — it withholds rationales as PII (§18).
3. **No source-system provenance.** The snapshot evidences IDCaddie's read of its own store, not the provider's state (§12.5).
4. **Not tamper-evident**, only append-only (§14.5).
5. **Current-access only.** Stale-only access is outside every v1 attestation, disclosed on the set and in the export (§12.1).
6. **500 relationships per set**, and a tenant above the Phase-15 evaluation caps cannot create a set at all (§16.3).
7. **No tenant-scoped customer erasure workflow** — only whole-tenant deletion plus field-level redaction (§15.3).
8. **Single active tenant** per user, with no switcher (§8.2).
9. **An audit event's actor may render as role + opaque id** where that set holds no decision by that actor (§17 screen 9) — the
   accepted price of keeping identifying fields off the un-redactable table.

## II.6 — Final gate result: NOT READY (four unresolved blockers)

Three adversarial verification rounds were run against the revised spec (4 independent auditors + refutation in round 1, 3 + refutation
in rounds 2 and 3). Progress across rounds, against the eleven READY criteria:

| Round | Blocking findings | Gate criteria passing |
|---|---|---|
| Part I (original spec) | 24 | — (not assessed; spec was NOT READY on every axis) |
| Round 1 (first revision) | 4 | 8 / 11 |
| Round 2 (after fixes) | 4 | 8 / 11 |
| Round 3 (after fixes) | 4 | 7 / 11 |

**Settled and stable across all three rounds** — criteria 1 (role model), 2 (scheduler), 4 (audit home), 5 (actor retention),
7 (bounded launch), 8 (write authorization), 10 (remediation boundary) pass unanimously in every round. Criterion 3 (terminal states)
passes in 2 of 3. These are genuinely resolved.

**Not settled** — criteria 6 (retention/erasure), 9 (Phase-15 inheritance) and 11 (no unresolved blocker). The four causes are
recorded as **U1–U4 in `docs/74` §26.0** and summarised here with the options:

| # | Blocker | Options |
|---|---|---|
| **U1** | The `include_stale = false` pin filters **nodes**, not only edges (`0061:51`, `access-loaders.ts:73`), so four snapshot fields are constants, one `Insufficient Evidence` trigger is unreachable, and a current assignment to a stale identity leaves the population silently | (a) delete the freshness fields, rewrite §11's trigger list, and add a disclosed count of dropped relationships; or (b) run a second stale-inclusive evaluation solely to populate freshness and the dropped count — a scope change needing its own §16 bound |
| **U2** | The freeze payload is necessarily computed in Node and passed **into** the definer RPC, so §12.4's "structural property, not a review promise" and §12.3's "a read it performed" are both false; supplied finding text lands in class B-object, which no redaction act clears | (a) store `rule_id` + a `rule_prose_version` only, so the RPC persists a bounded enum and the no-PII property becomes genuinely structural; or (b) keep frozen text and give class B-object a redaction path plus an explicit statement that its integrity is an application-layer review promise |
| **U3** | §12.4's finding-population key (`subject_type` + `subject_id`) cannot express an application-subject finding shared across items, nor the pair-subject case | Define the key precisely — most likely per-item match on identity OR application OR pair, with an explicit rule for shared application findings and a stated effect on `findings_total_count` |
| **U4** | `subject_no_longer_present` has no producer: detecting it needs a live-graph read that §12.6 forbids, and under the pin a stale subject is indistinguishable from an absent one | Drop the state (recommended — it exists to solve a problem the no-FK design already handles), or reopen a bounded live read, which conflicts with §4 |

**Assessment.** U1 and U2 are errors introduced by this revision, not carried over from Part I: both are consequences of asserting a
property of the Phase 15 platform that the code does not have. U3 and U4 are gaps in newly-added sections. All four are bounded and
local — they touch §11, §12 and §15 — and none reopens the settled architecture (roles, scheduler, audit home, actor retention,
write authorization, bounds, remediation boundary).

**Recommendation.** Close U1–U4 as a single focused pass over §11/§12/§15, then re-run the gate. Do not begin 16B until §26.0 is
empty.

---

# Part III — U1–U4 closure pass

**Added:** 2026-07-27, third revision session. Scope: resolve U1–U4, propagate, re-gate.

## III.1 — U1 disposition: **PARTIALLY RESOLVED**

**Root cause, verified this session.** The two Phase-15 read paths have different semantics, and the spec was using the wrong one:

| | Whole-tenant list path | Per-subject subgraph path |
|---|---|---|
| Edges | filtered by `sync_status` | filtered by `sync_status` |
| **Nodes** | **also filtered** (`0061:51,72,94`; `access-loaders.ts:73` passes the flag to all six) | **not filtered** — identity read `where id = … and tenant_id = …` (`0061:172-174`); groups/applications read by id from edge-derived arrays (`0061:194-195,203-204`) |

**Resolved for the evidence read.** Evidence is now frozen from the per-subject subgraph, so a current assignment to a stale
identity or application survives with its true `sync_status`/`stale_since`. This also makes `direct_assignment_with_stale_endpoint`
(`docs/71` rule 5) reachable, which is what gives `Insufficient Evidence` a real trigger.

**Not resolved for scope selection** — recorded as blocker **V1** in `docs/74` §26.0. A scope picker can only read the
node-filtered list RPCs (there is no `/access/identities` or `/access/applications` index route to reuse), so a stale subject cannot
be selected, and a relationship whose *both* endpoints are stale is unreachable. Two options are documented; choosing between them
is a product decision, not a mechanical fix.

**Sections changed:** §11 (trigger table), §12.1, §12.1.1 (four completeness axes), §12.1.2 (reused / not-reused / purpose-built
reads), §12.1.3 (item population + dedup + Gate 2 placement), §12.2 (observation model), §16.1 (two gates, distinct reasons),
§16.3 (preview is a lower bound), §9 S3, §17 screens 2–3, §18, §22, §23, §24.

## III.2 — U2 disposition: **RESOLVED**

The false claim ("a structural property, not a review promise") is withdrawn and replaced by §14.4.1, which states the trust
boundary in three layers and enumerates what the database **can** prove (role, tenancy, ownership, schema version, bounds, enums,
control characters, canonical-id tenancy) and what it **cannot** (that a descriptive string came from a Phase 15 read).

The design was then changed so the property becomes structural where it matters: **findings are stored as bounded structured
observations with no free text** (§12.4) — enums, integers, uuids, booleans, timestamps only. This removed the un-erasable PII
channel entirely rather than adding a redaction act to clear it. Customer prose is derived at render time from `RULE_PROSE` keyed by
`rule_id` + `rule_prose_version`.

Six PII classes (§15.2) each specify: stored, max size, exported, searchable, retention, pseudonymisation/erasure, legal hold.
The document claims **data-minimised, classified, bounded, retained and pseudonymisable** — never "no PII" except as an explicitly
scoped statement about class E.

**Sections changed:** §12.2, §12.4, §14.4.1 (new), §15.2, §16.1, §18, §23, §25.

## III.3 — U3 disposition: **RESOLVED**

Finding observation, attestation item, and their association are now three separate concepts. A `FrozenFindingObservation` belongs
to the **set**; an `AttestationItemFindingLink` associates it with zero, one, or many items. Link rules are given for all six
`GovernanceSubjectType` values. The durable key is a snapshot-local `observation_id` minted at launch; the live content hash is
stored as `source_finding_hash` **provenance only** and is never joined on. A set-local dedup key prevents duplicate observations,
and counting discipline (observations, never links) prevents inflated counts in the UI and the export.

**Sections changed:** §12.4, §12.4.1 (new), §16.1 (`MAX_FINDING_OBSERVATIONS`), §18, §23, §24.

## III.4 — U4 disposition: **RESOLVED BY REMOVAL**

`subject_no_longer_present` and every drift outcome are removed (§12.6). Option 1 was taken: Option 2 needs a purpose-built bounded
live-read contract, a five-value result taxonomy, and its own UI — substantial 16B widening for no v1 requirement. A link to the
live `/access` view remains and is safe here specifically because v1's only actor is owner/admin, the exact gate `/access` enforces.
No comparison is computed, stored, or inferred. Deferred in §22.

**Sections changed:** §12.2, §12.3, §12.6, §22, §25.

## III.5 — Architecture consequences

1. **The evidence source changed.** `loadAccessOverview` is now used *only* for the Gate 1 size check; it is disqualified as an
   evidence source. This inverts a decision made in the previous revision (which had removed the per-subject gate as "redundant") —
   the two reads are not interchangeable.
2. **Two gates, different jobs.** Gate 1 (tenant size, at preview) and Gate 2 (per-subject completeness, at open) are not redundant.
3. **The preview is a lower bound, not an estimate** — it is computed from the node-filtered path, so the frozen count can be higher.
4. **Findings left the snapshot.** They are set-scoped, so `MAX_SNAPSHOT_BYTES` drops from 64 KB to 32 KB.
5. **A new caution for 16B:** a field whose only producer is a state the gate refuses is not a field. This caught `subgraph_bounded`
   in this very pass (see III.7).

## III.6 — Deferred (unchanged scope, now with named dependencies)

Reviewer/approver/observer roles · delegated assignment · SoD enforcement · scheduling, recurrence, due dates, expiry ·
notifications · manager/department/application-owner scoping · background jobs · **drift monitoring and any live comparison** ·
sets above `MAX_ATTESTATION_ITEMS` · source-system provenance · engine/policy version pinning · **a versioned finding-prose
registry** · cryptographic tamper-evidence · cross-provider person correlation · bulk decisions · finding-anchored attestation ·
multi-tenant working · **stale-inclusive edge evaluation** · rationales in the export.

## III.7 — Remaining risks

- **V1 (open)** — scope selection cannot see stale subjects. §26.0.
- **Self-inflicted defects in correction passes.** Two of the four U-blockers were introduced by the previous revision, and this
  pass introduced `subgraph_bounded` (a fifth `Insufficient Evidence` trigger whose only producer is the state Gate 2 refuses),
  caught and removed within the same pass. The document is large and heavily cross-referenced; each correction round has produced at
  least one new local defect. Future passes should re-gate before claiming closure.
- **The final gate ran incomplete** (§III.8), so areas covered only by the two lenses that did not run are unverified this round.

## III.8 — Final gate result: **NOT READY**

The final adversarial gate was specified with six lenses plus independent refutation plus a completeness critic. **It did not
complete**: 4 of 6 lenses returned; **all 6 refutation agents and the completeness critic failed on a session limit**. Two lenses
(privacy/retention, state-machine/producer completeness) never ran.

Of the findings that did return, two BLOCKERs were **independently verified against the repository** by the reviewer rather than
accepted on trust:

| ID | Blocker | Verified how | Disposition |
|---|---|---|---|
| **L1-01** | Scope selection still drops stale nodes | `find src/app/(authenticated)/access -name '*.tsx'` returns no index route for identities or applications; the only candidate reads are the node-filtered list RPCs | **Open — recorded as V1** in §26.0. Needs a product decision between two documented options |
| **L1-02** | `subgraph_bounded` can never be true, so `Insufficient Evidence` trigger 5 is dead | Internal contradiction: §16.1 Gate 2 + §9 S3 + §12.1.3 all refuse the open when any subject is bounded | **FIXED in this pass** — field and trigger removed; §11 now lists four triggers, all reachable |

**Verdict: NOT READY.** Three independent reasons, any one of which is sufficient:
1. Blocker **V1** is open, so §26.0 is not empty.
2. U1 is only partially resolved.
3. The gate itself did not complete — two required lenses, all refutation, and the critic did not run, so "no further blockers" is
   not a claim this session can make.

**Recommended next pass:** decide V1 (option (a) is the better fit for a product whose value is coverage), propagate to §12.1,
§12.1.3, §16.3, §17 screen 2, §20.1 and §23, then re-run the full six-lens gate **to completion** before any READY claim.

---

# Part IV — V1 closure pass

**Added:** 2026-07-27, fourth revision session. Scope: resolve blocker V1, propagate, and complete the previously interrupted gate.

## IV.1 — V1 verified root cause

Re-verified from the repository this session, not carried over:

- `src/app/(authenticated)/access/` contains **only** `page.tsx`, `findings/page.tsx`, `identities/[id]/page.tsx`,
  `applications/[id]/page.tsx`. There is **no index route** for identities or applications.
- `loadAccessOverview` returns counts, breakdown, summary and findings — **no node rows** (`access-loaders.ts:92-99`).
- Therefore the only reads that can populate a scope picker are `listDirectoryIdentities` / `listDirectoryApplications`, whose RPCs
  apply `(p_include_stale or x.sync_status = 'current')` to the **node** row (`0061:51`, `0061:94`).
- With `p_include_stale = false`, a non-current subject is not listed, cannot be selected, and its current assignments never enter a
  set. Where both endpoints were non-current the relationship was reachable from neither side.

The previous pass fixed the **freeze** (per-subject subgraph, which filters edges but not nodes). It did not fix the **enumeration**
that precedes it.

## IV.2 — Product decision

**The attestation scope picker enumerates current and non-current candidates**, by calling the existing repository contract with
`includeStale: true`.

- **No Phase 15 code changes.** `listArgs` maps `p_include_stale: o.includeStale === true` (`access-repository.ts:48`) — an explicit
  per-call opt-in defaulting to `false`. Every existing `/access` caller omits it, so the shipped surface is provably unaffected.
  Phase 16A specifies *how 16B calls* an existing contract.
- 16B carries a regression test asserting no existing `/access` caller passes `includeStale` (§27, 16B-6).

## IV.3 — Candidate enumeration contract

`listDirectoryIdentities(tenantId, { includeStale: true, afterId, limit })` and the application equivalent. Each RPC re-checks
`has_tenant_role(p_tenant_id, {owner,admin})` in-body and filters `x.tenant_id = p_tenant_id`; `p_limit` is server-clamped to 100;
pagination is keyset by `id`. Totals come from `getAccessCounts`, which is **stale-agnostic** and is therefore the correct
denominator for a picker showing every freshness state.

**Freshness model — four states, not three.** `sync_status` is `NOT NULL` with a DB CHECK of exactly
`('current','stale','review_required','disconnected')` (`0053:44,53-55`; `0057:48,57`), and the runtime zod enum is identical
(`access-rpc-types.ts:14`). The migration's own vocabulary (`0053:51-52`) is used verbatim: *current* = seen in the latest complete
run; *stale* = absent from a complete run; *review_required* = circuit breaker fired; *disconnected* = connection disconnected.

**"Freshness unavailable" was rejected — it has no producer.** The column cannot be null and cannot hold an out-of-enum value, so no
row can arrive without valid freshness. Introducing it would repeat the `subgraph_bounded` defect. The two real sub-cases are stated
instead: `stale_since` is nullable ("since unknown"), and **no last-observed timestamp exists anywhere** — `last_discovery_run_id`
is excluded from every 0061 RPC, and `stale_since` records when confirmation stopped, not when the row was last seen.

**Filter contract: All (default) · Current · Not current.** Deliberately **not** Current/Stale/All: a "Stale"-only option would hide
`review_required` and `disconnected`, reintroducing the omission through the filter instead of the read.

## IV.4 — Selection / freeze separation

Three steps, explicitly separate (§12.1.4): **enumerate** (read-only, references only, persists nothing, infers no completeness) →
**select** (canonical row ids stored as *draft scope intent* only; tenant ownership revalidated; bounded) → **open/freeze** (server
resolves via per-subject subgraphs; runtime validation; database authorization and canonical-id revalidation; versioned snapshot
written; Open only if every hard gate passes).

**Visibility in the picker is not a completeness guarantee.** The open/freeze step remains the authoritative evidence gate.

## IV.5 — Stale-node behaviour

All three node kinds are freshness-safe:

| Node | How it survives |
|---|---|
| Identity | selectable in the picker; the subgraph reads it `where id = … and tenant_id = …` with no sync filter (`0061:172-174`) |
| Application | selectable; read by id from the edge-derived array with no sync filter (`0061:203-204`) |
| Group | **not** selectable and does not need to be: reached from current membership edges, then read `where id = any(v_group_ids)` with **no sync filter** (`0061:176-196`), and frozen into `group_path_observations[].state` |

## IV.6 — Both-endpoints-stale limitation, stated honestly

A relationship survives whenever a **current edge** supports it, regardless of either endpoint's freshness — so a non-current
identity with a current assignment to a non-current application is selectable and does freeze. What v1 does **not** do:

- resolve a relationship supported **only by a non-current edge** (`edge_inclusion = current_only`; stale-inclusive *edge*
  evaluation deferred, §22);
- reconstruct a relationship the current canonical graph no longer contains (no provider history is read).

Five conditions are kept distinct and must never be collapsed in copy: stale node metadata · non-current relationship observation ·
missing relationship · incomplete computation · unavailable evidence.

**Scope-resolution outcomes** (§12.1.3), each with a producer: `resolved`, `no_reviewable_relationship`, `subject_not_resolvable`,
`evidence_unavailable`, `excluded_by_bound`. A subject yielding nothing **never** produces an empty item and is never silently
dropped — the outcome is shown in the draft and the subject can be removed. None of these is a live-drift determination;
`subject_not_resolvable` reports that an id does not resolve *now*, not that something was present and has gone.

## IV.7 — Bounds

Six classes, separately specified (§16.1): candidate enumeration (`MAX_CANDIDATE_PAGE = 100`, server-clamped, paginated —
pagination carries **no** evidence meaning); draft selections (`MAX_DRAFT_SELECTIONS = 250`); evidence-freeze reads
(`SUBGRAPH_MAX_ROWS`, Gate 2, fail-closed); attestation items (`MAX_ATTESTATION_ITEMS = 500`); frozen finding observations
(`MAX_FINDING_OBSERVATIONS = 500`, applied after dedup); exports (`EXPORT_ROW_CAP = 10,000`).

Three anti-conflation rules (§16.3): no silent first-page behaviour; a paged candidate list is not a scope claim ("showing N of M"
always visible); a bounded underlying read is never called complete.

## IV.8 — Insufficient Evidence producer verification

§11 is now a full matrix — trigger code, producer, evaluation point, stored representation, user-facing wording, effect on the
decision form. Six triggers with producers (`stale_endpoint`, `unavailable_endpoint`, `incomplete_group_path`,
`incomplete_findings`, `stale_since_unknown`, `catalog_unmatched`) plus decider judgement.

**Four candidate triggers were rejected for having no producer at item level**, and the reasoning is recorded so it is not
relitigated: `subgraph_bounded` (Gate 2 refuses first; survives only as the draft-time `excluded_by_bound`),
`evidence_read_failed_or_partial` (fail-closed before item creation; survives as `evidence_unavailable`),
`subject_no_longer_present` (needs the live comparison v1 removed), and `source_freshness_unavailable` (freshness is never unknown —
NOT NULL + CHECK + matching zod enum).

## IV.9 — Sections changed

§4 (non-goals wording: stale-inclusive **edge** evaluation, node freshness supported) · §7 story 2 · §9 S2 (draft scope intent,
selection bound, id revalidation) · §11 (producer matrix + rejected triggers) · §12.1.3 (scope-resolution outcomes,
both-endpoints-stale, five distinct conditions) · §12.1.4 (**new** — three-step contract, freshness model, filter contract, group
coverage) · §16.1 (`MAX_CANDIDATE_PAGE`, `MAX_DRAFT_SELECTIONS`) · §16.3 (pagination-is-not-completeness) · §17 screens 2 and 3 ·
§22 (edge-vs-node deferral corrected) · §23 (six new criteria) · §24 (three new risk rows) · §25 · §26.0 (V1 recorded resolved;
standing producer rule) · §27 (16B-6 scope).

## IV.10 — V1 disposition

**RESOLVED.** Every dependent section is propagated: enumeration contract (§12.1.4), resolution outcomes (§12.1.3), producer matrix
(§11), bounds (§16), UI (§17), acceptance (§23), risks (§24), sequencing (§27), and §26.0 records no open blocker.

> **Superseded by Part V.** The campaign/item architecture that Parts I–IV reviewed has since been **deferred** in favour of a
> hybrid application-level model. Parts I–IV are retained as the evidence base for that decision. The ten-lens gate that was running
> against the campaign model was interrupted and its findings are moot against the replacement architecture.

---

# Part V — Product pivot: hybrid Application Governance Attestations

**Added:** 2026-07-27, fifth session. **Prior review history in Parts I–IV is retained unchanged** — it is the evidence base for
this decision, not superseded noise.

## V.1 — Product decision

Phase 16 v1 is now **Application Governance Attestations**: the old IDCaddie application-level workflow
(*Application → review evidence → Approve or Flag → immutable history*), enriched with V3 access-graph evidence.

The enterprise campaign / per-identity-item architecture specified in Parts I–IV is **deferred, not discarded** (`docs/74` §14).

## V.2 — Why the old workflow was selected

Parts I–IV are the argument. Across four adversarial rounds the campaign model never reached READY, and the failures were
structural rather than editorial:

- It needed reviewer / approver / observer principals that `tenant_memberships.role` does not contain (`0001:27`), and that no
  product surface can create (`admin-view.ts:51-53`).
- It needed a scheduler for expiry, recurrence and reminders; none exists and the spec's own non-goals forbade building one.
- It needed a delegation and onboarding surface that does not exist.
- Each correction round introduced at least one new producer-less field or internal contradiction — `subgraph_bounded`,
  "Freshness unavailable", the screen-3 timing contradiction — because the design was outrunning its substrate.

The old workflow needs none of that: one actor role that already exists, no scheduling, no assignment, no delegation. It is the
version that can actually ship, and it is what the product already proved with customers.

## V.3 — How V3 evidence improves it

The old snapshot was `appUsers.length` and `activeUsers`, computed in the browser from client state (`:441-455`). The V3 snapshot is
server-assembled from the canonical graph: effective identity count, DIRECT/GROUP/BOTH classification, governance findings by
severity, freshness, and an explicit completeness state. The old workflow recorded *that* a review happened; the hybrid records
*what was true* when it happened.

## V.4 — Old-app behaviours retained

Application-level scope · three review types with their labels and compliance references (`:382-386`) · two outcomes · optional note
· four cadences · current/overdue/never computed on read · immutable chronological history · newest-first ordering.

## V.5 — Old-app weaknesses deliberately not copied

Nine, each verified by line and each with a stated v1 treatment in `docs/74` §1.1: client-composed reviewer identity (`:428-433`) ·
direct browser→Firestore write (`:458-461`) · client-authored snapshot (`:441-455`) · two clocks for one event (`:434` vs
`:470,483`) · a mutable denormalised mirror that can drift (`:466-474`) · an **unordered error-fallback query** that makes "latest"
arbitrary (`:241-244` vs `:233-234`) · unbounded notes · day-approximated cadence (`:388-393`) · broad client-side authorization.

## V.6 — The material evidence finding

Verified this session and recorded in `docs/74` §4: **the three review types are not equally supported by V3.**

- *User Access Review* — richly supported.
- *Configuration & Security Review* — partly supported.
- *Business Justification* — **almost no V3 evidence exists.** `business_justification` and `data_classification` return **zero grep
  hits** across `supabase/migrations/` and `src/lib/`; business/technical owner and contract count live on `public.apps` with **no
  join path** from `directory_applications` (`catalog_product_id` targets `app_products` and `0057` leaves it NULL/unmatched); cost
  is both unjoinable and forbidden by the `docs/71`/`docs/72` truthfulness boundary; privileged/high-risk counts have no attribute
  in `docs/71` at all.

All three types are kept, with the gap represented as explicit `unavailable_in_v1` states rather than fabricated values. Enriching
Business Justification is a documented upgrade gated on the catalog link.

## V.7 — Enterprise features deferred

Per-identity certification · campaigns · delegated reviewers · application owners as reviewers · manager attestations · reviewer
inbox · approvals · separation of duties · recurrence · scheduled launches · reminders · escalation · notifications ·
finding-level dispositions · remediation · provider mutation · ticket integration · drift comparison · bulk decisions · enterprise
certification reporting. Each is listed in `docs/74` §14; the six with hard platform dependencies carry their named blocker.

## V.8 — Blocker disposition

| # | Blocker (origin) | Disposition |
|---|---|---|
| **U1** | Evidence read dropped non-current nodes | **NO LONGER APPLICABLE** — v1 has no per-identity scope selection or freeze. Application-level evidence comes from `loadApplicationAccessDetail`, whose subgraph read does not filter nodes |
| **U2** | False structural PII claim; finding prose stored unredactable | **RESOLVED and carried forward** — `docs/74` §7 states what the database can and cannot prove; findings are stored as counts by severity only, never prose |
| **U3** | Finding modelled per-item could not express application-scoped findings | **NO LONGER APPLICABLE** — the attestation subject *is* the application, so an application-scoped finding count is the natural grain. No link table needed |
| **U4** | `subject_no_longer_present` had no producer | **NO LONGER APPLICABLE** — no drift concept exists in v1 (`docs/74` §11) |
| **V1** | Scope selection could not enumerate non-current subjects | **NO LONGER APPLICABLE** — there is no scope picker. The attestation targets one application the user is already viewing |
| — | The 42 findings from the interrupted campaign-model gate | **MOOT** — they were against an architecture now deferred. Retained in Part IV for the record; none carries into the hybrid model |

**The pivot dissolves rather than fixes most of the prior blocker set** — which is itself the strongest evidence that the campaign
model was the wrong size for the platform.

## V.9 — Readiness assessment

The hybrid model's *architectural* risk profile is materially lower than the campaign model's: one existing role, no scheduler, no
delegation, no state machine, one new primary entity, evidence reused from an already-accepted loader. That judgement stands.

**The specification itself, however, is NOT READY** — see §V.10.

## V.10 — Ten-lens gate result: NOT READY

The full gate ran to completion: **10 lenses + 10 independent refutations**, 13 findings refuted, **54 surviving, 7 blockers,
9 of 10 lenses failing** (only `tenant-authz` passed). Findings cluster into **eight root causes**, recorded as B1–B8 in
`docs/74` §19.

**Three blockers were verified by direct repository inspection rather than accepted on trust:**

| Blocker | Verification |
|---|---|
| **B1** — `application_status_category` has no producer | `ApplicationAccessDetailData` (`access-loaders.ts:39-43`) exposes no `status_category`; §4.2 makes it required-to-submit, so Business Justification would block 100% of the time |
| **B2** — `includeStale` never pinned | `loadApplicationAccessDetail(applicationId, includeStale = false)` takes the flag; every frozen count depends on it; the spec never fixes it and the snapshot never records it |
| **B3** — reviewer role has no trusted source | `has_tenant_role` returns **boolean** (`0001:238`), not a role; §8's "the role `has_tenant_role` just verified" cannot be implemented as written |

The remaining blockers (B4–B8) are internal contradictions: redaction mandated and forbidden simultaneously; a retention promise
with no permitted enforcement mechanism; a form that cannot show the evidence it will freeze; a cadence capability with no
authorization row, UI, write path, or PR — which also silently regresses a control the old app had (`page.tsx:1305-1312`); and two
fields rendered and exported but never defined.

### V.10.1 — Honest process observation

Three of the eight root causes are the **same error repeated**: asserting a field is available without checking the actual return
type of the read path the spec binds itself to. B2 (unpinned evaluation policy) and B6 (preview vs authoritative freeze) were both
**solved in the deferred campaign model and reintroduced here**.

This is the fifth full specification cycle for Phase 16A. Each cycle has produced a materially better architecture and a fresh crop
of local defects. The pattern suggests the next pass should not be another full rewrite but a **narrow, verified correction of
B1–B8**, with each fix checked against the concrete return type or capability it depends on before it is written down.

### V.10.2 — Recommended next pass

1. Decide B1: add a named Phase-16 read for `status_category`, **or** demote it to explicitly-unavailable and shrink Business
   Justification's frozen set accordingly (it then freezes little more than the application label and a constant).
2. Pin `includeStale` explicitly and record it in the snapshot (B2).
3. Source the reviewer role from `tenant_memberships.role`, not `has_tenant_role` (B3).
4. Decide whether redaction and retention exist in v1 at all — if yes, give them a capability row, an audit event, and a PR; if no,
   remove the promises (B4, B5).
5. Adopt the "preview is advisory, the write is authoritative" rule already proven in the deferred model (B6).
6. Decide cadence: ship the control (capability + UI + write path + PR) or default to Annual and disclose the regression (B7).
7. Define `evidence_summary` and `snapshot_completeness`, or remove them (B8).
8. Re-run the ten-lens gate to completion before any READY claim.

---

# Part VI — Reset: evidence-driven design

**Added:** 2026-07-29. Parts I–V retained.

## VI.1 — Why a reset

Four specifications failed review. The common cause was **method, not judgement**: each began with a desired product and assumed
platform support. Each asserted at least one field that does not exist —

- `application_status_category` required-to-submit, on a DTO that does not expose it;
- `reviewer_tenant_role` sourced from `has_tenant_role`, which returns `boolean`;
- `business_justification` / `data_classification`, with **zero occurrences** in the repository;
- an unpinned `includeStale` on which every frozen count depended.

`docs/74` is now rebuilt inventory-first. Every field in the design is traced to a concrete return type before it is used.

## VI.2 — The discovery that changes the product

**V3 has two application worlds that do not join.**

| | Directory application | Operational application |
|---|---|---|
| Table / surface | `directory_applications` · `/access/applications/[id]` | `public.apps` · `/apps` + `/apps/[id]` |
| Read authorization | owner/admin only | **any tenant member** (`0001:292-293`) + org members (`0002:153`) |
| Holds | effective access, findings, freshness | ownership booleans, contract/user counts, vendor, status |
| Index route | **none** | yes |

The bridge exists in schema — `apps.canonical_app_id` (`0024:97,103`) and `directory_applications.catalog_product_id` (`0057:43`)
both target `app_products` — and **neither is populated**. `0024:13-16` implements no resolver; `0057:10,20` keeps the match
`unmatched`; `canonical_app_id` appears in no application code, only generated types.

Every prior spec's premise — one attestation mixing access evidence with business context — was therefore asserting a join that
resolves to nothing.

## VI.3 — What the inventory supports

**READY:** effective identity count · DIRECT/GROUP/BOTH · assigned groups · findings scoped to the app, with counts by severity ·
application label and provider · `bounded` completeness · ownership booleans · linked-contract and app-user counts (complete for
owner/admin) · vendor, category, status, instance markers.

**PARTIAL:** `staleSince` (nullable) · `syncState` (4 states collapsed to 2 at `access-loaders.ts:46`) · `catalogMatchStatus`
(always `unmatched`) · org references (IDs, no names) · identity labels inside findings (real PII — screen only, never frozen) ·
reviewer role (needs a `tenant_memberships.role` read).

**UNAVAILABLE:** `status_category` / `sign_on_category` / `connection_id` / `is_active` (on the RPC row, discarded by the DTO) ·
four-state freshness · business justification · data classification · owner names · privileged/high-risk counts · cost · cadence ·
cross-world correlation.

## VI.4 — Resulting product

Two review types, each on the surface holding its evidence:

1. **Access Review** (`/access/applications/[id]`) — v1 core. The review V3 uniquely enables.
2. **Application Governance Review** (`/apps/[id]`) — same machinery, optional in v1.

The old three types are **not preserved**: "Business Justification" had zero backing evidence, and "Configuration & Security Review"
named a verification V3 does not perform.

**Cadence and Current/Overdue are dropped from v1** — no cadence storage exists, and the old app's day arithmetic (31/92/183/366)
was wrong anyway. Cards show "Never reviewed" or "Last reviewed `<date>`". This is a disclosed reduction, not an oversight.

## VI.5 — Disposition of every prior blocker

| Origin | Blocker | Disposition |
|---|---|---|
| Campaign model | U1–U4, V1 (scope selection, PII structural claim, finding cardinality, drift producer) | **DISSOLVED** — no campaigns, no scope picker, no per-item findings, no drift |
| Hybrid model | B1 `status_category` has no producer | **DISSOLVED** — not in the design; classified UNAVAILABLE |
| Hybrid model | B2 `includeStale` unpinned | **RESOLVED** — pinned to `false` and recorded in the snapshot |
| Hybrid model | B3 reviewer role has no source | **RESOLVED** — explicit `tenant_memberships.role` read |
| Hybrid model | B4 redaction mandated and forbidden | **RESOLVED** — redaction is an explicit owner/admin act with a capability row |
| Hybrid model | B5 retention with no mechanism | **DISSOLVED** — v1 makes no timed retention promise |
| Hybrid model | B6 form cannot show what it freezes | **RESOLVED** — "preview is advisory, the write is authoritative", carried from the deferred model |
| Hybrid model | B7 cadence has no capability or PR | **DISSOLVED** — cadence removed from v1 and deferred with its cost |
| Hybrid model | B8 undefined `evidence_summary` | **RESOLVED** — every snapshot field enumerated in §4.1/§4.2 |

**Most blockers dissolve rather than get fixed** — the same signal seen when the campaign model was deferred: the defects were
consequences of designing past the platform.

## VI.6 — The gate that would have prevented all of this

`docs/74` §6.4 PR B carries one test: **assert every snapshot field exists on `ApplicationAccessDetailData`.** That single check
catches B1, B2 and the `status_category` class of error mechanically, at build time, instead of in adversarial review.

## VI.7 — Readiness

Not yet asserted. This document is product discovery and design; it has not been through an adversarial gate in this form. The
design's claim is narrower and more testable than its predecessors': every field is traced to a return type in §1, and the
capability matrix in §2 states what was excluded and why.
