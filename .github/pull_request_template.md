<!--
ID Caddie v3 PR template. Delete sections that are genuinely N/A, but say *why*.
Canonical review framework: docs/07_P0_REVIEW_CHECKLIST.md · Standards: docs/08_CODE_AND_DOCS_STANDARD.md
-->

## Summary
<!-- What this PR does, in 1–3 sentences. -->

## Why this change exists
<!-- The problem/decision. Link the risk/issue if there is one. -->

## Ponytail simplification pass
<!-- What you did NOT build and why. What stdlib/existing structure you reused instead of adding new code. -->

## Existing structures inspected
<!-- Migrations, helpers, policies, scripts, docs you read before writing. Reuse > reinvention. -->

## Impact (state N/A explicitly where it doesn't apply)
- **Product:**
- **Security:**
- **Tenant isolation / RLS:**
- **Org / resource isolation:**
- **Migration:** <!-- new migration number? append-only? hosted-apply implications? -->
- **Service-role:** <!-- any service-role key use? where? why approved? -->
- **Secrets / credentials:**
- **Import / export:**
- **Destructive operations:**

## Tests run
<!-- Paste real command output, not "should pass". e.g. scripts/test-rls.sh → ALL ORG-RLS ASSERTIONS PASSED -->

## Docs / risk / changelog
- **Docs updated:** <!-- which docs/* files, or .docs-not-needed.md justification -->
- **Risk register (docs/04):** <!-- risk opened/closed/changed, or "no risk change" -->
- **Engineering changelog (docs/05):** <!-- entry added -->

## What I intentionally did NOT change
<!-- Scope boundaries, deferred items, follow-ups. -->

## Reviewer focus areas
<!-- Where you most want eyes. -->

## Rollback / forward-fix plan
<!-- Migrations are append-only → forward-fix. Note the revert/forward path. -->

---

### P0 checklist (docs/07_P0_REVIEW_CHECKLIST.md)
- [ ] I did **not** run against hosted Supabase
- [ ] I did **not** use service-role keys outside approved server/test paths
- [ ] I did **not** rely on frontend filtering for authorization
- [ ] I considered tenant isolation
- [ ] I considered org / resource isolation
- [ ] I considered telemetry/privacy impact if this PR adds analytics, performance tracking, or instrumentation
- [ ] I updated docs, or added a valid `.docs-not-needed.md`
- [ ] I updated the risk register if risk changed
- [ ] I updated the engineering changelog
- [ ] I ran the RLS tests if DB/security was touched
- [ ] I documented risky decisions
