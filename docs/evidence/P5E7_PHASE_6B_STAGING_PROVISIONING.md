# P5E7 Phase 6B — Staging Entra connector + migration 0043 + credential-reference provisioning (evidence)

> **Hosted STAGING only.** Three authorized hosted staging writes were performed against Supabase project
> `ycdpz…qyoai` (idcaddie-staging). **Production was never targeted; the production project ref never entered any command,
> SQL session, env var, or file.** No AWS secret value was read; no IAM/ECS/deployment/Microsoft/Graph/connector-execution
> action occurred. **Microsoft Entra remains `certificationOnly`. Connector-sync ECS family remains dormant. RISK-007 remains
> OPEN. Phase C remains BLOCKED.**

## Authorization scope

Fresh explicit GO (P5E7 Phase 6B) for exactly three hosted staging writes:
1. create **one** synthetic `microsoft_entra` connector in the approved synthetic staging tenant;
2. apply migration `0043_connector_credential_reference.sql` to staging;
3. insert **one** matching row into `public.connector_credential_references`.

Not authorized (and not performed): production access; repurposing/modifying the existing Slack connector; more than one
connector; a customer connector; reading any AWS secret value; changing the Entra credential; IAM changes; ECS
task-definition registration; ECS task/service changes; deployment; token acquisition; Microsoft Graph requests; connector
execution; canonical promotion; Phase C unblocking.

## Coordinates

| Field | Value |
|---|---|
| Timestamp (UTC) | 2026-07-13T15:18:49Z (connector created 15:03:46Z; reference row created 15:15:26Z) |
| v3 SHA | `6d08ec9` (migration `0043` merged in PR #318) |
| runner SHA | `296c5d0` (Entra credential repository; Entra `certificationOnly`) |
| Supabase staging project (masked) | `ycdpz…qyoai` (idcaddie-staging; linked project verified before every write) |
| Synthetic staging tenant (masked) | `aaaa1111…` (slug `storage-verifier-tenant-a`; synthetic, non-customer, non-production) |
| Synthetic Entra connector (masked) | `d48d0618…` (`display_name` = "Synthetic Entra Connector (staging P5E7 Phase 6B)") |
| AWS account / region | `833822972703` / `ca-central-1` |
| Entra secret ARN (masked) | `arn:aws:secretsmanager:ca-central-1:833822972703:secret:/idcaddie/staging/connector/microsoft_entra/****` |
| Credential version | `v1` (logical, non-secret; NOT the AWS `VersionId`, tenant/client id, secret, or a timestamp) |

## Phase 0 — gates (all green before any write)

- v3 `HEAD == origin/main == 6d08ec9`; runner `HEAD == origin/main == 296c5d0`; both trees clean; `0043` unchanged.
- Local: migration-safety ✓; RLS Docker suite ✓ (all migrations incl. `0043` + `connector_credential_reference_test.sql`
  C0–C5, incl. the functional `set role connector_runner` read/write and request-role deny-all tests); v3 DAL + guard vitest
  13/13 ✓; v3 `tsc` ✓; runner suite 607/607 ✓; runner `tsc` ✓; `vendor:verify` ✓; `deploy:check` ✓; Entra
  `certificationOnly` count 2 ✓.
- Hosted read gates: Supabase linked = staging `ycdpz…qyoai`; `0043` the **only** pending migration; AWS identity =
  account `833822972703`.

## Connector counts (before → after)

| Metric | Before | After |
|---|---|---|
| `microsoft_entra` connectors | 0 | 1 |
| `microsoft_entra` **active** connectors | 0 | 1 |
| Slack connectors (`slack`/`pending`) | 1 | 1 (unchanged) |
| connectors total | 1 | 2 |

Phase 2 used one guarded atomic `DO` block: confirm tenant exists → assert no `microsoft_entra` connector for it → insert
exactly one (`provider='microsoft_entra'`, `status='active'`, `organization_id` NULL) → assert exactly one inserted →
assert provider/status. No upsert, no fallback update, no Slack mutation. No credential/tenant-id/client-id/ARN is stored on
the connector row (the schema has no such columns).

## Migration state (before → after)

| Migration | Before | After |
|---|---|---|
| `0043_connector_credential_reference.sql` | local present, **remote PENDING** (sole pending migration) | **remote APPLIED** (`schema_migrations.version='0043'` = 1) |

Dry-run immediately before apply showed exactly one migration to push (`0043`); `supabase db push --linked` applied it. No
reset, no repair, no seed, no unrelated migration, no production target.

### Migration 0043 post-apply verification (staging)

- `public.connector_credential_references` exists; RLS enabled; **0** policies (deny-all).
- Composite FK `FOREIGN KEY (connector_id, tenant_id) REFERENCES connectors(id, tenant_id) ON DELETE CASCADE` present.
- Unique identity `UNIQUE (tenant_id, connector_id, provider)` present.
- `anon` SELECT = false; `authenticated` table SELECT = false; `authenticated` column SELECT on `credential_secret_ref` = false.
- `connector_runner`: table SELECT = false, column SELECT on `credential_secret_ref`/`credential_version` = **true**; INSERT/UPDATE/DELETE = false.
- `public.connectors` access unchanged: `authenticated` SELECT = true; `connector_runner` column SELECT on `status` = true.

## AWS metadata-only verification (Phase 4)

- Account `833822972703`, region `ca-central-1` confirmed.
- Exactly **1 active** Entra secret in `/idcaddie/staging/connector/microsoft_entra/`; **0** pending-deletion.
- Exact ARN obtained in process memory only (never printed; masked above).
- Exact-ARN task-role grant still exists: role `idcaddie-staging-slack-taskread`, inline policy
  `idcaddie-staging-microsoft-entra-secret-read`, `secretsmanager:GetSecretValue` scoped to the exact ARN.
- **No** `get-secret-value` / `batch-get-secret-value` / KMS decrypt / any content-retrieval API was called.

## Reference-row counts (before → after) and provisioning

| Metric | Before | After |
|---|---|---|
| `connector_credential_references` rows | 0 (table created empty by `0043`) | 1 |

Phase 5 used one guarded atomic `DO` block via a `0600` temp SQL file (ARN embedded from process memory, file never printed,
deleted immediately): confirm exactly one active Entra connector → assert active → assert no existing reference row → insert
exactly one (`tenant_id`, `connector_id`, `provider='microsoft_entra'`, `credential_secret_ref`=exact ARN,
`credential_version='v1'`) → assert exactly one inserted. No upsert, no update, no fallback lookup, no broad query. The full
ARN was kept out of shell history and argv.

## Hosted verification (Phase 6)

| Check | Result |
|---|---|
| `0043` recorded as applied | yes (`schema_migrations.version='0043'`) |
| exactly one `microsoft_entra` connector, active | yes |
| exactly one credential-reference row | yes |
| stored reference **equals** metadata ARN (boolean) **and** version = `v1` | **true** |
| stored version | `v1` |
| runner's exact query (tenant+connector+provider, `status='active'`, LIMIT 2) returns exactly one row | 1 |
| another tenant cannot resolve the row (tenant-B binding, same connector) | 0 |
| `authenticated` can SELECT the table | false |
| `anon` can SELECT the table | false |
| `connector_runner` intended column read granted | true (grant surface; functional C1/C2 proven by the local RLS suite in Phase 0) |
| `connector_runner` INSERT / UPDATE / DELETE | false / false / false |
| Slack connector unchanged (`slack`/`pending`, same tenant) | yes |
| any other connector or reference row added | no |

Note: the Supabase Management API query role is not a superuser and cannot `set role connector_runner`, so the functional
`SET ROLE` read/write was not exercised over that channel (a good sign — the API role cannot impersonate the runner). The
runner grant surface is proven here via `has_column_privilege`/`has_table_privilege`, and the functional `set role
connector_runner` read (C1/C2) + request-role deny-all (C3) are proven by `connector_credential_reference_test.sql` in the
local RLS Docker suite (green in Phase 0) against this exact migration.

## Confirmations

- **No secret value read** — only `list-secrets` metadata + IAM read (`list-roles`/`get-role-policy`); never `get-secret-value`/`batch-get`/KMS decrypt.
- **Production untouched** — every write targeted the linked staging project `ycdpz…qyoai`; the production ref never appeared in any command/SQL/env/file.
- **No AWS write, no IAM change, no ECS change, no deployment, no Microsoft request, no connector execution.**
- Microsoft Entra remains `certificationOnly`; connector-sync ECS family remains dormant.

## Rollback procedure

- To undo provisioning: `delete from public.connector_credential_references where provider='microsoft_entra';` (removes the one row).
- The synthetic Entra connector row is removed **only** under a later explicit rollback GO.
- Do **not** drop migration `0043` or the `connector_credential_references` table under this phase.

## Stop line

Work stops here — **before** live composition wiring, task-definition registration, ECS reactivation, secret reads, token
acquisition, Graph execution, or connector execution. **RISK-007 remains OPEN. Phase C remains BLOCKED.**
