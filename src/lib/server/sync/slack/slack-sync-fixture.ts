// Server-only SYNTHETIC Slack fixtures — a deterministic, NETWORK-FREE `SlackHttpClient` + a dummy `ProviderTokenSource`
// that replay committed fake `auth.test` + `users.list` responses. This makes the existing Slack sync pipeline
// (createSlackClient → emitSlackDiscoveryFacts → applySlackDiscoveryResolution → recordedSlackSyncRun) driveable
// end-to-end with NO live Slack call, NO real token, NO AWS/KMS/Secrets Manager, and NO production. Reusable by tests.
//
// The dummy token is clearly fake ("FIXTURE-not-a-real-slack-token") and is never a real credential; the fixture http
// client IGNORES the Authorization header entirely (it replays canned JSON), so no token ever leaves the process.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below.

import type { SlackHttpClient } from "./slack-client";
import type { ProviderTokenSource } from "../provider-token-source";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/slack/slack-sync-fixture is server-only and must not be imported in client code");
}

// A clearly-fake, non-secret dummy token. The fixture http client never reads it; it exists only so the token seam is
// exercised. Kept out of any real-token shape (no `xoxb-<digits>…`) and self-labelled.
export const FIXTURE_SLACK_TOKEN = "FIXTURE-not-a-real-slack-token";

export const FIXTURE_TEAM_ID = "T0FIXTURE01";
export const FIXTURE_TEAM_NAME = "Fixture Workspace";
export const FIXTURE_TEAM_URL = "https://fixture-workspace.example.test";
export const FIXTURE_CONNECTOR_ID = "slack-synthetic-fixture";

// Canned `auth.test` response (workspace identity anchor).
export const FIXTURE_AUTH_TEST = {
  ok: true,
  team_id: FIXTURE_TEAM_ID,
  user_id: "U0FIXTUREBOT",
  team: FIXTURE_TEAM_NAME,
  url: FIXTURE_TEAM_URL,
} as const;

// Canned `users.list` members (raw Slack shape read by normalizeSlackUser). One deterministic page. Scenario coverage:
//   U0000001 normal member (email) · U0000002 admin (email) · U0000003 is_bot (EXCLUDED) · USLACKBOT (EXCLUDED)
//   U0000004 deleted (email; represented, NOT hard-deleted) · U0000005 + U0000006 mixed-case DUPLICATE email
//   (Alice@Example.COM / alice@example.com → ONE person) · U0000007 emailless (app_user only, no person/match).
export const FIXTURE_MEMBERS = [
  { id: "U0000001", team_id: FIXTURE_TEAM_ID, updated: 1700000001, profile: { email: "bob@example.com", real_name: "Bob Normal", display_name: "bobn" } },
  { id: "U0000002", team_id: FIXTURE_TEAM_ID, is_admin: true, updated: 1700000002, profile: { email: "carol@example.com", real_name: "Carol Admin", title: "Ops Lead" } },
  { id: "U0000003", team_id: FIXTURE_TEAM_ID, is_bot: true, profile: { email: "buildbot@example.com", real_name: "Build Bot" } },
  { id: "USLACKBOT", team_id: FIXTURE_TEAM_ID, profile: { real_name: "Slackbot" } },
  { id: "U0000004", team_id: FIXTURE_TEAM_ID, deleted: true, profile: { email: "dana@example.com", real_name: "Dana Deleted" } },
  { id: "U0000005", team_id: FIXTURE_TEAM_ID, updated: 1700000005, profile: { email: "Alice@Example.COM", real_name: "Alice One" } },
  { id: "U0000006", team_id: FIXTURE_TEAM_ID, profile: { email: "alice@example.com", real_name: "Alice Two" } },
  { id: "U0000007", team_id: FIXTURE_TEAM_ID, profile: { real_name: "Eve NoEmail" } },
] as const;

export const FIXTURE_USERS_LIST = { ok: true, members: FIXTURE_MEMBERS, response_metadata: { next_cursor: "" } } as const;

// The EXPECTED resolved graph for one tenant (single source of truth for the test assertions). Bot + Slackbot are
// excluded from app_users; the two mixed-case emails fold to one person; the emailless user gets an app_user but no
// person/match; the deleted user is represented (upserted), never deleted.
export const SLACK_FIXTURE_EXPECTED = {
  apps: 1,
  appUsers: 6, // U0000001,2,4,5,6,7 (U0000003 bot + USLACKBOT excluded)
  people: 4, // DISTINCT people rows (bob, carol, dana, alice — U5+U6 dedupe on lower(email)); the DB/store-map count
  peopleUpserts: 5, // person-UPSERT OPERATIONS (one per email-bearing user U1,U2,U4,U5,U6) — the run-summary `peopleWritten` metric
  matches: 5, // one per email-bearing app_user (U1,U2,U4,U5,U6); U0000007 emailless → none
  excludedBotIds: ["U0000003", "USLACKBOT"] as const,
  deletedAppUserExternalId: "U0000004",
  emaillessAppUserExternalId: "U0000007",
  dedupedPersonEmail: "alice@example.com",
} as const;

// Deterministic, network-free SlackHttpClient. Replays the canned JSON by method in the URL; IGNORES the Authorization
// header (the token never matters). Never touches `fetch`.
export const fixtureSlackHttpClient: SlackHttpClient = async (url, _init) => {
  const body = url.includes("/auth.test")
    ? (FIXTURE_AUTH_TEST as unknown)
    : url.includes("/users.list")
      ? (FIXTURE_USERS_LIST as unknown)
      : { ok: false, error: "fixture_unknown_method" };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
};

// A dummy token source — returns the clearly-fake fixture token. NEVER loads a real credential, reads no env, no vault.
export const fixtureProviderTokenSource: ProviderTokenSource = {
  async getProviderToken() {
    return { provider: "slack", token: FIXTURE_SLACK_TOKEN };
  },
};

// A CALL-RECORDING wrapper over `fixtureSlackHttpClient` — same canned responses, plus a `calls` log of each request's
// url + Authorization header. Lets a unit test assert call ORDER / the Bearer header while reusing the committed fixture
// data (no ad-hoc response shapes). Still network-free.
export function makeFixtureSlackHttpClient(): { client: SlackHttpClient; calls: { url: string; auth?: string }[] } {
  const calls: { url: string; auth?: string }[] = [];
  const client: SlackHttpClient = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return fixtureSlackHttpClient(url, init);
  };
  return { client, calls };
}
