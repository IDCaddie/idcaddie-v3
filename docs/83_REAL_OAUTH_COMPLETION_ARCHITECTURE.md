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

**Applied to staging `ycdpzduxugdsffjqyoai` (head 0080). Nothing deployed; production untouched.**

| | SHA |
|---|---|
| v3 #392 — **0079**, the `oauth_completer` role | `bf5bd48f559df153e9aa2f75f2b0f6667e640655` |
| v3 #394 — **0080**, caller-owned envelope version | `cb613301f0fd06d43fa69ccf0e056baf658de0de` |
| runner #115 / #117 / #119 — the completer client | `5c09896…` / `55d11bb…` / `aaa4f0b…` |

0080 sha256: `e0e678c76921c40d0d6bb71d3329859c42e2c79266648a0565ecd33415714587`.

`oauth_completer` holds EXECUTE on exactly four purpose-pinned wrappers and **zero** table and sequence privileges,
verified on hosted. No login role can `SET ROLE` into it — direct authentication is its only path.

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
2. **The Vercel OIDC handoff.** Pin issuer, audience, project `prj_l30QMLpF3dNLwKBP2CTG7v9rIon0`, team
   `team_PYYzXw6Wn7HVtPvvcQWNRSlC`, environment identity, body digest, and the job id/nonce. The callback returns a
   truthful pending page and never claims "Connected" at handoff time.
3. **The worker task**, deployed separately from discovery, with no runner database credential in the process.

Unprovisioned: the ten remaining gate variables, both KMS keys, the OIDC role, and the Slack redirect registration.

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

**V3 still must never hold `OAUTH_COMPLETER_DB_URL`.** Every wrapper above is called by the worker. The web tier's only
role in this flow is to seal the code and hand it to the worker over the OIDC-authenticated channel PR 3 builds.
