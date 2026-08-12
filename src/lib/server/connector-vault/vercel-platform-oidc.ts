// The ONE module permitted to touch the Vercel platform OIDC value, and the only consumer of it (doc 83 §8.4).
//
// ── WHY THIS EXISTS RATHER THAN `@vercel/oidc` ───────────────────────────────────────────────────────────────────────
// The SDK has exactly one supported entry (`"."` -> `dist/index.js`), a CommonJS barrel that top-level `require`s
// `token-util` -> `@vercel/cli-exec` -> `execa` -> `child_process`, plus `@vercel/cli-config`'s keyring credential
// store. CJS re-exports cannot be tree-shaken by name, and there is no supported deep import, so importing it AT ALL
// puts a process-spawning credential-store capability in the public callback path — the exact class doc 83 §2 exists to
// prevent, and a `next build` module-graph walk showed the synchronous edge from the route entry to `child_process`.
//
// So the two things we actually need are reimplemented here from their observed contracts, in ~60 lines of
// Web-standard primitives. Nothing else about the design changes: the platform token still comes only from Vercel's
// runtime context, and the audience is still a real exchange against Vercel's service.
//
// ── THE TRUST RULE ───────────────────────────────────────────────────────────────────────────────────────────────────
// `readPlatformToken` is NOT exported. The raw platform token never leaves this module: the only export takes an
// audience and returns an EXCHANGED token. There is therefore no seam through which application input — a body, query,
// cookie, or an inbound `Authorization` — could supply or override it, and no caller can obtain the platform token to
// forward it somewhere else. That is a dataflow property, not a naming convention, and
// `vercel-platform-oidc.dataflow.test.ts` proves it by injection rather than by forbidding a string.
//
// The platform value is INFRASTRUCTURE METADATA supplied by the runtime, not application input. Vercel documents
// `x-vercel-oidc-token` on the function's request context as the delivery mechanism; we read it only through that
// context object, never off a `Request` we were handed.

/** Vercel's request-context global. The runtime sets it; nothing in this repository writes it. */
const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

type RequestContext = { headers?: Record<string, string | undefined> };
/** Injectable ONLY so tests can drive it; production always reads the real global. */
export type PlatformContextReader = () => RequestContext;

const defaultContextReader: PlatformContextReader = () => {
  const g = globalThis as Record<symbol, { get?: () => RequestContext } | undefined>;
  return g[VERCEL_REQUEST_CONTEXT]?.get?.() ?? {};
};

/**
 * Read the platform token. Module-private on purpose — see the trust rule above.
 *
 * The env var is the BUILD and LOCAL-DEVELOPMENT path and is kept as a fallback for exactly those, matching Vercel's
 * documented behaviour and the SDK's own precedence. In a deployed Function the context header is what answers.
 */
function readPlatformToken(readContext: PlatformContextReader): string | null {
  const fromContext = readContext().headers?.["x-vercel-oidc-token"];
  const token = typeof fromContext === "string" && fromContext.length > 0 ? fromContext : process.env.VERCEL_OIDC_TOKEN;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** Vercel's custom-audience exchange. Pinned whole — not a host check, for the reason `connector-oauth-config` gives. */
export const VERCEL_TOKEN_EXCHANGE_URL = "https://oidc.vercel.com/~token" as const;
/** The browser is waiting on the callback, and this is a third-party call we do not control. */
export const EXCHANGE_TIMEOUT_MS = 3000;
/** An exchanged JWT is ~1KB. Anything approaching this is not the response we asked for. */
export const EXCHANGE_MAX_RESPONSE_BYTES = 16 * 1024;

export type ExchangeResult =
  | { ok: true; token: string }
  | { ok: false; reason: "platform_token_missing" | "exchange_failed" | "exchange_timeout" | "exchange_response_invalid" };

export type ExchangeDeps = { fetchImpl?: typeof fetch; readContext?: PlatformContextReader };

/**
 * Exchange the platform token for one whose `aud` is exactly `audience`.
 *
 * Protocol, from Vercel's own client: `POST https://oidc.vercel.com/~token`, JSON `{ token, aud }`, JSON `{ token }`.
 *
 * Every outbound discipline this repository applies elsewhere applies here: exact URL, `redirect: "error"` so a 30x
 * cannot carry the bearer to another origin, `cache: "no-store"`, an `AbortController` ceiling, a bounded read, and a
 * bounded parse. The provider's error body is DISCARDED rather than surfaced — it can echo the token we just sent.
 */
export async function exchangeForDedicatedAudience(audience: string, deps: ExchangeDeps = {}): Promise<ExchangeResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const platformToken = readPlatformToken(deps.readContext ?? defaultContextReader);
  if (platformToken === null) return { ok: false, reason: "platform_token_missing" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(VERCEL_TOKEN_EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token: platformToken, aud: audience }),
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    // The caught error is never wrapped or logged: a fetch failure embeds the URL, and an abort must be distinguishable
    // from a refusal without leaking either.
    return { ok: false, reason: controller.signal.aborted ? "exchange_timeout" : "exchange_failed" };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return { ok: false, reason: "exchange_failed" };

  // Bounded read: a declared length over the ceiling is refused without reading a byte, and the text is capped anyway
  // so a chunked body with no declared length — or a lying one — cannot exceed it either.
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > EXCHANGE_MAX_RESPONSE_BYTES) return { ok: false, reason: "exchange_response_invalid" };
  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, reason: "exchange_failed" };
  }
  if (body.length > EXCHANGE_MAX_RESPONSE_BYTES) return { ok: false, reason: "exchange_response_invalid" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "exchange_response_invalid" };
  }
  const token = (parsed as { token?: unknown } | null)?.token;
  return typeof token === "string" && token.length > 0
    ? { ok: true, token }
    : { ok: false, reason: "exchange_response_invalid" };
}
