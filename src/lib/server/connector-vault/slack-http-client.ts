// Phase 8C — the ONE real Slack HTTP client. Server-only.
//
// Every other module in this vault takes `SlackHttpClient` as an injected TYPE and never reaches the network, which is what has
// kept an accidental `slack.com` call out of the test suite for eight phases. This is the single concrete implementation, and it
// exists so exactly one file has to be reviewed for network behaviour.
//
// It is deliberately minimal and does exactly one thing: POST a form body to an absolute https://slack.com URL and hand back
// status + text. It performs no retry, no redirect following, no JSON parsing and no logging — the exchange wrapper owns parsing
// and sanitisation, and a redirect on a token endpoint is a reason to fail, not to follow.
//
// WHAT IT MUST NEVER DO, and why each is enforced rather than documented:
//   * Log, echo or return the request body. It carries the client secret and the authorization code.
//   * Follow a redirect. A 30x from a token endpoint means something is wrong with the URL; following it would forward the
//     secret to wherever the redirect points.
//   * Accept a non-Slack URL. The caller builds the URL, but a bug or an injected value must not be able to post credentials to
//     an arbitrary host, so the host is checked here as well.

import type { SlackHttpClient } from "./slack-oauth-exchange";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/slack-http-client is server-only and must not be imported in client code");
}

export class SlackHttpClientError extends Error {
  constructor(public readonly reason: "bad_host" | "network" | "timeout") {
    // A static reason only. A network error message can contain the URL, and the URL is not always free of context.
    super(`slack_http_${reason}`);
    this.name = "SlackHttpClientError";
  }
}

const ALLOWED_ORIGIN = "https://slack.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export function makeSlackHttpClient(opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): SlackHttpClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // `fetchImpl` exists so tests can assert behaviour without a network. It defaults to the platform fetch — this module is the
  // only place in the vault where that is permitted.
  const doFetch = opts.fetchImpl ?? fetch;

  return async (url, init) => {
    // Host allowlist, checked here as well as at the caller. Posting a client secret to an attacker-chosen host is the worst
    // outcome this file could have, so it is guarded at the last possible point.
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new SlackHttpClientError("bad_host"); }
    if (parsed.origin !== ALLOWED_ORIGIN) throw new SlackHttpClientError("bad_host");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        // Never follow a redirect: a 30x here would forward the credential-bearing body elsewhere.
        redirect: "error",
        signal: controller.signal,
        cache: "no-store",
      });
      // The body is read ONCE and closed over. `json()` re-parses that captured text rather than touching the stream again, so
      // a caller that inspects the response twice cannot get a "body already consumed" error mid-exchange.
      //
      // Parsing failure is left to throw here and is caught by the exchange wrapper, which already sanitises malformed-JSON into
      // a static reason class. The raw text is never logged, returned or attached to an error.
      const text = await res.text();
      return { ok: res.ok, status: res.status, json: async () => JSON.parse(text) as unknown };
    } catch (e) {
      // The original error is deliberately dropped rather than wrapped: fetch failures embed the URL, and callers log errors.
      throw new SlackHttpClientError((e as { name?: string })?.name === "AbortError" ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
  };
}
