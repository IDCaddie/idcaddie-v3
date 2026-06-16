# 10 · Docs Index

**Canonical source for: where everything is and which doc owns which fact.** Start here if
you don't know where to look. Repo layout: [01_ARCHITECTURE](./01_ARCHITECTURE.md#repo-structure).

## Status taxonomy
Used consistently across all docs. Never blur these.
| Word | Meaning |
|------|---------|
| `planned` | intended, not implemented |
| `implemented` | code/docs exist |
| `verified-local` | tested locally (with command output) |
| `ci-enforced` | enforced by a GitHub Action on PRs |
| `staged` | applied to a hosted **staging** Supabase environment |
| `production-applied` | applied to **production** hosted Supabase |
| `deferred` | deliberately not built yet |
| `blocked` | cannot proceed until a decision/action |
| `deprecated` | old approach kept only for history |
| `legacy-production` | the current Firebase system still serving users |

Today: migrations are `implemented` + `verified-local` + `ci-enforced`, **not** `staged`/
`production-applied`. Firebase is `legacy-production`. v3 UI is `planned`.

## Canonical docs (this set)
| Doc | Canonical for | Reader | Status |
|-----|---------------|--------|--------|
| [00_PRODUCT_STATUS](./00_PRODUCT_STATUS.md) | current status, "can we ship", next PRs, ADR-lite | everyone (read first) | living |
| [01_ARCHITECTURE](./01_ARCHITECTURE.md) | stack, repo structure, server/client boundary | engineers, reviewers | living |
| [02_SECURITY_AND_RLS](./02_SECURITY_AND_RLS.md) | the authorization model + threats→tests | security reviewers | living |
| [03_DATABASE_AND_MIGRATIONS](./03_DATABASE_AND_MIGRATIONS.md) | migration list + DB workflow | DB reviewers, engineers | living |
| [04_RISK_REGISTER](./04_RISK_REGISTER.md) | open + closed risks | reviewers, buyers | living (update on risk change) |
| [05_ENGINEERING_CHANGELOG](./05_ENGINEERING_CHANGELOG.md) | what each PR changed | reviewers | living (every PR) |
| [06_BUILD_SEQUENCE](./06_BUILD_SEQUENCE.md) | build order, what-not-to-build-yet | engineers, agents | living |
| [07_P0_REVIEW_CHECKLIST](./07_P0_REVIEW_CHECKLIST.md) | how to review for P0s | reviewers | stable |
| [08_CODE_AND_DOCS_STANDARD](./08_CODE_AND_DOCS_STANDARD.md) | code + docs bar, ponytail pass, docs-update policy | everyone | stable |
| [09_AGENT_HANDOFF](./09_AGENT_HANDOFF.md) | how an agent continues safely | coding agents | living |
| [10_DOCS_INDEX](./10_DOCS_INDEX.md) | this index + taxonomy | everyone | living |

## Existing docs (reconciled — linked, not duplicated)
| Doc | Canonical for | Note |
|-----|---------------|------|
| [v3-data-model.md](./v3-data-model.md) | **the schema** (tables/columns/relationships) | `02`/`03` link here |
| [migration-workflow.md](./migration-workflow.md) | **the migration process rules** (CI-tied) | `03` links here |
| [migration-checklist.md](./migration-checklist.md) | **the migration PR checklist** template | `03` + PR template link here |
| [v3-security-model.md](./v3-security-model.md) | original security **design rationale** | superseded as the canonical model by `02` |
| [v3-product-scope.md](./v3-product-scope.md) | product scope detail | `00` links here |
| [v3-migration-plan.md](./v3-migration-plan.md) | Firestore→Supabase **data** migration plan | future; `03`/`06` link here |
| [current-product-map.md](./current-product-map.md) | legacy product evidence | history |
| [current-security-risk-map.md](./current-security-risk-map.md) | legacy security evidence (P0s) | history; informs `02`/`04` |

## Reading paths
- **Mike/Jon (status/buyer):** [00](./00_PRODUCT_STATUS.md) → [04](./04_RISK_REGISTER.md) → [05](./05_ENGINEERING_CHANGELOG.md).
- **Security reviewer:** [02](./02_SECURITY_AND_RLS.md) → `supabase/tests/org_rls_test.sql` → [04](./04_RISK_REGISTER.md) → [07](./07_P0_REVIEW_CHECKLIST.md). Legacy: [current-security-risk-map.md](./current-security-risk-map.md).
- **New engineer:** [README_START_HERE](../README_START_HERE.md) → [00](./00_PRODUCT_STATUS.md) → [01](./01_ARCHITECTURE.md) → [03](./03_DATABASE_AND_MIGRATIONS.md) → [06](./06_BUILD_SEQUENCE.md) → [08](./08_CODE_AND_DOCS_STANDARD.md).
- **Coding agent:** [09_AGENT_HANDOFF](./09_AGENT_HANDOFF.md) → [00](./00_PRODUCT_STATUS.md) → [06](./06_BUILD_SEQUENCE.md) → [07](./07_P0_REVIEW_CHECKLIST.md).
- **Database reviewer:** [03](./03_DATABASE_AND_MIGRATIONS.md) → [v3-data-model.md](./v3-data-model.md) → `supabase/migrations/` → [migration-workflow.md](./migration-workflow.md).
