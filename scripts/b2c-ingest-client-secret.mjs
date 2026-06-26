// scripts/b2c-ingest-client-secret.mjs
//
// GUARDED PRE-FLIGHT for the B2c-run Slack client-secret ingestion (docs/45 §5). It is NOT the run.
//
// This launcher NEVER reads, holds, prints, or transmits the client secret, and it does NOT perform the ingestion
// itself. It only REFUSES unsafe conditions and EMITS the exact safe procedure. The actual ingestion is performed by
// the reviewed harness CORE `src/lib/server/connector-vault/client-secret-ingest-harness.ts` (`ingestClientSecret` +
// `readSecretFromStream`), which reads the secret from STDIN inside the hosted runner runtime (the runner supplies
// the `RunnerConnection` as `connector_runner_login` + the real KMS provider — see docs/45 §4). The secret must be
// PIPED via stdin into that core — never typed, never argv, never env, never a logged temp file.
//
// Run: `node scripts/b2c-ingest-client-secret.mjs --confirm`  (emits the procedure; default without --confirm refuses).
// No real Slack API call, no real token, no real client secret, no production/hosted command, no RISK-007 closure.

import { readFileSync } from "node:fs";

const STAGING_REF = "ycdpzduxugdsffjqyoai";
const PRODUCTION_REF = "dzbfxulvxchdemcettrx";

// Refuse anything but the staging ref (never production).
export function assertStagingRef(refRaw) {
  const ref = String(refRaw ?? "").trim();
  if (ref === PRODUCTION_REF) throw new Error("REFUSE: production Supabase ref — B2c-run prep is STAGING ONLY");
  if (ref !== STAGING_REF) throw new Error(`REFUSE: Supabase ref is not the expected staging ref (${STAGING_REF})`);
}
// The secret must NEVER be in env.
export function assertNoEnvSecret(env) {
  if (env && typeof env.SLACK_CLIENT_SECRET === "string" && env.SLACK_CLIENT_SECRET.length > 0)
    throw new Error("REFUSE: SLACK_CLIENT_SECRET is set in the environment — the secret must be piped via stdin, never env");
}
// The secret must NEVER be on the command line. Only `--confirm` is allowed; a positional arg is refused. Error
// messages are generic — they never echo an argv value (which could be the secret).
export function assertNoArgvSecret(argv) {
  for (const a of argv ?? []) {
    if (typeof a !== "string") throw new Error("REFUSE: invalid argument");
    if (a.startsWith("--")) { if (a.split("=", 1)[0] !== "--confirm") throw new Error("REFUSE: unknown flag (the secret must not be passed on the command line)"); continue; }
    throw new Error("REFUSE: positional argument not allowed — the client secret must be piped via stdin, never on the command line");
  }
}

// The safe procedure (a short pointer; the authoritative steps are docs/45 §5). It contains NO secret.
const PROCEDURE = [
  "PRE-FLIGHT OK (staging ref, no env/argv secret).",
  "",
  "This launcher does NOT ingest. Perform the ingestion in the HOSTED RUNNER runtime via the reviewed harness core",
  "(client-secret-ingest-harness.ts -> ingestClientSecret), piping the secret on STDIN. See docs/45 §5 for the exact",
  "command, the prerequisites (connector_runner_login + CONNECTOR_VAULT_KMS_KEY_ID), the post-ingestion DB/scanner",
  "checks, and the cleanup steps.",
  "",
  "NEVER type the secret, NEVER pass it as an argument, NEVER put it in an env var, NEVER echo it. Disable shell",
  "history first (`unset HISTFILE`). PREFER an IN-MEMORY pipe so the secret NEVER touches disk — e.g. a secrets-manager",
  "CLI piped straight in: `pass show <ref> | <runner-invokes ingestClientSecret reading stdin>`. Do NOT write the",
  "client secret to a temp file. If a temp file is genuinely unavoidable: `umask 077`, then portable FAIL-LOUD cleanup",
  "`shred -u \"$f\" 2>/dev/null || rm -f \"$f\"`, then VERIFY it is gone (`[ -e \"$f\" ] && { echo 'FATAL: secret file",
  "remains'; exit 1; }`). NEVER a bare `shred` — it does not exist on macOS and silently no-ops, leaving plaintext on disk.",
].join("\n");

export function preflight({ argv, env, ref, confirm }) {
  assertStagingRef(ref);
  assertNoEnvSecret(env);
  assertNoArgvSecret(argv);
  if (!confirm) throw new Error("REFUSE: re-run with --confirm after reading docs/45 §5 (default = refuse). This emits the procedure only; it does NOT ingest the secret.");
  return PROCEDURE;
}

// Only run when invoked directly (so tests can import the guards without executing main).
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const ref = readFileSync(new URL("../supabase/.temp/project-ref", import.meta.url), "utf8");
    const out = preflight({ argv: process.argv.slice(2), env: process.env, ref, confirm: process.argv.includes("--confirm") });
    process.stdout.write(out + "\n");
  } catch (e) {
    process.stderr.write(String(e && e.message ? e.message : e) + "\n"); // guard messages carry no secret
    process.exit(1);
  }
}
