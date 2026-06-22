import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  persistSlackAuthorizePending,
  type SlackPendingInserter,
  type OAuthPendingInsertRow,
  type SlackAuthorizePersistInput,
} from "./slack-authorize-pending";
import { createHmacStateSigner } from "../oauth-state";
import { getConnectorProvider } from "../provider-registry";

const SIGNER = createHmacStateSigner("test-only-state-secret-not-a-real-secret", "k1");
const NOW = 1_750_000_000_000;
const TENANT = "aaaa1111-1111-1111-1111-111111111111";
const ORG = "bbbb2222-2222-2222-2222-222222222222";
const SUBJECT = "cccc3333-3333-3333-3333-333333333333";
const REDIRECT = "https://app.example.com/connectors/oauth/callback";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// In-memory mock inserter — GENUINELY enforces the oauth_pending UNIQUE(state_jti)/UNIQUE(nonce_hash)
// constraints (duplicate → fail closed). No real DB, no network, no credentials. Records inserted rows.
function makeInserter(opts: { failDb?: boolean } = {}): SlackPendingInserter & { rows: OAuthPendingInsertRow[] } {
  const rows: OAuthPendingInsertRow[] = [];
  const jtis = new Set<string>();
  const nonces = new Set<string>();
  return {
    rows,
    async insertPending(row) {
      if (opts.failDb) return { ok: false, reason: "db_error" };
      if (jtis.has(row.stateJti) || nonces.has(row.nonceHash)) return { ok: false, reason: "duplicate" };
      jtis.add(row.stateJti);
      nonces.add(row.nonceHash);
      rows.push(row);
      return { ok: true };
    },
  };
}

function input(over: Partial<SlackAuthorizePersistInput> = {}): SlackAuthorizePersistInput {
  return { tenantId: TENANT, organizationId: ORG, subject: SUBJECT, clientId: "11111.22222", redirectUri: REDIRECT, signer: SIGNER, now: NOW, nonce: "nonce-A", ...over };
}

describe("persistSlackAuthorizePending — authorize-time oauth_pending persist", () => {
  it("persists exactly one oauth_pending row and returns the Slack authorize URL + safe metadata", async () => {
    const ins = makeInserter();
    const res = await persistSlackAuthorizePending(input(), ins);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // returned URL is Slack-specific + carries the signed state; safe metadata only
    expect(new URL(res.url).origin).toBe("https://slack.com");
    expect(new URL(res.url).pathname).toBe("/oauth/v2/authorize");
    expect(res.stateJti).toBe(sha256(new URL(res.url).searchParams.get("state")!));
    expect(res.expiresAt).toBe(NOW + 600_000);
    // exactly one row persisted, provider slack, hashes not raw values
    expect(ins.rows).toHaveLength(1);
    const row = ins.rows[0];
    expect(row.provider).toBe("slack");
    expect(row.tenantId).toBe(TENANT);
    expect(row.organizationId).toBe(ORG);
    expect(row.subject).toBe(SUBJECT);
    expect(row.connectorId).toBeNull();
    expect(row.intent).toBe("connect");
    expect(row.stateJti).toBe(res.stateJti);
    expect(row.nonceHash).toBe(sha256("nonce-A")); // stores the HASH
    expect(new Date(row.expiresAt).getTime()).toBe(NOW + 600_000);
  });

  it("stores state_jti and nonce_hash — never the raw state or raw nonce", async () => {
    const ins = makeInserter();
    const res = await persistSlackAuthorizePending(input({ nonce: "super-secret-nonce-RAW" }), ins);
    expect(res.ok).toBe(true);
    const row = ins.rows[0];
    const flat = JSON.stringify(row);
    expect(flat).not.toContain("super-secret-nonce-RAW"); // raw nonce never stored
    const state = res.ok ? new URL(res.url).searchParams.get("state")! : "";
    expect(flat).not.toContain(state); // raw signed state string is never a stored column (only its sha256)
    expect(row.nonceHash).toBe(sha256("super-secret-nonce-RAW"));
    expect(row.stateJti).toBe(sha256(state));
    // the result object likewise carries no raw nonce
    expect(JSON.stringify(res)).not.toContain("super-secret-nonce-RAW");
  });

  it("a fresh connect persists connector_id null; a re-auth persists the connector_id", async () => {
    const fresh = makeInserter();
    await persistSlackAuthorizePending(input({ connectorId: null }), fresh);
    expect(fresh.rows[0].connectorId).toBeNull();
    const reauth = makeInserter();
    await persistSlackAuthorizePending(input({ connectorId: "17000000-0000-0000-0000-0000000000a1" }), reauth);
    expect(reauth.rows[0].connectorId).toBe("17000000-0000-0000-0000-0000000000a1");
  });

  it("fails closed on a duplicate state_jti/nonce_hash (single-use insert)", async () => {
    const ins = makeInserter();
    const first = await persistSlackAuthorizePending(input({ nonce: "dup" }), ins);
    expect(first.ok).toBe(true);
    const second = await persistSlackAuthorizePending(input({ nonce: "dup" }), ins); // same nonce → same hashes
    expect(second).toEqual({ ok: false, reason: "duplicate_pending" });
    expect(ins.rows).toHaveLength(1); // the duplicate did not persist
  });

  it("fails closed on a DB error (no partial row)", async () => {
    const ins = makeInserter({ failDb: true });
    const res = await persistSlackAuthorizePending(input(), ins);
    expect(res).toEqual({ ok: false, reason: "persist_failed" });
    expect(ins.rows).toHaveLength(0);
  });

  it("fails closed on a missing inserter", async () => {
    // @ts-expect-error — null inserter
    expect(await persistSlackAuthorizePending(input(), null)).toEqual({ ok: false, reason: "missing_inserter" });
  });

  it("fails closed on a missing tenant (and never reaches the insert)", async () => {
    const ins = makeInserter();
    expect(await persistSlackAuthorizePending(input({ tenantId: "" }), ins)).toEqual({ ok: false, reason: "missing_tenant" });
    expect(ins.rows).toHaveLength(0);
  });

  it("fails closed on missing client_id / redirect_uri / signer (builder reasons)", async () => {
    const ins = makeInserter();
    expect((await persistSlackAuthorizePending(input({ clientId: "" }), ins))).toEqual({ ok: false, reason: "missing_client_id" });
    expect((await persistSlackAuthorizePending(input({ redirectUri: "" }), ins))).toEqual({ ok: false, reason: "missing_redirect_uri" });
    expect((await persistSlackAuthorizePending(input({ signer: undefined }), ins))).toEqual({ ok: false, reason: "missing_signer" });
    expect(ins.rows).toHaveLength(0);
  });

  it("fails closed on an unsafe / non-https redirect_uri (never reaches the insert)", async () => {
    const ins = makeInserter();
    for (const bad of ["javascript:alert(1)", "http://evil.example.com/cb", "not-a-url", "//evil.com"]) {
      expect(await persistSlackAuthorizePending(input({ redirectUri: bad }), ins)).toEqual({ ok: false, reason: "invalid_redirect_uri" });
    }
    expect(ins.rows).toHaveLength(0);
  });

  it("the provider registry still marks Slack non-functional (this persist step does not flip it)", () => {
    const slack = getConnectorProvider("slack");
    expect(slack?.status).toBe("skeleton");
    expect(slack?.enabled).toBe(false);
  });
});

// Static guards: server-only, no token exchange / Slack API / connector_secrets / KMS / token storage / DB
// client, no client/browser import.
describe("slack-authorize-pending module is server-only + scoped (no exchange/api/secrets/kms/db-client)", () => {
  it("imports only its server-only siblings; no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "slack-authorize-pending.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./slack-oauth", "../oauth-state", "../provider-registry"].sort());
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/); // no Slack API call / no token exchange
    expect(code).not.toMatch(/createClient\s*\(/); // no global service-role / supabase client created here
    expect(code).not.toMatch(/process\.env/);
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const serviceRole = ["service", "role"].join("_");
    expect(code).not.toContain(serviceRole);
    for (const tok of ["oauth.v2.access", "access_token", "refresh_token", "client_secret", "grant_type", "GenerateDataKey", "Decrypt", "@supabase"]) {
      expect(code).not.toContain(tok);
    }
  });

  it("the OAuth callback route is still inert — no token exchange", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const route = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "..", "app", "(authenticated)", "connectors", "oauth", "callback", "route.ts"),
      "utf8",
    );
    const code = route.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    for (const bad of [["connector", "secrets"].join("_"), "access_token", "refresh_token", "oauth.v2.access", "grant_type"]) {
      expect(code).not.toContain(bad);
    }
  });
});
