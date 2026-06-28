# connector-runner (deployable SKELETON — fail-closed)

The hosted connector runner is a **separate deployable** (doc 46 §11). This directory is its **in-repo skeleton** (PR
#200): a structurally-isolated, **pg/AWS/KMS-free**, fail-closed implementation of the typed runner seam from PR #199.
It loads **no real secret**, performs **no KMS decrypt / AWS Secrets Manager / Postgres** access, and is **disabled by
default**. **RISK-007 stays OPEN.**

## Separate from the app runtime
- Lives outside `src/`, with **its own `tsconfig.json`** (`npm run runner:typecheck`) and **its own test run**
  (`npm run runner:test`) — it compiles/tests independently of the Next app.
- It is **excluded from the app build** (root `tsconfig.json` `exclude`), and the app `src/` **never imports it**
  (enforced by `scripts/check-app-runtime-imports.sh`, run in CI).
- It **vendors** the typed contract (`src/contract.ts`) instead of importing app `src/` — mirroring the doc 46 §11.2
  vendor model. The production runner vendors the connector-vault core **byte-identical at a pinned commit** + a drift
  check; this skeleton vendors only the contract.

## What it implements (from the PR #199 seam)
- `ConnectorRunner.run(request)` → a **redacted** `RunnerResult` (`{ok, secretId|reason, provider}`; never a token,
  secret, ciphertext, DEK, DB conn string, or AWS creds).
- `RunnerRequest` — a **non-secret** envelope (provider/tenant/connector/purpose/secretKind/appEnv/version); carries no
  plaintext (the real runner reads the secret from Secrets Manager, never from the request).
- `validateRunnerRequest`, `isConnectorRunnerEnabled` (allowlist, **always false**), `createConnectorRunner` (fail-closed:
  `run()` always returns `{ok:false, reason:"runner_disabled"}`), and a safe `main()` (prints a static line, exits 1).

## What is still DISABLED / forbidden here
No real Slack token, no real OAuth, no KMS decrypt, no AWS Secrets Manager, no Postgres, no production deploy
(no Docker/ECS that could run), no production env, no service-role. The skeleton MUST NOT gain `pg`/AWS until the
production-runner decision (§11.1/§11.3) + RISK-007 closure.

## Relation to §11 (doc 46)
§11.1 pins the runner as its own repo/project and §11.4 requires a **new explicit decision** for any in-repo runner.
PR #200 records that decision in **doc 46 §14**: this skeleton lives in-repo as a separate, app-build-excluded,
pg/AWS-free directory; the **production** runner (with `pg` + real KMS/Secrets-Manager + its own host) still follows
§11 and may become its own repo. The app stays pg-free either way.

## Deployment contract (skeleton)
PR #201 adds the **typed deployment contract only** — no real deploy, no real AWS/KMS/Secrets-Manager/pg, no real token,
runner stays disabled. It is summarized **by reference** (no real ARNs/accounts/secrets/deploy command live in this
repo; the production runner owns the live infra, §11.1/§11.3):
- **Runtime target:** ECS/Fargate **one-shot** task (doc 46 §12.1) on the `idcaddie-staging-runner` IAM identity.
- **Ingestion:** **Secrets Manager task-read (Model B)** — the task reads the secret into memory at startup, NOT ECS-Exec
  stdin (Exec sessions can be logged and capture the master credential, §12.2). Plaintext flows only into the in-memory
  ingest; never disk, env, argv, or logs.
- **KMS boundary:** the runner may `GenerateDataKey`/`Decrypt` only via the canonical staging KEK, referenced by **alias**
  (`CONNECTOR_VAULT_KMS_KEY_ID` → an `alias/…` or ARN — never key material); web identity stays `explicitDeny` on Decrypt.
- **DB boundary:** the runner uses `connector_runner_login` (its password injected as a secret, referenced here by the
  **env-var NAME** `CONNECTOR_RUNNER_DB_URL_REF` — never a connection string) and `SET ROLE connector_runner`.
- **Typed config (`src/deploy-config.ts`):** `validateDeployConfig(env)` validates the SHAPE of `RUNNER_RUNTIME_TARGET`
  / `RUNNER_INGESTION_MODEL` / `RUNNER_APP_ENV` (staging-only) / `CONNECTOR_VAULT_AWS_KMS_REGION` /
  `CONNECTOR_VAULT_KMS_KEY_ID` / `CONNECTOR_VAULT_SECRET_REF` / `CONNECTOR_RUNNER_DB_URL_REF`. It accepts only
  **references** (names/aliases/ARNs/env-var-names) and hard-rejects any raw secret VALUE (`secret_value_supplied`); it
  is **disabled by default** (`deploy_disabled` — `productionRunnerProvisioned` hardcoded false; a request can't enable
  it), reads only the trusted env map, and performs no decrypt/resolve/connect.
- **Cleanup pointer:** after a real ingest the staging Secrets Manager secret is disabled → proven unreadable → deleted
  (doc 46 §12.6). No such secret exists yet.
- **Inert:** no Terraform / CDK / CloudFormation / aws-cli command that can apply anything is committed. The inert
  ECS/Fargate deploy package skeleton (PR #202) lives in **[`deploy/`](deploy/README.md)** — placeholders only,
  fail-closed Dockerfile, no deploy command; validated by `scripts/check-deploy-templates.sh` (CI). Phase C stays
  **BLOCKED**; **RISK-007 stays OPEN** until the items below land.

## Remaining before RISK-007 can close
real hosted runner deploy (ECS/Fargate one-shot) · Secrets Manager task-read · production KMS/IAM provisioned + verified ·
first-real-token staging dry-run (doc 44 §5) · B2c-run runbook (doc 45) · reviewed `connector_runner_login` provisioning ·
real runner-backed `VaultProviderTokenSource`. **RISK-001/RISK-007 remain OPEN; cutover BLOCKED.**
