# 07 · P0 Review Checklist

**Canonical source for: how to review a PR for P0s.** Use on every PR that touches data,
security, migrations, scripts, or (future) server/UI code. The security model being
checked against is [02_SECURITY_AND_RLS.md](./02_SECURITY_AND_RLS.md).

## Automatic blockers (any one ⇒ request changes, do not merge)
- ❌ Cross-tenant read or write possible (RLS not keyed on `is_tenant_member`/tenant-bound).
- ❌ Service-role key reachable from the browser or a user-request path.
- ❌ A raw secret/token/credential logged, stored in an app table, or exported.
- ❌ RLS disabled (`DISABLE ROW LEVEL SECURITY`) or a policy weakened without a tested reason.
- ❌ Authorization decided/filtered in the frontend.
- ❌ Destructive import (full-replace / hard-delete) without preview + audit.
- ❌ Any `UPDATE`/`DELETE` path to `audit_logs`.
- ❌ Hosted Supabase migration applied without a separate review.
- ❌ A tenant-owned table without `tenant_id` + RLS.
- ❌ An org FK used for access without tenant-binding (in `enforce_owning_org_tenant` **and** the policy).
- ❌ A merged migration edited (not fixed forward).

## Section-by-section
For each: ask the **questions**, watch the **red flags**, demand the **proof**, then give a **verdict** (pass / changes / block).

| Area | Questions | Red flags | Required proof |
|---|---|---|---|
| **Tenant isolation** | Every new tenant row has `tenant_id`? RLS keyed on membership? | a query without a tenant condition; client-supplied tenant id | a negative test: Tenant A cannot read/write Tenant B |
| **Org/resource isolation** | Reads = related org? Writes = steward only? New access FK tenant-bound? | bare `has_org_role` without tenant; new owning-org column not in the trigger | tests: related read works, non-steward write denied, foreign-tenant FK blocked |
| **RLS** | Policies cover select/insert/update/delete intentionally? `USING` *and* `WITH CHECK`? | "we'll filter in the app"; only a SELECT policy on a writable table | `test-rls.sh` green + new assertions |
| **Service-role usage** | Only in trusted server/test paths? Out of the client bundle? | service-role client imported in `src/app`/components | grep test / build shows no service-role in client |
| **Secrets/credentials** | None in app tables, browser, logs, or exports? | plaintext token; secret in a log line | encrypted/service-role-only store; no secret in diff |
| **Imports/uploads** | Preview before write? Upsert + soft-delete? Provenance + audit? | full-replace; hard-delete; no validation | dry-run + audit rows + dup detection in tests |
| **Exports/reports** | Tenant-scoped? No secrets? No cross-tenant rows? | unscoped query; credential field in export | scoped query + test |
| **Destructive ops** | Reversible or audited? Approval for bulk/deactivation? | cascade delete without audit | audit row before cascade; test |
| **Audit logs** | Append-only respected? Safe fields only? | a write/update/delete path; secret in a field | no mutation path; field allowlist |
| **Files/storage** | Tenant-scoped paths + policy? | shared bucket, no scope | path scoping + policy (when built) |
| **Auth/session** | Server-side session? Context from membership, not input? | client-only auth; tenant from query param | redirect tests; context from rows |
| **Migrations** | Sequential, additive, append-only? Safety check passing? Hosted apply separate? | edited merged migration; `DROP TABLE`/`TRUNCATE` w/o ack | `check-migration-safety.sh` green; checklist filled |
| **Background jobs** | service-role isolated? idempotent? | job writes audit-mutating SQL | scoped, idempotent, tested |
| **Integrations** | Dry-run? scoped tokens? no destructive deactivation w/o approval? | broad token; auto-deactivate | vault-backed creds; dry-run logs |
| **Frontend filtering** | Is any security enforced client-side? | `.filter()` standing in for a policy | RLS proves the boundary, not the client |
| **Tests/CI** | New auth tests (positive + negative)? CI green? | behavior change with no test | `test-rls.sh` + assertions |
| **Docs/risk/changelog** | Docs updated? Risk register touched? Changelog entry? | code change, no doc change, no justification | `check-docs-updated.sh` pass or valid `.docs-not-needed.md` |

## Example failures (what a block looks like)
- *Cross-tenant:* a SELECT policy `using (true)` on a tenant table → Tenant A reads B. **Block.**
- *Owning-org leak:* a new `paying_org_id` read key added but not added to `enforce_owning_org_tenant` → cross-tenant pointer leak (the exact PR #1 bug). **Block.**
- *Audit mutation:* an "edit log note" feature adding an `UPDATE audit_logs` path. **Block.**
- *Service-role:* importing the service-role Supabase client in a client component. **Block.**

## Verdict guide
- **Pass:** no blockers; questions answered; proof present; docs/risk/changelog updated.
- **Changes:** non-blocking gaps (missing test, weak naming, stale doc).
- **Block:** any automatic blocker, or a security claim without a test.
