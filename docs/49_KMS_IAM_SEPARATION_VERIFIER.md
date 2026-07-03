# 49 · Connector-vault KMS/IAM separation verifier

**Status:** verifier `implemented` + `selftest ci-enforced`; **live run = operator-only, not yet run**. RISK-007 remains
**OPEN**; Phase C remains **BLOCKED**.

`scripts/verify-connector-vault-kms-iam-separation.mjs` **evaluates** the hosted KMS/IAM separation boundary that
RISK-007 closure depends on, and returns a PASS/FAIL **allowed/denied matrix**. It complements — does not replace —
`verify-staging-kms-iam-separation-dry-run.mjs` (which prints a synthetic decrypt/deny *runbook* for a human). This one
decides access by **evaluation** (`iam:SimulatePrincipalPolicy` + `kms:ListAliases`), which never performs the action.

## What it never does
No `kms:Decrypt`, no `kms:GenerateDataKey`, no `secretsmanager:GetSecretValue`, no ECS, no DB. It reads **no secret
value** and prints **verdicts + metadata only** (identity label, action, redacted resource tail, expected, actual,
PASS/FAIL) — never a secret, DB URL, key material, account id, or full ARN. The agent and CI run **only** `selftest`.

## The matrix (the whole contract)
| # | Identity | Action | Resource | Expected |
|---|---|---|---|---|
| 1 | task/runner role | `kms:Decrypt` | vault CMK | **allowed** |
| 2 | task/runner role | `kms:GenerateDataKey` | vault CMK | **allowed** |
| 3 | task/runner role | `kms:Decrypt` | **decoy** CMK | **denied** (grant scoped to the CMK, not `Resource:*`) |
| 3b | task/runner role | `kms:GenerateDataKey` | **decoy** CMK | **denied** (symmetric CMK-scope check) |
| 4 | web/request role | `kms:Decrypt` | vault CMK | **denied** (load-bearing) |
| 5 | execution role | `kms:Decrypt` | vault CMK | **denied** (load-bearing) |
| 6 | execution role | `secretsmanager:GetSecretValue` | DB-URL secret | **allowed** (only this) |
| 7 | execution role | `secretsmanager:GetSecretValue` | connector secret | **denied** (role separation) |
| 8 | task/runner role | `secretsmanager:GetSecretValue` | connector secret | **allowed** (where applicable) |
| A | — | `kms:ListAliases` | vault CMK | resolves to the **expected alias** (not some other key) |

A single failing row fails the run. Rows 3/3b/4/5/7 are the security-critical **denials**; row A catches a wrong CMK.

**How live access is evaluated.** For KMS rows the verifier fetches the CMK **key policy** (`kms:GetKeyPolicy` —
metadata, no key material) and passes it to `iam:SimulatePrincipalPolicy` via `--resource-policy`, so authorization is
evaluated as *identity policy ∪ key policy*. Without this, a `kms:Decrypt` granted **directly in the key policy** (not via
IAM) would be invisible and a load-bearing DENIED row could wrongly pass. `iam:SimulatePrincipalPolicy` still only
*evaluates* — it performs no action, reads no secret, decrypts nothing.

## Selftest (CI, no AWS)
```
npm run verify:kms-iam:selftest
# SELFTEST PASS — 6 matrix-logic checks (mocks only; no AWS, no decrypt, no get-secret-value).
```
The matrix logic + failure detection (wildcard KMS resource, web/exec decrypt leak, wrong alias, exec reading the
connector secret, output redaction) is covered by `scripts/verify-connector-vault-kms-iam-separation.test.ts` (runs in
CI via `npm test`). No real AWS client is constructed in any test.

## Live run — OPERATOR-ONLY, after explicit approval
Inert + fail-closed by default: it refuses unless enabled + confirmed, rejects the production ref, requires the staging
ref, and requires every identity env var. Run from an admin/read-only profile that may call `iam:SimulatePrincipalPolicy`:
```
CONNECTOR_VAULT_KMS_IAM_VERIFY=1 \
CONNECTOR_VAULT_KMS_IAM_VERIFY_CONFIRM="RUN KMS IAM SEPARATION VERIFY" \
AWS_REGION=ca-central-1 AWS_PROFILE=<admin-readonly> \
CONNECTOR_VAULT_TASK_ROLE_ARN=… CONNECTOR_VAULT_EXEC_ROLE_ARN=… CONNECTOR_VAULT_WEB_ROLE_ARN=… \
CONNECTOR_VAULT_CMK_ARN=… CONNECTOR_VAULT_DECOY_CMK_ARN=… \
CONNECTOR_VAULT_EXPECTED_ALIAS=alias/idcaddie-staging-connector-vault \
CONNECTOR_VAULT_DB_URL_SECRET_ARN=… CONNECTOR_VAULT_CONNECTOR_SECRET_ARN=… \
node scripts/verify-connector-vault-kms-iam-separation.mjs
```
`CONNECTOR_VAULT_DECOY_CMK_ARN` is any *other* real CMK in the account (used only to prove the runner grant is not
wildcarded — the run only *evaluates* access to it, never uses it).

**Expected output:** the matrix with every row `PASS` and `=> ALL SEPARATION CHECKS PASS`.

## Evidence to record (a docs-only verification PR)
Record PASS/FAIL **per row** + the run date/account/region — never a secret, ARN, or key material. A green run is
hosted evidence for the **KMS/IAM separation only**.

## What it does / does not close
Proves: the two runtime identities (web, exec) cannot decrypt vault material, the runner can, the KMS grant is
CMK-scoped (not wildcarded), and Secrets Manager access is role-separated. Does **not** close RISK-007 on its own —
audited secret access/use, rotation/revocation, and the full credential lifecycle remain. RISK-007 stays **OPEN**;
Phase C stays **BLOCKED**; real connector-credential storage/use stays **not allowed**.
