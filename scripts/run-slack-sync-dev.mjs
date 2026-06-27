// LOCAL-DEV-ONLY pre-flight for the manual Slack P0 sync run (PR 6). PREPARED, NOT a full runner: like the connector
// dry-run scripts, this .mjs cannot import the TS chain, so it GUARDS the environment + prints the exact procedure the
// developer runs. It performs NO Slack call, NO DB write, and reads/holds NO token. It refuses outside local dev and
// against the production ref. NOT customer-facing OAuth, NOT the production runner, NOT a scheduler, NOT a UI button.
//
// Run:  NODE_ENV=development ID_CADDIE_DEV_SLACK_SYNC_ENABLED=1 node scripts/run-slack-sync-dev.mjs --confirm

import { readFileSync } from "node:fs";

const STAGING_REF = "ycdpzduxugdsffjqyoai";
const PRODUCTION_REF = "dzbfxulvxchdemcettrx";

// ALLOWLIST-shaped local-dev guard — IDENTICAL shape to run-slack-sync-dev.ts (positive local dev + explicit opt-in).
export function isLocalDevRunEnabled(env) {
  const isLocalDev = env.NODE_ENV === "development" && (env.VERCEL_ENV === undefined || env.VERCEL_ENV === "development");
  if (!isLocalDev) return false;
  return env.ID_CADDIE_DEV_SLACK_SYNC_ENABLED === "1";
}

// Refuse if a Slack token / dev-user JWT appears in argv (it must never be on the command line). Only --confirm allowed.
export function assertNoSecretInArgv(argv) {
  for (const a of argv) {
    if (a === "--confirm") continue;
    throw new Error("refuse: unexpected argument — never pass a token/JWT on the command line (use env vars read by the run)");
  }
}

export function assertNotProduction(ref) {
  if (ref === PRODUCTION_REF) throw new Error(`refuse: production ref ${PRODUCTION_REF} — this manual run is staging/local-dev only`);
}

const PROCEDURE = [
  "Manual Slack P0 sync — LOCAL/DEV ONLY. This is a dev/test token run, NOT customer OAuth, NOT the production runner,",
  "NOT a scheduler. RISK-007 remains OPEN. It runs: dev-token source (#187) -> Slack client (#188) -> emitter (#189)",
  "-> tenant-scoped resolver (#190), writing graph rows as a TENANT MEMBER via RLS (never service-role).",
  "",
  "Set (server-only env; NEVER printed/argv/committed):",
  "  NODE_ENV=development  ID_CADDIE_DEV_SLACK_SYNC_ENABLED=1  ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED=1",
  "  ID_CADDIE_DEV_SLACK_TOKEN=<dev workspace bot token>      ID_CADDIE_DEV_USER_JWT=<a dev tenant-member access token>",
  "Then invoke runSlackSyncDev({ env, tokenSource: createDevProviderTokenSource(env), httpClient: <fetch wrapper>,",
  "  store: createSupabaseSlackResolverStore(createDevUserScopedClient(env)), identity: { tenantId, connectorId },",
  "  observedAt: <ISO> }) from a server-only TS entrypoint, and print ONLY the safe RunSlackSyncSummary (counts/booleans",
  "  — no token, no email, no name, no raw response). Verify the rows via the read-only UI (app detail page).",
].join("\n");

function currentRef() {
  try {
    return readFileSync(new URL("../supabase/.temp/project-ref", import.meta.url), "utf8").trim();
  } catch {
    return "";
  }
}

function main(argv, env) {
  if (!isLocalDevRunEnabled(env)) {
    console.error("[REFUSE] local dev + ID_CADDIE_DEV_SLACK_SYNC_ENABLED=1 required (allowlist; fails closed in CI/staging/prod).");
    process.exit(1);
  }
  assertNoSecretInArgv(argv);
  assertNotProduction(currentRef());
  if (!argv.includes("--confirm")) {
    console.error("[REFUSE] re-run with --confirm after reading docs/47. This prints the procedure only; it runs nothing.");
    process.exit(1);
  }
  console.log(`ref: ${currentRef() || "(unlinked)"} (expected staging ${STAGING_REF}; production ${PRODUCTION_REF} refused)`);
  console.log(PROCEDURE);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2), process.env);
}
