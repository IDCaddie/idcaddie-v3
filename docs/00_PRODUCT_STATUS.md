# 00 · Product Status — ID Caddie v3

**Canonical source for: current status.** First doc to read. Last verified against the
repo on 2026-06-17 (PRs through #51 merged — the contract-file Storage paper trail + the staging env-var inventory; the staging hosted apply is now **partial**: migrations `0001`–`0014` + the private `contract-files` bucket (`public=false`, 25 MiB, `application/pdf`) + the `storage.objects` **object policies are applied to the STAGING project `ycdpzduxugdsffjqyoai`** (2 `authenticated` INSERT/SELECT, 0 unsafe — **structural verification passed**) — [25 §0/§0.2](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md); #52/#55 record the staging apply+verification, **#58 records the human-executed PRODUCTION apply + verification PASSED 14/14, and #59 records the production synthetic cleanup (counts 0; 2 tenant + 3 append-only audit anchors retained)** on `dzbfxulvxchdemcettrx` ([29_PRODUCTION_STORAGE_APPLY_EVIDENCE](./29_PRODUCTION_STORAGE_APPLY_EVIDENCE.md); real REST calls, user-scoped JWTs, no service-role; a discovered `public.files` grant codified as migration `0015`). **No upload route/action/UI, signed URLs, AI, or OCR built; upload is NOT automatically production-ready.** **RISK-001 stays OPEN** — closure criteria (1)–(4) met, but **(5) the doc 17 §5 cutover checklist is NOT met**, so cutover stays BLOCKED. RLS now 222; tests 67/67; `files` still not surfaced; cutover stays BLOCKED; RISK-001/002/007/016 open). **OMC is a paying production-replacement customer, NOT a pilot.** **v3 is NOT OMC replacement-ready; the master line-item parity tracker is [27_LEGACY_OMC_FULL_PARITY_MATRIX](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) (full legacy parity required by default — most rows missing/blocked).** Status words are defined in [10_DOCS_INDEX](./10_DOCS_INDEX.md#status-taxonomy).

## What ID Caddie v3 is
An enterprise SaaS-governance platform: the source of truth for *what apps a company
uses, who owns/pays/renews each, which contract governs it, who has access, which
paid users are stale or unmanaged, and which costs charge back to which org/agency*.
Target customer: Omnicom/Flywheel (a holding company with many agencies). Product
scope detail: [v3-product-scope.md](./v3-product-scope.md).

## Why v3 exists (not a Firebase port)
The legacy Firebase/Firestore app is `legacy-production` and still serves users, but
its authorization was structurally unsafe: direct client→Firestore access, frontend
filtering as "security", duplicated permission documents, plaintext integration
credentials, mutable audit logs, and per-project (not per-row) tenant isolation.
Evidence: [current-security-risk-map.md](./current-security-risk-map.md),
[current-product-map.md](./current-product-map.md). v3 rebuilds the data + security
foundation on Postgres with RLS as the authorization source of truth. We **preserve
validated workflows, port no Firebase code**.

## Parity doctrine — same product, better backend (OMC = production replacement, not a pilot)
v3 is a **same-product-experience / better-backend replacement**, not a redesign. **OMC/Flywheel is a
paying production customer (~$3.5k/mo); v3 must REPLACE the live app with no missing/broken workflows —
this is not a pilot and not "pilot-ready."** Users must feel *"this is the same ID Caddie I know."* The
backend improves (real tenant isolation, RLS, append-only audit, non-destructive imports, same-tenant
integrity, no hard deletes, better auth/session, safer exports, cleaner schema), but the **user-facing
workflow preserves legacy behavior unless a difference is intentionally approved**. Improvements come
**after** replacement, via version-controlled planned rollouts. The per-workflow parity contract +
doctrine live in [14_LEGACY_UX_WORKFLOW_PARITY_MAP](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md); the binding
**go/no-go cutover gate** is [17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)
(if 11/14 and 17 disagree on readiness, 17 wins): **cutover is blocked on workflow parity, not on
backend/RLS readiness alone.**

## Current phase
**Read-only governance foundation + first contract WRITE workflow.** The secure data/RLS foundation,
the auth/session skeleton, and read-only tenant/org context resolution are complete, a set of
**read-only product surfaces** ship on top of them, and the **first user-visible write workflow** —
contract create/edit — now exists (RLS-gated, audited):
- `/apps` inventory (PR #13) and `/apps/[id]` app detail (PR #14)
- `/contracts` list and `/contracts/[id]` detail (PR #19)
- linked app↔contract panels on detail pages (PR #20)
- `/apps/[id]` app-user roster (PR #21), match-status column (PR #23), and account-summary card (PR #24)
- **`/contracts/new` + `/contracts/[id]/edit` contract create/edit (PR #31 — first write UI; Partial parity)**

**Built (contract write workflow):** the contract **write path** — server-side DAL
(`createContractForCurrentUser`/`updateContractForCurrentUser`) + `"use server"` actions (PR #30) on the
**user-scoped anon client**, gated by the existing RLS, `tenant_id` resolved server-side, audit inherited
from `0010` (PR #29's DB-side `SECURITY DEFINER` `AFTER INSERT/UPDATE` trigger, actor = `auth.uid()`) — and
now the **create/edit UI** (PR #31): `/contracts/new` + `/contracts/[id]/edit`, posting to those actions.
**Partial** legacy parity — supported v3 columns only ([15](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)).

**Design + schema/RLS foundation (no user-facing surface):** identity matching read-scope ([12](./12_IDENTITY_MATCHING_READ_SCOPE.md),
PR #22 — only the match-*status* slice is built); **contract PDF upload + AI extraction** ([16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md),
PR #33 design + PR #34 `files` metadata foundation (`0012`) + PR #35 **`files` RLS policies** (`0013` — tenant-member SELECT + contract-write-authority INSERT [tenant editor+ OR procurement-org manager; `paying_org` grants no write; `uploaded_by`=caller], **no UPDATE/DELETE/FOR ALL**): `files` now has a **tested read+write authorization model** but is **still NOT surfaced** — no Storage bucket, upload UI/route, signed URLs, scan/AI worker, file preview, or app DAL touches `files`.

**Not built:** anything applied to a **hosted Supabase environment**; the legacy contract fields v3 still has no
column/surface for (`commodity_*` [hidden in legacy], `validated` [read-only], **gantt**) and **PDF-upload/AI-extraction**
(**DESIGNED — PR #33 / [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md); `files` metadata `0012` (#34) + RLS policies `0013` (#35) added — but NO upload/Storage/signed-URL/scan/AI/UI surface, and no app DAL touches `files`**) — so contract parity is **Partial**, not Same, even after PR #32 added `category`/`procurement_date`/`notes`/
`po_number`/`auto_renew`/`month_to_month`; contract **delete**/archive / soft-delete; `app_contracts` writes (link/unlink); UAR / unmanaged-account report; identity matching *algorithm*;
`people` org-read (stays tenant-only); `identity_accounts` read (default-deny); license rules/evaluation;
spend/chargeback; files/invoices; people directory; provisioning; tenant switching; imports/exports;
connectors. **OMC/Flywheel cutover and new paid-customer onboarding remain blocked** — the full blocker list + the ~105-row replacement parity matrix are in [17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md). **v3 is NOT production-replacement-ready;** a grounded legacy inspection (PR #36) puts full parity at **~70–110 PRs** from current state (pending OMC-confirmation of actual usage).

## Merged PRs
**PRs #1–#76 are merged** (main @ `ff32f75`); **PR #77 (record contract-file attachment staging verification — docs-only evidence (doc 41 §11): a human manually verified the PR #76 E09a contract-file attachment UI on staging `https://idcaddie-v3.vercel.app` for the **Tenant A happy path** (synthetic `tenant-editor-a@idcaddie-staging.local`, contract `cccca111-…a1`) — contract detail loaded, attachment section rendered, PDF upload worked, file listed, Open available; no `storage_path`/signed-URL text exposed. **Recorded honestly: multiple synthetic-test.pdf `pending` rows visible from repeated test uploads (no UPDATE/DELETE on the request path; no cleanup performed — a future worker reconciles).** Verifies only the Tenant A attachment happy path on staging — not parity/AI/invoices/connectors. **Invoices remain not built; PDF/AI extraction remains not built; Old-app/UI-UX/AI-API-connector parity NOT complete; Storage authorization remains necessary but not sufficient for cutover; hosted Auth/tenant-context verified but old-app replacement not yet verified; upload not production-ready; no doc 17 box ticked; RISK-001 stays OPEN; cutover BLOCKED**) is this PR.** The full
per-PR engineering log is the canonical source — see [05_ENGINEERING_CHANGELOG](./05_ENGINEERING_CHANGELOG.md);
do not maintain a second PR table here (it drifts). Milestone summary:
- **Foundation / discipline:** RLS foundation + tests (#1/#2), migration discipline (#3), clean-app
  operating system + docs/CI (#4), app CI (#15).
- **Auth + data layer:** auth/session skeleton (#6), tenant/org context (#9), demo fixture (#10), typed read-only DAL (#11).
- **Security hardening (migrations):** destructive-delete hardening `0004` (#16), same-tenant integrity `0005` (#17),
  child-table read truth-pass (#18), org-scoped reads `0006`/`0007`/`0008` for app_contracts/app_users/app_user_identity_matches (#20/#21/#23),
  `app_contracts` read tenant-bind `0009` (#27), contract **audit-on-write** `0010` (#29).
- **Read-only surfaces:** app inventory (#13), app detail (#14), contracts list+detail (#19), linked panels (#20),
  app-user roster (#21), match status (#23), account summary (#24).
- **Contract writes:** write server actions + DAL (#30, backend, RLS-gated, audit inherited from `0010`); **create/edit UI** `/contracts/new` + `/contracts/[id]/edit` (#31 — first write workflow); **parity fields** category/procurement_date/notes/po_number/auto_renew/month_to_month (#32 — `0011`). **Partial** legacy parity throughout.
- **Design / parity docs (nothing user-facing built):** identity matching read-scope (#22), contract steward write design (#25), docs truth pass (#26), legacy UX/workflow parity map (#28), legacy contract-form inspection (#31 — [15](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)), contract PDF/AI extraction design (#33 — [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)).
- **Schema + RLS foundation (no surface):** `files` metadata foundation (#34 — `0012`; columns + same-tenant FK + CHECKs) + `files` RLS policies (#35 — `0013`; tenant-member SELECT + contract-write-authority INSERT, no UPDATE/DELETE/FOR ALL). Authorized-by-design + tested; `files` still **not surfaced** in the app.
- **Contract-file validation foundation (no surface):** server-side PDF validation + server-derived tenant-bound storage-path helpers (#40 — `src/lib/files/pdf-validation.ts`; bucket `contract-files`; 16 unit tests). Pure lib only — **no bucket created, no upload action/UI/route, no signed URLs, no AI**; `files` still **not surfaced**.
- **Storage local-test feasibility (docs):** the Storage bucket + object-RLS **cannot be faithfully tested locally** (#41 — [21](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md); empirically proven — no `storage` schema in the plain-`postgres:16` harness; SQL-only ≠ storage-api enforcement). No fake shim. **Verified in hosted staging (doc 20)** before any upload action ships.
- **Storage bucket apply runbook (docs):** the exact reviewed, human-executed **staging** apply + verification steps for the private `contract-files` bucket + object policies (#42 — [22](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md); runbook only — nothing applied/created). Gates the future upload action; executes the doc 21 §6 checklist; stops before production.
- **Storage staging apply evidence template (docs):** the fill-in record a human captures while executing doc 22 in staging (#43 — [23](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md); template only — nothing applied). 20 reviewer-signed verification rows + metadata + failure log + rollback + signoff; no secrets; does not close RISK-001 or authorize cutover.
- **Staging env-var inventory & wiring checklist (docs):** exactly which env vars to set in Vercel + Supabase staging before a hosted staging execution (#44 — [24](./24_STAGING_ENVIRONMENT_VARIABLES_AND_WIRING_CHECKLIST.md); names + classifications only, no values, no hosted/Vercel mutation). Two public Supabase vars; service-role deferred (never browser); connector/vault vars blocked (RISK-007). Does not close RISK-001; cutover blocked.
- **Replacement governance (docs):** OMC production replacement parity gate (#36 — [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md); the binding go/no-go gate, grounded ~105-row matrix, honest ~70–110-PR estimate; OMC = production replacement, not a pilot) + OMC confirmation pass scaffolding (#37 — [18](./18_OMC_CONFIRMATION_PASS.md); the working questionnaire/workshop/decision-log that feeds doc 17; no secrets collected).
- **Security design (docs):** connector credential vault design (#38 — [19](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md); the safe future path for connector secrets — vault handle + redacted metadata, no service-role on request paths, related-org/payor get no credential authority, non-destructive sync). **Design only — no vault/connector/encryption/secret implemented; RISK-007 stays open.**
- **Operational discipline (docs):** staging + hosted apply & cutover discipline (#39 — [20](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md); the runbook for hosted staging/apply/Vercel/cutover — staging-first, verify-after-apply, per-env secrets, stop/rollback rules, 10 verification checklists). **Discipline only — nothing applied/deployed; no staging/prod/secrets created; RISK-001 stays open.**

Migration `0001` (core schema) predates the numbered PRs (rebuild starter pack).

## Status of the foundation
| Item | Status |
|------|--------|
| Migrations `0001`–`0014` (core schema, org RLS, related-org read, delete hardening, child integrity, org-scoped child reads + tenant-bind hardening, contract audit-on-write, contract form parity fields, files metadata foundation, files RLS policies, contract-file Storage auth helpers) | `implemented`, `verified-local`, `ci-enforced`; **`staged`** (`0001`–`0014` applied to staging `ycdpzduxugdsffjqyoai` — PR #47/#48 + #52); **not** `production-applied` |
| RLS model (tenant isolation, steward writes, related-org reads, audit immutability, no admin self-promotion, files read+write authority) | `implemented`, `verified-local` (222 assertions in `org_rls_test.sql`), `ci-enforced` (PR #2) |
| Contract **audit-on-write** (DB-side `SECURITY DEFINER` `AFTER INSERT/UPDATE` trigger → append-only `audit_logs`, actor = `auth.uid()`) | `implemented` (PR #29 — `0010`); `verified-local` (T31/T32: allowed writes audit once with the correct actor; denied/failed writes never audit; no direct `authenticated` audit insert; contracts keep 0 DELETE / 0 FOR ALL). Invisible backend; the write **path** (PR #30) and **create/edit UI** (PR #31) now exist and inherit this audit |
| No normal hard-delete of core evidence tables (`organizations`/`apps`/`contracts`/`app_contracts`/`people`/`app_users`) | `implemented` (PR #16 — `0004`; `FOR ALL` split into `INSERT`+`UPDATE`, no `DELETE`); `verified-local` (T17/T24/T25). Archive/soft-delete UI **not built** |
| Same-tenant child integrity (cross-tenant child/link writes fail at the DB) | `implemented` (PR #17 — `0005`; composite `(parent_ref, tenant_id)` FKs); `verified-local` (T26). Org-scoped child-table **reads** still deferred (RISK-002) |
| Migration safety (numbering, unsafe keywords) | `ci-enforced` (PR #3) |
| Migrations applied to hosted Supabase (staging/prod) | **staging done + verified** (`0001`–`0014` `staged` to `ycdpzduxugdsffjqyoai`; private `contract-files` bucket + `storage.objects` object policies applied; **real Storage REST API authz verification PASSED in staging 14/14** — [25 §0.3](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md)); **production not done**. RISK-001 OPEN (production apply + cutover checklist pending — [04](./04_RISK_REGISTER.md)) |
| Auth/session skeleton (login, server session via Proxy, protected route group, no service-role) | `implemented` (PR #6); `verified-local` (build + `check-auth-safety.sh`); **not** exercised against hosted Supabase Auth |
| Tenant/org context resolution (read-only; memberships → active tenant + org list, RLS-scoped) | `implemented` (PR #9); `verified-local` (build + unit tests); **not** exercised against hosted Supabase |
| Tenant switching UI / user provisioning / invites | `planned` (not built; deterministic first tenant chosen — RISK-012) |
| Local/demo data fixture (synthetic; never hosted-applied) | `implemented` (PR #10 — `supabase/fixtures/local_demo.sql` via `scripts/seed-local-demo.sh`); local-only |
| Typed DB types + read-only data access layer (server-only) | `implemented` (PR #11 — generated `database.types.ts`, typed server client, `src/lib/data/apps.ts`); `verified-local` (typed build) |
| Read-only app inventory screen (`/apps`) | `implemented` (PR #13 — first product surface, server-rendered, typed DAL, RLS-scoped); `verified-local` (build + RLS query: owner sees all tenant apps, org-only user sees only related, non-member sees none) |
| Read-only app detail screen (`/apps/[id]`) | `implemented` (PR #14 — server-rendered, typed DAL, route id is lookup-only not authz); `verified-local` (RLS query: owner reads all 3 details, org-only reads only its 2 related, unrelated/non-member → not_found) |
| Read-only contracts list + detail (`/contracts`, `/contracts/[id]`) | **`partial` — read-only only** (PR #19 — server-rendered, typed DAL `src/lib/data/contracts.ts`, route id lookup-only, related-org RLS). Direct `contracts` columns; **linked apps now shown read-only (PR #20)**; invoices/files still NOT shown (default-deny — RISK-002). No create/edit/delete/import/export. `verified-local` (RLS spot-check: owner sees both tenant contracts; related-org user sees only its related; unrelated org-only + non-member → not_found) |
| Read-only linked apps ↔ contracts panels (`/contracts/[id]`, `/apps/[id]`) | **`partial` — read-only only** (PR #20 — `0006` org-scoped `SELECT` on `app_contracts`, typed DAL `src/lib/data/links.ts`). Shows only links to apps/contracts the user may read; **no linking/unlinking/editing**. `verified-local` (T28 + spot-check: org-only users see only related links; cross-tenant + non-member → none) |
| App CI (lint · vitest · `tsc --noEmit` · `next build`) + deterministic build (system fonts, no remote font fetch) | `implemented` + `ci-enforced` (PR #15 — `.github/workflows/app-ci.yml`); metadata/README hygiene fixed |
| Invoices · files · license surfaces · app-contract linking *writes* · contract **delete/archive** | `deferred` (default-deny tables or write surfaces — not built; RISK-002 open for reads). Contract create/edit **UI** shipped PR #31 (see the "Contract **write**" row below); delete/archive, links, files stay deferred |
| Product **write** workflows | **first write workflow shipped** — contract create/edit UI (PR #31, Partial parity); people directory / reports / imports / exports still `planned`/`deferred`. Other product surfaces (apps, app detail, linked panels, app-user roster, match status, account summary) remain **read-only** |
| Read-only app-user roster (`/apps/[id]` "App users") | **`partial` — read-only only** (PR #21 — `0007` org-scoped `SELECT` on `app_users`, typed DAL `src/lib/data/app-users.ts`). Direct `app_users` columns only; org-only users see only users of apps they may read. **No** matching/provisioning/utilization/edit. `verified-local` (T29 + spot-check: org-only users see only related apps' users; cross-tenant + non-member → none) |
| Child-table read scope (canonical map: [02 §8](./02_SECURITY_AND_RLS.md), pinned by T27/T28/T29/T30) | `partial` — `app_contracts` (`0006`) + `app_users` (`0007`) + `app_user_identity_matches` (`0008`) now **org-scoped read**; **tenant-only** (`people`) + **default-deny** (`identity_accounts`/`license_*`/`files`/`invoices`) remain; org-only users read none of those. Org-scoped reads for the rest still `deferred` (RISK-002, narrowed not closed) |
| Read-only app-user **match status** (`/apps/[id]` "Match" column) | **`partial` — read-only status only** (PR #23 — `0008` org-scoped `SELECT` on `app_user_identity_matches`, typed DAL `src/lib/data/app-user-matches.ts`). Shows matched/unmatched (+ optional method/confidence) for app_users you may read; **no `person_id`, no person name, no identity-account details, no PII**. `verified-local` (T30 + spot-check). **No matching algorithm / merge / UAR / orphaned status / provisioning.** `people` tenant-only + `identity_accounts` default-deny (unchanged). RISK-002 + RISK-016 open |
| Read-only **account summary** (`/apps/[id]` "Account summary" card) | **`partial` — read-only, derived** (PR #24 — pure helper `src/lib/data/app-account-intelligence.ts`, unit-tested). Counts from **visible `app_users` + visible matches only**: visible/matched/unmatched/match-rate, status breakdown, stale candidates (>90d). **No migration / RLS change.** **NOT UAR** — no `people`/`identity_accounts`/license/files/invoices/PII; no orphaned/deactivated/managed label, no matching algorithm, no provisioning. RISK-002 + RISK-016 open |
| Contract **write** (create/edit) | **`partial` — backend path + create/edit UI + parity fields built; Partial legacy parity.** Write **RLS authority** (`0002`/`0004`) + **audit-on-write** (`0010`, PR #29) + **server-side write path** (PR #30 — DAL + `"use server"` actions, anon client, `tenant_id` server-resolved, audit inherited) + **create/edit UI** (PR #31 — `/contracts/new` + `/contracts/[id]/edit`; RLS is the boundary, not client-side role checks; denied save → generic, no enumeration) + **parity fields** (PR #32 — `0011` adds `category`/`procurement_date`/`notes`/`po_number`/`auto_renew`/`month_to_month`). `verified-local` (`contract-write.test.ts` 28 + `contract-form-shared.test.ts` 11 + RLS T9/T14/T20/T21/T31/T32; no new SQL — RLS unchanged by that PR). **Still Partial parity** — legacy `commodity_*` (hidden) + `validated` (read-only) + PDF/AI + **gantt** have no v3 column/surface ([15](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)). No delete/archive/soft-delete, no `app_contracts` writes, no files. Design: [13](./13_CONTRACT_STEWARD_WRITE_DESIGN.md). RISK-002 + RISK-016 open; OMC cutover blocked |
| `resource_org_links` relationship table + org hierarchy | `deferred` |
| Imports/exports, integrations/connectors, credential vault | `deferred` |
| Legacy Firebase | `legacy-production` (still serving customers) |
| Legacy→v3 capability parity / OMC (Flywheel) cutover gate | tracked (PR #12 — [11_LEGACY_PARITY_AND_OMC_CHECKLIST](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md)); **no cutover until P0/P1 parity `verified` + signed off** |
| Vercel Web Analytics + Speed Insights (platform telemetry) | `implemented` (PR #5, PR #7); platform-only, see below |

## Platform telemetry (Vercel)
Vercel **Web Analytics** (`@vercel/analytics`, PR #5) and **Speed Insights**
(`@vercel/speed-insights`, PR #7) are integrated in the root layout. They are **platform
performance/traffic telemetry only** — page views and Core Web Vitals.
- They are **not** product analytics, audit logs, authorization, billing, customer reporting, or compliance evidence, and must never be used as a source of truth for any of those.
- **No custom tracking events** are implemented (the bare `<Analytics />` / `<SpeedInsights />` components only).
- No PII / tenant IDs / user emails / app or contract names / spend data / tokens / credentials are sent.
- **No production or custom-domain traffic is intentionally pointed at v3 yet**; legacy Firebase remains production.
- Architecture: [01 · Platform telemetry](./01_ARCHITECTURE.md#platform-telemetry-vercel). Open privacy review: [04 · RISK-013](./04_RISK_REGISTER.md).

## What is NOT verified
- Nothing has run against hosted Supabase. The shim used by `test-rls.sh` mimics
  Supabase's `auth.uid()`/roles but is not Supabase itself; first hosted apply is unproven.
- The GitHub-hosted CI run validates the Docker flow on `ubuntu-latest`; confirm it
  stays green (it is `ci-enforced`, not assume-green).
- The auth skeleton **compiles and passes static safety checks**, but login/logout have
  not been exercised against a live Supabase Auth instance (no hosted env). The end-to-end
  login → session → protected-route flow is unproven against real Supabase.

## Key decisions (ADR-lite)
One-line decisions; deep rationale in the linked canonical docs.
| Decision | Why | Revisit when | Where |
|---|---|---|---|
| Rebuild on Supabase/Postgres + RLS, not port Firebase | legacy authz unsafe & unportable | — (settled) | this doc, [02](./02_SECURITY_AND_RLS.md) |
| `tenant_id` on every tenant row = hard boundary | one provable isolation primitive | — | [02](./02_SECURITY_AND_RLS.md) |
| Steward-only **writes**, related-org **reads** (union of owning-org columns) | chargeback needs multi-org read; edits need one accountable org | multi-org sharing grows → `resource_org_links` | [02](./02_SECURITY_AND_RLS.md) |
| Audit logs append-only (trigger blocks update/delete for all roles) | tamper-evidence; legacy P0 was mutable logs | retention/archival design needed | [02](./02_SECURITY_AND_RLS.md), [04](./04_RISK_REGISTER.md) |
| Migrations append-only after merge; hosted apply is a separate reviewed step | deployed state must stay knowable | — | [03](./03_DATABASE_AND_MIGRATIONS.md) |
| No UI before the data/security foundation is proven | avoid building on unsafe authz | foundation `verified-local`+`ci-enforced` (now true) → UI may start read-only | [06](./06_BUILD_SEQUENCE.md) |
| Child-table org scoping deferred | not needed until those tables carry org-sensitive reads | a feature reads them per-org | [02](./02_SECURITY_AND_RLS.md), [04](./04_RISK_REGISTER.md) |

## Do-not-do-yet list
- Do **not** apply migrations to hosted Supabase (no reviewed deployment process exercised yet).
- Do **not** build UI that bypasses RLS or filters data in the client for "security".
- Do **not** use service-role keys outside trusted server/test paths.
- Do **not** add connectors/credential handling until the encrypted-credential boundary is designed.
- Do **not** edit a merged migration (`0001`–`0013`) — fix forward with a new migration.
- Do **not** cut OMC/Flywheel off legacy Firebase until all P0/P1 parity items are `verified` + signed off ([11](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md)).

## Can we…?
- **Deploy v3 to customers today?** No. Only **read-only** surfaces exist (no writes), **nothing is applied
  to a hosted Supabase environment**, and legacy Firebase is still production.
- **Cut OMC/Flywheel over to v3?** **No — blocked** until all P0/P1 parity items are `verified` + signed off ([11](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md)).
- **Onboard a new paid customer?** **No — blocked.** No hosted environment, no write/provisioning path, no UAR/reporting parity.
- **Safely keep building on this foundation?** Yes — *after* `scripts/check-docs-updated.sh`,
  `check-migration-safety.sh`, and `test-rls.sh` pass. The RLS model is tested and CI-enforced.

## Next recommended PRs (audit `0010` (#29) → write path (#30) → create/edit UI (#31) → parity fields `0011` (#32) → PDF/AI **design** (#33) → `files` metadata `0012` (#34) → `files` RLS `0013` (#35) → OMC replacement gate doc 17 (#36) are done)
> **The canonical, grounded next-PR sequence (Track A security/file path + Track B replacement-parity build-out) now lives in [17 §7](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md), with the honest ~70–110-PR estimate (§8) and the OMC-confirmation list (§9). Start there.** The items below are the near-term head of Track A.

1. **Run the OMC-confirmation pass** — use the [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md) questionnaire/workshop/decision-log (scaffolding shipped #37; resolves doc [17 §9](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)) — it sizes the entire replacement; do it early. No secrets/tokens collected.
2. **Implement contract PDF upload + AI extraction** per the [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) plan — **multiple PRs, each with tests:** ~~(a) `files` forward migration (§4) + `gen-types`~~ — **DONE (`0012`, PR #34)**; ~~(b) `files` RLS policies + the §5 tests~~ — **DONE (`0013`, PR #35 — tenant-member SELECT + contract-write-authority INSERT; no UPDATE/DELETE/FOR ALL)**; (c) **private Storage bucket + server-side validation** (extension/MIME/magic-byte/size + scan gate) ← **next**; (d) extraction worker (out-of-request, tenant-re-deriving; **no service-role app route**) with strict-allowlist parsing through `parseContractWriteInput`; (e) minimal review-and-apply UI; (f) DB-side file/extraction audit; (also: org-scoped `files` read, the deferred read-broadening). **Suggestions only — no AI auto-save.** RISK-002 stays open until built+tested.
2. **Remaining contract-form parity gaps** — the renewal **gantt** and the legacy list-page inline-edit/bulk-delete. `commodity_*`/`validated` deliberately not built (docs/15). Parity stays **Partial**.
3. **App-contract link/unlink** and the next legacy write workflows ([14 §8](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md)).
4. First reviewed **hosted-Supabase apply** (RISK-001 — still nothing applied to any hosted env).

(These are `planned`. Each must follow [07_P0_REVIEW_CHECKLIST.md](./07_P0_REVIEW_CHECKLIST.md) and update [04](./04_RISK_REGISTER.md)/[05](./05_ENGINEERING_CHANGELOG.md). Detailed ordering: [09_AGENT_HANDOFF](./09_AGENT_HANDOFF.md).)
