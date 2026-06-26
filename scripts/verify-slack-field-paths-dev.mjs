// LOCAL-DEV-ONLY Slack field-path verification (Slack P0 PR 2 §4). The ONE place a real Slack call may happen — and
// ONLY in positively-confirmed local development with the PR #187 dev-token opt-in. It calls auth.test + users.list with
// the dev token and prints SAFE AGGREGATE / FIELD-PRESENCE info ONLY — never the token, an email, a name, the raw
// response, an auth header, or an `xoxb-` value.
//
// It FAILS CLOSED outside local dev (allowlist-shaped, mirrors src/lib/server/sync/provider-token-source.ts) and is
// NEVER run in CI / staging / production. The agent does NOT run it (no dev token); a human runs it locally.
//
// Run:  NODE_ENV=development ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED=1 ID_CADDIE_DEV_SLACK_TOKEN=<dev-bot-token> \
//         node scripts/verify-slack-field-paths-dev.mjs

const SLACK_API = "https://slack.com/api";

// Allowlist-shaped local-dev guard — IDENTICAL shape to provider-token-source.ts (positive local dev + explicit opt-in).
export function isLocalDevTokenEnabled(env) {
  const isLocalDev = env.NODE_ENV === "development" && (env.VERCEL_ENV === undefined || env.VERCEL_ENV === "development");
  if (!isLocalDev) return false; // unknown / unset / test / staging / preview / production → fail closed
  return env.ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED === "1";
}

const isBotMember = (m) => !!m && (m.is_bot === true || m.id === "USLACKBOT");
const hasPath = (o, p) => p.split(".").reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), o) != null;

// Read EXACTLY the field paths the client reads; return presence COUNTS only (never a value). Email is broken down BY
// USER TYPE — a workspace can return a single email that belongs to a BOT, so non-bot email presence is what matters.
export function summarizeMembers(members) {
  const c = { total: 0, bots: 0, nonBots: 0, deleted: 0, restricted: 0, ultraRestricted: 0, admins: 0, owners: 0, primaryOwners: 0,
    usersWithEmail: 0, botsWithEmail: 0, nonBotsWithEmail: 0, nonBotsMissingEmail: 0,
    withDisplayName: 0, withRealName: 0, withTitle: 0, withTz: 0, with2fa: 0, withSso: 0, missingId: 0 };
  for (const m of members) {
    if (!m || typeof m !== "object") continue;
    c.total++;
    const bot = isBotMember(m);
    const email = hasPath(m, "profile.email");
    if (bot) c.bots++; else c.nonBots++;
    if (!hasPath(m, "id")) c.missingId++;
    if (m.deleted === true) c.deleted++;
    if (m.is_restricted === true) c.restricted++;
    if (m.is_ultra_restricted === true) c.ultraRestricted++;
    if (m.is_admin === true) c.admins++;
    if (m.is_owner === true) c.owners++;
    if (m.is_primary_owner === true) c.primaryOwners++;
    if (email) c.usersWithEmail++;
    if (bot && email) c.botsWithEmail++;
    if (!bot && email) c.nonBotsWithEmail++;
    if (!bot && !email) c.nonBotsMissingEmail++;
    if (hasPath(m, "profile.display_name")) c.withDisplayName++;
    if (hasPath(m, "profile.real_name")) c.withRealName++;
    if (hasPath(m, "profile.title")) c.withTitle++;
    if (hasPath(m, "tz")) c.withTz++;
    if (m.has_2fa === true) c.with2fa++;
    if (m.has_sso === true) c.withSso++;
  }
  return c;
}

// Pick the field-path sample: PREFER a non-bot member WITH profile.email (the merge-gate evidence). Returns ONLY safe
// booleans + the field-path PRESENCE block (booleans) — never the raw member, so no email/name/value can leak.
export function pickSampledNonBot(members) {
  const nonBots = (Array.isArray(members) ? members : []).filter((m) => m && typeof m === "object" && !isBotMember(m));
  const withEmail = nonBots.find((m) => hasPath(m, "profile.email")) ?? null;
  const sample = withEmail ?? nonBots[0] ?? null;
  return {
    sampledNonBotWithEmailFound: !!withEmail,
    sampledNonBotHasEmail: !!sample && hasPath(sample, "profile.email"),
    hasSample: !!sample,
    fieldPaths: sample ? fieldPathPresence(sample) : [], // booleans only — the raw member never escapes this helper
  };
}

// The field paths the client depends on — report present/ABSENT (so a stale/relocated old-scraper path is visible).
const EXPECTED_MEMBER_PATHS = ["id", "team_id", "deleted", "is_admin", "is_owner", "is_primary_owner", "is_restricted",
  "is_ultra_restricted", "is_bot", "has_2fa", "has_sso", "tz", "updated", "profile.email", "profile.display_name",
  "profile.real_name", "profile.title", "profile.status_text"];

export function fieldPathPresence(sampleMember) {
  const has = (o, p) => p.split(".").reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), o) !== undefined;
  return EXPECTED_MEMBER_PATHS.map((p) => ({ path: p, present: !!sampleMember && has(sampleMember, p) }));
}

async function main() {
  const env = process.env;
  if (!isLocalDevTokenEnabled(env)) {
    console.error("[REFUSE] local-dev + ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED=1 required (allowlist; fails closed in CI/staging/prod).");
    process.exit(1);
  }
  const token = env.ID_CADDIE_DEV_SLACK_TOKEN;
  if (!token) { console.error("[REFUSE] ID_CADDIE_DEV_SLACK_TOKEN not set."); process.exit(1); }
  const get = async (method, query = {}) => {
    const qs = new URLSearchParams(query).toString();
    const res = await fetch(`${SLACK_API}/${method}${qs ? `?${qs}` : ""}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) return { ok: false, error: "ratelimited" };
    try { return await res.json(); } catch { return { ok: false, error: "malformed_response" }; }
  };

  // auth.test
  const auth = await get("auth.test");
  console.log("auth.test ok:", auth.ok === true);
  console.log("  team_id present:", typeof auth.team_id === "string" && auth.team_id.length > 0);
  console.log("  user_id present:", typeof auth.user_id === "string" && auth.user_id.length > 0);
  if (auth.ok !== true) { console.error("  auth error code:", typeof auth.error === "string" ? auth.error : "unknown"); process.exit(1); }

  // users.list (paginate, aggregate only)
  let cursor = "", pages = 0, all = [];
  do {
    const page = await get("users.list", cursor ? { limit: "200", cursor } : { limit: "200" });
    if (page.ok !== true) { console.error("users.list error code:", typeof page.error === "string" ? page.error : "unknown"); process.exit(1); }
    all = all.concat(Array.isArray(page.members) ? page.members : []);
    cursor = (page.response_metadata && page.response_metadata.next_cursor) || "";
    pages++;
  } while (cursor && pages < 100);

  const counts = summarizeMembers(all);
  const { sampledNonBotWithEmailFound, sampledNonBotHasEmail, hasSample, fieldPaths } = pickSampledNonBot(all);
  console.log("users.list ok: true");
  console.log("  pages fetched:", pages, "| pagination handled:", pages > 1 ? "multi-page" : "single-page");
  console.log("  aggregate counts:", JSON.stringify(counts));
  console.log("  sampledNonBotWithEmailFound:", sampledNonBotWithEmailFound);
  console.log("  sampledNonBotHasEmail:", sampledNonBotHasEmail);
  if (sampledNonBotWithEmailFound) {
    console.log("  field-path presence (sampled NON-BOT member WITH email):");
  } else {
    console.log("  sampled non-bot with email: NOT FOUND");
    if (hasSample) console.log("  field-path presence (fallback non-bot member, email ABSENT):");
  }
  for (const { path, present } of fieldPaths) console.log(`    ${present ? "PRESENT" : "ABSENT "}  ${path}`);
  console.log("  → MERGE GATE: nonBotsWithEmail >= 1 AND profile.email PRESENT on the non-bot sample above.");
  console.log("  → any other ABSENT path is a stale/relocated old-scraper assumption to reconcile.");
}

// Run only as a script (never on import). Top-level guard so the module is importable by its guard test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => { console.error("[FAIL] verification errored (details suppressed — no token/PII printed)."); process.exit(1); });
}
