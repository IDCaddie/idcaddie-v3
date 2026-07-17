import { describe, it, expect, vi } from "vitest";
import { resolveOktaClientConfig, oktaClientConfigPermitsConnection } from "./okta-client-config";
import { createInMemoryPkceVerifierStore } from "./okta-pkce-verifier-store";
import { createInMemoryOktaTransactionStore } from "./okta-transaction-store";
import { writeOktaCredential, type OktaSecretStoreWriter, type OktaCredentialReferenceWriter } from "./okta-credential-write";
import { persistOktaConnectedUnsynced, type OktaConnectionWriter } from "./okta-connection-persist";
import { executeOktaDisconnect, type OktaDisconnectSinks } from "./okta-disconnect-execute";
import type { OktaOAuthTransactionRecord } from "./okta-oauth-transaction";
import type { VaultBoundAccessTokenRef } from "./okta-token-exchange";

// P5E18b Phase 4/5/7/9/10/15 — the staging wiring boundaries: client config, transient PKCE store, transaction persistence,
// credential-write rollback, connection persistence, disconnect execution.

const CONFIG = {
  clientId: "0oaEXAMPLEexampleABCDE", credentialReference: "ref-pointer",
  redirectUri: "https://idcaddie-v3.vercel.app/connectors/oauth/okta/callback", issuerUrl: "https://acme.okta.com",
  orgHostname: "acme.okta.com", scopes: ["okta.users.read"], environment: "staging",
};

describe("okta client config (Phase 5)", () => {
  it("fails closed when the client id is absent (deferred until the operator provides it)", () => {
    const r = resolveOktaClientConfig({ ...CONFIG, clientId: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain("clientId");
  });
  it("resolves a complete config but does NOT permit connection while certificationOnly", () => {
    const r = resolveOktaClientConfig(CONFIG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.clientAuthMethod).toBe("private_key_jwt");
    expect(oktaClientConfigPermitsConnection(r)).toBe(false); // lifecycle certificationOnly
  });
  it("rejects non-staging environment and a broader scope", () => {
    expect(resolveOktaClientConfig({ ...CONFIG, environment: "production" }).ok).toBe(false);
    expect(resolveOktaClientConfig({ ...CONFIG, scopes: ["okta.users.read", "okta.groups.read"] }).ok).toBe(false);
  });
});

describe("transient PKCE verifier store (Phase 4)", () => {
  it("one-time consumption + expiry; never persisted twice", () => {
    const s = createInMemoryPkceVerifierStore();
    s.put("txn-1", "verifier-secret", { now: 1000, ttlMs: 60000 });
    expect(s.takeOnce("txn-1", 2000)).toBe("verifier-secret");
    expect(s.takeOnce("txn-1", 2000)).toBeNull(); // one-time
    s.put("txn-2", "v2", { now: 1000, ttlMs: 1000 });
    expect(s.takeOnce("txn-2", 5000)).toBeNull(); // expired
    s.put("txn-3", "v3", { now: 1000, ttlMs: 60000 });
    s.invalidate("txn-3");
    expect(s.takeOnce("txn-3", 2000)).toBeNull();
  });
});

const rec = (over: Partial<OktaOAuthTransactionRecord> = {}): OktaOAuthTransactionRecord => ({
  provider: "okta", correlationId: "corr-1", tenantId: "t", organizationId: "o", connectorId: null, subject: "s",
  requestedScopes: ["okta.users.read"], issuerUrl: "https://acme.okta.com", orgHostname: "acme.okta.com",
  redirectUri: CONFIG.redirectUri, returnRoute: "/connectors/okta/status", pkceChallenge: "c", pkceMethod: "S256",
  stateNonceHash: "a".repeat(64), createdAt: 1000, expiresAt: 61000, consumedAt: null, ...over,
});

describe("transaction persistence (Phase 4)", () => {
  it("single-use consume; replay + expiry + invalidation fail closed", async () => {
    const s = createInMemoryOktaTransactionStore();
    await s.create(rec());
    expect((await s.consumeOnce("corr-1", 2000))?.correlationId).toBe("corr-1");
    expect(await s.consumeOnce("corr-1", 2000)).toBeNull(); // replay
    await s.create(rec({ correlationId: "corr-2" }));
    expect(await s.consumeOnce("corr-2", 999999)).toBeNull(); // expired
    await s.create(rec({ correlationId: "corr-3" }));
    await s.invalidate("corr-3", 2000, "operator");
    expect(await s.consumeOnce("corr-3", 2000)).toBeNull(); // invalidated
    expect(await s.findActive("corr-3", 2000)).toBeNull();
  });
});

describe("credential-write boundary (Phase 7)", () => {
  const tokenRef = "vault-ref" as VaultBoundAccessTokenRef;
  const input = { organizationId: "o", connectionId: "c", issuerUrl: "https://acme.okta.com", tokenRef, grantedScopes: ["okta.users.read"], expiresInSeconds: 3600, correlationId: "corr", now: 1000, secretNamespace: "idcaddie/staging/connector/okta" };
  it("writes secret then reference; returns only the version (never the full ref)", async () => {
    const secretStore: OktaSecretStoreWriter = { putSecret: async () => ({ credentialSecretRef: "arn:...:okta/c", credentialVersion: "v1" }), markRevoked: async () => {} };
    const rows: unknown[] = [];
    const referenceWriter: OktaCredentialReferenceWriter = { putReference: async (row) => { rows.push(row); } };
    const r = await writeOktaCredential(input, { secretStore, referenceWriter });
    expect(r).toEqual({ ok: true, credentialVersion: "v1" });
    expect(JSON.stringify(r)).not.toContain("arn:"); // full ref never surfaced
  });
  it("rolls back the secret when the DB reference write fails", async () => {
    const markRevoked = vi.fn(async () => {});
    const secretStore: OktaSecretStoreWriter = { putSecret: async () => ({ credentialSecretRef: "arn:...:okta/c", credentialVersion: "v1" }), markRevoked };
    const referenceWriter: OktaCredentialReferenceWriter = { putReference: async () => { throw new Error("db down"); } };
    const r = await writeOktaCredential(input, { secretStore, referenceWriter });
    expect(r).toEqual({ ok: false, reason: "reference_write_failed_rolled_back" });
    expect(markRevoked).toHaveBeenCalledOnce();
  });
  it("rejects a non-exact scope", async () => {
    const r = await writeOktaCredential({ ...input, grantedScopes: ["okta.groups.read"] }, { secretStore: { putSecret: async () => ({ credentialSecretRef: "x", credentialVersion: "v" }), markRevoked: async () => {} }, referenceWriter: { putReference: async () => {} } });
    expect(r).toEqual({ ok: false, reason: "scope_not_exact" });
  });
});

describe("connection persistence (Phase 9)", () => {
  const input = { organizationId: "o", connectionId: "c", issuerBindingId: "b", credentialVersion: "v1", grantedScopes: ["okta.users.read"], correlationId: "corr", actorSubject: "u", tenantId: "t", orgHostname: "acme.okta.com", now: 1000 };
  it("persists a connected-unsynced record (sync 0, no schedule, no first-sync)", async () => {
    let saved: { record: { status: string; syncCount: number; lastSyncAt: unknown; schedulingEnabled: boolean; firstSyncAuthorizationPresent: boolean } } | null = null;
    const writer: OktaConnectionWriter = { commitConnectedUnsynced: async (i) => { saved = i as never; } };
    const r = await persistOktaConnectedUnsynced(input, { writer });
    expect(r).toEqual({ ok: true, connectionId: "c", status: "connected_unsynced" });
    expect(saved!.record.status).toBe("connected_unsynced");
    expect(saved!.record.syncCount).toBe(0);
    expect(saved!.record.lastSyncAt).toBeNull();
    expect(saved!.record.schedulingEnabled).toBe(false);
    expect(saved!.record.firstSyncAuthorizationPresent).toBe(false);
  });
  it("rolls back on a commit failure", async () => {
    const writer: OktaConnectionWriter = { commitConnectedUnsynced: async () => { throw new Error("boom"); } };
    expect(await persistOktaConnectedUnsynced(input, { writer })).toEqual({ ok: false, reason: "commit_failed_rolled_back" });
  });
});

describe("disconnect execution (Phase 10)", () => {
  const base = { authenticated: true, role: "admin", connectorId: "c", tenantId: "t", organizationId: "o", actorSubject: "u", correlationId: "corr", now: 1000 } as const;
  const sinks = () => {
    const calls = { disconnected: 0, schedule: 0, revoked: 0, invalidated: [] as string[] };
    const s: OktaDisconnectSinks = {
      markConnectionDisconnected: async () => { calls.disconnected++; },
      disableSchedule: async () => { calls.schedule++; },
      revocation: { markCredentialReferenceRevoked: async () => { calls.revoked++; } },
      transactionStore: { create: async () => {}, consumeOnce: async () => null, invalidate: async (cid) => { calls.invalidated.push(cid); }, findActive: async () => null },
    };
    return { s, calls };
  };
  it("requires an authenticated admin", async () => {
    expect(await executeOktaDisconnect({ ...base, currentState: "connectedUnsynced", role: "member" }, sinks().s)).toEqual({ ok: false, reason: "insufficient_role" });
  });
  it("applies all effects on a new disconnect; is a no-op (no re-revocation) when already disconnected", async () => {
    const a = sinks();
    const r1 = await executeOktaDisconnect({ ...base, currentState: "connectedUnsynced", pendingCorrelationIds: ["corr-x"] }, a.s);
    expect(r1).toEqual({ ok: true, noOp: false });
    expect(a.calls).toMatchObject({ disconnected: 1, schedule: 1, revoked: 1, invalidated: ["corr-x"] });
    const b = sinks();
    const r2 = await executeOktaDisconnect({ ...base, currentState: "disconnected" }, b.s);
    expect(r2).toEqual({ ok: true, noOp: true });
    expect(b.calls.revoked).toBe(0); // idempotent — no re-revocation
    expect(b.calls.disconnected).toBe(1); // invariants still asserted
  });
});
