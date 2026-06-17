# 25 · Staging Schema & Contract-Files Storage Apply — Evidence (2026-06-17)

**Dated evidence record for the staging hosted-apply step**, filled from the
[23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md) template per the
[22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md) /
[20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md) discipline.

> ## ⚠️ OUTCOME: HOSTED APPLY **NOT EXECUTED** (correctly blocked) — production NOT touched
> - **Production (`dzbfxulvxchdemcettrx`) was NOT touched.** No hosted command was run against any project.
> - The staging schema apply + `contract-files` bucket creation + staging verification **were NOT performed**
>   in this session — they are **pending a human execution** (see §3 blocker + §5 remediation).
> - **This record contains no fabricated results.** Only what was actually verified (local, §2) is marked done;
>   every hosted step is marked **NOT EXECUTED**.
> - **RISK-001 remains OPEN** (no hosted apply has happened). RISK-002/007/016 remain open. **Cutover stays BLOCKED.**
> - No secrets/keys/passwords/JWTs/connection-strings are in this doc.

---

## 1. Execution metadata

| Field | Value |
|---|---|
| Date / time | 2026-06-17 |
| Executor | **Automated agent (Claude Code)** — performed the **read-only checks only**; **did NOT execute any hosted apply** (see §3). |
| Reviewer | **Pending** — a human executor + independent reviewer must run + record the actual apply (§5). |
| Repo commit | `53562c3` (main; PRs #1–#44 merged) |
| **Intended staging project ref** | `ycdpzduxugdsffjqyoai` |
| **Production project ref** | `dzbfxulvxchdemcettrx` — **NOT TOUCHED** (no hosted command run anywhere) |
| Confirmed staging, not production | ⚠️ **could not** — the staging project is **not reachable** from this environment (§2/§3) |

---

## 2. What was actually verified (read-only, local — real results)

- **Repo state:** on `main` @ `53562c3`, `git status` clean; **`.env.local` is NOT tracked**; **no `* 2.*`/`* 3.*`
  conflict files** outside `node_modules`/`.next`.
- **Supabase CLI link (CRITICAL):** the CLI is currently **linked to PRODUCTION** —
  `supabase/.temp/project-ref` = `dzbfxulvxchdemcettrx`, `linked-project.json` `{"ref":"dzbfxulvxchdemcettrx","name":"IDCaddie",…}`.
- **`supabase projects list`:** the **only** accessible project is **production** (`dzbfxulvxchdemcettrx`). The
  **staging project `ycdpzduxugdsffjqyoai` is NOT listed / NOT accessible** from this environment.
- **Hosted-apply credentials:** `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_SERVICE_ROLE_KEY`,
  and any DB URL/password are **all not set** in this environment.
- **Local verification suite (all local / throwaway Postgres — never hosted):**
  - `npm test` → **67/67** · `npm run lint` → clean · `npx tsc --noEmit` → clean · `npm run build` → clean (**10 routes**, unchanged)
  - `scripts/check-auth-safety.sh` → pass · `scripts/check-migration-safety.sh` → pass · `scripts/check-docs-updated.sh` → pass
  - `scripts/test-rls.sh` → **`ALL ORG-RLS ASSERTIONS PASSED`** (205, against a throwaway `postgres:16`, **not** hosted)
  - `scripts/gen-types-local.sh` → **0-line diff** (`database.types.ts` = 1283 lines)

---

## 3. Why the hosted apply was NOT executed (the blocker)

All four are independently sufficient; together they make a safe agent-run apply impossible here:

1. **The CLI is linked to PRODUCTION.** Any `supabase db push --linked` (or other `--linked` hosted command)
   right now would mutate **production `dzbfxulvxchdemcettrx`** — the one thing this work must never do. Running it
   as-is would be a production incident.
2. **Staging is unreachable.** `ycdpzduxugdsffjqyoai` is not accessible from this environment, so migrations
   could not be applied to it and the `contract-files` bucket could not be created/verified there.
3. **No credentials.** No staging access token / DB password / service-role is available, and **none may be
   added to the repo or this session** (hard rule). `db push` + bucket creation require credentials not present.
4. **Repo discipline.** [09_AGENT_HANDOFF](./09_AGENT_HANDOFF.md) is explicit: *an agent never executes a
   hosted apply / `supabase db push --linked` / bucket-or-policy creation itself* — those are **human-run under
   explicit approval** ([20 §3](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)). The agent may only prepare
   + record. Fabricating "applied/verified" results is forbidden ("never claim verified without command output").

---

## 4. Hosted-apply / bucket / staging-verification — status

| Step (template ref) | Result |
|---|---|
| Apply migrations `0001`–`0013` to **staging** | **NOT EXECUTED** — pending human (§3) |
| Verify staging migration list after apply | **NOT EXECUTED** — pending human |
| Create/verify private `contract-files` bucket (public=false, PDF, 25 MiB cap) | **NOT EXECUTED** — pending human |
| Core/`files` tables + `files` RLS exist on staging | **NOT EXECUTED** — pending human |
| Anon/unauthenticated cannot list private files | **NOT EXECUTED** — pending human |
| Preview `/login` renders; failed login lands in **staging** Auth logs (not prod) | **NOT EXECUTED / not independently verified** — Preview→staging wiring was reported set up out-of-band; the agent did not verify it (no staging access) |
| Authenticated staging test user reaches `/contracts` w/o production data | **NOT EXECUTED** — pending human |
| The full [21 §6](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md) / [23 §4](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md) Storage object-policy checklist | **NOT EXECUTED** — pending human |

**No failures to log** because nothing was applied. **No rollback needed** — production untouched, nothing created.

---

## 5. Human remediation runbook (run by a person, against STAGING only — redacted; no secrets in the repo)

> **STOP-FIRST SAFETY CHECK — the CLI is currently linked to PRODUCTION.** Before *any* `--linked` command you
> MUST re-link to staging and verify the target. **If `supabase/.temp/project-ref` shows
> `dzbfxulvxchdemcettrx` (production), DO NOT push.** Follow [22](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md)
> and record into a fresh [23](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md) copy.

1. **Re-link to staging + verify the target (the single most important step):**
   - `supabase link --project-ref ycdpzduxugdsffjqyoai`  *(staging DB password entered interactively / via your own env — never committed)*
   - `cat supabase/.temp/project-ref`  → **must print `ycdpzduxugdsffjqyoai`** (NOT `dzbfxulvxchdemcettrx`). If not, STOP.
2. **List migrations before applying:** `supabase migration list --linked` → confirm `0001`–`0013` are the
   expected missing set on staging; no unknown/duplicate.
3. **Apply only the expected migrations to staging:** `supabase db push --linked` (staging only) → then re-run
   `supabase migration list --linked` and confirm `0001`–`0013` are applied.
4. **Create the private bucket** `contract-files` (public=false; PDF; size cap consistent with
   `MAX_CONTRACT_FILE_BYTES` = 25 MiB; MIME `application/pdf` per `src/lib/files/pdf-validation.ts` + [16 §3](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md))
   via the Supabase dashboard / Management API + apply the object policies per [22 §4/§5](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md).
5. **Verify** against the real staging storage-api: run the [21 §6](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md) /
   [23 §4](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md) checklist (private bucket, no public read, cross-tenant
   read+overwrite/delete denied, upload only via contract-write authority, no service-role on a request path, `0013` still green).
6. **Record** everything (names + `set/not set` + redacted output, never values/secrets) in the doc 23 copy,
   with **executor + independent reviewer** signoff. **STOP before production** — production is a separate run.

---

## 6. Risk posture

**RISK-001** (no hosted apply — still true; **this session applied nothing**), **RISK-002** (`files` not
surfaced), **RISK-007** (no credential vault), **RISK-016** all remain **OPEN**. **Production untouched.**
Cutover stays **BLOCKED** ([17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) is the binding authority). v3 is
**not** production-replacement-ready. OMC/Flywheel is a paying production replacement, **not a pilot**.
