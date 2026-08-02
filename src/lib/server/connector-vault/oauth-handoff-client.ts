// Phase 8K — the bounded V3 → completion-worker handoff client. Server-only.
//
// This is the ONE place the web tier reaches out during OAuth completion, and the only network call the callback makes.
// It does NOT contact Slack: the token exchange belongs to the worker, and this repository has no path to it from the
// callback (`oauth-handoff-architecture.test.ts` asserts that).
//
// The discipline mirrors `slack-http-client.ts`, for the same reasons and with the same failure modes:
//   * the destination is validated BEFORE the request is attempted — refusing afterwards would already have sent the
//     bearer token and the sealed code somewhere,
//   * `redirect: "error"` — a 30x on this endpoint would forward an OIDC assertion wherever it points,
//   * `cache: "no-store"`, an explicit timeout, and a bounded read of the response,
//   * the underlying network error is DISCARDED, not wrapped: fetch errors embed the URL, and callers log errors.
//
// No assertion, claim, sealed payload, digest or environment value appears in a log or an error. Nothing here calls
// `console.*`.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import {
  HANDOFF_CORRELATION_HEADER,
  HANDOFF_DIGEST_HEADER,
  HANDOFF_PATH,
  HANDOFF_PROTOCOL_VERSION,
  HANDOFF_VERSION_HEADER,
  MAX_HANDOFF_BODY_BYTES,
  STAGING_VERCEL_PROJECT_ID,
  STAGING_VERCEL_TEAM_ID,
  canonicalHandoffBody,
  handoffAckSchema,
  handoffBodyDigest,
  type HandoffAck,
  type HandoffRequest,
} from "./oauth-handoff-protocol";
import { PayloadSealError, parseWorkerSealKey, type WorkerSealKey } from "./oauth-payload-seal";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-handoff-client is server-only and must not be imported in client code");
}

/**
 * The worker hosts a handoff may be posted to. EXACT hosts, compared as whole strings — the doc 81 rule: a suffix or
 * subdomain check accepts `worker.example.com.evil.test`, and this request carries a bearer assertion and a sealed
 * authorization code.
 *
 * DELIBERATELY EMPTY. The completion worker is not deployed and its host is not known, so real mode fails closed here
 * with `worker_host_not_allowlisted` until a reviewed change adds the host — the same shape as `REAL_CALLBACK_URIS` in
 * `connector-oauth-config.ts`. An operator cannot open this from the environment; that is the point.
 */
export const WORKER_ALLOWED_HOSTS: readonly string[] = [];

/** How long the handoff may take before it is abandoned. The browser is waiting, and the job's own deadline is 10
 *  minutes — a slow worker must not hold a request open long enough to matter. */
export const HANDOFF_TIMEOUT_MS = 8000;
/** The acknowledgement is two small fields. Anything larger is not an acknowledgement. */
const MAX_ACK_BYTES = 4096;

export type WorkerHandoffConfig = {
  endpoint: string;
  /** The audience the assertion must carry. Dedicated to the completion worker — never Vercel's default team audience. */
  audience: string;
  workerKey: WorkerSealKey;
};

export type WorkerConfigRefusal =
  | "worker_url_missing"
  | "worker_url_malformed"
  | "worker_url_not_https"
  | "worker_url_not_exact"
  | "worker_host_not_allowlisted"
  | "worker_audience_missing"
  | "worker_public_key_missing"
  | "worker_public_key_malformed"
  | "worker_public_key_id_invalid";

export type HandoffRefusal =
  | "handoff_assertion_missing"
  | "handoff_assertion_malformed"
  | "handoff_assertion_audience_mismatch"
  | "handoff_assertion_project_mismatch"
  | "handoff_assertion_expired"
  | "handoff_body_too_large"
  | "handoff_transport_failed"
  | "handoff_rejected"
  | "handoff_ack_invalid";

type Env = Record<string, string | undefined>;

/**
 * Resolve the worker handoff configuration from server-trusted environment values, or refuse with a bounded reason.
 *
 * Every rule is fail-closed and none of them has a default. The endpoint must be the EXACT normalized HTTPS URL of an
 * allowlisted host at the pinned path — no credentials, no query, no fragment, no alternative path — because the value
 * this resolves is what a bearer assertion and a sealed authorization code get posted to.
 */
export function resolveWorkerHandoffConfig(
  env: Env = process.env,
  allowedHosts: readonly string[] = WORKER_ALLOWED_HOSTS,
): { ok: true; config: WorkerHandoffConfig } | { ok: false; reason: WorkerConfigRefusal } {
  const rawUrl = env.OAUTH_COMPLETION_WORKER_URL;
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) return { ok: false, reason: "worker_url_missing" };

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "worker_url_malformed" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "worker_url_not_https" };
  if (url.username.length > 0 || url.password.length > 0) return { ok: false, reason: "worker_url_not_exact" };
  if (url.search.length > 0 || url.hash.length > 0) return { ok: false, reason: "worker_url_not_exact" };
  if (url.pathname !== HANDOFF_PATH) return { ok: false, reason: "worker_url_not_exact" };
  // `href` is the normalized form. Requiring the configured value to equal it rejects anything that only becomes valid
  // after normalization — a default port written out, a differently-cased host, an encoded path separator.
  if (url.href !== rawUrl.trim()) return { ok: false, reason: "worker_url_not_exact" };
  if (!allowedHosts.includes(url.host)) return { ok: false, reason: "worker_host_not_allowlisted" };

  const audience = env.OAUTH_COMPLETION_WORKER_OIDC_AUDIENCE;
  if (typeof audience !== "string" || audience.trim().length === 0) return { ok: false, reason: "worker_audience_missing" };

  // Base64 of the SPKI DER — see `parseWorkerSealKey` for why the format carries its own curve identity.
  const publicKey = env.OAUTH_COMPLETION_WORKER_PUBLIC_KEY;
  if (typeof publicKey !== "string" || publicKey.trim().length === 0) return { ok: false, reason: "worker_public_key_missing" };

  let workerKey: WorkerSealKey;
  try {
    workerKey = parseWorkerSealKey(publicKey.trim(), env.OAUTH_COMPLETION_WORKER_PUBLIC_KEY_ID?.trim());
  } catch (error) {
    if (error instanceof PayloadSealError && error.reason === "worker_public_key_id_invalid") {
      return { ok: false, reason: "worker_public_key_id_invalid" };
    }
    return { ok: false, reason: "worker_public_key_malformed" };
  }

  return { ok: true, config: { endpoint: url.href, audience: audience.trim(), workerKey } };
}

/**
 * Read the Vercel OIDC assertion.
 *
 * From the ENVIRONMENT only. Vercel injects `VERCEL_OIDC_TOKEN` into the function's environment and refreshes it; it is
 * NEVER read from an incoming request header, because an inbound `x-vercel-oidc-token` is attacker-controlled and this
 * value becomes the `Authorization` header of an outbound request.
 */
export function readVercelOidcAssertion(env: Env = process.env): string | null {
  const token = env.VERCEL_OIDC_TOKEN;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * A CLIENT-SIDE sanity check on our own assertion. This is NOT authentication and must never be described as such — the
 * worker verifies the signature and every pinned claim (`verifyHandoffAssertion`), and this function verifies nothing.
 *
 * It exists to catch a misconfiguration before a bearer token leaves the building: a token minted for Vercel's default
 * team audience rather than the dedicated worker audience, a token from the wrong project or team, or an expired one.
 * Refusing here means the assertion is never sent to a relying party it was not minted for.
 */
export function preflightOwnAssertion(
  token: string | null,
  expected: { audience: string; nowSeconds: number },
): { ok: true } | { ok: false; reason: HandoffRefusal } {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "handoff_assertion_missing" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return { ok: false, reason: "handoff_assertion_malformed" };

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "handoff_assertion_malformed" };
  }

  const audRaw = claims.aud;
  const aud = typeof audRaw === "string" ? audRaw : Array.isArray(audRaw) && audRaw.length === 1 && typeof audRaw[0] === "string" ? audRaw[0] : null;
  if (aud !== expected.audience) return { ok: false, reason: "handoff_assertion_audience_mismatch" };
  if (claims.project_id !== STAGING_VERCEL_PROJECT_ID || claims.owner_id !== STAGING_VERCEL_TEAM_ID) {
    return { ok: false, reason: "handoff_assertion_project_mismatch" };
  }
  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || !(exp > expected.nowSeconds)) {
    return { ok: false, reason: "handoff_assertion_expired" };
  }
  return { ok: true };
}

export type HandoffFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Post one handoff and return a bounded acknowledgement.
 *
 * Exactly one attempt. There is no transport retry, deliberately: a retry would have to re-send the SAME sealed bytes to
 * be idempotent under migration 0081's `body_digest`, and a caller that instead re-sealed would be making a new request
 * that 0081 refuses. One attempt makes "reuse the same buffer" structurally true rather than a rule to remember, and a
 * genuine retry is the customer pressing the retry link, which re-authorizes.
 *
 * `duplicate` is a SUCCESSFUL outcome for the browser's purposes: a job already exists for this correlation, so the
 * truthful next screen is the pending page, not a failure.
 */
export async function submitHandoff(
  request: HandoffRequest,
  deps: {
    endpoint: string;
    assertion: string;
    fetchImpl: HandoffFetch;
    timeoutMs?: number;
  },
): Promise<{ ok: true; ack: HandoffAck } | { ok: false; reason: HandoffRefusal }> {
  const body = canonicalHandoffBody(request);
  if (Buffer.byteLength(body, "utf8") > MAX_HANDOFF_BODY_BYTES) return { ok: false, reason: "handoff_body_too_large" };

  let response: Response;
  try {
    response = await deps.fetchImpl(deps.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.assertion}`,
        "content-type": "application/json",
        accept: "application/json",
        [HANDOFF_VERSION_HEADER]: String(HANDOFF_PROTOCOL_VERSION),
        [HANDOFF_CORRELATION_HEADER]: request.correlationId,
        [HANDOFF_DIGEST_HEADER]: handoffBodyDigest(body),
      },
      body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? HANDOFF_TIMEOUT_MS),
    });
  } catch {
    // Discarded on purpose — a fetch failure embeds the URL, and DNS/TLS errors sometimes embed more.
    return { ok: false, reason: "handoff_transport_failed" };
  }

  // 200 = enqueued. 409 = the correlation already has a job (0081 refused a re-sealed retry). Everything else, including
  // every 5xx and every redirect the fetch did not already reject, is a bounded failure with no detail carried out.
  if (response.status !== 200 && response.status !== 409) return { ok: false, reason: "handoff_rejected" };

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, reason: "handoff_transport_failed" };
  }
  if (text.length > MAX_ACK_BYTES) return { ok: false, reason: "handoff_ack_invalid" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "handoff_ack_invalid" };
  }
  const ack = handoffAckSchema.safeParse(parsed);
  if (!ack.success) return { ok: false, reason: "handoff_ack_invalid" };
  // The status and the HTTP code must agree; a 200 claiming `duplicate` (or the reverse) is a worker that is not
  // speaking this protocol, and guessing which half to believe is how a customer gets told the wrong thing.
  if ((response.status === 200) !== (ack.data.status === "accepted")) return { ok: false, reason: "handoff_ack_invalid" };

  return { ok: true, ack: ack.data };
}
