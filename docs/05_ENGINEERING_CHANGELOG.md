# 05 · Engineering Changelog

**Canonical source for: what every PR changed and why.** Engineering/security log — not
product release notes. **Every PR must add an entry** (or justify omission per
[09_DOCS_UPDATE rules in 08](./08_CODE_AND_DOCS_STANDARD.md)). Newest first. Seeded only
from PRs verified via `git log` / `gh pr list`.

---

### PR #4 — Add ID Caddie clean-app operating system · 2026-06-15
- **Category:** docs / process / CI.
- **What:** Canonical doc set `docs/00`–`10`, true-entry `README_START_HERE.md`, PR template,
  `scripts/check-docs-updated.sh` + `pr-review-summary.sh`, `.docs-not-needed.template.md`,
  `.github/workflows/review-discipline.yml`. Reconciled (linked, not duplicated) the existing
  design/legacy/migration docs.
- **Why:** make the repo self-explaining, self-checking, and not dependent on Sam's memory.
- **Security impact:** none to runtime; adds a P0 review framework ([07](./07_P0_REVIEW_CHECKLIST.md)) and docs-drift CI.
- **Tests run:** `check-migration-safety.sh` (+selftest), `check-docs-updated.sh`,
  `pr-review-summary.sh`, `test-rls.sh`. *(See PR body / local-check output for results.)*
- **Docs updated:** this whole PR is docs/process.
- **Follow-ups:** none blocking; future PRs must keep [04](./04_RISK_REGISTER.md) and this file current.

---

### PR #3 — Document Supabase migration discipline · `ee59c6c`
- **Category:** docs / CI.
- **What:** `docs/migration-workflow.md`, `docs/migration-checklist.md`,
  `scripts/check-migration-safety.sh` (with `selftest`), `.github/workflows/migration-safety.yml`,
  README dev-workflow section.
- **Why:** prevent skipping local migration tests, mutating merged migrations, or pushing to hosted Supabase too early.
- **Security impact:** indirect — flags unsafe migration patterns; no RLS change.
- **Tests run:** safety selftest 6/6; real migrations pass; `test-rls.sh` green.
- **Docs updated:** migration workflow + checklist + README.
- **Follow-ups:** closed RISK-C04.

---

### PR #2 — Add repeatable RLS migration test runner · `bfffb84`
- **Category:** CI / tests.
- **What:** `scripts/test-rls.sh` (throwaway Postgres + Supabase-style `auth` shim, applies all
  migrations, runs `*_test.sql` with `ON_ERROR_STOP=1`, cleans up on failure) + `.github/workflows/rls-tests.yml`.
- **Why:** make RLS regressions impossible to merge unnoticed; one path local + CI.
- **Security impact:** makes the RLS guarantees continuously verified.
- **Tests run:** full suite passed (`ALL ORG-RLS ASSERTIONS PASSED`); negative check exits non-zero.
- **Docs updated:** README + `rls_test_plan.md`.
- **Follow-ups:** closed RISK-C03.

---

### PR #1 — Add org-scoped RLS foundation and adversarial tests · `f7c5c75`
- **Category:** database / security.
- **What:** `0002_org_scoped_rls.sql` (org helpers, steward writes, audit append-only trigger,
  `enforce_owning_org_tenant`, admin self-promotion fix) and `0003_org_access_union.sql`
  (related-org read model); `supabase/tests/org_rls_test.sql` (66 assertions, T1–T23).
- **Why:** enforce org_manager/org_viewer in Postgres and serve chargeback reads without
  over-granting writes.
- **Security impact:** large — tenant isolation + org scoping + audit immutability now enforced.
  Closed two live-verified bugs.
- **Tests run:** all assertions pass; cross-tenant exploit replayed and blocked.
- **Docs updated:** `v3-data-model.md`, `v3-security-model.md`, `rls_test_plan.md`.
- **Follow-ups:** closed RISK-C01, RISK-C02; opened the deferred items now tracked in [04](./04_RISK_REGISTER.md).

---

*Pre-PR history (legacy extraction docs, rebuild starter, `0001` core schema) is in
`git log` and the `docs/current-*` / `docs/v3-*` design docs.*
