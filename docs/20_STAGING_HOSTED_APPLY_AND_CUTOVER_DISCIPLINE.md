# 20 · Staging, Hosted Apply & Cutover Discipline

**Canonical source for: the operational discipline that moves v3 from local-only verified code to a
hosted staging environment and — eventually — a production replacement of the live OMC/Flywheel app.**
This is the runbook-of-record for hosted Supabase apply, Vercel deployment, secrets handling, post-apply
verification, rollback, and the OMC cutover sequence.

> **Status (do not overclaim):** **DISCIPLINE DOCUMENTED, NOTHING APPLIED.** No hosted Supabase apply has
> happened; no staging or production environment exists; no secrets added; no production deploy. This doc
> **does not make v3 ready** and **does not close RISK-001** — it defines the *future, safe path* to close
> RISK-001. Nothing here is executed by this PR.

> **Where this sits in the gate stack:**
> - [17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) — the
>   **binding go/no-go cutover gate** (17 wins on any conflict).
> - [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md) — confirms what OMC uses (existence/status
>   only; **no tokens**); feeds 17.
> - [19_CONNECTOR_CREDENTIAL_VAULT_DESIGN](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md) — gates **connector
>   credentials**.
> - **20 (this doc)** — gates **HOW** a hosted/staging/prod apply, deployment, and cutover are *executed*.
>   **Doc 17 authorizes WHETHER** cutover may happen; doc 20 never grants that authority.
>
> **Cutover is currently BLOCKED.** This doc gates *how* an apply/deploy happens once doc 17 allows it;
> it never authorizes one by itself.

Inherits the v3 invariants ([02_SECURITY_AND_RLS](./02_SECURITY_AND_RLS.md),
[03_DATABASE_AND_MIGRATIONS](./03_DATABASE_AND_MIGRATIONS.md), [09_AGENT_HANDOFF](./09_AGENT_HANDOFF.md)):
RLS is the authorization boundary; **no service-role on any request/browser path**; migrations are
forward-only and never edited after apply; `gen-types` runs **local-only, never `--linked`**; the local
demo fixture is **never** in the hosted path (RISK-015).

---

## 1. Purpose and scope

- This is the **operational discipline** for promoting v3 from local-only `verified-local` code to a hosted
  staging environment and — only after the gate is satisfied — a production replacement.
- It **does not make v3 ready**, and **does not close RISK-001** (nothing is applied to hosted Supabase).
- It **defines the future path for closing RISK-001 safely**: a reviewed, human-controlled, staging-first
  hosted apply with post-apply schema + RLS verification.
- **Out of scope of execution:** this doc applies nothing, deploys nothing, and adds no secrets. It is
  docs/process only.

---

## 2. Environment model

| Environment | What it is | State today |
|---|---|---|
| **Local dev/test** | Developer machine + throwaway Postgres (`scripts/test-rls.sh`, `gen-types-local.sh`). RLS proven against a local `auth` shim. | the only place v3 runs today |
| **Staging Supabase** | A separate hosted Supabase project for pre-prod verification (own DB, own Auth, own keys). | **does not exist yet** |
| **Staging Vercel** | A Vercel deployment wired to **staging** Supabase (explicit, not a random preview). | **does not exist yet** |
| **Production Supabase** | The hosted Supabase project that backs the live v3. | **does not exist yet** |
| **Production Vercel** | The production v3 deployment, custom domain, wired to production Supabase. | **does not exist yet** |
| **Legacy production app** | The current live Firebase/Firestore OMC/Flywheel app (`legacy-production`). | **still production**; v3 must replace it |
| **OMC/Flywheel production-replacement target** | The paying customer (~$3.5k/mo) v3 must replace the live app for — **not a pilot**. | replacement **blocked** (doc 17) |

**Rules:** each environment has its **own** Supabase project + keys + secrets. Never share a key/secret
across environments. Staging is a faithful, isolated rehearsal of production — never pointed at production
data or production secrets.

---

## 3. Branch and PR discipline

- **Feature branches only**; **no direct pushes to `main`** (agents propose on branches; humans dispose).
- **Humans merge.** No auto-merge; a human reviews every PR.
- **Every PR must pass CI** (`app-ci.yml` + the migration/RLS/auth/docs scripts).
- **Migration PRs need local RLS proof before any hosted apply** — `scripts/test-rls.sh` green + a
  positive/negative test per RLS change, reviewed on the PR.
- **Hosted apply is a SEPARATE, reviewed, human-controlled step** — never a side effect of merging a PR. A
  hosted apply is its own runbook action (§4), explicitly approved by the human, **staging first**.

---

## 4. Hosted Supabase apply discipline

A hosted apply is a deliberate human action, **staging first, production never first**. The required
sequence:

1. **List the migration state before apply** — compare the repo's `supabase/migrations/` (currently
   `0001`–`0013`) against the remote's applied list. Know exactly which migration(s) are missing.
2. **Apply only the expected missing migration(s)** — the specific forward migrations the diff shows, never
   "everything" blindly.
3. **Verify the remote schema after apply** — tables/columns/constraints/policies match what the migrations
   define; the applied list now matches the repo.
4. **Run post-apply smoke checks** — auth/session against hosted Auth, a representative RLS read/write as a
   real user, and the §9 "after staging apply" checklist.
5. **Never apply unknown or duplicate migrations** — if the remote shows a migration the repo doesn't have,
   or a duplicate number appears, **STOP** (§10).
6. **Never apply from a dirty working tree** — `git status` must be clean and on the reviewed commit.
7. **Never apply if generated types differ unexpectedly** — `gen-types-local.sh` must produce **no
   unexplained diff** vs the committed `database.types.ts`.
8. **Never apply if `scripts/test-rls.sh` is not green** locally first.
9. **Never use production first.** Staging apply + verify + soak, **then** production (§9).

**Hard prohibitions (this PR + always):** never `supabase db push --linked` casually; never apply from an
unreviewed branch; never include `supabase/fixtures/local_demo.sql` in a hosted apply (RISK-015); never
apply as part of CI/merge automation.

---

## 5. Staging-first rule

**All risky capabilities land in staging — verified — before production.** This explicitly includes:

- Storage bucket — the private `contract-files` bucket + its object-RLS are a Supabase `storage`-schema object the local harness can't host/test (empirically proven, PR #41 / [21](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md)); **created + verified via THIS hosted path, not a local migration / not a `storage` shim** — run the **[21 §6](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md) Storage bucket/object-policy verification checklist** in staging before any upload action ships (the PR #40 PDF validation/path core is a pure lib; the bucket is the hosted piece)
- file upload (the upload action: user-scoped client + the `0013` insert authority; **no service-role**)
- signed URLs
- PDF validation / scan gate (server-side validation core built PR #40 — `src/lib/files/pdf-validation.ts`)
- AI extraction
- the connector credential vault ([19](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md))
- connectors (Okta/Google/Entra/Slack/SCIM/scrapers)
- reports / exports
- imports (non-destructive upsert)
- billing / monthly reporting

Each ships to staging, is exercised against **OMC-shaped staging data** (synthetic, never real customer
secrets), and passes its tests + the §9 checklists **before** it is promoted toward production.

**Production replacement cannot happen** until staging holds OMC-shaped data **and** every
[17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) go/no-go box is true. Hosted/staging readiness is
necessary but **not sufficient** — the binding gate is doc 17.

---

## 6. Secrets discipline

- **No real connector credentials** (Okta/Google/Entra/Slack/SCIM/scraper/API tokens, service-account JSON,
  OAuth secrets) **until the [19](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md) vault is implemented, tested,
  reviewed, hosted-applied, and verified.** Connector *existence* may be confirmed via
  [18](./18_OMC_CONFIRMATION_PASS.md); **tokens are never collected there.**
- **Staging secrets are separate from production secrets.** Each environment has its own.
- **Production secrets are never used in preview or staging.**
- **Secrets never appear in:** docs, commits, issue comments, PR bodies, terminal output, logs, screenshots,
  generated types, or database rows. (Secrets live only in the per-environment secret store / vault — never
  in the repo or an app-readable column.)
- The only Supabase key v3 uses today is the **anon** key (user-scoped, RLS-bound). A service-role key is an
  **architecture boundary reserved for future isolated jobs only** — it is **not stored in the repo**, never
  on a request/browser path, and there is **no connector secret anywhere**. No secret value lives in the repo.

---

## 7. Vercel discipline

- **Preview deploys are NOT production** — a preview URL is a throwaway build, never customer-facing, never
  wired to production data/secrets.
- **Staging deployment must be explicit** — a named staging deployment wired to **staging** Supabase, not an
  ad-hoc preview.
- **Production deployment is gated by the cutover checklist** ([§9](#9-verification-checklists) +
  [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)) — never an automatic promotion.
- **Environment variables must be scoped correctly** — preview/staging/production each get their own
  Supabase URL + keys; **no production env var in preview or staging.**
- **A rollback plan is required before any production promotion** (§10) — rehearsed in staging.
- Vercel platform telemetry stays bare/unreviewed-for-prod until the RISK-013 privacy review; no custom
  events, no PII.

---

## 8. Cutover discipline for OMC/Flywheel

- **OMC/Flywheel is NOT a pilot** — a paying production-replacement customer (~$3.5k/mo).
- **Replacement means no missing/broken workflows** — users must not notice a regression.
- **[17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) remains the binding go/no-go gate.**
- **[18](./18_OMC_CONFIRMATION_PASS.md) feeds confirmations into doc 17** (existence/status only; no tokens).
- **[19](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md) gates connector credentials.**
- **This doc (20) gates HOW a hosted/staging/prod apply, deployment, and cutover are executed** — doc 17 authorizes *whether* cutover happens; doc 20 does not.
- **Cutover is BLOCKED until all hard blockers are cleared** (doc 17 §3/§5). Satisfying this doc's apply
  discipline is necessary plumbing, not permission to cut over.

---

## 9. Verification checklists

Each is a hard gate; do not proceed while any box is unchecked.

### Before opening a PR
- [ ] On a feature branch (not `main`); working tree understood.
- [ ] `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build` green.
- [ ] `scripts/test-rls.sh` green; `scripts/check-migration-safety.sh`, `check-auth-safety.sh`, `check-docs-updated.sh` pass.
- [ ] `gen-types-local.sh` run; `database.types.ts` diff is **expected** (or none).
- [ ] No `* 2.*`/`* 3.*` strays; no secrets in the diff.

### Before merging a PR
- [ ] CI green; a human has reviewed.
- [ ] Docs/risk/changelog updated (or a justified `.docs-not-needed`).
- [ ] Migration PRs: RLS positive+negative tests present and green; migration numbering sequential, no duplicates.
- [ ] No hosted apply is implied by the merge.

### Before staging Supabase apply
- [ ] On the reviewed commit; **clean working tree**.
- [ ] Local `test-rls.sh` green; `gen-types` diff explained.
- [ ] Remote (staging) applied-migration list known; the **exact** missing migration(s) identified.
- [ ] No unknown/duplicate migration on the remote.
- [ ] Human approval recorded for this specific staging apply.

### After staging Supabase apply
- [ ] Remote schema matches the migrations (tables/columns/constraints/policies).
- [ ] Applied list now matches the repo.
- [ ] Auth/session smoke check against hosted Auth passes.
- [ ] A representative RLS read/write as a real user behaves correctly (no cross-tenant leak).
- [ ] Post-apply RLS verification (re-run the suite's intent against staging) passes.

### Before production Supabase apply
- [ ] The same migration(s) were applied + verified in **staging** first and soaked.
- [ ] Staging holds OMC-shaped data and the relevant §9 staging checks passed.
- [ ] Backup/restore + rollback plan in place and rehearsed.
- [ ] Human approval recorded for the production apply.
- [ ] [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) cutover boxes relevant to this change are satisfied (if cutover-bound).

### After production Supabase apply
- [ ] Remote prod schema matches the migrations; applied list matches the repo.
- [ ] Smoke checks + RLS verification pass on production.
- [ ] Monitoring/alerting shows no regression; rollback path confirmed still available.

### Before Vercel production promotion
- [ ] Production Supabase apply done + verified.
- [ ] Production env vars scoped correctly; **no preview/staging secrets**, **no production secrets in preview/staging**.
- [ ] Rollback plan documented and rehearsed.
- [ ] Cutover checklist (doc 17 §5) satisfied for the workflows shipping.

### After Vercel production promotion
- [ ] Production app reachable; auth/session + key flows verified by a real user.
- [ ] Telemetry/error monitoring clean; no secret in logs.
- [ ] Rollback still possible; old/legacy app still available per the cutover plan.

### Before OMC cutover
- [ ] **Every** doc 17 §5 go/no-go box true; doc 18 confirmations resolved; no required workflow `partial`/`not-built`/`blocked`/`unknown`.
- [ ] Staging validated with OMC; OMC acceptance test plan executed; OMC signoff recorded.
- [ ] Documented old-app freeze/cutover plan + rollback; data-migration cutoff agreed.

### After OMC cutover
- [ ] OMC critical flows validated in production by OMC.
- [ ] Monitoring clean; rollback window honored; legacy app retained per plan.
- [ ] Post-cutover review logged; any deferred items tracked.

---

## 10. Rollback / stop rules

**STOP immediately (do not proceed / roll back)** on any of:

- Any **unexpected migration** appears on the remote (not in the repo).
- Any **duplicate migration number** appears.
- Any **generated-type drift** is unexplained.
- Any **RLS assertion fails** (local or staging verification).
- Any **production secret appears in logs or code** (or any secret in docs/PR/commit/output).
- Any **cross-tenant access suspicion** (a user seeing another tenant's data).
- Any **data-destructive behavior** (a delete/overwrite not explicitly approved + reversible).
- Any **app route starts using a service-role key on a request path** (forbidden — bypasses all RLS).
- Any **doc claims readiness prematurely** (cutover-ready / RISK-001-closed without the evidence).

On STOP: halt the apply/deploy, roll back to the last known-good state, record what happened, and open a
fix-forward PR. Never "push through" a stop condition.

---

## 11. Relationship to the risk register

- **RISK-001** → "**staging/hosted-apply discipline documented (PR #39); hosted apply still not done — risk
  remains OPEN.**" Closure requires an actual reviewed **staging apply + post-apply RLS/schema verification**
  (and, for prod, the §9 production checks) — not this doc.
- **RISK-002** remains **open** (child/link tables not fully org-scoped; org-scoped file read deferred).
- **RISK-007** remains **open** (no implemented credential vault — [19](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md) is design only).
- **RISK-016** remains **open** (replacement parity not met; cutover gated by doc 17).

This doc closes **no** risk. It makes RISK-001 *addressable* by a safe, reviewed apply path.

---

## 12. Non-goals (this PR)

This PR does **not**:

- apply hosted migrations (no `supabase db push --linked`, no hosted apply)
- create staging (no staging Supabase, no staging Vercel)
- create production (no production Supabase/Vercel)
- deploy production
- add secrets (no API tokens, connector credentials, OAuth secrets, service-account JSON, real customer secrets)
- build Storage (no bucket)
- build PDF upload
- build AI extraction
- build connectors
- close cutover blockers (doc 17 stays the binding gate; cutover stays BLOCKED)
- make v3 production-ready (RISK-001/002/007/016 stay open)

It is **docs/process only** — no migration, app code, route, package, RLS, or generated-type change.
