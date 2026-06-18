#!/usr/bin/env node
// verify-staging-storage-rest.mjs
//
// STAGING-ONLY Storage REST API authorization verifier for the private `contract-files` bucket.
// Proves the `storage.objects` policies (docs/22 §5) behave correctly through the REAL Supabase
// Storage REST API with USER-SCOPED JWTs — not just pg_policies inspection. See docs/26 for the
// runbook, the one-time admin fixture setup, env vars, and the evidence template.
//
// SAFETY (enforced below):
//   * Refuses to run unless the linked project ref (supabase/.temp/project-ref) is the staging ref,
//     and the target URL is the staging ref and NOT the production ref.
//   * USER-SCOPED ONLY: uses the public anon key + signs in as synthetic staging users. NEVER a
//     service-role key (that belongs only in the one-time admin fixture step, run separately — doc 26).
//   * Reads secrets (anon key, synthetic-user passwords) from LOCAL env vars only. Commits no secret;
//     prints no token/password. Fail-loud if any required env var is missing.
//   * Touches staging synthetic data only. Does not touch production.
//
// This script does NOT close RISK-001 and does NOT make upload "ready". Running it green is the
// REST-authz evidence that, once recorded (doc 25 / a doc 23 copy), lets RISK-001 criterion 2 advance.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const STAGING_REF = 'ycdpzduxugdsffjqyoai';
const PRODUCTION_REF = 'dzbfxulvxchdemcettrx'; // must NEVER be the target
const BUCKET = 'contract-files';

// ── Synthetic staging fixtures (non-secret IDs; created by the one-time admin step — doc 26) ──────
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

// ── Guard 1: linked project ref must be staging ───────────────────────────────────────────────────
let linkedRef = '';
try {
  linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim();
} catch {
  die('supabase/.temp/project-ref not found. Link the STAGING project first (supabase link --project-ref ' + STAGING_REF + ').');
}
if (linkedRef !== STAGING_REF) {
  die(`linked project ref is "${linkedRef}", refusing to run. This verifier runs ONLY against staging (${STAGING_REF}). Never production (${PRODUCTION_REF}).`);
}

// ── Guard 2: required local env vars ──────────────────────────────────────────────────────────────
const URL = process.env.STAGING_SUPABASE_URL;
const ANON = process.env.STAGING_SUPABASE_ANON_KEY;
const USERS_JSON = process.env.STAGING_STORAGE_TEST_USERS;
if (!URL) die('missing env STAGING_SUPABASE_URL (staging project URL).');
if (!ANON) die('missing env STAGING_SUPABASE_ANON_KEY (staging publishable anon key — local only, not committed).');
if (!USERS_JSON) die('missing env STAGING_STORAGE_TEST_USERS (JSON of synthetic-user {email,password} — local only, not committed).');

// ── Guard 3: target URL must be the staging ref, never production ─────────────────────────────────
if (!URL.includes(STAGING_REF)) {
  die(`STAGING_SUPABASE_URL ("${URL}") is not the staging project (${STAGING_REF}). Refusing.`);
}
if (URL.includes(PRODUCTION_REF)) {
  die(`STAGING_SUPABASE_URL points at the PRODUCTION ref (${PRODUCTION_REF}). Refusing — production must not be touched.`);
}

let USERS;
try {
  USERS = JSON.parse(USERS_JSON);
} catch {
  die('STAGING_STORAGE_TEST_USERS is not valid JSON.');
}
const REQUIRED_ROLES = ['tenantEditorA', 'procMgrA1', 'payingMgr', 'tenantViewerA', 'crossOrgMgr', 'tenantEditorB'];
for (const r of REQUIRED_ROLES) {
  if (!USERS[r]?.email || !USERS[r]?.password) {
    die(`STAGING_STORAGE_TEST_USERS is missing { email, password } for role "${r}".`);
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
  console.log(`\n  Staging Storage REST verifier — project ref ${STAGING_REF} (linked-ref + URL confirmed staging, not production)\n`);

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
  console.log('  All staging Storage REST authorization checks passed. Record the evidence per doc 25 / doc 26.\n');
}

main().catch((e) => die(e?.message ?? String(e)));
