# 78 — Okta Authentication Architecture (O2 foundation)

**Status:** APPROVED architecture, uncommitted for human review. **No code, SQL, migration, PR, hosted change, or Okta change was
made in producing it.**

**Repo heads at authoring:** V3 `55fc012` · connector-runner `3b671ef` · migration max **0062** (unapplied hosted).

---

## 1. Executive decision

**IDCaddie owns the Okta private signing key. It lives in an asymmetric AWS KMS key, is never exported as PEM, and is never
duplicated per customer.** The customer creates their own Okta API Services app, configures it to trust IDCaddie's public key, and
supplies only two **non-secret** values: the organization host and the client ID.

The decisive consequence:

> **A connector has no secret.** `client_id` and `org_host` are non-secret; the only secret is one platform KMS key that never
> leaves KMS. There is therefore **nothing to write per connection**, and the O2 secret-write P0 blocker is *dissolved*, not
> worked around.

Three structural changes:

| # | Change | Effect |
|---|---|---|
| 1 | Private key → **KMS asymmetric, non-exportable** | No key material exists to steal; "compromise" becomes bounded, audited, revocable `kms:Sign` abuse |
| 2 | Static public key → **published JWKS URI** | Rotation becomes a platform operation; **verified configurable in the Admin Console**, so self-service onboarding is viable |
| 3 | Per-connection secret document → **connector row** | Customer identity and platform crypto stop being bundled together |

**Nothing in O1A / O1B / O1C is invalidated.** Budgets, retry, progressive sweeps, completeness gating, reconciliation safety, the
three-scope contract and the organization fingerprint all stand unchanged.

---

## 2. Current-state inventory

### 2.1 Runner (`3b671ef`)

| Component | Today |
|---|---|
| Secret shape | `{ client_id, okta_domain, private_key }` — `okta-assertion-signer.ts:61` |
| Secret locator | `SecretReference { secretArn, credentialVersion }`, **per connector** |
| Signing | `crypto.createPrivateKey(pem)` → `crypto.sign("sha256", …)` — local, in-process, from PEM material |
| Key algorithm check | `keyObject.asymmetricKeyType !== "rsa"` → rejected |
| Assertion claims | `iss = sub = clientId`, `aud = ${issuerUrl}/oauth2/v1/token`, `exp = now + ttl` (cap 300s), fresh `jti` |
| Binding checks | secret's `okta_domain` must equal expected `orgHost`; secret's `client_id` must equal expected `clientId`; `issuerUrl` must equal `https://${orgHost}` |
| Token response | `token_type`/`access_token`/`expires_in` only; opaque token, discarded after use |

### 2.2 AWS / staging (metadata only — **no secret value was read; `get-secret-value` was never used**)

| Item | State |
|---|---|
*Verified read-only against account `833822972703` / `ca-central-1` during O2B.0. No value was read; `get-secret-value` was never
used; nothing was mutated.*

| Item | Verified state |
|---|---|
| Secret container | `/idcaddie/staging/connector/okta/staging-app-v1` — **POPULATED** (see the correction below) |
| IAM | `idcaddie-staging-okta-secret-read` — **`secretsmanager:GetSecretValue` only**, exact ARN, explicitly *no write/update/delete* |
| Task role / exec role | `idcaddie-staging-slack-taskread` / `idcaddie-staging-connector-runner-exec` — separation preserved |
| Task-definition env | `OKTA_VERIFY_SECRET_ARN` and DB URL are `REPLACE_WITH_…` placeholders resolved at deploy; `OKTA_VERIFY_SECRET_VERSION=AWSCURRENT`; `OKTA_VERIFY_CLIENT_ID=0oa15fcokefFqDREa698`; `OKTA_VERIFY_KID=VDkZ…wz0` in all 12 |
| KMS keys present | `idcaddie-staging-kek` and `idcaddie-staging-connector-vault` — **both `SYMMETRIC_DEFAULT` / `ENCRYPT_DECRYPT`. Neither can sign.** |
| KMS signing key | **MISSING.** No `SIGN_VERIFY` key exists. |
| `kms:Sign` grant | **MISSING.** The task role holds only `kms:Decrypt` + `kms:GenerateDataKey`, on the vault key. |
| `kms:GetPublicKey` grant | **MISSING.** No principal holds it. |
| KMS admin role | `idcaddie-staging-kms-admin` — pinned by ARN to the two existing keys; **has no `kms:CreateKey`** |
| CloudTrail | **MISSING. No trail exists in the inspected account.** Default Event history (90 days, non-durable, not alarmable) only. |
| JWKS hosting | **MISSING.** No S3 bucket and no CloudFront distribution exist for this purpose. |
| Staging/production isolation | **UNVERIFIED.** Everything visible is staging (all secrets `/idcaddie/staging/`, one ECS cluster, all roles `idcaddie-staging-*`, KMS keys only in `ca-central-1`). Whether production is a separate account cannot be confirmed from this vantage point and is **not assumed**. |

### SUPERSEDED — the staging secret is NOT empty

An earlier revision of this document, following `docs/evidence/P5E18C`, stated: *"Version stages: NONE — an EMPTY container; no
secret body / no placeholder material was written."* **That claim is false as of the O2B.0 verification.** Metadata shows:

```
VersionStages : AWSCURRENT 54f336a3… , AWSPREVIOUS 699dfd81…
Created       : 2026-07-17      LastChanged : 2026-07-23      LastAccessed : 2026-07-23
Tags          : SecretMaterial=none , State=dormant
```

Two version stages, a change date six days after creation, and a recorded access mean **material was written — twice — and has been
read**. Because the runner's secret document is `{client_id, okta_domain, private_key}`, this must be treated for risk and migration
planning as **containing exportable private-key PEM**.

**The tags are inaccurate.** `SecretMaterial=none` and `State=dormant` no longer describe reality, so anyone auditing by tag would
wrongly conclude no key material exists. Correcting them is a **separately authorized** action (O2B.1) — a tag write is still a
write.

**Handling:**

| Rule | |
|---|---|
| The secret is **transitional** | It backs the current PEM signer until the KMS migration completes |
| **No value inspection is required** — or permitted | The metadata above is sufficient for every decision here |
| **No deletion during O2B** | Deleting it now would break the existing signer with nothing to replace it |
| Retire the secret **and** its IAM policy | Only **after** KMS migration and live validation both succeed |
| Tag correction | Separately authorized; do not bundle it into a code PR |

### 2.3 V3 (`55fc012`)

`connectors` has `tenant_id, provider, status, granted_scopes_safe, connected_by, connection_state` (CHECK narrowed by `0050` to
only `configured` / `verification_pending`). `connector_credential_references` holds an opaque ARN pointer with unique
`(tenant, connector, provider)` and an Okta ARN-namespace CHECK. **Missing:** `client_id`, `normalized_org_host`, both fingerprints,
signing-key reference, `contract_version`. Wizard `save()` writes only to **sessionStorage** via `setDemoConnection`.

---

## 3. Why per-connector private-key storage is rejected

| Defect | Consequence |
|---|---|
| **Key fan-out** | Every customer registers the *same* public KID, so N connectors ⇒ **N copies of one private key**. Blast radius scales with customer count while posture does not improve. |
| **Exportable material** | A stolen PEM is permanent, silent and unrevocable. A KMS grant is bounded, audited and revocable. |
| **O(N) rotation** | Rotating the platform key means rewriting N secret documents, each able to partially fail. There is no atomic "the platform key is now X". |
| **Category error** | The document bundles customer identity (`client_id`), customer topology (`okta_domain`) and **platform crypto** (`private_key`) — three things with different owners and lifecycles. A customer recreating their app should never require touching platform key material. |
| **Contradicts the product** | The customer never possesses the private key, so a "per-connection credential" containing it is platform key material wearing a customer's label. |
| **Manufactures a blocker** | It is the sole reason O2 appeared to need a secret-write path that IAM deliberately forbids. |

**What is right in the current model and is retained:** reference indirection (DB stores a pointer, never a value) · audience binding
to the customer's exact token endpoint · `issuerUrl === https://${orgHost}` derivation · exact-path token URL, redirect rejection,
host allowlist · read-only IAM posture · `credential_version` metadata.

---

## 4. Key ownership

**IDCaddie owns the key.** In `private_key_jwt` the assertion proves *the client's* identity to the customer's authorization server,
and IDCaddie **is** the client. Requesting a customer private key would invert the trust model and create a custody problem.

**The customer keeps the strongest lever:** they can revoke IDCaddie unilaterally, at any time, with no coordination, by removing the
key or JWKS URI from their app. That is the correct placement of the revocation control.

**Default cardinality: one signing-key set per IDCaddie environment.** Per-customer keys are largely theatre when every key sits
behind the same KMS grant — the control plane is the real boundary, not key count — and they multiply onboarding friction and
rotation cost by N. **But the schema carries `signing_key_id` / `signing_key_version` per connector**, so a high-assurance customer
can be escalated to a dedicated key as *policy*, with no migration. Cardinality must never be hard-coded.

**The honest trade-off:** a shared platform key makes signing a shared platform capability. Tenant isolation is therefore enforced by
**connector resolution and assertion binding**, not by cryptography — see the §6 invariant, which must be independently tested.

---

## 5. Connector metadata model

**Metadata only.** Illustrative shape — no migration is written here.

| Field | Notes |
|---|---|
| `id`, `tenant_id`, `provider='okta'` | tenant-scoped |
| `normalized_org_host` | canonical, from `canonicalizeOktaOrgHost` (O1C) |
| `client_id` | customer's service-app id — **non-secret** |
| `organization_fingerprint` | O1C; excludes `client_id` |
| `service_app_fingerprint` | O1C; includes `client_id` |
| `signing_key_id`, `signing_key_version` | which platform key this connection was validated against |
| `contract_version` | `1.0.0` |
| `approved_scopes` | the exact three read scopes |
| `authentication_mode` | `private_key_jwt` |
| `status` / lifecycle | §5.1 |
| `certification_only`, `production_enabled=false` | governance, mirrors the manifest |
| `created_by`, `created_at`, `updated_at`, `last_validated_at` | audit |

**Never stored:** private key · PEM · access token · client assertion · refresh token · customer API token · duplicated key material
· raw OAuth response.

**Because `organization_fingerprint` excludes `client_id` (O1C), it survives both app recreation and key rotation** — the decision
pays off exactly here.

### 5.1 Connection states

`draft` → `validating` → `ready_for_initial_sync` · terminal failures `validation_failed`, `credential_invalid`,
`permission_insufficient`. **Never `healthy`/`connected` merely because a row exists** — health requires a completed sync.
`0050` narrowed the CHECK to two values, so O2A must widen it.

### 5.2 `connector_credential_references`

**Stops applying to Okta** — there is no per-connector secret to point at. It remains correct for providers with genuine
per-tenant credentials (Slack bot tokens, Entra). **Do not delete it; scope it.** The Okta ARN-namespace CHECK from `0050` becomes
dead for Okta and should be retired deliberately, not silently.

---

## 6. KMS signer design

Behind the **existing `signOktaClientAssertion` interface** — that shape is good; only the implementation changes.

```
connector_id
  → authorize actor (owner/admin) + load TENANT-OWNED connector row
  → normalized_org_host, client_id  ← FROM THE ROW
  → resolve ACTIVE signing key      ← FROM ENVIRONMENT CONFIG
  → aud = https://{normalized_org_host}/oauth2/v1/token
    iss = sub = client_id ; kid = active key id ; exp ≤ 60s ; fresh jti
  → kms:Sign(RSASSA_PKCS1_V1_5_SHA_256)
  → base64url(signature) → assertion
  → exchange → access token → use within THIS operation → discard
```

### The invariant

> **The signer must never accept a caller-supplied `aud`, `iss`, `sub`, `kid`, org host, tenant authority, or signing-key ARN.**
> Every one is derived from the authorized connector row or environment configuration.

With a shared platform key this **is** the tenant-isolation boundary. It requires its own tests, not incidental coverage.

### Signature encoding

RS256 + `RSASSA_PKCS1_V1_5_SHA_256` returns a raw PKCS#1 v1.5 signature that base64url-encodes **directly** — no transformation.
**Do not switch to ECDSA/ES256 without handling the encoding difference:** KMS returns **DER**-encoded ECDSA, while JWT requires raw
`r‖s`. That mismatch is a classic silent-failure bug. RSA_2048 is recommended for v1 precisely because the encoding path is trivial.

### Local development

A fixture-key signer may exist for local tests **only**, behind a build/env gate that no production or hosted task can select, with a
test asserting the production composition root cannot resolve it.

---

## 7. JWT and token lifecycle

**Assertion:** `exp ≤ 60s` (Okta's ceiling is 1 hour; we use far less), fresh `jti`, audience-bound to exactly one token endpoint,
single use.

**Access token:** Okta's lifetime is a fixed 1 hour. It is the **highest-value artifact in the system** — an org-wide read bearer
credential. Therefore: never persisted · never written to disk · never in the DB · never in Secrets Manager · never logged · never in
metrics · never returned to V3 or the browser · held in the runner process for the current operation only · discarded on completion
**and on failure**.

**No refresh token exists in client-credentials, and none must ever be introduced.** `maxTokenRequests: 1` already enforces the
shape.

---

## 8. Key lifecycle

| State | Signs | Published | Meaning |
|---|---|---|---|
| `PENDING` | no | **yes** | published ahead of use so caches and customer trust can prepare |
| `ACTIVE` | **yes** | yes | exactly one per environment by default |
| `RETIRED` | no | yes | overlap window: in-flight assertions and stale caches remain valid |
| `REVOKED` | no | **no** | `kms:Sign` grant removed; excluded from JWKS |

**Rotation:** create next KMS key → publish its JWK as `PENDING` → wait ≥ **2× the observed JWKS cache TTL** (to be measured, §16) →
promote to `ACTIVE`, demote old to `RETIRED` → after the overlap, revoke `kms:Sign` on the old key → remove its JWK.

| Parameter | Value |
|---|---|
| Minimum overlap | **≥ 24 h** under JWKS, pending measured cache behaviour; **customer-coordinated** under static fallback |
| Cache-control | short enough to bound rotation (target ≤ 1 h), long enough to survive a brief outage |
| Emergency rotation | promote `PENDING`→`ACTIVE` immediately, revoke compromised key at once, accept in-flight failures |
| Rollback | re-promote the `RETIRED` key **only if it was never revoked**; a revoked key is never resurrected |
| Customer impact | **none under JWKS**; under static fallback every customer must register the new key before promotion |

**Automatic rotation is not available:** AWS KMS does not support automatic rotation for asymmetric keys. Rotation is an explicit,
audited, multi-step operation — never a toggle.

---

## 9. JWKS design

**Verified: an Okta service app can be configured with a remote JWKS URI, and it is settable in the Admin Console** (also via
`/oauth2/v1/clients/{clientId}`). Okta "dynamically fetches the latest public key," and up to **50 keys per app** are permitted. So
self-service onboarding via JWKS is viable and rotation need not touch customers.

**Endpoint:** `https://<approved-idcaddie-domain>/.well-known/okta-jwks.json` (path subject to approval).

| Requirement | Design |
|---|---|
| Content | **Public keys only.** RFC 7517 JWK Set; each key `kty`,`use:"sig"`,`alg:"RS256"`,`kid`,`n`,`e` |
| Membership | `PENDING` + `ACTIVE` + overlap `RETIRED`. **`REVOKED` excluded.** |
| Auth | none — public by definition |
| Determinism | byte-stable ordering; identical bytes for identical key state |
| Caching | explicit `Cache-Control`, `ETag` where practical |
| Availability | CDN/front-door; **static artifact, no DB lookup per request** |
| Isolation | **no tenant data, no connector data, no counts** — it must reveal nothing about customers |
| Publication | fail-safe: a failed publish leaves the previous valid document served, never an empty or partial set |

**Required test:** compare each JWK's modulus and exponent against the corresponding **KMS `GetPublicKey`** output (DER SPKI →
`n`/`e`), so a mis-published or stale key fails CI rather than production.

**New dependency, stated plainly:** the JWKS endpoint becomes an availability dependency for *new* token mints. An outage does not
break in-flight work, and Okta's caching absorbs brief unavailability — but it must be monitored like a production dependency.

---

## 10. Static public-key fallback

If JWKS proves impractical for self-service (see §16 open items), fall back to static registration. **Even then:**

- private key **remains in KMS** — no PEM anywhere, no per-connector copy;
- the customer registers the current public key/KID;
- the connector stores `signing_key_id`/`signing_key_version`;
- use **multiple simultaneously registered keys** (Okta permits 50) so overlap rotation still works;
- rotation becomes **customer-coordinated**, and the onboarding copy must say so truthfully.

**Never fall back to per-connector private-key copies. Never adopt customer API tokens (SSWS) as the production architecture** — they
are long-lived, broadly privileged, human-handled bearer secrets, i.e. every property this design removes.

---

## 11. AWS / IAM model

| Component | Disposition |
|---|---|
| KMS asymmetric key per environment (`RSA_2048`, `SIGN_VERIFY`) | **NEW** |
| `kms:Sign` grant to the runner task role, single key ARN, no wildcard | **NEW** |
| `kms:GetPublicKey` for JWKS publication | **NEW**, separate principal from the signer |
| Secrets Manager Okta secret + `GetSecretValue` policy | **TRANSITIONAL** → removed when migration completes (§12) |
| Task/exec role separation | **RETAINED unchanged** |
| CloudTrail | **RETAINED**, extended with `kms:Sign` volume alarms |
| `connector_credential_references` | **RETAINED for other providers**, retired for Okta |

**Key policy principle:** the signing role may `Sign` and nothing else; the publication role may `GetPublicKey` and nothing else; no
principal may `GetKeyMaterial`/export; no cross-account grant; production and staging keys are separate with no shared principal.

---

## 12. Migration plan

**12.1 Interface** — keep `signOktaClientAssertion`'s signature and result union; add a KMS-backed implementation. Callers, budgets,
retry and the twelve entrypoints are untouched.

**12.2 Binding checks move, they do not disappear.** `secret_domain_mismatch` / `secret_client_mismatch` become **connector-row**
checks. The cross-org protection is preserved; only its source of truth changes.

**12.3 Input contract** — tasks take `connector_id` (+ tenant) and resolve host/client id server-side, instead of
`OKTA_VERIFY_SECRET_ARN` + secret document. `OKTA_VERIFY_KID` becomes the *active signing key id*, still consistency-asserted.

**12.4 The existing staging secret.** Whether it holds exportable PEM is unknown from the repository. Because a KMS key **cannot
import an existing private key non-exportably in the general case**, assume the platform key is **newly generated in KMS**. That
means **the public key — and therefore the KID — changes**. Consequences:

> **The currently published KID `VDkZ…wz0` will be superseded when the KMS key is created.** Any Okta app already configured with it
> must be reconfigured before it can authenticate. If a live demo depends on the current KID, that demo must either run before
> migration or be re-registered after it. **This must not be discovered during a demo.**

Once migration completes: delete the Secrets Manager secret and its IAM policy, and prohibit the PEM signer in any hosted task.

**12.5 Other providers unaffected** — Slack and Entra keep their credential models.

---

## 13. Threat model

| Threat | Prevention | Detection | Containment | Recovery | Test |
|---|---|---|---|---|---|
| **Unauthorized `kms:Sign`** | Key policy: one role, one key, no wildcard | CloudTrail on every `Sign` | Remove grant — instant, platform-wide | Rotate to `PENDING` key | IAM policy assertion test |
| **Signing-volume abuse** | Per-run token budget (`maxTokenRequests: 1`) | Alarm on `Sign` rate anomaly | Throttle/disable role | Rotate if abuse confirmed | Budget test |
| **Cross-tenant connector substitution** | Ownership-validated resolution; RLS | Fingerprint mismatch audit | Reject before signing | — | **Dedicated isolation test** |
| **Caller-controlled `aud`/`iss`/`kid`** | §6 invariant — derived only | — | Signer refuses | — | **Must be explicit** |
| **Wrong-org token mint** | `aud` from the row; org fingerprint compare | `different_organization` | Reject; never repoint silently | Re-validate | O1C comparison tests |
| **Key compromise** | Non-exportable KMS | CloudTrail | Revoke grant + drop JWK | Emergency rotation (§8) | Runbook drill |
| **AWS account compromise** | **Genuine single point.** Separate keys/accounts, no cross-account grant | CloudTrail to a separate account | Revoke; disable key | Rebuild env keys | Policy review |
| **Malicious connector row mutation** | RLS + owner/admin + DB constraints | Audit on write | Fingerprint mismatch blocks use | Restore row | RLS/pgTAP |
| **JWKS poisoning** | Publication pipeline is the only writer; static artifact | JWK↔KMS comparison test; ETag | Serve last-good | Re-publish | **CI comparison test** |
| **Stale JWKS cache** | Overlap ≥ 2× TTL | Token-mint failure rate | Extend overlap | Re-promote retired key | Rotation drill |
| **Revoked key still published** | Publication excludes `REVOKED` | Post-revocation JWKS assertion | Immediate re-publish | — | Publication test |
| **Token theft** | Never stored/logged/returned; ≤1 h | Anomalous API use | Token expiry | Re-mint | Log-scanning test |
| **JWT replay** | `exp ≤ 60s`, fresh `jti`, single audience | — | Natural expiry | — | Assertion test |
| **Logging leakage** | Allowlist result construction (O1C) | Log scan in CI | — | — | **Existing pattern extended** |
| **SSRF / token-endpoint substitution** | Exact-path URL, host allowlist, redirect rejection | — | Fail closed | — | O1C host matrix |
| **Key-version downgrade** | Signer resolves `ACTIVE` from config, never from input | Audit `signing_key_id` per run | Reject unknown/retired for new signing | — | Signer test |
| **Emergency global revocation** | One grant removal disables all signing | — | Platform-wide stop | Promote `PENDING` | **Drill required** |
| **One tenant exhausting the signer** | Per-run budgets; per-tenant concurrency | Per-tenant sign metrics | Throttle that tenant | — | Load test |

---

## 14. Audit and observability

**Audit:** key created / published / promoted / retired / revoked · connector validation succeeded / failed · assertion signing
requested (**metadata only — never JWT contents**) · token exchange succeeded / failed · abnormal sign volume · fingerprint mismatch.

**Never audit:** private key · JWT · access token · client assertion · raw provider response.

**Metrics:** sign count and failures by environment · token-exchange failures by safe category · fingerprint mismatches · usage by
key version (proves rotation progress) · unusual per-tenant volume · JWKS availability and, where observable, cache status.

---

## 15. O2 PR sequence

**O2A-DB is IMPLEMENTED** (migration `0063`, uncommitted-to-hosted). Two clarifications came out of building it:

1. **No new connection state was needed.** An earlier draft added `configuration_saved`; the existing `configured` (from `0052`)
   already means exactly "configuration recorded, nothing verified". Adding a synonym would have created two states with one
   meaning. `0052` — not `0050` — holds the authoritative 11-value vocabulary, and O2A touches it not at all.
2. **RLS, not table grants, is the enforcement boundary.** Both the test harness and hosted Supabase blanket-grant DML on public
   tables to `authenticated`, so a migration's `REVOKE` is defence-in-depth that the platform re-grants. The provable property is
   that a request role can modify **zero rows**, silently — not that a write raises.


| PR | Scope | Depends on |
|---|---|---|
| **O2A — connector persistence** | migration `0063`; `client_id`, `normalized_org_host`, both fingerprints, `signing_key_id`/`version`, `contract_version`; widen state CHECK; uniqueness on `(tenant, organization_fingerprint)` for active rows; owner/admin RPC; audit; RLS/pgTAP | **none — ready now** |
| **O2B — KMS signer** | `GetPublicKey` load; JWT construction; `kms:Sign`; encoding; token exchange; in-memory token lifecycle; **cross-tenant invariant tests**; no hosted run | KMS key decision |
| **O2C — JWKS publication or static fallback** | endpoint or publication process; key-state model; caching; JWK↔KMS comparison test; monitoring; setup copy | §16 verification |
| **O2D — real wizard** | org host + client ID; server-side validation; safe org confirmation; connector creation; **no secret entry**; `ready_for_initial_sync` | O2A, O2B |
| **O2E — controlled staging acceptance** | explicit GO; configure test app; live KID/JWKS verification; validate; create connector; **no sync** | all above |

Synchronization orchestration begins only after connection and signing are accepted.

---

## 16. Test-org verification runbook

**No Okta mutation until a separate controlled test-org GO.** Use a dedicated Okta developer org — never a customer production org.

| # | Question | Method | Documented? |
|---|---|---|---|
| 1 | Can a service app use a remote `jwks_uri`? | Admin Console + Apps API | **YES** |
| 2 | Configurable in the Admin Console? | Console walkthrough, screenshot the field | **YES** (verify hands-on) |
| 3 | API-only? | — | **No** — both paths exist |
| 4 | Does Okta fetch/cache automatically? | Publish key, observe fetch in endpoint logs | **UNDOCUMENTED — must measure** |
| 5 | Multiple simultaneous keys? | Publish 2 JWKs, sign with each | **YES — 50/app** (verify hands-on) |
| 6 | How is the key selected by `kid`? | Sign with non-first `kid`, expect success | **UNDOCUMENTED — must measure** |
| 7 | Cache headers / refresh interval? | Vary `Cache-Control`, time re-fetch | **UNDOCUMENTED — must measure** |
| 8 | Required overlap? | Derived from 4 + 7 | **Blocked on measurement** |
| 9 | Edition/org-type limits? | Confirm on a developer org and the target edition | Not mentioned |
| 10 | Does the existing staging app support it? | Inspect app config | Unknown |

**Steps:** (1) create KMS key, record ARN + `kid`; (2) publish JWKS to a staging URL; (3) configure the test app with the JWKS URI;
(4) mint a token via the verify entrypoint; (5) publish a second key and confirm both work; (6) promote/retire and confirm zero
customer action; (7) revoke and confirm mints fail closed; (8) **measure and record the cache TTL** — it sets the minimum overlap.

**Reversal:** delete the test app, revoke the KMS grant, unpublish the JWKS. Nothing in a customer org is touched.

---

## 16a. JWKS publication — DONE and publicly verified (O2C.1)

| | |
|---|---|
| **Authoritative staging URL** | `https://jwks.staging.idcaddie.com/.well-known/idcaddie-okta-jwks.json` |
| Hosting | **dedicated static Vercel project**; no auth, no cookies, **no AWS credentials at request time** — the serving path cannot call `kms:Sign` |
| TLS | Let's Encrypt, `CN=jwks.staging.idcaddie.com`, SAN matches |
| Published KID | `p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto` |
| **Active contract KID** | `p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto` — **cut over in O2C.2 (2026-07-30), contract v1.1.0** |
| **Stale marking** | **VERIFIED 2026-07-31** — one controlled group staled, breaker not triggered at 16.7% (threshold 30%, unchanged). Stale transitions are NOT audit-logged; gap recorded. |
| **Initial discovery** | **EXERCISED ONCE** on staging 2026-07-31 — five sweeps, all complete/clean, zero stale marks, legacy connector byte-identical throughout. Scheduler still disabled. |
| **Live verification** | **PROVEN** — all six approved read surfaces: users, groups, apps (2026-07-30) and group memberships, app-user assignments, app-group assignments (2026-07-31). Each its own KMS Sign and single-scope token. Contract 1.2.0. App-group assignments returned zero records (authorized but unexercised). Initial discovery NOT authorized; no scheduler; production disabled. |
| Status | **`published_not_active`** — the signer still fails closed |

**38 checks passed from outside the platform**, including: `Allow: GET, HEAD` on every 405 · unknown path 404 · no redirect, no Vercel SSO, no cookies · `public, max-age=300, must-revalidate` + ETag · exactly one key with member set `{alg,e,kid,kty,n,use}` and no private members · modulus 256 bytes · exponent 65537 · **RFC 7638 thumbprint recomputed from the fetched bytes matches the KID** · **published modulus and exponent byte-identical to a fresh `kms:GetPublicKey`**.

**Isolation:** the JWKS hostname is public while V3 staging still redirects to Vercel SSO. Separate projects; no protection was changed anywhere.

**§9's answer to "can Okta fetch it":** the endpoint is reachable and standards-shaped. Whether Okta's *refresh* behaviour matches the 300s policy is **still unmeasured** — that is O2C.2, and until then the cache policy and any rotation overlap window remain provisional.

**One correction to §2.2's earlier expectation:** the V3 application was the initial hosting candidate, but its auth proxy redirected `/.well-known/...` to `/login` — Okta fetches server-to-server with no cookies and would have received an HTML login page. The endpoint therefore lives in a dedicated project, and V3 hosts no JWKS at all.

---

## 17. Open questions

| # | Question | Owner | Blocks |
|---|---|---|---|
| 1 | JWKS cache TTL, refresh behaviour, `kid` selection | test org | **O2C.2** — endpoint is live; Okta's behaviour against it is still unmeasured |
| 2 | ~~Approved public domain/path~~ | **RESOLVED** | `jwks.staging.idcaddie.com`, live and publicly verified |
| 3 | ~~Does the staging secret contain exportable PEM?~~ | **RESOLVED (O2B.0)** — metadata proves it is populated; treat as exportable PEM; tags corrected; retire only after live acceptance |
| 4 | **KID change at migration** — impact on any planned demo | product | **scheduling risk** |
| 5 | RSA_2048 vs ECC_NIST_P256 | security | O2B (RSA recommended v1) |
| 6 | Okta admin-role coverage for app **user** assignments | test org (O1B/O1C open) | O2E |
| 7 | Live KID verification | test org (O1B open) | production enablement |

---

## 18. Acceptance criteria

Private key exists only in KMS, never as PEM · no per-connector secret · connector stores metadata only · signer derives
`aud`/`iss`/`sub`/`kid` solely from the authorized row + environment · cross-tenant invariant independently tested · tokens never
persisted/logged/returned · no refresh tokens · four key states implemented · rotation drill executed · JWKS contains only public
keys and excludes revoked · JWK↔KMS comparison test passes · three-scope contract unchanged · `certification_only` and
`production_enabled=false` preserved · full suites, typecheck, lint, vendor:verify, deploy:check, build, CI all pass.

## 19. Production-readiness gates

Live KID/JWKS verification complete · rotation and **emergency-revocation drills** executed · CloudTrail alarms live · JWKS
monitored with an availability SLO · admin-role requirement confirmed against a real org · staging acceptance (O2E) accepted ·
Secrets Manager Okta secret and its IAM policy deleted · PEM signer prohibited in hosted tasks · governance flipped from
`certification_only` deliberately, never as a side effect.

## 20. Rollback strategy

| Scenario | Rollback |
|---|---|
| KMS signer regression | Revert to the previous runner image; **do not** reinstate the PEM signer |
| Rotation goes wrong | Re-promote the `RETIRED` key **only if never revoked** |
| JWKS outage | Serve last-good static artifact from CDN; existing tokens keep working for up to 1 h |
| Key compromise | Emergency rotation + grant revocation; accept in-flight failures |
| Connector model regression | `0063` is additive; a connector row can be disabled without deleting it |
| Total stop | Remove `kms:Sign` — one action halts all Okta authentication platform-wide |

---

## VERDICT

# READY FOR O2A

**O2A may proceed now.** It satisfies every condition stated for readiness:

- the connector metadata model supports **both** JWKS and static-key fallback — `signing_key_id`/`signing_key_version` are
  agnostic to how the public key reaches the customer;
- **no secret-write path is required** — the P0 blocker is dissolved, not deferred;
- the signing-key reference model is settled (platform key set, per-connector reference, cardinality as policy);
- no unresolved P0/P1 affects persistence design — every open question in §17 concerns *signing and publication*, not the
  connector row.

**NOT READY:** **O2B** (KMS signer) pending the key-creation decision and §17-5; **O2C** (JWKS) pending §17-1 and §17-2;
**O2E** (live) pending §17-4, §17-6 and §17-7.

**Flagged as a scheduling risk, not a technical one:** creating a KMS key **changes the published KID**, so any Okta app configured
with `VDkZ…wz0` must be reconfigured. That must be planned around, not discovered during a demo.
