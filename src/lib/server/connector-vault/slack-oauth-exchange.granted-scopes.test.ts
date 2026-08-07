import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  exchangeSlackOAuthCode,
  REQUIRED_SLACK_BOT_SCOPES,
  type SlackHttpClient,
  type SlackHttpResponse,
  type ClientSecretProvider,
  type ExchangeStoreHandoff,
  type SlackExchangeInput,
} from "./slack-oauth-exchange";

// The granted-scope gate: what Slack ASKED for and what Slack GRANTED are different facts, and only the second one is
// in this response. A token short of `users:read.email` exchanges, stores, passes `auth.test` and completes discovery —
// then matches nobody, because `normalized_email` is the only automatic identity-matching method Slack has. So the
// check has to happen HERE, before the store, and these tests exist to prove it cannot be skipped.

const TOKEN_SENTINEL = "xoxb-2222222222-3333333333-MUSTNOTLEAKbbbbbbbbbbbb";
const SECRET_SENTINEL = "MUSTNOTLEAK-slack-client-secret-sentinel";
const CODE = "synthetic-auth-code-MUSTNOTLEAK";
const REDIRECT = "https://app.example.com/connectors/oauth/callback";
const TEAM = "T0ABCDEF123";

const input = (over: Partial<SlackExchangeInput> = {}): SlackExchangeInput => ({
  code: CODE,
  redirectUri: REDIRECT,
  tenantId: "11111111-1111-1111-1111-111111111111",
  connectorId: "22222222-2222-2222-2222-222222222222",
  version: 2,
  correlationId: "corr-scope-gate-01",
  expectedTeamId: TEAM,
  ...over,
});

const okSecret = (): ClientSecretProvider => ({ read: async () => SECRET_SENTINEL });
const httpReturning = (body: unknown): SlackHttpClient => async () => {
  const resp: SlackHttpResponse = { ok: true, status: 200, json: async () => body };
  return resp;
};
// Captures every plaintext handed to the store. If the gate works, a refusal leaves this EMPTY — that is the assertion
// that matters most, because "refused" and "refused before storing" are different claims.
const captureStore = () => {
  const captured: { plaintext: string }[] = [];
  const store: ExchangeStoreHandoff = async (i) => {
    captured.push({ plaintext: i.plaintext });
    return { ok: true, ref: { secretId: "sec-1" } };
  };
  return { store, captured };
};
const body = (scope: unknown, over: Record<string, unknown> = {}) => ({
  ok: true, access_token: TOKEN_SENTINEL, token_type: "bot",
  team: { id: TEAM, name: "disposable-dev" },
  ...(scope === undefined ? {} : { scope }),
  // The USER-token grant. Present in a real response, a different principal, and deliberately never read: a user token
  // carrying every scope in the world must not satisfy the BOT contract.
  authed_user: { id: "U9", scope: "users:read,users:read.email,usergroups:read", access_token: "xoxp-MUSTNOTLEAK-user", token_type: "user" },
  ...over,
});

let consoleDump: string[];
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK BLOCKED"); }));
  consoleDump = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleDump.push(a.map(String).join(" ")); });
  }
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function run(scope: unknown, over: Record<string, unknown> = {}) {
  const { store, captured } = captureStore();
  let result: unknown; let thrown: unknown;
  try {
    result = await exchangeSlackOAuthCode(input(), {
      clientId: "11111.22222", httpClient: httpReturning(body(scope, over)), clientSecret: okSecret(), store,
    });
  } catch (e) { thrown = e; }
  const dump = JSON.stringify({ result, thrown: thrown instanceof Error ? thrown.message : thrown, console: consoleDump });
  return { result, thrown, captured, dump };
}
const refused = (r: { result: unknown }, reason: string) => expect(r.result).toEqual({ ok: false, reason });
// Every refusal path must satisfy ALL of these, not just the reason. A gate that refuses and stores anyway is worse
// than no gate, because the row exists and the job says it failed.
const storedNothing = (r: { captured: unknown[]; dump: string }) => {
  expect(r.captured).toHaveLength(0);
  expect(r.dump).not.toContain(TOKEN_SENTINEL);
  expect(r.dump).not.toContain(SECRET_SENTINEL);
  expect(r.dump).not.toContain(CODE);
  expect(r.dump).not.toContain("xoxp-MUSTNOTLEAK-user");
};

describe("granted-scope gate — the required set is pinned to the manifest, not hand-maintained", () => {
  it("REQUIRED_SLACK_BOT_SCOPES equals the union of slack.v1.json's declared endpoint scopes", () => {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "src/lib/server/connectors/manifests/slack.v1.json"), "utf8"),
    ) as { endpoints?: { required_scopes?: string[] }[] };
    const declared = [...new Set((raw.endpoints ?? []).flatMap((e) => e.required_scopes ?? []))].sort();
    expect([...REQUIRED_SLACK_BOT_SCOPES].sort()).toEqual(declared);
  });

  it("contains no duplicate (the extras check compares a Set size against this length)", () => {
    expect(new Set(REQUIRED_SLACK_BOT_SCOPES).size).toBe(REQUIRED_SLACK_BOT_SCOPES.length);
  });

  it("is exactly the three reviewed scopes and grants nothing beyond read", () => {
    expect([...REQUIRED_SLACK_BOT_SCOPES].sort()).toEqual(["usergroups:read", "users:read", "users:read.email"]);
    for (const s of REQUIRED_SLACK_BOT_SCOPES) expect(s).not.toMatch(/^(chat|channels|groups|im|mpim|files|admin)[.:]/);
  });
});

describe("granted-scope gate — ACCEPTS exactly the reviewed set, in any order", () => {
  it("the exact three succeed and the token reaches the store", async () => {
    const r = await run("users:read,users:read.email,usergroups:read");
    expect(r.result).toEqual({ ok: true, ref: { secretId: "sec-1" } });
    expect(r.captured).toHaveLength(1);
    expect(r.captured[0].plaintext).toBe(TOKEN_SENTINEL); // handed off, never returned
    expect(r.dump).not.toContain(TOKEN_SENTINEL);
  });

  // Slack does not promise an ordering, so ordering must not be load-bearing. All six permutations, not a token sample.
  it("succeeds for every permutation of the three", async () => {
    const perms = [
      "users:read,users:read.email,usergroups:read",
      "users:read,usergroups:read,users:read.email",
      "users:read.email,users:read,usergroups:read",
      "users:read.email,usergroups:read,users:read",
      "usergroups:read,users:read,users:read.email",
      "usergroups:read,users:read.email,users:read",
    ];
    for (const p of perms) {
      const r = await run(p);
      expect(r.result, `permutation ${p}`).toEqual({ ok: true, ref: { secretId: "sec-1" } });
    }
  });

  it("tolerates the whitespace a comma-separated list may carry", async () => {
    const r = await run(" users:read , users:read.email ,usergroups:read ");
    expect(r.result).toEqual({ ok: true, ref: { secretId: "sec-1" } });
  });
});

describe("granted-scope gate — REFUSES a short grant, before the store", () => {
  const cases: [string, string][] = [
    ["missing users:read", "users:read.email,usergroups:read"],
    ["missing users:read.email", "users:read,usergroups:read"],
    ["missing usergroups:read", "users:read,users:read.email"],
    // The exact set the app requested before Phase 8P, and the exact set the pre-8P staging token was minted under.
    ["the OLD two-scope grant", "users:read,usergroups:read"],
    ["only one scope", "users:read"],
    ["none of the required scopes", "channels:read,chat:write"],
  ];
  for (const [name, scope] of cases) {
    it(`${name} → granted_scopes_insufficient, nothing stored, nothing leaked`, async () => {
      const r = await run(scope);
      refused(r, "granted_scopes_insufficient");
      storedNothing(r);
    });
  }

  it("a USER-token grant carrying all three does NOT satisfy the bot contract", async () => {
    // `authed_user.scope` has all three in every case above; the bot `scope` here has none. Reading the wrong field
    // would turn this into a pass.
    const r = await run("channels:read");
    refused(r, "granted_scopes_insufficient");
    storedNothing(r);
  });
});

// The case both suites were missing. The gate refuses through TWO independent checks — a membership loop over the
// required set, then a cardinality comparison — and every refusal fixture until now had the wrong SIZE. So the extras
// check alone accounted for all of them, and deleting the membership loop broke nothing anywhere.
//
// It is not a theoretical gap. With the loop deleted, `users:read,usergroups:read,chat:write` passes the size check
// (3 === 3) and is stored: a token that cannot read an email address and CAN post to the workspace, with the job marked
// completed. That is the exact outcome this gate exists to prevent, plus a write capability nobody reviewed.
describe("granted-scope gate — a WRONG set of the RIGHT size", () => {
  const SAME_SIZE_WRONG = "users:read,usergroups:read,chat:write"; // 3 scopes: email MISSING, chat:write UNEXPECTED

  it("refuses it and stores nothing", async () => {
    const r = await run(SAME_SIZE_WRONG);
    expect(r.result).toEqual({ ok: false, reason: "granted_scopes_insufficient" });
    storedNothing(r);
  });

  // The single reason names the MISSING side, because the membership loop returns before the cardinality check is
  // reached. Both defects are real and both are caught — but they are caught by different checks, so proving it takes
  // decomposing the input rather than reading one reason and claiming it says two things.
  it("the missing scope is what refuses it: drop the extra and it is STILL refused", async () => {
    const r = await run("users:read,usergroups:read"); // email still missing, nothing unexpected
    expect(r.result).toEqual({ ok: false, reason: "granted_scopes_insufficient" });
    storedNothing(r);
  });

  it("the extra is independently caught: supply the missing scope and it refuses as UNEXPECTED", async () => {
    const r = await run("users:read,users:read.email,usergroups:read,chat:write");
    expect(r.result).toEqual({ ok: false, reason: "granted_scopes_unexpected" });
    storedNothing(r);
  });

  it("order is irrelevant to a same-size wrong set too", async () => {
    for (const p of [
      "chat:write,users:read,usergroups:read",
      "usergroups:read,chat:write,users:read",
      "users:read,chat:write,usergroups:read",
    ]) {
      const r = await run(p);
      expect(r.result, `permutation ${p}`).toEqual({ ok: false, reason: "granted_scopes_insufficient" });
      expect(r.captured, `permutation ${p}`).toHaveLength(0);
    }
  });

  it("three scopes with NONE of the required ones is refused, not merely counted", async () => {
    const r = await run("channels:read,chat:write,files:read");
    expect(r.result).toEqual({ ok: false, reason: "granted_scopes_insufficient" });
    storedNothing(r);
  });

  // The control. Without this the suite could pass by refusing everything, which is the other way to make a gate
  // useless.
  it("the exact reviewed three still succeed, in any order", async () => {
    for (const p of [
      "users:read,users:read.email,usergroups:read",
      "usergroups:read,users:read.email,users:read",
      "users:read.email,users:read,usergroups:read",
    ]) {
      const r = await run(p);
      expect(r.result, `permutation ${p}`).toEqual({ ok: true, ref: { secretId: "sec-1" } });
      expect(r.captured, `permutation ${p}`).toHaveLength(1);
    }
  });
});

describe("granted-scope gate — REFUSES extra scopes (exact equality, a documented judgement)", () => {
  it("the three PLUS an extra → granted_scopes_unexpected, nothing stored", async () => {
    const r = await run("users:read,users:read.email,usergroups:read,chat:write");
    refused(r, "granted_scopes_unexpected");
    storedNothing(r);
  });

  it("a superset that includes a write scope is refused rather than silently accepted", async () => {
    const r = await run("users:read,users:read.email,usergroups:read,channels:read,files:write");
    refused(r, "granted_scopes_unexpected");
    storedNothing(r);
  });

  // The direction is the whole point of having two reasons: under- and over-scoped have opposite remedies.
  it("under-scoped and over-scoped are DISTINGUISHABLE", async () => {
    expect((await run("users:read,users:read.email")).result).toEqual({ ok: false, reason: "granted_scopes_insufficient" });
    expect((await run("users:read,users:read.email,usergroups:read,chat:write")).result).toEqual({ ok: false, reason: "granted_scopes_unexpected" });
  });
});

describe("granted-scope gate — REFUSES a malformed or absent scope", () => {
  const malformed: [string, unknown][] = [
    ["absent", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["commas only", ",,,"],
    ["a number", 3],
    ["an array", ["users:read", "users:read.email", "usergroups:read"]],
    ["an object", { users: true }],
    ["a boolean", true],
  ];
  for (const [name, scope] of malformed) {
    it(`scope ${name} → granted_scopes_malformed, nothing stored`, async () => {
      const r = await run(scope);
      refused(r, "granted_scopes_malformed");
      storedNothing(r);
    });
  }

  it("an ARRAY of the correct scopes is refused, not coerced — the contract is Slack's comma-separated string", async () => {
    const r = await run(["users:read", "users:read.email", "usergroups:read"]);
    refused(r, "granted_scopes_malformed");
    storedNothing(r);
  });
});

describe("granted-scope gate — ordering against the other pre-store checks", () => {
  it("a wrong WORKSPACE still refuses as workspace_mismatch even when scopes are perfect", async () => {
    const { store, captured } = captureStore();
    const result = await exchangeSlackOAuthCode(input(), {
      clientId: "11111.22222", clientSecret: okSecret(), store,
      httpClient: httpReturning(body("users:read,users:read.email,usergroups:read", { team: { id: "TOTHERWORKSPACE" } })),
    });
    expect(result).toEqual({ ok: false, reason: "workspace_mismatch" });
    expect(captured).toHaveLength(0);
  });

  // THE BYPASS THIS FILE DID NOT COVER. `expectedTeamId` is optional — the synthetic path has no workspace to check —
  // so the gate sits next to a block that IS conditional on it. Folding the scope check into that conditional makes it
  // skippable by per-deployment configuration, and every other test here sets `expectedTeamId`, so the whole suite
  // stayed green under exactly that mutation. An adversarial review demonstrated it. These two assert the gate is
  // unconditional, which is the property the module comment claims.
  it("refuses a short grant with expectedTeamId UNSET — the gate is not nested in the workspace check", async () => {
    const { store, captured } = captureStore();
    const result = await exchangeSlackOAuthCode(input({ expectedTeamId: undefined }), {
      clientId: "11111.22222", clientSecret: okSecret(), store,
      httpClient: httpReturning(body("users:read,usergroups:read")),
    });
    expect(result).toEqual({ ok: false, reason: "granted_scopes_insufficient" });
    expect(captured).toHaveLength(0);
  });

  it("refuses extra scopes with expectedTeamId UNSET", async () => {
    const { store, captured } = captureStore();
    const result = await exchangeSlackOAuthCode(input({ expectedTeamId: undefined }), {
      clientId: "11111.22222", clientSecret: okSecret(), store,
      httpClient: httpReturning(body("users:read,users:read.email,usergroups:read,chat:write")),
    });
    expect(result).toEqual({ ok: false, reason: "granted_scopes_unexpected" });
    expect(captured).toHaveLength(0);
  });

  it("still SUCCEEDS with expectedTeamId unset when the grant is exactly right", async () => {
    const { store, captured } = captureStore();
    const result = await exchangeSlackOAuthCode(input({ expectedTeamId: undefined }), {
      clientId: "11111.22222", clientSecret: okSecret(), store,
      httpClient: httpReturning(body("users:read,users:read.email,usergroups:read")),
    });
    expect(result).toEqual({ ok: true, ref: { secretId: "sec-1" } });
    expect(captured).toHaveLength(1);
  });
});

describe("granted-scope gate — separator and shape tolerance", () => {
  // RFC 6749 §5.1 is space-delimited; Slack's comma form is the deviation. A space-separated grant must not be refused.
  it("accepts the RFC space-delimited form as well as Slack's commas", async () => {
    for (const s of [
      "users:read users:read.email usergroups:read",
      "users:read,users:read.email usergroups:read",
      "users:read\tusers:read.email\nusergroups:read",
    ]) {
      expect((await run(s)).result, `separator form: ${JSON.stringify(s)}`).toEqual({ ok: true, ref: { secretId: "sec-1" } });
    }
  });

  it("a space-separated SHORT grant is still refused (the looser split does not weaken the check)", async () => {
    const r = await run("users:read usergroups:read");
    refused(r, "granted_scopes_insufficient");
    storedNothing(r);
  });

  it("a space-separated grant with an extra is still refused", async () => {
    const r = await run("users:read users:read.email usergroups:read chat:write");
    refused(r, "granted_scopes_unexpected");
    storedNothing(r);
  });
});

describe("granted-scope gate — the response fields it newly reads never reach a log or a reason", () => {
  // The module header claims the raw body is never logged. This PR made the gate read TWO more fields, and the existing
  // sentinels covered neither — a review proved `console.warn(b.scope, b.team.name)` passed the entire suite. These
  // sentinels are marker-carrying values planted in exactly those fields.
  const SCOPE_MARKER = "MUSTNOTLEAK-scope-marker:read";
  const TEAM_NAME_MARKER = "MUSTNOTLEAK-workspace-display-name";

  it("neither the granted scope string nor the workspace NAME appears in a result, error or log", async () => {
    for (const scope of [
      `users:read,users:read.email,usergroups:read,${SCOPE_MARKER}`, // over-scoped
      `users:read,${SCOPE_MARKER}`,                                  // short
      `${SCOPE_MARKER}`,                                             // malformed-ish: present but wrong
    ]) {
      const r = await run(scope, { team: { id: TEAM, name: TEAM_NAME_MARKER } });
      expect(r.dump).not.toContain(SCOPE_MARKER);
      expect(r.dump).not.toContain(TEAM_NAME_MARKER);
      expect(r.captured).toHaveLength(0);
    }
  });

  it("a SUCCESSFUL exchange also logs neither field", async () => {
    const r = await run("users:read,users:read.email,usergroups:read", { team: { id: TEAM, name: TEAM_NAME_MARKER } });
    expect(r.result).toEqual({ ok: true, ref: { secretId: "sec-1" } });
    expect(r.dump).not.toContain(TEAM_NAME_MARKER);
  });
});
