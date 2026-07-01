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
- **Task role — three distinct least-privilege permissions, kept separate (tightened by PR #213):**
  1. **Secrets Manager task-read** — `secretsmanager:GetSecretValue` on **only**
     `…:secret:/idcaddie/staging/slack/oauth-client-secret-*`. No `secretsmanager:*`, no write action, no other/decoy/
     production secret. (This is the dimension `scripts/check-runner-task-read.sh` proves.)
  2. **`kms:Decrypt` — the customer-managed CMK decrypt path.** The SM secret is CMK-encrypted (the canonical KEK, alias
     `alias/idcaddie-staging-connector-vault`, PR #211), so `GetSecretValue` returns plaintext only with `kms:Decrypt` on
     that key; the same action unwraps the envelope DEK during ingest. Scope to the KEK, resolved by alias at runtime —
     **not** a hardcoded key UUID.
  3. **`kms:GenerateDataKey` — the ingest envelope-WRITE only, NOT for reading Secrets Manager.** Grant **only** when the
     same one-shot task, immediately after the task-read, calls `ingestClientSecret(...)` and must create the encrypted
     vault row. A read-only task does not get it.
  **No** `kms:*`, **no** `kms:Encrypt` / `kms:ReEncrypt*` / `kms:DescribeKey`, **no** `Resource "*"`, **no** broad KMS,
  **no** production secret, **no** other resource; never the superseded key (doc 42 §91.2).
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

> **UPDATE (PR #211, 2026-07-01):** the design-time posture above is superseded on one point — the operator has now
> **provisioned the staging Secrets Manager secret** `/idcaddie/staging/slack/oauth-client-secret` and it passed
> **metadata-only** verification (§19 / docs/47). The secret **value** lives only in AWS Secrets Manager (staging),
> **never** in the repo/docs; it was **never read** (`no get-secret-value`). No live KMS run, no OAuth, no B2c-run, no
> ECS task-read, production untouched. **RISK-001 / RISK-007 remain OPEN; Phase C BLOCKED.**

## 13. PR #199 — in-repo TYPED SEAM landed (skeleton only) · 2026-06-28
PR #199 added **only the typed app↔runner boundary** in the app repo —
`src/lib/server/connector-vault/runner-ingest-entrypoint.ts`: the `RunnerIngestEntrypoint` contract
(`run(request, deps?)`), the non-secret `RunnerIngestRequest`, the redacted `RunnerIngestResult` /
safe `RunnerIngestReason`, `validateRunnerIngestRequest`, an always-false `isRunnerIngestEntrypointEnabled`,
and a `createDisabledRunnerIngestEntrypoint()` placeholder whose `run()` always fails closed
(`reason:'disabled'`). It reaffirms **§11.1/§11.2/§11.4**: the runtime/CLI/`pg`/AWS stay in the
**separate runner deployable**; the app gains **no `pg`, no new runtime dependency, no entrypoint
script** (its only import is a TYPE import from the committed core, so the separate runner vendoring
this file + the core is a zero-contract-change drop-in). New boundary scan
`scripts/check-app-runtime-imports.sh` enforces the app stays pg/`@aws-sdk/client-secretsmanager`-free,
`src/app` imports no runner internals/`@aws-sdk/client-kms`, and KMS stays confined to the two adapters.
**Phase C stays BLOCKED; RISK-001/RISK-007 remain OPEN; no real secret, no runtime, no AWS resource.**

## 14. PR #200 — in-repo runner SKELETON: the explicit decision §11.4 required · 2026-06-28
§11.4 says *"any future in-repo runner module would require a NEW explicit architecture decision that replaces
§11.1/§11.2."* PR #200 is directed by the architecture owner and **records that decision here**, EXTENDING (not
weakening) §11:
- **What changed:** the conforming runner's **skeleton** now lives in-repo at `runner/connector-runner/` (a structurally
  separate, app-build-excluded directory with its own `tsconfig.json` + `npm run runner:typecheck` / `npm run
  runner:test`). It implements the PR #199 typed seam, **vendoring** the contract (`src/contract.ts`, self-contained —
  it does not import app `src/`), and is **fail-closed** (`run()` always returns `{ok:false, reason:"runner_disabled"}`).
- **What is PRESERVED (the §11.4 hard line holds):** the skeleton has **NO `pg`, NO AWS SDK, NO KMS client, NO Secrets
  Manager, NO Postgres, NO vault reader** — so the forbidden case ("a runner inside `~/code/idcaddie-v3` **with `pg`**")
  is NOT crossed. The app `src/` stays pg-free and **does not import the runner** (enforced by
  `scripts/check-app-runtime-imports.sh`, which now also scans `runner/` for forbidden imports — run in CI). The
  production runner (with `pg` + real KMS/Secrets-Manager + `connector_runner_login` + its own host, §11.1/§11.3) is
  still future work and **may become its own repo**; vendoring discipline (§11.2) governs how it copies the core.
- **What is NOT changed:** Phase C stays **BLOCKED**; no real token/KMS/AWS/pg; no production deploy (no Docker/ECS that
  could run); **RISK-001 / RISK-007 remain OPEN**; cutover BLOCKED; connector credentials not production-ready.

## 15. PR #201 — in-repo deployment-contract skeleton (typed, fail-closed) · 2026-06-28
PR #201 lands the **deployment CONTRACT only** for the separate runner — no real deploy, no AWS/KMS/Secrets-Manager/pg,
no real token. It adds `runner/connector-runner/src/deploy-config.ts`: a typed `validateDeployConfig(env)` that validates
the SHAPE of the future ECS/Fargate runtime config (runtime target = ECS/Fargate one-shot §12.1; ingestion = Secrets
Manager task-read Model B §12.2; staging-only §6; KMS via alias reference §9; the `connector_runner_login` DB password
referenced by env-var NAME, never a connection string). It accepts only **references** (names/aliases/ARNs/env-var-names)
and hard-rejects any raw secret VALUE (`secret_value_supplied`); it is **disabled by default** (`deploy_disabled` —
`productionRunnerProvisioned` hardcoded false; reads the trusted env map only; a request can't enable it) and performs no
decrypt/resolve/connect. It is self-contained (no app-`src/`/pg/AWS/KMS import — covered by the runner self-test +
`check-app-runtime-imports.sh scan_runner`), and a runner test asserts the committed config + README carry **no real
ARN/account/key-material/DB-URL**. Also fixes the README cross-reference (`§11.5` → `§14`). **No runnable infra is
committed** (no Dockerfile/ECS-taskdef/Terraform/CDK/CFN/aws-cli). Phase C stays **BLOCKED**; **RISK-001/RISK-007 remain
OPEN.**

## 16. PR #202 — in-repo ECS/Fargate deploy PACKAGE skeleton (inert) · 2026-06-28
PR #202 adds the **inert deploy package skeleton** under `runner/connector-runner/deploy/` — the concrete shape for the
future ECS/Fargate one-shot deploy, **without making it deployable**. **No deployment was performed**; there is **no
AWS/KMS/Secrets-Manager/pg call** and **no real config value** (account/region/ARN/secret/KMS key/DB url are all
`REPLACE_WITH_*` placeholders). Files: `Dockerfile` (no secret build args; default `CMD` fails closed), a
`task-definition.template.json` (ECS/Fargate one-shot; `secrets[].valueFrom` is a Secrets Manager **placeholder** =
task-read Model B §12.2; non-secret config in `environment`; runner disabled — `ID_CADDIE_CONNECTOR_RUNNER_ENABLED`
absent), `env.example` (reference placeholders), and `deploy/README.md` (runbook; the real run command is **prose-only,
"future, not implemented"**). New `scripts/check-deploy-templates.sh` (CI, scoped to `deploy/`) asserts placeholders
present, **no real account/ARN/KMS-UUID/token/DB-url**, **no executable deploy/apply command** in templates, and no
Dockerfile secret build args. Runner stays disabled/fail-closed; app stays pg/AWS/KMS-free. Phase C **BLOCKED**;
**RISK-001/RISK-007 remain OPEN.**

## 17. PR #204 — read-only staging infra PREFLIGHT (step-0, before the live KMS round-trip) · 2026-06-28
PR #204 adds `scripts/check-runner-infra-preflight.sh`: a **read-only, fail-closed, opt-in** preflight that DESCRIBES the
staging AWS/KMS/IAM/Secrets-Manager shape **before** any provisioning or the live B2 KMS round-trip (§91.7 of doc 42).
It performs **no deploy, no KMS crypto (Decrypt/Encrypt/GenerateDataKey), no Secrets-Manager GetSecretValue, no Postgres
connection, no IAM/KMS/secret state change**. Allowed read-only calls: `sts get-caller-identity`, `kms describe-key`,
`iam get-user`/`simulate-principal-policy`, `secretsmanager describe-secret` (metadata only — §12.4, value never read),
`ec2 describe-instances`. Guards (fail-closed, in order): opt-in `ID_CADDIE_RUNNER_PREFLIGHT=1` → `AWS_PROFILE` →
`AWS_REGION=ca-central-1` → explicit 12-digit `ID_CADDIE_RUNNER_PREFLIGHT_EXPECTED_ACCOUNT` (verified vs live `sts`) →
`ID_CADDIE_RUNNER_PREFLIGHT_ENV=staging` → production project-ref `dzbfxulvxchdemcettrx` hard-abort. The agent and CI
never run it live (CI runs only the guard self-test; the static-analysis test bounds it to allowlisted read-only
actions). **A PASS proves SHAPE/IDENTITY only** — no cryptography verified, no secret read, the Secrets Manager secret
stays NOT-YET-CREATED (§12.9). RISK-001/RISK-007 remain **OPEN**; Phase C **BLOCKED**.

## 18. PR #205 — live KMS round-trip verification (step-1 after the preflight) · 2026-06-28
PR #205 (a) RECORDS the safe, redacted result of the PR #204 preflight operator run (docs/47 — staging account/region/
KMS-alias/IAM identities/simulate decisions all PASS; the SM secret stays NOT-YET-CREATED), and (b) adds
`scripts/check-runner-kms-roundtrip.sh`: an **operator-run-only** LIVE KMS round-trip that proves the staging decrypt
boundary with **synthetic data-key material only**. It invokes only `sts get-caller-identity`, `kms generate-data-key`,
`kms decrypt` (the runner's only KMS grants) — runner GenerateDataKey + Decrypt round-trip (recovered == generated), web
Decrypt of the same wrapped key MUST be AccessDenied (the live negative). The canonical-key check derives from the
`GenerateDataKey` `KeyId` (the runner is **not** granted `kms:DescribeKey`, §91.4). It never attempts `kms:Encrypt`
(policy forbids it, §91.4), reads no Secrets-Manager value, connects to no Postgres, changes no state, and is fail-closed/opt-in/staging-only
(production project-ref hard-abort). Key material lives only in shell vars (`umask 077`), is compared in-shell, and is
NEVER printed — output is a redacted PASS/FAIL checklist + safe error class. The agent and CI NEVER run the live path
(CI runs only the guard self-test; a vitest test bounds the script to the 4 allowlisted actions and asserts no
key-material is printed). **A green run proves the LIVE decrypt boundary (synthetic) only** — it stores no real secret;
the live result is **PASSED** (operator run 2026-06-28, PR #206: runner GenerateDataKey+Decrypt round-trip matched, web
Decrypt = AccessDenied, no Encrypt, no secret read, no real secret stored — docs/47). A green round-trip proves the live
decrypt boundary only; RISK-001/RISK-007 remain **OPEN**; Phase C **BLOCKED**.

## 19. PR #209 — Secrets Manager secret provisioning + metadata verification (operator-run) · 2026-07-01
PR #209 adds the safe operator runbook to provision the staging Slack OAuth client-secret reference
`/idcaddie/staging/slack/oauth-client-secret` (§12.4: Console/stdin value entry — never argv/history/chat/docs) plus
`scripts/check-runner-secret-metadata.sh`: a fail-closed, opt-in, **read-only, metadata-only** verifier. It invokes ONLY
`sts get-caller-identity` and `secretsmanager describe-secret` (which returns metadata, **never** the value) — it NEVER
calls `get-secret-value`, never reads/prints/logs the secret value, makes no KMS crypto / IAM / ECS / Postgres call, and
changes no state. It checks the secret exists with the expected name / region / account / KMS association (default vs a
supplied expected key) + version count + tag keys, and prints a redacted PASS/FAIL/INFO checklist (no value, no raw ARN,
no KMS id). Guards: opt-in + profile + `AWS_REGION=ca-central-1` + 12-digit expected account (verified vs live `sts`) +
`env=staging` + production project-ref hard-abort; missing secret fails closed (NOT-YET-CREATED → provision first). The
agent and CI never run the live path (CI runs only the guard self-test; a vitest static test bounds it to the two
allowlisted actions and forbids `get-secret-value`; a vitest behavioral test proves at runtime that `get-secret-value` is
never invoked). **Live provisioning result: DONE** (PR #211, 2026-07-01) — the operator provisioned the secret and the
metadata verifier passed (secret exists at the pinned name; account `833822972703` / `ca-central-1`; customer-managed
KMS association whose alias target matched `alias/idcaddie-staging-connector-vault`; 1 version; no tags; **value never
read; no `get-secret-value`**; no key id / ARN recorded — docs/47). This is the provisioning + metadata-verification
prerequisite; the ECS/Fargate **task-read** (§12.5) is a later step (still PENDING). RISK-001/RISK-007 remain **OPEN**;
Phase C **BLOCKED**.

## 20. PR #210 — ECS/Fargate task-read SKELETON (typed, fail-closed) · 2026-07-01
PR #210 adds the runner-side **task-read seam** for the future Model B task-read (§12.5): `runner/connector-runner/src/
task-secret-read.ts` — a typed, self-contained (no app-`src/` import), **AWS-SDK-free** fail-closed skeleton.
`TaskSecretReader.read(request, consume)` takes a **non-secret reference** request; the result carries **no value**
(only ok/reason/provider + the non-secret secretRef). **Leak-proof by construction:** the future real reader delivers
the plaintext ONLY via `consume(plaintext)` in-scope (→ `ingestClientSecret`), never a returned field. `GetSecretValue`
appears only in COMMENTS; nothing is imported/invoked. `createDisabledTaskSecretReader().read()` ALWAYS returns
`{ok:false, reason:"task_read_disabled"}` and NEVER calls `consume` (never reads). The app runtime stays
Secrets-Manager-free — `scripts/check-app-runtime-imports.sh` now forbids the `GetSecretValue`/`get-secret-value` API
name under `src/` too, confining task-read to the runner boundary. An operator-run readiness harness
(`scripts/check-runner-task-read.sh`) proves — by `describe-secret` + `simulate-principal-policy` ONLY, never
`get-secret-value` (§12.8) — that the task role is allowed GetSecretValue on only the pinned ARN and denied elsewhere.
The agent and CI never run the live path (CI runs only the guard self-tests; static + behavioral tests prove
`get-secret-value` is never invoked). **Live task-read result is PENDING** (the secret + task role are not yet
provisioned). RISK-001/RISK-007 remain **OPEN**; Phase C **BLOCKED**.

## 21. PR #212 — ECS/Fargate task-role provisioning + readiness (IAM simulation only) · 2026-07-01
PR #212 extends the readiness harness `scripts/check-runner-task-read.sh` to prove the **task role's** least-privilege for
the future Model B task-read (§12.7/§12.8) — by `simulate-principal-policy` + `describe-secret` ONLY, never
`get-secret-value`, never reading the value. Four IAM-simulation facts: GetSecretValue **allowed on only** the pinned
secret; **denied** on a decoy staging secret; **denied** on a production-NAMED same-account secret (name-scoped — real
cross-account production isolation is the AWS account boundary, not this policy); **denied** a write action (no broad
`secretsmanager:*`). The principal defaults to the current pinned identity (IAM user `idcaddie-staging-runner`, §12.1);
the operator supplies the real ECS/Fargate task-role ARN via `ID_CADDIE_RUNNER_TASK_READ_ROLE_ARN` once provisioned (the
specific task-role provisioning/name is the §11.3 unresolved infra decision; the ECS/Fargate runtime is PINNED in §12.1).
Output is redacted (no raw ARN / account / value); fail-closed + opt-in + staging-only; the agent and CI never run the
live path (CI runs only the guard self-test; static + behavioral tests prove `get-secret-value` is never invoked and no
ARN is printed). **Task-role readiness is PENDING** (no operator run against a provisioned task role yet). RISK-001/
RISK-007 remain **OPEN**; Phase C **BLOCKED**.

## 22. PR #213 — persisted task-role provisioning runbook (docs-only) · 2026-07-01
PR #213 persists the operator runbook to provision the staging ECS/Fargate Slack task-read role into docs/47 (Step 0
policy files → Step 1 create role → Step 2 attach the Secrets Manager task-read grant → Step 3 KMS → Step 4 run
`check-runner-task-read.sh`), and tightens §12.7 so the three permissions are kept **separate and purpose-scoped**:
`secretsmanager:GetSecretValue` = task-read of only the pinned SM secret; `kms:Decrypt` = the customer-managed CMK
decrypt path (required to complete GetSecretValue); `kms:GenerateDataKey` = the ingest envelope-WRITE only (a one-shot
task that immediately calls `ingestClientSecret`), **not** required merely to read from Secrets Manager. KMS is scoped to
the canonical KEK by **alias** `alias/idcaddie-staging-connector-vault` resolved at runtime — no hardcoded key UUID; no
`kms:*`, no `Resource "*"`, no `kms:Encrypt`/`kms:ReEncrypt*`. Docs-only: **no IAM resource created, no AWS command run, no
`get-secret-value`, no ECS run, no production touch, no `VaultProviderTokenSource` enablement.** Task-role readiness stays
**PENDING**. RISK-001/RISK-007 remain **OPEN**; Phase C **BLOCKED**.
