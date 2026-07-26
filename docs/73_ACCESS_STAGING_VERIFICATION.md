# 73 — /access Verification Runbook (Phase 15 Part 2, PR E + PR F)

Read-only acceptance for the `/access` product surface (Part 1 + Part 2). A HUMAN runs the verifier + the manual UI checklist in an approved
window; the agent runs only `node --check` + the mock-only guard tests (`verify-staging-access-surface.test.ts`).

> STATUS BANNER (do not remove): the verifier is READ-ONLY and USER-SCOPED. It records no secrets. **The database target is STAGING Supabase
> in every mode.** A green run is staging evidence only — it does NOT close RISK-007 and does NOT unblock Phase C. Production is never touched.

## 0. Verification modes (explicit opt-in via `ACCESS_VERIFY_MODE`; never inferred from the host)
- **`staging` (default)** — the app target is `STAGING_APP_URL`; production/legacy hosts (`idcaddie.com`/`www`/`app`) are refused. Existing
  behavior, unchanged.
- **`isolated-v3`** — the app target is an explicitly reviewed, **isolated V3 web deployment** (`ACCESS_VERIFY_APP_URL`) whose host must
  EXACTLY match the statically reviewed allowlist (`idcaddie-v3.vercel.app`) and the operator-supplied `ACCESS_VERIFY_ALLOWED_HOST`.

**Why `isolated-v3` exists:** the V3 deployment is currently an inactive, isolated validation environment — not the legacy live IDCaddie
site, not customer-facing, real connector sync disabled. Vercel's **"Production" channel label refers to the deployment channel, not
authorization to use production data.** `isolated-v3` mode allows validating that one reviewed deployment as a read-only target **while the
database target stays STAGING Supabase** and every other fail-closed safeguard is preserved. It is a strict allowlist (exact host), not a
relaxation of the production-host denylist. To target a different/preview host, add it explicitly to `ISOLATED_V3_ALLOWED_HOSTS` in the
script (a reviewed change) — no wildcard/suffix/substring matching is permitted.

### Sunset condition (must be removed or re-reviewed)
`isolated-v3` mode must be **removed or re-reviewed before any** of: V3 becomes customer-facing; V3 is connected to production Supabase; real
customer data is introduced; live connectors are enabled; Phase C is unblocked; RISK-007 is closed; or provider mutation is authorized.

## 1. What this proves
Owner/admin can read the `/access` surface via the migration-0061 RPCs on real hosted staging; editor/viewer/non-member/anonymous are
denied; the canonical counts match; the known identity + both applications resolve with correct DIRECT (no false GROUP/BOTH) classification;
foreign/nonexistent/invalid ids are indistinguishable; no forbidden field leaks; and the product routes, filters, pagination, drill-down,
and bounded CSV export behave and stay read-only.

## 2. Prerequisites
- Staging linked: `supabase link --project-ref ycdpzduxugdsffjqyoai` (the verifier also accepts `ACCESS_SURFACE_REF_FILE` pointing at a
  file containing the ref — used by the unit tests only). The **production** ref `dzbfxulvxchdemcettrx` and any production URL are refused.
- Synthetic staging users (see §4), in the staging tenant only. Never real customer users.
- The staging canonical fixture present (the Part-1 verified state): identities 1, groups 2, applications 2, memberships 1, direct
  assignments 1, group assignments 0.

### Required local-only env vars (never committed; secret values never printed)
| Var | What |
|---|---|
| `ACCESS_VERIFY_MODE` | `staging` (default) or `isolated-v3`. Unknown/other values are refused; never inferred from the host. |
| `STAGING_SUPABASE_URL` | staging project URL; host must be exactly `ycdpzduxugdsffjqyoai.supabase.co` (exact-host match, not a substring) — **both modes** |
| `STAGING_SUPABASE_ANON_KEY` | staging **anon/publishable** key — a legacy service-role JWT or a current-gen `sb_secret_*` key is REFUSED |
| `STAGING_AUTH_TEST_USERS` | JSON (below) |
| `STAGING_APP_URL` | **staging mode only** — the deployed staging app `https://…` URL; production hosts (`idcaddie.com`/`www`/`app`) refused |
| `ACCESS_VERIFY_APP_URL` | **isolated-v3 mode only** — the reviewed V3 deployment `https://…` bare origin (no creds/path/query/fragment) |
| `ACCESS_VERIFY_ALLOWED_HOST` | **isolated-v3 mode only** — must equal the `ACCESS_VERIFY_APP_URL` host and be a reviewed host (`idcaddie-v3.vercel.app`) |

Setting a **conflicting** `ACCESS_VERIFY_APP_URL` in `staging` mode (one that differs from `STAGING_APP_URL`), or a conflicting
`STAGING_APP_URL` in `isolated-v3` mode, is **refused** as ambiguous. (A matching value is allowed.)

The anon-key value + synthetic passwords + tokens + cookies are never printed. The staging **app URL** (a non-secret deployment URL) does
appear in the run banner; no user/tenant identifier, label, email, provider external id, or raw RPC response is ever printed.

`STAGING_AUTH_TEST_USERS` JSON shape:
```json
{
  "expectedTenantId": "<uuid>",
  "owner":     { "email": "…", "password": "…" },
  "admin":     { "email": "…", "password": "…" },
  "editor":    { "email": "…", "password": "…" },
  "viewer":    { "email": "…", "password": "…" },
  "nonMember": { "email": "…", "password": "…" },
  "foreignId": "<uuid of a canonical row in ANOTHER tenant>"
}
```
**Only `expectedTenantId` is required.** Every principal (`owner`/`admin`/`editor`/`viewer`/`nonMember`) is **optional** and validated only
if supplied; `foreignId` is optional. A check whose principal is absent is reported **`SKIP`** — never silently passed.

### Positive path needs an owner OR admin (and the minimum fixture to add)
The `/access` surface is **owner/admin-only by design** — the migration-0061 RPCs gate on `has_tenant_role(tenant_id, {owner,admin})` and
return `null` to everyone else. So the **positive path** (O1–O7 + A1: counts parity, entity resolution, DIRECT classification, the privacy
scan *of the returned payload*, and authorized export) can only be obtained with an **owner or admin** member of `expectedTenantId`.

With neither present the verifier runs a **PARTIAL / INCONCLUSIVE** run (**exit 3**): it prints `SKIP` for the `POS` line, runs the deny
checks (U1–U7 unauthenticated route-deny; D1/D2/D3 editor/viewer/non-member; N1 anon) + attempts structure, and **never invents an owner or
counts the skipped positive path as passed**. Crucially — **without an authorized read there is no positive control**, so the deny checks
alone **cannot distinguish a correctly-denying surface from one that denies EVERYONE** (e.g. the 0061 RPCs unapplied/broken). A passing
partial run is therefore **inconclusive** — it only shows unauthorized callers got `null`, not that the surface works. `finish()` says so
loudly and exits `3`. (To catch the most common broken case, the deny checks require a *clean* deny — `null` data **and** no RPC error; an RPC
error is a `FAIL`.)

The current staging canonical tenant (`aaaa1111-1111-1111-1111-111111111111`) has **only `editor` + `viewer`** memberships — no owner, no
admin — so a run against it is PARTIAL by construction. To obtain **full** coverage, add the **minimum** synthetic data (read-only-safe, no
schema/grant/directory-data change): **one** synthetic Auth user (e.g. `tenant-owner-a@idcaddie-staging.local`, created via the Auth
dashboard) and **one** `tenant_memberships` row granting it `role='owner'` (or `'admin'`) `status='active'` in that tenant, applied
deliberately in the staging SQL editor after confirming the project ref. Do **not** weaken the verifier or use a real account instead.

## 3. Run
```bash
# Preflight — guards + check plan only; NO network, NO creds required (works in either mode):
node scripts/verify-staging-access-surface.mjs --preflight

# Live STAGING run (default mode), env exported locally:
export STAGING_SUPABASE_URL="https://ycdpzduxugdsffjqyoai.supabase.co"
export STAGING_SUPABASE_ANON_KEY="<STAGING_ANON_OR_PUBLISHABLE_KEY>"
export STAGING_APP_URL="https://<staging-app-host>"
export STAGING_AUTH_TEST_USERS='<SYNTHETIC_TEST_USER_JSON>'
node scripts/verify-staging-access-surface.mjs

# Live ISOLATED-V3 run — reviewed V3 deployment as the app target; STAGING Supabase as the database target:
export ACCESS_VERIFY_MODE="isolated-v3"
export ACCESS_VERIFY_APP_URL="https://idcaddie-v3.vercel.app"
export ACCESS_VERIFY_ALLOWED_HOST="idcaddie-v3.vercel.app"
export STAGING_SUPABASE_URL="https://ycdpzduxugdsffjqyoai.supabase.co"
export STAGING_SUPABASE_ANON_KEY="<STAGING_ANON_OR_PUBLISHABLE_KEY>"
export STAGING_AUTH_TEST_USERS='<SYNTHETIC_TEST_USER_JSON>'
node scripts/verify-staging-access-surface.mjs
```
Exit codes: `0` **FULL PASS** (positive path obtained, nothing failed) · `1` a check **failed** (do not record as passing) · `2` a guard or
fatal precondition refused (bad ref/URL/host, missing env, service-role/secret key, or an unreachable app URL) · `3` **PARTIAL /
INCONCLUSIVE** (positive path skipped — no owner/admin reader; deny-only evidence is not conclusive). Output is check-id +
`PASS`/`FAIL`/`SKIP` + redacted aggregates only — never a password, token, cookie, anon-key value, provider external id, raw RPC response,
label, email, or canonical/tenant id. The `O0`–`O7`/`A0`/`A1`/`POS` positive checks require an authorized owner/admin reader (else `SKIP`,
exit 3); `U1`–`U7` (all seven routes) / `D1`–`D3` / `N1` (the deny boundary) run regardless. `O0`/`A0` record a *configured* owner/admin that
failed to sign in (a `FAIL`).

### Automated checks (RPC + routing)
| ID | Check |
|---|---|
| U1–U7 | Unauthenticated `/access`, `/access/findings`, `/access/identities/:id`, `/access/applications/:id`, and the three `/export` routes all redirect to `/login` (denied) |
| O0/A0 | *Configured* owner/admin failed to sign in → `FAIL` (only recorded when the principal was supplied but sign-in failed) |
| O1–O2 | Authorized owner∨admin sign-in succeeds; JWT is user-scoped (never service_role) |
| O3 | Authorized reader allowed; counts == identities 1 / groups 2 / applications 2 / memberships 1 / direct 1 / group 0 |
| O4 | Identity list = 1, application list = 2 |
| O5 | Known identity resolves DIRECT-only (1 direct assignment, 0 group paths → no false GROUP/BOTH) |
| O6 | Both known applications resolve |
| O7 | Nonexistent (and foreign, if provided) ids return not-found-equivalent `null` (indistinguishable) |
| O3p/O4p/O5p | Privacy scan: no `external_id`/`raw_payload`/`normalized_*`/`credential`/`setting`/`profile`/`source_endpoint`/`secret`/`token` in any RPC response |
| A1 | Admin *also* allowed (only when BOTH owner + admin supplied) |
| D1–D3/N1 | Editor / viewer / non-member / anon are **cleanly** denied (null data **and** no RPC error; an RPC error is a `FAIL`) |
| D1–D3 | Editor / viewer / non-member denied (RPC returns `null`) |
| N1 | Anonymous denied |

### Manual UI acceptance (a script cannot hold the app session)
Signed in as **owner** (then **admin**), in the staging app:
- `/access` loads; findings, identity detail, application detail load.
- Search + each filter (severity/confidence/rule/subject/stale on findings; search/classification/stale on detail) narrow results; "Clear
  filters" resets; the active-filter count is correct.
- Pagination works and is deterministic (Previous/Next, "Page X of N").
- Finding drill-down (`<details>`) expands to evidence/guidance/disclaimer.
- "Export CSV" downloads on findings + identity + application; the response is an attachment, `Cache-Control: no-store`, and
  `X-Content-Type-Options: nosniff`; the CSV carries no id/external-id/raw-evidence column and no formula-executing cell.
- No mutation / removal / reclaim / savings / remediation control appears anywhere.
Signed in as **editor** and **viewer**: a direct `/access` URL is denied. **Anonymous**: redirected to `/login`.
Accessibility spot-check: one `<h1>` per page/state; keyboard-only operation reaches every control with a visible focus ring; filter
controls are labelled; severity/confidence/stale are conveyed with text, not color alone.

## 4. Synthetic-user / fixture setup (one-time)
Create owner/admin/editor/viewer/non-member synthetic users in the staging tenant (and, for the foreign-id check, one canonical row id in a
second isolated tenant). Store credentials in local env only. Never use real customer identities.

## 5. Failure interpretation
- Guard refusal (exit 2): wrong/missing ref, a production ref/URL, missing env, or a service-role key — fix the environment, do not bypass.
- A `LEAK` detail on O*p / D* / N1 / O7 is a **stop-ship** privacy or authorization failure — investigate before any record of passing.
- A count mismatch means the staging fixture drifted from the Part-1 verified state — reconcile the fixture, do not edit expectations.

## 6. Read-only + production prohibition
The verifier calls ONLY the 0061 read RPCs (`.rpc()`) and GETs the allowlisted routes. It performs no insert/update/delete, no mutation, no
hosted task, no AWS call, and no connector-runner change. It refuses the production ref and any production URL. **Never run it against
production.**

## Operational diagnostics — DEFERRED
PR E scope included optional safe aggregate diagnostics (route type, completeness state, duration, validation-failure category, export row
count). The repo has **no approved telemetry/observability abstraction** (only ad-hoc fixed-string `console.error` on query failure). Per the
Phase E instruction, no ad-hoc console logging was added; operational diagnostics are **deferred** until an approved telemetry sink exists.
