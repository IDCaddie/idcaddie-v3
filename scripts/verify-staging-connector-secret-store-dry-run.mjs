#!/usr/bin/env node
// verify-staging-connector-secret-store-dry-run.mjs
//
// PREPARED, NOT RUN BY THE AGENT. A staging-ref-guarded gate that emits the NO-REAL-TOKEN connector-secret
// STORE-ADAPTER dry-run runbook a HUMAN operator executes to prove the PR #160 runner-backed connector_secrets
// store adapter can WRITE and LOAD a *synthetic* encrypted secret through the REAL hosted grant shape
// (`SET ROLE connector_runner`, the 0029/0030 column-scoped INSERT/SELECT) — WITHOUT ever using or printing a
// real provider token (docs/42 §79).
//
// SAFETY MODEL (identical to verify-staging-connector-vault-dry-run.mjs): this script connects to NOTHING and
// prints NO secret values. It performs NO hosted mutation itself — even the confirmed path only PRINTS an
// ordered runbook (parameterized psql commands referencing shell env VARS by name) that the operator runs and
// records. It never touches a connection string (which can carry an inline password).
//
// GUARANTEES (by construction — the script opens no DB/KMS/provider connection in ANY mode):
//   * refuses the PRODUCTION ref (dzbfxulvxchdemcettrx); requires the STAGING ref (ycdpzduxugdsffjqyoai);
//   * requires an explicit human confirmation phrase before emitting the runbook (default = refuse);
//   * requires every hosted secret/config via ENVIRONMENT VARIABLES (names only — values are NEVER read,
//     printed, or interpolated; the runbook prints the shell var, e.g. "$CONNECTOR_RUNNER_DB_URL");
//   * uses ONLY the clearly-synthetic non-secret payload "synthetic-vault-dry-run-not-a-token" — never a real
//     provider token; never exchanges an OAuth code; never calls a provider API; never uses a real Okta/Slack/
//     Google token;
//   * NEVER prints DB URLs, AWS secrets, KMS material, plaintext DEKs, ciphertext, AEAD tags, nonces, or wrapped
//     DEKs — the envelope bytes live only in the operator's shell vars and are bound as parameters;
//   * the runner WRITE/LOAD is the adapter's EXACT column shape (INSERT the 12 allowed columns; SELECT the
//     granted columns + active/non-expired filter); it adds NO grant and issues NO UPDATE on connector_secrets;
//   * cleanup is NARROW + SYNTHETIC-KEYED and runs on the SETUP/admin connection (the runner holds no DELETE
//     grant — and this PR does NOT add one): it deletes only the synthetic connector (its connector_secrets
//     cascade) + synthetic tenant by their synthetic ids;
//   * never makes the web/request runtime capable of decrypting — the unwrap/decrypt step runs only as the
//     runner with the runner's KMS Decrypt grant; the script never decrypts and exposes NO request path.
//
// A green human-run dry run is hosted evidence for the STORE-ADAPTER SHAPE with SYNTHETIC data only. It does NOT
// store a real credential, does NOT prove hosted KMS/IAM separation on its own, does NOT close RISK-001 or
// RISK-007, and does NOT unblock cutover. Real connector credential storage/use stays NOT allowed.

import { readFileSync } from "node:fs";

const STAGING_REF = "ycdpzduxugdsffjqyoai"; // the only permitted ref
const PRODUCTION_REF = "dzbfxulvxchdemcettrx"; // must NEVER be touched
const CONFIRM_PHRASE = "RUN CONNECTOR SECRET STORE STAGING DRY RUN";
// A clearly-synthetic, non-secret sentinel — NOT a token. The dry run wraps/loads only this.
const SYNTHETIC_PAYLOAD = "synthetic-vault-dry-run-not-a-token";

// Hosted secrets/config the human supplies via env (NAMES only — never read/printed here). DB connections are
// required (the runner login + an admin/setup conn for synthetic seed/cleanup); KMS is OPTIONAL (the full
// wrap/unwrap round-trip runs only when it is supplied — otherwise the DB grant-shape is exercised with a
// clearly-synthetic placeholder envelope).
const REQUIRED_ENV = ["CONNECTOR_RUNNER_DB_URL", "CONNECTOR_VAULT_SETUP_DB_URL"];
const OPTIONAL_ENV = ["CONNECTOR_VAULT_AWS_KMS_REGION", "CONNECTOR_VAULT_KMS_KEY_ID"];

const REF_FILE = process.env.CONNECTOR_SECRET_STORE_DRY_RUN_REF_FILE || "supabase/.temp/project-ref";

function die(msg, code = 2) {
  // Print only the static message — never an env value, URL, or secret.
  console.error(`\n  FATAL: ${msg}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`\n  verify-staging-connector-secret-store-dry-run — human-run NO-REAL-TOKEN store-adapter dry-run gate (docs/42 §79).\n
  This emits a runbook only. It connects to NOTHING, prints NO secret values, and performs NO hosted mutation.
  The agent never runs the hosted runbook; a human operator does, on staging (${STAGING_REF}).\n
  Usage:
    node scripts/verify-staging-connector-secret-store-dry-run.mjs            # default: refuse (no confirmation)
    node scripts/verify-staging-connector-secret-store-dry-run.mjs --help     # this help
    CONNECTOR_SECRET_STORE_DRY_RUN_CONFIRM="${CONFIRM_PHRASE}" \\
      CONNECTOR_RUNNER_DB_URL=... CONNECTOR_VAULT_SETUP_DB_URL=... \\
      node scripts/verify-staging-connector-secret-store-dry-run.mjs [--ref ${STAGING_REF}]   # emit the runbook\n
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

console.log(`\n  Connector-secret STORE-ADAPTER NO-REAL-TOKEN dry-run gate — staging ${STAGING_REF} (production ${PRODUCTION_REF} not touched).`);
console.log("  This script connects to nothing and prints no secrets. The hosted steps below are HUMAN-run.\n");

// ── Guard 2: require explicit human confirmation before emitting the runbook ─────────────────────────────────
if (process.env.CONNECTOR_SECRET_STORE_DRY_RUN_CONFIRM !== CONFIRM_PHRASE) {
  console.log("  [REFUSE] No confirmation. This gate emits the hosted store-adapter dry-run runbook only after");
  console.log("  explicit human confirmation. It performs NO hosted mutation itself and is NOT executed by the agent.");
  console.log(`  To emit the runbook, set CONNECTOR_SECRET_STORE_DRY_RUN_CONFIRM="${CONFIRM_PHRASE}" and provide the`);
  console.log(`  required env (names only): ${REQUIRED_ENV.join(", ")}.`);
  console.log("  It would then PRINT (not run) an ordered no-real-token runbook to: seed a synthetic tenant +");
  console.log("  connector; (optionally, if KMS env is set) KMS-wrap the synthetic sentinel into an envelope; WRITE");
  console.log("  the synthetic encrypted secret as connector_runner using the adapter's exact 12 allowed columns;");
  console.log("  LOAD it back via the adapter's active/non-expired SELECT shape; reconstruct the envelope; prove");
  console.log("  wrong tenant/connector/kind/version and expired/revoked rows return 0; then clean up narrowly.\n");
  console.log("  Real connector credential storage/use is still NOT allowed. RISK-001 remains OPEN. RISK-007 remains");
  console.log("  OPEN. Cutover remains BLOCKED.\n");
  process.exit(1);
}

// ── Guard 3: every required hosted env must be PRESENT (names only; values never read/printed) ───────────────
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  die(`confirmed, but missing required env (set these to non-empty values — they are never printed): ${missing.join(", ")}.`);
}

// ── Emit the NO-REAL-TOKEN store-adapter dry-run RUNBOOK (the operator runs each step; this script runs none) ─
// Synthetic namespace — clearly-fake ids so the dry run can never collide with real data; cleaned up narrowly.
const SYNTH_TENANT = "00000000-0000-0000-0000-0000000d8a70";    // synthetic "dryrun" tenant
const SYNTH_CONNECTOR = "00000000-0000-0000-0000-0000000d8a71"; // synthetic "dryrun" connector
const SYNTH_KEY_ID = "dryrun-kek-synthetic";                    // synthetic, non-secret key id (NOT KMS material)
const SYNTH_AAD_DIGEST = "dryrunsyntheticaaddigest";            // synthetic non-secret digest placeholder

console.log("  [RUNBOOK] no-real-token connector-secret STORE-ADAPTER dry run — human-executed; this script opens no connection.");
console.log("  Keep all URLs/secrets in your shell env only ($CONNECTOR_RUNNER_DB_URL etc.) — never commit/print them.");
console.log("  Bind the envelope bytes (ciphertext/dek_wrapped/aead_nonce/aead_tag) as PARAMETERS from your shell —");
console.log("  never echo them. Use only the synthetic sentinel; bind no real token-shaped value.\n");

console.log("  0) Preconditions: staging linked; connector_runner has ONLY the 0029/0030 COLUMN-scoped INSERT/SELECT");
console.log("     on connector_secrets (NO table-level, NO UPDATE/DELETE — T50/T51); (optional) KMS KEK alias +");
console.log(`     IAM (GenerateDataKey+Decrypt only). Payload is the synthetic sentinel "${SYNTHETIC_PAYLOAD}".\n`);

console.log("  1) SEED a synthetic tenant + connector (admin/setup conn $CONNECTOR_VAULT_SETUP_DB_URL; idempotent;");
console.log("     parameterized; synthetic namespace):");
console.log("       insert into public.tenants (id, name) values ($1, $2) on conflict (id) do nothing;");
console.log(`         -- bind $1='${SYNTH_TENANT}', $2='dryrun-synthetic-tenant'`);
console.log("       insert into public.connectors (id, tenant_id, provider, display_name, status)");
console.log("         values ($1, $2, $3, $4, $5) on conflict (id) do nothing;");
console.log(`         -- bind $1='${SYNTH_CONNECTOR}', $2='${SYNTH_TENANT}', $3='dryrun', $4='dryrun-synthetic', $5='active'\n`);

console.log("  2) (optional, only if KMS env is set) WRAP the synthetic sentinel via KMS — NO provider token:");
console.log("     a. GenerateDataKey on $CONNECTOR_VAULT_KMS_KEY_ID (region $CONNECTOR_VAULT_AWS_KMS_REGION) -> a");
console.log("        plaintext DEK + a wrapped (ciphertext) DEK [held in shell vars; NEVER printed];");
console.log(`     b. AES-256-GCM encrypt the synthetic sentinel "${SYNTHETIC_PAYLOAD}" under the DEK -> ciphertext`);
console.log("        + 16-byte GCM tag + 12-byte nonce [shell vars; NEVER printed]. If KMS env is NOT set, use a");
console.log("        clearly-synthetic placeholder envelope (e.g. 16 zero bytes for the tag) to exercise the DB");
console.log("        grant shape only (no decrypt).\n");

console.log("  3) WRITE via the runner-backed store adapter shape — as connector_runner ($CONNECTOR_RUNNER_DB_URL);");
console.log("     the adapter's EXACT 12 allowed columns; PARAMETERIZED; envelope bytes bound from step 2:");
console.log("       set role connector_runner;");
console.log("       insert into public.connector_secrets");
console.log("         (tenant_id, connector_id, secret_kind, version, ciphertext, dek_wrapped, aead_nonce,");
console.log("          aad_digest, key_id, aead_tag, envelope_version, aead_alg)");
console.log("         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id;");
console.log(`         -- bind $1='${SYNTH_TENANT}', $2='${SYNTH_CONNECTOR}', $3='api_key', $4=1,`);
console.log("         --      $5=ciphertext, $6=dek_wrapped, $7=aead_nonce, $10=aead_tag  (bytea, from step 2 — never printed),");
console.log(`         --      $8='${SYNTH_AAD_DIGEST}', $9='${SYNTH_KEY_ID}', $11=1, $12='AES-256-GCM'`);
console.log("       Expect: exactly 1 row id returned. (This proves the adapter writes ONLY the allowed columns.)\n");

console.log("  4) LOAD via the adapter SELECT shape — as connector_runner; PARAMETERIZED identity; active/non-expired:");
console.log("       select id, ciphertext, dek_wrapped, aead_nonce, aad_digest, key_id, aead_tag, envelope_version, aead_alg");
console.log("       from public.connector_secrets");
console.log("       where tenant_id=$1 and connector_id=$2 and secret_kind=$3 and version=$4");
console.log("         and status='active' and (expires_at is null or expires_at > now()) limit 2;");
console.log(`         -- bind $1='${SYNTH_TENANT}', $2='${SYNTH_CONNECTOR}', $3='api_key', $4=1`);
console.log("       Expect: exactly 1 row. RECONSTRUCT the envelope from the columns (the columnsToEncryptedSecret");
console.log("       mapping: ciphertext/dek_wrapped/aead_nonce/aead_tag/aad_digest/key_id/envelope_version/aead_alg).");
console.log("       (optional, only if KMS env is set) UNWRAP as the runner: KMS Decrypt the wrapped DEK -> DEK ->");
console.log("       decrypt the envelope -> assert it equals the synthetic sentinel. Print NO bytes / NO plaintext.\n");

console.log("  5) FAIL-CLOSED — as connector_runner, re-run the step-4 SELECT with each WRONG value; expect 0 rows EACH:");
console.log("       wrong tenant_id; wrong connector_id; wrong secret_kind; wrong version.");
console.log("  6) EXPIRED/REVOKED excluded — seed (setup conn) a second synthetic secret with expires_at = now() -");
console.log("       interval '1 day', and a third with status='revoked'; the step-4 active/non-expired SELECT returns");
console.log("       NEITHER (0 rows for each). (This proves LOAD returns only active, non-expired rows.)\n");

console.log("  7) CLEAN UP (setup conn) — NARROW, synthetic-keyed ONLY (the runner holds no DELETE grant; do NOT add");
console.log("     one). Deleting the synthetic connector cascades its connector_secrets; then the synthetic tenant:");
console.log("       delete from public.connector_secrets where tenant_id = $1 and key_id like 'dryrun-kek-%';");
console.log(`         -- bind $1='${SYNTH_TENANT}'   (synthetic tenant + synthetic key prefix only)`);
console.log("       delete from public.connectors where id = $1 and tenant_id = $2;");
console.log(`         -- bind $1='${SYNTH_CONNECTOR}', $2='${SYNTH_TENANT}'`);
console.log("       delete from public.tenants where id = $1;");
console.log(`         -- bind $1='${SYNTH_TENANT}'\n`);

console.log("  8) RECORD evidence (a docs-only verification PR): PASS/FAIL per step 3-6, with NO secrets/URLs/DEKs/");
console.log("     ciphertext/tags/nonces printed. Nothing real was stored; no token was exchanged; no provider was called.\n");

console.log("  The verifier is human-run only; the agent did not run hosted commands. This proves the STORE-ADAPTER");
console.log("  SHAPE with SYNTHETIC data only — it does NOT store a real credential and, on its own, does NOT prove");
console.log("  hosted KMS/IAM separation. Real connector credential storage/use is still NOT allowed. RISK-001 remains");
console.log("  OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.\n");
process.exit(0);
