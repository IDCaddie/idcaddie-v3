# 83 — Real OAuth completion: the architecture, and how to provision it

**Canonical source for: how a real Slack OAuth callback completes without putting broad credentials in the web request
path, and the exact steps to turn it on for staging.**

Phase 8E built the safety primitives (workspace binding, exact callback allowlist, fail-closed assembly — doc
[81](81_SLACK_CONNECTOR_STATE.md)). It deliberately did not switch the route, because switching it requires deciding
*what the web tier is allowed to hold*. This doc makes that decision and records why.

---

## 1. The problem, stated precisely

Completing an OAuth callback needs three capabilities:

| capability | why | what it implies |
|---|---|---|
| read the Slack **client secret** | `oauth.v2.access` requires it in the POST body | AWS KMS decrypt + a read of `connector_app_secrets` |
| **write** the returned bot token | it must land envelope-encrypted | AWS KMS encrypt + an insert into `connector_secrets` |
| **consume** the `oauth_pending` row | single-use replay defence | one atomic UPDATE |

The existing implementation reaches all three through `RunnerConnection` + `createRunnerAppSecretStore`, which
authenticate as **`connector_runner_login`**. That role is the connector runner's identity: it can execute every
`runner_*` function in the schema — open runs, insert discovery facts, promote canonical evidence, mark accounts stale.

Handing that to Vercel would mean **the public web tier can drive the entire evidence pipeline**. A request-path bug, an
SSRF, or a leaked deployment env would not just leak a token — it would let an attacker fabricate directory evidence.
That is a materially worse blast radius than the thing we are trying to enable, and it is the stop condition this work
was given.

---

## 2. The decision

> **CORRECTED 2026-08-02 — a dedicated OAuth-completion worker in the runner repo, using a new least-privilege
> database identity, `oauth_completer`, that can execute exactly three functions and nothing else.**
>
> The original decision recorded here was "no dedicated worker" — the narrow role used directly from the Vercel
> request path. That was **wrong**, and this document is the reason it got as far as an implementation.
>
> `scripts/check-app-runtime-imports.sh` enforces, with doc 46 §11 behind it, that *the app repo stays pg-free and the
> request/route surface holds no runner internals or KMS client*. A narrow role does not help if reaching it requires
> putting a Postgres driver and a KMS client in a public web tier — the boundary is about what the tier can DO, not
> which credential it holds. That invariant predates this work; it was not checked before the option was chosen, and
> the check caught the violation at the first full gate run.
>
> The role and its three wrappers (migration 0079) are unaffected and correct. What changed is **where the client
> lives**: the runner is a separate deployable that already owns `pg` and the KMS adapters. Vercel validates the
> signed state and hands off; it opens no database connection and constructs no KMS client.

The reasoning below is retained as the record of why option 1 was *initially* rejected. Each point still stands on its
own terms — the worker really does move the credential rather than remove it, and really does add a hop and a job store.
What the reasoning missed is that doc 46 §11 had already decided the question: those costs are the ones the boundary
chose to pay. Kept rather than deleted, because the argument is sound and only the conclusion was wrong:

- It does not remove the credential — it **moves** it. The worker still needs KMS and a database identity; we would
  still have to decide what that identity may do, which is this same question with an extra queue in front of it.
- It adds a hop that must be authenticated, a job store that must be single-use, and a failure mode where the user's
  browser has returned but the connection has not completed. That is three new pieces of state on the exact path where
  correctness matters most.
- Its real advantage — no KMS in the web tier — is worth having, and is the right answer once there is a second
  provider or a non-interactive re-auth. It is recorded here as the follow-up, not discarded.

The narrow role gets the same security property for one new database role and no new moving parts. **Fewest files,
smallest blast radius, and the boundary is enforced by Postgres rather than by our own discipline.**

### What `oauth_completer` may do

`NOINHERIT`, `NOBYPASSRLS`, and granted EXECUTE on exactly:

1. `product_read_app_client_secret_envelope(...)` — returns the **envelope**, never plaintext
2. `runner_ingest_connector_secret(...)` — writes the token envelope for one connector
3. `runner_consume_oauth_pending(...)` — the atomic single-use consume

It holds **no table grant at all**, and no grant on any `runner_*` discovery function. If the web tier is fully
compromised, the attacker can complete an OAuth flow for a connector that already has a pending row — and cannot read
one row of customer evidence, cannot write a fact, and cannot stale an account.

### KMS

The web tier gets a KMS grant for **decrypt on the app-secret key** and **encrypt on the connector-secret key**, and
nothing else. Specifically **not** `kms:Decrypt` on the connector-secret key: the web tier writes tokens, it never reads
them back. Reading them stays the runner's job, which is the separation
[49](49_KMS_IAM_SEPARATION_VERIFIER.md) already verifies.

---

## 3. Provisioning runbook (staging)

Everything below is a **human action**. None of it can be done from the repository, and none of it should be done from
an agent session.

### 3.1 Database role

Applied as a migration, reviewed like any other. It creates the role with **no** password — the password is set out of
band so it never appears in a migration, a repo, or a diff.

```sql
-- reviewed migration, not run ad-hoc
create role oauth_completer nologin noinherit;
revoke all on all tables in schema public from oauth_completer;
grant execute on function public.product_read_app_client_secret_envelope(text, text) to oauth_completer;
grant execute on function public.runner_ingest_connector_secret(uuid, uuid, text, integer, text, jsonb) to oauth_completer;
grant execute on function public.runner_consume_oauth_pending(uuid, text, uuid, text, text, timestamptz) to oauth_completer;

create role oauth_completer_login login noinherit password null;  -- password set out of band
grant oauth_completer to oauth_completer_login;
```

Then, **outside the repo**: `alter role oauth_completer_login password '<generated>'`.

Verify before going further — this is the whole point of the design, so it gets asserted rather than assumed:

```sql
-- must return ZERO rows
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and (has_table_privilege('oauth_completer', c.oid, 'SELECT')
     or has_table_privilege('oauth_completer', c.oid, 'INSERT')
     or has_table_privilege('oauth_completer', c.oid, 'UPDATE'));

-- must return EXACTLY the three functions above
select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('oauth_completer', p.oid, 'EXECUTE')
   and p.proname not in (select proname from pg_proc where pronamespace = 'pg_catalog'::regnamespace);
```

### 3.2 AWS

- An IAM role for the Vercel deployment (OIDC-federated; **no long-lived access key**).
- `kms:Decrypt` on the **app-secret** key only.
- `kms:Encrypt` + `kms:GenerateDataKey` on the **connector-secret** key only.
- Explicitly **no** `kms:Decrypt` on the connector-secret key.
- CloudTrail on both keys, and an alarm on any `Decrypt` of the connector-secret key by this role — that call should be
  impossible, so one occurrence is an incident, not a metric.

### 3.3 Vercel environment (staging only — never Production scope)

Set on the **Preview/staging** environment of `idcaddie-v3`:

| variable | value | notes |
|---|---|---|
| `CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED` | `1` | the gate; absent = synthetic |
| `CONNECTOR_OAUTH_REDIRECT_URI` | `https://idcaddie-v3.vercel.app/connectors/oauth/callback` | must be on the allowlist in `connector-oauth-config.ts` |
| `CONNECTOR_OAUTH_EXPECTED_SLACK_TEAM_ID` | the approved workspace's `T…` id | unset ⇒ refuses; it is not a wildcard |
| `CONNECTOR_OAUTH_EXPECTED_TENANT_ID` | staging fixture tenant | must match the `oauth_pending` row |
| `CONNECTOR_OAUTH_EXPECTED_CONNECTOR_ID` | the Slack connector | ditto |
| `CONNECTOR_OAUTH_EXPECTED_CORRELATION_ID` | from the authorize step | `= oauth_pending.state_jti` |
| `CONNECTOR_OAUTH_STATE_SECRET` | generated | HMAC key for the state |
| `SLACK_CLIENT_ID` | Slack app client id | not a secret |
| `OAUTH_COMPLETER_DB_URL` | the `oauth_completer_login` connection string | **never** the runner's |
| `AWS_ROLE_ARN` / region | the IAM role above | OIDC, no static key |

**Do not set any of these on the Production environment.** `isRealExchangeEnabled` refuses when `VERCEL_ENV=production`
regardless, but the second line of defence is not putting the values there in the first place.

### 3.4 Slack app

Redirect URL must **byte-match** `CONNECTOR_OAUTH_REDIRECT_URI`. Scopes must not exceed the reviewed manifest:
`users:read`, `users:read.email`, `usergroups:read`. No write scope, no `channels:*`, no `chat:write`.

---

## 4. What is already enforced in code

These need no runbook step — they are in `oauth-callback-real-runner.ts` and tested:

- Production refusal, and an explicit opt-in that defaults off.
- Exact whole-URI callback allowlist (not a host check — see the `.host` note in doc 81).
- Workspace binding on `team.id`, checked **before** the token is stored.
- Signed, expiring, tenant- and connector-bound, single-use state; replay denied by the atomic consume.
- Bounded error categories; no OAuth code, client secret, token, host or env value in any result.
- No silent fallback to the synthetic handler when real mode is enabled.

---

## 5. Follow-up

Move completion to a dedicated worker when any of these becomes true: a second OAuth provider, non-interactive
re-authorization, or a requirement that the web tier hold no KMS grant at all. At that point the `oauth_completer` role
moves to the worker unchanged — the narrow grant is the part worth keeping either way.

---

## 6. State as of 2026-08-02 — the canonical handoff

**Applied to staging `ycdpzduxugdsffjqyoai` (head 0081). Nothing deployed; production `dzbfxulvxchdemcettrx` untouched.**

| | SHA |
|---|---|
| v3 #392 — **0079**, the `oauth_completer` role | `bf5bd48f559df153e9aa2f75f2b0f6667e640655` |
| v3 #394 — **0080**, caller-owned envelope version | `cb613301f0fd06d43fa69ccf0e056baf658de0de` |
| v3 #396 — **0081**, the completion job (+ the §10 trigger-grant fix) | `ac2c66c7af2e441325050358c245a156ff9b0bac` |
| runner #115 / #117 / #119 — the completer client | `5c09896…` / `55d11bb…` / `aaa4f0b…` |

0080 sha256: `e0e678c76921c40d0d6bb71d3329859c42e2c79266648a0565ecd33415714587`.
0081 sha256: `00a410273b7c8298e6b13b23ecdad0e5e4576d7e7678edd29bfda33532849f93`.

`oauth_completer` holds EXECUTE on exactly **nine** purpose-pinned wrappers and **zero** table and sequence privileges,
verified on hosted. No login role can `SET ROLE` into it — direct authentication is its only path. As of 0081 it can
also reach **no** other SECURITY DEFINER function at all, trigger functions included; before 0081 it could reach four
definer audit writers through Postgres's implicit `PUBLIC` grant.

### Two things not to re-derive

**The version belongs to the caller.** `canonicalAad` seals it at encrypt time, so a database that derives its own
produces a row whose version disagrees with the sealed one — an unopenable credential, with the working one already
superseded, reported as success. 0080 fixes this and drops the deriving signature.

**`aad_digest` is not envelope identity.** It is sha256 over `(tenant, connector, secret_kind, version)` and nothing
else; `crypto.ts` warns that a caller must never treat a match as proof. Keying idempotency on it made two concurrent
re-authorizations indistinguishable — the second reported success while its Slack-issued token was silently discarded.
Idempotency is keyed on `(aead_nonce, aead_tag)`.

### Remaining work

1. ~~**The completion-job model.**~~ **DONE — migration 0081 (§7 below).**
2. ~~**The Vercel OIDC handoff.**~~ **DONE — Phase 8K (§8 below).**
3. **The worker task**, deployed separately from discovery, with no runner database credential in the process. This is
   the only remaining code, and §8.7 lists exactly what it owes.

Unprovisioned: the remaining gate variables (§8.6), both KMS keys, the OIDC audience/federation, the worker's sealing
key pair, the worker host, and the Slack redirect registration.

---

## 7. The completion job — migration 0081 (Phase 8J, 2026-08-02)

`public.oauth_completion_jobs` is the durable hand-off, and deliberately nothing more. Full model in
[03 § 0081](03_DATABASE_AND_MIGRATIONS.md); the parts that constrain the next two PRs:

| property | how |
|---|---|
| tenant + connector bound | composite FK `(connector_id, tenant_id) → connectors` |
| correlation bound | `unique (correlation_id)` — one authorize, at most one job, forever |
| provider / redirect pinned | CHECK on `provider = 'slack'` and the exact callback URI |
| short-lived | CHECK ceiling of 15 minutes; the wrapper writes **10** |
| single-use | terminal transitions require `status = 'claimed'`; a terminal row never matches again |
| atomically claimable | ONE `UPDATE … WHERE status = 'pending' AND expires_at > now()` |
| code protection | opaque envelope sealed to the **worker public key**; scheme `X25519-HKDF-SHA256-AES-256-GCM` |
| cleared on terminal | payload/scheme/key nulled in the SAME statement as the status, and a CHECK makes it the only legal terminal shape |

**Idempotency key: `body_digest`, sha256 over the whole enqueue request INCLUDING the sealed bytes**, computed by the
wrapper and never supplied. This is the 0080 `aad_digest` lesson one layer up — a digest over the bound fields alone is
a tautology under a correlation lookup, and a substituted authorization code would be accepted as "already done".
**The practical consequence for PR 3: seal once and retry with the same buffer.** Re-sealing produces fresh ephemeral
key and nonce bytes, which is a different request and is refused; a caller that has re-sealed should read the job's
status instead of enqueuing again.

**The clock is the database's.** No wrapper accepts a `timestamptz`. PR 3 must not expect to pass a deadline.

**V3 holds only the public half.** The sealing module does not exist yet and belongs with its first caller in PR 3 —
`node:crypto` covers X25519 + HKDF-SHA256 + AES-256-GCM with no new dependency, which is why that scheme is the one the
CHECK constrains. V3 gains **no KMS grant** for this: the encryption authority and the decryption authority stay in
different processes.

### The granted surface after 0081

`oauth_completer` holds EXECUTE on **nine** purpose-pinned wrappers (four from 0079/0080, five here) and still **zero**
table and sequence privileges, no `runner_*` and no `product_*` grant. The one browser-facing addition is
`product_oauth_completion_job_status`, granted to `authenticated` and explicitly revoked from `oauth_completer`; it
returns status and three timestamps and a CHECK-constrained terminal reason, and denies by returning an empty set.

**§2's claim was not quite true until 0081.** This document says a fully compromised web tier "cannot read one row of
customer evidence, cannot write a fact, and cannot stale an account". That held — but it could **forge an audit record**.
0079 §6 closed the implicit `PUBLIC` EXECUTE on nine definer RLS predicate helpers and not on trigger functions, four of
which are definer audit writers carrying `=X/postgres` on hosted staging. `TEMPORARY` is a `PUBLIC` database privilege
and `CREATE TRIGGER` checks EXECUTE, so a role holding no table privilege could attach one to a temp table of its own
shape and write a fabricated `audit_logs` row for any tenant under the migration owner's authority — polluting the
append-only trail this design relies on to reconstruct exactly the incident it is modelling. Migration 0081 §10 closes
it for every trigger-returning function; detail in [02 §4a](02_SECURITY_AND_RLS.md).

**V3 still must never hold `OAUTH_COMPLETER_DB_URL`.** Every wrapper above is called by the worker. The web tier's only
role in this flow is to seal the code and hand it to the worker over the OIDC-authenticated channel PR 3 builds.

### Hosted apply — staging, 2026-08-02

Applied to `ycdpzduxugdsffjqyoai` after checksum and preflight (head was 0080, table absent, role present with four
wrappers). Head is now **0081**. Verified on hosted, positively rather than by absence of error — a deliberately false
assertion through the same path returns `P0004`, so a silent no-op is ruled out:

| | before | after |
|---|---|---|
| `oauth_completer_*` wrappers | 4 | **9** |
| other SECURITY DEFINER functions reachable by `oauth_completer` | 4 | **0** |
| trigger functions holding a `PUBLIC` EXECUTE grant | 4 | **0** |
| `oauth_completer` table / sequence privileges | 0 / 0 | **0 / 0** |
| `oauth_completion_jobs` RLS / policies | — | **on / 0** |
| `product_oauth_completion_job_status` for `authenticated` / `oauth_completer` | — | **yes / no** |

The full lifecycle then ran against hosted PG 17.6 inside one transaction that **rolled back** — enqueue, identical
retry, substituted-payload rejection, wrong-connector rejection, bounded refusal, claim, duplicate-claim denial,
terminal-once, payload cleared, terminal row unable to regain a payload, sweep, and zero runs/facts/evidence/credentials
touched. Zero fixture rows survived the rollback, confirmed by count afterwards.

It seeded **no `auth.users` and no `public.profiles`**, so the `authenticated` half of the suite was deliberately not
run against shared staging (doc [20](20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md) forbids exactly that class of
fixture there). That boundary is proven on hosted by privilege instead, in the read-only pass. Neither pass claims the
other's ground.

---

## 8. The handoff — Phase 8K (2026-08-02)

The web tier's whole job, in one sentence: **prove the callback is the one it authorized, seal the authorization code so
only the worker can read it, hand it over, and tell the customer the truth about what has and has not happened.**

It opens no database connection, constructs no KMS client, contacts no Slack endpoint, and cannot decrypt what it just
sealed. `oauth-handoff-architecture.test.ts` asserts each of those against the source of every file on the path, and
mutation-tests each rule against a planted violation — the boundary that §2 says was crossed once already is now checked
by something that has been seen to fail.

### 8.1 The environment gate inverted

`resolveStagingEnvironmentIdentity` used to **require** `OAUTH_COMPLETER_DB_URL`. It now **refuses** it — new reason
`completer_credential_present`, alongside `runner_credential_present`. That is the §2 correction made operational: the
boundary is about what this tier can DO, and a database credential here means the rejected design is being rebuilt.

**A credential is a connection string, not a mention of one.** The first version of this check scanned every
environment *value* for the role name as a substring, and that was a live outage waiting to happen: Vercel injects
`VERCEL_GIT_COMMIT_MESSAGE` into the runtime environment, and every commit in this phase discusses `oauth_completer`,
so a deploy cut from one would have refused on the grounds that a credential was present, taken the not-pinned branch,
and served a bare 404 to every real Slack callback. The rule is now the dedicated variable **name**, or a value that is
actually a Postgres URI — which is *stricter* than the substring test, because this tier is pg-free and any connection
string here is a refusal regardless of which role it names.

The gate also now checks the **grammars** the seal, the protocol schema and 0081's CHECKs all enforce (uuid, correlation
id, `^T[A-Z0-9]{2,30}$`) — reason `expected_context_malformed`. A value that passed the gate and failed downstream gave
a deployment that looked configured and then refused every callback with a reason naming the crypto rather than the
misconfiguration; an uppercase UUID was enough.

### 8.2 The handoff protocol — version 1

`oauth-handoff-protocol.ts` is the SHARED contract; the worker reads the same file. Canonical JSON, keys written out in
this order, `JSON.stringify` — the receiver re-serializes and compares, so a non-canonical body that parses to the right
fields is still refused.

> **SUPERSEDED BY PROTOCOL v2 — see §9.** The table below is the v1 shape. v2 adds `nonceHash` and `subject`, and
> **v1 is refused**, because v1 could not complete a flow correctly: it carried neither of the two values migration
> 0079's consume wrapper matches its row on.

| field | value |
|---|---|
| `version` | `1` |
| `environment` | `"staging"` — the **ID Caddie** environment, not Vercel's channel label |
| `correlationId` | `oauth_pending.state_jti`, `^[A-Za-z0-9_.:-]{1,64}$` |
| `tenantId` / `connectorId` | uuid |
| `provider` | `"slack"` |
| `redirectUri` | `https://idcaddie-v3.vercel.app/connectors/oauth/callback` |
| `expectedTeamId` | `^T[A-Z0-9]{2,30}$` |
| `payloadScheme` | `X25519-HKDF-SHA256-AES-256-GCM` |
| `payloadKeyId` | `^[A-Za-z0-9_.:-]{1,128}$` |
| `protectedPayload` | base64 of the sealed envelope, 60–8192 bytes decoded |

Strict: an unknown key is a refusal, not an ignored extra. There is no forward-compatible extension point — `version` is
how this protocol changes. `POST` to the pinned path `/internal/oauth-completion/handoff`, with headers
`authorization: Bearer <assertion>`, `x-idcaddie-handoff-version`, `x-idcaddie-correlation-id`, and
`x-idcaddie-body-digest` (sha256 hex over the exact serialized body — a **header**, because a digest cannot cover
itself). The acknowledgement is `{ version: 1, status: "accepted" | "duplicate" }` and nothing else: no job id, no
timestamps, no reason. 200 must carry `accepted`, 409 must carry `duplicate`, and a disagreement between the two is a
refusal rather than a guess.

### 8.3 What the assertion can and cannot bind — read this before changing anything

A Vercel OIDC token is minted **by Vercel, for a deployment**. A caller cannot add a nonce, a body digest, a tenant or a
correlation to it. So the binding is split across three mechanisms, each doing only what it can actually do:

1. **The assertion authenticates the CALLER** — issuer, audience, subject, team, project, Vercel environment, bounded
   lifetime. It answers "is this our staging deployment", and nothing else.
2. **The AAD of the sealed payload binds the request FIELDS.** AES-GCM authenticates the AAD, so a worker handed a
   substituted body cannot open the authorization code at all. *This* is the body binding.
3. **The transport digest binds the exact bytes**, so alteration in the channel is a refusal rather than a partial parse.

Residual, stated plainly: an assertion captured within its lifetime could in principle be paired with a different body.
TLS prevents the capture; the AAD makes the substituted body useless; and 0081's correlation uniqueness plus the
`oauth_pending` liveness gate make the replay a refusal. Adding a shared HMAC secret to close the theoretical gap would
reintroduce exactly the long-lived credential this design removes.

### 8.4 The claims PR 4 must verify

`verifyHandoffAssertion` is implemented **here**, in PR 3, so PR 4 cannot invent a weaker one. It **requires** an injected
signature verifier and refuses without one: a decoded JWT is not an authenticated JWT, and the type says so.
`makeJwksSignatureVerifier` does kid resolution and RS256 verification with `node:crypto`; PR 4 supplies the fetched key
set and nothing else.

| claim | rule |
|---|---|
| algorithm | `RS256` only. `none` and every other alg refused **before any claim is read** |
| signature | over `header.payload`, key resolved by `kid`; absent or unmatched `kid` ⇒ refuse |
| `iss` | must start `https://oidc.vercel.com/` **and** equal the configured issuer exactly |
| `aud` | exactly the audience **dedicated to the completion worker** — never Vercel's default `https://vercel.com/<team>`. An array is accepted only when it names exactly one audience |
| `sub` | exact `owner:<team>:project:<project>:environment:<vercel-environment>` |
| `owner_id` | exact `team_PYYzXw6Wn7HVtPvvcQWNRSlC` |
| `project_id` | exact `prj_l30QMLpF3dNLwKBP2CTG7v9rIon0` |
| `environment` | exact Vercel channel name — **not** the string `staging` (see §8.2) |
| `exp` | `> now`, with **no** skew grace |
| `iat` | `<= now + 30s` (issued-in-future refused) and `now - iat <= maxAge` |
| `nbf` | if present, `<= now + 30s` |
| `exp - iat` | `<= maxLifetime` |

`maxLifetime` / `maxAge` default to **3600s** and are **parameters, not constants**. That is an assumption, not a
measurement: Vercel's runtime-injected token lifetime is not observable from this repository, and a ceiling below it
would refuse every real token. **PR 4 must tighten it to the observed lifetime once a real assertion has been seen.**

Alongside the assertion, `verifyHandoffRequest` checks the version header, the body size, the digest header against the
received bytes, the strict schema, the correlation header against the body, canonical form, and the payload bounds.

V3 also runs `preflightOwnAssertion` before sending — audience, project, team, expiry. It is **NOT authentication**, it
verifies no signature, and it is named so nobody can mistake it for one. It exists so a bearer token minted for a
different relying party never leaves the building. The assertion is read from `process.env.VERCEL_OIDC_TOKEN` **only**;
an inbound `x-vercel-oidc-token` header is attacker-controlled and would become an outbound `Authorization` header.

### 8.5 Sealing

`oauth-payload-seal.ts`, `node:crypto` only, no new dependency and no KMS.

```
offset  size  meaning
0       1     envelope version, 0x01
1       32    ephemeral X25519 public key, raw
33      12    AES-GCM nonce
45      n     ciphertext
45+n    16    AES-GCM tag

shared = X25519(ephemeral_private, worker_public)
key    = HKDF-SHA256(ikm=shared, salt=ephemeral_public||worker_public, info=HKDF_INFO, len=32)
env    = AES-256-GCM(key, nonce, plaintext=authorization code, aad=canonicalSealAad(binding))

HKDF_INFO = "idcaddie:oauth-completion-handoff:v1:X25519-HKDF-SHA256-AES-256-GCM"
```

The salt binds **both** public keys, so a key-substitution attempt derives a different key. The AAD is newline-joined,
in this fixed order, and every field's grammar excludes a newline so no value can shift a boundary:

```
idcaddie:oauth-completion-handoff:v1
1
<tenantId>
<connectorId>
slack
<correlationId>
https://idcaddie-v3.vercel.app/connectors/oauth/callback
<expectedTeamId>
<payloadKeyId>
```

Fresh ephemeral key and fresh nonce every call, with **no injectable seam** for either — a deterministic seal is exactly
what this envelope must not have. That is why 0081 treats a re-seal as a new request: two seals of one code differ, and
a caller that re-sealed should read the job's status rather than enqueue again. There is **no transport retry**, so
"reuse the same sealed buffer" is structurally true rather than a rule to remember, and a 409 `duplicate` is reported as
pending rather than as failure.

**The configured public key is base64 of the SPKI DER, not the raw 32 bytes**, and that is load-bearing. An X25519 and
an Ed25519 public key are both exactly 32 raw bytes; told `crv: "X25519"`, Node imports a signing key as a key-agreement
key without complaint, and the mistake surfaces later as a worker that can never decrypt anything. SPKI carries the
curve OID, so it is refused at configuration time, where a person can still fix it. *(Found by a test that was written
expecting the raw form to be rejected and discovered it was not.)*

**There is no opener under `src/`.** The reference decryption lives in `oauth-payload-seal.test.ts`, which proves the
wire format is real without giving the web tier the capability. PR 4 implements it from the layout above.

### 8.6 Configuration — names only; nothing is set

Added by this PR as **parsing and validation only** (doc 24 §3f):

| variable | rule |
|---|---|
| `OAUTH_COMPLETION_WORKER_URL` | exact normalized HTTPS URL, allowlisted host, pinned path, no credentials/query/fragment |
| `OAUTH_COMPLETION_WORKER_OIDC_AUDIENCE` | the dedicated worker audience |
| `OAUTH_COMPLETION_WORKER_PUBLIC_KEY` | base64 SPKI of the worker's X25519 public key |
| `OAUTH_COMPLETION_WORKER_PUBLIC_KEY_ID` | `^[A-Za-z0-9_.:-]{1,128}$` |
| `VERCEL_OIDC_TOKEN` | injected by Vercel; read from the environment only |

`OAUTH_COMPLETER_DB_URL` is **removed from the V3 contract entirely** and its presence is now a refusal (§8.1).

**`WORKER_ALLOWED_HOSTS` is deliberately EMPTY in code.** The worker is not deployed and its host is not known, so a
fully-configured staging environment still refuses with `worker_host_not_allowlisted`. Opening it requires a reviewed
change to the constant — an operator cannot do it from the environment, which is the same discipline as
`REAL_CALLBACK_URIS` in `connector-oauth-config.ts`. **This is the one code-level unblock PR 4 needs.**

### 8.7 The pending experience, and what PR 4 owes

The callback redirects to `/connectors/oauth/pending?c=<correlationId>`. That page's only source of truth is
`product_oauth_completion_job_status` — the single 0081 wrapper granted to `authenticated`, read under the
**server-pinned tenant**, not the session's active one. Those are different questions with different answers: there is
no tenant switcher, so `activeTenant` is simply the alphabetically-first membership, and a user who belongs to more
than one tenant would have queried the wrong one and been told the connection failed while it was completing. It does
not widen access — the wrapper gates on `has_tenant_role(p_tenant_id, owner|admin)` itself.

**A read we could not make is not a job that failed.** Denied / foreign / absent / RPC-error all render *identically*
to a real failure — that is what keeps them indistinguishable — but none of them is **terminal**, so the poller keeps
going. Only the wrapper's own `failed` stops it. One transient statement timeout on the first server render would
otherwise have pinned the screen to "Connection failed" forever with polling disabled while the worker went on to store
a live Slack token. Four customer words:
**Completing your Slack connection · Connection completed · Connection failed · Connection expired**, plus a
**Retry connection** link on the two a customer can act on. The failure copy does **not** say "nothing was changed":
0081's vocabulary includes `store_failed`, reached only *after* Slack's exchange succeeded — at which point the app is
installed in the customer's workspace — and the terminal reason deliberately never crosses this boundary, so the screen
cannot tell that apart from "we never started" and must claim neither. Refusals that never reach a job land on
`/connectors?oauth=error`, which now renders a bounded banner rather than returning the customer silently. `pending`/`claimed` both read as *completing*; a denied read,
another tenant's job, and a job that never existed are all *failed* and therefore indistinguishable. Nothing else
crosses the boundary: no job id, no timestamps, no terminal reason, no attempt count, no digest, no payload. Polling is
5s × 36 (three minutes; the job's deadline is ten), stops on the first terminal state, and when the budget runs out says
so truthfully instead of guessing an ending. A refresh renders the durable state on the first paint.

PR 4 owes, and only this:

1. The worker endpoint at `/internal/oauth-completion/handoff`, calling `verifyHandoffRequest` from this repository with
   a JWKS-backed verifier and a tightened `maxLifetime` (§8.4).
2. Opening the private half of the sealing key and decrypting the envelope (§8.5).
3. `oauth_completer_enqueue_oauth_completion_job` → claim → Slack `oauth.v2.access` → workspace binding → 0080 secret
   ingest → consume the pending row → complete/fail, over `OAUTH_COMPLETER_DB_URL`, in the worker process.
4. A reviewed change adding the worker host to `WORKER_ALLOWED_HOSTS` (§8.6).

---

## 9. Protocol v2 — the fields that make the consume possible (Phase 8M, 2026-08-03)

§8's protocol was version 1, and **it could not complete an OAuth flow correctly.** The defect was structural rather
than a bug in either half, and neither half could have found it alone: V3 sent a well-formed request, the worker
accepted it, and the step that could not run was in a third place.

`oauth_completer_consume_oauth_pending` (migration 0079) matches its row on

```sql
where p.state_jti = p_state_jti
  and p.nonce_hash = p_nonce_hash
  and p.tenant_id = p_tenant_id
  and p.provider = 'slack'
  and p.connector_id is not distinct from p_connector_id
  and p.subject   is not distinct from p_subject
  and p.consumed_at is null
  and p.expires_at > p_now
```

and refuses outright when `p_nonce_hash` is null or empty. **Version 1 carried neither `nonce_hash` nor `subject`.**
The worker holds no table grant with which to look either up, so no value reachable from that process could satisfy
this WHERE. Runner PR #120 shipped with the consume deliberately NOT called, documented at length, because calling it
would have returned `not_found` on every completion — and mapping that to failure would have failed every real
connection after its token was stored, while mapping it to success would have been a single-use gate that always
passes.

### 9.1 What v2 adds, and what it still refuses to carry

| field | value | why it is safe to send |
|---|---|---|
| `nonceHash` | `sha256(nonce)`, lowercase hex | exactly what `oauth_pending.nonce_hash` already holds. The RAW nonce is a live CSRF secret and is never sent — the database has never stored it either (doc [42](42_SECURITY_THREAT_MODEL.md) §32.3) |
| `subject` | the initiating `auth.uid()` uuid | the value the authorize half already bound into the signed state and the row. Opaque — never an email, a name, or anything a person reads |

These are the **minimum** the existing wrapper requires: every other column in its WHERE (`state_jti` = the
correlation, `tenant_id`, `connector_id`, the pinned provider, and the redirect the wrapper re-checks) was already in
v1. Nothing else was added, and in particular the handoff still carries no raw nonce, no authorization code outside the
sealed envelope, no token, no state signing secret, and no human-readable identifier.

`subject` is REQUIRED rather than nullable. `slack-authorize-pending` refuses to create a pending row without one, so a
null could only ever describe a row this flow cannot produce — and sending null would let `is not distinct from` match
some OTHER subject-less row.

### 9.2 Where the new fields are bound

All three places, because each answers a different question:

- **canonical serialization + transport digest** — alteration in the channel is a refusal rather than a partial parse.
- **the seal AAD** — and this is the load-bearing one. A substituted `nonceHash` would otherwise let a valid-looking
  handoff point the consume at a *different* pending row; binding it into AES-GCM's AAD means such a body cannot open
  the authorization code at all.
- `AAD_DOMAIN` and `HKDF_INFO` both derive from the protocol version, so a v1 envelope can never be opened as a v2 one
  even before a single field is compared.

### 9.3 There is no negotiation and no downgrade

A v1 body fails the strict schema (`version` is a literal, and the two new fields are required); a v1 *header* fails the
header comparison before the body is parsed at all. **v1 is refused, not tolerated** — that is the intended backward
compatibility, and it is what stops a stale deployment completing a real flow through the old, unconsumed path.

### 9.4 The consequence for the worker's ordering

With v2 the worker can finally perform the consume. The ordering is:

1. verify handoff and OIDC · 2. open the protected code · 3. enqueue and claim · 4. read/decrypt the app secret ·
5. exchange with Slack · 6. verify the exact `team.id` · 7. allocate the version · 8. encrypt and store the token ·
9. **atomically consume the exact `oauth_pending` row** · 10. mark the job completed.

Two notes on that list, because it is a list of EFFECTS and one of them is not in execution order:

- **The version is READ before the exchange and APPLIED after it.** `exchangeSlackOAuthCode` takes `version` in its
  input and seals it into the AAD at encrypt time, so the allocating read (a `stable` function, no side effect) has to
  precede the call. What step 7 pins is that the version a token is ENCRYPTED under is allocated for this completion and
  is the one written to the row — the 0080 lesson — not that the read happens after Slack answers.
- **Store precedes consume**, which REVERSES the ordering connector-runner #120 chose and documented. That change is
  deliberate and is recorded here rather than silently applied. #120 argued consume-first on the grounds that
  store-first's failure case is "the token was written, then the single-use gate said this authorization was already
  used" — a replay that has already rotated a working credential. Under migration 0081 that case is not reachable: the
  enqueue requires an unconsumed pending row, `correlation_id` is unique forever, and the claim is atomic, so between
  our enqueue and our consume there is no second party who could have consumed the row. What store-first buys in
  exchange is real: a consume failure then leaves a VALID, PERSISTED credential rather than a spent authorization and
  nothing at all.

### 9.5 The partial-failure boundary between store and consume

**The job is never marked `completed` unless BOTH the store and the consume succeeded.** The interesting case is a
store that succeeds followed by a consume that does not.

| consume outcome | what it means | what the worker does |
|---|---|---|
| `consumed` | the row was ours and is now spent | mark the job `completed` |
| throws (ambiguous) | the UPDATE may or may not have committed | retry, bounded — see below |
| `already_consumed`, on a retry after an ambiguous attempt | almost certainly OUR earlier attempt | treat as consumed; the row is spent either way |
| `already_consumed`, with no prior ambiguous attempt | somebody else spent it — a replay signal | `state_consume_failed` |
| `expired` / `not_found` / `redirect_uri_mismatch` | the authorization is not consumable | `state_consume_failed` |

That `already_consumed` rule is the whole of the idempotent recovery: it is success ONLY when a previous attempt of
OURS could have been the one that consumed the row. On a clean first attempt it stays a refusal, so a genuine replay is
still denied.

When the job ends `state_consume_failed`:

- **The stored token is left completely alone.** It is valid and active, and revoking or overwriting it would destroy a
  working credential to tidy up a bookkeeping failure. `auth.revoke` is outside this worker's Slack surface anyway.
- The `oauth_pending` row is left to expire. It cannot be reused: its correlation is bound to a terminal job, so
  0081's enqueue refuses any further handoff for it.
- **The customer is not told the connection is unusable, and is not told it succeeded either.** The terminal reason
  never crosses the product boundary; the pending page's `failed` copy already says "We could not complete this Slack
  connection. You can try connecting again." and deliberately does NOT say "nothing was changed" — precisely because
  `store_failed` (and now `state_consume_failed`) are reachable with a live token in existence.
- **Recovery needs no operator.** "Retry connection" starts a fresh authorize with a fresh correlation, nonce and
  pending row; the completion stores a new version and 0080 supersedes the previous one in the same statement. That is
  ordinary re-authorization, not a repair.
