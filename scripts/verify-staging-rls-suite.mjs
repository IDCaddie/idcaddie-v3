#!/usr/bin/env node
// verify-staging-rls-suite.mjs
//
// PREPARED, NOT RUN. A staging-ref-guarded gate for running the full org_rls_test.sql RLS suite against a
// HOSTED Postgres — the "full RLS suite re-run against hosted" sub-task of doc 17 §5 boxes 5/8. It does NOT run
// the suite against the shared staging project: by design it DETECTS the suite's destructive fixture statements
// and REFUSES, because raw execution against shared hosted staging is unsafe even in a rollback transaction.
// This script connects to NOTHING — even the disposable-isolated opt-in only PRINTS a runbook a human executes.
//
// ── WHY (analysis of scripts/test-rls.sh + supabase/tests/org_rls_test.sql) ─────────────────────────────────
// test-rls.sh applies migrations to a THROWAWAY postgres:16 docker container and runs the suite via
// `psql ... ON_ERROR_STOP=1` (NOT --single-transaction). It relies on the container being DISPOSABLE, not on
// rollback. The suite's fixture setup (org_rls_test.sql lines ~20-29) is destructive:
//   * `reset role; truncate table <17 core tables incl. public.audit_logs> restart identity cascade;`
//   * `delete from auth.users;`  (then re-inserts synthetic auth.users + all fixture rows)
//   * plus ~116 INSERT / ~77 UPDATE / ~70 DELETE statements and `set role authenticated|service_role`.
//
// Against SHARED hosted staging this is unsafe EVEN wrapped in a single rollback-only transaction:
//   1. TRUNCATE includes public.audit_logs. TRUNCATE fires a STATEMENT-level trigger event that the row-level
//      `reject_audit_mutation()` (0002, BEFORE INSERT/UPDATE/DELETE) does NOT cover — so it WOULD wipe
//      append-only audit history (the data PR #69 proved is protected from DELETE). RESTART IDENTITY CASCADE
//      can also cascade beyond the listed tables.
//   2. `delete from auth.users` mutates the Supabase-managed auth schema and needs elevated privilege.
//   3. TRUNCATE takes ACCESS EXCLUSIVE locks on 17 LIVE tables — it blocks the live staging app for the txn
//      duration even though the txn rolls back.
//   4. `set role authenticated|service_role` + the privileged TRUNCATE/auth-delete require a near-superuser
//      connection to the shared project — a large, unacceptable risk surface on a shared environment.
// => Rollback-only execution of the RAW suite against the SHARED staging project is NOT safe. This gate refuses.
//
// ── SAFE ALTERNATE (run the suite hosted without risk to shared staging) ────────────────────────────────────
// Use a DEDICATED, DISPOSABLE, ISOLATED hosted Postgres — a separate scratch Supabase project or a Supabase
// branch DB — seeded fresh, the suite run rollback-only, then disposed. That is the hosted equivalent of the
// local throwaway container: TRUNCATE/auth-wipe/reload is acceptable there because the project IS disposable and
// is NEVER the shared staging project (`ycdpzduxugdsffjqyoai`) and NEVER production (`dzbfxulvxchdemcettrx`).
//
// This script intentionally does NOT open a DB connection itself, because:
//   * a connection string can carry an inline password — passing it to a child process risks leaking it via an
//     argv/stack trace on any failure (the script must print NO secrets/URLs/passwords); and
//   * a URL substring check cannot PROVE the target is a disposable project rather than the shared one reached
//     by an alias / resolved IP / mixed-case host — only connecting and asserting a disposable-identity marker
//     can, which is the human operator's responsibility on the disposable project they created.
// So the opt-in path emits a RUNBOOK (rollback-only psql + count-snapshot) for a human to run + dispose.
//
// SAFETY: hard-refuses unless the linked ref is staging `ycdpzduxugdsffjqyoai`; hard-refuses if the linked ref
// is production `dzbfxulvxchdemcettrx`; connects to nothing; prints no secrets. Run only by a human; this PR
// does not run it. A green disposable-isolated run is hosted-RLS evidence; it does NOT close RISK-001 or approve
// cutover.

import { readFileSync } from 'node:fs';

const STAGING_REF = 'ycdpzduxugdsffjqyoai';      // the only permitted linked ref
const PRODUCTION_REF = 'dzbfxulvxchdemcettrx';   // must NEVER be touched
const SUITE = 'supabase/tests/org_rls_test.sql';

// Tables whose row counts the disposable-isolated run snapshots pre/post to prove rollback-only left no residue.
const KEY_TABLES = [
  'tenants', 'profiles', 'organizations', 'tenant_memberships', 'organization_memberships',
  'apps', 'contracts', 'app_contracts', 'app_users', 'people', 'identity_accounts',
  'app_user_identity_matches', 'files', 'invoices', 'license_rules', 'license_evaluations', 'audit_logs',
];
// Destructive / state-mutating fixture statements that make raw execution against shared staging unsafe.
const DESTRUCTIVE = [
  { re: /\btruncate\s+table\b/i, name: 'TRUNCATE (incl. public.audit_logs — bypasses the row-level audit immutability trigger)' },
  { re: /\bdelete\s+from\s+auth\.users\b/i, name: 'DELETE FROM auth.users (wipes all Supabase Auth users)' },
  { re: /\binsert\s+into\s+auth\.users\b/i, name: 'INSERT INTO auth.users (managed auth schema)' },
];

function die(msg, code = 2) { console.error(`\n  FATAL: ${msg}\n`); process.exit(code); }

// ── Guard 1: linked project ref must be staging, never production ───────────────────────────────────────────
let linkedRef = '';
try { linkedRef = readFileSync('supabase/.temp/project-ref', 'utf8').trim(); }
catch { die(`supabase/.temp/project-ref not found. Link STAGING first (supabase link --project-ref ${STAGING_REF}).`); }
if (linkedRef === PRODUCTION_REF) die(`linked project ref is PRODUCTION (${PRODUCTION_REF}). Refusing — production must not be touched.`);
if (linkedRef !== STAGING_REF) die(`linked project ref is "${linkedRef}", refusing. This gate runs ONLY with staging linked (${STAGING_REF}).`);

// ── Scan the suite for destructive fixture statements ───────────────────────────────────────────────────────
let sql = '';
try { sql = readFileSync(SUITE, 'utf8'); } catch { die(`could not read ${SUITE}.`); }
const found = DESTRUCTIVE.filter((d) => d.re.test(sql)).map((d) => d.name);

console.log(`\n  Hosted-staging RLS suite gate — linked ref ${STAGING_REF} (production ${PRODUCTION_REF} not touched)\n`);

if (process.env.RLS_RUN_TARGET !== 'disposable-isolated') {
  // ── DEFAULT: refuse to run the raw destructive suite against the shared staging project ───────────────────
  console.log('  [REFUSE] Raw org_rls_test.sql must NOT be run directly against hosted staging.');
  console.log('  Hosted staging RLS execution is prepared but not yet run. The suite contains destructive fixture');
  console.log('  setup that is unsafe against the shared staging project even in a rollback-only transaction:');
  for (const f of found) console.log(`    - ${f}`);
  console.log('\n  Safe path: run it against a DEDICATED DISPOSABLE/ISOLATED hosted project (a separate scratch');
  console.log('  Supabase project or a Supabase branch DB — never the shared staging project, never production).');
  console.log('  Re-invoke with RLS_RUN_TARGET=disposable-isolated to print the rollback-only runbook to execute');
  console.log('  there (this script connects to nothing and prints no secrets).');
  console.log('\n  RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready.\n');
  process.exit(1);
}

// ── OPT-IN: emit the disposable-isolated RUNBOOK (a human runs it; this script connects to NOTHING) ──────────
const snapshot = KEY_TABLES.map((t) => `select '${t}' tbl, count(*) n from public.${t}`).join(' union all ');
console.log('  [RUNBOOK] disposable-isolated hosted RLS run — human-executed; this script opens no connection.\n');
console.log('  Preconditions (the operator must guarantee, since a URL alias/IP/case cannot prove identity):');
console.log(`    - a DEDICATED DISPOSABLE Supabase project/branch — NOT ${STAGING_REF}, NOT ${PRODUCTION_REF};`);
console.log('    - you can prove it is disposable (it holds no real data) BEFORE running; migrations are applied;');
console.log('    - keep its connection string in your shell only ($RLS_DISPOSABLE_DB_URL) — never commit/print it.');
console.log('\n  1) Snapshot key-table counts (record audit_logs especially):');
console.log(`       psql "$RLS_DISPOSABLE_DB_URL" -tAqc "${snapshot}"`);
console.log('\n  2) Run the suite ROLLBACK-ONLY (begin … rollback; never commit):');
console.log(`       psql "$RLS_DISPOSABLE_DB_URL" -v ON_ERROR_STOP=1 -c "begin;" -f ${SUITE} -c "rollback;"`);
console.log('\n  3) Re-snapshot and PASS only if: every assertion passed (step 2 exit 0), post counts == pre counts');
console.log('     for all key tables, audit_logs count unchanged, and nothing was committed.');
console.log('\n  4) Dispose the project/branch. Record evidence (PASS/FAIL + table by table; NO secrets/URLs).');
console.log('\n  RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready.\n');
process.exit(0);
