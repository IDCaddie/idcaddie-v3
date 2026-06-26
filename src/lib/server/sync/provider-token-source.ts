// Server-only PROVIDER TOKEN SOURCE seam (Slack P0 PR 1). The small interface future Slack sync code depends on, plus a
// DEV/TEST-ONLY implementation that is STRUCTURALLY DISABLED outside local development (an ALLOWLIST-shaped fail-closed
// guard). This is a temporary BUILD SCAFFOLD to prove v3's sync chain with a server-only dev token.
//
// It does NOT change credential-vault / RISK-007 posture: customer-facing v3 credentials MUST still be born via
// OAuth/vault/runner (docs 44/46). This dev source is for LOCAL DEVELOPMENT proof only and must be removed/replaced
// before any production connector use. NO real token, NO Slack call, NO OAuth, NO vault/runner/KMS here. It is NOT the
// old app's pasted-token model — no DB storage, no credential document, no credential UI.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and the static no-client-import scan in the
// test. Never a route/server-action/public-API return; the token surfaces ONLY as the in-memory object handed to the
// direct server-side caller.

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/provider-token-source is server-only and must not be imported in client code");
}

// P0 = Slack only. Any other provider fails closed until it is explicitly added.
export type ProviderName = "slack";

export type ProviderTokenRequest = {
  provider: ProviderName;
  tenantId: string;
  connectorId: string;
  purpose: string;
};

// The in-memory token object handed to the direct caller. `token` is the ONLY secret field; nothing else carries it,
// and this object is never logged, thrown, audited, or written to a discovery/provenance fact.
export type ProviderToken = {
  provider: ProviderName;
  token: string;
};

// The seam both the P0 dev source and the FUTURE vault/OAuth/runner source implement.
export interface ProviderTokenSource {
  getProviderToken(req: ProviderTokenRequest): Promise<ProviderToken>;
}

// Future placeholder ONLY (the swap target): the customer-facing vault/OAuth/runner source will implement the SAME
// `ProviderTokenSource`, loading the token through the runner/KMS/vault boundary (docs 44/46). NOT implemented here.
export type VaultProviderTokenSource = ProviderTokenSource;

export class ProviderTokenError extends Error {
  // GENERIC messages ONLY — never the token, the env value, or a caught error body.
  constructor(message: string) {
    super(message);
    this.name = "ProviderTokenError";
  }
}

// ── ALLOWLIST-shaped fail-closed guard ────────────────────────────────────────────────────────────────────────────
// The dev-token source is enabled ONLY when the runtime is POSITIVELY local development AND an explicit opt-in is set.
// This is "allow only confirmed local dev + opt-in", NOT "deny known staging/prod": every other case — unknown env,
// unset env, `test`, staging, Vercel preview, Vercel production — falls through to DISABLED. It reads TRUSTED server
// config (the env map) ONLY; it is never passed, and never reads, a request header/query/cookie/body/url.
const DEV_OPT_IN = "ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED";
const DEV_TOKEN_ENV = "ID_CADDIE_DEV_SLACK_TOKEN"; // server-only var (NOT NEXT_PUBLIC_*); the token is never in code.

export function isDevProviderTokenSourceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  // POSITIVE local-dev classification: the Node dev runtime AND not running on any non-dev Vercel deployment.
  // On Vercel, NODE_ENV is "production" for every deploy (preview + production), so this excludes all deploys; locally
  // `next dev` is NODE_ENV=development with VERCEL_ENV unset, and `vercel dev` is VERCEL_ENV=development.
  const isLocalDev = env.NODE_ENV === "development" && (env.VERCEL_ENV === undefined || env.VERCEL_ENV === "development");
  if (!isLocalDev) return false; // unknown / unset / test / staging / preview / production all fail closed
  return env[DEV_OPT_IN] === "1"; // explicit opt-in required (default off)
}

// DEV/TEST-ONLY Slack token source. Fails closed unless `isDevProviderTokenSourceEnabled(env)`; supports ONLY Slack;
// reads the dev token from a server-only env var. Never logs/throws the token; returns only the in-memory
// `{ provider, token }` object to its direct caller.
export function createDevProviderTokenSource(env: Record<string, string | undefined> = process.env): ProviderTokenSource {
  return {
    async getProviderToken(req: ProviderTokenRequest): Promise<ProviderToken> {
      // Guard FIRST — fail closed before reading or returning anything if not positively local-dev + opted in.
      if (!isDevProviderTokenSourceEnabled(env))
        throw new ProviderTokenError("dev provider-token source is disabled (allowlist: local dev + explicit opt-in only)");
      if (!req || req.provider !== "slack")
        throw new ProviderTokenError("unsupported provider for the dev token source (P0 = slack only)");
      const token = env[DEV_TOKEN_ENV];
      if (typeof token !== "string" || token.length === 0)
        throw new ProviderTokenError("dev Slack token is not configured"); // never echoes the (absent) value
      return { provider: "slack", token }; // the ONLY place the token surfaces — the caller's in-memory object
    },
  };
}
