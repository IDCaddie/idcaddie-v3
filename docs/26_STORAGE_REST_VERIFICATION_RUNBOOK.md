# 26 · Staging Storage REST API Verification Runbook

**Canonical source for: how to prove the `contract-files` `storage.objects` policies (docs/22 §5) actually
work through the REAL Supabase Storage REST API — with user-scoped JWTs, in hosted STAGING — not just
`pg_policies` inspection.** The verifier is `scripts/verify-staging-storage-rest.mjs`.

> **Production variant:** `scripts/verify-production-storage-rest.mjs` (PR #57) runs the **same 14 REST checks**
> against **production** (`dzbfxulvxchdemcettrx`) with inverted guards (fail-loud refuses unless the linked ref +
> URL are production; refuses the staging ref) and production-specific env vars
> (`PRODUCTION_SUPABASE_URL`/`PRODUCTION_SUPABASE_ANON_KEY`/`PRODUCTION_STORAGE_TEST_USERS`). It is run **only**
> during an approved production apply window per [28 §9](./28_PRODUCTION_STORAGE_APPLY_RUNBOOK.md); it has **NOT
> been run**, and a green run does **not** close RISK-001 or approve cutover.

> ## ⚠️ STATUS BANNER (do not remove)
> - **The verifier was RUN in hosted staging on 2026-06-18 → real Storage REST API authorization verification
>   PASSED (14/14 + the check-12 path self-test; check 15 = local `test-rls.sh` 222).** Evidence recorded in
>   [25 §0.3](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md). The verifier used real Supabase Storage REST
>   API calls with user-scoped JWTs; **no service-role key was used; no production project was touched; no
>   secrets/passwords/anon keys/JWTs were recorded.** Re-run any time policies change.
> - **RISK-001 remains OPEN.** A green run is *necessary evidence*, not closure (closure also needs production
>   apply + doc 17 §5 — see [04 · RISK-001](./04_RISK_REGISTER.md)). **Upload is NOT ready.**
> - **Cutover remains BLOCKED** ([17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)).
> - **No production change.** The verifier refuses to run unless the linked ref **and** the target URL are the
>   staging project `ycdpzduxugdsffjqyoai`, and it errors out if the production ref `dzbfxulvxchdemcettrx` appears.
> - **No secrets in the repo.** The anon key + synthetic-user passwords live in **local env vars only** (§4),
>   are **never committed**, and are **never printed** by the verifier.
> - **User-scoped only.** The verifier uses the public anon key + synthetic-user sign-in. **No service-role on
>   any app/browser/request path.** Service-role appears ONLY in the one-time admin fixture step (§5), run
>   separately by a human against staging.

---

## 1. What it proves (the REST authorization obligations — doc 21 §6)

Each maps to a check the verifier asserts against the live Storage API:

| # | Obligation | Expectation |
|---|---|---|
| 1 | Tenant editor uploads only under their **own** tenant prefix | own-prefix allow; cross-tenant deny |
| 2 | Procurement-org manager uploads **only where contract-write authority exists** | allow on own-org contract; deny on other |
| 3 | Paying-org manager **denied** upload | deny |
| 4 | Tenant viewer **denied** upload | deny |
| 5 | Cross-org manager **denied** upload | deny |
| 6 | Tenant A cannot read or list tenant B prefix | list empty + download denied |
| 7 | Tenant B cannot read, list, or **sign** a tenant A object | list empty + download + signed-URL denied |
| 8 | Anonymous/public GET **denied** | anon download denied (private bucket) |
| 9 | Overwrite/`upsert` **denied** | upsert-on-existing denied (no UPDATE policy) |
| 10 | Move/copy/delete **denied** | all denied (no UPDATE/DELETE/`FOR ALL`) |
| 11 | Signed URL is **single-object scoped** (TTL set to 60s via `expiresIn`) | per-object URL; grants no listing/other object |
| 12 | Object path is the server-derived `contracts/{tenant_id}/{file_id}.pdf` | **client self-test** (the verifier always uses the canonical shape); server-side enforcement is proven by check 13's denials, not logged as REST evidence |
| 13 | Client-supplied / bad-UUID-shaped paths **fail closed** | non-canonical + traversal denied |
| 14 | **`files` table is the source of truth** | upload with no `files` row denied even for an authorized editor |
| 15 | `files`-table RLS (`0013`) unchanged | verify locally: `scripts/test-rls.sh` → **222** (not a REST check) |

A non-green run must **not** be recorded as passing evidence.

---

## 2. Safety model

- **Staging-ref guard (refuses otherwise):** reads `supabase/.temp/project-ref` and requires it to equal
  `ycdpzduxugdsffjqyoai`; requires `STAGING_SUPABASE_URL` to be the staging project and **not** contain the
  production ref `dzbfxulvxchdemcettrx`.
- **User-scoped only:** anon key + `signInWithPassword` for synthetic users; the upload flow inserts the
  `files` row via the `0013` user-scoped authority, then uploads the object — exactly the real flow. **No
  service-role** anywhere in the verifier (`scripts/check-auth-safety.sh` scope is `src/`; the verifier is
  `scripts/` and is anon-only regardless).
- **Synthetic staging data only:** all tenants/orgs/contracts/users/files are synthetic (§5). The verifier
  generates fresh `file_id`s per run, so re-runs don't collide; it never deletes (no DELETE policy) — leftover
  synthetic objects are harmless staging clutter, cleared by the admin in §5 if desired.
- **No secrets committed/printed:** secrets come from env; the verifier prints role names + pass/fail +
  redacted error messages only.

---

## 3. Run sequence (high level)

1. One-time: apply the admin fixtures in **staging** (§5) — separate, elevated, human-run.
2. `supabase link --project-ref ycdpzduxugdsffjqyoai` and confirm `cat supabase/.temp/project-ref`.
3. Export the local env vars (§4).
4. `node scripts/verify-staging-storage-rest.mjs` — it prints `[PASS]/[FAIL]` per check and exits non-zero on
   any failure.
5. Record the evidence (§6) into [25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md)
   (or a [23](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md) copy).

---

## 4. Required LOCAL env vars (names only — NEVER commit values)

| Var | What | Notes |
|---|---|---|
| `STAGING_SUPABASE_URL` | staging project URL | must be the staging ref; not production |
| `STAGING_SUPABASE_ANON_KEY` | staging publishable anon key | public, but still **local only** — not committed |
| `STAGING_STORAGE_TEST_USERS` | JSON of synthetic-user creds | `{ "tenantEditorA": {"email","password"}, "procMgrA1": {...}, "payingMgr": {...}, "tenantViewerA": {...}, "crossOrgMgr": {...}, "tenantEditorB": {...} }` |

Keep these in a **gitignored** local file (e.g. `.env.staging.local`, never committed) or your shell — the
repo commits **no** values. The verifier **fails loudly** if any is missing or malformed.

---

## 5. One-time staging admin fixture setup (ELEVATED — run separately, staging only)

> **This is the only step that needs elevated access** (Supabase Auth admin + SQL editor / service-role). Run
> it **once** against **staging only**, by a human. **Keep it out of the user-scoped verifier.** Do not paste
> the service-role key anywhere committed; use the staging dashboard SQL editor or a local-only admin client.

Create six synthetic auth users (record their generated UUIDs), then insert their profiles + tenant/org
memberships + the tenants/orgs/contracts. Synthetic IDs (match the verifier constants):

| Fixture | ID |
|---|---|
| Tenant A | `aaaa1111-1111-1111-1111-111111111111` |
| Tenant B | `bbbb2222-2222-2222-2222-222222222222` |
| Contract A1 (proc Org A1, paying null) | `cccca111-0000-0000-0000-0000000000a1` |
| Contract A-central (proc Central, paying Org A3) | `cccca1cc-0000-0000-0000-0000000000cc` |
| Contract B1 (tenant B) | `ccccb111-0000-0000-0000-0000000000b1` |

Memberships (the authority each synthetic user must have):

| Synthetic user (env role) | Grant |
|---|---|
| `tenantEditorA` | tenant A, role `editor` |
| `tenantViewerA` | tenant A, role `viewer` |
| `procMgrA1` | org **A1** (Contract A1's procurement org), role `manager` — org-only, **no** tenant membership |
| `payingMgr` | org **A3** (Contract A-central's **paying** org), role `manager` — org-only |
| `crossOrgMgr` | org **A2** (an org with no write authority over Contract A1), role `manager` — org-only |
| `tenantEditorB` | tenant B, role `editor` |

The orgs (A1/A2/A3/Central in tenant A; B1 in tenant B) and the contracts above are inserted with these IDs;
the contracts' `procurement_org_id` / `paying_org_id` are set as in the table. **The `files` rows and Storage
objects are NOT created here** — the verifier creates them user-scoped at run time (that is itself part of the
test). Optional teardown: the admin may delete synthetic Storage objects / `files` rows afterward (staging only).

---

## 6. Evidence to record after a green run (no tokens/passwords)

Capture into [25 §0.3](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md) (or a [23](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md) copy):

- Date / executor / independent reviewer.
- Confirmed linked ref + URL = `ycdpzduxugdsffjqyoai` (staging), production untouched.
- The verifier's `[PASS]` line for **each** of checks 1–14, plus `scripts/test-rls.sh` → 222 for check 15.
- Redacted console output (no tokens/passwords/anon key/JWTs pasted).
- Confirmation that the run was **staging-only synthetic** data.

**Until that evidence is recorded, the docs must continue to say "real Storage REST API authorization
verification pending", "RISK-001 remains OPEN", "cutover remains BLOCKED".**

---

## 7. Non-goals / risk posture

This doc + verifier do **not**: apply anything to production; add an upload route/action/UI; add service-role
to any app/browser/request path; commit secrets; or close RISK-001. A green run is the REST-authz evidence;
**RISK-001 stays OPEN** until that evidence is recorded **and** the remaining closure criteria (production
apply, doc 17 §5 cutover checklist) are met. RISK-002/007/016 remain open. OMC/Flywheel is a paying production
replacement, **not a pilot**.
