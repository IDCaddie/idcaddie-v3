# 71 — Governance Analytics Model (Phase 14)

A pure, provider-neutral, **compute-only** governance-analytics engine at `src/lib/server/governance-analytics/`. It consumes the
canonical `directory_*` graph (identities, groups, applications, memberships, user-assignments, group-assignments) + the Phase-13
effective-access results (computed in memory) + an explicit policy, and produces **immutable, deterministic governance findings** + an
aggregate summary. It writes NOTHING and asserts only what the graph topology can prove.

- **Dependency direction:** canonical graph → access-graph (Phase 13) → governance-analytics. Phase 13 must NOT import this module.
- **API:** `evaluateGovernance(graph, policy?, ctx?)`, `evaluateIdentityGovernance(graph, identityId, policy?, ctx?)`, `summarizeGovernance(findings, access, graph)`.

## Truthfulness boundary

The `directory_*` graph proves **access TOPOLOGY only** — who is granted what, directly or via a group, and how fresh each edge is.
There is **no** seat/license, price/cost, usage/activity event, or last-login field anywhere in this graph.

**This engine CAN prove:** reachability (direct / group-derived / effective), redundant direct-vs-group access, identities with no
effective access, groups that grant no application reach, applications with no effective identities, current-assignment-to-stale-endpoint,
effective access supported only by stale edges, count-based breadth (threshold-gated), duplicate inherited paths, and structural graph
inconsistencies in the supplied input.

**This engine CANNOT prove — and never claims:** unused licenses/seats, cost, price, savings, actual application usage, employee
inactivity, last-login behavior, orphaned paid subscriptions, shadow IT, entitlement-risk severity from external policy, or compliance
violations. Those require billing, usage, contract, policy, or risk evidence that does not exist in this graph. A "broad access" finding
does **not** claim over-provisioning; an "application without identities" finding does **not** claim an unused license; a "stale-only
access" finding does **not** claim the user is inactive. Wording is deferred to message keys resolved by a future UI (Phase 15).

## Rule catalog

The GO's 10 rule families (rules 5 and 10 emit multiple rule ids). Severity is `info|low|medium|high` (never `critical` from topology);
confidence is `high|medium|low`, **separate** from severity (high = pure canonical topology proves it; medium = a threshold/derived
signal; low = a heuristic).

| ruleId | subject | severity | confidence | fires when |
|---|---|---|---|---|
| `redundant_direct_access` | identity | medium | high | app reached by BOTH a direct edge and ≥1 group path (direct grant *potentially* redundant) |
| `identity_without_effective_access` | identity | info | high | a current identity (or any, if `includeStale`) with zero effective apps |
| `group_without_application_reach` | group | info | high | a current group grants zero apps in the primary view |
| `application_without_effective_identities` | application | low | high | a current app has zero effective identities |
| `direct_assignment_with_stale_endpoint` | assignment | medium | high | a **current** user-assignment whose identity or app node is non-current |
| `group_assignment_with_stale_endpoint` | assignment | medium | high | a **current** group-assignment whose group or app node is non-current |
| `stale_only_effective_access` | effective_access | medium | medium | identity→app reachable with stale edges but **absent** current-only |
| `identity_broad_access` | identity | medium | medium | effective app count > `identityBroadAccessThreshold` (policy; disabled by default) |
| `group_broad_application_reach` | group | low | medium | group grants > `groupBroadReachThreshold` apps (policy; disabled by default) |
| `duplicate_inherited_access_paths` | effective_access | low | high | app reached via > `duplicateInheritedPathThreshold` (default 1) distinct groups |
| `assignment_missing_identity` / `_group` / `_application`, `membership_missing_identity` / `_group` | graph | high | high | an input edge references a row id absent from the corresponding node set (aggregate count per scope; **no foreign id emitted**) |
| `cross_scope_edge_ignored`, `wrong_provider_edge_ignored` | graph | medium | high | an input edge references a node in a different scope (aggregate count per scope; no foreign id) |

Structural rules are **diagnostics** about the supplied input — the DB composite FKs make them impossible in the persisted graph. They
report **aggregate counts only** (`edgeCount`), with a per-scope token as `subjectId` and **never** a foreign entity id.

## Current vs stale

`SyncStatus` (`current | stale | review_required | disconnected`) is the freshness axis, from each edge's/node's provenance. The
**primary (actionable)** access view is **current-only** by default (`policy.includeStale = false`); `includeStale: true` opts the primary
rules into non-current edges. `stale_only_effective_access` always compares current-vs-all regardless. Staleness = "the connector has not
re-confirmed this edge" (lineage) — **never** phrased as inactivity or last-login.

## Deterministic finding identity

`id = governance:{ruleId}:{sha256(hex)}` over a byte-length-tagged, domain-prefixed serialization of `(ruleId, tenantId, connectionId,
provider, subjectType, subjectId, SORTED relatedIds)` — all canonical ROW ids. Injective (a value cannot forge the delimiter), **scope-
folded** (cross-scope id isolation for free), order-independent (same related set in any order → same id), and independent of mutable
labels / external ids / PII. Repeated evaluation of the same input+policy yields **byte-identical** output (findings are sorted: higher
severity first, then ruleId, subjectType, subjectId, relatedIds, id). `detectedAt` is caller-injected — never `Date.now`.

## Privacy

Finding identity **and** evidence carry only: canonical directory ROW ids (`subjectId`/`relatedIds`/`supportingIds` — never
`external_id`, which is ambiguous across connections), integer counts, the bounded `syncStatus` enum + `staleSince`, message keys, and the
injected `detectedAt`. **Never** external_ids, names, emails, logins, labels, URLs, tokens, secrets, profile data, free-text
`sourceEndpoint`, or raw `lastDiscoveryRunId`. The engine builds only on `directory_*` + Phase 13 — never the legacy `app_users` /
`app_user_identity_matches` model.

## Performance

Index-then-resolve, **O(V + E)** + output size. Effective access is resolved once (current + stale views via Phase 13); rule indices
(members-by-group, apps-by-group, identities-by-app, per-app assignment counts) are single-pass. No recursion, no `O(V·E)`. Verified at
1000 identities × 1000 groups × 10000 memberships × 10000 assignments.

## No persistence / no action

The engine creates no migration, table, fact, RPC, route, component, dashboard, hosted task, or schedule; it makes no network/DB call,
reads no env/flag, logs nothing, and never mutates the input graph or any access. It computes findings — it does not remediate, alert,
ticket, or remove anything.

## Future UI boundary (Phase 15)

Phase 15 separately designs the SELECT-only canonical graph reads, tenant-safe server loaders, and the access-explanation + governance
findings UI (message-key → prose resolution, search/filter, empty/error/loading states, customer-language truthfulness). Phase 14 adds
none of that. RISK-007 remains OPEN; Phase C remains BLOCKED; production untouched.

---

# Phase 16 — the tenant-wide cross-source sibling

**Phase 14, described above, is unchanged.** Its scope contract is still `(tenant, connection, provider)`, its rule
catalog and finding-id function are untouched, and nothing in this section widens either. What follows is a **sibling**
engine at `src/lib/server/cross-source-governance/`, not an extension of that one.

| | Phase 14 — provider-local | Phase 16 — cross-source |
|---|---|---|
| scope | tenant + connection + provider | **tenant** |
| reads | `directory_*` | `app_accounts`, `identity_accounts`, `person_account_links`, `directory_applications`, `application_matches`, capability state |
| key domain | `governance:` | `cross-source:` |
| answers | "is this connector's access graph coherent?" | "does this human's access make sense across every source?" |

Two engines because the questions have different scopes, and one column that means two scopes is how a metric starts
lying. They **share** severity, confidence (still separate axes), the message-key indirection, the PII-free evidence
discipline, and migration **0083** — which owns finding persistence and lifecycle for both, keeping them apart with
`gf_scope_chk` and `gf_key_domain_chk`. They share **no** rule implementation.

## Who owns which fact

- **`person_account_links` (0082)** owns the human ↔ provider-account judgement. It is evidence-bearing and
  human-decided; the engine only ever *reads* `accepted` / `proposed` and never infers a link.
- **0083** owns lifecycle. The engine emits what is true now; first/last seen, reopen and closure are not its business.
- **The connector layer** owns evidence. The engine reads canonical rows and capability state, never a provider module.

## Unsupported never means zero — restated as code

Every rule declares what must be **available** before it may open, and every finding declares the connections it rests
on. When the requirement is unmet the rule is **withheld** and reported in `withheldRules` with a reason — never
evaluated to zero. A rule returning no findings because it could not look is a lie in the shape of good news.

Two guards are worth naming because they are counter-intuitive:

- **An empty `person_account_links` is unknown, not "every account is an orphan."** Rules 1 and 3 stay silent until
  resolution has produced output, so shipping 0082 does not flag an entire estate.
- **An empty `application_matches` is unknown, not "nothing is managed."** No matcher exists yet (see
  [79](./79_CANONICAL_INTELLIGENCE_LAYER.md)), so **rule 5 ships correct and permanently silent** until one runs.

Both guards are **row-count proxies for "did this process run"**, and neither can distinguish a *partial* run from a
complete one. That is sound today — no matcher exists at all, and 0082's proposer links every current human account
carrying an address in one pass, so an orphan candidate cannot come back link-less from a real run unless it has no
address. It stops being sound the moment either process gains partial or incremental execution, at which point each
needs a real completeness signal of its own, in the shape `connector_capability_state` already uses for connectors.
Recorded here so the replacement is a decision rather than a discovery.

## Rule catalog

| rule | subject | severity | must be `available` to open |
|---|---|---|---|
| `active_saas_account_without_accepted_identity` | app account | medium | the account's `app_accounts` + ≥1 `identity` source + resolution has run |
| `privileged_saas_account_without_accepted_identity` | app account | high | as above; fires only where the provider actually reported admin, and **only an ACCEPTED owner silences it** |
| `inactive_identity_with_active_saas_account` | person | high | ≥1 `identity` **and** ≥1 `app_accounts` — the finding asserts both sides |
| `duplicate_active_accounts_for_one_person` | person | medium | that connection's `app_accounts` |
| `discovered_application_unmanaged_by_idp` | directory application | low | that connection's `directory_applications` **and** a matcher having run |

`isActive` / `isAdmin` are nullable: **only an explicit `false` / `true` counts.** Null means the provider did not say,
and treating unknown as inactive would accuse a live employee.

**A pending proposal shields an ordinary account, but never a privileged one.** For an ordinary account a `proposed`
link means "a candidate exists, a human has not decided", and reporting that as an orphan hands the reviewer their own
queue back as a governance problem. For an admin account it is not enough: a proposal never expires, so a wrong one — or
simply nobody reviewing — would hide an unowned privileged account for as long as the queue is ignored. That is a false
negative with an indefinite lifetime, on exactly the account class worth not hiding.

**Rule 4 counts only `human` accounts.** 0082's proposer links only humans, but a *manual* link can attach anything, and
a rule must not depend on another component's filter. A person who owns their login plus a service account has one
account and a robot, not two duplicates.

**Rule 4 is deliberately narrow.** Holding many accounts is normal — one person legitimately has several providers — so
the rule fires only on two or more active accounts **within a single connection**. Across connections it is not a
finding even for the same provider: two Okta organisations legitimately hold one human, which is what 0071 supersession
describes.

**`ACTIVE_ENTITLEMENT_ON_INACTIVE_IDENTITY` is DEFERRED, not implemented.** No entitlement or licence evidence model
exists in the schema; there is nothing to read. It is absent rather than stubbed, because a rule that cannot be
evaluated must not appear as one that found nothing.

## Provider neutrality

The engine imports **zero** provider modules — its only imports are `node:crypto` and two sibling *type* modules.
`provider` is carried as an opaque string for provenance and grouping; it is never compared to a literal. Google plugs
in by landing rows in `app_accounts` plus a capability row, and no file here changes; a test asserts an unknown provider
evaluates identically to a known one.
