# 77 — Okta Production-Readiness — Phase 0 Gap Audit

**Status:** AUDIT ONLY. No code, SQL, migrations, or implementation in this pass.
**Method:** every claim below was read directly from source in this session. Where something is MISSING, I state the search that
failed. Docs describe intent; code describes reality — where they disagree, the code is the finding.

---

## 1. Repository state

| | |
|---|---|
| V3 | `main` @ `3b748868e3a600775cf7eb2dcd04f289f86eccdf`, migration max **0061** |
| connector-runner | `9f9fcd0` |
| V3 working tree | 7 untracked files from prior sessions (docs 74/75/76, review, Northstar fixture + script + test) |
| Tests | 1702 passed / 22 skipped / 0 failed at this head |

---

## 2. Old-app Okta capability inventory (verified by direct read)

| File | Lines | What it does |
|---|---|---|
| `webapp/functions/src/appScraping/scrapers/oktaScraper.js` | 190 | `@okta/okta-sdk-nodejs`; `client.userApi.listUsers({search, limit:200})`; `for await` pagination; filter `status eq "ACTIVE"` unless `includeInactiveUsers`; `skipExUsers` via `profile.ex_user` |
| `webapp/functions/src/appScraping/handlers/fetchOktaAppUsers.js` | 70 | `client.applicationApi.listApplicationUsers({appId})` with `.each()`; keeps `ACTIVE`/`PROVISIONED` |
| `webapp/functions/src/companies/IDCApps/syncIdpAssignments.js` | 146 | Callable + scheduled assignment sync **and stale cleanup** |
| `webapp/functions/src/appScraping/app_handlers/fetchOktaApps.js` | 32 | App enumeration handler |
| `frontend-v2/src/shared/scraperDescriptors.ts` | 791 | Scraper descriptor/config surface |

**User fields captured by the old scraper:** `UserID, Email, FullName, Status, LastLogin, Created, LastUpdated, FirstName,
LastName, Login, MobilePhone, PasswordChanged, ActivationDate` — plus `_rawData: JSON.stringify(user)`.

### 2.1 The three weaknesses that must never be reproduced — with quotes

**W1 — API error becomes zero, then deletes.** `syncIdpAssignments.js`:

```js
} catch (err) {
  oktaError = err.message || 'Unknown Okta API error';
  console.warn(`... Treating as 0 assignments (stale cleanup will run).`);
}
```

Step 4 then runs `assignmentsRef.where('lastSynced','!=',lastSynced)` and **hard `batch.delete()`s** every untouched assignment —
**unconditionally**, since `oktaError` is written to the parent doc but never gates cleanup. It cascades further, clearing `idp` on
app users whose `matchType === 'assignment'`. **A single 429 or 401 destroys all assignment evidence and the identity linkage.**

**W2 — no tenant/role authorization.** The callable checks `context.auth` only. `providerAppId`, `targetAppId` and `oktaAppId` all
arrive **from the client** with no ownership validation — any authenticated user could sync any app.

**W3 — plaintext credentials in ordinary records, raw provider objects stored.** Credentials read from
`IDCApps/{id}/private/scraperCredentials` → `{token, domain}` and `IDCApps/{id}/private/apiKey` → `{apiToken, domain}`.
`_rawData: JSON.stringify(user)` and `data: user` store whole Okta objects; `MobilePhone` is captured with no minimization.

---

## 3. Current V3 capability inventory (verified by direct read)

### 3.1 Reconciliation safety — **already solved, and better than the design brief asked for**

This is the headline finding. `runner_stale_absent_okta_identities` (migration `0053`) **cannot** reproduce W1. Before it marks
anything stale it requires **proof of complete observation**:

```sql
-- eligibility: only a complete, clean, last_page, non-quarantined run may EVER stale absent rows
if not found or v_complete is not true or coalesce(v_rejected, 1) <> 0
   or v_termination is distinct from 'last_page' or v_review is true then
  return ... 'eligible', false;
end if;
```

Layered on top of that:

| Guard | Behaviour |
|---|---|
| Ownership | raises if the run's connector is not the caller's tenant, or not provider `okta` |
| TOCTOU | `select … from connectors … for update` serialises stale/promote per connection |
| Latest-run guard | a **superseded** older complete run returns `superseded: true` and marks zero |
| First-run rule | the first promotion for a connection marks **zero** stale |
| Circuit breaker | `> stale_absolute_threshold` (default **100**) or `> stale_percent_threshold` (default **30%**) → marks **zero**, sets `review_required = true` |
| Destructiveness | *"mark ONLY absent rows … **Never hard-delete, never unlink people**"* — stale-marking only |
| Privilege | `revoke execute … from public, anon, authenticated` — only `connector_runner` may invoke |

An error yielding zero observations would compute 100% absent, blow straight through the 30% breaker, and mark **nothing**. W1 is
structurally impossible. Thresholds are policy-driven via `connector_discovery_policy`.

**Status: COMPLETE** for the sync path. This is the hardest and most dangerous part of the product and it is already built and
pgTAP-tested.

**One qualification that matters for Disconnect.** There is no `DELETE`/`TRUNCATE` of canonical rows anywhere in code, but there
**is** one hard-delete path: every canonical table cascades from `connectors` — `identity_accounts` (`0053:60-61`),
`directory_groups` (`0054:56-57`), memberships (`0056:50,53,56`), `directory_applications` (`0057:65-66`) and both assignment edges
(`0059:52,55,58` and `0059:90,93,96`), all `on delete cascade`. **Deleting a connector row deletes the entire imported directory.**
So a customer-facing "Disconnect" must be a **state change**, never a row delete — the `sync_status` vocabulary already has
`disconnected`.

### 3.2 Readers — five of six exist, and all are pilot-sized

**Correction to an earlier draft of this document.** I initially rated these COMPLETE on the strength of the file listing. A
deeper audit corrected that: the readers exist and are unit-tested, but **hard caps make them return nothing at real-org scale**,
and one resource is absent entirely.

| Resource | Path | Status | Limiting fact |
|---|---|---|---|
| Users | `/api/v1/users` | **FIXED in O1A** | `OKTA_DEFAULT_BUDGET.maxRecords = 100` (`okta-pagination.ts:20`) and **no entrypoint overrides it** — a tenant with >100 users returns `okta_record_cap`. No `?search`/`?filter` (URL is `?limit=N` only, `okta-users-aggregate.ts:77`), so no incremental mode and no equivalent of the old app's `status eq "ACTIVE"` filter. No controlled-run launcher and no runbook |
| Groups | `/api/v1/groups` | **COMPLETE** | The only reader that clears the bar end-to-end: runbook + controlled-run launcher + a real staging run. Sweep is duplicated between aggregate and persist (no shared core) |
| Group memberships | `/api/v1/groups/{id}/users` | **FIXED in O1A** | **`MEMBERSHIP_MAX_GROUPS = 10`** (`okta-group-membership-discovery.ts:24`) — a tenant with 11+ persisted groups returns `{kind:"over_cap"}` and reads **nothing** (`:73`). Also `MAX_TOTAL_REQUESTS = 25`, `MAX_TOTAL_RELATIONSHIPS = 500`. No runbook, never run live |
| Applications | `/api/v1/apps` | **COMPLETE** | `OKTA_APPS_BUDGET` = 10 pages / 500 records / **`maxRetries: 0`** — a single 429 kills the sweep |
| Direct app assignments | `/api/v1/apps/{id}/users` | **FIXED in O1A** | Same budget/cap family |
| Group app assignments | `/api/v1/apps/{id}/groups` | **FIXED in O1A** | Same |
| **Organization identity** | `/api/v1/org` | **MISSING** | A repo-wide grep of every `/api/v1/` literal finds only the six paths above plus `/oauth2/v1/token`. No org reader exists — and self-service **requires** one to confirm *which* org was connected and pin the connection to a stable org id. Needs a new scope (`okta.orgs.read`) |

### 3.2.1 O1A — what was fixed (connector-runner)

Delivered and verified; see `idcaddie-connector-runner/docs/OKTA_READER_BUDGETS_AND_RETRY.md`.

| Blocker | Resolution |
|---|---|
| `maxRecords = 100` | `OKTA_PRODUCTION_BUDGET` (400 pages / 80k records / 5 retries / 30 min) + validated `makeOktaBudget()` overrides |
| `MEMBERSHIP_MAX_GROUPS = 10` → empty `over_cap` | **Progressive sweep.** Bounded prefix + `groupsRemaining` + `nextGroupIndex`; production budget 2,000 groups |
| `MAX_APPLICATIONS = 10` → empty `over_cap` | Same redesign for assignments; production budget 1,000 applications |
| `handleRateLimit` had no caller | Bounded retry wired **once** inside the shared `paginateOktaUsers`; 429 via `Retry-After`, 5xx via exponential backoff + jitter, 401/403 never retried |
| `maxRetries: 0` on apps | Per-resource budgets supply retries; caller-supplied tighter budgets still honoured via `min()` |
| Budgets tallied only after the sweep | Enforced **in flight**, before a worker claims the next item |

**Three defects found while implementing, not present in the original audit:**

1. **All seven fetch wrappers dropped `Retry-After`**, forwarding only `link`. Bounded retry would have been **inert in
   production** — always failing closed on the first 429. Fixed in all seven.
2. **`capHit` absorbed non-budget failures**, so a 401 was reported as a budget cap. Now scoped to genuine budget stops.
3. **Retry metrics were lost on the failure path** — exactly when an operator needs them. Now returned on both paths.

**Verification:** 1301/1301 tests across 101 files, TypeScript clean, ESLint clean. 66 new tests. No hosted run, no Okta contact.

**Still open after O1A:** no durable checkpoint (continuation is *reported*, resumption is the orchestrator's job); no
incremental/delta read; no `?search`/status filter; organisation identity reader absent (O1C); Okta unregistered in the framework
registry (O1C).

**Rate-limit handling is implemented but never called.** `handleRateLimit` (`okta-pagination.ts:131-139`) is unit-tested and has
**no production caller** — grep finds only the definition, two comments and the test. `paginateOktaUsers` returns
`okta_rate_limited` on the **first** 429 (`:104`). Combined with `maxRetries: 0`, one throttle aborts a sync.

### 3.3 Auth and permission model — verified, and it is *not* a token paste

`src/connector-sync/okta-auth.ts`:

- **Preferred and implemented:** OAuth 2.0 client-credentials with **`private_key_jwt`** (a signed JWT assertion, **not** a
  client secret).
- **Legacy SSWS API token** is modelled as a credential *type* but is explicitly *"NOT the preferred path"* and has **no OAuth
  acquisition** — it would be sent directly as an `SSWS` header.
- Okta ids are opaque (`0oa…`), never UUIDs.

**Minimum permission model — exact, frozen, and enforced:**

```ts
export const OKTA_APPROVED_SCOPES = Object.freeze(["okta.users.read", "okta.groups.read", "okta.apps.read"]);
```

`scopesApproved()` requires requested ⊆ approved and **fails closed** (`unapproved_scope`). `okta.factors.read` and
`okta.logs.read` appear in the codebase but are **deferred and not accepted**. App writes (`okta.apps.manage`) are rejected.

**Three read scopes. Super Admin is not required and must not be requested** — this directly answers the brief's warning.

**But there are FIVE different scope lists in the repository, and the docs disagree with the code.** All six Okta docs say
`okta.users.read` **only** — `OKTA_STAGING_APP_SETUP.md:41` even says *"grant **only** `okta.users.read`. Do NOT grant
`okta.groups.read`, `okta.apps.read`…"*, and `OKTA_CONNECTOR_THREAT_MODEL.md:84` claims `scopesExactlyApproved` enforces exactly
`["okta.users.read"]`. Meanwhile the runner requests three. **Customer setup copy cannot be written until one list is made
authoritative** — and it must be the three-scope set, because that is what actually runs.

**The customer-facing public key is STALE — this alone would break the demo.** The wizard and runbook tell the customer to register
KID `i-Wptr6usN1tpkNp17vHXv_Mar4NPz53rn-bmlTq8j4` (`okta-content.ts:53` `OKTA_APPROVED_PUBLIC_KID`,
`OKTA_STAGING_APP_SETUP.md:34-38`), but every live task definition uses a **different** KID
(`VDkZAQoJl_prLRU83WiPreOBGoP6Fib3qC0CG880wz0`, `deploy/task-definition-okta-verify.json:29`). **A customer following the shipped
wizard registers the wrong key and gets `auth_assertion_rejected`.**

#### 3.3.1 — RESOLVED in O1B (2026-07-29)

Both findings above are closed. **PR O1B-RUNNER** (`idcaddie-connector-runner` #98) and **PR O1B-V3** established one authoritative
contract, `contracts/okta-provider-contract.v1.json` — **contract_version 1.0.0**, byte-identical in both repositories, pinned by a
SHA-256 (`46e627f8…`) asserted in each.

| Finding | Resolution |
|---|---|
| Five disagreeing scope lists | The three-scope set is authoritative. V3's `OKTA_APPROVED_SCOPES` corrected from two to three, and `okta.apps.read` **removed from `OKTA_PROHIBITED_SCOPES`** — it had been listed as prohibited while the runner required it, so a customer granting the correct scopes would have been *rejected at the config gate*. All six docs and the runbooks corrected with `superseded` annotations. |
| Stale customer-facing KID | `okta-content.ts` and `OKTA_STAGING_APP_SETUP.md` now publish `VDkZ…wz0`, matching all 12 task definitions. The stale value survives only as a negative test constant. |

**Two findings this audit did not surface**, both discovered during implementation:

1. **A DB CHECK made the three-scope contract unstorable.** `0048:49` pinned `approved_scopes` by exact *array equality* to
   `array['okta.users.read']` — users-only **and** order-sensitive. No three-scope binding could be inserted at all, so the live
   connection flow would have failed at the first write, after the customer had already configured Okta correctly. Migration
   **`0062`** replaces it with an order-independent, duplicate-rejecting, NULL-rejecting exact-set CHECK. Added `not valid` so a
   pre-existing users-only staging row does not fail the apply; new and updated rows are fully constrained. Migration max **0061 →
   0062**. **Not applied hosted.**
2. **Nothing enforced the KID.** All 12 task definitions were already correct, so the audit rated infrastructure fine — but no test
   would have caught the next drifting edit. `okta-contract-consistency.test.ts` now does, in both repositories, and was verified
   by **mutation**: reverting one task definition to the stale KID fails 4 assertions.

**The admin-role requirement is recorded as UNRESOLVED, not guessed.** The runbook previously specified a Read-Only Administrator
constrained to a users-only resource set, which cannot be correct for `okta.apps.read`. OAuth scopes and Okta admin-role assignment
are separate mechanisms; the minimum role must be determined empirically against the dedicated test organisation. No Super Admin
wording was introduced.

**Live KID verification remains OUTSTANDING.** Repository consistency is not proof that the public key is registered on the real
Okta application or that the three scopes are granted. Production enablement stays gated.

#### 3.3.2 — O1C RESOLVED: organization identity + registry reconciliation (2026-07-30)

**PR O1C-RUNNER** (`idcaddie-connector-runner` #99) and **PR O1C-V3**. **No fourth scope was added** — identity is derived from
verified request context, so `okta.orgs.read` proved unnecessary. Contract stays at **1.0.0**.

| Audit finding | Resolution |
|---|---|
| **Organization identity MISSING** (`/api/v1/org` absent) | Not needed. A versioned, deterministic `organizationFingerprint` is derived from provider + canonical org host + verified token endpoint. It is an **IDCaddie-derived value, never an Okta-issued org ID** — the access token is opaque, so there is no issuer claim to read and no signature we verify. Documented precisely rather than overclaimed. |
| **Okta unregistered in `framework-registry.ts`** while 12 entrypoints ran | Registered as `certificationOnly`, mirroring `microsoft_entra`. Reverses a prior judgement that absence was "a stronger dormancy posture" — the objection is truthfulness, not strength. Block count verified **not** to have decreased. |
| `OKTA_RESOURCES = ["users"]` vs six real flows | A purpose-built capability declaration states six resources, eight capabilities and eight not-yet-complete items, bound by test to the real entrypoints in **both** directions. |

**Two defects this audit did not surface**, both found during implementation:

1. **The runner had no Okta apex allowlist.** `okta-auth.ts`'s `ORG_HOST` is a transport check accepting any lowercase dotted host
   with an alphabetic TLD — `evil.example.com` passed it. An identity-grade, boundary-anchored allowlist now rejects lookalikes
   (`notokta.com`, `okta.com.evil.com`, `okta.co`, `0kta.com`, punycode).
2. **V3's wizard accepted hosts the runner rejects.** `a.b.okta.com` and `acme.internal.okta.com` validated in the wizard but fail the
   runner's single-label rule — a customer could have completed setup and then had every sync fail. Both sides now agree, asserted by
   a shared host-policy matrix.

**Also corrected:** the wizard's **"Use a custom Okta domain"** checkbox never enabled custom domains — it only disabled the
convenience `.okta.com` append. Custom domains are structurally unsupported (the signer requires `issuerUrl === https://${orgHost}`),
so the label promised something the product does not do. Relabelled, and the limitation is now stated.

**Deliberately deferred:** `manifests/okta.v1.json` is not rewritten. Its schema pins `discovery_only`/`promotion_disabled` to
`z.literal(true)` plus single-resource literals and a superseded pilot budget. Its flags are true *of the manifest-driven executor
path* that the standalone persist tasks do not use — a real distinction, but one easy to misread. **Residual, stated plainly:** a
reader of that file alone would still infer a users-only, non-promoting connector. Reconciling it remains **OPEN**.

**Rotation and reconnect rules are defined, not implemented** (O2/O6): rotation requires an organization-fingerprint match and must
not replace the existing credential on mismatch; a different organization must never silently repoint an existing connector.

**Live KID verification and production enablement remain OUTSTANDING.**

#### 3.3.4 — O2A: connector persistence and security foundation (2026-07-30)

Migration **`0063`** adds `okta_connector_configs`: a narrow, typed, tenant-scoped record holding **metadata only**. There is no
secret column, no key material, and **no credential reference** — the approved architecture (docs/78) gives an Okta connector no
per-connector secret at all, which is what dissolved the O2 secret-write blocker.

**Placement.** A new table rather than columns on `connectors` (which carries a table-wide `authenticated` SELECT grant, so any
Okta column added there becomes readable by every tenant member) and rather than `connector_okta_issuer_bindings` (an
operator-approved **issuer allowlist**: organization-scoped, `has_org_role` manager read, service_role-only writes — a different
concept, owner and lifecycle).

**The database refuses to represent an untruthful configuration.** `certification_only` is pinned true and `production_enabled`
pinned false by CHECK, so no write path can flip them. Scopes are an exact, order-independent, duplicate- and NULL-rejecting set.
Contract version and authentication mode are pinned. Most importantly, **a verified organization fingerprint cannot exist without a
successful validation** — and `verified_organization_fingerprint` is not a parameter of the write RPC at all, so O2A is structurally
incapable of producing one.

**Proposed vs verified identity.** The O1C derivation needs only host + client id, so it *can* be computed at configuration time —
but its trustworthiness comes from a verified token endpoint, and O2A verifies nothing. It is therefore stored as **proposed**, with
the verified column NULL until O2B/O2D performs a real token exchange.

**Cross-repository fingerprint agreement.** The derivation is implemented in both repositories (they share no package) and pinned by
**known-answer vectors** asserted in V3, generated from the runner. A silent divergence would make a legitimate reconnect read as
`different_organization`. *Recommended follow-up: a one-file reciprocal test in the runner, so drift in **either** direction fails.*

**Deletion stays unavailable.** `connectors` is the parent of **19 `on delete cascade` FKs across 12 tables**, so a delete would
silently destroy the tenant's canonical directory graph. Disconnect is a future lifecycle transition (O6), never a row deletion.

**Two findings worth recording:** the authoritative state vocabulary lives in `0052`, not `0050`, and already contains the state O2A
needs (`configured`) — so no state was added; and **RLS, not table grants, is the enforcement boundary**, because the platform
blanket-grants DML on public tables to `authenticated`.

**Still outstanding:** live KID verification, custom-admin-role viability, the KMS key (O2B), JWKS publication (O2C), and production
enablement.

#### 3.3.3 — O1C.1 CLOSED: truthful manifest model + admin role resolved (2026-07-30)

The two items O1C left open are closed.

**1. The manifest contradiction is resolved in the schema, not in prose.**

`manifests/okta.v1.json` could not be made truthful because the **neutral vendored manifest schema is an executor program**:
`base_url` + `endpoints` + `field_map` + `pagination` tell the generic executor how to fetch and map. Three structural blocks made
Okta unrepresentable:

| Block | Why |
|---|---|
| `base_url` is one constant host, allowlisted by exact hostname | Okta's base URL is **per-tenant** (`https://<org>.okta.com`), server-derived from the connection. No constant host can exist. |
| `field_map` is mandatory for a fact-emitting endpoint | Okta normalizes in reviewed TypeScript with its own response schemas. A declared `field_map` would claim to drive an executor that never reads it — a **new** fiction. |
| `EMIT_FACT_TYPES` has no member for application assignments | Two of the six resources could not declare an emit type at all. |

So the neutral schema was **extended generically** (`src/lib/server/connectors/manifest-schema.ts`) with a provider-agnostic
lifecycle envelope and a second manifest kind, `native_connector`, for providers implemented by reviewed native code. Any future
native provider uses it; the neutral schema stays authoritative, so there is no provider-specific format that only one provider's code
understands. **Backward compatibility is the load-bearing property:** `manifest_kind` defaults to `executor_program`, so
`slack.v1.json` validates **byte-unchanged** with no field added — asserted by test.

**Execution safety is enforced by the schema itself.** A `certification_only` provider **cannot** declare
`production_enabled: true` or waive `explicit_hosted_authorization_required` — the refinement rejects the combination, so no manifest
input can express it. The capability enum contains **no** mutate/write/grant/revoke verb, so a write capability is not declarable. The
constraint keys off `status`, not off a provider name, so it is generic policy rather than an Okta special case (proved by a test
showing an `enabled` provider *may* declare production).

**2. The Okta admin-role requirement is RESOLVED from official documentation** — not guessed, and not Super Admin.

| Question | Answer | Source |
|---|---|---|
| Is an admin role required in addition to scopes? | **Yes.** Okta does not assign one to a service app automatically; without it every call returns **403** even with all three scopes granted. | [service-app guide](https://developer.okta.com/docs/guides/implement-oauth-for-okta-serviceapp/main/), [support article](https://support.okta.com/help/s/article/how-to-assign-the-correct-admin-role-to-a-service-application?language=en_US) |
| Minimum standard role | **`Read Only Administrator`** — views users, groups, apps and app instances | [read-only administrators](https://help.okta.com/en-us/content/topics/security/administrators-read-only-admin.htm) |
| Is Super Admin required? | **No.** No official source requires it; the support article's own read-only example uses Read Only Admin. | as above |
| Custom role with a resource set? | **Not recommended in v1.** Okta exposes **no read-only permission for application *user* assignments** — only *"Edit app's user assignments"*, a **write** permission we must never request. A least-privilege custom role may 403 on `/apps/{id}/users`. **UNVERIFIED**; needs test-org confirmation. | [role permissions](https://help.okta.com/en-us/content/topics/security/custom-admin-role/about-role-permissions.htm) |

**Accepted trade-off, stated plainly:** `Read Only Administrator` has **no optional resource targets**, so it cannot be narrowed to a
subset of the org — it grants org-wide *read*. Accepted because the alternatives are a write permission or an unverified
configuration.

**A diagnostic falls out of the distinction, and is now in the setup copy:** an insufficient **scope** fails at *token request*
(`invalid_scope`); an insufficient **admin role** fails at the *API call* (`403 Forbidden`). That tells a customer which of the two
steps they missed.

**Still outstanding after O1C.1:** live KID verification, custom-admin-role viability, and production enablement. **No fourth scope
was added; the scope/KID contract remains 1.0.0.**

### 3.4 Self-service UI — the wizard exists but its last step is a demo store

`src/app/(authenticated)/connectors/[provider]/connect/okta-connect-wizard.tsx` is a real 4-step flow
(Instructions → Organization → Configuration → Review → saved) importing genuine validation:
`validateOktaOrgHost`, `normalizeOrgInput`, `ORG_HOST_MESSAGE`, `validateOktaClientId`, `OKTA_CONTENT`, `OKTA_SETUP`,
`OKTA_APPROVED_PUBLIC_KID`.

**But:** it calls `setDemoConnection` from `@/lib/customer-connectors/demo-store` — a client-side store. And
`src/lib/data/connectors.ts` is **read-only**: `listConnectorsForCurrentUser` selects an explicit safe subset and there is **no
INSERT into `connectors` anywhere in `src/`** (searched `from("connectors")` across `src/` — one hit, a SELECT).

**Status: PARTIAL.** The customer-facing surface is perhaps 80% built and then stops at the trust boundary.

### 3.5 Governance gating — real Okta calls happen today, outside the governed path

Two facts that sit uncomfortably together:

- **Okta is deliberately unregistered** as a framework provider: *"The Okta provider is intentionally NOT registered in the runner
  framework-registry (so `resolveFrameworkProvider("okta")` fails closed)"* (`okta-manifest.ts:8-9`), and the manifest admits
  exactly one resource — `OKTA_RESOURCES = ["users"]`.
- **Yet real Okta API calls do happen**, through 12 one-shot hosted Fargate entrypoints that **bypass the manifest and the
  framework registry entirely**.

So the "governed" path knows only about users, while the actual working readers run outside it. Registering Okta properly means
extending `OKTA_RESOURCES` to all six resources, relaxing the `certification_only` / `discovery_only` literals, raising the manifest
budget ceilings, and adding Okta to `framework-registry.ts`. **Evidence capture is also missing** — the hosted runs happened but no
evidence document records them.

---

## 4. Parity / gap matrix

| # | Old behaviour | V3 status | Evidence | Work required |
|---|---|---|---|---|
| 1 | Marketplace entry | COMPLETE | `customer-connectors/catalog` | — |
| 2 | Setup instructions | COMPLETE | `OKTA_CONTENT`, `OKTA_SETUP` | Re-verify scope copy against Okta docs |
| 3 | Domain validation | COMPLETE | `validateOktaOrgHost`, `normalizeOrgInput` | — |
| 4 | Credential validation | PARTIAL | `okta-verify-task` exists; no customer path reaches it | Wire wizard → verify |
| 5 | Org discovery | PARTIAL | verify task validates org + scope | Return safe org label to UI |
| 6 | Connection creation | **MISSING** | no INSERT into `connectors` in `src/` | **Server action + DAL + RLS write** |
| 7 | Secret storage | PARTIAL | vault `0017`–`0043`, `connector_credential_references` `0043` | Customer-initiated write path |
| 8–15 | All six resource reads | COMPLETE | §3.2 | Orchestration only |
| 16 | Status normalisation | COMPLETE | bounded category columns (`0053`/`0057`) | — |
| 17–18 | Repeat / incremental sync | PARTIAL | per-resource ECS tasks exist | Single "Sync Now" orchestration |
| 19–20 | Stale / deletion | **COMPLETE** | §3.1 | — |
| 21 | Partial failure | **COMPLETE** | eligibility gate | — |
| 22–24 | Rate limits, retry, checkpoints | UNVERIFIED | not confirmed this session | Audit in PR O1 |
| 25–27 | Progress, counts, errors | PARTIAL | `connector_run_discovery` metrics exist | Customer status surface |
| 28 | Credential rotation | MISSING | — | PR O6 |
| 29–30 | Disconnect / reconnect | MISSING | — | PR O6 |
| 31–32 | Tenant / role authorization | COMPLETE | RLS + `has_tenant_role` + in-body RPC checks | Apply to new write paths |
| 33 | Audit events | PARTIAL | `0010`/`0042` trigger precedent | Connector-specific events |
| 34 | Data minimisation | COMPLETE | allowlisted columns, no raw payload | — |
| 36 | Scheduled sync | DORMANT | `0046` schedule policy exists, disabled | Enable per-tenant |
| 40 | Production acceptance | MISSING | — | PR O7 |

---

## 5. Production blockers (corrected)

The deep audit surfaced **96 capabilities, 46 of them production-blocking**, and corrected 15 of its own first-pass ratings.
Grouped:

| # | Blocker | Why it blocks |
|---|---|---|
| **B1** | No connection-creation write path | Wizard ends in browser `sessionStorage`; **no INSERT into `connectors` anywhere in `src/`** |
| **B2** | No customer credential submission | Vault exists; no customer-initiated write reaches it. No per-tenant key material |
| **B3** | No sync orchestration | 12 one-shot Fargate entrypoints, no customer-triggered run |
| **B4** | No real status surface | `/connectors/[provider]/status` reads demo state; app code never reads `connectors.connection_state` (0049/0050/0051) |
| **B5** | Okta unregistered + manifest admits only `users` | Governed path can't run five of six resources |
| **B6** | Rotation / disconnect / reconnect missing | And **disconnect must not delete** — the connector cascade would wipe the directory (§3.1) |
| **B7** | **Rate-limit retry never wired** | `handleRateLimit` has no caller; first 429 aborts; `maxRetries: 0` |
| **B8** | **Pilot-sized caps** | 100 users, **10 groups for memberships**, 500 relationships — real orgs read nothing |
| **B9** | **Org identity reader missing** | Self-service can't confirm which org was connected |
| **B10** | **Stale public-key KID in customer copy** | Customer registers the wrong key → auth fails |
| **B11** | Five conflicting scope lists | Setup copy cannot be written truthfully until reconciled |
| **B12** | No live acceptance, no evidence capture | Hosted runs happened but were never evidenced |

## 6. Proposed permission model (customer-facing)

**Okta API Services app using OAuth 2.0 client-credentials with `private_key_jwt`.** Customer steps:
create an API Services app → register IDCaddie's public key → grant exactly `okta.users.read`, `okta.groups.read`,
`okta.apps.read` → supply org host + client ID.

**The customer never pastes a secret** — IDCaddie holds the private key and the customer authorises a public key. This is
materially safer than the old app's SSWS token and is what is already implemented.

**Open product decision:** SSWS is modelled but unpreferred. Supporting it would give a one-field "paste a token" UX at the cost of
a broad, user-tied credential. **Recommendation: private_key_jwt only for v1**, since it is what the code implements and what the
scope enforcement is built around.

---

## 7. Proposed architecture (unchanged where it already works)

**Do not rebuild §3.1 or §3.2.** The work is the connective tissue:

```
Wizard (exists) → server action (NEW) → server-only DAL (NEW) → vault secret write (exists)
                                      → connectors INSERT (NEW, RLS + owner/admin)
                                      → verify via okta-verify-task (exists)
                                      → sync orchestration (NEW) → aggregate+persist tasks (exist)
                                      → promotion + stale RPCs (exist, safe)
                                      → canonical graph → /access (exists)
```

Reconciliation model: keep exactly what `0053` implements — completeness-gated eligibility, latest-run guard, first-run rule,
circuit breaker, stale-marking only, never delete.

---

## 8. PR plan

| PR | Scope |
|---|---|
| **O1** | Finish this audit: verify rate-limit/retry/checkpoint behaviour (B7), the runner gating chain (B5), and confirm the scope copy against current Okta documentation |
| **O2** | **Connection creation** — server action + DAL + RLS write + credential submission to the vault + verify wiring + audit events (B1, B2) |
| **O3** | **Sync orchestration** — one customer-triggered run across the six existing readers, with concurrency guard (B3) |
| **O4** | **Real status surface** — replace demo-state with connection state, counts, last successful complete sync, warnings (B4) |
| **O5** | Rotation, disconnect, reconnect (B6) |
| **O6** | Ungate Okta for staging; scheduled sync enablement (B5) |
| **O7** | Live test-org acceptance + full matrix + go/no-go (B8) |

---

## 9. Critical path and realistic weekend scope (corrected)

My first pass said O2+O3+O4 would give a live-Okta demo. **That was too optimistic** — it assumed the readers were production-ready.
They are pilot-sized, and three of them return *nothing* at real-org scale.

**Minimum for a live demo, in dependency order:**

1. **B8 caps** — raise `maxRecords` (100), `MEMBERSHIP_MAX_GROUPS` (**10**), relationship caps. Without this a real test org imports nothing.
2. **B7 retry** — wire `handleRateLimit`; set `maxRetries > 0`. Without this one 429 aborts the demo.
3. **B10 KID** — correct the customer-facing key, or the wizard cannot be followed at all.
4. **B1/B2** — connection creation + credential submission (the trust-boundary gap).
5. **B3** — orchestrate one run across the readers.
6. **B4** — real status surface.

**Honest assessment:** items 1–3 are small but *mandatory*; 4–6 are the real build. A live-Okta demo is achievable only if the test
org is kept small (≤10 groups, ≤100 users) so the existing caps are not hit — which is a legitimate demo choice, but must be stated
rather than presented as production scale.

**Recommended:** keep the **Northstar fixture as the primary demo** (it is deterministic, complete, and already verified), and add
live Okta as a *second* chapter showing a real connection + import against a deliberately small test org. That gets a truthful live
story without betting the demo on caps and retry work landing.

**Still blocking production afterwards:** B5, B6, B9, B11, B12, plus the full failure-drill matrix and a separate authorization to
move Okta off `certificationOnly`. RISK-007 is CLOSED at its staging-defined criteria and Phase C is UNBLOCKED **as a governance
state only** — neither authorises a production Okta connection.

## 10. Audit completeness note

The six-lens parallel inventory (12 agents, adversarially verified) **did complete**, and it materially corrected this document.
15 of its own first-pass ratings were downgraded by its verifier, and several of **my** ratings were wrong — I had marked the
readers COMPLETE on the strength of a file listing, when caps make three of them non-functional at real scale, and I missed the
absent org-identity reader entirely. Those corrections are folded in above.

Two areas remain worth independent confirmation before relying on them: the precise per-resource budget ceilings under load, and
whether any hosted run has ever exercised the assignment readers end-to-end (no evidence document records one).
