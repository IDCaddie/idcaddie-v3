// scripts/run-gate-a-b2c-real-exchange-launcher.mjs
//
// INERT BY DEFAULT. GUARDED OPERATOR PRE-FLIGHT for RUN GATE A — the first REAL B2c OAuth token exchange, STAGING ONLY
// (docs/50 runbook, docs/51 Checklist A). It is NOT the run.
//
// This launcher assembles NOTHING and performs NO exchange: it never calls Slack, never opens an authorize URL, never
// reads a secret / OAuth code / token / DB URL, never touches AWS/Supabase/KMS, and never imports the real-exchange
// wiring (that stays a separate, explicitly-Sam-approved step — the real deps are produced only by
// `makeRealOrchestratorDeps`, which itself throws unless the gate is on). This tool only REFUSES unsafe conditions and
// EMITS the exact operator procedure (a pointer to docs/50/51). Default (no `--confirm`) = refuse.
//
// It REFUSES unless ALL hold:
//   * linked Supabase ref is exactly the staging ref (production ref is hard-blocked)
//   * CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED=1  AND  the environment is non-production (mirrors `isRealExchangeEnabled`)
//   * --confirm is exactly "RUN B2C FIRST REAL TOKEN STAGING"
//   * --app-env is "staging"
//   * --redirect-uri is the exact staging callback URI
//   * NO client secret / bot token / OAuth code / DB URL / password appears in argv or env
//
// Run:  node scripts/run-gate-a-b2c-real-exchange-launcher.mjs --confirm="RUN B2C FIRST REAL TOKEN STAGING" --app-env=staging
// Self-test (no AWS/Supabase/Slack/DB/secret, CI):  node scripts/run-gate-a-b2c-real-exchange-launcher.mjs selftest
//
// RISK-007 remains OPEN; Phase C remains BLOCKED. A green pre-flight is NOT the run and does NOT close RISK-007.

import { readFileSync } from "node:fs";

const STAGING_REF = "ycdpzduxugdsffjqyoai"; // the only permitted Supabase project ref
const PRODUCTION_REF = "dzbfxulvxchdemcettrx"; // must NEVER be linked/touched
const ENABLE_FLAG = "CONNECTOR_OAUTH_REAL_EXCHANGE_ENABLED";
const CONFIRM_PHRASE = "RUN B2C FIRST REAL TOKEN STAGING";
const EXPECT_APP_ENV = "staging";
const STAGING_REDIRECT_URI = "https://idcaddie-v3.vercel.app/connectors/oauth/callback"; // connector-oauth-config.ts
const REDIRECT_RE = /^https:\/\/[a-z0-9.-]+\/connectors\/oauth\/callback$/; // mirrors connector-oauth-config.ts

// The only flags this launcher accepts. Anything else (positional or unknown flag) is refused — a stray token/secret
// on the command line must never be accepted or echoed.
const ALLOWED_FLAGS = new Set(["--confirm", "--app-env", "--redirect-uri", "--dry-run", "selftest"]);
// Env var NAMES that would carry a real secret / code / DB URL / password — refused if set (value NEVER echoed).
const FORBIDDEN_ENV = [
  "SLACK_CLIENT_SECRET", "CONNECTOR_VAULT_CLIENT_SECRET", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET",
  "SLACK_OAUTH_CODE", "OAUTH_CODE", "DATABASE_URL", "SUPABASE_DB_URL", "PGPASSWORD", "DB_PASSWORD", "POSTGRES_PASSWORD",
];
// Secret-SHAPED values (defence-in-depth, in case a secret is fat-fingered onto argv). Matched but NEVER echoed.
const SECRET_SHAPE = /(xox[baprs]-|xapp-|eyJ[A-Za-z0-9_-]{6,}\.|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN|postgres(ql)?:\/\/[^ ]*:[^ ]*@|sk-[A-Za-z0-9]{16,})/;

// ── pure guards (exported; unit-tested) ─────────────────────────────────────────────────────────────────────
export function assertStagingRef(refRaw) {
  const ref = String(refRaw ?? "").trim();
  if (ref === PRODUCTION_REF) throw new Error("REFUSE: production Supabase ref — RUN GATE A prep is STAGING ONLY");
  if (ref !== STAGING_REF) throw new Error(`REFUSE: Supabase ref is not the expected staging ref (${STAGING_REF})`);
}
// Mirrors src/lib/server/connector-vault/oauth-real-exchange-wiring.ts `isRealExchangeEnabled` (parity asserted in the
// test): never in production; requires the explicit flag. Kept as pure JS so this launcher imports NO real path.
export function gateEnabled(env = {}) {
  if (env.VERCEL_ENV === "production" || env.NODE_ENV === "production") return false;
  return env[ENABLE_FLAG] === "1";
}
export function assertGateEnabled(env = {}) {
  if (env && (env.VERCEL_ENV === "production" || env.NODE_ENV === "production"))
    throw new Error("REFUSE: production environment — real exchange is disabled in production");
  if (!gateEnabled(env)) throw new Error(`REFUSE: gate OFF — set ${ENABLE_FLAG}=1 (non-production). INERT by default.`);
}
export function assertConfirm(confirm) {
  if (confirm !== CONFIRM_PHRASE) throw new Error(`REFUSE: missing/incorrect confirmation — pass --confirm="${CONFIRM_PHRASE}"`);
}
export function assertAppEnv(appEnv) {
  if (appEnv !== EXPECT_APP_ENV) throw new Error(`REFUSE: --app-env must be exactly "${EXPECT_APP_ENV}"`);
}
export function assertRedirectUri(uri) {
  if (typeof uri !== "string" || !REDIRECT_RE.test(uri) || uri !== STAGING_REDIRECT_URI)
    throw new Error("REFUSE: --redirect-uri must be the exact staging callback URI (see connector-oauth-config.ts)");
}
// No client secret / bot token / OAuth code / DB URL / password on the command line. Only the allowed FLAG NAMES are
// permitted; positional args and unknown flags are refused. Error messages NEVER echo an argv value.
export function assertNoArgvSecret(argv) {
  for (const a of argv ?? []) {
    if (typeof a !== "string") throw new Error("REFUSE: invalid argument");
    if (SECRET_SHAPE.test(a)) throw new Error("REFUSE: an argument looks like a secret/token/DB URL — never pass secrets on the command line");
    if (a.startsWith("--") || a === "selftest") {
      if (!ALLOWED_FLAGS.has(a.split("=", 1)[0])) throw new Error("REFUSE: unknown flag — secrets/codes/tokens must never be passed on the command line");
      continue;
    }
    throw new Error("REFUSE: positional argument not allowed — no secret/code/token/DB URL may be passed on the command line");
  }
}
// No secret/code/DB URL/password in env. Message NEVER echoes the value.
export function assertNoEnvSecret(env = {}) {
  for (const k of FORBIDDEN_ENV) {
    if (typeof env[k] === "string" && env[k].length > 0)
      throw new Error(`REFUSE: ${k} is set in the environment — the real exchange reads secrets ONLY via the gated server path, never env`);
  }
}

// The safe procedure (a short pointer; the authoritative steps are docs/50 + docs/51 Checklist A). Contains NO secret.
const PROCEDURE = [
  "PRE-FLIGHT OK (staging ref, gate ON non-prod, confirmation, app-env, redirect URI; no argv/env secret).",
  "",
  "This launcher does NOT run the exchange, does NOT call Slack, and does NOT build an authorize URL.",
  "Perform RUN GATE A per docs/51 Checklist A + docs/50 runbook, on a DISPOSABLE Slack DEV workspace, staging only:",
  "  * confirm the KMS/IAM separation is green (docs/52 criterion 5) and connector_runner_login is verified (0039).",
  "  * the real deps are assembled ONLY by makeRealOrchestratorDeps (gated); the browser callback route stays synthetic.",
  "  * the exchange consumes the durable oauth_pending row EXACTLY ONCE; a replay/mismatch fails closed before exchange.",
  "  * verify payload.corr == oauth_pending.state_jti binding (enforced by key identity + the atomic multi-field WHERE).",
  "",
  "NEVER type/echo/argv/env a client secret, bot token, OAuth code, DB URL, or password. Redact all output.",
  "A green run is NOT a RISK-007 closure. RISK-007 remains OPEN; Phase C remains BLOCKED.",
].join("\n");

// Run ALL guards, then emit the procedure. NEVER assembles or runs the real exchange.
export function preflight({ argv, env, ref, confirm, appEnv, redirectUri }) {
  assertNoArgvSecret(argv); // secret-safety FIRST (before anything could echo)
  assertNoEnvSecret(env);
  assertStagingRef(ref);
  assertGateEnabled(env);
  assertAppEnv(appEnv);
  assertRedirectUri(redirectUri);
  assertConfirm(confirm);
  return PROCEDURE;
}

// ── selftest: prove the guards with pure inputs (no AWS/Supabase/Slack/DB/secret) ───────────────────────────
export function runSelftest() {
  const fail = (m) => { throw new Error(`SELFTEST FAILED: ${m}`); };
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  const S = "MUSTNOTLEAK-selftest-secret";
  const enabledEnv = { [ENABLE_FLAG]: "1" };
  const goodArgs = { argv: [`--confirm=${CONFIRM_PHRASE}`, "--app-env=staging"], env: enabledEnv, ref: STAGING_REF, confirm: CONFIRM_PHRASE, appEnv: EXPECT_APP_ENV, redirectUri: STAGING_REDIRECT_URI };

  // 1) ref: staging ok; production + other refused.
  throws(() => assertStagingRef(STAGING_REF)) && fail("staging ref must pass");
  throws(() => assertStagingRef(PRODUCTION_REF)) || fail("production ref must REFUSE");
  throws(() => assertStagingRef("other")) || fail("unknown ref must REFUSE");
  // 2) gate: off by default; on only with flag + non-prod.
  gateEnabled({}) && fail("gate must be OFF by default");
  gateEnabled(enabledEnv) || fail("gate must be ON with the flag (non-prod)");
  gateEnabled({ ...enabledEnv, VERCEL_ENV: "production" }) && fail("gate must be OFF in VERCEL_ENV=production");
  gateEnabled({ ...enabledEnv, NODE_ENV: "production" }) && fail("gate must be OFF in NODE_ENV=production");
  throws(() => assertGateEnabled(enabledEnv)) && fail("assertGateEnabled must pass with the flag");
  throws(() => assertGateEnabled({})) || fail("assertGateEnabled must REFUSE without the flag");
  throws(() => assertGateEnabled({ ...enabledEnv, VERCEL_ENV: "production" })) || fail("assertGateEnabled must REFUSE in production");
  // 3) confirmation / app-env / redirect.
  throws(() => assertConfirm(CONFIRM_PHRASE)) && fail("exact confirm must pass");
  throws(() => assertConfirm("nope")) || fail("wrong confirm must REFUSE");
  throws(() => assertConfirm(undefined)) || fail("missing confirm must REFUSE");
  throws(() => assertAppEnv("staging")) && fail("staging app-env must pass");
  throws(() => assertAppEnv("production")) || fail("non-staging app-env must REFUSE");
  throws(() => assertRedirectUri(STAGING_REDIRECT_URI)) && fail("exact redirect must pass");
  throws(() => assertRedirectUri("http://idcaddie-v3.vercel.app/connectors/oauth/callback")) || fail("non-https redirect must REFUSE");
  throws(() => assertRedirectUri("https://evil.example.com/connectors/oauth/callback")) || fail("wrong-host redirect must REFUSE");
  // 4) argv/env secret safety — refused AND never echoed.
  throws(() => assertNoArgvSecret(["xoxb-1111-secret"])) || fail("secret-shaped argv must REFUSE");
  (() => { try { assertNoArgvSecret([S]); return ""; } catch (e) { return e.message; } })().includes(S) && fail("argv guard must not echo the value");
  throws(() => assertNoArgvSecret(["positional"])) || fail("positional argv must REFUSE");
  throws(() => assertNoArgvSecret(["--evil=x"])) || fail("unknown flag must REFUSE");
  throws(() => assertNoArgvSecret([`--confirm=${CONFIRM_PHRASE}`, "--app-env=staging"])) && fail("allowed flags must pass");
  throws(() => assertNoEnvSecret({ SLACK_CLIENT_SECRET: S })) || fail("env secret must REFUSE");
  (() => { try { assertNoEnvSecret({ SLACK_CLIENT_SECRET: S }); return ""; } catch (e) { return e.message; } })().includes(S) && fail("env guard must not echo the value");
  throws(() => assertNoEnvSecret(enabledEnv)) && fail("clean env must pass");
  // 5) preflight: full-valid emits the procedure (no secret); any missing guard refuses.
  const out = preflight(goodArgs);
  out.includes("PRE-FLIGHT OK") || fail("valid preflight must emit the procedure");
  (out.includes(S) || out.includes("xoxb") || /-----BEGIN/.test(out)) && fail("procedure must contain no secret");
  throws(() => preflight({ ...goodArgs, confirm: undefined })) || fail("preflight must REFUSE without confirm");
  throws(() => preflight({ ...goodArgs, ref: PRODUCTION_REF })) || fail("preflight must REFUSE on production ref");
  throws(() => preflight({ ...goodArgs, env: {} })) || fail("preflight must REFUSE with the gate off");

  return { ok: true, checks: 5 };
}

// ── operator entrypoint (only when invoked directly) ────────────────────────────────────────────────────────
function flagVal(argv, name) {
  for (const a of argv) { const eq = a.indexOf("="); if ((eq === -1 ? a : a.slice(0, eq)) === name) return eq === -1 ? "" : a.slice(eq + 1); }
  return undefined;
}
function main(argv) {
  if (argv.includes("selftest")) {
    const r = runSelftest();
    process.stdout.write(`RUN GATE A LAUNCHER SELFTEST PASS — ${r.checks} guard checks (no AWS/Supabase/Slack/DB/secret; no exchange).\n`);
    return 0;
  }
  let ref = "";
  try { ref = readFileSync(new URL("../supabase/.temp/project-ref", import.meta.url), "utf8"); } catch { ref = ""; }
  const out = preflight({
    argv,
    env: process.env,
    ref,
    confirm: flagVal(argv, "--confirm"),
    appEnv: flagVal(argv, "--app-env"),
    redirectUri: flagVal(argv, "--redirect-uri") ?? STAGING_REDIRECT_URI,
  });
  process.stdout.write(out + "\n");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`RUN GATE A PREFLIGHT REFUSED: ${e && e.message ? e.message : e}\n`); // messages carry no secret
    process.exit(1);
  }
}
