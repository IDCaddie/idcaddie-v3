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

### What an application match IS — the 0 / 1 / many instance question

**`application_matches` is an INSTANCE relationship, not a product-level one.** 0075 settles it in its own words: `apps` is
*"normalized software records — what do we pay for, and under what contract"*, and *"a directory application with **no SaaS record
is not an error** (nobody has recorded a contract)"*. Product-level identity lives one layer up, in `app_aliases` →
`app_products`. The two answer different questions and are deliberately not merged.

Phase 18B0 made the chain deterministic at last by giving `apps.canonical_app_id` its first writer:

```
directory_application.external_id → confirmed alias → app_product → apps WHERE canonical_app_id = product → application_matches.app_id
```

| instances of the resolved product | what a matcher may do |
|---|---|
| **exactly one** | propose that `app_id` deterministically — the ordinary path |
| **many** (Salesforce Production + Sandbox) | propose **each** as a competing candidate, all `proposed`. The evidence proves the *product*, never the *instance*, so nothing may pick one. A human accepts exactly one; the partial unique index makes a second acceptance impossible |
| **zero** | propose nothing. Per 0075 this is **explicitly not an error** — the product is known, but nobody has recorded a contract for it. The product-level truth still stands in `app_products`/`app_aliases`; `application_matches` simply has nothing to say |

`app_id` is therefore sufficient **because the relationship being recorded is instance-level**. Repointing it at `app_product_id`
would record a different, weaker fact and aim the FK at a table with a far thinner writer.

### What "managed" means to Rule 5 — and what is still undefined

`discovered_application_unmanaged_by_idp` is subjected on a **directory application** and fires when a current one has **no
accepted match**, and only when the matcher's status is `completed` — an empty table means *not yet looked* just as readily as
*nothing is managed*. Given the instance semantics above, "managed" means **an accepted link to an operational/contract record
exists**. A confirmed product with zero instances therefore still reads as unmanaged, and that is coherent: the estate knows what
the application is, and has no contract record for it.

**Open, and not this phase's to fix:** the rule's `title_key` / `summary_key` / `remediation_key` resolve to **no copy anywhere in
the repository**, so the sentence a customer eventually reads is still undefined. Whoever writes that copy must say
*instance/contract* management, not product recognition, or the finding will contradict this model.

### The prerequisite 18C still needs

18B0 gave `apps.canonical_app_id` a writer, but it is a **human-driven** one: an operator creates the product, declares the alias,
and the resolver links the app. Until a tenant has actually done that, the join above yields nothing, so **a matcher run over an
uncanonicalized estate will legitimately propose zero matches** — which Rule 5 must not read as "everything is unmanaged". The
matcher-state gate (`completed`) is what protects that, and 18C must keep it honest.
