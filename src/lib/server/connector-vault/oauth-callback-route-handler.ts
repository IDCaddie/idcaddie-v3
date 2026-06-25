// Server-only PRODUCTION-SHAPED Slack OAuth callback handler (PR B2c-route — RISK-007, docs/42 §90). SYNTHETIC ONLY.
//
// This is the production SHAPE of the callback request path (guard → explicit session resolution → parse → B2c-wire
// orchestrator → safe/static response), but it runs FULLY SYNTHETIC: it composes B2c-wire (#176) with MOCKED Slack
// dependencies (a synthetic http client that returns a token-shaped sentinel, a synthetic client-secret provider, a
// synthetic store). It makes NO real Slack call, handles NO real token, uses NO real client secret, and DOES NOT
// import or call the B2c-secret client-secret decrypt boundary (`withSlackClientSecret`) — the synthetic exchange
// path needs no real client-secret decrypt. It is PRODUCTION-DISABLED (fail-closed) until B2c-run is explicitly
// authorized. RISK-001 / RISK-007 remain OPEN.
//
// REQUEST-PATH DISCIPLINE: the production-disabled guard refuses at the EARLIEST point (before reading/parsing/
// logging ANY request material) with a generic 404 that does not reveal this is an OAuth callback, name the guard/
// env, or return a reason. The `code`/`state`/session/cookies/URL are NEVER logged, echoed into an error, put in a
// response body/header, or returned to the browser. Responses are safe/static (a 303 to a fixed target with only a
// coarse success|error flag — never raw code/state/error detail). Session is resolved EXPLICITLY (no layout auth).
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts` (only the
// inert callback route may import it from src/app).

import {
  orchestrateSlackOAuthCallback,
  type OrchestratorResult,
} from "./oauth-callback-orchestrator";
import type { OAuthStateSigner } from "./oauth-state";
import type { SlackHttpClient, SlackHttpResponse, ExchangeStoreHandoff } from "./slack-oauth-exchange";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-callback-route-handler is server-only and must not be imported in client code");
}

// The staging/test guard. Read from TRUSTED server config ONLY (never the request). Default OFF; NEVER true in
// production. Request-supplied values cannot enable it. Until B2c-run, this keeps the route synthetic + disabled.
export function isSyntheticCallbackEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VERCEL_ENV === "production" || env.NODE_ENV === "production") return false; // never in production
  return env.CONNECTOR_OAUTH_SYNTHETIC_CALLBACK_ENABLED === "1"; // explicit opt-in required (default off)
}

export type SyntheticCallbackHandlerDeps = {
  // The guard result (from `isSyntheticCallbackEnabled`, trusted config only) — NOT derived from the request.
  enabled: boolean;
  // Explicit session resolution (NO layout auth) — returns the authenticated actor subject, or null if no session.
  resolveSubject: () => Promise<string | null>;
  // Runs B2c-wire with SYNTHETIC deps. Receives ONLY the parsed state/code + the resolved subject; returns the
  // orchestrator result (a safe ok flag — never a token/secret/code).
  runOrchestrator: (input: { state?: string; code?: string; subject: string }) => Promise<OrchestratorResult>;
};

const SAFE_REDIRECT_BASE = "/connectors";
// A safe/static 303 to a FIXED target carrying ONLY a coarse status flag — never raw code/state/error/reason detail.
function safeRedirect(status: "success" | "error"): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `${SAFE_REDIRECT_BASE}?oauth=${status}`, "cache-control": "no-store" },
  });
}
// Generic not-found — for the production-disabled refusal. Reveals NOTHING (not an OAuth callback, no guard/env name,
// no reason).
function genericNotFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
}

// The production-shaped, synthetic callback handler.
export async function handleSyntheticSlackOAuthCallback(
  request: Request,
  deps: SyntheticCallbackHandlerDeps,
): Promise<Response> {
  // 1) EARLIEST guard — production-disabled / not-opted-in → generic 404, BEFORE reading/parsing/logging ANY request
  //    material (we don't even read the URL here). No disclosure of purpose, guard, env, or reason.
  if (!deps.enabled) return genericNotFound();

  // 2) EXPLICIT session resolution (no layout auth). No session → fail closed, safe/static (no disclosure).
  let subject: string | null;
  try {
    subject = await deps.resolveSubject();
  } catch {
    return safeRedirect("error");
  }
  if (typeof subject !== "string" || subject.length === 0) return safeRedirect("error");

  // 3) Parse ONLY `state` + `code` from the query. They are NEVER logged, echoed, or returned.
  let state: string | undefined;
  let code: string | undefined;
  try {
    const url = new URL(request.url);
    state = url.searchParams.get("state") ?? undefined;
    code = url.searchParams.get("code") ?? undefined;
  } catch {
    return safeRedirect("error");
  }

  // 4) Run B2c-wire (synthetic). The orchestrator is the authoritative gate (B2a validate → B2b mocked exchange → B1
  //    store). Any throw → safe failure; never surface the error/code/state.
  let result: OrchestratorResult;
  try {
    result = await deps.runOrchestrator({ state, code, subject });
  } catch {
    return safeRedirect("error");
  }

  // 5) Safe/static response — NO code/state/secret/token/reason-with-context (only a coarse success|error flag).
  return safeRedirect(result.ok ? "success" : "error");
}

// ── Synthetic B2c-wire runner (the route's wiring; no real Slack, no client-secret decrypt) ─────────────
// A token-SHAPED synthetic sentinel (marked) the synthetic Slack response returns — proves a real-shaped token would
// not survive into a response/log. NOT a real token.
const SYNTHETIC_BOT_TOKEN = "xoxb-9999999999-8888888888-MUSTNOTLEAKsynthroute";
const SYNTHETIC_CLIENT_SECRET = "MUSTNOTLEAK-synthetic-route-client-secret";

// The synthetic Slack http client — returns the sentinel bot token WITHOUT any network. There is no global `fetch`
// here and no fallback, so the route can never reach slack.com.
function syntheticSlackHttpClient(): SlackHttpClient {
  return async () => {
    const resp: SlackHttpResponse = { ok: true, status: 200, json: async () => ({ ok: true, access_token: SYNTHETIC_BOT_TOKEN, token_type: "bot" }) };
    return resp;
  };
}
// The synthetic store — accepts the (synthetic) token and returns a redacted ref. Never persists/logs it.
function syntheticStore(): ExchangeStoreHandoff {
  return async () => ({ ok: true, ref: { secretId: "synthetic-app-secret" } });
}

export type SyntheticRunnerConfig = {
  signer: OAuthStateSigner;
  // Server-trusted expected context (in B2c-run this comes from the oauth_pending lookup + server config; here it is
  // synthetic). NOT sourced from the request.
  expected: { tenantId: string; connectorId: string; provider: string; redirectUri: string; correlationId: string };
  now: () => number;
};

// Build a `runOrchestrator` that wires B2c-wire with FULLY SYNTHETIC deps. The client-secret provider is a synthetic
// inline sentinel — this path NEVER calls `withSlackClientSecret` / the B2c-secret decrypt boundary.
export function makeSyntheticOrchestratorRunner(config: SyntheticRunnerConfig): SyntheticCallbackHandlerDeps["runOrchestrator"] {
  return async ({ state, code, subject }) =>
    orchestrateSlackOAuthCallback(
      { state, code },
      {
        expectedContext: { subject, redirectIntent: "connect", ...config.expected },
        signer: config.signer,
        now: config.now(),
        clientId: "synthetic-client-id",
        clientSecret: { read: async () => SYNTHETIC_CLIENT_SECRET }, // SYNTHETIC — never the B2c-secret decrypt boundary
        httpClient: syntheticSlackHttpClient(),
        store: syntheticStore(),
        version: 1,
      },
    );
}
