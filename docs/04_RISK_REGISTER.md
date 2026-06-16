# 04 · Risk Register

**Canonical source for: open + closed risks.** Living document — **update this when a risk
is opened, closed, or changes severity** (a PR that changes risk must touch this file).
Severity: P0 (critical) · P1 (high) · P2 (medium) · P3 (low). Status uses the
[taxonomy](./10_DOCS_INDEX.md#status-taxonomy). Only verified state is recorded here.

## Active risks
| ID | Sev | Status | Description / why it matters | Mitigation today | What closes it |
|----|-----|--------|------------------------------|------------------|----------------|
| RISK-001 | P1 | open | **Nothing applied to hosted Supabase.** The RLS model is proven only on a local Postgres + `auth` shim, not Supabase itself; first hosted apply is unproven. | Foundation `verified-local` + `ci-enforced`; hosted apply gated as a separate reviewed step ([03](./03_DATABASE_AND_MIGRATIONS.md)). | A reviewed staging apply + post-apply RLS/schema verification. |
| RISK-002 | P2 | open | **Child tables tenant-scoped, not org-scoped** (`app_users`, `files`, `invoices`, `license_*`, `app_contracts`). No cross-tenant leak, but org-only users may see tenant-wide child rows. | `tenant_id` + RLS on all of them; documented in [02 §8](./02_SECURITY_AND_RLS.md). | Org-scoped policies + tests when a feature reads them per-org. |
| RISK-003 | P2 | open | **`resource_org_links` deferred.** Access is column-based (responsible/paying/procurement); richer multi-org sharing not modeled. | Column union read covers chargeback today ([02 §3](./02_SECURITY_AND_RLS.md)). | A relationship table + migration + tests when sharing outgrows columns. |
| RISK-004 | P3 | open | **Org hierarchy traversal deferred.** `organizations.parent_org_id` exists but parent-org roles don't inherit child visibility. | Flat org membership; acceptable for MVP. | Recursive membership + policy + tests. |
| RISK-005 | P1 | open | **Auth/session not built.** No Supabase Auth wiring; RLS is unused until a user-scoped server client exists. | RLS ready; UI work blocked behind it intentionally ([06](./06_BUILD_SEQUENCE.md)). | Auth/session skeleton PR. |
| RISK-006 | P2 | open | **No product UI.** Only the Next shell; the system is not usable. | Phase 1 is foundation-only by design. | Build-sequence stages 2–9. |
| RISK-007 | P1 | open | **Credential vault not built.** Connectors/credentials are deferred; legacy stored them in plaintext. | No connector code exists; encrypted/service-role boundary reserved ([02](./02_SECURITY_AND_RLS.md), [01](./01_ARCHITECTURE.md)). | Encrypted credential store (Vault/pgsodium) + service-role-only access, before any connector. |
| RISK-008 | P2 | open | **Imports/exports not built.** Legacy did destructive full-replace imports + unscoped exports. | Deferred; rules pre-committed (upsert + soft-delete + audit; tenant-scoped export) in [06](./06_BUILD_SEQUENCE.md). | Import/export PRs that follow those rules + tests. |
| RISK-009 | P2 | open | **Audit retention unresolved.** Deletes are blocked, so `audit_logs` has no purge/archival path and grows unbounded. | Append-only is correct for tamper-evidence ([02 §4](./02_SECURITY_AND_RLS.md)). | A partition/archival design (not row delete). |
| RISK-010 | P1 | open | **Legacy Firebase still production**, including its known P0s (plaintext creds, mutable logs, frontend authz). v3 does not fix the live system. | Tracked in [current-security-risk-map.md](./current-security-risk-map.md). | Legacy P0 patches (separate effort) and/or v3 cutover. |
| RISK-011 | P3 | open | **Generated Supabase types drift** not checked (no typed client yet). | No app data layer exists yet. | A types-generation + drift check when the data layer lands. |

## Closed risks (verified)
| ID | Sev | Closed by | What it was |
|----|-----|-----------|-------------|
| RISK-C01 | P0 | PR #1 (`0002`/`0003`, tests T7/T22+23) | Cross-tenant org-pointer leak — a member could point a resource's owning-org at a foreign-tenant org and that org's members read/edited it. Closed by tenant-bound reads + `enforce_owning_org_tenant`; original exploit replayed and blocked. |
| RISK-C02 | P1 | PR #1 (`0002`, test T16) | Tenant-admin self-promotion to `owner` / owner demotion. Closed by owner/admin membership policy split. |
| RISK-C03 | P1 | PR #2 | RLS regressions could merge unnoticed. Closed by `test-rls.sh` + `rls-tests.yml` (full migration chain + 66 assertions on every PR). |
| RISK-C04 | P2 | PR #3 | Dangerous/disordered migrations could merge. Closed by `check-migration-safety.sh` + `migration-safety.yml`. |
| RISK-C05 | P2 | this PR | Documentation/risk drift invisible to reviewers. Mitigated by `check-docs-updated.sh` + `review-discipline.yml` + this register. |

## How to use
- Opening a risk: add a row to **Active** with a real mitigation and a concrete "what closes it".
- Closing a risk: move it to **Closed** with the PR and the test/mechanism that proves closure — only if actually verified.
- Severity changes: edit in place and note it in [05_ENGINEERING_CHANGELOG.md](./05_ENGINEERING_CHANGELOG.md).
