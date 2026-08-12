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
// `readPlatformToken` is NOT exported, and THE EXCHANGE TAKES NO INJECTABLE DEPENDENCIES. The raw platform token never
// leaves this module: the only export takes an audience and returns an EXCHANGED token.
//
// IT USED TO TAKE `deps: { fetchImpl?, readContext? }`, and that was the same defect as the `readAssertion` seam it
// replaced, in a new spelling and strictly worse. A caller supplying `fetchImpl` received the RAW PLATFORM TOKEN in
// `init.body` — the module header claimed a dataflow property while handing the value to caller-supplied code before
// any exchange happened — and, by returning a `Response` of its choosing, could also decide the assertion that went on
// the wire to the worker. A review demonstrated both. Neither the dataflow guard nor the construction-site pin caught
// it: both watched the RETURN value and the CALL SITE, and the leak was in the argument.
//
// So there is no seam at all now. The token comes from the platform context, the network is the global `fetch`, and
// tests drive the REAL globals (`Symbol.for("@vercel/request-context")`, `vi.stubGlobal("fetch")`) exactly as the
// runtime does — a test double installed on the global cannot be reached through a production signature.
//
// ── WHAT THIS DOES AND DOES NOT DEFEND ───────────────────────────────────────────────────────────────────────────────
// It defends the API SURFACE: no caller, however it is written, can obtain the raw token or choose the assertion by
// calling into this module. That is checkable and it is checked.
//
// It does NOT defend against code already executing in this process. Using the global `fetch` means any module that
// loads first can replace it and intercept the exchange — a review demonstrated exactly that from a `.js` module, and
// capturing a reference at module load would not help, since the patch can load earlier. Nothing at this layer can fix
// that, because a module running in the function can read `process.env` and the request context directly anyway.
//
// The control for that threat is therefore not a signature but MEMBERSHIP: `vercel-platform-oidc.dataflow.test.ts`
// pins the callback route's entire import closure by name, across every extension the runtime resolves. A new module
// fails that test whatever it contains. The boundary is "no unreviewed module runs in the callback", not "hostile code
// in the callback cannot reach the token" — the second is not achievable and is not claimed.
//
// The platform value is INFRASTRUCTURE METADATA supplied by the runtime, not application input. Vercel documents
// `x-vercel-oidc-token` on the function's request context as the delivery mechanism; we read it only through that
// context object, never off a `Request` we were handed.

/** Vercel's request-context global. The runtime sets it; nothing in this repository writes it. */
const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

type RequestContext = { headers?: Record<string, string | undefined> };

function readContext(): RequestContext {
  const g = globalThis as Record<symbol, { get?: () => RequestContext } | undefined>;
  return g[VERCEL_REQUEST_CONTEXT]?.get?.() ?? {};
}

/**
 * Read the platform token. Module-private on purpose — see the trust rule above.
 *
 * The env var is the BUILD and LOCAL-DEVELOPMENT path and is kept as a fallback for exactly those, matching Vercel's
 * documented behaviour and the SDK's own precedence. In a deployed Function the context header is what answers.
 */
function readPlatformToken(): string | null {
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

import { readBounded } from "./read-bounded";

/**
 * Exchange the platform token for one whose `aud` is exactly `audience`.
 *
 * Protocol, from Vercel's own client: `POST https://oidc.vercel.com/~token`, JSON `{ token, aud }`, JSON `{ token }`.
 *
 * Every outbound discipline this repository applies elsewhere applies here: exact URL, `redirect: "error"` so a 30x
 * cannot carry the bearer to another origin, `cache: "no-store"`, an `AbortController` ceiling, a bounded read, and a
 * bounded parse. The provider's error body is DISCARDED rather than surfaced — it can echo the token we just sent.
 */
export async function exchangeForDedicatedAudience(audience: string, timeoutMs: number = EXCHANGE_TIMEOUT_MS): Promise<ExchangeResult> {
  const platformToken = readPlatformToken();
  if (platformToken === null) return { ok: false, reason: "platform_token_missing" };

  // ONE DEADLINE COVERS THE WHOLE EXCHANGE — fetch, headers, the streamed body read, and the parse.
  //
  // It used to be cleared in a `finally` around the fetch alone, which disarmed it the moment HEADERS arrived. A server
  // that answered instantly and then trickled the body held this browser-blocking callback open indefinitely: measured
  // at 9s against a 3000ms ceiling, and it would have run to the platform function timeout. `readBounded` bounds SIZE;
  // only a live signal bounds TIME, and the two are different hazards.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = () => controller.signal.aborted;
  try {
    let response: Response;
    try {
      response = await fetch(VERCEL_TOKEN_EXCHANGE_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token: platformToken, aud: audience }),
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      // The caught error is never wrapped or logged: a fetch failure embeds the URL, and an abort must be
      // distinguishable from a refusal without leaking either.
      return { ok: false, reason: timedOut() ? "exchange_timeout" : "exchange_failed" };
    }

    // The body is CANCELLED on every path that does not read it. Without this the deadline is cleared by the `finally`
    // below while the provider's stream stays open, held until GC — an idle connection per refusal on a hot path.
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { ok: false, reason: "exchange_failed" };
    }

    // BOUNDED READ. A declared length over the ceiling is refused without reading a byte — but `Content-Length` can be
    // absent, wrong, or describe the COMPRESSED size, so the stream is capped as it arrives too. `readBounded` stops one
    // byte PAST the limit rather than draining a hostile body — one byte, because stopping exactly AT it would return a
    // truncated body that the `> limit` check below cannot distinguish from a legitimate one. The deadline stays armed
    // throughout: `readBounded` races each read against the same signal, so a trickled body cannot outlast it.
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > EXCHANGE_MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => {});
      return { ok: false, reason: "exchange_response_invalid" };
    }
    let body: string;
    try {
      body = await readBounded(response, EXCHANGE_MAX_RESPONSE_BYTES, controller.signal);
    } catch {
      return { ok: false, reason: timedOut() ? "exchange_timeout" : "exchange_failed" };
    }
    if (timedOut()) return { ok: false, reason: "exchange_timeout" };
    if (Buffer.byteLength(body, "utf8") > EXCHANGE_MAX_RESPONSE_BYTES) return { ok: false, reason: "exchange_response_invalid" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, reason: "exchange_response_invalid" };
    }
    if (timedOut()) return { ok: false, reason: "exchange_timeout" };
    const token = (parsed as { token?: unknown } | null)?.token;
    return typeof token === "string" && token.length > 0
      ? { ok: true, token }
      : { ok: false, reason: "exchange_response_invalid" };
  } finally {
    // Cleared only once every phase is done, so a fast success does not hold the event loop open.
    clearTimeout(timer);
  }
}
