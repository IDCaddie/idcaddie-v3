# 79 · Canonical Intelligence Layer

**Canonical source for: how a source becomes a product surface.** Every metric, its owner, and what renders when a source cannot
answer. Phase 7B.

---

## The one-directional flow

```
Source  →  Evidence  →  Canonical model  →  Derived intelligence  →  Product
```

Nothing flows backwards. A page never asks a connector a question; it reads a registered metric whose owner is declared here. The
rule that makes this hold: **no page computes its own metric.** Two surfaces deriving the same number independently is how
"7 groups" and "6 groups" coexisted for four phases (closed by migration 0074).

## Why a capability model exists

Before this, a surface asked "did Okta give me groups?" and every other provider fell through to a zero.

**A zero is a claim.** It says *we looked and there are none*. For an unconnected or unimplemented source the truth is *we cannot
know*, and those must never render the same way.

### Two orthogonal axes, deliberately not collapsed

| axis | question | varies by |
|---|---|---|
| **Support** | Has ID Caddie *built* this capability for this provider? | nothing — it is a product fact |
| **State** | What does *this workspace's* connector actually have? | tenant, connector |

Collapsing them produces the zero. A workspace with a healthy Slack connector still cannot have Usage — it is not built, so
"connect Slack" would be the wrong instruction for something they already did.

### Support values

- `implemented` — a discovery path, a persistence model and a read contract, proven end to end
- `planned` — on the roadmap; **no ingestion exists**, so no workspace can have this data
- `not_applicable` — this provider does not expose it; it will never light up

### State values — nine, none of which is a number

`available` · `not_connected` · `source_required` · `incomplete` · `stale` · `failed` · `review_required` · `unavailable` ·
`unknown`

`unknown` is a **read failure**, and is checked first. Deciding "not connected" from a failed read is a claim about an estate we
could not see.

## The honest support matrix, today

**Only Okta has any implemented capability**, and only the five directory ones: identity, groups, directory applications,
memberships, assignments. Twelve providers are in the catalogue; one has promote RPCs. Everything else is `planned` or
`not_applicable`, and the product says so rather than showing zeros.

## Metric lineage

`src/lib/canonical/lineage.ts` is machine-readable on purpose. A test walks it and fails if two entries claim one metric, if a
directory metric declares itself unscoped, or if a refresh trigger points at a route that does not exist — so the documentation
cannot drift from the product, because it *is* the product's registry.

Every entry declares: capability owner · RPC · tables · formula in words · refresh trigger · connector scope · **unavailable
state** · stale behaviour · security boundary.

## Refresh propagation

Declared in one place (`REFRESH_PATHS`) rather than scattered across `revalidatePath` calls, so adding a connector means adding a
row, not hunting for every page that happens to read it.

| trigger | invalidates |
|---|---|
| `directory_discovery` | Home, People, Groups, Directory applications, Access, Findings, Directories |
| `connector_lifecycle` | the above, plus the marketplace |
| `contract_write` | Home, Contracts |

## The unified application model

`directory_applications` and `public.apps` **stay separate, permanently.** They answer different questions about overlapping
things:

- *directory application* — "who can sign in to this?"
- *SaaS application* — "what do we pay for, and under what contract?"

Migration **0075** adds `application_matches`: an explicit, confidence-bearing link with provenance.

**Why a table and not a join.** Any join would be on name, label or domain — and every one is wrong. "Slack" the Okta app and
"Slack" the contract may be different tenants, different regions, or the same name owned by two vendors. A match is a
**judgement** with a confidence and an author, so it is stored as a fact, not inferred at read time. Same reasoning as connector
supersession (0071): *declare, never infer.*

At most one **accepted** match per directory application. Deliberately **not** unique on the SaaS side: two Okta organizations
both exposing Salesforce legitimately map to one contract, and constraining that would force an operator to choose which
organization "owns" a contract covering both.

**No matcher exists.** The table is empty, RLS-locked with no policy, and nothing reads it. Building a matcher before fixing the
shape of its output is how you get a name-based join.

## Canonical application identity — the bridge a matcher needs (Phase 18A)

Three facts stay separate, permanently. Collapsing any two is the failure mode:

```
directory_applications.external_id       raw PROVIDER identifier — connector-owned (0057)
            ↓
app_aliases                              canonical JUDGEMENT: this identifier IS this product — product-owned (0024/0026)
            ↓
app_products                             canonical application/product identity
            ↓
application_matches                      directory application ↔ SaaS app — a different decision, still unbuilt (0075)
```

**Why the matcher could not be built first.** Both endpoints already point at one catalog —
`directory_applications.catalog_product_id → app_products` and `apps.canonical_app_id → app_products`, each a same-tenant
composite FK — but nothing had ever written either column, and `app_aliases` was empty. The only other joinable fields are names.
So **building the matcher before this bridge exists would have forced name-based matching or produced a zero-output engine.** The
missing layer was canonical application evidence, not matching logic.

**The product does not need to receive `external_id` to declare the canonical relationship.** That is the whole design, and it
is what lets identity be established without adding a read path 0061 deliberately withheld.

**Be precise about what is hidden.** The command never *returns* the identifier, and adds no read RPC and no SELECT grant. It
does *write* it to `app_aliases.alias_value`, which any tenant **member** may read (0024). That is not a new disclosure: 0025
already grants members read on `discovery_facts`, whose `fact_json` carries the same `external_id` for directory-application facts
— exactly what the 0057 promote RPC reads — and 0024 classifies `alias_value` as "a label/id, never a secret/token". So the
accurate claim is narrow: **the command does not return it and opens no new disclosure path.** It is *not* "`external_id` is
invisible to the product", and nothing should be built on that assumption.

**Why a command rather than a read.** `directory_applications` enables RLS and defines **no policy at all** (0057), so it is
deny-all to `authenticated`; and the 0061 read RPCs deliberately return "ONLY bounded safe fields … and **NEVER external_id**".
Product code therefore cannot obtain the identifier a declaration would key on. Phase 18A1 shipped a server action that read it
directly, and independent review deleted it: mocked IO had hidden that it could never execute.

0061's rule is about what is **returned to a browser caller**, not about what a definer function may **read**. Its own RPCs
already read `directory_applications` internally and simply do not return the identifier. Migration **0087**
(`product_declare_application_alias(p_tenant_id, p_directory_application_id, p_app_product_id)`) follows exactly that discipline:

```
caller sends  directory_application_id + app_product_id     (two row ids it already holds)
0087          verifies owner/admin, reads external_id INTERNALLY, writes the alias
caller gets   one bounded status string                      (never the identifier)
```

`external_id` is opaque provider evidence — an Okta application id, stored unencrypted, not a credential, and it reaches no
product surface anywhere in the app. It was withheld as minimum-disclosure discipline. Using it inside the database boundary
**preserves** that decision; returning it would break it.

**Authorization is owner/admin, deliberately not editor.** The 0024 policy lets owner/admin/editor write `app_aliases` directly,
so editor looks like the obvious answer. It is gated at 0061's level because the command acts on a canonical directory row that
editors may not read. The reasoning is *not* that the identifier is otherwise unobtainable — an editor is a member, and members
can read `discovery_facts`, where the same value sits in `fact_json`. The question is who may make a canonical **judgement** over
a directory row, and that is the 0061/0078 level. `p_tenant_id` is **verified, never trusted**:
`has_tenant_role` resolves the caller from `auth.uid()`.

**Declaration is a human judgement, so it writes `confirmed`** with `reviewed_by = auth.uid()`. Writing `pending` would produce a
judgement the resolver cannot use; `auto` has no defined meaning anywhere in this schema. Only a **current** directory application
may mint new identity — a stale, review_required or disconnected row is evidence the provider stopped confirming the application
exists. That gate is one-directional: an already-confirmed alias keeps resolving forever, because the resolver never reads the
directory side.

**Conflicts are bounded and never destructive.** The 0026 natural key means one identifier carries at most one judgement.
Re-declaring the same product is an idempotent `already_confirmed`; a different product, a pending proposal, and a rejected
mapping are all `conflict`. The command never promotes, resurrects or overwrites — last-write-wins is not a canonical identity
policy.

**Ownership.** `connector_runner` holds no grant on `app_aliases`, `app_products`, `vendors` or `apps`, and gains none. It writes
`directory_applications` only through the `runner_*` SECURITY DEFINER functions (0057). Discovery may report an identifier; it may
not decide what that identifier *is*. The canonical judgement is product-owned; reads run under the existing 0024 RLS policies
(members read; owner/admin/editor insert and update; nobody deletes), whose tenant isolation is proven functionally by
`supabase/tests/org_rls_test.sql` (T46). Phase 18A adds **no migration, no policy, no grant and no SECURITY DEFINER RPC**.

**Ambiguity is not multiple `app_aliases` rows.** The 0026 natural key `UNIQUE(tenant_id, alias_type, alias_value)` means an
identifier has at most one canonical judgement — that is what makes it a judgement rather than a candidate list. When it is not
clear which product an identifier belongs to, **leave it unresolved**: write nothing. Competing candidates are a *match* concept
and belong in `application_matches`, which is proposal-bearing by design. Never weaken the natural key to hold candidates.

**Names are display metadata, never identity.** `alias_type` includes `name`, and deterministic resolution excludes it
structurally (`DETERMINISTIC_ALIAS_TYPES` = every type except `name`). A name lookup short-circuits before any query reaches the
database. There is no fuzzy, substring, vendor-similarity or display-label fallback anywhere in the path.

**Only a settled judgement resolves — and only `confirmed`.** `pending` is a proposal nobody accepted and `rejected` is a human
saying these are not the same product. `auto` is excluded for a stronger reason: the 0024/0025 CHECK constraints admit it, but
**nothing in this repository defines what it means and nothing writes it**, and the only implemented review lifecycle
(`sync-review-actions.ts` over `discovery_facts`) transitions pending → confirmed | rejected without it. Treating an undefined
status as accepted canonical truth is precisely the "proposal silently becomes fact" failure this layer exists to prevent. A
future deterministic writer that wants auto-confirmed aliases adds `auto` together with a documented meaning.

**Provider freshness and canonical judgement are separate facts.** Resolution reads `app_aliases` alone and never consults the
directory side, so a settled judgement keeps resolving after its source goes stale, is superseded, or its connector is
disconnected. Whether a *stale* source may mint a *new* judgement is a question for the declaration path, and therefore for 18A2.

**Canonical alias declaration is NOT application matching.** Declaring says "this identifier IS this product"; resolving reads
that judgement back. Neither says a directory application has been **matched** to a SaaS application — that decision belongs to
`application_matches` (0075), which is proposal-bearing by design and remains unbuilt. The full seam now reads:

```
directory_applications.external_id   raw provider evidence, connector-owned (0057) — never leaves the database
        ↓  0087 governed command (owner/admin, SECURITY DEFINER, reads it internally)
app_aliases                          human canonical judgement: provider_app_id → app_product (0024/0026)
        ↓  Phase 18A1 deterministic resolver (confirmed only, name structurally excluded)
app_products                         canonical application/product identity
        ↓  still unbuilt
application_matches                  directory application ↔ SaaS app (0075)
```

## The application match review boundary (Phase 18B)

Migration **0088** adds the only two mutations `application_matches` will ever need, and nothing else:

```
deterministic evidence  →  PROPOSED match  →  human ACCEPT / REJECT  →  accepted relationship  →  governance truth
```

**PROPOSED ≠ MATCHED. REJECTED ≠ ABSENT EVIDENCE. ACCEPTED = CANONICAL RELATIONSHIP.** No LLM establishes this truth, and no
automatic process may: a proposal carries no decision, and 0075's `decided_chk` refuses any row that claims `accepted` without a
`decided_at`, so auto-accepting is structurally impossible rather than merely un-implemented.

- `product_propose_application_match(tenant, directory_application, app, method, confidence)` → `proposed` only.
- `product_decide_application_match(tenant, match, accepted|rejected)` → `decided_by` is `auth.uid()`, `decided_at` is the
  database's clock, and the update is guarded on `status = 'proposed'` so a decided row is **immutable through this command**.
  Re-opening a decision is a separate future workflow, never a hidden toggle.

Both are owner/admin, matching 0085's read and the 0078/0087 precedent. `connector_runner` is granted nothing; proposal generation
is product-side orchestration, so no new machine identity was introduced. `application_matches` keeps its 0075 deny-all posture —
RLS on, no policy, no table grant — and 0085's bounded read stays the only read path.

**Candidate identity is the pair `(tenant, directory application, app)`** — one row per pair for all time (0088's unique index).
That makes three properties structural: re-proposing is a no-op, a **rejected candidate can never be resurrected** by proposing
again, and an accepted one can never be duplicated. Method is deliberately not part of the key: two methods reaching the same pair
are one candidate with two lines of evidence.

**Ambiguity is preserved, not resolved.** Different targets are different pairs, so one directory application may carry several
competing proposals at once; nothing picks a winner by confidence or arrival order. Cardinality is 0075's: at most **one accepted**
match per directory application, and deliberately **many-to-one** on the SaaS side — two directory applications may both accept one
`apps` row. Two concurrent accepts cannot both win; the loser gets a bounded status, not a Postgres error.

**Method vocabulary admitted here:** `manual`, `exact_external_id`, `vendor_catalog`. `exact_domain` is refused because the
directory side carries no domain column, and `suggested` because nothing produces it and admitting the weak-evidence bucket before
a producer exists invites the name-similarity matching this work exists to prevent.

### The three layers, and why they are not collapsed

| layer | table | question it answers |
|---|---|---|
| canonical product identity | `app_products` | *what software is this?* |
| operational / contract instance | `apps` | *what do we pay for, and under what contract?* |
| instance relationship | `application_matches` | *which contract record does this IdP application correspond to?* |

```
canonical product recognition:   directory application → confirmed alias → app_product
instance matching:               app_product → zero / one / many apps rows → application_match proposals
```

Recognition and matching are different acts on different evidence. Collapsing them is what a name-based join does.

### What an application match IS — the 0 / 1 / many instance question

**`application_matches` is an INSTANCE relationship, not a product-level one.** 0075 settles it in its own words: `apps` is
*"normalized software records — what do we pay for, and under what contract"*, and *"a directory application with **no SaaS record
is not an error** (nobody has recorded a contract)"*. Phase 18B0 gave `apps.canonical_app_id` its first writer, so the chain
`external_id → confirmed alias → app_product → apps WHERE canonical_app_id = product → app_id` is deterministic at last.

| instances of the resolved product | what may be proposed |
|---|---|
| **exactly one** | that `app_id`, deterministically — the ordinary path |
| **many** (Salesforce Production + Sandbox) | **each**, as competing `proposed` candidates. The evidence proves the *product*, never the *instance*, so neither confidence, arrival order nor arithmetic may pick one. A human accepts exactly one; the losing candidate **remains a proposal** rather than being silently rejected, and 0075's partial unique index makes a second acceptance impossible |
| **zero** | nothing. The product is recognised, no contract record exists, and nothing is fabricated to fill the gap. Product-level truth continues to live in `app_products`/`app_aliases` |

`app_id` is sufficient **because the fact being recorded is instance-level**. Repointing at `app_product_id` would record a
weaker, different fact against a far thinner writer. Proven by B14 (many) and B15 (zero) against a real shared-product estate.

### A rejection is instance-scoped, and that is deliberate

**Rejecting a candidate means "not this instance" — never "not this product".** The question a reviewer is actually shown is
*"is this IdP application the same thing as this operational/contract record?"*, so their `rejected` answers exactly that. It
follows that a later candidate for a **different** instance of the same product is a **new and legitimate question**, not a
resurrection of the one already refused — and 0088's candidate key `(tenant, directory_application, app_id)` is what keeps the two
apart. Re-proposing the *same* pair is still an idempotent no-op that can never resurrect the rejection (B10).

This looks, at a glance, like a replay hole: reject Salesforce Production and a Salesforce Sandbox candidate may still appear.
It is not one, and **the fix that suggests itself is the bug**. Keying rejection on the product instead would (a) refuse a
question the human was never asked, and (b) put a product-wide `rejected` verdict in `application_matches` alongside a
`confirmed` `app_aliases` row asserting the same directory application IS that product — two tables recording one fact with
independently mutable lifecycles and nothing to reconcile them. Product recognition is `app_aliases`'s to accept or reject
(§ *Only a settled judgement resolves*); this table only ever decides instances.

A reviewer who means "this IdP application is not Salesforce at all" is rejecting the **alias**, not the match.

### What "managed" means to Rule 5 — and the copy debt it carries

`discovered_application_unmanaged_by_idp` is subjected on a **directory application** and fires when a current one has **no
accepted match**, gated on the matcher's status being `completed` — an empty table means *not yet looked* just as readily as
*nothing is managed*. Given the instance semantics above, **"managed" means an accepted relationship exists to a tenant
operational/contract application record.**

It does **not** mean the canonical product is unknown, the software unidentified, or the alias unresolved. A recognised
`app_product` with zero operational instances is therefore still "unmanaged" *at the operational-instance layer*, and that is
coherent rather than contradictory.

**Recorded debt, deliberately not fixed here:**
- the rule's name reads backwards from its implementation — it is subjected on the IdP's own record, not on a SaaS-discovered one;
- its `title_key` / `summary_key` / `remediation_key` resolve to **no copy anywhere in the repository**, so the sentence a customer
  eventually reads is still undefined;
- whoever writes that copy must say **instance/contract management, not product recognition**, or the finding will contradict this
  model.

### The 18C candidate contract (migration 0090)

**`canonical_product` — a sixth `method`, because none of the five was true.** The chain
`external_id → confirmed provider_app_id alias → app_product → apps WHERE canonical_app_id = product` proves the
**product**; the identifier never touches the `apps` row, so it does not prove the **instance** — and that stays true at
N=1, where the candidate set is exhaustive by *cardinality*, not by evidence. `exact_external_id` would claim the
identifier matched this instance. `vendor_catalog` was never defined by 0075, nothing writes it, and `vendors`
(Atlassian) is a different noun from `app_products` (Jira), so it reads as an external catalogue — retrofitting it would
hollow out the vocabulary. `suggested` is the weak-evidence bucket 0088 refuses to keep name-similarity out, and this
derivation is deterministic. `manual` is an operator. So:

> **`canonical_product`** — candidate derived deterministically from a confirmed canonical-product mapping and the
> tenant's operational instances of that product; the evidence does not itself identify this instance as the correct one.

**method is provenance; confidence is the weighing.** 0075: *"HOW the match was decided … the automated methods are
recorded distinctly so a low-quality heuristic can be found and revisited later"* versus *"a match without one is an
assertion nobody can weigh."* So method must NOT vary with cardinality and confidence MAY:

| operational instances | proposal | method | confidence |
|---|---|---|---|
| **zero** | none | — | — |
| **one** | one candidate | `canonical_product` | **medium** — exhaustive, but still inferential; the zero case proves a product may own no instance at all |
| **many** | one per instance | `canonical_product` | **low** for every candidate — nothing distinguishes them |

Never propagate alias/product confidence into instance confidence: a high-confidence *product* identification says
nothing about which instance is right.

**`product_application_match_candidates` — the bounded read.** `directory_applications` is deny-all and 0061 withholds
`external_id`, so product code cannot perform `directory_application → alias` at all. The definer reads the identifier
INTERNALLY, joins on it, and returns only `(directory_application_id, app_product_id, app_id)` — never the identifier,
alias value, label, name or provider payload. Owner/admin, `authenticated` EXECUTE only; PUBLIC/anon/`connector_runner`
revoked; no `service_role`, no table grant, no policy on `directory_applications`.

Eligibility mirrors 0087: a `current` directory application with a non-blank identifier, on a connector that is neither
superseded nor disconnected, carrying a **confirmed** `provider_app_id` alias. `pending`, `rejected`, `auto` and `name`
never bridge.

**Paging bounds PARENTS, never the exploded join.** One directory application expands into 0/1/N rows; a limit on the
joined result would split a many-instance group across a page boundary, and a matcher seeing half a group would propose
half an ambiguity and call the run complete. So a page of parents is selected first, ordered by immutable `id`, then
every selected parent is expanded to its complete set. Row count is unbounded by design. The cursor is the last parent
id, readable from the last row — and a zero-instance parent still emits its `app_id NULL` row, which is what stops a
page made entirely of them from stalling the walk.

**Execution for 18C v1 is request-driven**: an authenticated owner/admin triggers it. Background/scheduled matching is a
separate trust-boundary phase and no principal for it exists.

### Phase 18C — how the deterministic matcher runs

Two independently-read feeds, deliberately not collapsed:

```
census            product_list_directory_applications(p_include_stale = false)   every eligible application
candidate feed    product_application_match_candidates(...)                      only those whose product is settled
```

**Absence from the candidate feed is not absence of the application** — it is absence of settled product evidence. A
matcher driven by the feed alone would never learn an application exists and would report a clean run over an estate it
never looked at. The census is also what validates the feed: a candidate naming an application the census did not return
means the two feeds disagree, and the run fails rather than proposing against something it never examined.

| state | evidence | proposals |
|---|---|---|
| **unresolved product** | in census, absent from feed | none |
| **resolved, zero instances** | feed row with `app_id` NULL | none |
| **one candidate** | one operational app | that one — `canonical_product` / **medium** |
| **ambiguous** | N operational apps | **every** one — `canonical_product` / **low** |

**Confidence is not cardinality.** One instance means the ambiguity is small, not that the evidence is stronger: the
identifier proved the PRODUCT in both cases. Promoting a lone candidate to `high` would launder "the estate happens to
have one row today" into "we know this is the right one", and a second instance appearing tomorrow would retroactively
falsify a claim already recorded. `high` is never emitted.

**The run is fail-closed, and the ordering is the point.** `start` → complete census → complete candidate feed →
validate → **all** proposals → `complete`. Any failure after the start marks the run FAILED and returns. Completion is
last because `application_matcher_state = completed` is what licenses Rule 5: completing first would leave a window in
which the rule reads a completed run whose proposals do not exist yet. A read failure is never an empty read, and there
is no partial completion.

**The matcher proposes and never decides.** Not even the unambiguous one-candidate case — a match is a human judgement,
and `product_decide_application_match` is absent from the source, asserted statically rather than sampled at runtime.
`already_accepted` and `already_rejected` on replay are SUCCESSES: the candidate was legitimate and a person had already
answered it. A rejected candidate is never re-opened, an accepted one never duplicated, and a candidate that disappears
from the estate keeps its proposal — this phase has no authority to delete review history.

**Completeness is relative to its own bounded reads, not to a database snapshot.** The two feeds are separate cursor
walks in separate statements; an application created between them belongs to the next run. Stated rather than papered
over, because claiming snapshot consistency we do not have would be the more dangerous kind of wrong.

Request-driven, owner/admin, tenant from `accessGate()`. No scheduler, no background principal, no UI, no migration.

### What Rule 5 still cannot say — and what must change with it

After a completed run, an application whose product is UNRESOLVED and one whose product is resolved with ZERO
operational instances are genuinely different states, and Rule 5 sees one thing about each: no accepted match. That is
truthful at the level the rule speaks, and it is why both produce the same finding, severity and copy keys — pinned by a
test, not only described here. The **remediation** differs completely: one needs a canonical alias declared, the other
needs an operational record. Whoever writes that copy must resolve the distinction; the pinning test fails the moment
the rule starts making it, which is exactly when the copy has to change too.

### What 18C still needs

18B0's writer is **human-driven**: an operator creates the product, declares the alias, and the resolver links the app. Until a
tenant has done that, the join yields nothing, so **a matcher run over an uncanonicalized estate will legitimately propose zero
matches** — which Rule 5 must not read as "everything is unmanaged". The `completed` gate is what protects that, and 18C must keep
it honest.
