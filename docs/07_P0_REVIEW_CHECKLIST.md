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
- ❌ A `FOR ALL` (or `FOR DELETE`) policy on a core evidence table (`organizations`/`apps`/`contracts`/`app_contracts`/`people`/`app_users`/…) — it silently grants hard-delete; write policies must be `INSERT`+`UPDATE` only until an audited admin/archive path exists (`0004`).
- ❌ A new tenant-scoped child/link table whose parent reference lacks a composite same-tenant FK `(parent_ref, tenant_id) → parent(id, tenant_id)` — RLS hides cross-tenant rows but doesn't prevent writing them (`0005`).
- ❌ Surfacing a **default-deny** child table (`identity_accounts`/`license_rules`/`license_evaluations`/`files`/`invoices`) or the **tenant-only** table `people` to org-only users **as if it were org-scoped** — `0005` FKs protect *writes*, not reads; an org-scoped read policy + test must land first (RISK-002; canonical read map [02 §8](./02_SECURITY_AND_RLS.md)). (`app_contracts` — `0006`/§8a, T28 — `app_users` — `0007`/§8a, T29 — and `app_user_identity_matches` — `0008`/§8a, T30 — are already org-scoped for read and may be surfaced read-only.)
- ❌ **Org-scoping `people` or `identity_accounts`** (they have no app anchor — org-scoping them leaks the tenant-wide HR/IdP directory). The only org-scopable identity table is `app_user_identity_matches` (done — `0008`, gated on a **readable `app_user`**, status only — [12 §5](./12_IDENTITY_MATCHING_READ_SCOPE.md)). Any further identity/matching read PR must land [12 §7](./12_IDENTITY_MATCHING_READ_SCOPE.md) tests **before** UI, must NOT start an org-only view from the `people`/`identity` side, and must NOT expose person PII / `person_id` / `raw_payload` / identity-account details in a match surface.
- ❌ A **contract (or steward) write path** that keys write authority on `paying_org_id` or on related-org **read** visibility (read ≠ write — the write anchor is `procurement_org_id` / tenant editor+ only); or that uses a **service-role app client** in the request route; or that audits writes via service-role instead of a **DB-side `SECURITY DEFINER` trigger** (`audit_logs` is append-only with no `authenticated` INSERT). Write authority already exists in `0004` — do not weaken it; see [13_CONTRACT_STEWARD_WRITE_DESIGN](./13_CONTRACT_STEWARD_WRITE_DESIGN.md).
- ❌ A **user-visible workflow change without parity approval.** For any PR touching a user-facing surface, the reviewer must answer: *"Does this PR preserve or restore a legacy user workflow exactly? If not, is the difference intentional, documented (in [14_LEGACY_UX_WORKFLOW_PARITY_MAP](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md) as Better-approved / Removed-approved), and approved by the product owner?"* An unapproved user-visible change (field/action/filter/sort/export/label/navigation) is a **blocking** finding. Backend-only changes (no perceivable difference) are exempt from product approval (still need docs/test/PR discipline). Never copy a legacy backend anti-pattern to achieve "sameness".
- ❌ Telemetry/analytics carrying tenant IDs, app/contract names, user emails, spend data, tokens, secrets, or audit payloads.

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
| **Telemetry / analytics** | Does this add analytics/performance tracking? Does it collect customer identifiers or business data? Custom events? Production-facing? Documented in risk + changelog? | telemetry carrying tenant IDs, app/contract names, user emails, spend data, tokens, secrets, or audit payloads; custom `track()` events; used as a product/billing/audit source of truth | platform telemetry only (bare components), no custom events, no PII/customer data; risk + changelog updated (e.g. RISK-013) |
| **Tests/CI** | New auth tests (positive + negative)? CI green? | behavior change with no test | `test-rls.sh` + assertions |
| **Docs/risk/changelog** | Docs updated? Risk register touched? Changelog entry? | code change, no doc change, no justification | `check-docs-updated.sh` pass or valid `.docs-not-needed.md` |

## Example failures (what a block looks like)
- *Cross-tenant:* a SELECT policy `using (true)` on a tenant table → Tenant A reads B. **Block.**
- *Owning-org leak:* a new `paying_org_id` read key added but not added to `enforce_owning_org_tenant` → cross-tenant pointer leak (the exact PR #1 bug). **Block.**
- *Audit mutation:* an "edit log note" feature adding an `UPDATE audit_logs` path. **Block.**
- *Service-role:* importing the service-role Supabase client in a client component. **Block.**

## Connected agent permissions
Reviewing a PR from a connected agent/tool (Claude/Vercel/GitHub/Supabase)? It is allowed to
branch, edit, open PRs, run checks, read status, and create **preview** deployments — nothing
more. Block it if it tries to:
- push to `main`, auto-merge, or bypass/disable CI;
- add/modify secrets or add a service-role key;
- run a **hosted** Supabase migration (outside an explicit deployment-runbook PR);
- change DNS / custom domains or promote a **production** deployment;
- add telemetry/analytics/auth/billing/imports/exports/integrations **without** docs/risk/changelog.

Require before approving an agent PR: completed PR template · docs/risk/changelog updated (or valid
`.docs-not-needed.md`) · CI green · a human reviewer (this is you). Full policy: [09 · Connected
agent permissions](./09_AGENT_HANDOFF.md#connected-agent-permissions); risk: [04 · RISK-014](./04_RISK_REGISTER.md).

## Verdict guide
- **Pass:** no blockers; questions answered; proof present; docs/risk/changelog updated.
- **Changes:** non-blocking gaps (missing test, weak naming, stale doc).
- **Block:** any automatic blocker, or a security claim without a test.
