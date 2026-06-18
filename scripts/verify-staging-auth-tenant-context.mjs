#!/usr/bin/env node
// verify-staging-auth-tenant-context.mjs
//
// STAGING-ONLY hosted Auth + tenant-context verifier for the deployed staging app (doc 17 §5 boxes 5/6/8;
// blocker-sequence item #1 — docs/30/31). It exercises the REAL hosted Supabase Auth + RLS for synthetic
// staging users, and the deployed staging app's routing, with USER-SCOPED JWTs only. See docs/31 for the full
// plan, the one-time synthetic-user setup, the manual UI steps, env vars, and the evidence template.
//
// PREPARED, NOT EXECUTED: this PR adds the verifier; it is run later by a human in an approved staging window.
//
// SAFETY (enforced below):
//   * Refuses unless the linked project ref (supabase/.temp/project-ref) is the STAGING ref
//     (ycdpzduxugdsffjqyoai), and STAGING_SUPABASE_URL is the staging ref and NOT the production ref. Refuses
//     any production project ref (dzbfxulvxchdemcettrx).
//   * USER-SCOPED ONLY: public anon key + sign-in as synthetic staging users. NEVER a service-role key.
//   * Reads secrets (anon key, synthetic-user passwords, app URL) from LOCAL env vars only. Commits no secret;
//     prints NO tokens, passwords, cookies, JWTs, anon keys, or secrets — only check names + PASS/FAIL.
//   * Touches staging only (signs in PRE-EXISTING synthetic users; creates no users/fixtures). Never production.
//
// A green run is hosted Auth/tenant-context evidence toward doc 17 §5; it does NOT close RISK-001 and does NOT
// approve cutover. It does NOT cover the app-session UI checks (authenticated-page render + tenant render in
// the page) — those are manual/browser steps in docs/31.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const STAGING_REF = 'ycdpzduxugdsffjqyoai';      // required target
const PRODUCTION_REF = 'dzbfxulvxchdemcettrx';   // must NEVER be the target

function die(msg) {
  console.error(`\n  FATAL: ${msg}\n`);
  process.exit(2);
}

// ── Guard 1: linked project ref must be staging ───────────────────────────────────────────────────
let linkedRef = '';
try {
  linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim();
} catch {
  die('supabase/.temp/project-ref not found. Link the STAGING project first (supabase link --project-ref ' + STAGING_REF + ').');
}
if (linkedRef === PRODUCTION_REF) die(`linked project ref is PRODUCTION (${PRODUCTION_REF}). Refusing — production must not be touched.`);
if (linkedRef !== STAGING_REF) die(`linked project ref is "${linkedRef}", refusing. This verifier runs ONLY against staging (${STAGING_REF}).`);

// ── Guard 2: required local env vars ──────────────────────────────────────────────────────────────
const URL = process.env.STAGING_SUPABASE_URL;
const ANON = process.env.STAGING_SUPABASE_ANON_KEY;
const USERS_JSON = process.env.STAGING_AUTH_TEST_USERS;
const APP_URL = process.env.STAGING_APP_URL || process.env.VERCEL_STAGING_URL;
if (!URL) die('missing env STAGING_SUPABASE_URL (staging project URL).');
if (!ANON) die('missing env STAGING_SUPABASE_ANON_KEY (staging publishable anon key — local only, not committed).');
if (!USERS_JSON) die('missing env STAGING_AUTH_TEST_USERS (JSON of synthetic-user {email,password,expectedTenantId} — local only, not committed).');
if (!APP_URL) die('missing env STAGING_APP_URL (or VERCEL_STAGING_URL) — the deployed STAGING app URL for the routing checks.');

// ── Guard 3: URLs must be staging, never production ───────────────────────────────────────────────
if (!URL.includes(STAGING_REF)) die(`STAGING_SUPABASE_URL ("${URL}") is not the staging project (${STAGING_REF}). Refusing.`);
if (URL.includes(PRODUCTION_REF)) die(`STAGING_SUPABASE_URL points at the PRODUCTION ref (${PRODUCTION_REF}). Refusing.`);
if (APP_URL.includes(PRODUCTION_REF)) die(`STAGING_APP_URL points at the PRODUCTION ref (${PRODUCTION_REF}). Refusing.`);
if (!/^https:\/\//.test(APP_URL)) die('STAGING_APP_URL must be an https:// URL of the deployed staging app.');

let USERS;
try { USERS = JSON.parse(USERS_JSON); } catch { die('STAGING_AUTH_TEST_USERS is not valid JSON.'); }
for (const r of ['tenantA', 'tenantB']) {
  if (!USERS[r]?.email || !USERS[r]?.password || !USERS[r]?.expectedTenantId) {
    die(`STAGING_AUTH_TEST_USERS is missing { email, password, expectedTenantId } for role "${r}".`);
  }
}

// ── Harness ───────────────────────────────────────────────────────────────────────────────────────
const results = [];
function record(id, name, passed, detail) {
  results.push({ id, passed });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${id}. ${name}${detail ? ` — ${detail}` : ''}`);
}
const appUrl = (path) => new global.URL(path, APP_URL).toString();
function anonClient() {
  return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
}
// Decode ONLY the `role` claim from a JWT payload (no token is printed/stored).
function jwtRole(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.role ?? null;
  } catch { return null; }
}

async function main() {
  console.log(`\n  STAGING Auth + tenant-context verifier — project ref ${STAGING_REF}; app ${APP_URL.replace(/\/+$/, '')}\n`);

  // ── App routing checks (no session) ──────────────────────────────────────────────────────────────
  // (Obligation 8, staging-env-wired, is NOT scanned from served HTML — NEXT_PUBLIC_SUPABASE_URL is only
  // referenced in server-only code (no browser client consumer yet), so Next does not inline it into the
  // served HTML. Env-wiring is instead assured by: this verifier's staging-only Supabase guards above, AND
  // the manual authenticated-reach step in docs/31 §3 — a staging-issued session reaching the deployed app's
  // authenticated pages proves the app is wired to staging Auth; a production-wired app rejects it.)

  // A1: protected route redirects an unauthenticated request to /login (proxy.ts route guard).
  let prot;
  try { prot = await fetch(appUrl('/apps'), { redirect: 'manual', headers: { cookie: '' } }); }
  catch (e) { die(`could not reach STAGING_APP_URL (${e?.message}).`); }
  const protLoc = prot.headers.get('location') || '';
  record('A1', 'Protected page redirects unauthenticated users to /login',
    [301, 302, 303, 307, 308].includes(prot.status) && protLoc.includes('/login'),
    `status ${prot.status} → ${protLoc.includes('/login') ? '/login' : '(not /login)'}`);

  // A2: public /login is reachable without a session.
  const pub = await fetch(appUrl('/login'), { redirect: 'manual' });
  record('A2', 'Public /login is reachable without a session', pub.status === 200, `status ${pub.status}`);

  // A3: /logout redirects to /login (clears session server-side; proves the route exists + redirects).
  const lo = await fetch(appUrl('/logout'), { redirect: 'manual', headers: { cookie: '' } });
  const loLoc = lo.headers.get('location') || '';
  record('A3', 'Logout endpoint redirects to /login',
    [301, 302, 303, 307, 308].includes(lo.status) && loLoc.includes('/login'),
    `status ${lo.status} → ${loLoc.includes('/login') ? '/login' : '(not /login)'}`);

  // ── Hosted Auth + RLS checks (user-scoped, against staging Supabase) ─────────────────────────────
  const a = anonClient();
  const { data: aSignIn, error: aErr } = await a.auth.signInWithPassword({ email: USERS.tenantA.email, password: USERS.tenantA.password });
  // R1: login succeeds for a synthetic staging user against real hosted Auth.
  record('R1', 'Login succeeds for a synthetic staging user (hosted Auth)', !aErr && !!aSignIn?.session, aErr ? 'sign-in error' : 'session issued');
  if (aErr || !aSignIn?.session) { return finish(); }

  // R2: the issued JWT is a USER token (role=authenticated), never service_role.
  const role = jwtRole(aSignIn.session.access_token);
  record('R2', 'Issued JWT is user-scoped (role=authenticated, not service_role)', role === 'authenticated', `role=${role ?? 'unknown'}`);

  // R3: tenant context resolves to the expected tenant — the same active-membership read resolveTenantContext does.
  const { data: aMems } = await a.from('tenant_memberships').select('tenant_id, role, status').eq('status', 'active');
  const aTenantIds = (aMems ?? []).map((m) => m.tenant_id);
  record('R3', 'Tenant context resolves to the correct tenant',
    aTenantIds.includes(USERS.tenantA.expectedTenantId),
    `active tenant(s) = ${aTenantIds.length} row(s); expected tenant present=${aTenantIds.includes(USERS.tenantA.expectedTenantId)}`);

  // R4: cross-tenant access is denied/not exposed — tenant A user reads 0 of tenant B's rows. A genuine RLS
  // deny returns data:[] with error:null; an ERRORED read (e.g. a hosted base-privilege gap on these tables —
  // the 0015-class divergence; tenant_memberships/tenants have no explicit grant) must FAIL, not be scored as
  // a "deny" (supabase-js returns data:null on error). So require error===null AND length===0.
  const { data: bRows, error: bRowsErr } = await a.from('tenant_memberships').select('tenant_id').eq('tenant_id', USERS.tenantB.expectedTenantId);
  const { data: bTenant, error: bTenantErr } = await a.from('tenants').select('id').eq('id', USERS.tenantB.expectedTenantId);
  record('R4', 'Cross-tenant access is denied / not exposed',
    !bRowsErr && !bTenantErr && (bRows?.length ?? 0) === 0 && (bTenant?.length ?? 0) === 0,
    `${bRowsErr || bTenantErr ? 'READ ERRORED (not a clean RLS deny) — ' : ''}tenant-B membership rows visible=${bRows?.length ?? 0}, tenant rows visible=${bTenant?.length ?? 0} (expect no error + 0/0)`);

  // R5: hosted RLS / privilege divergence probe (the 0015 lesson). A tenant member SELECT on public.files must
  // NOT fail with a base-privilege error ("permission denied for table files") — that is exactly the
  // local-vs-hosted grant gap that bit production and was codified as migration 0015.
  const { error: filesErr } = await a.from('files').select('id', { count: 'exact', head: true });
  // A tenant member's RLS-filtered SELECT must succeed (rows filtered, not errored). ANY error fails this
  // probe; a "permission denied for table files" is the exact local-vs-hosted grant gap that bit production.
  const privDenied = !!filesErr && /permission denied/i.test(filesErr.message || '');
  record('R5', 'Hosted RLS/privilege parity — no public.files grant divergence (the 0015 lesson)',
    !filesErr,
    filesErr
      ? (privDenied ? 'permission denied for table files — staging is MISSING the 0015 authenticated grant' : 'files SELECT errored (not the expected RLS-filtered success)')
      : 'authenticated holds the files SELECT privilege; RLS reachable');

  await a.auth.signOut();
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} automated checks passed.`);
  console.log('  NOT covered here (manual/browser — docs/31 §3): authenticated user reaches authenticated pages with a');
  console.log('  real app session, and the page renders the correct tenant context. Staging-env-wiring (obligation 8) is');
  console.log('  assured by this verifier\'s staging-only guards + that manual reach step, NOT by an HTML scan. A green');
  console.log('  run does NOT close RISK-001 or approve cutover; cutover remains BLOCKED.');
  if (failed.length) { console.log(`  FAILED: ${failed.map((r) => r.id).join(', ')} — do NOT record as passing evidence.\n`); process.exit(1); }
  console.log('  All automated Auth/tenant-context checks passed. Record per docs/31 (no tokens/cookies/secrets).\n');
}

main().catch((e) => die(e?.message ?? String(e)));
