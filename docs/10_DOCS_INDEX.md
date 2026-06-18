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

Today: migrations (`0001`–`0013`) are `implemented` + `verified-local` + `ci-enforced`, and now **`staged`**
(applied to the **staging** Supabase project `ycdpzduxugdsffjqyoai` — PR #47/#48; Storage object policies +
verification still pending, [04 · RISK-001](./04_RISK_REGISTER.md)), but **not** `production-applied`. The
auth/session skeleton is `implemented` (not hosted-exercised). Firebase is
`legacy-production`. v3 has **read-only** product UI `implemented` (apps inventory + detail, contracts
list + detail, linked app↔contract panels, app-user roster + match status, account summary — PRs
#13/#14/#19/#20/#21/#23/#24) **plus the first write surface — contract create/edit** (`/contracts/new`,
`/contracts/[id]/edit` — PR #31, RLS-gated, audited, **Partial** legacy parity); **other write UI, hosted
apply, UAR, imports/exports are `planned`/`deferred`**.

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
| [11_LEGACY_PARITY_AND_OMC_CHECKLIST](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md) | legacy→v3 capability parity + OMC cutover go/no-go | product owner, buyers (Mike/Jon) | living (every parity PR) |
| [12_IDENTITY_MATCHING_READ_SCOPE](./12_IDENTITY_MATCHING_READ_SCOPE.md) | **design** for safely reading identity/account/matching data | security reviewers, future implementer | design (match-status slice built PR #23) |
| [13_CONTRACT_STEWARD_WRITE_DESIGN](./13_CONTRACT_STEWARD_WRITE_DESIGN.md) | contract write design + guardrails (RLS authority `0004`; **audit `0010` (#29) + write path (#30) + create/edit UI (#31)** all built; legacy parity **Partial**) | security reviewers, implementers | living |
| [14_LEGACY_UX_WORKFLOW_PARITY_MAP](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md) | the **legacy→v3 parity contract** ("same product, better backend") + the per-workflow cutover gate | product owner, reviewers, implementers | living (update every parity-bound PR) |
| [15_LEGACY_CONTRACT_FORM_INSPECTION](./15_LEGACY_CONTRACT_FORM_INSPECTION.md) | **inspection note** — the legacy contract create/edit workflow + exact field mapping + not-ported anti-patterns (evidence for PR #31's Partial parity) | reviewers, future implementer | reference |
| [16_CONTRACT_PDF_AI_EXTRACTION_DESIGN](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) | **design + security plan** — contract PDF upload + AI extraction: trust boundaries, tenant-bound Storage + signed URLs, `files` schema/RLS (`0012`/`0013` built), **server-side PDF validation + storage-path helpers (`src/lib/files/pdf-validation.ts`, PR #40 built)**, AI suggestions-not-autosave, legacy anti-patterns not ported. Bucket/upload/AI/UI still NOT built | security reviewers, implementer | design + partial build (update when more built) |
| [17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) | **the binding go/no-go cutover gate** — replacing the live OMC/Flywheel production app with v3 (NOT a pilot): status taxonomy, hard blockers, the ~105-row grounded replacement parity matrix, the go/no-go checklist, approved-difference process, next-PR sequence, honest ~70–110-PR estimate, OMC-confirmation list. **If 11/14 and 17 disagree on cutover-readiness, 17 wins.** | product/cutover owner, buyers (Mike/Jon), agents | living (every parity PR) |
| [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md) | **the working confirmation process that feeds doc 17** — questionnaire + workshop agenda + workflow confirmation table + evidence checklist + decision log to resolve doc 17's `probably`/`unknown` rows from OMC evidence. **Feeds 17; does not replace it; running it does not make v3 ready. No secret/token collection.** | product/cutover owner, ID Caddie + OMC owners | working doc (fill during the pass) |
| [19_CONNECTOR_CREDENTIAL_VAULT_DESIGN](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md) | **design + security plan** — the safe future path for connector credentials (Okta/Google/Entra/Slack/SCIM/scrapers/inbound-API): threat model, design-only data model, vault-handle secret storage (never the secret, never to client/logs/types), key management, authorization (related-org/payor get no credential authority), server-only OAuth, non-destructive sync, RLS/test plan, redaction rules. **DESIGN-ONLY — does NOT close RISK-007; no secrets collected.** | security reviewers, future implementer | design (update when built) |
| [20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md) | **operational discipline / runbook-of-record** — moving v3 from local-only to hosted staging → production replacement: environment model, branch/PR discipline, hosted-apply rules (staging-first, verify, never dirty/duplicate/type-drift/prod-first), secrets discipline, Vercel discipline, the ten before/after verification checklists, stop/rollback rules. **DISCIPLINE-ONLY — nothing applied/deployed; does NOT close RISK-001; gates *how* an apply happens, never authorizes one.** | ops/release owner, agents, reviewers | living (runbook) |
| [21_STORAGE_LOCAL_HARNESS_FEASIBILITY](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md) | **feasibility spike (PR #41)** — can Supabase Storage object-RLS be tested locally? **Verdict: NO** (empirically proven: the plain-`postgres:16` harness has no `storage` schema; a storage-policy migration breaks `test-rls.sh`/`gen-types`; SQL-only ≠ storage-api enforcement). No fake shim. **Storage object-RLS is verified in HOSTED STAGING (doc 20)** — includes the concrete hosted-staging bucket/object-policy verification checklist. | storage implementer, reviewers | spike findings + checklist |
| [22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md) | **staging apply runbook (PR #42)** — the exact reviewed, human-executed STAGING steps to create the private `contract-files` bucket + object policies and verify them via the doc 21 §6 checklist. Bucket spec, staged apply sequence (clean main → staging-only → list-first → apply bucket/policies only → verify → Storage API verification → stop before prod), illustrative policy shape, stop/rollback. **RUNBOOK ONLY — nothing applied/created; gates the future upload action; does NOT close RISK-001.** | ops/release executor, reviewers | runbook (execute in staging later) |
| [23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md) | **evidence template (PR #43)** — the fill-in record a human captures WHILE executing doc 22 in staging: execution metadata, pre-apply checklist, redacted apply evidence (no runnable mutating commands), the doc 21 §6 verification reproduced as 20 rows with result/evidence/**reviewer initials**/notes, failure log, rollback, and a final staging signoff. **TEMPLATE ONLY — NOTHING APPLIED; does NOT close RISK-001 or authorize cutover; no secrets.** | ops/release executor + independent reviewer | template (fill in during a staging execution) |
| [24_STAGING_ENVIRONMENT_VARIABLES_AND_WIRING_CHECKLIST](./24_STAGING_ENVIRONMENT_VARIABLES_AND_WIRING_CHECKLIST.md) | **env-var inventory + wiring checklist (PR #44)** — exactly which env vars to set in Vercel + Supabase **staging** (names + classifications only, **no values**) before any hosted staging execution, + the Vercel/Supabase wiring checklists + a no-values evidence template. v3 uses two **public** vars (`NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY`); service-role is **deferred** (never browser/`NEXT_PUBLIC_`); connector/vault vars **BLOCKED (RISK-007)**. **DOCS-ONLY — configures nothing; no secrets; does NOT close RISK-001; cutover blocked.** | ops/release executor + reviewer | inventory/checklist (configure in staging later) |
| [25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md) | **dated staging-apply evidence (PR #47/#48/#52, 2026-06-17)** — §0/§0.2: a **human applied migrations `0001`–`0014` to staging `ycdpzduxugdsffjqyoai`, created the private `contract-files` bucket** (`public=false`, 25 MiB, `application/pdf`), and **applied the `storage.objects` object policies** (2 `authenticated` INSERT/SELECT, 0 unsafe — **structural verification passed**); **real Storage REST API authz verification PENDING; production NOT touched.** §1–§6: the PR #47 agent session (correctly did NOT execute). **No upload/UI/AI built; RISK-001 stays OPEN; cutover blocked; no secrets.** | ops/release owner | evidence (real REST authz verification still pending) |
| [26_STORAGE_REST_VERIFICATION_RUNBOOK](./26_STORAGE_REST_VERIFICATION_RUNBOOK.md) | **Storage REST verification runbook (PR #53, 2026-06-17)** — how to run `scripts/verify-staging-storage-rest.mjs`, the staging-only **user-scoped** (anon-key-only, **no service-role**) verifier that proves the `contract-files` object policies through the **real Storage REST API** (15 obligations). Local env-var names (no values), the one-time admin fixture setup, the evidence template. **Verifier RUN green in hosted staging 2026-06-18 → real REST authz verification PASSED (14/14, [25 §0.3](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md)); user-scoped JWTs, no service-role, no production touched; refuses unless linked+URL = staging `ycdpzduxugdsffjqyoai`; RISK-001 stays OPEN (production apply + cutover pending); cutover blocked; no secrets.** | ops/release executor + reviewer | runbook (verifier run; staging passed) |
| [27_LEGACY_OMC_FULL_PARITY_MATRIX](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) | **full OMC replacement parity matrix (PR #54)** — the row-level parity ledger under the [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) gate: 16 tracks (routes/screens, workflows, fields, lists, dashboard/metrics, reporting, imports/connectors, files/Storage, AI, auth/roles, admin/settings, audit, billing/revenue, data migration, UX, operations) with status/blocker/evidence per row. **Full legacy parity required by default**; a missing route/workflow/field/report/import/setting/billing/migration item is an **OMC blocker** unless `deprecated-approved`; unknown legacy = `blocked-unknown-legacy-behavior` (never done). **Control doc only — implements nothing, proves no parity, does NOT close RISK-001 or authorize cutover. v3 is NOT OMC-ready.** Future feature PRs must cite the rows they close. | OMC owner + reviewer | parity tracker (mostly missing/blocked) |

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
- **Mike/Jon (status/buyer):** [00](./00_PRODUCT_STATUS.md) → [17 OMC replacement gate](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) → [11 parity scorecard](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md) → [04](./04_RISK_REGISTER.md) → [05](./05_ENGINEERING_CHANGELOG.md).
- **Product / cutover owner:** [17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) (the go/no-go gate) → [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md) (run this to fill the gate) → [11_LEGACY_PARITY_AND_OMC_CHECKLIST](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md) → [14_LEGACY_UX_WORKFLOW_PARITY_MAP](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md) → [current-product-map.md](./current-product-map.md) → [06](./06_BUILD_SEQUENCE.md).
- **Security reviewer:** [02](./02_SECURITY_AND_RLS.md) → `supabase/tests/org_rls_test.sql` → [04](./04_RISK_REGISTER.md) → [07](./07_P0_REVIEW_CHECKLIST.md). Legacy: [current-security-risk-map.md](./current-security-risk-map.md).
- **New engineer:** [README_START_HERE](../README_START_HERE.md) → [00](./00_PRODUCT_STATUS.md) → [01](./01_ARCHITECTURE.md) → [03](./03_DATABASE_AND_MIGRATIONS.md) → [06](./06_BUILD_SEQUENCE.md) → [08](./08_CODE_AND_DOCS_STANDARD.md).
- **Coding agent:** [09_AGENT_HANDOFF](./09_AGENT_HANDOFF.md) → [00](./00_PRODUCT_STATUS.md) → [06](./06_BUILD_SEQUENCE.md) → [07](./07_P0_REVIEW_CHECKLIST.md).
- **Database reviewer:** [03](./03_DATABASE_AND_MIGRATIONS.md) → [v3-data-model.md](./v3-data-model.md) → `supabase/migrations/` → [migration-workflow.md](./migration-workflow.md).
