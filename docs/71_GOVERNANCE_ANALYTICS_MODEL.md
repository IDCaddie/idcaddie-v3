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

## The read boundary (migration 0085)

```
canonical facts  →  authorized read RPCs  →  [Phase 17 tenant loader]  →  pure engine  →  0083 lifecycle
```

The engine consumes six canonical inputs. Four already had authorized reads — `product_app_accounts` /
`product_connector_capabilities` (0078) and `product_list_directory_identities` / `product_list_directory_applications`
(0061). Two did not: `person_account_links` (0082) shipped propose/decide only, and `application_matches` (0075) shipped
with the note *"the read contract will be a product RPC when a consumer exists."* 0085 adds exactly those two, plus the
one fact neither table can express.

**Both tables stay deny-all.** No SELECT policy was added, no existing revoke weakened, no direct table grant exists, and
`service_role` is never used — the definer functions remain the only path, as 0061 chose for the directory graph.
Because `scripts/test-rls.sh` blanket-grants and then re-revokes (masking a broadened grant from the SQL suite),
`scripts/governance-read-boundary-migration.test.ts` asserts the privilege closure statically. That masking is real: a
mutation adding `grant select … to connector_runner` passed the DB suite and was caught only by the static guard.

### Three different facts, three different owners

| fact | owner | question it answers |
|---|---|---|
| `person_account_links` (0082) | canonical **human ↔ account** judgement | *is this account this person's?* |
| `application_matches` (0075) | canonical **application relationship** judgement | *is this directory app that SaaS product?* |
| `application_matcher_state` (0085) | **execution** evidence | *did matching run to completion at all?* |

**Matcher execution state is not match truth.** The first two are decided by a human; the third is a fact about a
process. Neither is ever derived from the other.

### MATCHER RAN + ZERO MATCHES ≠ MATCHER NEVER RAN

This is the whole reason 0085 adds a table rather than another read. Rule 5 must separate four states, and a row count
separates only two:

| state | representation |
|---|---|
| never ran | **no row** — absence is the answer, so there is no `has_ever_run` column duplicating it |
| running | `status='running'`, `last_completed_at` unchanged |
| failed | `status='failed'`, `last_completed_at` unchanged |
| completed | `status='completed'`, `last_completed_at` set |

A complete run that found nothing is a **result**; never having looked is an **unanswered question**. Counting
`application_matches` rows gives the same zero for both, and the answer it picks — *unknown* — would silently withhold a
true finding forever.

`last_completed_at` deliberately survives a later failure. An older completion remains a fact when a newer run fails, and
the newer failure remains a fact too, so a stale completion cannot mask a fresh failure and a fresh failure cannot erase
a real completion. The reader decides which matters.

**Reuse was rejected on semantics.** `connector_capability_state` (0076) is keyed
`(tenant_id, connection_id, capability)` with `connection_id NOT NULL`. Application matching is a tenant-level process
over already-persisted rows and has no connection; making it fit would mean inventing a synthetic connector row, which is
a lie in the shape of a foreign key. `connector_runs` and `connector_run_resource_discovery` are connector-scoped for the
same reason.

### What the matcher lane must call

`product_start_application_matcher_run` → do the matching (writing `application_matches` itself) →
`product_complete_application_matcher_run` **or** `product_fail_application_matcher_run`. Both terminal verbs move only a
run that actually started, so a completion cannot be claimed by a caller that never looked at anything. 0085 implements
**no matching logic**.

### Person resolution is unchanged

`resolutionHasRun = personAccountLinks.length > 0` is **not** touched here. Phase 16 reviewed and retained it, and its
limitation is documented above. 0085 adds an execution signal for the application matcher only, because that is where the
row-count proxy is actually wrong today — not to generalise a pattern.

## The tenant loader (Phase 17)

```
canonical persisted evidence
        ↓   authorized product RPCs (0061 / 0078 / 0085)
tenant loader            — src/lib/data/cross-source-governance-loader.ts
        ↓   CrossSourceGraph
pure cross-source engine — src/lib/server/cross-source-governance/
        ↓   findings + completeConnectionIds
0083 evidence-gated lifecycle
```

**The loader owns availability and completeness truth. The engine owns deterministic governance meaning. 0083 owns the
finding lifecycle.** Those are three questions, and answering any of them twice is how a product gets two answers. There
is no rule logic in the loader — no severity, no subject, no threshold — and no SQL in the engine; closing, reopening and
first/last-seen are never re-derived in TypeScript.

| engine input | source |
|---|---|
| `appAccounts` | `product_app_accounts` (0078), offset-paged |
| `identityAccounts` | `product_list_directory_identities` (0061), cursor-paged |
| `directoryApplications` | `product_list_directory_applications` (0061), cursor-paged |
| `personAccountLinks` | `product_person_account_links` (0085), cursor-paged |
| `applicationMatches` | `product_application_matches` (0085), cursor-paged |
| `capabilities` | `product_connector_capabilities` (0078) + `connectors` for the provider label |
| `matcherState` | `product_application_matcher_state` (0085) |

Tenant authority comes from `accessGate()` — the existing RLS-backed tenant context, never a caller-supplied id — and
every RPC re-verifies it via `has_tenant_role`, so the check happens twice. The user-scoped cookie-bound client is the
only database access; **no `service_role`, no elevated client, no provider adapter, and no provider name is ever compared
to a literal.**

### Read failure is not an empty result

A failed read and a successful empty read are the same `[]` in most code, and once they are the same the engine cannot
tell *"this tenant has no orphaned accounts"* from *"we could not look"* — after which 0083 would close findings on the
strength of a query that never ran. So **a failed required read fails the whole evaluation**: nothing is synced and
nothing closes. The bounded error vocabulary is `not_authorized` · `query_failed` · `page_limit_exceeded`, and no SQL,
URL, PostgREST payload, row or stack ever reaches a caller.

Every read is **paged to exhaustion**. "Page one is enough" is the quiet way a loader lies: the engine would see a
truthful-looking subset and conclude that accounts beyond row 500 have no owner. A cursor that fails to advance is
treated as a broken read contract and fails, because a duplicated or truncated estate is worse than no answer.

Stale rows are loaded **deliberately** — the engine decides what staleness means per rule, and a loader that filtered
them would answer a question the rules exist to answer.

### `complete_connection_ids`

Passed to 0083 as the engine's own `completeConnectionIds`: exactly the connections whose capability was proven
`available`. A stale, failed, plan-limited, permission-limited, unsupported or simply undeclared source can therefore
never license a closure. A capability naming a connection the tenant does not own is dropped rather than defaulted — an
unattributable capability is not evidence.

### Rule 5 now reads execution state, not row count

The engine gates rule 5 on `matcherState.status === "completed"` (0085) and nothing else. `lastCompletedAt` being set is
deliberately **not** enough: that timestamp survives a later failure, so a run that failed this morning must not present
yesterday's completeness as today's. Never-ran, running and failed each produce a distinct withheld reason.

**Person resolution is unchanged.** `resolutionHasRun = personAccountLinks.length > 0` remains as Phase 16 reviewed and
retained it, with the limitation documented above — no new execution marker was introduced.
