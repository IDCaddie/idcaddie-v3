// Server-only Slack OAuth code→token EXCHANGE wrapper (PR B2b — RISK-007, docs/42 §90.4). MOCKED ONLY.
//
// This builds the SHAPE of the server-side exchange so it can be tested with MOCKED Slack responses. It does NOT
// make a real Slack network call: the Slack token endpoint is reached ONLY through an INJECTED http client (a mock
// in tests; the real client is wired in a later, explicitly-authorized PR). There is NO global `fetch` here and NO
// fallback to one — so an automated test cannot accidentally hit `slack.com`.
//
// BOUNDARIES (docs/42 §90.1/§90.3/§90.4):
//   * The authorization `code` reaches this wrapper ONLY after B2a state validation succeeds (the caller's
//     precondition — this wrapper takes a validated `code` + the EXACT redirect URI as inputs and never re-derives
//     them from request data). The `code` is used once and is NEVER logged/returned.
//   * The Slack **client secret** is read from an INJECTED provider (`ClientSecretProvider`) — NOT
//     `process.env.SLACK_CLIENT_SECRET`. It is plaintext in memory ONLY for the duration of the exchange call, is
//     placed only in the (un-logged) request body, and is NEVER logged, echoed into an error, returned, or audited.
//     B2b mocks it; B2c wires the vault-grade/KMS-backed store (§90.3).
//   * The Slack bot **token** is extracted from the parsed response and handed STRAIGHT to the B1 store/encrypt
//     path (`ExchangeStoreHandoff`). It is NEVER returned to the caller, included in the success result, put in a
//     thrown error, logged, or audited. The live reference is dropped after the handoff (V8-heap residual remains —
//     not a hard wipe, docs/44 §2 step 7).
//   * The raw Slack response is parsed in memory; only the bot-token field is read. The raw body is NEVER logged,
//     returned, or audited; Slack `error` codes are SANITIZED into safe static reason classes (never echoed).
//   * Fail-closed on a non-`ok` response, a missing/non-bot token, malformed JSON, an HTTP/network error, or a
//     missing/denied client secret — and on a store failure (no half state).
//
// B2b adds NO real Slack API call, NO real token, NO callback route that performs a real exchange, NO live connector
// use, NO request-path decrypt, NO production enablement. RISK-007 remains OPEN. Exchange-specific audit events
// (`connector_oauth.exchange.*`, §90.6) are NOT implemented here — they remain future.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/slack-oauth-exchange is server-only and must not be imported in client code");
}

// A typed, safe-to-surface error — its message is always a fixed static string (never a secret/token/code).
export class SlackOAuthExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackOAuthExchangeError";
  }
}

// The Slack OAuth v2 token endpoint (docs/42 §90.4). It is the TARGET passed to the injected client — this module
// NEVER calls it directly (no `fetch`), so there is no accidental-egress path.
export const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";

// A minimal injected HTTP client (the ONLY way this wrapper reaches Slack). Mirrors the shape of `fetch`'s response
// (ok/status/json) so the real wiring can adapt a runner-side client; a mock supplies it in tests.
export type SlackHttpResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
export type SlackHttpClient = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<SlackHttpResponse>;

// The injected client-secret reader — NEVER `process.env`. `read()` resolves the plaintext client secret (mocked in
// B2b; vault-grade/KMS-backed in B2c). A throw is treated as access-denied; an empty value as missing.
export type ClientSecretProvider = { read: () => Promise<string> };

// The handoff to the B1 store/encrypt path (the bot token's only destination). Mocked in B2b; wired to
// `ingestStagingConnectorSecret` in B2c. Returns a REDACTED reference — never the token/ciphertext.
export type ExchangeStoreHandoff = (input: {
  plaintext: string;
  tenantId: string;
  connectorId: string;
  version: number;
  correlationId: string;
}) => Promise<{ ok: true; ref: { secretId?: string } } | { ok: false }>;

// SAFE STATIC reason classes — never a raw Slack `error`, response body, code, token, or client secret.
export type SlackExchangeReason =
  | "missing_client_secret"
  | "client_secret_denied"
  | "exchange_http_error"
  | "slack_error"
  | "malformed_response"
  | "missing_bot_token"
  | "unexpected_token_type"
  | "missing_workspace" // the response named no team, so the workspace cannot be proven
  | "workspace_mismatch" // the token belongs to a DIFFERENT Slack workspace than the one authorized
  | "granted_scopes_malformed" // the response carried no usable bot `scope` string at all
  | "granted_scopes_insufficient" // Slack granted FEWER capabilities than the reviewed manifest needs
  | "granted_scopes_unexpected" // Slack granted MORE than was reviewed — see §"extra scopes" below
  | "store_failed";

// ── THE GRANTED-SCOPE CONTRACT ───────────────────────────────────────────────────────────────────────────────────────
//
// The capabilities `slack.v1.json` declares its endpoints need, and exactly the reviewed set in doc 83 §3.4.
// `slack-oauth-exchange.granted-scopes.test.ts` pins this to the manifest's own union, so the two cannot drift.
//
// A CONSTANT, not an input, and deliberately so. `expectedTeamId` is optional-if-unset because the approved workspace is
// per-deployment configuration; the required capability set is not — it is a property of what the discovery code will
// call. Making it injectable would create an "unset ⇒ accept anything" path, which is the wildcard doc 81 says a
// refusal must never be. There is no way to skip this check from configuration.
export const REQUIRED_SLACK_BOT_SCOPES: readonly string[] = ["users:read", "users:read.email", "usergroups:read"];

// Slack returns the granted BOT scopes as a comma-separated string in the top-level `scope`. We read that and never
// `authed_user.scope` — that is the USER-token grant, a different principal with a different token we neither request
// nor store. Splitting on comma and trimming tolerates whitespace; ordering is not significant to Slack and is not
// significant here.
function parseGrantedBotScopes(raw: unknown): ReadonlySet<string> | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? new Set(parts) : null;
}

export type SlackExchangeResult =
  | { ok: true; ref: { secretId?: string } } // REDACTED: a non-secret reference only — never the token
  | { ok: false; reason: SlackExchangeReason };

export type SlackExchangeInput = {
  code: string; // a B2a-validated authorization code (caller precondition); used once, never logged/returned
  redirectUri: string; // the EXACT redirect URI bound in the state (server-trusted)
  tenantId: string;
  connectorId: string;
  version: number;
  correlationId: string;
  // The Slack workspace this authorization is allowed to be for, from server-trusted config. When set, a token for
  // any other workspace is refused BEFORE the store handoff, so a wrong-workspace token is never persisted.
  //
  // Optional here because the synthetic path has no workspace to check. A real run must always supply it: the
  // real-callback runner refuses to assemble without one, so "unset" cannot mean "any workspace" in production shape.
  expectedTeamId?: string;
};

export type SlackExchangeDeps = {
  httpClient: SlackHttpClient; // injected — the ONLY Slack-calling path (no global fetch)
  clientId: string; // non-secret app config
  clientSecret: ClientSecretProvider; // injected; NEVER process.env
  store: ExchangeStoreHandoff; // the B1 store/encrypt handoff
};

function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// Exchange a validated authorization code for a Slack bot token via the INJECTED client, then hand the token to the
// store/encrypt path. Returns a REDACTED reference on success; a SAFE static reason on any failure. Never logs/
// returns/audits the code, client secret, raw response, or token.
export async function exchangeSlackOAuthCode(
  input: SlackExchangeInput,
  deps: SlackExchangeDeps,
): Promise<SlackExchangeResult> {
  if (!deps || typeof deps.httpClient !== "function") throw new SlackOAuthExchangeError("missing injected http client");
  if (!deps.clientSecret || typeof deps.clientSecret.read !== "function") throw new SlackOAuthExchangeError("missing injected client-secret provider");
  if (!deps.store || typeof deps.store !== "function") throw new SlackOAuthExchangeError("missing store handoff");

  // 1) read the client secret from the injected provider (NEVER env). A throw = denied; empty = missing.
  let clientSecret: string;
  try {
    clientSecret = await deps.clientSecret.read();
  } catch {
    return { ok: false, reason: "client_secret_denied" };
  }
  if (typeof clientSecret !== "string" || clientSecret.length === 0) return { ok: false, reason: "missing_client_secret" };

  // 2) POST the exchange via the INJECTED client (the body carries client_secret + code and is NEVER logged). Any
  //    network/timeout/throw is a fail-closed http error. The client secret reference is not retained past this call.
  let resp: SlackHttpResponse;
  try {
    resp = await deps.httpClient(SLACK_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form({ client_id: deps.clientId, client_secret: clientSecret, code: input.code, redirect_uri: input.redirectUri }),
    });
  } catch {
    return { ok: false, reason: "exchange_http_error" };
  }
  if (!resp || resp.ok !== true) return { ok: false, reason: "exchange_http_error" };

  // 3) parse the response IN MEMORY. Malformed JSON / non-object fails closed; the raw body is never logged/returned.
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return { ok: false, reason: "malformed_response" };
  }
  if (!body || typeof body !== "object") return { ok: false, reason: "malformed_response" };
  const b = body as Record<string, unknown>;

  // 4) accept ONLY the expected bot-token shape; a Slack error is sanitized (never echo `b.error`).
  if (b.ok !== true) return { ok: false, reason: "slack_error" };
  const token = b.access_token;
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing_bot_token" };
  if (b.token_type !== "bot") return { ok: false, reason: "unexpected_token_type" };

  // 4b) WORKSPACE BINDING. Slack decides which workspace the user consented on, not us — the authorize URL cannot
  //     pin it. So the only place the answer exists is this response, and it has to be checked BEFORE the store: a
  //     token that reached the vault is a token that will be used, and a token for the wrong workspace means reading
  //     an organisation nobody authorized. The team id is compared, never the name (a name is not an identity).
  if (typeof input.expectedTeamId === "string" && input.expectedTeamId.length > 0) {
    const team = b.team;
    const teamId = team && typeof team === "object" ? (team as Record<string, unknown>).id : undefined;
    if (typeof teamId !== "string" || teamId.length === 0) return { ok: false, reason: "missing_workspace" };
    if (teamId !== input.expectedTeamId) return { ok: false, reason: "workspace_mismatch" };
  }

  // 4c) GRANTED-SCOPE BINDING. The authorize URL says what we ASKED for; this response says what Slack GRANTED, and
  //     they are not the same fact. Slack answers `users.list` WITHOUT the email field rather than refusing, so a token
  //     short of `users:read.email` exchanges, stores, passes `auth.test`, completes discovery — and matches nobody,
  //     because `normalized_email` is the only automatic identity-matching method Slack has (0076 permits `manual` and
  //     `normalized_email` and nothing else). That failure surfaces days later and nowhere near its cause, which is why
  //     it is checked HERE, before the store, on the same principle as the workspace binding above: a token that
  //     reached the vault is a token that will be used.
  //
  //     EXTRA SCOPES ARE REFUSED — exact set equality, not "superset is fine". Recorded because it is a judgement, not
  //     an obvious default:
  //       * The app's declared scopes are operator-configured to exactly the reviewed three. Anything beyond them means
  //         the installed app is broader than what was reviewed, which is precisely the governance signal this gate
  //         exists to raise — a bot token that can do more than the review approved is not a smaller problem than one
  //         that can do less.
  //       * The known way extras arise is Slack's union-on-reinstall: re-authorizing a workspace that already granted a
  //         set yields the union. On this staging workspace the prior grant was `users:read` + `usergroups:read`, a
  //         SUBSET of the three, so the union is still exactly three and equality holds. A union that exceeds three
  //         would mean the workspace carries a broader historical grant, and stopping is the right answer.
  //       * Cost of being wrong is bounded and visible: the exchange has already succeeded, so the app IS installed in
  //         the workspace, but no token is stored. Recovery is to uninstall/revoke in Slack and re-authorize — an
  //         operator action on a disposable DEV workspace, not customer-visible, because no customer-initiated flow
  //         exists yet.
  //     If Slack is ever observed adding a scope nobody asked for, relaxing this to a superset check is a REVIEWED code
  //     change here — not a configuration switch, for the same reason the required set is a constant.
  const granted = parseGrantedBotScopes(b.scope);
  if (granted === null) return { ok: false, reason: "granted_scopes_malformed" };
  for (const required of REQUIRED_SLACK_BOT_SCOPES) {
    if (!granted.has(required)) return { ok: false, reason: "granted_scopes_insufficient" };
  }
  // Direction matters to whoever has to fix it: under-scoped and over-scoped have opposite remedies, so they get
  // separate bounded reasons even though 0081's terminal CHECK collapses both to `exchange_failed`.
  if (granted.size !== REQUIRED_SLACK_BOT_SCOPES.length) return { ok: false, reason: "granted_scopes_unexpected" };

  // 5) hand the bot token STRAIGHT to the store/encrypt path — its only destination. Never returned/logged.
  let stored: Awaited<ReturnType<ExchangeStoreHandoff>>;
  try {
    stored = await deps.store({
      plaintext: token,
      tenantId: input.tenantId,
      connectorId: input.connectorId,
      version: input.version,
      correlationId: input.correlationId,
    });
  } catch {
    return { ok: false, reason: "store_failed" };
  }
  // (the local `token` reference is now out of scope — V8-heap residual remains until GC, not a hard wipe.)
  if (!stored || stored.ok !== true) return { ok: false, reason: "store_failed" };

  // 6) REDACTED result — a non-secret reference only. No token, no client secret, no raw response.
  return { ok: true, ref: { ...(stored.ref?.secretId !== undefined ? { secretId: stored.ref.secretId } : {}) } };
}
