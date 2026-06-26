import { describe, it, expect, vi, beforeEach } from "vitest";
import { emitSlackDiscoveryFacts, slackUserCandidates, type SlackEmitContext } from "./slack-discovery-emitter";
import { parseDiscoveryFact } from "./discovery-facts";

// Slack P0 PR 3 — discovery-fact emitter. Synthetic normalized records only; no Slack call, no DB, no resolver.
const TENANT = "tenant-arg-001";
const CTX: SlackEmitContext = { observedAt: "2026-06-26T00:00:00.000Z", sourceRunId: "run-1" };
const WORKSPACE = { ok: true as const, teamId: "T1", userId: "U_AUTH", teamName: "Acme", url: "https://acme.slack.com" };

const user = (over: Record<string, unknown> = {}) => ({
  slackUserId: "U1", teamId: "T1", email: "Ada@X.test", displayName: "Ada", title: "Eng", status: "coding",
  roleHint: "member", isAdmin: false, isOwner: false, isPrimaryOwner: false, isRestricted: false,
  isUltraRestricted: false, isBot: false, isDeleted: false, lastActivityAt: 1700000000, timezone: "America/Toronto",
  rawProvenance: { updated: 1700000000 }, ...over,
}) as unknown as Parameters<typeof emitSlackDiscoveryFacts>[0]["users"][number];

const emit = (users: unknown[], tenant = TENANT) =>
  emitSlackDiscoveryFacts({ workspace: WORKSPACE, users: users as Parameters<typeof emitSlackDiscoveryFacts>[0]["users"] }, tenant, CTX);
const types = (facts: { fact_type: string }[]) => facts.map((f) => f.fact_type);

let consoleDump: string[];
beforeEach(() => {
  consoleDump = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleDump.push(a.map(String).join(" ")); });
});

describe("slack-discovery-emitter — workspace facts", () => {
  it("emits app_discovery once and app_instance_identity once (anchored on team id)", () => {
    const { facts } = emit([]);
    expect(types(facts).filter((t) => t === "app_discovery")).toHaveLength(1);
    expect(types(facts).filter((t) => t === "app_instance_identity")).toHaveLength(1);
    const app = facts.find((f) => f.fact_type === "app_discovery") as Record<string, unknown>;
    expect(app).toMatchObject({ discovered_app_name: "Slack", category: "Communication", signal_id: "slack:app_discovery:slack" });
    const inst = facts.find((f) => f.fact_type === "app_instance_identity") as Record<string, unknown>;
    expect(inst).toMatchObject({ external_instance_id: "T1", workspace_id: "T1", signal_id: "slack:app_instance:T1" });
  });
});

describe("slack-discovery-emitter — per-user facts", () => {
  it("app_user_account for a user WITH email", () => {
    const acct = emit([user()]).facts.find((f) => f.fact_type === "app_user_account") as Record<string, unknown>;
    expect(acct).toMatchObject({ app_user_external_id: "U1", app_instance_key: "T1", app_id_hint: "slack", email: "ada@x.test", display_name: "Ada", role_hint: "member", signal_id: "slack:app_user:T1:U1" });
  });

  it("app_user_account is STILL emitted for a user WITHOUT email (no throw, no drop)", () => {
    const { facts } = emit([user({ email: undefined })]);
    const acct = facts.find((f) => f.fact_type === "app_user_account") as Record<string, unknown>;
    expect(acct).toBeTruthy();
    expect(acct.email).toBeUndefined();
    expect(types(facts)).not.toContain("person_identity_candidate"); // no email → no person
  });

  it("person_identity_candidate ONLY when email exists; signal id keyed on NORMALIZED lower-cased email", () => {
    const withEmail = emit([user({ email: "  Ada@X.TEST " })]).facts.find((f) => f.fact_type === "person_identity_candidate") as Record<string, unknown>;
    expect(withEmail).toMatchObject({ primary_email: "ada@x.test", display_name: "Ada", signal_id: "slack:person:ada@x.test" });
    // missing email → never CONSTRUCTED (not constructed-then-dropped):
    const noEmail = emit([user({ slackUserId: "U2", email: undefined })]).facts;
    expect(noEmail.some((f) => f.fact_type === "person_identity_candidate")).toBe(false);
  });

  it("no malformed person_identity_candidate (empty/blank email) ever slips through", () => {
    for (const bad of [undefined, "", "   ", "not-an-email", null]) {
      const facts = emit([user({ slackUserId: "Ux", email: bad })]).facts;
      expect(facts.some((f) => f.fact_type === "person_identity_candidate")).toBe(false);
    }
  });

  it("role_admin for admin/owner/primary_owner; priority primary_owner > owner > admin", () => {
    const admin = emit([user({ isAdmin: true })]).facts.find((f) => f.fact_type === "role_admin") as Record<string, unknown>;
    expect(admin).toMatchObject({ role_name: "admin", is_admin: true, role_scope: "T1", signal_id: "slack:role_admin:T1:U1" });
    expect((emit([user({ isAdmin: true, isOwner: true })]).facts.find((f) => f.fact_type === "role_admin") as Record<string, unknown>).role_name).toBe("owner");
    expect((emit([user({ isAdmin: true, isOwner: true, isPrimaryOwner: true })]).facts.find((f) => f.fact_type === "role_admin") as Record<string, unknown>).role_name).toBe("primary_owner");
  });

  it("plain member: NO role_admin; role is carried only by app_user_account.role_hint='member'", () => {
    const { facts } = emit([user()]);
    expect(types(facts)).not.toContain("role_admin");
    expect((facts.find((f) => f.fact_type === "app_user_account") as Record<string, unknown>).role_hint).toBe("member");
  });

  it("usage_activity ONLY when lastActivityAt exists; omitted when unknown", () => {
    const withAct = emit([user()]).facts.find((f) => f.fact_type === "usage_activity") as Record<string, unknown>;
    expect(withAct).toMatchObject({ last_activity_at: "2023-11-14T22:13:20.000Z", usage_source: "slack_users_list_updated", signal_id: "slack:usage:T1:U1" });
    expect(emit([user({ lastActivityAt: undefined })]).facts.some((f) => f.fact_type === "usage_activity")).toBe(false);
    expect(emit([user({ lastActivityAt: 0 })]).facts.some((f) => f.fact_type === "usage_activity")).toBe(false); // 0 → not real
  });

  it("bot records are not emitted (defensive, even though the client filters)", () => {
    expect(emit([user({ isBot: true })]).facts).toHaveLength(2); // only the 2 workspace facts
    expect(slackUserCandidates(user({ slackUserId: "USLACKBOT", isBot: false }), "T1", TENANT, CTX)).toEqual([]);
  });
});

describe("slack-discovery-emitter — safety + idempotency + validation", () => {
  it("tenant_id ALWAYS from the argument — a payload tenant_id is ignored", () => {
    const { facts } = emit([user({ tenant_id: "EVIL-TENANT", tid: "EVIL" })]);
    for (const f of facts) expect((f as Record<string, unknown>).tenant_id).toBe(TENANT);
    expect(JSON.stringify(facts)).not.toContain("EVIL");
  });

  it("no token / auth header / raw Slack object reaches facts or provenance", () => {
    const { facts } = emit([user({ token: "xoxb-evil-leak", access_token: "secret", profile: { email: "x@y.test" }, _raw: { nested: 1 } })]);
    const blob = JSON.stringify(facts);
    for (const bad of ["xoxb-evil-leak", "access_token", "_raw", "Bearer "]) expect(blob).not.toContain(bad);
    expect(consoleDump.join("\n")).not.toContain("xoxb-evil-leak");
  });

  it("every emitted fact passes parseDiscoveryFact (strict) — no unknown fields", () => {
    const { facts, built, rejected } = emit([user(), user({ slackUserId: "U2", isAdmin: true }), user({ slackUserId: "U3", email: undefined })]);
    for (const f of facts) expect(parseDiscoveryFact(f).success).toBe(true);
    expect(rejected).toBe(0); // a stray unknown field would land here, not in facts
    expect(built).toBe(facts.length);
  });

  it("out-of-range lastActivityAt does NOT throw or fail the batch — usage_activity omitted, other facts kept", () => {
    let result: ReturnType<typeof emit> | undefined;
    expect(() => { result = emit([user({ slackUserId: "U_GOOD" }), user({ slackUserId: "U_BAD", email: "bad@x.test", lastActivityAt: 1e20 })]); }).not.toThrow();
    const facts = result!.facts;
    const accts = facts.filter((f) => f.fact_type === "app_user_account") as Record<string, unknown>[];
    expect(accts.map((f) => f.app_user_external_id).sort()).toEqual(["U_BAD", "U_GOOD"]); // both users kept
    expect(facts.filter((f) => f.fact_type === "usage_activity")).toHaveLength(1); // only U_GOOD has a usable activity ts
    expect((accts.find((f) => f.app_user_external_id === "U_BAD") as Record<string, unknown>).last_activity_at).toBeUndefined();
  });

  it("a malformed record is skipped without failing the rest of the batch", () => {
    const { facts } = emit([null, "str", { no_id: true }, user({ slackUserId: "U9" })]);
    const accts = facts.filter((f) => f.fact_type === "app_user_account");
    expect(accts).toHaveLength(1);
    expect((accts[0] as Record<string, unknown>).app_user_external_id).toBe("U9");
  });

  it("signal ids are deterministic (no random / no timestamp in id) across two runs", () => {
    const a = emit([user(), user({ slackUserId: "U2", isOwner: true })]).facts.map((f) => (f as Record<string, unknown>).signal_id);
    const b = emit([user(), user({ slackUserId: "U2", isOwner: true })]).facts.map((f) => (f as Record<string, unknown>).signal_id);
    expect(a).toEqual(b);
    for (const id of a) { expect(id).not.toMatch(/\d{13}/); expect(String(id)).not.toContain(CTX.observedAt); } // no epoch-ms / no timestamp
  });

  it("has_2fa / has_sso are never read (not present on input, not emitted)", () => {
    const { facts } = emit([user({ has_2fa: true, has_sso: true, hasSso: true, has2fa: true })]);
    const blob = JSON.stringify(facts);
    for (const k of ["has_2fa", "has_sso", "has2fa", "hasSso"]) expect(blob).not.toContain(k);
  });

  it("fails closed: empty tenant, missing observed_at, or no workspace team id → no facts", () => {
    expect(emit([user()], "").facts).toEqual([]);
    expect(emitSlackDiscoveryFacts({ workspace: WORKSPACE, users: [user()] }, TENANT, { observedAt: "" }).facts).toEqual([]);
    expect(emitSlackDiscoveryFacts({ workspace: { ok: true, teamId: "", userId: "U" } as never, users: [user()] }, TENANT, CTX).facts).toEqual([]);
  });
});
