// Phase 8K — the customer-facing state of one Slack OAuth completion.
//
// Two properties. First: the ONLY thing that can make this say "completed" is the 0081 status wrapper returning
// `completed` — nothing here can infer it, default to it, or optimistically assume it. Second: an unauthorized caller,
// another tenant's job, and a job that never existed are INDISTINGUISHABLE, because "no such job" and "not yours" must
// not be separable answers.

import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const identity = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
// The tenant comes from the SERVER-PINNED environment identity, not from the session's active tenant — the job was
// written under the pinned one, and `activeTenant` is merely the alphabetically-first membership.
// Partial: `oauth-handoff-protocol.ts` re-exports real constants from this module, so a full replacement would break
// the grammar this file's own correlation-id assertions depend on.
vi.mock("@/lib/server/connector-vault/staging-environment-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/connector-vault/staging-environment-identity")>()),
  resolveStagingEnvironmentIdentity: () => identity(),
}));

import { CONNECTION_STATES, getSlackConnectionStatus } from "./oauth-completion-status";

const TENANT = "aaaa1111-1111-1111-1111-111111111111";
const CORR = "corr-live-run-1";
const row = (job_status: string) => ({
  job_status,
  job_created_at: "2026-08-02T10:00:00Z",
  job_expires_at: "2026-08-02T10:10:00Z",
  job_completed_at: null,
  job_terminal_reason: job_status === "failed" ? "exchange_failed" : null,
});

beforeEach(() => {
  rpc.mockReset();
  identity.mockReset();
  identity.mockReturnValue({ ok: true, tenantId: TENANT });
  rpc.mockResolvedValue({ data: [row("pending")], error: null });
});

describe("mapping the job to a customer state", () => {
  it("calls the bounded product wrapper with the SERVER-PINNED tenant, never the session's active one", async () => {
    await getSlackConnectionStatus(CORR);
    expect(rpc).toHaveBeenCalledWith("product_oauth_completion_job_status", { p_tenant_id: TENANT, p_correlation_id: CORR });
  });

  it("pending and claimed both read as 'completing' — a customer cannot act on the difference", async () => {
    for (const s of ["pending", "claimed"]) {
      rpc.mockResolvedValue({ data: [row(s)], error: null });
      expect(await getSlackConnectionStatus(CORR), s).toEqual({ state: "completing", terminal: false });
    }
  });

  it("'completed' comes ONLY from the wrapper saying completed", async () => {
    rpc.mockResolvedValue({ data: [row("completed")], error: null });
    expect(await getSlackConnectionStatus(CORR)).toEqual({ state: "completed", terminal: true });
  });

  it("failed and expired are terminal and distinct", async () => {
    rpc.mockResolvedValue({ data: [row("failed")], error: null });
    expect(await getSlackConnectionStatus(CORR)).toEqual({ state: "failed", terminal: true });
    rpc.mockResolvedValue({ data: [row("expired")], error: null });
    expect(await getSlackConnectionStatus(CORR)).toEqual({ state: "expired", terminal: true });
  });

  it("returns ONLY the state and its terminality — no timestamps, reason, ids or counts", async () => {
    for (const s of ["pending", "claimed", "completed", "failed", "expired"]) {
      rpc.mockResolvedValue({ data: [row(s)], error: null });
      const r = await getSlackConnectionStatus(CORR);
      expect(Object.keys(r).sort(), s).toEqual(["state", "terminal"]);
      const serialized = JSON.stringify(r);
      expect(serialized).not.toMatch(/2026-08-02|exchange_failed|job_|attempt|claim|digest|payload/);
      expect(CONNECTION_STATES).toContain(r.state);
    }
  });
});

describe("a denied read is indistinguishable from a job that does not exist", () => {
  // "We could not get an authoritative answer." Every one renders identically to a real failure — that is what keeps
  // denied / foreign / absent inseparable — but none of them is TERMINAL, because none of them is the job speaking.
  const nonAuthoritative: Array<[string, () => void]> = [
    ["empty set — denied, foreign, or absent", () => rpc.mockResolvedValue({ data: [], error: null })],
    ["null data", () => rpc.mockResolvedValue({ data: null, error: null })],
    ["an rpc error", () => rpc.mockResolvedValue({ data: null, error: { message: "permission denied for function LEAKME" } })],
    ["more than one row", () => rpc.mockResolvedValue({ data: [row("pending"), row("completed")], error: null })],
    ["a status outside the vocabulary", () => rpc.mockResolvedValue({ data: [{ job_status: "sneaky" }], error: null })],
    ["a row that is not a row", () => rpc.mockResolvedValue({ data: ["completed"], error: null })],
  ];

  const fresh = () => {
    // Each case starts from a HEALTHY baseline. Without this the first case's mock would still be in force for every
    // case after it, and they would all refuse for the first case's reason rather than for their own. Mutation testing
    // found exactly that: replacing the empty-set branch with "completed" left this test green.
    identity.mockReturnValue({ ok: true, tenantId: TENANT });
    rpc.mockResolvedValue({ data: [row("pending")], error: null });
  };

  it("every one renders IDENTICALLY, and carries nothing", async () => {
    for (const [name, setup] of nonAuthoritative) {
      fresh(); setup();
      const r = await getSlackConnectionStatus(CORR);
      expect(r.state, name).toBe("failed");
      expect(Object.keys(r).sort(), name).toEqual(["state", "terminal"]);
      expect(JSON.stringify(r), name).not.toContain("LEAKME");
    }
  });

  // The load-bearing half. One transient statement timeout on the first server render must not pin the screen to
  // "Connection failed" forever with polling disabled while the worker goes on to store a live Slack token.
  // (Found in adversarial review of PR #398.)
  it("none of them is TERMINAL — a read we could not make is not a job that failed", async () => {
    for (const [name, setup] of nonAuthoritative) {
      fresh(); setup();
      expect((await getSlackConnectionStatus(CORR)).terminal, name).toBe(false);
    }
  });

  it("…while the wrapper's OWN 'failed' is terminal — that one really is the job speaking", async () => {
    fresh();
    rpc.mockResolvedValue({ data: [row("failed")], error: null });
    expect(await getSlackConnectionStatus(CORR)).toEqual({ state: "failed", terminal: true });
  });

  it("refuses a malformed correlation id, terminally, without ever reaching the database", async () => {
    for (const c of [null, undefined, "", "corr with spaces", "x".repeat(65), "corr/../other"]) {
      // Terminal on purpose: a malformed id can never name a job, so there is nothing to wait for.
      expect(await getSlackConnectionStatus(c), String(c)).toEqual({ state: "failed", terminal: true });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses terminally outside the pinned staging environment — no job can exist there", async () => {
    identity.mockReturnValue({ ok: false, reason: "real_exchange_disabled" });
    expect(await getSlackConnectionStatus(CORR)).toEqual({ state: "failed", terminal: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not fall back to a table read when the wrapper refuses", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await getSlackConnectionStatus(CORR);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.every(([name]) => name === "product_oauth_completion_job_status")).toBe(true);
  });
});

describe("the read is the bounded wrapper and nothing else", () => {
  it("names no table and no other function", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = (require("node:fs") as typeof import("node:fs")).readFileSync("src/lib/data/oauth-completion-status.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/product_oauth_completion_job_status/);
    expect(code).not.toMatch(/\.from\(|oauth_completer_|oauth_completion_jobs|connector_secrets|oauth_pending/);
  });
});
