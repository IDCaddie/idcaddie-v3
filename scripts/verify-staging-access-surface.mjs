#!/usr/bin/env node
// verify-staging-access-surface.mjs
//
// READ-ONLY verifier for the /access product surface (Phase 15 Part 2; docs/73). It exercises the REAL hosted STAGING Supabase (the
// migration-0061 authenticated read RPCs) + a deployed app's routing, with USER-SCOPED anon-key + synthetic-user sign-ins only. A human runs
// it in an approved window; the agent runs only `node --check` + the mock-only guard tests.
//
// VERIFICATION MODE (explicit opt-in; NEVER inferred from the host):
//   * staging (default): the app target is STAGING_APP_URL; production-style/legacy hosts are refused.
//   * isolated-v3: the app target is an explicitly reviewed, isolated V3 web deployment (ACCESS_VERIFY_APP_URL) whose host must EXACTLY
//     match a statically reviewed allowlist. Vercel's "Production" channel label is NOT authorization to use production data — the database
//     target stays STAGING Supabase in every mode. See docs/73 for the sunset condition.
//
// SAFETY (enforced in BOTH modes):
//   * Linked ref (supabase/.temp/project-ref, or ACCESS_SURFACE_REF_FILE) must be STAGING (ycdpzduxugdsffjqyoai); PRODUCTION ref
//     (dzbfxulvxchdemcettrx) is refused. STAGING_SUPABASE_URL host must be EXACTLY ycdpzduxugdsffjqyoai.supabase.co.
//   * READ-ONLY: calls ONLY the 0061 read RPCs (RPC_ALLOWLIST) via .rpc(); NEVER .insert/.update/.delete, no mutation, no hosted task, no
//     AWS, no connector-runner. Fetches the app routes (ROUTE_ALLOWLIST) with GET only.
//   * USER-SCOPED ONLY: anon/publishable key + synthetic-user sign-in. A legacy service-role JWT or a current-gen sb_secret_* key is REFUSED.
//   * Reads secrets from LOCAL env only. Prints NO passwords, tokens, cookies, anon/publishable-key values, provider external ids, raw RPC
//     responses, labels, emails, or canonical/tenant ids — only mode + check ids + PASS/FAIL + redacted aggregates.
//
// A green run is staging evidence only. It does NOT close RISK-007 and does NOT unblock Phase C. The authenticated-UI acceptance is the
// MANUAL browser checklist in docs/73 (a script cannot hold the app session).

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const STAGING_REF = "ycdpzduxugdsffjqyoai";    // the only permitted Supabase project ref (database target in EVERY mode)
const PRODUCTION_REF = "dzbfxulvxchdemcettrx"; // must NEVER be touched
const REF_FILE = process.env.ACCESS_SURFACE_REF_FILE || "supabase/.temp/project-ref";

const VALID_MODES = ["staging", "isolated-v3"];
const RAW_MODE = process.env.ACCESS_VERIFY_MODE;
const MODE = RAW_MODE === undefined || RAW_MODE.trim() === "" ? "staging" : RAW_MODE.trim(); // default staging; empty/unset → staging
// Statically reviewed isolated-v3 web hosts. Add a host ONLY via a reviewed edit here — no wildcard, no suffix/substring, exact match only.
const ISOLATED_V3_ALLOWED_HOSTS = ["idcaddie-v3.vercel.app"];
const PRODUCTION_APP_HOSTS = ["idcaddie.com", "www.idcaddie.com", "app.idcaddie.com"]; // legacy live app — never targeted

// Explicit allowlist of the migration-0061 READ RPCs this verifier may call (read-only). Nothing else is ever invoked.
const RPC_ALLOWLIST = [
  "product_directory_access_counts",
  "product_list_directory_identities", "product_list_directory_groups", "product_list_directory_applications",
  "product_list_group_memberships", "product_list_user_assignments", "product_list_group_assignments",
  "product_identity_access_subgraph", "product_application_access_subgraph",
];
// Explicit allowlist of approved app routes (GET only).
const ROUTE_ALLOWLIST = [
  "/access", "/access/findings", "/access/identities/:id", "/access/applications/:id",
  "/access/findings/export", "/access/identities/:id/export", "/access/applications/:id/export",
];
const EXPECTED_COUNTS = { identities: 1, groups: 2, applications: 2, memberships: 1, userAssignments: 1, groupAssignments: 0 };
// Keys that must NEVER appear in any RPC response reaching the browser/product path.
const FORBIDDEN_KEYS = ["external_id", "raw_payload", "normalized_", "credential", "setting", "profile", "source_endpoint", "secret", "token"];

function die(msg, code = 2) {
  console.error(`\n  FATAL: ${msg}\n`); // static message only — never an env value, URL, secret, or id
  process.exit(code);
}

const argv = process.argv.slice(2);
const PREFLIGHT = argv.includes("--preflight") || argv.includes("--dry-run");
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`\n  verify-staging-access-surface — READ-ONLY /access verifier (docs/73). Database target is STAGING Supabase in every mode.\n
  Modes (ACCESS_VERIFY_MODE; explicit opt-in, never inferred): staging (default) | isolated-v3.\n
  Usage:
    node scripts/verify-staging-access-surface.mjs --preflight    # guards + check plan only; NO network, NO creds required
    node scripts/verify-staging-access-surface.mjs                # live run (requires the env below); human-run
    node scripts/verify-staging-access-surface.mjs --help\n
  Always required (LOCAL only; never printed): STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY, STAGING_AUTH_TEST_USERS.
  staging mode:     STAGING_APP_URL (production/legacy hosts refused).
  isolated-v3 mode: ACCESS_VERIFY_APP_URL + ACCESS_VERIFY_ALLOWED_HOST (must match + be a reviewed host: ${ISOLATED_V3_ALLOWED_HOSTS.join(", ")}).
  STAGING_AUTH_TEST_USERS JSON: { "expectedTenantId": "<uuid>",   // expectedTenantId is the ONLY required field
    "owner"?/"admin"?/"editor"?/"viewer"?/"nonMember"?: {"email","password"}, "foreignId"?: "<uuid>" }.
  The POSITIVE path needs an owner OR admin (the /access surface is owner/admin-only); with neither, that path is SKIPPED (partial run,
  deny boundary + structure still verified). Any supplied principal is validated for { email, password }.
  Requires the linked ref (or ACCESS_SURFACE_REF_FILE) = staging ${STAGING_REF}; refuses production ${PRODUCTION_REF}.\n`);
  process.exit(0);
}

if (!VALID_MODES.includes(MODE)) die(`ACCESS_VERIFY_MODE is not recognized. Use one of: ${VALID_MODES.join(", ")}.`); // does not echo the env value

// ── Guard 1: linked ref must be staging; refuse production ────────────────────────────────────────────
let ref = "";
try { ref = readFileSync(REF_FILE, "utf8").trim(); }
catch { die(`no ${REF_FILE}. Link STAGING first (supabase link --project-ref ${STAGING_REF}).`); }
if (ref === PRODUCTION_REF) die(`linked ref is PRODUCTION (${PRODUCTION_REF}). REFUSED — production must not be touched.`);
if (ref !== STAGING_REF) die(`linked ref is not the staging project (${STAGING_REF}), refusing.`); // does not echo the file-derived ref value

// A JWT role decoder (decodes ONLY the role claim; the token is never printed/stored).
function jwtRole(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")).role ?? null; }
  catch { return null; }
}
// Parse + strictly validate a BARE https origin, returning its lowercased host. No substring trust; no credentials/path/query/fragment.
function httpsBaseHost(raw, label) {
  let u; try { u = new global.URL(raw); } catch { die(`${label} must be a valid https:// URL.`); }
  if (u.protocol !== "https:") die(`${label} must be an https:// URL.`);
  if (u.username || u.password) die(`${label} must not contain URL credentials.`);
  if (u.search || u.hash) die(`${label} must not contain a query or fragment.`);
  if (u.pathname && u.pathname !== "/") die(`${label} must be a bare origin (no path).`);
  if (u.port) die(`${label} must not specify a port.`); // WHATWG normalizes :443 away; any explicit non-default port is refused
  return u.hostname.toLowerCase();
}
// Accept ONLY an anon/publishable key; refuse a service-role/secret key or any unrecognized format (fail closed). Covers BOTH the legacy
// JWT keys (role claim) and the current-generation opaque sb_publishable_/sb_secret_ keys.
function isAnonKey(key) {
  if (typeof key !== "string" || key.length === 0) return false;
  if (key.startsWith("sb_publishable_")) return true;  // current-gen browser-safe publishable key
  if (key.startsWith("sb_secret_")) return false;       // current-gen secret (service-role-equivalent) — refuse
  return jwtRole(key) === "anon";                        // legacy JWT: only the anon role
}
// Resolve the app target per MODE, with strict host allowlisting. Returns { appUrl, appHost }. Dies fail-closed on any ambiguity.
function resolveAppTarget() {
  const accessAppUrl = process.env.ACCESS_VERIFY_APP_URL;
  const allowedHost = process.env.ACCESS_VERIFY_ALLOWED_HOST;
  const stagingAppUrl = process.env.STAGING_APP_URL;
  if (MODE === "isolated-v3") {
    if (!accessAppUrl) die("isolated-v3 mode requires ACCESS_VERIFY_APP_URL.");
    if (!allowedHost) die("isolated-v3 mode requires ACCESS_VERIFY_ALLOWED_HOST (explicit reviewed host).");
    if (stagingAppUrl && stagingAppUrl !== accessAppUrl) die("ambiguous config: STAGING_APP_URL and ACCESS_VERIFY_APP_URL conflict. Refusing.");
    const host = httpsBaseHost(accessAppUrl, "ACCESS_VERIFY_APP_URL");
    if (allowedHost.trim().toLowerCase() !== host) die("ACCESS_VERIFY_ALLOWED_HOST does not match the ACCESS_VERIFY_APP_URL host. Refusing.");
    if (!ISOLATED_V3_ALLOWED_HOSTS.includes(host)) die(`host "${host}" is not a reviewed isolated-v3 host (${ISOLATED_V3_ALLOWED_HOSTS.join(", ")}). Refusing.`);
    if (host.includes(PRODUCTION_REF) || PRODUCTION_APP_HOSTS.includes(host)) die("isolated-v3 host resolves to a production host. Refusing.");
    return { appUrl: accessAppUrl, appHost: host };
  }
  // staging mode (default)
  if (!stagingAppUrl) die("staging mode requires STAGING_APP_URL (or set ACCESS_VERIFY_MODE=isolated-v3).");
  if (accessAppUrl && accessAppUrl !== stagingAppUrl) die("ambiguous config: ACCESS_VERIFY_APP_URL is set but mode is staging. Refusing.");
  const host = httpsBaseHost(stagingAppUrl, "STAGING_APP_URL");
  if (host.includes(PRODUCTION_REF)) die(`STAGING_APP_URL points at the PRODUCTION project (${PRODUCTION_REF}). Refusing.`);
  if (PRODUCTION_APP_HOSTS.includes(host)) die(`STAGING_APP_URL host "${host}" is a PRODUCTION host. Refusing.`);
  return { appUrl: stagingAppUrl, appHost: host };
}
const TARGET_LABEL = MODE === "isolated-v3" ? "isolated V3 web deployment" : "staging app deployment";

// ── Preflight (dry-run): guards + plan only. No network, no creds required. ───────────────────────────
if (PREFLIGHT) {
  console.log(`\n  [PREFLIGHT] /access verifier — mode=${MODE}; target=${TARGET_LABEL}; database=staging Supabase (${STAGING_REF}); read-only.`);
  console.log(`  Ref ${STAGING_REF} OK (production ${PRODUCTION_REF} refused). No network performed.\n`);
  if (MODE === "isolated-v3") {
    const appUrl = process.env.ACCESS_VERIFY_APP_URL, allowedHost = process.env.ACCESS_VERIFY_ALLOWED_HOST;
    if (appUrl && allowedHost) {
      const host = httpsBaseHost(appUrl, "ACCESS_VERIFY_APP_URL");
      if (allowedHost.trim().toLowerCase() !== host) die("ACCESS_VERIFY_ALLOWED_HOST does not match the ACCESS_VERIFY_APP_URL host.");
      if (!ISOLATED_V3_ALLOWED_HOSTS.includes(host)) die(`host "${host}" is not a reviewed isolated-v3 host.`);
      console.log(`  Normalized allowed host: ${host} (reviewed). Production database rejected; legacy live application not targeted.`);
    } else {
      console.log(`  ACCESS_VERIFY_APP_URL / ACCESS_VERIFY_ALLOWED_HOST: UNSET (required for the live run).`);
      console.log(`  Reviewed isolated-v3 hosts: ${ISOLATED_V3_ALLOWED_HOSTS.join(", ")}.`);
    }
  } else {
    console.log(`  Staging app host: from STAGING_APP_URL (production/legacy hosts refused: ${PRODUCTION_APP_HOSTS.join(", ")}).`);
  }
  const present = (k) => (process.env[k] ? "set" : "UNSET");
  console.log("\n  Required env (names + set/unset only; values never read here):");
  for (const k of ["STAGING_SUPABASE_URL", "STAGING_SUPABASE_ANON_KEY", "STAGING_AUTH_TEST_USERS"]) console.log(`    - ${k}: ${present(k)}`);
  console.log("\n  Read-only RPC allowlist:"); for (const r of RPC_ALLOWLIST) console.log(`    - ${r}`);
  console.log("\n  Approved GET route allowlist:"); for (const r of ROUTE_ALLOWLIST) console.log(`    - ${r}`);
  console.log(`\n  Expected canonical counts: ${JSON.stringify(EXPECTED_COUNTS)}.`);
  console.log("  Live run performs: unauthenticated route-deny checks; owner/admin allowed + editor/viewer/non-member/anon denied;");
  console.log("  count parity; entity resolution + DIRECT-only shape; invalid/nonexistent/foreign id indistinguishability; privacy scan.");
  console.log("  Authenticated-UI acceptance (search/filter/pagination/drill-down/CSV, no-mutation) is the MANUAL docs/73 checklist.\n");
  process.exit(0);
}

// ── Guard 2: always-required env present (live mode) ───────────────────────────────────────────────────
const URL_ = process.env.STAGING_SUPABASE_URL;
const ANON = process.env.STAGING_SUPABASE_ANON_KEY;
const USERS_JSON = process.env.STAGING_AUTH_TEST_USERS;
for (const [k, v] of [["STAGING_SUPABASE_URL", URL_], ["STAGING_SUPABASE_ANON_KEY", ANON], ["STAGING_AUTH_TEST_USERS", USERS_JSON]]) {
  if (!v) die(`missing env ${k} (LOCAL only, never printed). Run --preflight to see the plan without creds.`);
}

// ── Guard 3: Supabase host must be EXACTLY staging (both modes); app target resolved + host-allowlisted per mode ─
const dbHost = httpsBaseHost(URL_, "STAGING_SUPABASE_URL");
if (dbHost !== `${STAGING_REF}.supabase.co`) die(`STAGING_SUPABASE_URL host must be exactly ${STAGING_REF}.supabase.co. Refusing.`);
const { appUrl: APP_URL, appHost } = resolveAppTarget();

// ── Guard 4: parse synthetic users (role-keyed) ──────────────────────────────────────────────────────
// ONLY expectedTenantId is required. Every principal (owner/admin/editor/viewer/nonMember) is OPTIONAL and validated ONLY if supplied.
// The /access surface is owner/admin-only, so the POSITIVE path needs an owner OR admin; with neither, main() SKIPs it (loud PARTIAL) and
// still verifies the deny boundary + structure — it never invents an owner or counts an absent positive check as passed.
let USERS;
try { USERS = JSON.parse(USERS_JSON); } catch { die("STAGING_AUTH_TEST_USERS is not valid JSON."); }
if (!USERS?.expectedTenantId) die("STAGING_AUTH_TEST_USERS needs { expectedTenantId } at minimum.");
for (const role of ["owner", "admin", "editor", "viewer", "nonMember"]) {
  const p = USERS[role];
  if (p !== undefined && (typeof p?.email !== "string" || typeof p?.password !== "string" || p.email.length === 0 || p.password.length === 0)) {
    die(`STAGING_AUTH_TEST_USERS.${role}, if supplied, needs non-empty string { email, password }.`);
  }
}

// ── Guard 5: NEVER accept a service-role/secret key — accept ONLY an anon/publishable key (fail closed) ─
if (!isAnonKey(ANON)) die("STAGING_SUPABASE_ANON_KEY must be an anon/publishable key — never a SERVICE-ROLE or secret key. REFUSED (user-scoped only).");

// ── Harness (redacted output only) ────────────────────────────────────────────────────────────────────
const results = [];
function record(id, name, passed, detail) {
  results.push({ id, status: passed ? "PASS" : "FAIL" });
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${id}. ${name}${detail ? ` — ${detail}` : ""}`); // detail carries redacted aggregates only
}
// SKIP is a distinct state — an absent optional principal / uncovered check. It is NEVER counted as passed; finish() surfaces it loudly.
function skip(id, name, detail) {
  results.push({ id, status: "SKIP" });
  console.log(`  [SKIP] ${id}. ${name}${detail ? ` — ${detail}` : ""}`);
}
const anonClient = () => createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const appUrl = (p) => new global.URL(p, APP_URL).toString();
// Read-only RPC — refuses anything off the allowlist (defense-in-depth).
async function rpc(client, name, args) {
  if (!RPC_ALLOWLIST.includes(name)) die(`internal: RPC "${name}" is not on the read allowlist.`);
  return client.rpc(name, args);
}
// Privacy scan of a jsonb response WITHOUT printing it: stringify + check forbidden keys. Returns the offending key or null.
function forbiddenKeyIn(value) {
  const s = JSON.stringify(value ?? null).toLowerCase();
  return FORBIDDEN_KEYS.find((k) => s.includes(k)) ?? null;
}
async function signIn(role) {
  const u = USERS[role];
  if (!u?.email || !u?.password) return null;
  const c = anonClient();
  const { data, error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error || !data?.session) return null;
  return { c, token: data.session.access_token };
}

async function main() {
  console.log(`\n  /access verifier — Verification target: ${TARGET_LABEL}; database: staging Supabase (${STAGING_REF}); operation mode: read-only. App host ${appHost}.`);
  if (MODE === "isolated-v3") {
    console.log("  target type: isolated V3 web deployment · database target: staging Supabase · operation mode: read-only");
    console.log("  connector mutation: disabled/not invoked · production database: rejected · legacy live application: not targeted");
  }
  console.log("");
  const tid = USERS.expectedTenantId;

  // ── Unauthenticated route-deny checks (no session) — covers ALL 7 allowlisted routes (auth precedes any id lookup) ──────────────
  const PH = "00000000-0000-4000-8000-000000000000"; // placeholder id for the :id routes (unauth denial precedes any lookup)
  const routeDeny = [
    ["U1", "/access"], ["U2", "/access/findings"], ["U3", `/access/identities/${PH}`], ["U4", `/access/applications/${PH}`],
    ["U5", "/access/findings/export"], ["U6", `/access/identities/${PH}/export`], ["U7", `/access/applications/${PH}/export`],
  ];
  for (const [id, path] of routeDeny) {
    let r; try { r = await fetch(appUrl(path), { method: "GET", redirect: "manual", headers: { cookie: "" } }); }
    catch { die("could not reach the app URL."); } // static message — no error detail echoed
    const loc = r.headers.get("location") || "";
    record(id, `Unauthenticated ${path} is denied (→ /login)`, [301, 302, 303, 307, 308].includes(r.status) && loc.includes("/login"), `status ${r.status}`);
  }

  // ── Positive path: the /access surface is OWNER/ADMIN-ONLY. Use owner ∨ admin as the authorized reader. With NEITHER present the
  //    positive coverage is SKIPPED (loud PARTIAL) — never counted as passed; the deny + structural checks below still run. ─────────
  const ownerConfigured = !!(USERS.owner?.email && USERS.owner?.password);
  const adminConfigured = !!(USERS.admin?.email && USERS.admin?.password);
  const owner = ownerConfigured ? await signIn("owner") : null;
  const admin = adminConfigured ? await signIn("admin") : null;
  if (ownerConfigured && !owner) record("O0", "Configured owner sign-in succeeds", false, "sign-in failed");
  if (adminConfigured && !admin) record("A0", "Configured admin sign-in succeeds", false, "sign-in failed");
  const authed = owner ?? admin;
  const authedRole = owner ? "owner" : "admin";

  if (!authed) {
    skip("POS", "Positive path (counts parity, entity resolution, DIRECT, authorized privacy scan, authorized export)",
      ownerConfigured || adminConfigured
        ? "configured owner/admin sign-in failed — positive checks not run"
        : "no owner/admin principal — add an owner/admin membership (docs/73 §minimum fixture) to obtain positive coverage");
  } else {
    record("O1", `Authorized ${authedRole} sign-in succeeds (hosted Auth)`, true, "session issued");
    const role = jwtRole(authed.token);
    record("O2", "Authorized JWT is user-scoped (role=authenticated, not service_role)", role === "authenticated", `role=${role ?? "unknown"}`);

    const { data: counts } = await rpc(authed.c, "product_directory_access_counts", { p_tenant_id: tid });
    const countsOk = counts && Object.entries(EXPECTED_COUNTS).every(([k, v]) => Number(counts[k]) === v);
    record("O3", "Authorized reader is allowed and counts match expected", !!countsOk,
      counts ? `got ${JSON.stringify(EXPECTED_COUNTS_ACTUAL(counts))} expected ${JSON.stringify(EXPECTED_COUNTS)}` : "no counts returned");
    record("O3p", "Counts response carries no forbidden keys", !forbiddenKeyIn(counts), forbiddenKeyIn(counts) ? "LEAK" : "clean");

    const { data: idRows } = await rpc(authed.c, "product_list_directory_identities", { p_tenant_id: tid, p_limit: 100 });
    const { data: appRows } = await rpc(authed.c, "product_list_directory_applications", { p_tenant_id: tid, p_limit: 100 });
    record("O4", "Identity + application lists resolve at expected cardinality", (idRows?.length ?? 0) === 1 && (appRows?.length ?? 0) === 2, `identities=${idRows?.length ?? 0}, applications=${appRows?.length ?? 0}`);
    record("O4p", "List responses carry no forbidden keys", !forbiddenKeyIn(idRows) && !forbiddenKeyIn(appRows), (forbiddenKeyIn(idRows) || forbiddenKeyIn(appRows)) ? "LEAK" : "clean");

    // Entity resolution + DIRECT-only shape (structural, at the RPC level — no engine reimplementation):
    if ((idRows?.length ?? 0) === 1) {
      const { data: sub } = await rpc(authed.c, "product_identity_access_subgraph", { p_identity_id: idRows[0].id, p_tenant_id: tid });
      const directOnly = sub && (sub.userAssignments?.length ?? 0) === 1 && (sub.memberships?.length ?? 0) === 0 && (sub.groupAssignments?.length ?? 0) === 0;
      record("O5", "Known identity resolves as DIRECT-only (1 direct assignment, 0 group paths → no false GROUP/BOTH)", !!directOnly,
        sub ? `direct=${sub.userAssignments?.length ?? 0}, memberships=${sub.memberships?.length ?? 0}, groupAssignments=${sub.groupAssignments?.length ?? 0}` : "subgraph null");
      record("O5p", "Identity subgraph carries no forbidden keys", !forbiddenKeyIn(sub), forbiddenKeyIn(sub) ? "LEAK" : "clean");
    } else {
      skip("O5", "Known-identity DIRECT-only shape", "identity cardinality != 1 (see O4) — not evaluated");
    }
    if ((appRows?.length ?? 0) === 2) {
      let both = true;
      for (const a of appRows) { const { data: s } = await rpc(authed.c, "product_application_access_subgraph", { p_application_id: a.id, p_tenant_id: tid }); if (!s) both = false; }
      record("O6", "Both known applications resolve", both, both ? "2/2 resolved" : "an application did not resolve");
    } else {
      skip("O6", "Both known applications resolve", "application cardinality != 2 (see O4) — not evaluated");
    }

    // Indistinguishability: invalid / nonexistent / foreign id → null (not-found-equivalent).
    const NONEXISTENT = "00000000-0000-4000-8000-000000000000";
    const { data: bad1 } = await rpc(authed.c, "product_identity_access_subgraph", { p_identity_id: NONEXISTENT, p_tenant_id: tid });
    const foreignId = USERS.foreignId;
    let foreignSame = true, foreignNote = "no foreign fixture (skipped)";
    if (foreignId) { const { data: f } = await rpc(authed.c, "product_identity_access_subgraph", { p_identity_id: foreignId, p_tenant_id: tid }); foreignSame = f == null; foreignNote = `foreign → ${f == null ? "null (same as missing)" : "RESOLVED (LEAK)"}`; }
    record("O7", "Nonexistent (and foreign, if present) ids return not-found-equivalent null", bad1 == null && foreignSame, `nonexistent → ${bad1 == null ? "null" : "resolved"}; ${foreignNote}`);

    // If BOTH owner and admin are supplied, cross-check that admin is ALSO allowed; else note which single role provided coverage.
    if (owner && admin) { const { data: c } = await rpc(admin.c, "product_directory_access_counts", { p_tenant_id: tid }); record("A1", "Admin is also allowed", c != null, c != null ? "counts returned" : "denied"); }
    else skip("A1", "Admin also-allowed cross-check", !adminConfigured ? "no admin principal" : !admin ? "admin supplied but sign-in failed" : "only admin supplied (no owner)");

    await owner?.c.auth.signOut();
    await admin?.c.auth.signOut();
  }

  // ── Editor / viewer / non-member (optional): CLEANLY denied. ALWAYS run. A clean deny = null data AND no RPC error; an RPC error is
  //    NOT a clean deny (a missing/broken 0061 RPC also returns null) → FAIL, so a globally-broken surface can't masquerade as "denied". ─
  for (const [id, role] of [["D1", "editor"], ["D2", "viewer"], ["D3", "nonMember"]]) {
    if (typeof USERS[role]?.email !== "string" || typeof USERS[role]?.password !== "string" || !USERS[role].email || !USERS[role].password) { skip(id, `${role} is denied`, "no principal supplied"); continue; }
    const s = await signIn(role);
    if (!s) { record(id, `${role} sign-in (for deny check)`, false, "configured but sign-in failed"); continue; }
    const { data, error } = await rpc(s.c, "product_directory_access_counts", { p_tenant_id: tid });
    record(id, `${role} is cleanly denied (null data, no RPC error)`, error == null && data == null, error != null ? "RPC ERRORED — not a clean deny" : data == null ? "denied" : "ALLOWED (LEAK)");
    await s.c.auth.signOut();
  }

  // ── Anonymous: cleanly denied ─────────────────────────────────────────────────────────────────────────
  const { data: anonCounts, error: anonErr } = await rpc(anonClient(), "product_directory_access_counts", { p_tenant_id: tid });
  record("N1", "Anonymous is cleanly denied (null data, no RPC error)", anonErr == null && anonCounts == null, anonErr != null ? "RPC ERRORED — not a clean deny" : anonCounts == null ? "denied" : "ALLOWED (LEAK)");

  finish();
}

// Return counts limited to the expected keys (aggregate numbers only — never ids/labels) for a redacted diff.
function EXPECTED_COUNTS_ACTUAL(counts) {
  const o = {}; for (const k of Object.keys(EXPECTED_COUNTS)) o[k] = Number(counts?.[k] ?? -1); return o;
}

function finish() {
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  const passed = results.filter((r) => r.status === "PASS");
  const posSkipped = skipped.some((r) => r.id === "POS");
  const denySkipped = ["D1", "D2", "D3"].filter((id) => skipped.some((r) => r.id === id));
  console.log(`\n  ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed (mode=${MODE}).`);
  if (posSkipped) {
    // The crux: without an authorized (owner/admin) read there is NO positive control. The deny checks cannot tell a correctly-denying
    // surface from one that denies EVERYONE (e.g. the 0061 RPCs unapplied/broken). So a passing partial run is INCONCLUSIVE, not evidence.
    console.log("  INCONCLUSIVE (PARTIAL) — no authorized owner/admin read was performed, so there is NO positive control. The deny checks");
    console.log("  cannot distinguish a correctly-denying surface from one that denies EVERYONE (e.g. the migration-0061 RPCs unapplied or");
    console.log("  broken). This run is NOT evidence the surface works — it only shows unauthorized callers received null. Add an owner/admin");
    console.log("  membership (docs/73 §minimum fixture) for conclusive coverage.");
  }
  if (denySkipped.length) {
    console.log(`  Role-based deny boundary NOT fully exercised — missing principal(s): ${denySkipped.join(", ")} (supply editor/viewer/non-member to exercise them).`);
  }
  console.log("  MANUAL (docs/73 §UI acceptance): an owner/admin opens /access; findings/identity/application render; search, filters,");
  console.log("  pagination, drill-down, CSV export work; export is private/no-store + nosniff; NO mutation/removal/reclaim/savings control.");
  console.log("  RISK-007 remains OPEN; Phase C remains BLOCKED; production untouched.");
  if (failed.length) { console.log(`  Result: FAILED (exit 1) — ${failed.map((r) => r.id).join(", ")}. Do NOT record as passing evidence.\n`); process.exit(1); }
  if (posSkipped) { console.log("  Result: PARTIAL / INCONCLUSIVE (exit 3) — not a full verification.\n"); process.exit(3); }
  console.log("  Result: FULL PASS (exit 0) — staging evidence only.\n");
}

main().catch((e) => die(e?.message ?? String(e)));
