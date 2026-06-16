# 08 · Code & Docs Standard

**Canonical source for: how we write code and docs.** Combines the engineering style bar
and the living-docs policy. Reviewer enforcement: [07_P0_REVIEW_CHECKLIST](./07_P0_REVIEW_CHECKLIST.md).

## Code standard
**Bias:** boring, deterministic, small. The best code is code not written
(see the [ponytail pass below](#ponytail-pass-before-any-pr)).

- Small, focused modules; explicit inputs/outputs; no god files; no hidden side effects.
- Validate at trust boundaries (Zod on external/user input). Inside the boundary, trust the types.
- **Authorization is RLS, never duplicated in app code.** No permission logic in components.
- No ad-hoc DB access scattered through UI — go through the user-scoped server client / a
  feature service. The service-role key never touches a request path or the client bundle.
- Typed inputs/outputs; failure modes explicit (return/throw deliberately, don't swallow).
- No vague names (`data2`, `helper`, `manager`); names say what and why.
- Comments explain *why*, never lie, and are deleted when stale. A comment that contradicts
  code is a bug.
- Tests live next to risky logic (auth, money, imports, migrations). Every RLS change ships
  a positive **and** a negative assertion.

### Blocks merge (code smells)
- Cross-tenant/authorization handled outside RLS · service-role in client · secret logged ·
  god file / tangled side effects · behavior change with no test · generated-looking code
  merged unread · abstraction with one caller · dead "for later" scaffolding.

### Generated-code review rules
AI/generated code is reviewed like any other: read every line, confirm it matches an actual
need, delete speculative breadth, verify auth/tests. Do not merge code you cannot explain.

### When to abstract (and not)
Abstract on the **third** real duplication, not the first. One implementation ⇒ no
interface/factory. A value that never changes ⇒ a constant, not config. Prefer deleting
code over adding indirection.

## Ponytail pass (before any PR)
Ask, in order: (1) Can we avoid building this? (2) Can it stay manual? (3) Reuse an existing
helper/schema/test? (4) Avoid a new dependency? (5) Avoid a migration? (6) Defer the UI?
(7) Defer the integration? (8) Explicitly reject a premature feature? (9) What is the
smallest safe version that solves the *real* workflow?

**Never simplify away:** tenant isolation · RLS · org access safety · auditability ·
privacy · data-loss prevention · import/export safety · migration discipline · tests ·
docs · production verification · credential safety.

## Docs standard
- **Every important decision is documented** with *why* — not just *what*.
- **Distinguish:** current state vs future plan; verified-fact vs assumption; this uses the
  [status taxonomy](./10_DOCS_INDEX.md#status-taxonomy).
- **Never claim verification without command output.** "Tests pass" requires having run them.
- **One canonical source per fact; link, don't restate.** Duplication goes stale and stale docs are a safety risk.
- **Docs ship in the same PR as the behavior they describe.**

### Verified vs assumed language
- ✅ "`test-rls.sh` passed locally (`ALL ORG-RLS ASSERTIONS PASSED`)" — backed by output.
- ✅ "child tables are `deferred` (tenant-scoped only)" — a marked status.
- ❌ "RLS is fully secure" — unfalsifiable, no scope, no proof.
- ❌ "applied to Supabase" when nothing was applied — false claim.

### Required updates per change (docs-update policy)
| If the PR changes… | Update… |
|---|---|
| a migration / schema | [03_DATABASE_AND_MIGRATIONS](./03_DATABASE_AND_MIGRATIONS.md) (+ [v3-data-model.md](./v3-data-model.md) if schema) |
| security / RLS | [02_SECURITY_AND_RLS](./02_SECURITY_AND_RLS.md) + [07_P0_REVIEW_CHECKLIST](./07_P0_REVIEW_CHECKLIST.md) |
| product scope / status | [00_PRODUCT_STATUS](./00_PRODUCT_STATUS.md) + [06_BUILD_SEQUENCE](./06_BUILD_SEQUENCE.md) |
| architecture / boundaries | [01_ARCHITECTURE](./01_ARCHITECTURE.md) |
| scripts / workflows | [README_START_HERE](../README_START_HERE.md) + relevant doc |
| **risk opened/closed/changed** | [04_RISK_REGISTER](./04_RISK_REGISTER.md) |
| **any PR at all** | [05_ENGINEERING_CHANGELOG](./05_ENGINEERING_CHANGELOG.md) |

`scripts/check-docs-updated.sh` flags the mechanical cases; the rest is reviewer judgment.
If a change genuinely needs no docs, add a [`.docs-not-needed.md`](../.docs-not-needed.template.md)
with the required headings.
