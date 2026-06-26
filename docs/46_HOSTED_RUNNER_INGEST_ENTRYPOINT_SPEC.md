# 46 · Hosted-runner client-secret ingestion entrypoint — SPEC (Phase C)

**Status: SPEC ONLY. No code in this repo. Phase C (real Slack client-secret ingestion) is BLOCKED until a
conforming hosted runner exists.** RISK-001 / RISK-007 remain **OPEN**; cutover **BLOCKED**; not production-ready.
**Location PINNED (§11, 2026-06-26):** separate deployable (Option A) · vendor the core at a pinned commit · fresh
ephemeral host on the IAM-user model (§47 EC2 confirmed gone).
**Runtime + ingestion PINNED (§12, 2026-06-26):** **ECS/Fargate one-shot** task · ingestion via **AWS Secrets Manager
task-read (Model B)**, NOT ECS Exec stdin (Exec session logging could capture the master credential) · the committed
core is unchanged (only the plaintext *source* changes: SM fetch, not stdin) · stdin-only (#183) stays valid for
interactive models but SM task-read supersedes it for Fargate.
**Adding `pg` to this app repo is NOT authorized; an in-repo runner would require a new decision replacing §11.**

## 0. Why this doc exists
Phase C must load the real Slack OAuth **client secret** (the master credential) through the reviewed,
no-disk ingest core. The capability check found there is **no runnable ingestion entrypoint** here, **by design**:
`runner-db-client.ts` states the real `connector_runner_login` Postgres connection is *"a server-only Postgres pool
bound to `connector_runner_login`… provided by the **future hosted runner** via the injected `RunnerConnection`."*
The repo is deliberately **pg-free** (the runner is a separate trust boundary; see [[connector-vault-no-human-token-handling]]).
**Decision (2026-06-26):** keep it that way — do **not** add `pg` to this repo, do **not** build a local direct-Postgres
ingest script, do **not** split encrypt/insert. This doc specifies the **hosted runner** that performs Phase C.

The hosted runner **reuses the committed core unchanged** and supplies only two injected deps (a KMS provider built
from env, and a `RunnerConnection`). It owns **no** crypto, **no** secret material at rest, **no** SQL beyond the
committed parameterized shapes.

## 1. Where the hosted runner lives
A **dedicated server-only runner process** — the §47 model: a small host/container (e.g. EC2 / ECS task) that already
has the runner **AWS IAM identity** and is on a network with the staging Postgres. **Not** Vercel, **not** the Next.js
app, **not** browser-reachable, **no** public route. An operator reaches it only over an authenticated admin channel
(SSH / SSM session) to pipe the secret on stdin. It is long-lived only for the duration of the controlled run; ideally
ephemeral (spun up for the run, torn down after).

## 2. How it injects `RunnerConnection`
The committed contract (`runner-db-client.ts`):
```ts
export interface RunnerConnection {
  runSequence(statements: ReadonlyArray<{ sql: string; params: readonly unknown[] }>): Promise<...>;
}
```
The hosted runner implements `runSequence` over a **single pooled Postgres connection bound to
`connector_runner_login`**, executing the statements **in order inside ONE transaction** (`BEGIN … COMMIT`, rollback on
any error). It passes that connection to `createRunnerAppSecretStore(conn)` and hands the resulting store to
`saveSlackClientSecret`. The committed store prepends `set role connector_runner` to every sequence, so the runner
connection needs **no** ambient privilege (it is `connector_runner_login`: LOGIN + NOINHERIT, zero direct grants — B1/T57).
The runner provides **only** the connection object; all SQL shapes + the SET-ROLE wrapping are committed.

## 3. How it authenticates to Postgres as `connector_runner_login`
- A **direct Postgres connection** (Supabase **session** pooler `:5432` or a direct connection) as
  `connector_runner_login`, using its password. `connector_runner_login` only `SET ROLE connector_runner`s — it can do
  nothing ambiently (proven by RLS T57 + the B1 behavioral check).
- The password is supplied to the runner host at runtime from a **secret store / injected env** (e.g.
  `CONNECTOR_RUNNER_DB_URL`), **never** committed, **never** in argv/shell history, **never** logged. The runner host —
  not this repo — owns the `pg`/postgres client.
- **No** service-role, **no** PostgREST/anon, **no** request-path DB access. **No** production DB URL.

## 4. How it uses the committed crypto / KMS / save path (no new dependency)
```
keyProvider = createKmsKeyProvider({
  kmsClient: createAwsKmsClient({ sender: createAwsKmsSdkSenderFromEnv(), region: CONNECTOR_VAULT_AWS_KMS_REGION }),
  currentKekId, previousKekIds,                 // from kmsKeyProviderConfigFromEnv()
})                                              // @aws-sdk/client-kms is ALREADY a dep — no new dependency
store       = createRunnerAppSecretStore(runnerConnection)
plaintext   = await readSecretFromStream(process.stdin)        // committed, in-memory, no disk
result      = await ingestClientSecret({ plaintext, appEnv: "staging", version: 1 }, { keyProvider, kekId, store })
//            → saveSlackClientSecret → encryptAppSecret (KMS GenerateDataKey + AES-256-GCM, app-scoped AAD) → envelope-only INSERT
```
`createKmsKeyProvider` / `createAwsKmsSdkSenderFromEnv` **fail closed** if region/KEK are unset — no mock, no plaintext
fallback in real mode (the mock client exists only in tests). AWS credentials come from the runner host's IAM identity
via the SDK default provider chain.

## 5. Exact operator command (stdin-only, in-memory)
On the runner host, over the admin channel (the secret is piped from a no-echo in-memory source — never typed, argv,
env, temp file, or logged):
```
unset HISTFILE; set +o history
pass show slack/staging-client-secret | <hosted-runner ingest entrypoint>  # reads process.stdin; --app-env staging --version 1
```
The `<hosted-runner ingest entrypoint>` is the runner's thin wiring from §4 (it imports the committed core). The committed
`assertSafeInvocation` refuses `SLACK_CLIENT_SECRET` in env and any positional/flag secret; the entrypoint accepts only
the non-secret flags `--app-env` / `--version` / `--confirm`. **Output is only a redacted `secret_id` or a safe static
reason** — never the secret, ciphertext, or a raw error.

## 6. Exact staging guards (all must hold or the run aborts)
- `appEnv` is pinned to `"staging"` (the harness rejects anything else: `invalid_app_env`).
- The runner verifies it is connected to the **staging** DB (project ref `ycdpzduxugdsffjqyoai`) and that
  `CONNECTOR_VAULT_KMS_KEY_ID=alias/idcaddie-staging-connector-vault` **resolves to** the canonical key
  `…key/a1b7eaa9-5ed6-4fb9-8a19-f610c6407d5f` (doc 42 §91) before any KMS/DB call. **Production ref
  `dzbfxulvxchdemcettrx` → hard abort.**
- Secret is **stdin-only, in-memory** (no temp file; no `fs` write in the core — proven by `ingest-no-disk.test.ts`).
- `provider="slack"`, `secret_kind="oauth_client_secret"`, `version≥1` (the `connector_app_secrets` identity the
  B2c-secret store + migration `0035` CHECK constraints require).

## 7. Audit / atomicity guarantee
`createRunnerAppSecretStore.insertEnvelope` issues `runSequence([{set role connector_runner}, {INSERT envelope}])`. The
hosted runner MUST run that sequence in **one transaction on one connection** — so the `SET ROLE` + the envelope INSERT
(and any audit row, if added) **commit atomically or roll back together**. A failure leaves **no orphan envelope** and
the run reports a redacted failure. (The app-secret **USE** audit remains future, doc 42 §90.7; the connector_secrets
store-audit atomic pattern, doc 42 §84, is the template if a store-audit row is added here.) Encrypt-immediately holds:
plaintext is encrypted before the INSERT and never persisted — only the envelope (ciphertext + wrapped DEK + nonce +
tag + AAD digest + kek id) is stored.

## 8. DB envelope-only verification query (run after ingestion)
```sql
select id, app_env, provider, secret_kind, version, is_active, kek_id, aead_alg, aad_digest,
       (ciphertext is not null) as has_ciphertext, (aead_tag is not null) as has_tag
  from public.connector_app_secrets where app_env='staging' and provider='slack' order by created_at desc limit 3;
-- expect: one active row; provider/secret_kind/kek_id/aead_alg/aad_digest carry NO secret; has_ciphertext/has_tag = true;
-- there is NO plaintext column. Do NOT select/print ciphertext, dek_wrapped, aead_nonce/tag, or any connection string.
```

## 9. Deployment / runtime requirements
- Runner host: Node runtime **plus a Postgres wire client (`pg`/postgres) that lives on the runner host, NOT in this
  repo**; the committed `connector-vault` core available as a library (imported/vendored).
- **AWS:** the runner IAM identity `idcaddie-staging-runner` with **only** `kms:GenerateDataKey` + `kms:Decrypt` on the
  canonical KEK (doc 42 §91); credentials via fresh temporary keys (minted for the run, deleted after) or the host role.
- **Env (config, not secrets):** `CONNECTOR_VAULT_AWS_KMS_REGION=ca-central-1`,
  `CONNECTOR_VAULT_KMS_KEY_ID=alias/idcaddie-staging-connector-vault`. **Secrets (injected, never committed/logged):** the
  `connector_runner_login` connection string. `SLACK_CLIENT_SECRET` must **not** be set.
- Network reachability to the staging Postgres only; **no** public/browser route; staging-only.

## 10. Tests required BEFORE any real secret is loaded
1. **Committed core (already green):** `client-secret-ingest-harness.test.ts`, `ingest-no-disk.test.ts`,
   `slack-client-secret-store.test.ts` + RLS T56 (envelope-only, no-leak, fail-closed, no-disk).
2. **Hosted-runner thin wiring (synthetic, on the runner side):** a test injecting a **mock `RunnerConnection`** + a
   marked synthetic sentinel proving stdin → `ingestClientSecret` → envelope INSERT, the staging/prod + env/argv guards,
   redacted output, fail-closed on missing KMS/DB, and **no sentinel** in stdout/stderr/logs/disk.
3. **Synthetic live dry-run on the runner host:** run `scripts/verify-staging-connector-vault-dry-run.mjs` (synthetic
   payload) end-to-end on the host — KMS wrap/unwrap + a synthetic envelope INSERT against staging as
   `connector_runner_login` — **green before any real secret**.
4. **Live KMS/IAM (done, green — doc 42 §91):** runner GenerateDataKey/Decrypt allowed; web Decrypt explicitDeny.

Only when **1–4 are green** may the operator run §5 once, with Sam's explicit GO. This doc changes nothing operationally
— it specifies the missing entrypoint and keeps Phase C **BLOCKED** until a conforming hosted runner exists.

## 11. Location decision — PINNED (2026-06-26 clarification)
§1/§9 left two seams open (import-vs-vendor; runtime target). This section pins them so the runner architecture is
settled **before** any implementation. **No code, no `pg`, no runner project is created by this doc.**

### 11.1 Classification — Option A (separate deployable) — PINNED
The conforming runner is a **separate deployable** (its own runner repo/project), **not** a module inside
`~/code/idcaddie-v3`:
- the app repo **stays pg-free** — **no `pg` in `~/code/idcaddie-v3`**, no direct `connector_runner_login` pool in the
  app repo, no local direct-Postgres ingest script, no browser/request-path route, no encrypt/insert split;
- the runner owns `pg` / the direct Postgres / the `connector_runner_login` connection on its own host;
- the runner build does **not** happen inside the app repo.

### 11.2 Package/library mechanism — VENDOR at a pinned commit (Option B) — PINNED
The runner **vendors (copies) the minimal `connector-vault` core modules at a pinned app-repo commit** — it does **not**
depend on a published package.
- **Minimal vendor set:** `client-secret-ingest-harness.ts`, `slack-client-secret-store.ts`, `crypto.ts`,
  `kms-key-provider.ts`, `aws-kms-client.ts`, `aws-kms-sdk-sender.ts`, and the `runner-db-client.ts` `RunnerConnection`
  type — and their tests. Nothing else.
- **Why this preserves the pg-free boundary:** the app repo gains nothing (no `pg`, no new export surface, no release
  pipeline); the runner is the *only* place `pg` + the vendored core meet. Publishing a package would add
  release/versioning infrastructure before there is more than one consumer — deferred until multiple runners exist.
- **Pinned-commit discipline:** the runner records the **exact app-repo commit SHA** it vendored from (a
  `VENDOR.lock`/manifest). The vendored files MUST be **byte-identical** to the app repo at that SHA.
- **Drift control:** a runner-side check diffs each vendored file against the app repo at the pinned SHA and **fails on
  any drift**. Bumping the SHA is a **reviewed** change in the runner project.
- **How app-core changes flow in:** any app-repo PR touching a vendored `connector-vault` module obliges a re-vendor +
  re-review in the runner (new SHA, new diff, re-run tests). The app repo stays the source of truth.
- **Proof the vendored code matches app behavior before any real secret:** (a) byte-identical diff at the pinned SHA,
  and (b) the runner **re-runs the committed core's synthetic tests** (`ingest-no-disk`, harness, store) against the
  vendored copy — green — plus the §10.3 synthetic dry-run. Only then may a real secret be considered.

### 11.3 Runtime target — fresh ephemeral host on the CURRENT IAM-user model; §47 EC2 NOT reused — PINNED (with one open infra seam)
Read-only check (2026-06-26, DESCRIBE only — no start/stop/modify):
- **§47 EC2 instance `i-00335d464d6f7c299`: GONE** — `aws ec2 describe-instances` returns no instance (not a usable
  running host).
- The historical role `idc-runner-role` still exists, **but its instance does not**; doc 42 §91 records the **current**
  model as the **IAM user `idcaddie-staging-runner`** (KMS-granted), not the EC2 assumed role.
- **Decision:** **do NOT reuse the §47 EC2** (Option B rejected — it no longer exists). The runner runs on a **fresh,
  ephemeral host/container using the current IAM-user model** (`idcaddie-staging-runner`, fresh temp keys minted for the
  run + deleted after), spun up for the one controlled run and torn down after. **Vercel/Next.js request path is
  excluded** (serverless, browser-reachable, pg-free by design — wrong trust boundary).
- **Open infra seam (per §4):** the *specific* fresh-ephemeral service — a plain VM host vs. an ECS/Fargate one-shot
  container vs. another one-shot runtime — is the **one remaining unresolved infrastructure decision**. It must be made
  **explicitly** before the runner is built; **do not guess** between EC2/ECS/new host. What it must satisfy is fixed:
  receives the `idcaddie-staging-runner` IAM identity (KMS), receives the `connector_runner_login` DB config as an
  injected secret (never committed/logged), is server-only/not browser-reachable, staging-only, and is torn
  down/disabled after the run.

### 11.4 Hard architecture constraints (do not cross without a NEW explicit decision)
- **Building a runner inside `~/code/idcaddie-v3` with `pg` would VIOLATE this architecture decision.**
- **Adding `pg` to the app repo is NOT authorized.**
- **Any future in-repo runner module would require a NEW explicit architecture decision that replaces §11.1/§11.2.**
- **Phase C cannot proceed until the separate deployable runner exists and is reviewed.**
- **Phase C remains BLOCKED even though B1 and B2 are green.** RISK-001 / RISK-007 remain **OPEN**; cutover **BLOCKED**;
  connector credentials not production-ready.

## 12. Runtime + ingestion model — PINNED (2026-06-26)
Resolves the one open seam from §11.3 (specific service) and the ingestion model it forces. **No AWS resource is created,
no Secrets Manager value is written, no runner code is built by this doc.**

### 12.1 Runtime = ECS/Fargate one-shot task — PINNED
The runner is an **ECS/Fargate one-shot task** (not a VM, not the §47 EC2). Rationale:
- **ephemeral by default** — the task runs once and **exits**; nothing long-lived to patch;
- **no leftover state** — no SSH key, no shell history, no temp files, no persistent disk;
- the **task IAM role maps cleanly to `idcaddie-staging-runner`** (KMS-granted, doc 42 §91);
- **Vercel/Next.js request path stays excluded**; the **app repo stays pg-free** (the task vendors the core per §11.2 and
  owns `pg` itself); the **§47 EC2 is gone and not reused** (§11.3).

### 12.2 Ingestion model — DECISION: B (Secrets Manager task-read), NOT A (ECS Exec stdin)
A one-shot Fargate task has **no natural interactive stdin**, which forces a choice:
- **A — ECS Exec interactive stdin (REJECTED).** ECS Exec opens an interactive session and pipes the secret to the
  process stdin. **ECS Exec sessions can be logged** (CloudWatch Logs / S3 session logging captures terminal I/O) — that
  would capture the **master credential**, reintroducing exactly the exposure the #183 no-disk/no-log hardening removed.
  Proving session logging never captures stdin is fragile, and it bolts an interactive surface onto a one-shot task.
  **Rejected** unless a future decision proves Exec logging is provably incapable of capturing stdin.
- **B — AWS Secrets Manager task-read (CHOSEN).** The operator writes the client secret **once** into a staging-only
  Secrets Manager secret (server-side, no laptop→task pipe). The Fargate task's IAM role reads **only that secret** at
  startup **into memory**, passes the plaintext **directly** to the committed `ingestClientSecret(...)`, and the secret
  is encrypted + stored as an envelope. No interactive session, no ECS Exec, no stdin from a laptop — the natural fit
  for a one-shot task.

**The new problem, named (not hidden):** Model B moves the secret-handling question to *"how does the operator safely
put the secret into Secrets Manager?"* — answered in §12.4 (Console no-echo write).

### 12.3 Harness reconciliation — core UNCHANGED, only the plaintext SOURCE changes
The committed `ingestClientSecret(input, deps)` consumes `input.plaintext` **directly** (`client-secret-ingest-harness.ts`);
`readSecretFromStream(process.stdin)` is merely **one** source. Model B substitutes the source: the task **fetches the
secret from Secrets Manager into memory** and calls `ingestClientSecret({ plaintext, appEnv: "staging", version: 1 },
{ keyProvider, kekId, store })`. **All committed guarantees are preserved** — the secret is never written to disk (the
core imports no fs-write API, proven by `ingest-no-disk.test.ts`), never an env var (`SLACK_CLIENT_SECRET` is **not**
set — the task uses the SM API, not env), never argv, never logged; output is the redacted `secret_id` or a safe static
reason; the catch surfaces no caught error. **`saveSlackClientSecret` / `encryptAppSecret` / `createRunnerAppSecretStore`
are used unchanged.**
- **stdin-only (#183 / doc 46 §5) remains the valid model for INTERACTIVE runner models.**
- **For the Fargate one-shot runtime, Secrets Manager task-read SUPERSEDES the stdin source** (the laptop→stdin pipe
  does not exist on a one-shot task).

### 12.4 Model B — secret WRITE (operator → Secrets Manager, the only human-touch point)
- Create a **staging-only** secret, name convention **`/idcaddie/staging/slack/oauth-client-secret`**
  (`ca-central-1`, account `833822972703`). **Never** a production secret.
- The value is entered **once** by the operator via the **AWS Console secret-value field** (or an approved no-echo CLI
  method) — **never** a CLI argv (`--secret-string '<value>'`), **never** shell history, **never** a screenshot, **never**
  pasted into chat/docs/PR.
- Operator verifies the secret **exists without printing the value**:
  `aws secretsmanager describe-secret --secret-id /idcaddie/staging/slack/oauth-client-secret` (metadata only — never
  `get-secret-value` in the setup shell).

### 12.5 Model B — task READ (Fargate startup, in-memory only)
- The task role calls `secretsmanager:GetSecretValue` on **only that secret ARN**, reads the plaintext **into memory**,
  passes it straight to `ingestClientSecret(...)`, and discards it. It **never** logs the secret, **never** writes it to
  disk, **never** puts it in the task env dump.
- **Fail-closed:** missing/empty secret, wrong secret ARN/name, missing KMS config, missing DB connection, or any save
  failure → a redacted failure with no leak (the existing harness fail-closed semantics).

### 12.6 Model B — post-ingest CLEANUP (non-optional)
After a verified envelope-only vault row exists (the §8 query shows the active row):
1. **Disable first** — `aws secretsmanager update-secret-version-stage` / restrict, or rotate the value, so the secret
   is no longer usable;
2. **Prove the task can no longer read it** — a `GetSecretValue` as the task role must now fail
   (`ResourceNotFoundException` / `AccessDenied`);
3. **Delete** — `aws secretsmanager delete-secret` with a **short recovery window** (e.g. 7 days) for one-time safety, or
   `--force-delete-without-recovery` once the vault row is confirmed (decide per run; the runbook records which).
- **No active plaintext staging secret may remain** once the runbook requires deletion.

### 12.7 IAM / policy implications (Model B)
- **Task role:** `secretsmanager:GetSecretValue` on **only** `…:secret:/idcaddie/staging/slack/oauth-client-secret-*`;
  `kms:Decrypt` on the SM secret's encryption key as required; and **only** `kms:GenerateDataKey` + `kms:Decrypt` on the
  canonical connector-vault KEK (`a1b7eaa9…`, doc 42 §91). **No** `secretsmanager:*`, **no** broad KMS, **no** production
  secret, **no** other resource.
- **Web/request identity** (`idcaddie-staging-web`) stays **denied** `kms:Decrypt` (doc 42 §91) **and** is granted **no**
  read on the SM secret. No app/Vercel/request role can read the secret. No broad human access beyond the operator's
  one-time Console write. **CloudTrail** records the `GetSecretValue` + KMS calls (audit), and contains **no** plaintext.

### 12.8 Tests required BEFORE any real secret (synthetic only; extends §10)
A future implementation must prove, with a marked **synthetic** secret only:
- the task **fetches** the synthetic secret from Secrets Manager and reaches `ingestClientSecret`;
- **no disk write** of the secret; **no** secret in stdout/stderr, CloudWatch logs, the task **env dump**, or (if ever
  used) ECS Exec logs;
- **missing secret** fails closed; **wrong secret ARN/name** fails closed; **production/staging guard** blocks;
- **task-role IAM least-privilege** holds (`simulate-principal-policy`: GetSecretValue only on the one ARN; KMS only the
  two actions on the canonical key); **web/request denied-decrypt preserved**;
- **scanner clean**; and the **Secrets Manager cleanup/deletion proof** (the task can no longer read it after cleanup).
Plus §10's committed-core tests + the synthetic dry-run. Only when all are green may a real secret be considered.

### 12.9 Posture
**This is docs only.** No AWS resource created, **no Secrets Manager secret written**, no runner code built, no real
Slack client secret loaded, no live KMS run, no AWS keys minted, no OAuth, no B2c-run, production untouched. **RISK-001 /
RISK-007 remain OPEN; cutover BLOCKED; connector credentials not production-ready. Phase C remains BLOCKED until the
ECS/Fargate runtime + the Secrets Manager task-read model are implemented and reviewed.**
