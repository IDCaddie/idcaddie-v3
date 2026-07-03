// Server-only SLACK API CLIENT (Slack P0 PR 2). Ports the data-pull (auth.test + users.list) from the old Firebase
// slackScraper.js into v3 as a verifiable-in-isolation client: dev-token source → Slack API → NORMALIZED records.
//
// It does NOT emit discovery facts, NOT write the resolver, NOT touch the DB/UI/OAuth/runner/KMS. The token is obtained
// ONLY via the PR #187 `ProviderTokenSource` seam (never read from a random env var here) and reaches Slack ONLY in the
// Authorization header of the INJECTED http client — never logged, returned, thrown, or placed in a normalized record.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and the static no-client-import scan in the
// test. No route/server-action/public-API surface.

import type { ProviderTokenSource } from "../provider-token-source";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/slack/slack-client is server-only and must not be imported in client code");
}

// A minimal INJECTED http client (the ONLY Slack-calling path — no global `fetch` in this module, so no accidental
// egress). `headers.get` mirrors fetch's Headers for Retry-After. Tests inject a mock; the live dev-verify command
// injects global fetch.
export type SlackHttpResponse = { ok: boolean; status: number; headers?: { get(name: string): string | null }; json: () => Promise<unknown> };
export type SlackHttpClient = (url: string, init: { method: "GET"; headers: Record<string, string> }) => Promise<SlackHttpResponse>;

// A SAFE, static error — `code` is a Slack error code (invalid_auth / missing_scope / ratelimited / …) or one of our
// static reasons. It NEVER carries the token, the Authorization header, or a raw response body.
export class SlackApiError extends Error {
  readonly code: string;
  readonly retryAfterSeconds?: number;
  constructor(code: string, retryAfterSeconds?: number) {
    super(`slack api error: ${code}`);
    this.name = "SlackApiError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type SlackAuthTestResult = { ok: true; teamId: string; userId: string; teamName?: string; url?: string };

// The NORMALIZED internal record the future emitter consumes. ONLY allowlisted, non-secret fields — never a raw Slack
// object spread, never the token/headers/full-response, never a tenant_id taken from the Slack payload.
export type SlackUserRecord = {
  slackUserId: string;
  teamId: string;
  email?: string;
  displayName?: string;
  title?: string;
  status?: string;
  roleHint: "primary_owner" | "owner" | "admin" | "ultra_restricted" | "restricted" | "member";
  isAdmin: boolean;
  isOwner: boolean;
  isPrimaryOwner: boolean;
  isRestricted: boolean;
  isUltraRestricted: boolean;
  isBot: boolean;
  isDeleted: boolean;
  // NOTE: `email` is per-user OPTIONAL — the live test workspace returned `profile.email` absent on the sampled member
  //   (users:read.email scoped). Records must never require it. (PR 3: emit person_identity_candidate only when email exists.)
  lastActivityAt?: number; // Slack `updated` (last profile change, Unix ts) — closest scalar; VERIFY against live.
  timezone?: string;
  // `has2fa` / `hasSso` are UNAVAILABLE via P0 `users.list` (live-verified absent) → NOT required output; captured in
  // provenance ONLY when actually present. Defer real 2FA/SSO posture to Enterprise Grid / SCIM / a security-posture path.
  rawProvenance: { updated?: number; tzOffset?: number; color?: string; has2fa?: boolean; hasSso?: boolean };
};

const SLACK_API = "https://slack.com/api";
const USERS_PAGE_LIMIT = 200;
const MAX_PAGES = 100; // safety cap — never loop forever on a misbehaving cursor

export type SlackClientDeps = {
  tokenSource: ProviderTokenSource; // PR #187 seam — the ONLY token path
  httpClient: SlackHttpClient; // injected — the ONLY Slack-calling path
  identity: { tenantId: string; connectorId: string };
};
export type SlackClientOptions = { includeBots?: boolean }; // default false → filter bots for P0

// The field paths this client reads from the live Slack response — exported so the dev-verify command checks EXACTLY
// these (the old scraper is a reference, not ground truth). VERIFY against the current Slack API before relying on them.
export const SLACK_FIELD_PATHS = {
  authTest: ["ok", "team_id", "user_id", "team", "url"],
  member: ["id", "team_id", "deleted", "is_admin", "is_owner", "is_primary_owner", "is_restricted", "is_ultra_restricted", "is_bot", "has_2fa", "has_sso", "tz", "updated"],
  profile: ["profile.email", "profile.display_name", "profile.real_name", "profile.title", "profile.status_text"],
  pagination: ["response_metadata.next_cursor"],
} as const;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const bool = (v: unknown): boolean => v === true;

// Normalize ONE live member → the allowlisted record (or null if it has no id). No raw spread.
export function normalizeSlackUser(member: unknown): SlackUserRecord | null {
  if (!member || typeof member !== "object") return null;
  const u = member as Record<string, unknown>;
  const id = str(u.id);
  if (!id) return null;
  const profile = u.profile && typeof u.profile === "object" ? (u.profile as Record<string, unknown>) : {};
  const isAdmin = bool(u.is_admin);
  const isOwner = bool(u.is_owner);
  const isPrimaryOwner = bool(u.is_primary_owner);
  const isRestricted = bool(u.is_restricted);
  const isUltraRestricted = bool(u.is_ultra_restricted);
  const isBot = bool(u.is_bot) || id === "USLACKBOT";
  return {
    slackUserId: id,
    teamId: str(u.team_id) ?? "",
    email: str(profile.email),
    displayName: str(profile.display_name) ?? str(profile.real_name),
    title: str(profile.title),
    status: str(profile.status_text),
    roleHint: isPrimaryOwner ? "primary_owner" : isOwner ? "owner" : isAdmin ? "admin" : isUltraRestricted ? "ultra_restricted" : isRestricted ? "restricted" : "member",
    isAdmin,
    isOwner,
    isPrimaryOwner,
    isRestricted,
    isUltraRestricted,
    isBot,
    isDeleted: bool(u.deleted),
    lastActivityAt: typeof u.updated === "number" ? u.updated : undefined,
    timezone: str(u.tz),
    rawProvenance: {
      updated: typeof u.updated === "number" ? u.updated : undefined,
      tzOffset: typeof u.tz_offset === "number" ? u.tz_offset : undefined,
      color: str(u.color),
      // has_2fa / has_sso are absent in P0 users.list (verified) — captured ONLY if a response ever includes them.
      ...(typeof u.has_2fa === "boolean" ? { has2fa: u.has_2fa } : {}),
      ...(typeof u.has_sso === "boolean" ? { hasSso: u.has_sso } : {}),
    },
  };
}

// users.list COMPLETENESS signal (#234 truncation hardening). `complete` is true ONLY when pagination reached the natural
// last page (no next_cursor) without hitting the page cap or a cursor loop — so a downstream consumer can refuse to mark
// absent users stale on a possibly-truncated fetch. A hard error mid-stream (http/ratelimit/malformed/Slack error) still
// THROWS SlackApiError (fails the whole sync); this result covers only the SILENT truncation cases. `reason` is a SAFE
// class only — never a token, response body, or cursor value.
export type ListUsersIncompleteReason = "page_limit_reached" | "cursor_loop";
export type ListUsersResult = {
  users: SlackUserRecord[];
  complete: boolean;
  reason: "complete" | ListUsersIncompleteReason;
  usersFetched: number;
  pagesFetched: number;
};

export type SlackClient = {
  authTest(): Promise<SlackAuthTestResult>;
  listUsers(): Promise<ListUsersResult>;
};

export function createSlackClient(deps: SlackClientDeps, options: SlackClientOptions = {}): SlackClient {
  const includeBots = options.includeBots === true;

  async function callSlack(method: string, query: Record<string, string>, purpose: string): Promise<Record<string, unknown>> {
    // Token via the PR #187 seam ONLY — never a direct env read.
    const { token } = await deps.tokenSource.getProviderToken({ provider: "slack", tenantId: deps.identity.tenantId, connectorId: deps.identity.connectorId, purpose });
    const qs = new URLSearchParams(query).toString();
    const url = `${SLACK_API}/${method}${qs ? `?${qs}` : ""}`; // no secret in the URL — the token rides the header
    let res: SlackHttpResponse;
    try {
      res = await deps.httpClient(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    } catch {
      throw new SlackApiError("http_error"); // NEVER surface the caught error (defense-in-depth)
    }
    if (res && res.status === 429) {
      const n = Math.floor(Number(res.headers?.get("retry-after")));
      throw new SlackApiError("ratelimited", Number.isFinite(n) && n > 0 ? n : undefined); // positive int only; drop NaN/0/negative/HTTP-date
    }
    if (!res || typeof res.json !== "function") throw new SlackApiError("malformed_response");
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new SlackApiError("malformed_response");
    }
    if (!body || typeof body !== "object") throw new SlackApiError("malformed_response");
    const obj = body as Record<string, unknown>;
    if (obj.ok !== true) {
      throw new SlackApiError(str(obj.error) ?? "unknown_error"); // safe Slack error code (invalid_auth / missing_scope / …)
    }
    return obj;
  }

  return {
    async authTest(): Promise<SlackAuthTestResult> {
      const obj = await callSlack("auth.test", {}, "auth_test");
      const teamId = str(obj.team_id);
      const userId = str(obj.user_id);
      if (!teamId || !userId) throw new SlackApiError("malformed_response");
      return { ok: true, teamId, userId, teamName: str(obj.team), url: str(obj.url) };
    },

    async listUsers(): Promise<ListUsersResult> {
      const out: SlackUserRecord[] = [];
      let cursor = "";
      const seenCursors = new Set<string>(); // break on a repeating cursor → no duplicate-record loop on a misbehaving page
      // Default = INCOMPLETE: if the loop exhausts MAX_PAGES while a cursor is still pending, we truncated → fail closed.
      let complete = false;
      let reason: ListUsersResult["reason"] = "page_limit_reached";
      let pagesFetched = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query: Record<string, string> = { limit: String(USERS_PAGE_LIMIT) };
        if (cursor) query.cursor = cursor;
        const obj = await callSlack("users.list", query, "users_list");
        pagesFetched++;
        const members = Array.isArray(obj.members) ? obj.members : [];
        for (const m of members) {
          const rec = normalizeSlackUser(m);
          if (!rec) continue; // skip malformed (no id)
          if (rec.isBot && !includeBots) continue; // P0: filter bots by default
          out.push(rec);
        }
        const meta = obj.response_metadata && typeof obj.response_metadata === "object" ? (obj.response_metadata as Record<string, unknown>) : {};
        cursor = str(meta.next_cursor) ?? "";
        if (!cursor) { complete = true; reason = "complete"; break; } // reached the natural last page → COMPLETE
        if (seenCursors.has(cursor)) { complete = false; reason = "cursor_loop"; break; } // looping cursor → INCOMPLETE
        seenCursors.add(cursor);
      }
      return { users: out, complete, reason, usersFetched: out.length, pagesFetched };
    },
  };
}
