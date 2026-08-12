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
 * The dedicated audience this deployment's assertion must be minted for. Vercel's default `aud` is
 * `https://vercel.com/<team-slug>`, which EVERY relying party in the team receives — a token minted for any of them
 * would otherwise authenticate a handoff. Requesting a dedicated audience narrows the assertion to this worker, and the
 * worker refuses the default by name.
 */
export const HANDOFF_OIDC_AUDIENCE = "https://idcaddie.com/oauth-completion-worker" as const;

/** The shape of `getVercelOidcToken` from `@vercel/oidc`. Injected so tests never touch the platform. */
export type VercelOidcTokenGetter = (options: { audience: string }) => Promise<string>;

/**
 * Acquire the Vercel OIDC assertion, minted for OUR dedicated audience.
 *
 * ── WHERE THE TOKEN COMES FROM, AND WHY THIS IS NOT THE THING §8.4 FORBIDS ──────────────────────────────────────────
 * This used to read `process.env.VERCEL_OIDC_TOKEN` and nothing else. That was wrong for the runtime this actually runs
 * in: Vercel documents `VERCEL_OIDC_TOKEN` as the BUILD and LOCAL-DEVELOPMENT path, while in Vercel Functions the
 * platform supplies the token through the function's request context (`x-vercel-oidc-token`). An env-only read is
 * therefore empty in production and the handoff could never authenticate.
 *
 * The rule that matters is unchanged and is about TRUST, not about which transport the platform chose:
 *   * application code must NEVER read `x-vercel-oidc-token` off a request itself, and never treat any caller-supplied
 *     header or body value as an assertion — a value we do not control must not become an outbound `Authorization`;
 *   * the ONLY permitted source is the official `@vercel/oidc` SDK, which reads the platform-injected token from
 *     Vercel's own trusted request context. We never see, parse or choose the raw header.
 * `oauth-handoff-architecture.test.ts` enforces both halves against the source of every file on this path.
 *
 * ── THE AUDIENCE IS AN EXCHANGE ────────────────────────────────────────────────────────────────────────────────────
 * Passing `audience` makes the SDK exchange the platform token for one whose `aud` is exactly that string. It is not a
 * project setting and there is nothing to configure in the dashboard. A failed exchange returns null and the caller
 * fails closed — an assertion for the wrong audience must never be sent instead.
 */
export async function acquireHandoffAssertion(
  getToken: VercelOidcTokenGetter,
  audience: string = HANDOFF_OIDC_AUDIENCE,
): Promise<string | null> {
  let token: unknown;
  try {
    token = await getToken({ audience });
  } catch {
    // The caught error is DISCARDED, never wrapped or logged: an SDK error can embed the token, the exchange URL and
    // response body. The caller reports a bounded reason.
    return null;
  }
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

  // Parse into `unknown` and CHECK before dereferencing — `JSON.parse("null")` returns null, and a cast would make the
  // next line throw a TypeError instead of returning the bounded refusal this function's type promises.
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as unknown;
  } catch {
    return { ok: false, reason: "handoff_assertion_malformed" };
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return { ok: false, reason: "handoff_assertion_malformed" };
  }
  const claims = decoded as Record<string, unknown>;

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
 * Read at most `limit` bytes of a response body, then stop and release the stream.
 *
 * Streaming rather than buffering is the whole point: the ceiling has to be enforced while the bytes arrive, not after
 * they have all been decompressed into memory. One byte over the limit is enough to decide — the caller only needs to
 * know the body is too large, never what the rest of it said.
 */
async function readBounded(response: Response, limit: number): Promise<string> {
  const body = response.body;
  // No stream (an empty body, or a fetch implementation that does not expose one). There is nothing to bound.
  if (!body) return await response.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total > limit) break; // one byte over is enough; do not keep reading a hostile body
    }
  } finally {
    // Releases the connection whether we finished or bailed out early.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)), Math.min(total, limit + 1)).toString("utf8");
}

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
  void MAX_HANDOFF_BODY_BYTES;

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

  // Read the acknowledgement with a HARD byte ceiling, streaming.
  //
  // `await response.text()` would materialise the whole DECOMPRESSED body before any ceiling could be applied, so a
  // compromised worker — the exact threat doc 83 §2 names — could answer 200 with ~600 KB of gzip that inflates to
  // ~600 MB and OOM-kill the function. The customer would then get a platform 500 instead of the bounded redirect this
  // design promises, which is precisely the third outcome it says cannot exist. Measured at 1.7 GB RSS before this
  // change. (Found in adversarial review of PR #398.)
  let text: string;
  try {
    text = await readBounded(response, MAX_ACK_BYTES);
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
