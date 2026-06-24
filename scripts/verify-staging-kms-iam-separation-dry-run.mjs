#!/usr/bin/env node
// verify-staging-kms-iam-separation-dry-run.mjs
//
// PREPARED, NOT RUN BY THE AGENT. A staging-ref-guarded gate that emits the SYNTHETIC-ONLY hosted KMS/IAM
// SEPARATION dry-run runbook a HUMAN operator executes to prove the key remaining RISK-007 boundary: that the
// hosted RUNNER runtime can KMS-decrypt and the WEB/REQUEST runtime CANNOT (docs/42 §81) — using only synthetic
// material, never a real connector credential.
//
// THIS IS A KMS/IAM TEST ONLY. It touches NO database, writes NO connector_secrets row, and broadens NO
// connector_runner DB grant. It is purely about whether two distinct hosted IAM identities have (runner) /
// lack (web) the `kms:Decrypt` capability on the vault KEK.
//
// SAFETY MODEL (identical to verify-staging-connector-secret-store-dry-run.mjs): this script connects to
// NOTHING and prints NO secret values. It performs NO hosted action itself — even the confirmed path only
// PRINTS an ordered runbook (AWS CLI / KMS commands referencing shell env VARS by name) that the operator runs
// and records. It never touches a connection string, an AWS credential, or KMS key material.
//
// GUARANTEES (by construction — the script opens no KMS/AWS/DB/provider connection in ANY mode):
//   * refuses the PRODUCTION ref (dzbfxulvxchdemcettrx); requires the STAGING ref (ycdpzduxugdsffjqyoai);
//   * requires an explicit human confirmation phrase before emitting the runbook (default = refuse);
//   * requires every hosted identity/config via ENVIRONMENT VARIABLES (names only — values are NEVER read,
//     printed, or interpolated; the runbook prints the shell var, e.g. "$CONNECTOR_VAULT_RUNNER_AWS_PROFILE");
//   * uses ONLY the clearly-synthetic non-secret plaintext "synthetic-kms-dry-run-not-a-token" — never a real
//     provider token; never exchanges an OAuth code; never calls a provider API;
//   * NEVER prints plaintext after creation, ciphertext, data keys, wrapped DEKs, KMS response bodies, DB URLs,
//     env values, or any key material — the operator keeps those in shell vars / restricted files and only
//     records PASS/FAIL + an error CLASS (e.g. "AccessDenied");
//   * the load-bearing test is the NEGATIVE: the WEB/REQUEST identity attempting `kms:Decrypt` MUST be DENIED.
//     If it succeeds, the separation is BROKEN — a RISK-007 finding, recorded as FAIL;
//   * it does NOT grant the web/request runtime decrypt capability and adds NO public route to secrets.
//
// A green human-run dry run is hosted evidence for the KMS/IAM DECRYPT SEPARATION with SYNTHETIC material only.
// It does NOT, on its own, close RISK-007: audited secret access/use, revocation/rotation, and the full
// credential lifecycle remain. Real connector credential storage/use stays NOT allowed.

import { readFileSync } from "node:fs";

const STAGING_REF = "ycdpzduxugdsffjqyoai"; // the only permitted ref
const PRODUCTION_REF = "dzbfxulvxchdemcettrx"; // must NEVER be touched
const CONFIRM_PHRASE = "RUN KMS IAM SEPARATION STAGING DRY RUN";
// A clearly-synthetic, non-secret plaintext — NOT a token. The dry run wraps/decrypts only this.
const SYNTHETIC_PLAINTEXT = "synthetic-kms-dry-run-not-a-token";

// Hosted identity/config the human supplies via env (NAMES only — never read/printed here): the KMS region +
// KEK, and the TWO DISTINCT hosted IAM identities — the RUNNER identity (must have kms:Decrypt on the KEK) and
// the WEB/REQUEST identity (must NOT have kms:Decrypt on the KEK).
const REQUIRED_ENV = [
  "CONNECTOR_VAULT_AWS_KMS_REGION",
  "CONNECTOR_VAULT_KMS_KEY_ID",
  "CONNECTOR_VAULT_RUNNER_AWS_PROFILE",
  "CONNECTOR_VAULT_WEB_AWS_PROFILE",
];

const REF_FILE = process.env.CONNECTOR_VAULT_KMS_IAM_DRY_RUN_REF_FILE || "supabase/.temp/project-ref";

function die(msg, code = 2) {
  // Print only the static message — never an env value, ARN, URL, or key material.
  console.error(`\n  FATAL: ${msg}\n`);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`\n  verify-staging-kms-iam-separation-dry-run — human-run SYNTHETIC-ONLY hosted KMS/IAM separation gate (docs/42 §81).\n
  This emits a runbook only. It connects to NOTHING, prints NO secret values, and performs NO hosted action.
  The agent never runs the hosted runbook; a human operator does, on staging (${STAGING_REF}).\n
  It proves the key remaining RISK-007 boundary with SYNTHETIC material only: the RUNNER runtime CAN kms:Decrypt
  and the WEB/REQUEST runtime CANNOT. It does NOT close RISK-007 and stores NO real credential.\n
  Usage:
    node scripts/verify-staging-kms-iam-separation-dry-run.mjs            # default: refuse (no confirmation)
    node scripts/verify-staging-kms-iam-separation-dry-run.mjs --help     # this help
    CONNECTOR_VAULT_KMS_IAM_DRY_RUN_CONFIRM="${CONFIRM_PHRASE}" \\
      CONNECTOR_VAULT_AWS_KMS_REGION=... CONNECTOR_VAULT_KMS_KEY_ID=... \\
      CONNECTOR_VAULT_RUNNER_AWS_PROFILE=... CONNECTOR_VAULT_WEB_AWS_PROFILE=... \\
      node scripts/verify-staging-kms-iam-separation-dry-run.mjs [--ref ${STAGING_REF}]   # emit the runbook\n
  Requires the linked ref (or --ref) to be staging ${STAGING_REF}; refuses production ${PRODUCTION_REF}.
  Hosted identity/config come ONLY from env vars (never hardcoded, never printed): ${REQUIRED_ENV.join(", ")}.
  The dry run uses the synthetic non-secret plaintext "${SYNTHETIC_PLAINTEXT}" — never a real provider token.\n`);
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

console.log(`\n  Hosted KMS/IAM SEPARATION SYNTHETIC dry-run gate — staging ${STAGING_REF} (production ${PRODUCTION_REF} not touched).`);
console.log("  This script connects to nothing and prints no secrets. The hosted steps below are HUMAN-run.\n");

// ── Guard 2: require explicit human confirmation before emitting the runbook ─────────────────────────────────
if (process.env.CONNECTOR_VAULT_KMS_IAM_DRY_RUN_CONFIRM !== CONFIRM_PHRASE) {
  console.log("  [REFUSE] No confirmation. This gate emits the hosted KMS/IAM separation runbook only after explicit");
  console.log("  human confirmation. It performs NO hosted action itself and is NOT executed by the agent.");
  console.log(`  To emit the runbook, set CONNECTOR_VAULT_KMS_IAM_DRY_RUN_CONFIRM="${CONFIRM_PHRASE}" and provide the`);
  console.log(`  required env (names only): ${REQUIRED_ENV.join(", ")}.`);
  console.log("  It would then PRINT (not run) an ordered synthetic-only runbook to: (1) prove the RUNNER identity can");
  console.log("  GenerateDataKey/Encrypt/Decrypt the synthetic sentinel; (2) prove the WEB/REQUEST identity is DENIED");
  console.log("  kms:Decrypt (the load-bearing negative); and record what is/ is not proven.\n");
  console.log("  Real connector credential storage/use is still NOT allowed. RISK-001 remains OPEN. RISK-007 remains");
  console.log("  OPEN. Cutover remains BLOCKED.\n");
  process.exit(1);
}

// ── Guard 3: every required hosted env must be PRESENT (names only; values never read/printed) ───────────────
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  die(`confirmed, but missing required env (set these to non-empty values — they are never printed): ${missing.join(", ")}.`);
}

// ── Emit the SYNTHETIC-ONLY KMS/IAM separation RUNBOOK (the operator runs each step; this script runs none) ──
console.log("  [RUNBOOK] synthetic-only hosted KMS/IAM separation dry run — human-executed; this script opens no connection.");
console.log("  Keep all AWS creds/keys in your shell/profile config only — never commit/print them. Pipe KMS responses");
console.log("  to restricted shell vars/files (umask 077); NEVER echo a plaintext DEK, wrapped DEK, ciphertext, or KMS");
console.log("  response body. Use only the synthetic sentinel; involve no real token.\n");

console.log("  0) Preconditions: staging linked; the vault KEK alias ($CONNECTOR_VAULT_KMS_KEY_ID, region");
console.log("     $CONNECTOR_VAULT_AWS_KMS_REGION) provisioned; and TWO DISTINCT hosted IAM identities —");
console.log("       * RUNNER  ($CONNECTOR_VAULT_RUNNER_AWS_PROFILE): kms:GenerateDataKey + kms:Encrypt + kms:Decrypt on the KEK;");
console.log("       * WEB/REQUEST ($CONNECTOR_VAULT_WEB_AWS_PROFILE): MUST NOT have kms:Decrypt on the KEK (at most");
console.log("         encrypt-only, or no kms:* at all).");
console.log(`     Plaintext is the synthetic sentinel "${SYNTHETIC_PLAINTEXT}". No real credential is involved.\n`);

console.log("  1) RUNNER POSITIVE — as the RUNNER identity (aws --profile $CONNECTOR_VAULT_RUNNER_AWS_PROFILE");
console.log("     --region $CONNECTOR_VAULT_AWS_KMS_REGION); pipe every response to a restricted var, print NO bytes:");
console.log("       a. kms generate-data-key --key-id $CONNECTOR_VAULT_KMS_KEY_ID --key-spec AES_256");
console.log("          -> a plaintext DEK + a wrapped (CiphertextBlob) DEK  [shell vars; NEVER printed];");
console.log(`       b. AES-256-GCM encrypt the synthetic sentinel "${SYNTHETIC_PLAINTEXT}" under the DEK`);
console.log("          -> ciphertext + 16-byte GCM tag + 12-byte nonce  [shell vars; NEVER printed];");
console.log("       c. kms decrypt --ciphertext-blob <the wrapped DEK> --key-id $CONNECTOR_VAULT_KMS_KEY_ID");
console.log("          -> recover the DEK -> decrypt the envelope -> assert it EQUALS the synthetic sentinel.");
console.log("          Record PASS/FAIL ONLY; print NO plaintext, NO DEK, NO ciphertext.");
console.log("       Expect: PASS (the runner identity CAN GenerateDataKey + Encrypt + Decrypt).\n");

console.log("  2) WEB/REQUEST NEGATIVE — the LOAD-BEARING proof. As the WEB/REQUEST identity");
console.log("     (aws --profile $CONNECTOR_VAULT_WEB_AWS_PROFILE --region $CONNECTOR_VAULT_AWS_KMS_REGION):");
console.log("       a. attempt kms decrypt --ciphertext-blob <the wrapped DEK from step 1a> --key-id $CONNECTOR_VAULT_KMS_KEY_ID");
console.log("          -> EXPECT a non-zero exit + AccessDeniedException ('not authorized to perform kms:Decrypt').");
console.log("          Record the error CLASS ONLY (e.g. 'AccessDenied'); print NO KMS response body / NO key material.");
console.log("       Expect: DENIED. *** If this SUCCEEDS, the separation is BROKEN: the web/request runtime can");
console.log("       decrypt vault secrets — record FAIL and a RISK-007 finding; do NOT proceed to record proof. ***\n");

console.log("  3) WEB/REQUEST SURFACE (confirm intended scope) — as the WEB/REQUEST identity, confirm the design's");
console.log("     intended KMS surface: either encrypt-only (kms:GenerateDataKey/Encrypt allowed, kms:Decrypt DENIED)");
console.log("     or NO kms:* at all. Record which. The ONLY hard requirement is that kms:Decrypt is DENIED.\n");

console.log("  4) RECORD evidence (a docs-only verification PR) — distinguish clearly, print NO secrets:");
console.log("       * DB grant shape: already proven by the #163 staging synthetic store-adapter dry-run;");
console.log("       * KMS/IAM separation: PROVEN by THIS run only if step 1 = PASS AND step 2 = DENIED; otherwise");
console.log("         NOT proven (or BROKEN if step 2 succeeded);");
console.log("       * real credential readiness: STILL blocked until audit + rotation/revocation + lifecycle are");
console.log("         complete — KMS/IAM separation alone does NOT close RISK-007 and does NOT permit real credentials.\n");

console.log("  5) FAILURE STATES (explicit + safe; print NO key material in any case):");
console.log("       * runner cannot decrypt (step 1 FAIL) -> the vault crypto/IAM path is broken; NOT proven;");
console.log("       * web/request CAN decrypt (step 2 succeeds) -> separation BROKEN; RISK-007 finding; NOT proven;");
console.log("       * a missing identity / KEK / permission setup -> INCONCLUSIVE; record NOT proven, do not claim proof.\n");

console.log("  The verifier is human-run only; the agent did not run hosted commands. A green run proves the KMS/IAM");
console.log("  DECRYPT separation with SYNTHETIC material only — it does NOT store a real credential and does NOT, on");
console.log("  its own, close RISK-007 (audit + rotation/revocation + lifecycle remain). Real connector credential");
console.log("  storage/use is still NOT allowed. RISK-001 remains OPEN. RISK-007 remains OPEN. Cutover remains BLOCKED.\n");
process.exit(0);
