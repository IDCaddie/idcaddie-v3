// Phase 8K — the worker endpoint configuration and the bounded handoff client.
//
// Two properties, both of them about where a bearer assertion and a sealed authorization code are allowed to go:
//   1. the destination is settled from server-trusted config, exactly, before anything is sent;
//   2. what comes back is an acknowledgement or it is a bounded failure — there is no third outcome and no detail
//      carried out of it.
//
// The OIDC assertions here are assembled at test time, never committed as literals.

import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  HANDOFF_CORRELATION_HEADER,
  HANDOFF_DIGEST_HEADER,
  HANDOFF_PATH,
  HANDOFF_PAYLOAD_SCHEME,
  HANDOFF_PROTOCOL_VERSION,
  HANDOFF_REDIRECT_URI,
  HANDOFF_VERSION_HEADER,
  STAGING_VERCEL_PROJECT_ID,
  STAGING_VERCEL_TEAM_ID,
  canonicalHandoffBody,
  handoffBodyDigest,
  type HandoffRequest,
} from "./oauth-handoff-protocol";
import {
  HANDOFF_TIMEOUT_MS,
  WORKER_ALLOWED_HOSTS,
  preflightOwnAssertion,
  readVercelOidcAssertion,
  resolveWorkerHandoffConfig,
  submitHandoff,
} from "./oauth-handoff-client";
import { MIN_PROTECTED_PAYLOAD_BYTES } from "./oauth-handoff-protocol";

const spki = (key: KeyObject) => (key.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
const WORKER_KEY = spki(generateKeyPairSync("x25519").publicKey);
const HOST = "oauth-completion-worker.internal.example";
const ALLOWED = [HOST];
const AUDIENCE = "https://idcaddie.example/oauth-completion-worker";

const ENV: Record<string, string | undefined> = {
  OAUTH_COMPLETION_WORKER_URL: `https://${HOST}${HANDOFF_PATH}`,
  OAUTH_COMPLETION_WORKER_OIDC_AUDIENCE: AUDIENCE,
  OAUTH_COMPLETION_WORKER_PUBLIC_KEY: WORKER_KEY,
  OAUTH_COMPLETION_WORKER_PUBLIC_KEY_ID: "worker-seal-v1",
};
const withVal = (o: Record<string, string | undefined>) => ({ ...ENV, ...o });
const withOut = (k: string) => { const e = { ...ENV }; delete e[k]; return e; };
const resolve = (env = ENV) => resolveWorkerHandoffConfig(env, ALLOWED);

describe("worker endpoint configuration", () => {
  it("accepts the exact allowlisted HTTPS endpoint at the pinned path", () => {
    const r = resolve();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.endpoint).toBe(`https://${HOST}${HANDOFF_PATH}`);
    expect(r.config.audience).toBe(AUDIENCE);
    expect(r.config.workerKey.keyId).toBe("worker-seal-v1");
  });

  it("refuses a missing endpoint rather than defaulting to one", () => {
    expect(resolve(withOut("OAUTH_COMPLETION_WORKER_URL"))).toEqual({ ok: false, reason: "worker_url_missing" });
    expect(resolve(withVal({ OAUTH_COMPLETION_WORKER_URL: "   " }))).toEqual({ ok: false, reason: "worker_url_missing" });
  });

  it("refuses anything that is not exact HTTPS", () => {
    for (const [url, reason] of [
      [`http://${HOST}${HANDOFF_PATH}`, "worker_url_not_https"],
      [`ftp://${HOST}${HANDOFF_PATH}`, "worker_url_not_https"],
      ["not a url", "worker_url_malformed"],
      [`https://user:pw@${HOST}${HANDOFF_PATH}`, "worker_url_not_exact"],
      [`https://${HOST}${HANDOFF_PATH}?x=1`, "worker_url_not_exact"],
      [`https://${HOST}${HANDOFF_PATH}#frag`, "worker_url_not_exact"],
      [`https://${HOST}/some/other/path`, "worker_url_not_exact"],
      [`https://${HOST}${HANDOFF_PATH}/`, "worker_url_not_exact"],
      [`https://${HOST}:443${HANDOFF_PATH}`, "worker_url_not_exact"],  // normalizes away — not the configured string
      [`https://${HOST.toUpperCase()}${HANDOFF_PATH}`, "worker_url_not_exact"],
    ] as const) {
      expect(resolve(withVal({ OAUTH_COMPLETION_WORKER_URL: url })), url).toEqual({ ok: false, reason });
    }
  });

  // The doc-81 rule. A suffix or subdomain check accepts `worker.example.com.attacker.test`; whole hosts do not.
  it("refuses a host that is not on the allowlist, including suffix look-alikes", () => {
    for (const host of [`${HOST}.attacker.example`, `evil-${HOST}`, "attacker.example", `sub.${HOST}`]) {
      expect(resolve(withVal({ OAUTH_COMPLETION_WORKER_URL: `https://${host}${HANDOFF_PATH}` })), host)
        .toEqual({ ok: false, reason: "worker_host_not_allowlisted" });
    }
  });

  it("ships with an EMPTY allowlist — real mode cannot be opened from the environment", () => {
    expect(WORKER_ALLOWED_HOSTS).toEqual([]);
    expect(resolveWorkerHandoffConfig(ENV)).toEqual({ ok: false, reason: "worker_host_not_allowlisted" });
  });

  it("refuses missing or malformed OIDC/key configuration", () => {
    expect(resolve(withOut("OAUTH_COMPLETION_WORKER_OIDC_AUDIENCE"))).toEqual({ ok: false, reason: "worker_audience_missing" });
    expect(resolve(withOut("OAUTH_COMPLETION_WORKER_PUBLIC_KEY"))).toEqual({ ok: false, reason: "worker_public_key_missing" });
    expect(resolve(withOut("OAUTH_COMPLETION_WORKER_PUBLIC_KEY_ID"))).toEqual({ ok: false, reason: "worker_public_key_id_invalid" });
    expect(resolve(withVal({ OAUTH_COMPLETION_WORKER_PUBLIC_KEY_ID: "has spaces" }))).toEqual({ ok: false, reason: "worker_public_key_id_invalid" });
    for (const bad of ["not-base64!!", Buffer.alloc(44, 1).toString("base64"), spki(generateKeyPairSync("ed25519").publicKey)]) {
      expect(resolve(withVal({ OAUTH_COMPLETION_WORKER_PUBLIC_KEY: bad })), bad.slice(0, 12))
        .toEqual({ ok: false, reason: "worker_public_key_malformed" });
    }
  });

  it("never places a configured value in a refusal", () => {
    for (const env of [
      withVal({ OAUTH_COMPLETION_WORKER_URL: "https://LEAKME.attacker.example/internal/oauth-completion/handoff" }),
      withVal({ OAUTH_COMPLETION_WORKER_PUBLIC_KEY: "LEAKME-not-a-key" }),
      withVal({ OAUTH_COMPLETION_WORKER_PUBLIC_KEY_ID: "LEAKME key id" }),
    ]) {
      const r = resolve(env);
      expect(r.ok).toBe(false);
      const s = JSON.stringify(r);
      expect(s).not.toContain("LEAKME");
      expect(s).not.toContain(WORKER_KEY);
      expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
    }
  });
});

// ── The assertion source ─────────────────────────────────────────────────────────────────────────────────────────────
const b64url = (s: string) => Buffer.from(s).toString("base64url");
const assertionWith = (claims: Record<string, unknown>) =>
  `${b64url(JSON.stringify({ alg: "RS256", kid: "k" }))}.${b64url(JSON.stringify(claims))}.${b64url("signature-bytes")}`;
const NOW_S = 1_800_000_000;
const GOOD_CLAIMS = { aud: AUDIENCE, project_id: STAGING_VERCEL_PROJECT_ID, owner_id: STAGING_VERCEL_TEAM_ID, exp: NOW_S + 600 };
const ASSERTION = assertionWith(GOOD_CLAIMS);

describe("the OIDC assertion source", () => {
  it("reads the assertion from the ENVIRONMENT only", () => {
    expect(readVercelOidcAssertion({ VERCEL_OIDC_TOKEN: ASSERTION })).toBe(ASSERTION);
    expect(readVercelOidcAssertion({})).toBeNull();
    expect(readVercelOidcAssertion({ VERCEL_OIDC_TOKEN: "" })).toBeNull();
  });

  // An inbound header is attacker-controlled and this value becomes an outbound Authorization header. The module must
  // contain no path from a request to the assertion at all, so the property is asserted against the source.
  it("has no path from a request header to the assertion", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = (require("node:fs") as typeof import("node:fs")).readFileSync("src/lib/server/connector-vault/oauth-handoff-client.ts", "utf8");
    const fn = src.slice(src.indexOf("export function readVercelOidcAssertion"), src.indexOf("preflightOwnAssertion"));
    expect(fn).not.toMatch(/request|headers\.get|Request|x-vercel-oidc-token/);
    expect(fn).toMatch(/env\.VERCEL_OIDC_TOKEN/);
  });

  it("refuses to send an assertion minted for a different audience, project or team", () => {
    const preflight = (t: string | null) => preflightOwnAssertion(t, { audience: AUDIENCE, nowSeconds: NOW_S });
    expect(preflight(ASSERTION)).toEqual({ ok: true });
    expect(preflight(null)).toEqual({ ok: false, reason: "handoff_assertion_missing" });
    expect(preflight("not.a")).toEqual({ ok: false, reason: "handoff_assertion_malformed" });
    expect(preflight("a.b.c")).toEqual({ ok: false, reason: "handoff_assertion_malformed" });
    // Vercel's DEFAULT team audience is the misconfiguration this catches: it is a valid token, for someone else.
    expect(preflight(assertionWith({ ...GOOD_CLAIMS, aud: "https://vercel.com/idcaddie" })))
      .toEqual({ ok: false, reason: "handoff_assertion_audience_mismatch" });
    expect(preflight(assertionWith({ ...GOOD_CLAIMS, project_id: "prj_SOMEOTHER" })))
      .toEqual({ ok: false, reason: "handoff_assertion_project_mismatch" });
    expect(preflight(assertionWith({ ...GOOD_CLAIMS, owner_id: "team_SOMEOTHER" })))
      .toEqual({ ok: false, reason: "handoff_assertion_project_mismatch" });
    expect(preflight(assertionWith({ ...GOOD_CLAIMS, exp: NOW_S - 1 })))
      .toEqual({ ok: false, reason: "handoff_assertion_expired" });
    expect(preflight(assertionWith({ aud: AUDIENCE, project_id: STAGING_VERCEL_PROJECT_ID, owner_id: STAGING_VERCEL_TEAM_ID })))
      .toEqual({ ok: false, reason: "handoff_assertion_expired" });
  });

  // A payload that is not a claims OBJECT must refuse, not throw. `JSON.parse("null")` returns null, and dereferencing
  // it would escape this function's declared result union — the callback's blanket catch would then report the failure
  // as `seal_failed`, blaming the crypto for an assertion problem. (Found in adversarial review of PR #398.)
  it("refuses a payload that is not a claims object rather than throwing on it", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    for (const payload of ["null", "5", '"a string"', "[]", "true"]) {
      const token = `${b64(JSON.stringify({ alg: "RS256", kid: "k" }))}.${b64(payload)}.${b64("sig")}`;
      expect(() => preflightOwnAssertion(token, { audience: AUDIENCE, nowSeconds: NOW_S }), payload).not.toThrow();
      expect(preflightOwnAssertion(token, { audience: AUDIENCE, nowSeconds: NOW_S }), payload)
        .toEqual({ ok: false, reason: "handoff_assertion_malformed" });
    }
  });

  it("does not claim the preflight is authentication", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = (require("node:fs") as typeof import("node:fs")).readFileSync("src/lib/server/connector-vault/oauth-handoff-client.ts", "utf8");
    expect(src).toMatch(/NOT authentication/);
    // It must not verify a signature, because it cannot: the JWKS lives with the worker.
    expect(src.slice(src.indexOf("export function preflightOwnAssertion"))).not.toMatch(/verify\(|createPublicKey/);
  });
});

// ── The request itself ───────────────────────────────────────────────────────────────────────────────────────────────
const REQUEST: HandoffRequest = {
  version: HANDOFF_PROTOCOL_VERSION,
  environment: "staging",
  correlationId: "corr-live-run-1",
  tenantId: "aaaa1111-1111-1111-1111-111111111111",
  connectorId: "1575cde3-0000-4000-8000-00000000bbbb",
  provider: "slack",
  redirectUri: HANDOFF_REDIRECT_URI,
  expectedTeamId: "T0ABCDEF123",
  payloadScheme: HANDOFF_PAYLOAD_SCHEME,
  payloadKeyId: "worker-seal-v1",
  protectedPayload: Buffer.alloc(MIN_PROTECTED_PAYLOAD_BYTES + 1, 7).toString("base64"),
};
const ENDPOINT = `https://${HOST}${HANDOFF_PATH}`;
const ackResponse = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const submit = (fetchImpl: Parameters<typeof submitHandoff>[1]["fetchImpl"]) =>
  submitHandoff(REQUEST, { endpoint: ENDPOINT, assertion: ASSERTION, fetchImpl });

describe("submitting the handoff", () => {
  it("posts the canonical body with the assertion and both binding headers", async () => {
    const fetchImpl = vi.fn(async () => ackResponse(200, { version: 1, status: "accepted" }));
    const r = await submit(fetchImpl);
    expect(r).toEqual({ ok: true, ack: { version: 1, status: "accepted" } });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(canonicalHandoffBody(REQUEST));
    expect(headers.authorization).toBe(`Bearer ${ASSERTION}`);
    expect(headers[HANDOFF_VERSION_HEADER]).toBe("1");
    expect(headers[HANDOFF_CORRELATION_HEADER]).toBe(REQUEST.correlationId);
    expect(headers[HANDOFF_DIGEST_HEADER]).toBe(handoffBodyDigest(canonicalHandoffBody(REQUEST)));
    // A 30x on this endpoint would forward the assertion wherever it points; a cached response would be a replayed ack.
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    // The bound is PINNED, not merely "a signal exists": a customer's browser waits on this, and so does the function.
    // (Found in adversarial review of PR #398 — 8s could have become ten minutes undetected.)
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(HANDOFF_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(HANDOFF_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("actually aborts a worker that never answers", async () => {
    const started = Date.now();
    const r = await submitHandoff(REQUEST, {
      endpoint: ENDPOINT,
      assertion: ASSERTION,
      timeoutMs: 25,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    expect(r).toEqual({ ok: false, reason: "handoff_transport_failed" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  // `await response.text()` would materialise the whole decompressed body before any ceiling could apply, so a
  // compromised worker could answer 200 with a decompression bomb and OOM the function — a platform 500 instead of the
  // bounded redirect this design promises. (Found in adversarial review of PR #398.)
  it("stops reading a hostile body at the ceiling instead of buffering all of it", async () => {
    let emitted = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x41);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 64 MB if anything ever drains it to completion; the reader must give up long before that.
        if (emitted >= 1024) return controller.close();
        emitted += 1;
        controller.enqueue(chunk);
      },
    });
    const r = await submit(async () => new Response(body, { status: 200 }));
    expect(r).toEqual({ ok: false, reason: "handoff_ack_invalid" });
    // Enough to cross the ceiling, and nowhere near enough to have drained the stream.
    expect(emitted).toBeGreaterThan(0);
    expect(emitted).toBeLessThan(1024);
  });

  it("treats a 409 duplicate as a real outcome, not a failure", async () => {
    const r = await submit(async () => ackResponse(409, { version: 1, status: "duplicate" }));
    expect(r).toEqual({ ok: true, ack: { version: 1, status: "duplicate" } });
  });

  it("refuses when the HTTP status and the acknowledgement disagree", async () => {
    expect(await submit(async () => ackResponse(200, { version: 1, status: "duplicate" }))).toEqual({ ok: false, reason: "handoff_ack_invalid" });
    expect(await submit(async () => ackResponse(409, { version: 1, status: "accepted" }))).toEqual({ ok: false, reason: "handoff_ack_invalid" });
  });

  it("refuses every other status", async () => {
    for (const status of [201, 202, 301, 400, 401, 403, 404, 429, 500, 502, 503]) {
      expect(await submit(async () => ackResponse(status, { version: 1, status: "accepted" })), String(status))
        .toEqual({ ok: false, reason: "handoff_rejected" });
    }
    // 204 cannot carry a body at all, so it is refused for the same reason: it is not an acknowledgement.
    expect(await submit(async () => new Response(null, { status: 204 }))).toEqual({ ok: false, reason: "handoff_rejected" });
  });

  it("refuses an acknowledgement that is not one", async () => {
    for (const body of [
      "not json",
      { version: 1, status: "completed" },
      { version: 2, status: "accepted" },
      { version: 1, status: "accepted", jobId: "9f1c2f5a-0000-4000-8000-000000000001" },
      { status: "accepted" },
      "x".repeat(5000),
    ]) {
      expect(await submit(async () => ackResponse(200, body)), JSON.stringify(body).slice(0, 30))
        .toEqual({ ok: false, reason: "handoff_ack_invalid" });
    }
  });

  it("discards the underlying transport error rather than wrapping it", async () => {
    const r = await submit(async () => { throw new Error(`getaddrinfo ENOTFOUND ${HOST} SECRETDETAIL`); });
    expect(r).toEqual({ ok: false, reason: "handoff_transport_failed" });
    expect(JSON.stringify(r)).not.toMatch(/ENOTFOUND|SECRETDETAIL|internal\.example/);
  });

  it("makes exactly ONE attempt — a retry would have to reuse the same sealed bytes", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network"); });
    await submit(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const rejecting = vi.fn(async () => ackResponse(500, ""));
    await submit(rejecting);
    expect(rejecting).toHaveBeenCalledTimes(1);
  });

  it("never places the assertion or the sealed payload in a refusal", async () => {
    const r = await submit(async () => ackResponse(500, "detail"));
    const s = JSON.stringify(r);
    expect(s).not.toContain(ASSERTION);
    expect(s).not.toContain(REQUEST.protectedPayload);
    expect(s).not.toContain("detail");
    expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
  });
});
