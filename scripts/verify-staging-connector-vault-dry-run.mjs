#!/usr/bin/env node
// verify-staging-connector-vault-dry-run.mjs
//
// PREPARED, NOT RUN BY THE AGENT. A staging-ref-guarded gate that emits the NO-REAL-TOKEN connector-vault
// dry-run runbook a HUMAN operator executes to prove the hosted runner DB connection (as `connector_runner`)
// and the AWS KMS path work — WITHOUT storing any real provider credential (the §43.4 checklist, doc 42).
//
// SAFETY MODEL (identical to verify-staging-rls-suite.mjs): this script connects to NOTHING and prints NO
// secret values. It performs NO hosted mutation itself — even the confirmed path only PRINTS an ordered
// runbook (parameterized psql / KMS commands referencing shell env VARS by name) that the operator runs and
// records. A connection string can carry an inline password; passing it to a child process risks leaking it
// via argv / a stack trace — so the script never touches one. The agent runs only `node --check` + the
// mock-only guard tests; the agent never runs the hosted runbook and never mutates staging.
//
// GUARANTEES (by construction — the script opens no DB/KMS/provider connection in ANY mode):
//   * refuses the PRODUCTION ref (dzbfxulvxchdemcettrx); requires the STAGING ref (ycdpzduxugdsffjqyoai),
//     from the linked file or an explicit --ref;
//   * requires an explicit human confirmation phrase before emitting the hosted runbook (default = refuse);
//   * requires every hosted secret/config via ENVIRONMENT VARIABLES (names only — values are NEVER read,
//     printed, or interpolated; the runbook prints the shell var, e.g. "$CONNECTOR_RUNNER_DB_URL");
//   * uses ONLY the clearly-synthetic non-secret payload "synthetic-vault-dry-run-not-a-token" — never a
//     real provider token; never exchanges an OAuth code; never calls a provider API;
//   * runs NO hosted INSERT/UPDATE/DELETE against connector_secrets — step 5 PROVES the runner's narrow
//     COLUMN-scoped grant (0029) via READ-ONLY catalog inspection + a read-only SELECT only (the runner can
//     read/write ciphertext/envelope columns ONLY through the runner path, and cannot update/delete; the
//     request-path stays denied). The only synthetic setup is one oauth_pending row in a synthetic namespace,
//     cleaned up narrowly (no broad delete).
//
// A green human-run dry run is hosted evidence; it does NOT store real credentials, does NOT close RISK-001,
// and does NOT unblock cutover. The connector vault stays NOT usable for real credentials until this is run.

import { readFileSync } from "node:fs";

const STAGING_REF = "ycdpzduxugdsffjqyoai"; // the only permitted ref
const PRODUCTION_REF = "dzbfxulvxchdemcettrx"; // must NEVER be touched
const CONFIRM_PHRASE = "RUN CONNECTOR VAULT STAGING DRY RUN";
// A clearly-synthetic, non-secret sentinel — NOT a token. The dry run wraps/unwraps and consumes only this.
const SYNTHETIC_PAYLOAD = "synthetic-vault-dry-run-not-a-token";

// Hosted secrets/config the human supplies via env (NAMES only — never read/printed here). The script does
// not open these; it prints a runbook that references them by shell-var name for the operator's shell.
const REQUIRED_ENV = ["CONNECTOR_RUNNER_DB_URL", "CONNECTOR_VAULT_AWS_KMS_REGION", "CONNECTOR_VAULT_KMS_KEY_ID"];
const OPTIONAL_ENV = ["CONNECTOR_VAULT_SETUP_DB_URL", "CONNECTOR_OAUTH_STATE_SECRET"];

const REF_FILE = process.env.CONNECTOR_VAULT_DRY_RUN_REF_FILE || "supabase/.temp/project-ref";

function die(msg, code = 2) {
  // Print only the static message — never an env value, URL, or secret.
  console.error(`\n  FATAL: ${msg}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`\n  verify-staging-connector-vault-dry-run — human-run NO-REAL-TOKEN connector-vault dry-run gate (doc 42 §43.4).\n
  This emits a runbook only. It connects to NOTHING, prints NO secret values, and performs NO hosted mutation.
  The agent never runs the hosted runbook; a human operator does, on staging (${STAGING_REF}).\n
  Usage:
    node scripts/verify-staging-connector-vault-dry-run.mjs            # default: refuse (no confirmation)
    node scripts/verify-staging-connector-vault-dry-run.mjs --help     # this help
    CONNECTOR_VAULT_DRY_RUN_CONFIRM="${CONFIRM_PHRASE}" \\
      CONNECTOR_RUNNER_DB_URL=... CONNECTOR_VAULT_AWS_KMS_REGION=... CONNECTOR_VAULT_KMS_KEY_ID=... \\
      node scripts/verify-staging-connector-vault-dry-run.mjs [--ref ${STAGING_REF}]   # emit the runbook\n
  Requires the linked ref (or --ref) to be staging ${STAGING_REF}; refuses production ${PRODUCTION_REF}.
  Hosted secrets/config come ONLY from env vars (never hardcoded, never printed): ${[...REQUIRED_ENV, ...OPTIONAL_ENV].join(", ")}.
  The dry run uses the synthetic non-secret payload "${SYNTHETIC_PAYLOAD}" — never a real provider token.\n`);
  process.exit(0);
}

// ── Guard 1: resolve the target ref (explicit --ref overrides the linked file) and refuse production ─────────
const refArgIdx = argv.indexOf("--ref");
let ref = refArgIdx >= 0 ? (argv[refArgIdx + 1] || "").trim() : "";
if (!ref) {
  try {
    ref = readFileSync(REF_FILE, "utf8").trim();
  } catch {
    die(`no ${REF_FILE} and no --ref. Link STAGING first (supabase link --project-ref ${STAGING_REF}) or pass --ref ${STAGING_REF}.`);
  }
}
if (ref === PRODUCTION_REF) die(`target ref is PRODUCTION (${PRODUCTION_REF}). REFUSED — production must not be touched.`);
if (ref !== STAGING_REF) die(`target ref is "${ref}", refusing. This dry-run gate runs ONLY against staging (${STAGING_REF}).`);

console.log(`\n  Connector-vault NO-REAL-TOKEN dry-run gate — staging ${STAGING_REF} (production ${PRODUCTION_REF} not touched).`);
console.log("  This script connects to nothing and prints no secrets. The hosted steps below are HUMAN-run.\n");

// ── Guard 2: require explicit human confirmation before emitting the hosted runbook ─────────────────────────
if (process.env.CONNECTOR_VAULT_DRY_RUN_CONFIRM !== CONFIRM_PHRASE) {
  console.log("  [REFUSE] No confirmation. This gate emits the hosted dry-run runbook only after explicit human");
  console.log(`  confirmation. It performs NO hosted mutation itself and is NOT executed by the agent.`);
  console.log(`  To emit the runbook, set CONNECTOR_VAULT_DRY_RUN_CONFIRM="${CONFIRM_PHRASE}" and provide the`);
  console.log(`  required env (names only): ${REQUIRED_ENV.join(", ")}.`);
  console.log("  It would then PRINT (not run) an ordered no-real-token runbook to: seed one synthetic oauth_pending");
  console.log("  row; consume it exactly once as connector_runner; prove a second consume + every mismatch yields 0");
  console.log("  rows; verify connector_runner's narrow COLUMN-scoped connector_secrets grant (SELECT/INSERT on the");
  console.log("  identity/envelope columns only; NO table-level, NO UPDATE/DELETE) via read-only catalog + a read-only");
  console.log("  SELECT; prove oauth_pending + connector_secrets stay deny-all to anon/authenticated; wrap/unwrap the");
  console.log("  synthetic payload via KMS; then clean up.\n");
  console.log("  Connector vault is still not usable for real credentials until the human-run staging dry run is");
  console.log("  executed and recorded. RISK-001 remains OPEN. Cutover remains BLOCKED.\n");
  process.exit(1);
}

// ── Guard 3: every required hosted env must be PRESENT (names only; values never read/printed) ───────────────
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  die(`confirmed, but missing required env (set these to non-empty values — they are never printed): ${missing.join(", ")}.`);
}

// ── Emit the NO-REAL-TOKEN dry-run RUNBOOK (the operator runs each step; this script runs none of it) ────────
// Synthetic namespace — clearly-fake ids so the dry run can never collide with real data; cleaned up narrowly.
const SYNTH_TENANT = "00000000-0000-0000-0000-0000000d8a70"; // synthetic "dryrun" tenant
const SYNTH_JTI = "dryrun-state-jti"; // synthetic correlation id (a fixed synthetic value, not a real state)
// nonce_hash = a fixed synthetic sha256-shaped hex of the synthetic payload (the operator may recompute it).
const SYNTH_NONCE_HASH = "0000000000000000000000000000000000000000000000000000000000d8a700";

console.log("  [RUNBOOK] no-real-token connector-vault dry run — human-executed; this script opens no connection.");
console.log("  Keep all URLs/secrets in your shell env only ($CONNECTOR_RUNNER_DB_URL etc.) — never commit/print them.\n");

console.log("  0) Preconditions: staging linked; the runner DB role connector_runner exists with oauth_pending");
console.log("     SELECT + UPDATE(consumed_at,attempt_count,last_rejected_code) (0021/T43) AND the COLUMN-scoped");
console.log("     connector_secrets grant from 0029 (SELECT/INSERT on the identity+envelope columns only; NO");
console.log("     table-level, NO UPDATE/DELETE — T50/§41); KMS KEK alias + IAM (GenerateDataKey+Decrypt only)");
console.log(`     provisioned. Payload is the synthetic sentinel "${SYNTHETIC_PAYLOAD}".\n`);

console.log("  1) SEED one synthetic oauth_pending row (admin/setup conn $CONNECTOR_VAULT_SETUP_DB_URL; idempotent):");
console.log(`       insert into public.oauth_pending (tenant_id, provider, state_jti, nonce_hash, intent, expires_at)`);
console.log(`       values ('${SYNTH_TENANT}','dryrun','${SYNTH_JTI}','${SYNTH_NONCE_HASH}','connect', now() + interval '10 min')`);
console.log(`       on conflict (state_jti) do nothing;   -- synthetic namespace; NOT a real tenant/provider\n`);

console.log("  2) CONSUME exactly once as connector_runner ($CONNECTOR_RUNNER_DB_URL) — expect EXACTLY 1 row:");
console.log(`       update public.oauth_pending set consumed_at = now()`);
console.log(`        where state_jti='${SYNTH_JTI}' and nonce_hash='${SYNTH_NONCE_HASH}' and tenant_id='${SYNTH_TENANT}'`);
console.log(`          and provider='dryrun' and connector_id is not distinct from null`);
console.log(`          and consumed_at is null and expires_at > now() returning state_jti;\n`);

console.log("  3) SECOND consume (re-run step 2 verbatim) — expect 0 rows (single-use).");
console.log("  4) MISMATCH consumes (re-seed a fresh synthetic row, then try each) — expect 0 rows EACH:");
console.log("       wrong nonce_hash; wrong tenant_id; wrong provider; wrong state_jti.");
console.log("  5) RUNNER connector_secrets grant surface — READ-ONLY catalog + a read-only SELECT only (this runbook");
console.log("       runs NO hosted INSERT/UPDATE/DELETE against connector_secrets):");
console.log("       a. as connector_runner, verify the COLUMN-scoped 0029 grant via the catalog (read-only):");
console.log("            select privilege_type, column_name from information_schema.role_column_grants");
console.log("             where grantee='connector_runner' and table_name='connector_secrets' order by 1,2;");
console.log("          expect SELECT on (id,tenant_id,connector_id,secret_kind,version,status,expires_at,");
console.log("          ciphertext,dek_wrapped,aead_nonce,aad_digest,key_id) and INSERT on (tenant_id,connector_id,");
console.log("          secret_kind,version,ciphertext,dek_wrapped,aead_nonce,aad_digest,key_id); and");
console.log("          has_table_privilege('connector_runner','public.connector_secrets','SELECT') is FALSE");
console.log("          (column-only); and the runner has NO UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER.");
console.log("       b. read-only proof (touches no rows): as connector_runner");
console.log("            select id, ciphertext from public.connector_secrets limit 0;   -- granted columns -> OK");
console.log("            select created_at from public.connector_secrets limit 0;       -- non-granted -> permission denied");
console.log("          The runner can read/write ciphertext/envelope columns ONLY through the runner path; it");
console.log("          cannot update, delete, revoke, rotate, truncate, reference, or trigger.");
console.log("  6) DENY-ALL holds — as anon AND as authenticated: any select/update on public.oauth_pending and");
console.log("       public.connector_secrets is permission denied (zero privilege, zero policies — T39/T42/T43/T50/§41).\n");

console.log("  7) KMS wrap/unwrap of the SYNTHETIC payload (runner IAM; region $CONNECTOR_VAULT_AWS_KMS_REGION,");
console.log("     KEK alias $CONNECTOR_VAULT_KMS_KEY_ID) — NO provider token involved:");
console.log("       a. GenerateDataKey on the KEK alias → a plaintext DEK + a wrapped (ciphertext) DEK;");
console.log(`       b. encrypt the synthetic sentinel "${SYNTHETIC_PAYLOAD}" under the DEK (envelope);`);
console.log("       c. Decrypt the wrapped DEK → unwrap → decrypt the envelope → assert it equals the sentinel.");
console.log("       (Only kms:GenerateDataKey + kms:Decrypt are used; no kms:* / Resource:* ; no AWS keys in repo.)\n");

console.log(`  8) CLEAN UP (setup conn) — narrow delete by the synthetic key ONLY (never a broad delete):`);
console.log(`       delete from public.oauth_pending where state_jti like 'dryrun-%' and tenant_id='${SYNTH_TENANT}';\n`);

console.log("  9) RECORD evidence (a docs-only verification PR): PASS/FAIL per step 1–7, table by table. Print NO");
console.log("     secrets/URLs/DEKs/ciphertext. Nothing was written to connector_secrets; no token was exchanged.\n");

console.log("  The verifier is human-run only; the agent did not run hosted commands. Connector vault is still not");
console.log("  usable for real credentials: live decrypt is still blocked on real hosted KMS/IAM grant separation");
console.log("  (runner has kms:Decrypt, the web/request-path identity does not) — remaining RISK-007 work, along");
console.log("  with audit, revocation/rotation, staging+production verification, and live token storage.");
console.log("  RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.\n");
process.exit(0);
