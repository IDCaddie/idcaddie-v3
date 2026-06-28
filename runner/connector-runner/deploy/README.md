# connector-runner deploy package (INERT SKELETON — PR #202)

The shape of the future **ECS/Fargate one-shot** deploy for the connector runner. **Nothing here deploys or runs.** No
deployment was performed; there is **no AWS/KMS/Secrets-Manager/pg call**, **no real config value** (account/region/ARN/
secret/KMS key/DB url are all `REPLACE_WITH_*` placeholders), and the runner stays **disabled/fail-closed**. **RISK-007
remains OPEN.**

## Files
- `Dockerfile` — inert image skeleton. No secret build args, no AWS creds, no baked env secrets; default `CMD` fails
  closed (prints a disabled line, exits non-zero). The real build/run is **future, not implemented** (below).
- `task-definition.template.json` — ECS/Fargate one-shot task-definition template. Placeholders only; the
  `secrets[].valueFrom` is a Secrets Manager ARN **placeholder** (task-read, Model B, doc 46 §12.2) — never an inline
  secret. Non-secret config is in `environment`; `ID_CADDIE_CONNECTOR_RUNNER_ENABLED` is absent (disabled).
- `env.example` — the env-var reference template; reference fields hold names/aliases/ARNs/env-var-names only.

## Validation (what protects this)
`scripts/check-deploy-templates.sh` (run in CI, with a selftest) asserts: the templates contain the `REPLACE_WITH_*`
placeholders; they carry **no real 12-digit account / ARN / KMS key UUID / Slack or AWS token / DB url with a
password**; there is **no executable deploy/apply command** in any non-`.md` file (`aws ecs run-task`, `terraform
apply`, `cdk deploy`, `sam deploy`, `docker push`, …) — the README may mention them in prose; and the `Dockerfile` has
no secret build args. The scope is the `deploy/` dir only (the real staging account legitimately appears in other
committed docs, so the scan is not repo-wide).

## Runtime boundaries (future)
- the task receives secret **references**, never secret values;
- it reads from Secrets Manager **later**, not now;
- it may use KMS **later**, only after the production KMS/IAM is provisioned and **verified**;
- it logs **safe status only**, writes **no secret to disk**, and **exits non-zero when disabled**;
- there is **no production-ready enable flag** in this PR.

## Future run command — NOT IMPLEMENTED
The production flow (documented for direction only; **do not run** — nothing below is wired or authorized):
1. build + push the image to ECR; 2. register the task definition with real staging values substituted (never
committed); 3. `aws ecs run-task` as a one-shot Fargate task on the `idcaddie-staging-runner` identity; 4. the task
reads the Secrets Manager secret into memory, calls the committed `ingestClientSecret(...)`, exits; 5. the staging
secret is disabled → proven unreadable → deleted (doc 46 §12.6). **None of this is executed by this repo.**

## Infra preflight (read-only, operator-run — PR #204)
Before any provisioning/round-trip, an operator can run a **read-only** preflight that DESCRIBES the AWS/KMS/IAM/Secrets-
Manager shape — it performs **no deploy, no KMS crypto, no secret read, no DB connection, no state change**. The agent
and CI never run it live (CI only runs its guard self-test). It is fail-closed and opt-in:

```
ID_CADDIE_RUNNER_PREFLIGHT=1 \
AWS_PROFILE=<your read-only profile> \
AWS_REGION=ca-central-1 \
ID_CADDIE_RUNNER_PREFLIGHT_EXPECTED_ACCOUNT=<staging account id — see doc 42 §91> \
ID_CADDIE_RUNNER_PREFLIGHT_ENV=staging \
bash scripts/check-runner-infra-preflight.sh
```

It checks: caller account == expected staging account (ca-central-1); the KMS alias `alias/idcaddie-staging-connector-vault`
resolves to the canonical Enabled key (not the superseded key); IAM users `idcaddie-staging-runner` / `idcaddie-staging-web`
exist; `simulate-principal-policy` shows runner `GenerateDataKey`+`Decrypt` allowed / `Encrypt` not / web `Decrypt`
explicitDeny; the Secrets Manager secret `/idcaddie/staging/slack/oauth-client-secret` metadata (NOT-YET-CREATED is the
expected state); and the §47 EC2 host is gone. It **refuses** without opt-in / profile / region / expected-account / env,
and **hard-aborts** if pointed at the production project ref `dzbfxulvxchdemcettrx`.

Allowed (read-only): `sts get-caller-identity`, `kms describe-key`, `iam get-user`/`simulate-principal-policy`,
`secretsmanager describe-secret`, `ec2 describe-instances`. **Never:** secret-value reads, KMS crypto, ECS run-task, any
IAM/KMS/secret write, or a Postgres connection. Output is a redacted PASS/FAIL/UNKNOWN checklist — never a secret value,
key material, or raw policy/secret JSON.

**A PASS proves SHAPE/IDENTITY only** — no cryptography verified, no secret read, the live KMS round-trip + AccessDenied
negative are a separate future step, and **RISK-007 stays OPEN**.

## Next steps before RISK-007 can close
provision staging runner infra · provision/verify KMS/IAM (live round-trip + AccessDenied negative) · Secrets Manager
task-read · first-real-token staging dry-run (doc 44 §5) · B2c-run runbook (doc 45) · reviewed `connector_runner_login`
provisioning · real runner-backed `VaultProviderTokenSource`. **RISK-001/RISK-007 remain OPEN; cutover BLOCKED.**
