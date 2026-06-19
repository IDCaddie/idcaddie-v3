# 31 · Hosted Staging Auth + Tenant-Context Verification

**Canonical plan for doc 17 blocker-sequence item #1** ([30](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md)): prove the
**deployed staging app** uses **real hosted Supabase Auth** + **tenant-scoped session context** correctly, and
that the hosted RLS matches the local suite — advancing [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)
boxes **5, 6, 8**. The verifier is `scripts/verify-staging-auth-tenant-context.mjs`.

> ## ✅ RUN 2026-06-18 — PASSED (evidence in §7; synthetic-fixture cleanup/disposition in §8)
> **Hosted staging Auth + tenant-context verification PASSED.** A human ran it against the deployed staging app
> `https://idcaddie-v3.vercel.app` (staging Supabase `ycdpzduxugdsffjqyoai`): **8/8 automated checks + manual
> Tenant A/Tenant B browser checks passed**, after correcting the Vercel env vars (§7). **The verifier used real
> hosted Supabase Auth with user-scoped JWTs; no service-role key was used; no production project was touched;
> no secrets recorded.** RISK-001 stays OPEN; cutover stays BLOCKED. §1–§6 below are the plan as authored.

> ## ⚠️ STATUS BANNER (do not remove)
> - **Hosted staging Auth + tenant-context verification has now been RUN green (§7).** The plan + verifier below
>   are unchanged; **the agent ran nothing — a human executed it.** **No production project was touched.**
> - **No secrets, passwords, anon keys, cookies, or JWTs are recorded.** The verifier reads them from local env
>   and prints only check names + PASS/FAIL.
> - **User-scoped only** — public anon key + synthetic-user sign-in. **No service-role key** in the verifier.
> - **RISK-001 remains OPEN.** **Cutover remains BLOCKED.** **Upload is not automatically production-ready.**
> - **Storage completion is necessary but not sufficient for cutover** — this item is a *different* §5 box set;
>   a green run here does **not** close RISK-001 or approve cutover.

---

## 1. What this must prove

Against the **deployed staging app** (`STAGING_APP_URL`) + **hosted staging Supabase Auth/DB** (`ycdpzduxugdsffjqyoai`),
with synthetic staging users:

1. **Login succeeds** for a synthetic staging user (real hosted Auth).
2. **Logout clears the session** (the `/logout` route signs out + redirects to `/login`).
3. **Protected pages redirect unauthenticated users** to `/login` (the `src/proxy.ts` route guard).
4. **Authenticated users can reach authenticated pages** (with a valid app session).
5. **Tenant context resolves to the correct tenant** (the user's active membership → their tenant).
6. **Cross-tenant access is denied / not exposed** (tenant A user cannot read tenant B's data — RLS).
7. **The hosted app uses anon/user-JWT paths only, not service-role** (`role=authenticated`; `check-auth-safety.sh` green).
8. **Vercel staging env vars are wired to staging, not production** (assured by the verifier's staging-only
   guards + the manual authenticated-reach step — see §2; **not** an HTML scan, since the URL is server-only).
9. **Hosted RLS divergence is checked** — especially because production exposed a local-vs-hosted privilege gap
   on `public.files` later codified as migration `0015`; staging must hold the same `authenticated` grant.

---

## 2. The verifier — `scripts/verify-staging-auth-tenant-context.mjs`

**Local-only, user-scoped, fail-loud.** It refuses unless the linked ref **and** `STAGING_SUPABASE_URL` are the
staging ref `ycdpzduxugdsffjqyoai` (and errors on the production ref `dzbfxulvxchdemcettrx` in any URL), reads
secrets from local env only, prints no tokens/passwords/cookies/JWTs/anon keys, and exits non-zero on any failure.

**Required local env vars (names only — never commit values):**

| Var | What |
|---|---|
| `STAGING_SUPABASE_URL` | staging project URL (must include the staging ref) |
| `STAGING_SUPABASE_ANON_KEY` | staging publishable anon key (local only) |
| `STAGING_AUTH_TEST_USERS` | JSON: `{ "tenantA": {"email","password","expectedTenantId"}, "tenantB": {…} }` (synthetic; ≥1 user in each of 2 tenants) |
| `STAGING_APP_URL` (or `VERCEL_STAGING_URL`) | the deployed **staging** app URL (https; must not be production) |

**Automated checks (PASS/FAIL):**

| ID | Check | Obligation |
|---|---|---|
| A1 | Protected page redirects unauthenticated → `/login` | 3 |
| A2 | Public `/login` reachable without a session | 3 |
| A3 | `/logout` redirects to `/login` | 2 |
| R1 | Login succeeds for a synthetic staging user (hosted Auth) | 1 |
| R2 | Issued JWT is **user-scoped** (`role=authenticated`, not `service_role`) | 7 |
| R3 | Tenant context resolves to the correct tenant (active-membership read, RLS) | 5 |
| R4 | Cross-tenant access denied / not exposed (tenant A reads 0 of tenant B, **no read error**) | 6 |
| R5 | Hosted RLS/privilege parity — **no `public.files` grant divergence** (the `0015` lesson) | 9 |

**Obligation 8 (Vercel staging env wired to staging, not production) is NOT scanned from served HTML** —
`NEXT_PUBLIC_SUPABASE_URL` is referenced only in server-only code (no browser-client consumer yet), so Next
does not inline it into the served HTML. It is instead assured by **(i)** the verifier's staging-only guards
(it only ever talks to `STAGING_SUPABASE_URL`/the staging ref) **and (ii)** the manual authenticated-reach step
(§3) — a staging-issued session reaching the deployed app's authenticated pages proves the app is wired to
staging Auth; a production-wired app would reject it. **That manual reach step is load-bearing, not optional.**

**Run (human, in an approved staging window — NOT in this PR):**
`supabase link --project-ref ycdpzduxugdsffjqyoai` → confirm `cat supabase/.temp/project-ref` → set the local
env vars → `node scripts/verify-staging-auth-tenant-context.mjs`.

---

## 3. Manual / browser steps (NOT automated — do these alongside the script)

The script proves tenant-context **resolution** at the data layer and the **unauthenticated** app routing, but
the **authenticated app-session UI** is not faithfully scriptable without coupling to `@supabase/ssr` cookie
internals (a brittle script could pass/fail for the wrong reason). Verify these by hand in a browser against the
staging app, and record the result:

- **Obligation 4 — authenticated reach:** log in (synthetic user) → confirm `/`, `/apps`, `/contracts` render
  (HTTP 200, not a redirect to `/login`).
- **Obligation 5 (UI) — tenant render:** confirm the authenticated pages show **only the signed-in user's
  tenant's** data; switch to the tenant-B synthetic user and confirm tenant-A data is not visible.
- **Obligation 2 (UI) — logout clears session:** click logout → confirm you are returned to `/login` and a
  subsequent visit to a protected page redirects to `/login` (no stale session).

---

## 4. One-time synthetic-user / fixture setup (human, later — NOT in this PR)

This PR creates **no** Auth users or fixtures. Before a run, a human sets up (staging only, synthetic):
- ≥1 synthetic Auth user that is an **active** `tenant_membership` of **tenant A**, and ≥1 of **tenant B**
  (so cross-tenant denial is testable), plus the tenant/profile/membership rows.
- **Full tenant isolation between the synthetic users** — the tenant-A user must have **no cross-tenant
  `organization_membership`** in any org belonging to tenant B (and vice versa). The `tenants` SELECT RLS is the
  OR of `is_tenant_member` **and** `is_tenant_participant` (an org member of a tenant's org), so a cross-tenant
  org link would expose the other tenant's row and make R4 fail spuriously. Keep the two synthetic users in
  fully separate tenants/orgs.
- Record their emails/passwords/tenant IDs **only in local env** (`STAGING_AUTH_TEST_USERS`) — never committed.
- Reuse the doc 26 §5 synthetic-fixture shape where possible. Use **synthetic** identities only — never real
  customer data. (Elevated setup uses the dashboard / SQL editor; the verifier itself is anon-only.)

---

## 5. Evidence to record after a green run (no secrets)

Capture into a dated record (a [23](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md) copy or
`docs/evidence/staging-auth-<date>.md`) — **names + PASS/FAIL only; no tokens/passwords/cookies/JWTs/anon keys:**
- Date / executor / independent reviewer; confirmed linked ref + URLs = staging (not production).
- The verifier's `[PASS]` line for A1–A4, R1–R5; the §3 manual-step results (with reviewer initials).
- `scripts/check-auth-safety.sh` green (no service-role in `src/`) and `scripts/test-rls.sh` 222 (local).
- Confirmation: real hosted Auth + user-scoped JWTs, no service-role, staging-only synthetic data, no secrets recorded.

**Until that evidence is recorded, doc 17 §5 boxes 5/6/8 stay unticked; RISK-001 remains OPEN; cutover remains BLOCKED.**

---

## 6. Risk posture

**RISK-001** remains **OPEN** — this is necessary hosted-Auth evidence toward criterion (5) (the doc 17 §5
checklist), not its closure. **Cutover remains BLOCKED.** **Upload is not automatically production-ready.**
**Storage completion is necessary but not sufficient for cutover.** RISK-002/007/013/016 remain open. OMC/Flywheel
is a paying production **replacement, not a pilot**.

---

## 7. Recorded run evidence — 2026-06-18 (PASSED)

**Hosted staging Auth + tenant-context verification passed.** A human ran it against the deployed staging app;
the agent ran nothing. **No secrets, passwords, anon keys, cookies, JWTs, or tokens are recorded.**

| Field | Value |
|---|---|
| Date | 2026-06-18 |
| Staging project ref | `ycdpzduxugdsffjqyoai` |
| Production project ref (untouched) | `dzbfxulvxchdemcettrx` — **NOT touched** |
| Deployed app URL tested | `https://idcaddie-v3.vercel.app` |

### 7.1 Initial failure + the Vercel env-var fix
The first hosted app checks failed because the Vercel runtime env was missing `NEXT_PUBLIC_SUPABASE_URL` /
`NEXT_PUBLIC_SUPABASE_ANON_KEY`:
- `GET /login` = **500**, `GET /` = **500**, `GET /logout` = **500**; runtime logs showed the two missing
  `NEXT_PUBLIC_SUPABASE_*` vars.

**Fix:** **the Vercel environment variables were corrected for the tested deployment scope and the deployment
was redeployed** — `NEXT_PUBLIC_SUPABASE_URL` → `https://ycdpzduxugdsffjqyoai.supabase.co` (staging),
`NEXT_PUBLIC_SUPABASE_ANON_KEY` → the staging publishable/anon key (**no key value is recorded**).

**Post-fix `curl` (no session):** `GET /login` = **HTTP 200**; `GET /` = **HTTP 307 → /login**; `GET /logout` =
**HTTP 303 → /login**. **The deployed staging app was verified after Vercel env vars were corrected and
redeployed.**

### 7.2 Automated verifier — `node scripts/verify-staging-auth-tenant-context.mjs` → 8/8 PASS
**The verifier used real hosted Supabase Auth with user-scoped JWTs; no service-role key was used by the verifier.**

| # | Check | Result |
|---|---|---|
| A1 | Protected page redirects unauthenticated users to `/login` | **PASS** |
| A2 | Public `/login` is reachable without a session | **PASS** |
| A3 | Logout endpoint redirects to `/login` | **PASS** |
| R1 | Login succeeds for a synthetic staging user (hosted Auth) | **PASS** |
| R2 | Issued JWT is user-scoped (`role=authenticated`, not `service_role`) | **PASS** |
| R3 | Tenant context resolves to the expected tenant | **PASS** |
| R4 | Cross-tenant access denied / not exposed | **PASS** |
| R5 | Hosted RLS/privilege parity — no `public.files` grant divergence | **PASS** |

### 7.3 Manual browser checks — PASSED (Tenant A + Tenant B)
**Manual browser checks passed for Tenant A and Tenant B** (all values below are **synthetic** staging test
fixtures, not real customer data):

| Tenant | Synthetic user | Active tenant | Tenant ID | Role |
|---|---|---|---|---|
| A | `tenant-a-auth-check@idcaddie-staging.local` | Hosted Auth Check Tenant A | `a1111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1` | editor |
| B | `tenant-b-auth-check@idcaddie-staging.local` | Hosted Auth Check Tenant B | `b2222222-bbbb-4bbb-8bbb-bbbbbbbbbbb2` | editor |

Confirmed: `/` renders after login; `/apps` and `/contracts` render for the authenticated user; Tenant A context
shows **Tenant A only** and Tenant B context shows **Tenant B only** (no cross-tenant data visible); logout
returns to `/login`; protected routes redirect to `/login` when logged out.

### 7.4 Synthetic staging fixture used (all synthetic)
2 synthetic staging Auth users · 2 synthetic tenants · 2 synthetic profiles · 2 synthetic `tenant_memberships` ·
**0 cross-org memberships** for those users (full tenant isolation per §4).

### 7.5 Disposition
**This evidence does not approve cutover.** It advances doc 17 §5 boxes 5/6/8 (Auth/session/tenant-context +
the hosted RLS isolation/`files`-grant spot checks); the **full `org_rls_test.sql` suite re-run against hosted
Postgres/Auth** (prepared via `scripts/verify-staging-rls-suite.mjs` — [30 §6](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md); not yet run) and the OMC-shaped dataset (box 7) + critical flows (box 9) remain. **No production project was
touched. No service-role key was used. No secrets, passwords, anon keys, cookies, JWTs, or tokens are recorded.
RISK-001 remains OPEN** unless every documented closure criterion is satisfied (the doc 17 §5 checklist is not).
**Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not
sufficient for cutover.**

---

## 8. Synthetic-fixture cleanup / disposition — 2026-06-18

**Hosted staging Auth tenant-context cleanup/disposition recorded.** After the §7 run passed (8/8 automated +
manual Tenant A/B), a human attempted cleanup of the synthetic staging fixtures. The agent ran nothing. **No
production project was touched. No secrets, passwords, anon keys, cookies, JWTs, or tokens are recorded.**

**Cleanup verification result (staging `ycdpzduxugdsffjqyoai`):**

| Object | Count | Disposition |
|---|---|---|
| `tenant_memberships` (synthetic) | **0** | removed |
| `organization_memberships` (synthetic) | **0** | removed |
| retained synthetic `profiles` (audit anchors) | **2** | retained |
| retained synthetic `tenants` (audit anchors) | **2** | retained |
| retained synthetic Auth users | **2** | retained |
| `audit_logs` for the synthetic users/tenants | **1** | retained (append-only) |

**Interpretation:**
- **Synthetic tenant/org access was removed** — the two synthetic users no longer have any active
  `tenant_membership` or `organization_membership`, so they have **no tenant/org access through the app** (RLS
  resolves them to no-membership).
- **Two synthetic profiles, two synthetic tenants, and two synthetic Auth users remain as audit anchors** —
  deleting the linked `profiles`/Auth users would attempt to `update` the append-only `audit_logs.actor_user_id`
  (and removing the tenants would orphan the retained audit row), which is **blocked**.
- **Audit log immutability prevented destructive cleanup and is working as intended** — `audit_logs` is
  append-only (`reject_audit_mutation()`, `0002`); the **1** synthetic audit row cannot be deleted/updated, so
  its anchor `profiles`/`tenants`/Auth users are intentionally retained. This mirrors the production cleanup
  posture ([29 §6](./29_PRODUCTION_STORAGE_APPLY_EVIDENCE.md)).
- **No production project was touched** (`dzbfxulvxchdemcettrx` NOT touched). No service-role key was used.

**This cleanup evidence does not approve cutover.** **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is
not automatically production-ready. Storage completion is necessary but not sufficient for cutover.**
