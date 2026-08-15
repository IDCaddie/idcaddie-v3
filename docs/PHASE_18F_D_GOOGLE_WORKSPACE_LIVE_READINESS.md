# Phase 18F-D — Google Workspace provider-live readiness

**Readiness / certification only.** Nothing was enabled, deployed, contacted, or run against Google.
No production access. No database connection. No migration applied. No runtime code, task definition,
or test was modified by this lane — this document is the only artifact it produces.

**Baseline audited:** idcaddie-v3 `origin/main` `53f68f1` · idcaddie-connector-runner `origin/main` `374a596`.

---

## FINAL VERDICT

> ## GOOGLE WORKSPACE PROVIDER-LIVE READINESS = **NOT READY**

**Scope of this verdict.** It applies **only** to the Google Workspace provider-live exercise.
It is **not** a statement about the platform. The provider-neutral governance backend is already
staging-proven end-to-end and is not in question here. What is not ready is one provider's path to
its first live credential.

Two blockers (GWS-R1, GWS-R2) must be resolved in code. Four external/human preconditions
(GWS-E1–E4) cannot be satisfied by any repository change. Two readiness gaps (GWS-R3, GWS-R4)
should be accepted explicitly or closed before the exercise.

**Both blockers fail in the safe direction.** GWS-R1 fails closed before any Google call; GWS-R2
requires a schema-violating record from Google to trigger. Neither is an exposure. This is a
completeness call, not an incident.

---

## BLOCKERS BEFORE LIVE EXERCISE

### GWS-R1 — Persist task/runtime DB gate mismatch

`deploy/task-definition-google-workspace-persist.json:70-72` sets `RUNNER_DB_ENABLED=1`.
**Nothing reads that name.** The runtime gate is `IDCADDIE_RUNNER_DB_ENABLED`
(`src/runner-connection.ts:81`, read at `:174-176`).

Three requirements are unmet, all of them satisfied by every Okta persist task definition:

| Required by runtime | Where read | Google persist task definition |
|---|---|---|
| `IDCADDIE_RUNNER_DB_ENABLED=1` | `runner-connection.ts:81,174-176` | absent — sets `RUNNER_DB_ENABLED` instead |
| `IDCADDIE_RUNNER_DB_CONFIRM=1` | `google-workspace-persist-task.ts:68` | absent — 21 other task definitions set it; no Google one does |
| `CONNECTOR_RUNNER_DB_URL` (secret) | `runner-connection.ts:170` | `secrets: []` — never injected |

**Effect.** `google-workspace-persist-task.ts:68` fails closed at `db_not_enabled_or_confirmed`.
The persist half of the exercise cannot run at all.

**Why review did not catch it.** `test/connector-sync/google-workspace-manifest.test.ts:191-200`
("only the persist task is given database access") asserts on `RUNNER_DB_ENABLED` — the same name
the runtime does not read. The task definition and the test agree with each other and both disagree
with the runtime, so the suite is green and the assurance it provides is false. Correcting the task
definition without correcting the test will turn the suite red for the right reason.

### GWS-R2 — Members/licences parse failures may be silently dropped while completeness remains true

Group members and licence assignments that fail sanitization or strict parsing are skipped with a
bare `continue`:

- members — `src/connector-sync/google-workspace-persist.ts:260-263`
- licences — `src/connector-sync/google-workspace-persist.ts:291-295`

Users and groups behave the opposite way: a rejected record **fails the run**
(`:205` for users, `:218-222` for groups). The asymmetry is undocumented.

**Effect.** A dropped member is not counted in `membersNotPersistable`, so the emitted counters
cannot reveal it. Every sweep still returned `ok`, so `recordMetrics` is written with
`terminationReason: "last_page"` and `completeness: true` (`:309-316`), the promotion gate accepts
the run, and the stale pass then compares a set that is missing that edge against the stored set and
marks it absent. A real access edge disappears from governance with no signal on any surface.

This is the exact failure mode the fan-out cap was designed to prevent
(`:229-241` — "the promotion gate would accept it… precisely the mass-staleness the circuit breaker
exists to catch, arriving through the one door it does not watch"), reachable through a second door:
per-record rejection rather than per-sweep truncation.

**Trigger condition.** Requires Google to return a member or licence record that violates the strict
schema. Not reachable on well-formed data — which is why a first live exercise on an unknown tenant
is precisely where it would first appear.

---

## READINESS GAPS

### GWS-R3 — Manifest `rate_limit` declaration is not enforced proactively

`src/connector-sync/manifests/google_workspace.v1.json:89-92` declares `{"rps": 5, "burst": 2}`.
No code reads `rate_limit`, `rps`, or `burst`. There is no client-side throttle, pacing, token
bucket, or concurrency cap anywhere on the Google path.

Rate limiting is therefore **reactive only** — the connector backs off after Google has already
refused (which it does well; see PASSED). The declared figure is documentation, not a control, and
should not be relied on as one when sizing the exercise.

### GWS-R4 — Google Workspace findings evaluator has no production caller

`evaluateGoogleWorkspaceFindings` (`src/connector-sync/google-workspace-findings.ts:66`) is invoked
only from `test/connector-sync/google-workspace-facts-and-findings.test.ts`. Neither the aggregate
nor the persist entrypoint calls it.

**Effect.** A successful live run persists directory evidence and produces **zero** governance
findings. The manifest is honest about this — its `capabilities` list does not claim findings — so
this is an unwired capability rather than a false claim, but it means the exercise cannot
demonstrate governance output.

---

## EXTERNAL / HUMAN PRECONDITIONS

None of these can be satisfied by a repository change.

### GWS-E1 — Google service-account key not provisioned in KMS

`createHostedGoogleAssertionProvider` requires `GOOGLE_WORKSPACE_KMS_KEY_ID`,
`GOOGLE_WORKSPACE_SA_KEY_ID`, and `GOOGLE_WORKSPACE_KMS_REGION`, with no default and no local-key
fallback (`src/connector-sync/google-workspace-kms-adapter.ts:38-46,83-88`). With none present it
fails closed at `missing_kms_key`. Also required: the task role granted `kms:Sign` on that key.

### GWS-E2 — Domain-wide delegation grant not configured/verified

A Workspace super-admin must authorize the service-account client for exactly the four approved
scopes. `delegated_admin_required` is `true` in the contract and refused if set otherwise
(`google-workspace-contract.ts:93-95`). Google returns `unauthorized_client` on an incomplete
grant, so an under-grant fails closed rather than silently under-reading.

### GWS-E3 — `live_key_verification` remains `outstanding`

`contracts/google-workspace-provider-contract.v1.json` — the connector's own declaration that the
live key has never been exercised. Byte-identical in both repositories and hash-pinned by a test in
each.

### GWS-E4 — Hosted staging presence of migration 0086 must be explicitly verified

`0086_google_workspace_directory_persistence.sql` is on `main`. The changelog records the merge and
the double renumbering but makes **no applied-state claim**, and nothing in either repository can
settle it. This must be confirmed against hosted staging before a persist exercise, because the
entire write path depends on it.

Related and equally unverifiable from the repository: whether a staging `connector` row exists for
`google_workspace` in the `verified` state. Persist begins with
`advanceState(verified → discovery_pending)` (`google-workspace-persist.ts:154-159`) and fails at
step 1 without it.

---

## WHAT PASSED

Verified mechanically against the merged baseline.

| Area | Result | Evidence |
|---|---|---|
| DWD / RFC 7523 architecture | PASS | Service-account JWT-bearer with domain-wide delegation; `sub` names the impersonated admin and is **required and validated**, never optional (`google-workspace-auth.ts:15-17,136-140`). Impersonating a service account is refused — it would yield a token over an empty directory, a success-shaped failure. |
| No callback / PKCE requirement | PASS | Structurally inapplicable: no authorization code, no redirect, no user agent, nothing to bind. The Google path never touches the vendored Slack callback/state/pending machinery. |
| No refresh requirement | PASS | RFC 7523 §2.1 issues no refresh token. Every run re-signs a fresh assertion; no token is cached or persisted (`auth.ts:6-8,20-22`). |
| `refresh_token` refusal | PASS | A `refresh_token` on the token response is **refused as a credential-shaped key**, not tolerated-and-ignored (`google-workspace-token-schema.ts:40-42`). Stronger than "we choose not to store one": a response carrying one cannot be the response we asked for. `id_token` and secret-shaped keys refused likewise; prototype-pollution keys refused; the `{error, error_description}` envelope refused rather than logged, because it names the impersonated admin (`:94-96`). |
| Read-only scope posture | PASS | Four scopes (`auth.ts:40-45`); three are `.readonly`. Four further scopes analyzed and **refused with stated reasons** rather than omitted silently (`:47-63`). |
| Licensing write-capable scope handled honestly | PASS | Google publishes no `.readonly` variant of `apps.licensing`. Rather than a grammar rule that would be either worthless or make the resource unimplementable, the contract uses declare-and-justify: a non-readonly scope must be listed in `write_capable_scopes`, which costs a visible diff in an artifact byte-identical across two repositories and hash-pinned in each (`google-workspace-contract.ts:14-25,111-116`). |
| No non-GET licensing requests | PASS (by construction) | Every Google API call routes through `safeGet`, which hardcodes `method: "GET"` (`http-safety.ts:222`) — plus HTTPS-only, host allowlist, `redirect: "manual"`, per-request deadline, byte cap. The only `POST` on the Google path is the token request to `oauth2.googleapis.com`, and the contract **forbids the token host from appearing among `allowed_hosts`** (`google-workspace-contract.ts:123-125`), so no non-GET can reach `licensing.googleapis.com`. See the documentation note below. |
| Retry/backoff classification | PASS | Correctly separates Google's **403-quota** (`userRateLimitExceeded`, `quotaExceeded`, `rateLimitExceeded`, `backendError`, `internalError`) from **403-permission** (`google-workspace-pagination.ts:107-129`). Copying Okta's rule would have turned every quota event into a hard, non-retryable failure on exactly the largest tenants (`:17-19`). An unrecognized reason is treated as fatal — refusing to retry what we do not understand. |
| Bounded Retry-After | PASS | Honoured when present, capped at 60s; an excessive value fails closed rather than sleeping into the runtime budget (`:46`). The `headers.get` vs index-access trap that would silently ignore every `Retry-After` is called out and handled (`:77-91`). |
| Full-jitter backoff | PASS | Exponential from a 1s base, capped, with full jitter, used when `Retry-After` is absent — which for Google is the common case (`:23-24,47`). |
| Pagination guards | PASS | Repeated `pageToken` → `google_pagination_cycle`, fail closed (`:303-304`); per-page host pinning and exact path pinning (`:222,232`); page-token length bound (`:48`); page/record/retry/runtime budgets (`:42-44`); a partial or ambiguous result emits **nothing** (`:7`). |
| Projection / sanitization | PASS | Enumerated PII containers dropped by name and tallied; a raw secret-shaped key is deliberately **not** dropped because it is anomalous and swallowing it would hide it (`google-workspace-user-sanitize.ts:20-36,57-65`). The projection reduces `fact_json` to exactly the allowlisted `identity_account` keys and routes every Google-specific observation to `provenance_json` (`google-workspace-write-facts.ts:67-100`), so no raw-payload smuggling path into canonical evidence exists. `raw_payload` is never set. |
| Provider isolation | PASS | 0086's new functions are provider-**parameterized** with an allowlist containing only `google_workspace`; a caller passing `okta` is **refused** (0086:16-23). Okta's functions are untouched — not one byte — so this migration cannot alter, promote, or stale an Okta row even by mistake. Independently confirmed: 0086's `create or replace` of the shared `runner_insert_discovery_fact` is **strictly additive** (adds the `license` fact type and its minimal key allowlist); every pre-existing provider allowlist is byte-identical to 0077. |
| `certificationOnly` | PASS | `src/connector-sync/framework-registry.ts` — `google_workspace` carries `certificationOnly: true`. |
| `enabled: false` | PASS | v3 `src/lib/server/connector-vault/provider-registry.ts` — `status: "future"`, `enabled: false`. Not selectable in the product. |
| Pre-secret / pre-HTTP fail-closed live gate | PASS | `src/connector-sync/live.ts:50` returns `provider_certification_only` **before** any secret retrieval, HTTP call, DB connect, or run creation. Belt-and-suspenders: the Google manifest is runner-owned and absent from the vendored manifests directory the live path reads, and a `native_connector` manifest fails closed at `manifest_kind_not_executable` regardless. |
| Vendor pin current | PASS | `vendor:verify` OK — 31 files against pin `28172db`. Independently checked the limitation `vendor:verify` structurally cannot detect (it diffs against the pin, never against v3 tip): `git diff 28172db..53f68f1` over all vendored paths is **empty**. The pin is current, not merely self-consistent. |
| Offline gates | PASS | `npx vitest run` → **2521 passed / 130 files**; `npm run typecheck` clean; `npm run vendor:verify` OK; `npm run deploy:check` OK (44 files — role separation pinned, no plaintext DB URL, no secret values, no production ref). |
| Authorization gating of the three entrypoints | PASS | `verify`, `aggregate`, `persist` each carry a **distinct** confirm phrase *and* a **distinct** enable flag, so verify authorization can never trigger aggregate or persist. Plus `--app-env staging`, a production-ref regex over identity and DB URL, and token-host re-assertion immediately before every network call. `aggregate` holds **no writer in its dependency type**, so it cannot persist even if a caller wanted it to. |
| Logging / redaction | PASS | Exactly three `console.log` sites across the whole Google surface, all `emit()` of counts and verdicts. Library modules log nothing. No key, assertion, token, address, cursor, group name, SKU value, or raw page is ever logged. KMS errors are swallowed rather than surfaced because they carry the key ARN and caller identity (`google-workspace-kms-adapter.ts:70-73`). |
| Transactional promotion | PASS | Promote (users → groups → memberships, in dependency order), stale evaluation, run finish, and the advance to `discovered` all occur in **one transaction** (`google-workspace-persist.ts:319-342`). Any failure advances to `partial_failure`/`error` and promotes nothing, stales nothing. |
| Staleness invariant | PASS | Promotion clears `stale_since` (the 0070 invariant, preserved). Mass-staleness circuit breaker at 30% / 100 absolute (0086:414-422) — the established threshold. First-run-safe, latest-run-only, serialized by `FOR UPDATE` on the connector row. |
| Declared-unsupported honesty | PASS | `UNSUPPORTED_FINDINGS` is a first-class export naming the required scope or API for each gap (`google-workspace-findings.ts:56-64`), so parity-with-Okta assumptions fail in review rather than in production. |

### What this connector cannot support (its own declaration, verbatim)

- `unused_third_party_app_grant` — requires `admin.directory.user.security` (per-user OAuth token grants); deliberately not in the approved scope set
- `app_assignment_drift` — Google has no Okta-style application-assignment model; there is nothing to compare
- `licence_assigned_long_ago` — the Licensing API reports no assignment timestamp, so licence age is unknowable from this source
- `licence_cost_exposure` — the Licensing API reports no cost; spend must come from contracts/invoices
- `product_usage_inactivity` — requires `admin.reports.audit.readonly`; directory `lastLoginTime` is a sign-in signal, not product usage
- `named_admin_role_excess` — requires `admin.directory.rolemanagement.readonly`; only the `isAdmin`/`isDelegatedAdmin` booleans are available
- `shared_or_service_account` — Google marks no account as a bot/service account; any classification would be a guess from the address

Additional bounded-coverage limits, declared rather than hidden: licence enumeration covers five SKU
families only (`google-workspace-license-schemas.ts:80-86`) — a SKU outside that list is invisible;
external, nested-group, and whole-domain members are counted but cannot become edges; the sweep is
full-only, with no delta cursor.

---

## Secondary observations

Not blockers and not readiness gaps — recorded so they are not rediscovered later.

1. **The GET-only compensating control is real, but the test it cites does not exist.**
   `google-workspace-contract.ts:25` states the licensing write-capable exception is restrained by a
   GET-only rule "asserted against the licensing host by `google-workspace-contract.test.ts`". No
   such assertion is in that file. The property holds structurally (`safeGet` hardcodes GET; the
   token host is excluded from `allowed_hosts`), so the control is genuine — but it is enforced by
   construction, not by the named test, and the comment should not be read as evidence of one.
2. **Per-task least privilege is documented but not implemented.** `auth.ts:152-154` and
   `contract.ts:170-172` describe per-resource scope narrowing ("the users task requests
   `user.readonly` alone"). All three entrypoints request the **full four-scope set**
   (`verify-task.ts:51`, `aggregate.ts:87`, `persist.ts:168`); no per-resource task exists. The set
   requested is the reviewed set, so this is a documentation-versus-code divergence, not a widening.
3. **Granted scope is never verified.** The token response's `scope` is parsed then discarded
   (`token-schema.ts:71,99`), so an over-broad DWD grant is undetectable. Under-grant is caught by
   Google. This is the one lesson from the Slack Phase 8Q granted-scope gate not carried over —
   materially smaller here, because Google refuses rather than issuing a partial token.
4. **`scopeSetExactlyApproved` is a dead export** (`contract.ts:181`). Its comment says V3 uses it to
   validate the customer's granted set; V3 has zero callers.
5. **No aggregate budget across the member fan-out.** The paginator budget is per sweep, and persist
   issues one independent sweep per group — up to 2000, each with a fresh 400-page / 30-minute
   allowance. Acknowledged in `persist.ts:230-234`. Bounded in practice only by the fan-out cap and
   the ECS task timeout.
6. **Aggregate and persist use different fan-out caps** — 50 (`aggregate.ts:66`) versus 2000
   (`persist.ts:48`). Aggregate reports `complete: false` honestly when it truncates
   (`aggregate.ts:180-182`), so this is not a correctness issue, but an aggregate preview will not
   resemble the persist run on any tenant with more than 50 groups.

---

## Coordination record (Phase 0)

- Isolated worktree created from v3 `origin/main` on branch `phase18f/google-workspace-live-readiness`.
- Sibling 18F lanes live and non-overlapping: **A** `governance-findings-ui`, **B**
  `application-match-review-ui`, **C** `governance-ops-observability`. No competing D lane.
- **Baseline correction.** Google is already **merged** to `main` in both repositories — v3 #411
  (squash `28172db`, migration 0086) and runner #130 (squash `374a596`). The surviving
  `feat/google-workspace-connector` branches are post-squash leftovers; `git diff` against the merge
  commits is **empty** in both. Ancestry checks report "not merged" only because squash merges break
  ancestry, which is why this audit is baselined on `origin/main` rather than on those branches.
- **The provider-neutral governance engine was not modified by this lane.** This lane produces no
  code, no migration, no task-definition and no test change — only this document.

---

## Recommended order once separately authorized

1. Resolve **GWS-R1** — task definition *and* the test that enshrines the wrong name. Persist cannot run otherwise.
2. Resolve or explicitly accept **GWS-R2** for the chosen tenant.
3. Settle **GWS-E4** — confirm 0086 applied to hosted staging, and that a `verified` connector row exists.
4. Satisfy **GWS-E1** and **GWS-E2**; then flip **GWS-E3** to `verified`.
5. Run **verify** alone. It reads no directory data and discards the token — the cheapest possible first contact.
6. Run **aggregate**. Read-only, cannot persist by construction. Read the counts before anything is written.
7. Only then consider **persist**, with GWS-R3 and GWS-R4 accepted or closed.
