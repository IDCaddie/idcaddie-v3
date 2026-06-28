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

## Next steps before RISK-007 can close
provision staging runner infra · provision/verify KMS/IAM (live round-trip + AccessDenied negative) · Secrets Manager
task-read · first-real-token staging dry-run (doc 44 §5) · B2c-run runbook (doc 45) · reviewed `connector_runner_login`
provisioning · real runner-backed `VaultProviderTokenSource`. **RISK-001/RISK-007 remain OPEN; cutover BLOCKED.**
