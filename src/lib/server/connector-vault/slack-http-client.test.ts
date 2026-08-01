import { describe, it, expect, vi } from "vitest";
import { makeSlackHttpClient, SlackHttpClientError } from "./slack-http-client";

// Phase 8C — the ONE file in the vault that touches the network.
//
// It carries the Slack client secret and the authorization code in a request body, so the failure modes that matter are not
// "does it work" but "where could the credential go". Every test below is about containment.

const SECRET_BODY = "client_id=abc&client_secret=SUPER-SECRET&code=ONE-TIME-CODE";
const ok = (body: string, status = 200) => ({ ok: status < 400, status, text: async () => body }) as unknown as Response;

describe("the credential can only ever reach Slack", () => {
  it("refuses any host that is not slack.com", async () => {
    const spy = vi.fn();
    const c = makeSlackHttpClient({ fetchImpl: spy as unknown as typeof fetch });
    for (const url of [
      "https://slack.com.evil.test/api/oauth.v2.access",   // suffix attack
      "http://slack.com/api/oauth.v2.access",              // downgraded scheme
      "https://hooks.slack.com/api/oauth.v2.access",       // different subdomain
      "https://evil.test/api/oauth.v2.access",
      "not-a-url",
    ]) {
      await expect(c(url, { method: "POST", headers: {}, body: SECRET_BODY })).rejects.toThrow(SlackHttpClientError);
    }
    // The decisive assertion: no request was ever ATTEMPTED. Rejecting after the fetch would have already sent the secret.
    expect(spy, "the secret must not leave the process for a bad host").not.toHaveBeenCalled();
  });

  it("never follows a redirect — a 30x would forward the body elsewhere", async () => {
    const spy = vi.fn(async () => ok("{}"));
    const c = makeSlackHttpClient({ fetchImpl: spy as unknown as typeof fetch });
    await c("https://slack.com/api/oauth.v2.access", { method: "POST", headers: {}, body: SECRET_BODY });
    expect((spy.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "error" });
  });

  it("does not cache a credentialed request", async () => {
    const spy = vi.fn(async () => ok("{}"));
    const c = makeSlackHttpClient({ fetchImpl: spy as unknown as typeof fetch });
    await c("https://slack.com/api/oauth.v2.access", { method: "POST", headers: {}, body: SECRET_BODY });
    expect((spy.mock.calls[0] as unknown[])[1]).toMatchObject({ cache: "no-store" });
  });
});

describe("errors carry a static reason and nothing else", () => {
  it("drops the underlying network error rather than wrapping it", async () => {
    // fetch failures embed the URL, and callers log errors. The original is deliberately discarded.
    const c = makeSlackHttpClient({ fetchImpl: (async () => { throw new Error("connect ECONNREFUSED 1.2.3.4:443 https://slack.com/api/x?code=LEAK"); }) as unknown as typeof fetch });
    const err = await c("https://slack.com/api/oauth.v2.access", { method: "POST", headers: {}, body: SECRET_BODY }).catch((e) => e);
    expect(err).toBeInstanceOf(SlackHttpClientError);
    expect(err.message).toBe("slack_http_network");
    expect(JSON.stringify({ m: err.message, s: err.stack?.split("\n")[0] })).not.toMatch(/LEAK|ECONNREFUSED|1\.2\.3\.4/);
  });

  it("reports a timeout distinctly, and aborts rather than hanging", async () => {
    const c = makeSlackHttpClient({
      timeoutMs: 5,
      fetchImpl: ((_u: string, init: { signal: AbortSignal }) => new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch,
    });
    const err = await c("https://slack.com/api/oauth.v2.access", { method: "POST", headers: {}, body: SECRET_BODY }).catch((e) => e);
    expect(err.reason).toBe("timeout");
  });

  it("never puts the request body in an error", async () => {
    for (const impl of [
      async () => { throw new Error("boom"); },
      async () => ok("not json", 500),
    ]) {
      const c = makeSlackHttpClient({ fetchImpl: impl as unknown as typeof fetch });
      const r = await c("https://slack.com/api/oauth.v2.access", { method: "POST", headers: {}, body: SECRET_BODY })
        .then((res) => res.json().catch((e) => e), (e) => e);
      expect(JSON.stringify(r ?? {}) + String((r as Error)?.message ?? "")).not.toContain("SUPER-SECRET");
      expect(JSON.stringify(r ?? {}) + String((r as Error)?.message ?? "")).not.toContain("ONE-TIME-CODE");
    }
  });
});

describe("the response is handed on unparsed and re-readable", () => {
  it("lets json() be called more than once without consuming a stream", async () => {
    // The exchange wrapper may inspect the response twice; a "body already consumed" mid-exchange would be a confusing
    // failure on the one path that must fail cleanly.
    const c = makeSlackHttpClient({ fetchImpl: (async () => ok('{"ok":true,"access_token":"xoxb-x"}')) as unknown as typeof fetch });
    const res = await c("https://slack.com/api/oauth.v2.access", { method: "POST", headers: {}, body: SECRET_BODY });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
  });

  it("does not interpret a non-ok response — that is the wrapper's job", async () => {
    const c = makeSlackHttpClient({ fetchImpl: (async () => ok('{"ok":false,"error":"invalid_code"}', 200)) as unknown as typeof fetch });
    const res = await c("https://slack.com/api/oauth.v2.access", { method: "POST", headers: {}, body: SECRET_BODY });
    expect(res.ok).toBe(true);           // HTTP 200 — Slack signals failure in the body, not the status
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_code" });
  });
});
