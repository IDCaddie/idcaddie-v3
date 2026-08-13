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

**Ownership.** `connector_runner` holds no grant on `app_aliases`, `app_products`, `vendors` or `apps`, and gains none. It writes
`directory_applications` only through the `runner_*` SECURITY DEFINER functions (0057). Discovery may report an identifier; it may
not decide what that identifier *is*. The canonical judgement is a product-side editor write governed by the existing 0024 RLS
policies — members read, owner/admin/editor insert and update, nobody deletes. Phase 18A therefore adds **no migration and no
SECURITY DEFINER RPC**: a wrapper over an already-governed editor write would catch no failure class RLS does not.

**Ambiguity is not multiple `app_aliases` rows.** The 0026 natural key `UNIQUE(tenant_id, alias_type, alias_value)` means an
identifier has at most one canonical judgement — that is what makes it a judgement rather than a candidate list. When it is not
clear which product an identifier belongs to, **leave it unresolved**: write nothing. Competing candidates are a *match* concept
and belong in `application_matches`, which is proposal-bearing by design. Never weaken the natural key to hold candidates.

**Names are display metadata, never identity.** `alias_type` includes `name`, and deterministic resolution excludes it
structurally (`DETERMINISTIC_ALIAS_TYPES` = every type except `name`). Declaration is narrower still: only `provider_app_id` may
be declared today, because `directory_applications.external_id` is the only current source field with those semantics. Enabling
`sso_app_id`, `oauth_client_id`, `external_instance_id` or `instance_domain` means naming the source field it reads from — not
noticing that the enum contains the word.

**Only a settled judgement resolves — and only `confirmed`.** `pending` is a proposal nobody accepted and `rejected` is a human
saying these are not the same product. `auto` is excluded for a stronger reason: the 0024/0025 CHECK constraints admit it, but
**nothing in this repository defines what it means and nothing writes it**, and the only implemented review lifecycle
(`sync-review-actions.ts` over `discovery_facts`) transitions pending → confirmed | rejected without it. Treating an undefined
status as accepted canonical truth is precisely the "proposal silently becomes fact" failure this layer exists to prevent. A
future deterministic writer that wants auto-confirmed aliases adds `auto` together with a documented meaning.
Re-declaring the same mapping is an idempotent no-op;
pointing an identifier at a *different* product is a conflict requiring an explicit review decision, never a silent overwrite.
Last-write-wins is not a canonical identity policy.

**Provider freshness and canonical judgement are separate facts.** Only a `current` directory application may mint *new* canonical
identity, but an already-confirmed alias keeps resolving forever — resolution reads `app_aliases` alone and never consults the
directory side. A source going stale does not retract a judgement a human already made.

## Adding a new connector

1. Add the provider to the catalogue (`customer-connectors/catalog.ts`).
2. Add its capability row to `SUPPORT` in `canonical/capabilities.ts` — start every capability at `planned`.
3. Build discovery + promote RPCs for one capability; flip that capability to `implemented`.
4. If it introduces a new metric, add a `lineage.ts` entry. If it feeds an existing one, nothing changes.
5. Add its refresh trigger to `REFRESH_PATHS`.

Steps 1–2 alone make the connector appear correctly everywhere — as `planned`, with an explanation, and never as a zero. **That is
the property this layer exists to provide:** a new source lights up every compatible surface without touching product code.
