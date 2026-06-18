#!/usr/bin/env node
// verify-production-storage-rest.mjs
//
// PRODUCTION-ONLY Storage REST API authorization verifier for the private `contract-files` bucket.
// Derived from verify-staging-storage-rest.mjs with INVERTED guardrails (production-targeted). Runs the
// SAME 14 REST authorization checks through the REAL Supabase Storage REST API with USER-SCOPED JWTs.
// See docs/28 (production apply runbook) §9 + docs/26 for the obligations, fixture setup, and env vars.
//
// SAFETY (enforced below):
//   * Refuses to run unless the linked project ref (supabase/.temp/project-ref) is the PRODUCTION ref
//     (dzbfxulvxchdemcettrx), and the target URL is the production ref and NOT the staging ref. Refuses
//     if the linked ref or URL is the staging project (ycdpzduxugdsffjqyoai).
//   * USER-SCOPED ONLY: uses the production public anon key + signs in as SYNTHETIC production users.
//     NEVER a service-role key (that belongs only in the separate, one-time admin fixture step — doc 28 §H).
//   * Reads secrets (anon key, synthetic-user passwords) from LOCAL env vars only. Commits no secret;
//     prints no token/password/anon key/JWT. Fail-loud if any required env var is missing.
//   * Touches PRODUCTION synthetic data only (synthetic users/tenants/orgs/contracts created per doc 28 §H).
//
// A green run is the production REST-authz evidence for [25] / a [23] copy. It does NOT, by itself, close
// RISK-001 and does NOT approve cutover — production apply + this verification + the doc 17 §5 cutover
// checklist must ALL pass (doc 04 RISK-001). Run only inside an approved production apply window.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const PRODUCTION_REF = 'dzbfxulvxchdemcettrx'; // the REQUIRED target for this production verifier
const STAGING_REF = 'ycdpzduxugdsffjqyoai'; // must NEVER be the target here
const BUCKET = 'contract-files';

// ── Synthetic fixtures (non-secret IDs; same shape as staging; created by the one-time PRODUCTION admin step — doc 28 §H / doc 26 §5) ──────
const F = {
  tenantA: 'aaaa1111-1111-1111-1111-111111111111',
  tenantB: 'bbbb2222-2222-2222-2222-222222222222',
  contractA1: 'cccca111-0000-0000-0000-0000000000a1', // tenant A, procurement org A1, paying null
  contractACentral: 'cccca1cc-0000-0000-0000-0000000000cc', // tenant A, procurement Central, paying org A3
  contractB1: 'ccccb111-0000-0000-0000-0000000000b1', // tenant B
};

function die(msg) {
  console.error(`\n  FATAL: ${msg}\n`);
  process.exit(2);
}

// ── Guard 1: linked project ref must be PRODUCTION ─────────────────────────────────────────────────
let linkedRef = '';
try {
  linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim();
} catch {
  die('supabase/.temp/project-ref not found. Link the PRODUCTION project first, inside an approved window (supabase link --project-ref ' + PRODUCTION_REF + ').');
}
if (linkedRef === STAGING_REF) {
  die(`linked project ref is the STAGING project (${STAGING_REF}). This is the PRODUCTION verifier — use scripts/verify-staging-storage-rest.mjs for staging. Refusing.`);
}
if (linkedRef !== PRODUCTION_REF) {
  die(`linked project ref is "${linkedRef}", refusing to run. This verifier runs ONLY against production (${PRODUCTION_REF}) inside an approved apply window.`);
}

// ── Guard 2: required local env vars (PRODUCTION-specific) ─────────────────────────────────────────
const URL = process.env.PRODUCTION_SUPABASE_URL;
const ANON = process.env.PRODUCTION_SUPABASE_ANON_KEY;
const USERS_JSON = process.env.PRODUCTION_STORAGE_TEST_USERS;
if (!URL) die('missing env PRODUCTION_SUPABASE_URL (production project URL).');
if (!ANON) die('missing env PRODUCTION_SUPABASE_ANON_KEY (production publishable anon key — local only, not committed).');
if (!USERS_JSON) die('missing env PRODUCTION_STORAGE_TEST_USERS (JSON of synthetic-user {email,password} — local only, not committed).');

// ── Guard 3: target URL must be the production ref, never staging ─────────────────────────────────
if (!URL.includes(PRODUCTION_REF)) {
  die(`PRODUCTION_SUPABASE_URL ("${URL}") is not the production project (${PRODUCTION_REF}). Refusing.`);
}
if (URL.includes(STAGING_REF)) {
  die(`PRODUCTION_SUPABASE_URL points at the STAGING ref (${STAGING_REF}). Refusing — this verifier is production-targeted.`);
}

let USERS;
try {
  USERS = JSON.parse(USERS_JSON);
} catch {
  die('PRODUCTION_STORAGE_TEST_USERS is not valid JSON.');
}
const REQUIRED_ROLES = ['tenantEditorA', 'procMgrA1', 'payingMgr', 'tenantViewerA', 'crossOrgMgr', 'tenantEditorB'];
for (const r of REQUIRED_ROLES) {
  if (!USERS[r]?.email || !USERS[r]?.password) {
    die(`PRODUCTION_STORAGE_TEST_USERS is missing { email, password } for role "${r}".`);
  }
}

// ── Test harness ──────────────────────────────────────────────────────────────────────────────────
const results = [];
function record(num, name, passed, detail) {
  results.push({ num, name, passed, detail });
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${num}. ${name}${detail ? ` — ${detail}` : ''}`);
}

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
const objPath = (tenant, fileId) => `contracts/${tenant}/${fileId}.pdf`;

function anonClient() {
  return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function signIn(role) {
  const c = anonClient();
  const { data, error } = await c.auth.signInWithPassword(USERS[role]);
  if (error || !data?.user) die(`could not sign in synthetic user "${role}" (${error?.message ?? 'no user'}). Run the one-time admin fixture setup (doc 26) in staging first.`);
  return { client: c, userId: data.user.id };
}

// As a user-scoped writer, create a files metadata row (0013 INSERT authority) for (fileId, tenant, contract).
async function insertFilesRow(client, userId, fileId, tenant, contract) {
  const { error } = await client.from('files').insert({
    id: fileId, tenant_id: tenant, contract_id: contract,
    storage_path: objPath(tenant, fileId), original_filename: 'synthetic-test.pdf', uploaded_by: userId,
  });
  return error;
}
async function upload(client, path, opts = {}) {
  const { error } = await client.storage.from(BUCKET).upload(path, PDF, { contentType: 'application/pdf', ...opts });
  return error;
}

async function main() {
  console.log(`\n  PRODUCTION Storage REST verifier — project ref ${PRODUCTION_REF} (linked-ref + URL confirmed production, not staging)\n`);

  // Sign in all synthetic users (user-scoped; no service-role).
  const editorA = await signIn('tenantEditorA');
  const procMgrA1 = await signIn('procMgrA1');
  const payingMgr = await signIn('payingMgr');
  const viewerA = await signIn('tenantViewerA');
  const crossMgr = await signIn('crossOrgMgr');
  const editorB = await signIn('tenantEditorB');

  // ── User-scoped setup (NOT elevated): authorized writers seed the targets for this run ───────────
  // Read-target object in tenant A (editor A — authorized) + the cross-tenant write/read fixtures.
  const fRead = randomUUID();
  if (await insertFilesRow(editorA.client, editorA.userId, fRead, F.tenantA, F.contractA1)) die('setup: editor A could not insert a files row for contract A1 — check the admin fixtures.');
  // (1) tenant editor uploads under OWN prefix → allowed.
  record(1, 'Tenant editor can upload under own tenant prefix',
    !(await upload(editorA.client, objPath(F.tenantA, fRead))), 'authorized own-prefix upload succeeds');

  // (1b) cross-tenant write: editor A → a tenant-B object whose files row EXISTS (seeded by editor B) → denied.
  // The row exists, so the deny is purely the cross-tenant AUTHORITY check (editor A has no write authority in
  // tenant B), not a missing-files-row deny.
  const fB = randomUUID();
  if (await insertFilesRow(editorB.client, editorB.userId, fB, F.tenantB, F.contractB1)) die('setup: editor B could not insert a files row for contract B1 — check the admin fixtures.');
  await upload(editorB.client, objPath(F.tenantB, fB)); // editor B seeds a tenant-B object (authorized) for the read tests
  const fDenyB = randomUUID();
  if (await insertFilesRow(editorB.client, editorB.userId, fDenyB, F.tenantB, F.contractB1)) die('setup: editor B could not seed a tenant-B deny-target row.');
  record(1, 'Tenant editor CANNOT upload under another tenant prefix',
    !!(await upload(editorA.client, objPath(F.tenantB, fDenyB))), 'cross-tenant upload denied (tenant-B files row exists; editor A lacks authority in B)');

  // Deny-targets: files rows that EXIST (created by authorized editor A) but have NO object yet, so the deny
  // is the storage policy's authority check — not "object already exists" and not "no files row".
  const fDenyA1 = randomUUID();
  const fDenyCentral = randomUUID();
  if (await insertFilesRow(editorA.client, editorA.userId, fDenyA1, F.tenantA, F.contractA1)) die('setup: editor A could not seed the contract-A1 deny-target row.');
  if (await insertFilesRow(editorA.client, editorA.userId, fDenyCentral, F.tenantA, F.contractACentral)) die('setup: editor A could not seed the contract-A-central deny-target row.');

  // (2) procurement-org manager: allowed where contract-write authority exists (A1), denied where not (A-central).
  const fProc = randomUUID();
  await insertFilesRow(procMgrA1.client, procMgrA1.userId, fProc, F.tenantA, F.contractA1); // org mgr can 0013-insert (definer-read later)
  const procAllowed = !(await upload(procMgrA1.client, objPath(F.tenantA, fProc)));
  const procDeniedElsewhere = !!(await upload(procMgrA1.client, objPath(F.tenantA, fDenyCentral)));
  record(2, 'Procurement-org manager uploads only where contract-write authority exists',
    procAllowed && procDeniedElsewhere, `allowed on own org contract=${procAllowed}, denied on other contract=${procDeniedElsewhere}`);

  // (3) paying-org manager denied upload (read != write).
  record(3, 'Paying-org manager is denied upload',
    !!(await upload(payingMgr.client, objPath(F.tenantA, fDenyCentral))), 'denied for the paying-org contract');

  // (4) tenant viewer denied upload.
  record(4, 'Tenant viewer is denied upload',
    !!(await upload(viewerA.client, objPath(F.tenantA, fDenyA1))), 'denied');

  // (5) cross-org manager denied upload (org they cannot write).
  record(5, 'Cross-org manager is denied upload',
    !!(await upload(crossMgr.client, objPath(F.tenantA, fDenyA1))), 'denied');

  // (6) tenant A cannot read or list tenant B prefix.
  const listB = await editorA.client.storage.from(BUCKET).list(`contracts/${F.tenantB}`);
  const dlB = await editorA.client.storage.from(BUCKET).download(objPath(F.tenantB, fB));
  record(6, 'Tenant A cannot read or list tenant B prefix',
    (listB.data?.length ?? 0) === 0 && !!dlB.error, `list empty + download denied`);

  // (7) tenant B cannot read, list, or sign a tenant A object.
  const listA = await editorB.client.storage.from(BUCKET).list(`contracts/${F.tenantA}`);
  const dlA = await editorB.client.storage.from(BUCKET).download(objPath(F.tenantA, fRead));
  const signA = await editorB.client.storage.from(BUCKET).createSignedUrl(objPath(F.tenantA, fRead), 60);
  record(7, 'Tenant B cannot read, list, or sign a tenant A object',
    (listA.data?.length ?? 0) === 0 && !!dlA.error && !!signA.error, 'list empty + download + signed-url denied');

  // (8) anonymous/public GET denied.
  const anon = anonClient();
  const anonDl = await anon.storage.from(BUCKET).download(objPath(F.tenantA, fRead));
  record(8, 'Anonymous/public GET is denied', !!anonDl.error, 'anon download denied (private bucket)');

  // (9) overwrite/upsert denied (no UPDATE policy).
  record(9, 'Overwrite/upsert is denied',
    !!(await upload(editorA.client, objPath(F.tenantA, fRead), { upsert: true })), 'upsert on existing object denied');

  // (10) move/copy/delete denied (no UPDATE/DELETE/FOR ALL policy).
  const mv = await editorA.client.storage.from(BUCKET).move(objPath(F.tenantA, fRead), objPath(F.tenantA, randomUUID()));
  const cp = await editorA.client.storage.from(BUCKET).copy(objPath(F.tenantA, fRead), objPath(F.tenantA, randomUUID()));
  const rm = await editorA.client.storage.from(BUCKET).remove([objPath(F.tenantA, fRead)]);
  const rmDenied = !!rm.error || (Array.isArray(rm.data) && rm.data.length === 0);
  record(10, 'Move/copy/delete are denied (no UPDATE/DELETE/FOR ALL policy)',
    !!mv.error && !!cp.error && rmDenied, `move denied=${!!mv.error}, copy denied=${!!cp.error}, delete denied=${rmDenied}`);

  // (11) signed URL (authorized) is short-lived + single-object scoped: a 60s TTL URL that encodes the one
  // object path (createSignedUrl is per-object; it grants no listing and no other object).
  const sign = await editorA.client.storage.from(BUCKET).createSignedUrl(objPath(F.tenantA, fRead), 60);
  const singleObject = !!sign.data?.signedUrl && sign.data.signedUrl.includes(`${F.tenantA}/${fRead}`);
  record(11, 'Signed URL is single-object scoped (TTL set to 60s via expiresIn)',
    !sign.error && singleObject, 'per-object signed URL issued; grants no listing or other object (60s expiresIn)');

  // (12) object path shape — CLIENT self-test only (the verifier always uses the canonical shape). Real
  // server-side shape enforcement is proven by check 13's denials, not here — so this is a note, NOT recorded
  // REST authorization evidence.
  console.log(`\n  (12) object path is the server-derived contracts/{tenant_id}/{file_id}.pdf shape — client self-test (server enforcement = check 13). shape ok: ${/^contracts\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/.test(objPath(F.tenantA, fRead))}`);

  // (13) client-supplied / bad-UUID-shaped paths fail closed.
  const badName = await upload(editorA.client, `contracts/${F.tenantA}/not-a-uuid.pdf`);
  const traversal = await upload(editorA.client, `contracts/${F.tenantA}/../escape.pdf`);
  record(13, 'Client-supplied / bad-UUID-shaped paths fail closed',
    !!badName && !!traversal, 'non-canonical and traversal paths denied');

  // (14) files table is the source of truth — upload to a path with NO files row is denied even for an authorized editor.
  record(14, 'Files table is the source of truth (no files row => upload denied)',
    !!(await upload(editorA.client, objPath(F.tenantA, randomUUID()))), 'authorized editor denied when no files row exists');

  // (15) local files-table RLS (0013) is verified separately by scripts/test-rls.sh (222) — see doc 26.
  console.log('\n  (15) files-table RLS (0013) unchanged — verify locally with scripts/test-rls.sh (expect 222). Not a REST check.');

  const failed = results.filter((r) => !r.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} REST checks passed.`);
  if (failed.length) {
    console.log(`  FAILED: ${failed.map((r) => r.num).join(', ')} — DO NOT record this as passing evidence.\n`);
    process.exit(1);
  }
  console.log('  All PRODUCTION Storage REST authorization checks passed. Record the evidence per doc 28 §J (a doc 23 / doc 25 copy).');
  console.log('  NOTE: a green production verifier does NOT close RISK-001 by itself and does NOT approve cutover —');
  console.log('  production apply + this verification + the doc 17 §5 cutover checklist must ALL pass. Cutover remains BLOCKED.\n');
}

main().catch((e) => die(e?.message ?? String(e)));
