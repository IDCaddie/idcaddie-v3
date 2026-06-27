import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Mock the request-context IO modules so importing the trigger never loads next/headers. The trigger tests use an
// INJECTED io, so these mocks are never actually called — they just keep the import graph headless.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/auth/tenant-context", () => ({ resolveTenantContext: vi.fn() }));

import { isInternalSlackTriggerEnabled, authorizeInternalTrigger, runInternalSlackSync, type InternalTriggerIo } from "./internal-slack-trigger";
import type { ResolvedTenantContext } from "@/lib/auth/tenant-context";
import type { RunSlackSyncSummary } from "./run-slack-sync-dev";

const DEV = { NODE_ENV: "development", ID_CADDIE_INTERNAL_SLACK_TRIGGER_ENABLED: "1" } as Record<string, string | undefined>;
const ctx = (over: Partial<ResolvedTenantContext>): ResolvedTenantContext =>
  ({ activeTenant: { id: "tA", name: "A", slug: "a", role: "owner" }, tenantSwitchingRequired: false, ...over } as ResolvedTenantContext);
const ok: RunSlackSyncSummary = { ok: true, teamPresent: true, usersFetched: 1, factsEmitted: 6, factsRejected: 0, appUsersWritten: 1, peopleWritten: 1, matchesWritten: 1, matchConflicts: 0, skipped: 2 };

describe("isInternalSlackTriggerEnabled — allowlist-shaped, fail-closed", () => {
  it("enables ONLY local dev + the distinct trigger opt-in", () => {
    expect(isInternalSlackTriggerEnabled(DEV)).toBe(true);
    for (const env of [
      {}, { NODE_ENV: "production", ID_CADDIE_INTERNAL_SLACK_TRIGGER_ENABLED: "1" },
      { NODE_ENV: "development", VERCEL_ENV: "preview", ID_CADDIE_INTERNAL_SLACK_TRIGGER_ENABLED: "1" },
      { NODE_ENV: "development", VERCEL_ENV: "production", ID_CADDIE_INTERNAL_SLACK_TRIGGER_ENABLED: "1" },
      { NODE_ENV: "test", ID_CADDIE_INTERNAL_SLACK_TRIGGER_ENABLED: "1" }, { NODE_ENV: "development" },
      { NODE_ENV: "development", ID_CADDIE_INTERNAL_SLACK_TRIGGER_ENABLED: "true" },
    ]) expect(isInternalSlackTriggerEnabled(env)).toBe(false);
  });
});

describe("authorizeInternalTrigger — env + auth + write-role tenant, all server-side", () => {
  it("owner/admin/editor of a single active tenant are authorized (tenant from the auth context)", () => {
    for (const role of ["owner", "admin", "editor"] as const)
      expect(authorizeInternalTrigger(DEV, { id: "u" }, ctx({ activeTenant: { id: "tA", name: "A", slug: "a", role } }))).toEqual({ ok: true, tenantId: "tA" });
  });
  it("refuses: disabled env, unauthenticated, no active tenant, multiple tenants, viewer", () => {
    expect(authorizeInternalTrigger({ NODE_ENV: "production" }, { id: "u" }, ctx({}))).toEqual({ ok: false, errorCode: "trigger_disabled" });
    expect(authorizeInternalTrigger(DEV, null, ctx({}))).toEqual({ ok: false, errorCode: "unauthenticated" });
    expect(authorizeInternalTrigger(DEV, { id: "u" }, ctx({ activeTenant: null }))).toEqual({ ok: false, errorCode: "no_active_tenant" });
    expect(authorizeInternalTrigger(DEV, { id: "u" }, ctx({ tenantSwitchingRequired: true }))).toEqual({ ok: false, errorCode: "tenant_switch_required" });
    expect(authorizeInternalTrigger(DEV, { id: "u" }, ctx({ activeTenant: { id: "tA", name: "A", slug: "a", role: "viewer" } }))).toEqual({ ok: false, errorCode: "insufficient_role" });
  });
  it("a request-supplied opt-in cannot enable it — only the env arg is read", () => {
    void { headers: { ID_CADDIE_INTERNAL_SLACK_TRIGGER_ENABLED: "1" } };
    expect(authorizeInternalTrigger({ NODE_ENV: "development" }, { id: "u" }, ctx({})).ok).toBe(false); // no opt-in in env → disabled
  });
});

describe("runInternalSlackSync — authorize → run the existing chain (injected io)", () => {
  const io = (over: Partial<InternalTriggerIo>): InternalTriggerIo => ({
    env: DEV, getUser: async () => ({ id: "u" }), getContext: async () => ctx({}), runChain: async () => ok, ...over,
  });

  it("an authorized run calls the chain with the auth-derived tenant and returns the safe summary", async () => {
    const runChain = vi.fn(async () => ok);
    const res = await runInternalSlackSync(io({ getContext: async () => ctx({ activeTenant: { id: "tENANT", name: "n", slug: "s", role: "admin" } }), runChain }));
    expect(res).toEqual(ok);
    expect(runChain).toHaveBeenCalledWith("tENANT"); // tenant from the context, not any request input
  });

  it("a refused trigger NEVER calls the chain (no Slack/emitter/resolver), returns the safe errorCode", async () => {
    const runChain = vi.fn(async () => ok);
    const res = await runInternalSlackSync(io({ getContext: async () => ctx({ activeTenant: { id: "tA", name: "A", slug: "a", role: "viewer" } }), runChain }));
    expect(res).toEqual({ ok: false, errorCode: "insufficient_role" });
    expect(runChain).not.toHaveBeenCalled();
  });

  it("a duplicate active run passes through run_already_active from the chain", async () => {
    const res = await runInternalSlackSync(io({ runChain: async () => ({ ok: false, errorCode: "run_already_active" }) }));
    expect(res).toEqual({ ok: false, errorCode: "run_already_active" });
  });

  it("the returned summary carries no token/JWT/email/name/raw", async () => {
    const blob = JSON.stringify(await runInternalSlackSync(io({})));
    for (const bad of ["xoxb", "Bearer", "@", "profile", "members", "eyJ"]) expect(blob).not.toContain(bad);
  });
});

describe("internal trigger page + action — internal/dev only, no customer-facing CTA, no service-role", () => {
  const dir = path.resolve(__dirname, "..", "..", "..", "app", "(authenticated)", "internal", "slack-sync");
  const page = fs.readFileSync(path.join(dir, "page.tsx"), "utf8");
  const action = fs.readFileSync(path.join(dir, "actions.ts"), "utf8");
  it("the page is flag-gated and labeled internal-dev (button only when enabled)", () => {
    expect(page).toContain("isInternalSlackTriggerEnabled");
    expect(page).toContain("Internal dev Slack sync");
    expect(page).toContain("not enabled in this environment");
  });
  it("no customer-facing / production / scheduler language", () => {
    for (const bad of ["Connect Slack", "Production sync", "Production Slack", "OAuth", "scheduler", "cron", "every hour", "Connect workspace"])
      expect(page).not.toContain(bad);
  });
  it("no token/JWT/raw rendered; action takes no caller input (no service-role is enforced repo-wide by check-auth-safety)", () => {
    for (const bad of ["xoxb", "Bearer ", "access_token", "raw_payload", "supabaseAdmin"]) { expect(page).not.toContain(bad); expect(action).not.toContain(bad); }
    expect(action).toContain('"use server"');
    expect(action).toContain("runInternalSlackSync(");
  });
});
