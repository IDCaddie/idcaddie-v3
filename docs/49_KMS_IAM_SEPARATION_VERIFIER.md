# 49 · Connector-vault KMS/IAM separation verifier

**Status:** verifier `implemented` + `selftest ci-enforced`; **live run = operator-run — hosted STAGING PASS (2026-07-04)**
after least-privilege key-policy tightening (see *Evidence* below). **Staging only — no production run.** RISK-007 remains
**OPEN**; Phase C remains **BLOCKED** (this proves the KMS/IAM separation boundary; it does not close RISK-007).

`scripts/verify-connector-vault-kms-iam-separation.mjs` **evaluates** the hosted KMS/IAM separation boundary that
RISK-007 closure depends on, and returns a PASS/FAIL **allowed/denied matrix**. It complements — does not replace —
`verify-staging-kms-iam-separation-dry-run.mjs` (which prints a synthetic decrypt/deny *runbook* for a human). This one
decides access by **evaluation** — KMS rows by **structural key-policy analysis** (`kms:GetKeyPolicy` metadata),
Secrets-Manager rows by `iam:SimulatePrincipalPolicy`, alias by `kms:ListAliases` — which never performs the action.

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

**How live access is evaluated — KMS rows use structural key-policy analysis, not simulation.** `iam:SimulatePrincipalPolicy`
**cannot** faithfully evaluate a **role** principal against a KMS key policy supplied via `--resource-policy`: resource-policy
evaluation needs a concrete caller, which a role ARN cannot imply (*"Invalid caller — Caller is not present and cannot be
implied from policySourceArn"*), and KMS authorization (key policy + grants + IAM) is not modeled by the IAM simulator.
So for KMS rows the verifier fetches the CMK **key policy** (`kms:GetKeyPolicy` — metadata, no key material, no decrypt)
and evaluates it **structurally** (`evaluateKeyPolicyAccess` / `kmsAccessFromKeyPolicy`): *explicit Deny > explicit Allow >
implicit deny*, matching Principal (exact role ARN) and Action (`kms:Decrypt` / `kms:GenerateDataKey`, incl. `kms:*`).
Verdicts: **allowed** (the task role is explicitly granted), **denied** (no statement grants the principal), **overbroad**
(allowed only via a `*`/account-root principal — deliberately *not* "allowed", so it fails an expected-allowed row and, since
it matches every principal, the expected-denied rows too), and **error** (fail-closed, never a silent pass). Account-root is
recognized in **both** forms AWS treats identically — `arn:aws:iam::<acct>:root` and the bare `<acct>` id — and action
matching is a **case-insensitive glob** (`kms:*`, `kms:Decrypt*`, `kms:*Decrypt`, `*`), since under-matching a grant is the
fail-open direction. A statement carrying `NotPrincipal`, `NotAction`, or `Condition` (which this structural model cannot
safely evaluate) makes the policy **non-analyzable → `error`** (human review), rather than being skipped — a skip could hide
a broad `Allow` on a DENIED row. So a legitimately conditional vault key policy surfaces as `error` (investigate), never a
false pass. This asserts the vault CMK's **key-policy** separation: the runner task role is granted; the execution role
and the decoy CMK are not; no wildcard/root grant of the KMS actions.

*Limitation (documented boundary):* the structural check reads **only the CMK key policy**; it does not enumerate **KMS
grants** (`kms:ListGrants`). A principal granted a KMS action solely via a grant (not named in the key policy, no root
delegation) would read `denied` — a policy-only analysis cannot see runtime grants (the prior simulate approach modeled
them no better). The vault CMK does not rely on grants for the runner; a grant-based path would be a separate check.

**Secrets-Manager rows** are still evaluated with `iam:SimulatePrincipalPolicy` (identity-policy EvalDecision) — **without**
`--resource-policy`, so no caller is needed and the flag that caused the KMS error is never sent. `buildSimulateArgs` also
never passes the literal `*` to `--resource-arns` (`SimulatePrincipalPolicy` rejects it — a wildcard/absent resource omits
the flag, which defaults `ResourceArns` to `*`). All of `buildSimulateArgs` / `principalMatch` / `actionMatch` /
`evaluateKeyPolicyAccess` / `kmsAccessFromKeyPolicy` are pure, unit-tested, and make no AWS call.

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

### Web/request evidence — two modes
The `web/kms:Decrypt/cmk` row (LOAD-BEARING negative: the web/request runtime must not be able to decrypt vault
material) can be evidenced two ways. Pick by whether a web/request AWS principal exists:

- **Mode A — web ROLE mode** (`CONNECTOR_VAULT_WEB_ROLE_ARN=arn:aws:iam::…:role/<web-role>`): the web role is
  **simulated** and must resolve to **denied**. Use this only if the web/request runtime actually runs under an AWS role.

- **Mode B — `NO_WEB_AWS_PRINCIPAL`** (`CONNECTOR_VAULT_WEB_ROLE_ARN=NONE`, exact string): the web/request runtime has
  **no AWS identity by design** (v3 web = Vercel + Supabase RLS). The web row is recorded `no_web_aws_principal` and
  passes **by absence** — it is *not* simulated (there is no principal to simulate). This is **stronger** than a denied
  role: with no principal the web path cannot authenticate to AWS at all, so it cannot perform *any* KMS/Secrets-Manager
  action. Only the exact string `NONE` triggers it; unset/empty/a typo (`none`, `None `) keeps the web ARN **required**
  (unset → refuse) or simulates it as a real ARN (bogus → `error` → FAIL). Only the web rows are affected — task/exec/
  decoy/secret/alias rows are evaluated identically.

  **Three evidence anchors** back Mode B (record them alongside the matrix):
  1. **IAM role list** — `aws iam list-roles` shows **no** web/request role for the environment (only the runner
     `…-connector-runner-exec` and `…-slack-taskread` roles exist).
  2. **CI import boundary** — `scripts/check-app-runtime-imports.sh` fails CI on any `@aws-sdk/client-kms` in `src/app`
     or any `@aws-sdk/client-secretsmanager` / `GetSecretValue` under `src/`, so the request path has no code route to
     KMS or Secrets Manager.
  3. **Request-path token source** — `src/lib/server/sync/vault-provider-token-source.ts` is a hard-throwing,
     fail-closed placeholder (no reader; `isVaultProviderTokenSourceEnabled` is hardcoded `false`).

  Mode B operator command (same as above, but the web line becomes):
  ```
  CONNECTOR_VAULT_WEB_ROLE_ARN=NONE \
  ```
  and no web role ARN is supplied. Expected: the `web` row prints `actual=no_web_aws_principal`, and with the other
  rows green, `=> ALL SEPARATION CHECKS PASS`.

## Evidence to record (a docs-only verification PR)
Record PASS/FAIL **per row** + the run date/account/region — never a secret, ARN, or key material. A green run is
hosted evidence for the **KMS/IAM separation only**.

### Evidence — hosted STAGING run, 2026-07-04 (`ALL SEPARATION CHECKS PASS`)
Account `833822972703` / `ca-central-1`, caller `sam-cli`, **mode B** (`CONNECTOR_VAULT_WEB_ROLE_ARN=NONE`). The default
account-root "Enable IAM" delegation on both CMKs read **`overbroad`** (correct — root delegation is not key-policy
separation), so both key policies were **tightened to least-privilege** before the green run:
- **Vault CMK** (`alias/idcaddie-staging-connector-vault`): admin/manage = `sam-cli` + a new durable `idcaddie-staging-kms-admin`
  role; runtime-use = `idcaddie-staging-slack-taskread` for `kms:Decrypt` + `kms:GenerateDataKey` **only**.
- **Decoy CMK** (`alias/idcaddie-staging-kek`): admin/manage **only** — no runtime-use.
- Both: **no** account-root, **no** wildcard/bare-account principal, **no** exec-role KMS, **no** KMS grants (none pre-existed;
  IAM Access Analyzer returned no findings).

Matrix (all PASS): task→vault `Decrypt`/`GenerateDataKey` **allowed**; task→decoy `Decrypt`/`GenerateDataKey` **denied**;
exec→vault `Decrypt` **denied**; web `Decrypt` = **`no_web_aws_principal`** (IAM role list holds only the runner-exec,
slack-taskread, kms-admin roles — no web/request role); Secrets-Manager DB-URL secret allowed(exec) / connector secret
denied(exec) / connector secret allowed(task); alias = **match**. No `kms:Decrypt`/`GenerateDataKey` executed, no
`GetSecretValue` value read, no ECS, no DB, no production; no secret/DB-URL/token/ARN printed. **Staging only — not a
production claim; does not close RISK-007.** Recorded in [docs/52](./52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md) criteria 5 & 11.

## What it does / does not close
Proves: the two runtime identities (web, exec) cannot decrypt vault material, the runner can, the KMS grant is
CMK-scoped (not wildcarded), and Secrets Manager access is role-separated. Does **not** close RISK-007 on its own —
audited secret access/use, rotation/revocation, and the full credential lifecycle remain. RISK-007 stays **OPEN**;
Phase C stays **BLOCKED**; real connector-credential storage/use stays **not allowed**.
