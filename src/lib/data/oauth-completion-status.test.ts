// Phase 8K — the customer-facing state of one Slack OAuth completion.
//
// Two properties. First: the ONLY thing that can make this say "completed" is the 0081 status wrapper returning
// `completed` — nothing here can infer it, default to it, or optimistically assume it. Second: an unauthorized caller,
// another tenant's job, and a job that never existed are INDISTINGUISHABLE, because "no such job" and "not yours" must
// not be separable answers.

import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const gate = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
vi.mock("./access-repository", () => ({ accessGate: () => gate() }));

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
  gate.mockReset();
  gate.mockResolvedValue({ ok: true, tenantId: TENANT });
  rpc.mockResolvedValue({ data: [row("pending")], error: null });
});

describe("mapping the job to a customer state", () => {
  it("calls the bounded product wrapper with the gate's tenant, never a caller-supplied one", async () => {
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
  const cases: Array<[string, () => void]> = [
    ["no active tenant", () => gate.mockResolvedValue({ ok: false })],
    ["empty set — denied, foreign, or absent", () => rpc.mockResolvedValue({ data: [], error: null })],
    ["null data", () => rpc.mockResolvedValue({ data: null, error: null })],
    ["an rpc error", () => rpc.mockResolvedValue({ data: null, error: { message: "permission denied for function LEAKME" } })],
    ["more than one row", () => rpc.mockResolvedValue({ data: [row("pending"), row("completed")], error: null })],
    ["a status outside the vocabulary", () => rpc.mockResolvedValue({ data: [{ job_status: "sneaky" }], error: null })],
    ["a row that is not a row", () => rpc.mockResolvedValue({ data: ["completed"], error: null })],
  ];

  it("every one of them produces the SAME terminal failure and nothing else", async () => {
    for (const [name, setup] of cases) {
      // Each case starts from a HEALTHY baseline. Without this the first case's `gate.mockResolvedValue({ ok: false })`
      // would still be in force for every case after it, and they would all pass through the access gate rather than
      // through the thing they claim to test. Mutation testing found exactly that: replacing the empty-set branch with
      // "completed" left this test green.
      gate.mockResolvedValue({ ok: true, tenantId: TENANT });
      rpc.mockResolvedValue({ data: [row("pending")], error: null });
      setup();
      const r = await getSlackConnectionStatus(CORR);
      expect(r, name).toEqual({ state: "failed", terminal: true });
      expect(JSON.stringify(r), name).not.toContain("LEAKME");
    }
  });

  it("refuses a malformed correlation id without ever reaching the database", async () => {
    for (const c of [null, undefined, "", "corr with spaces", "x".repeat(65), "corr/../other"]) {
      expect(await getSlackConnectionStatus(c), String(c)).toEqual({ state: "failed", terminal: true });
    }
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
