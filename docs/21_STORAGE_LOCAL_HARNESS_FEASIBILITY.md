# 21 · Supabase Storage Local Harness Feasibility (Spike)

**Canonical source for: whether this repo can honestly test Supabase Storage bucket/object policies
locally, and — since it cannot right now — exactly what the hosted-staging verification of the
`contract-files` bucket + object policies must prove before any upload action ships.**

> **Verdict (do not overclaim):** **NOT feasible to faithfully test Supabase Storage object-RLS in the
> current local/CI pipeline.** No fake `storage` shim was added; no Storage object policy was added; no
> migration was added; no bucket was created; no upload action/UI was built. **Storage object-RLS must be
> verified in HOSTED STAGING per [20](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md) before any upload
> action ships** (§6 checklist). This spike is docs-only and **closes no risk** (RISK-001/002/007/016 stay open).

---

## 1. The question

PR #40 shipped the pure, locally-testable core of the contract PDF path (`src/lib/files/pdf-validation.ts` —
server-side validation + the server-derived tenant-bound path `contracts/{tenant_id}/{file_id}.pdf`, bucket
`contract-files`). The deferred piece is the **private Storage bucket + its object-RLS** (no public access,
tenant-prefix isolation, cross-tenant denial, authorized upload/read only through the contract-write
authority). **Can this repo test those Storage policies locally — faithfully, in CI — without faking
safety?** Outcome must be **A** (real local harness added) or **B** (not feasible → document + the hosted
verification checklist). Do not add a fake shim and call it equivalent to Supabase Storage.

## 2. What was investigated

- `supabase/config.toml` / a `supabase init`'d project — **absent.** The repo is **not** a Supabase-local
  project; there is no local stack configured.
- `scripts/test-rls.sh` and `scripts/gen-types-local.sh` — both spin up a **plain `postgres:16-alpine`**
  container, install a minimal **`auth` shim only** (`create schema auth` + `auth.uid()` + the
  `anon`/`authenticated`/`service_role` roles), then glob-apply **every** `supabase/migrations/*.sql`. CI
  (`.github/workflows/rls-tests.yml`) runs that same `test-rls.sh`.
- The Supabase CLI (v2.x) **is** installed and Docker is present, so `supabase start` is technically
  available — its default stack is a ~13-service set: `[analytics, db, edge-runtime, functions, imgproxy,
  inbucket, kong, meta, realtime, rest, storage, studio, vector]` (the `storage` service = storage-api).
- Supabase Storage architecture: the `storage` schema (`storage.buckets`, `storage.objects`, the
  `storage.foldername`/`filename`/`extension` helpers, the object RLS) is created + owned by the
  **storage-api service's own migrations** (version-coupled to the storage-api image). The *enforcement*
  of "no public access / owner / signed URLs / which bucket is private" happens in **storage-api**, not in
  Postgres alone — an object-RLS policy is only the SQL predicate half of the real behavior.

## 3. Findings (empirical)

Against a fresh `postgres:16-alpine` (the exact harness `test-rls.sh`/`gen-types-local.sh` use), with the
`auth` shim + all of `0001`–`0013` applied:

| Probe | Result |
|---|---|
| `select to_regclass('storage.objects')` | **null** — `storage.objects` does **not** exist |
| `select storage.foldername('contracts/x/y.pdf')` | **`ERROR: schema "storage" does not exist`** |
| `create policy p on storage.objects for select using (true)` | **`ERROR: schema "storage" does not exist`** |

**Therefore:**
1. **A storage-policy migration (`0014_*` touching `storage.*`) would BREAK `test-rls.sh` AND
   `gen-types-local.sh`** — both apply every `supabase/migrations/*.sql` to a schema-less plain Postgres,
   and the first `storage.` reference aborts with `ON_ERROR_STOP=1`. (The task requires keeping `test-rls.sh`
   green and not editing `0001`–`0013`.)
2. **A pure-SQL test of a storage policy predicate is NOT faithful.** Even if the `storage` schema were
   hand-installed, "no public access", object `owner`, signed-URL issuance, and private-bucket resolution
   are enforced by **storage-api**, not by the Postgres policy alone — so a SQL-only test would prove the
   predicate but **not** the end-to-end Storage behavior, and presenting it as "Storage object-RLS tested"
   would **overclaim / fake safety.**
3. **The only faithful local test = the real storage-api**, via `supabase start` (the ~13-service stack)
   exercised through the **Storage REST API** with real user JWTs (upload as A; cross-tenant read as B;
   anonymous/public GET; signed-URL read) — see §5.

## 4. Verdict: Outcome B — not feasible in this repo's pipeline right now

Rejected alternatives (and why each would be dishonest or break the pipeline):

- **Hand-rolled `storage` schema shim** (fake `storage.objects` + `storage.foldername`): forbidden by the
  task; tests a *fake*, not Supabase Storage. **Not done.**
- **Vendoring storage-api's real migrations into `supabase/migrations/`**: would break `test-rls.sh`/
  `gen-types` (they'd be applied to plain Postgres anyway), is version-coupled to a storage-api release
  that drifts from hosted Supabase, and *still* only tests the SQL predicate, not storage-api enforcement.
  **Not done.**
- **A storage-policy `0014` migration**: breaks both plain-Postgres harnesses (Finding 1). **Not done.**
- **Adopting `supabase start` in the current `rls-tests.yml`**: technically runnable locally, but it is a
  **different, far heavier harness** (a ~13-container stack vs one Postgres), would require `supabase init`
  + a pinned storage-api version, and is a **separate, larger CI infra decision** — not something to bolt
  onto the fast `test-rls.sh` path in this spike. It is recorded below as a *future option*, not adopted here.

**Conclusion:** there is no honest way to add *faithful, CI-compatible* Storage object-RLS tests to the
current pipeline. Per the repo's existing discipline ([20](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)),
**Storage bucket + object-RLS are verified in HOSTED STAGING** (the storage-api the customer actually runs),
and **no upload action ships until §6 passes there.**

## 5. The two faithful paths (for the future implementer)

**(a) Hosted staging — the path of record (doc 20).** Create the private `contract-files` bucket + object
policies in **staging** Supabase (the real storage-api), run the §6 verification through the Storage REST
API, then production — following the step-by-step **[22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md)**
(which reproduces this §6 checklist as its acceptance gate) and capturing the proof in the
**[23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md)** record. This is
authoritative because it exercises the exact storage-api version + semantics the customer runs. **No local migration; the bucket/policies are a hosted-applied Storage object, not a
`supabase/migrations/*.sql` file.**

**(b) Optional future: a dedicated `supabase start` CI job (separate from `rls-tests.yml`).** If the team
wants pre-staging local confidence, add a SEPARATE workflow that runs `supabase start` (pinned storage-api),
applies the bucket/policies, and tests them through the **Storage REST API** (not pure SQL). This is a real
(not fake) harness but a larger infra change; it must **not** put storage policies into `supabase/migrations/`
(that breaks `test-rls.sh`/`gen-types`) and must not be presented as a substitute for the hosted-staging
proof (storage-api version drift). **Deferred — not built here.**

## 6. Hosted-staging Storage bucket/object-policy verification checklist

Run **in staging** (doc 20 §4/§9), as the gate before any upload action ships. Every box must pass.

**Bucket setup**
- [ ] A bucket named **`contract-files`** exists and is **PRIVATE** (`public = false`).
- [ ] No public bucket and no public base URL for contract files; object access is **signed-URL only**.
- [ ] A server-side file-size limit consistent with `MAX_CONTRACT_FILE_BYTES` (25 MiB) is configured.

**Object-policy authority (mirrors the `0013` files-table authority — contract-write, never `paying_org`)**
- [ ] **Upload (INSERT on `storage.objects`)** is allowed **only** for a user with **contract-write
      authority** for the linked contract (tenant `owner`/`admin`/`editor`, OR the procurement-org manager),
      writing **only** under their own tenant prefix `contracts/{their_tenant_id}/…`. Tie the policy to the
      tenant prefix via `storage.foldername(name)` / the path convention.
- [ ] **`paying_org` manager is DENIED upload** (read ≠ write — mirrors `0013`/T34).
- [ ] **Tenant viewer is DENIED upload.**
- [ ] **Cross-org manager (different org) is DENIED upload** for a contract they cannot write.
- [ ] **UPDATE / DELETE on `storage.objects` (overwrite / `upsert:true` / move / copy / delete) is DENIED for
      everyone** (or, if ever allowed, scoped to the user's own tenant prefix only) — there is **no broad
      UPDATE/DELETE policy and no leftover `FOR ALL`** (mirrors the `0013`/T34 no-UPDATE/no-DELETE/no-`FOR ALL`
      posture on the `files` table). Supabase Storage exposes overwrite/`upsert`/move/copy/delete via the REST
      API, so this must be proven, not assumed.
- [ ] **A cross-tenant overwrite or delete is DENIED** — tenant B cannot overwrite, move, copy, or delete an
      object under tenant A's prefix (verified through the Storage REST API).

**Tenant isolation / no public access**
- [ ] **Tenant-prefix isolation:** a user can read/list **only** objects under their own
      `contracts/{their_tenant_id}/…` prefix.
- [ ] **Cross-tenant denial:** tenant B cannot read, list, or sign-URL an object under tenant A's prefix
      (verified through the Storage REST API, not just SQL).
- [ ] **No public access:** an **anonymous / unauthenticated** GET of an object path returns denied (no
      public URL works); reads succeed **only** via a short-lived signed URL issued after an auth check.
- [ ] A signed URL is **short-lived** and scoped to a single object; it does not grant listing or
      cross-tenant access.

**Integrity / preservation**
- [ ] The object path is the **server-derived** `contracts/{tenant_id}/{file_id}.pdf` (PR #40
      `buildContractFileObjectPath`); a client-supplied path/filename cannot escape the tenant prefix.
- [ ] The **`0013` files-table RLS is unchanged** and still green (the file **metadata row** is still
      governed by the `0013` INSERT authority + T34; the Storage object policy is an additional, parallel
      boundary, not a replacement).
- [ ] **No service-role on any request/browser path** in the upload action (user-scoped client only).
- [ ] Post-apply: re-run `scripts/test-rls.sh` (still **205**) and confirm no drift; record the staging
      verification per doc 20 §9.

## 7. What this PR did / did NOT do

- **Did:** evaluate feasibility with empirical probes (§3); record the verdict (B) + rationale; produce the
  hosted-staging verification checklist (§6); update the docs.
- **Did NOT:** add a migration; create a Storage bucket; add or test Storage object policies; add a
  `storage` shim; add an upload action/UI/route; add signed-URL code; add AI/OCR; add a service-role
  request path; mutate hosted Supabase; deploy; or add secrets. `test-rls.sh` stays **205**; migrations stay
  **0001–0013**; routes unchanged; `database.types.ts` unchanged.

## 8. Risk posture

**RISK-001** (no hosted apply), **RISK-002** (`files` still not surfaced), **RISK-007** (no credential
vault), **RISK-016** all remain **OPEN**. Cutover stays **BLOCKED**. OMC/Flywheel is a paying production
replacement, **not a pilot**.
