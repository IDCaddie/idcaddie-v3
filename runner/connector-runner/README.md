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
PR #200 records that decision in **doc 46 §11.5**: this skeleton lives in-repo as a separate, app-build-excluded,
pg/AWS-free directory; the **production** runner (with `pg` + real KMS/Secrets-Manager + its own host) still follows
§11 and may become its own repo. The app stays pg-free either way.

## Remaining before RISK-007 can close
real hosted runner deploy (ECS/Fargate one-shot) · Secrets Manager task-read · production KMS/IAM provisioned + verified ·
first-real-token staging dry-run (doc 44 §5) · B2c-run runbook (doc 45) · reviewed `connector_runner_login` provisioning ·
real runner-backed `VaultProviderTokenSource`. **RISK-001/RISK-007 remain OPEN; cutover BLOCKED.**
