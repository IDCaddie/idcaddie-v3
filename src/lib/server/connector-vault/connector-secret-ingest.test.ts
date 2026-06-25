import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  ingestStagingConnectorSecret,
  isStagingIngestEnvironment,
  ProductionIngestionBlockedError,
  ConnectorSecretIngestError,
  ALLOWED_INGEST_PROVIDER,
  ALLOWED_INGEST_CREDENTIAL_KIND,
} from "./connector-secret-ingest";
import type { EncryptOnlyKeyProvider } from "./secret-vault";
import { createRunnerConnectorSecretStore } from "./connector-secret-store";
import type { ConnectorVaultKeyProvider } from "./crypto";
import type { RunnerConnection } from "./runner-db-client";

// A SYNTHETIC sentinel — recognizable + obviously not a real token. NEVER a real `xoxb-` token (forbidden in tests).
const SENTINEL = "SENTINEL-staging-ingest-not-a-real-token-00000000";
const TENANT = "11111111-1111-1111-1111-111111111111";
const CONNECTOR = "22222222-2222-2222-2222-222222222222";

const validInput = (over: Record<string, unknown> = {}) => ({
  provider: ALLOWED_INGEST_PROVIDER,
  credentialKind: ALLOWED_INGEST_CREDENTIAL_KIND,
  tenantId: TENANT,
  connectorId: CONNECTOR,
  version: 1,
  correlationId: "run-staging-ingest-01",
  plaintext: SENTINEL,
  ...over,
});

function memKeyProvider(opts: { failGenerate?: boolean } = {}): ConnectorVaultKeyProvider {
  return {
    async generateDataKey(kekId) {
      if (opts.failGenerate) throw new Error("forced kms failure");
      const dek = randomBytes(32);
      return { dek, wrappedDek: Buffer.concat([Buffer.from(`${kekId}|`), dek]) };
    },
    async unwrapDataKey() { throw new Error("decrypt not allowed in ingestion"); },
  };
}
const encryptOnly = (kp: ConnectorVaultKeyProvider): EncryptOnlyKeyProvider => ({ generateDataKey: kp.generateDataKey });

// A capturing runner connection: models the atomic store tx (begin/commit), returns the INSERT row id, records the
// committed secret-row INSERT params + audit rows, and can force the in-tx store.succeeded audit to fail.
function captureConn(opts: { failSucceededAudit?: boolean } = {}) {
  const allStatements: { sql: string; params: readonly unknown[] }[] = [];
  const committedSecretRows: (readonly unknown[])[] = [];
  const committedAudits: { action: string; after_json: Record<string, unknown> }[] = [];
  const conn: RunnerConnection = {
    async runSequence(stmts) {
      const inTx = stmts.some((s) => /^\s*begin\s*$/i.test(s.sql));
      const pendingSecrets: (readonly unknown[])[] = [];
      const pendingAudits: { action: string; after_json: Record<string, unknown> }[] = [];
      const results: { rows: ReadonlyArray<Record<string, unknown>> }[] = [];
      let committed = false;
      let seq = committedSecretRows.length;
      for (const s of stmts) {
        allStatements.push({ sql: s.sql, params: s.params });
        if (/^\s*(set\s+role|begin)/i.test(s.sql)) { results.push({ rows: [] }); continue; }
        if (/^\s*commit/i.test(s.sql)) { committed = true; results.push({ rows: [] }); continue; }
        if (/insert\s+into\s+public\.connector_secrets/i.test(s.sql)) {
          pendingSecrets.push(s.params);
          results.push({ rows: [{ id: `sec-${++seq}` }] });
          continue;
        }
        if (/insert\s+into\s+public\.audit_logs/i.test(s.sql)) {
          const action = String(s.params[1]);
          if (opts.failSucceededAudit && action === "connector_secret.store.succeeded") throw new Error("forced audit failure");
          pendingAudits.push({ action, after_json: JSON.parse(String(s.params[3])) });
          results.push({ rows: [] });
          continue;
        }
        results.push({ rows: [] });
      }
      if (!inTx || committed) { committedSecretRows.push(...pendingSecrets); committedAudits.push(...pendingAudits); }
      return results;
    },
  };
  return { conn, allStatements, committedSecretRows, committedAudits };
}

const KEK = "kek-staging-1";
// serialize everything the path touched (params with Buffers→hex) so we can prove the sentinel never appears.
const dump = (c: ReturnType<typeof captureConn>, ref?: unknown) =>
  JSON.stringify({ statements: c.allStatements, audits: c.committedAudits, ref }, (_k, v) =>
    v && typeof v === "object" && v.type === "Buffer" ? Buffer.from(v.data).toString("hex") : v);

beforeEach(() => { vi.stubEnv("CONNECTOR_VAULT_STAGING_INGEST_ENABLED", "1"); vi.stubEnv("VERCEL_ENV", "preview"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("connector-secret-ingest — allowed staging ingestion (synthetic) stores envelope only, no leak", () => {
  it("stores the encrypted envelope, emits attempted+succeeded audit, returns a redacted ref — sentinel appears NOWHERE", async () => {
    const c = captureConn();
    const ref = await ingestStagingConnectorSecret(validInput(), { keyProvider: encryptOnly(memKeyProvider()), kekId: KEK, store: createRunnerConnectorSecretStore(c.conn) });
    // redacted ref — ids + KEK handle only, no plaintext/ciphertext.
    expect(ref).toEqual({ secretId: expect.any(String), tenantId: TENANT, connectorId: CONNECTOR, secretKind: "oauth_access_token", version: 1, kekId: KEK });
    expect(JSON.stringify(ref)).not.toContain(SENTINEL);
    // a secret row committed (envelope columns), and the sentinel is in NONE of the INSERT params.
    expect(c.committedSecretRows).toHaveLength(1);
    // audit: attempted + succeeded, carrying the correlation_id, no token material.
    expect(c.committedAudits.map((a) => a.action)).toEqual(["connector_secret.store.attempted", "connector_secret.store.succeeded"]);
    expect(c.committedAudits[1].after_json.correlation_id).toBe("run-staging-ingest-01");
    // the WHOLE path (every statement param incl. ciphertext-as-hex, every audit, the ref) contains no sentinel.
    expect(dump(c, ref)).not.toContain(SENTINEL);
    for (const a of c.committedAudits) for (const k of Object.keys(a.after_json)) expect(["event", "connector_id", "secret_kind", "version", "result", "actor_type", "error_class", "correlation_id"]).toContain(k);
  });

  it("the encrypted ciphertext is not the plaintext (envelope only in the secret row)", async () => {
    const c = captureConn();
    await ingestStagingConnectorSecret(validInput(), { keyProvider: encryptOnly(memKeyProvider()), kekId: KEK, store: createRunnerConnectorSecretStore(c.conn) });
    const insertParams = c.committedSecretRows[0].map((p) => (Buffer.isBuffer(p) ? p.toString("hex") : String(p)));
    expect(insertParams.join(" ")).not.toContain(SENTINEL);
  });
});

describe("connector-secret-ingest — guards reject (nothing stored, no token leaked)", () => {
  const noStore = () => { const c = captureConn(); return { c, deps: { keyProvider: encryptOnly(memKeyProvider()), kekId: KEK, store: createRunnerConnectorSecretStore(c.conn) } }; };

  it("forbidden provider rejected", async () => {
    const { c, deps } = noStore();
    await expect(ingestStagingConnectorSecret(validInput({ provider: "okta" }), deps)).rejects.toBeInstanceOf(ConnectorSecretIngestError);
    expect(c.committedSecretRows).toHaveLength(0); expect(c.committedAudits).toHaveLength(0);
  });
  it("forbidden credential kind rejected", async () => {
    const { c, deps } = noStore();
    await expect(ingestStagingConnectorSecret(validInput({ credentialKind: "api_key" }), deps)).rejects.toBeInstanceOf(ConnectorSecretIngestError);
    expect(c.committedSecretRows).toHaveLength(0);
  });
  it("missing/invalid tenant, connector, version rejected", async () => {
    const { deps } = noStore();
    for (const bad of [{ tenantId: "not-a-uuid" }, { connectorId: "nope" }, { version: 0 }, { version: 1.5 }]) {
      await expect(ingestStagingConnectorSecret(validInput(bad), deps)).rejects.toBeInstanceOf(ConnectorSecretIngestError);
    }
  });
  it("invalid correlation_id rejected (grammar-safe guard)", async () => {
    const { c, deps } = noStore();
    // a high-entropy opaque blob (key-shaped) must be rejected, not silently stored.
    await expect(ingestStagingConnectorSecret(validInput({ correlationId: "ABCDEF0123456789abcdef0123456789" }), deps)).rejects.toBeInstanceOf(ConnectorSecretIngestError);
    expect(c.committedSecretRows).toHaveLength(0);
  });
  it("a thrown guard error carries no plaintext", async () => {
    const { deps } = noStore();
    try { await ingestStagingConnectorSecret(validInput({ provider: "okta" }), deps); throw new Error("should throw"); }
    catch (e) { expect(String((e as Error).message)).not.toContain(SENTINEL); }
  });
});

describe("connector-secret-ingest — PRODUCTION HARD-BLOCK (requirement 4)", () => {
  it("isStagingIngestEnvironment is fail-closed: requires the explicit opt-in AND non-production", () => {
    expect(isStagingIngestEnvironment({ NODE_ENV: "test", CONNECTOR_VAULT_STAGING_INGEST_ENABLED: "1" })).toBe(true);
    expect(isStagingIngestEnvironment({ NODE_ENV: "test" })).toBe(false); // opt-in unset → refused
    expect(isStagingIngestEnvironment({ VERCEL_ENV: "production", CONNECTOR_VAULT_STAGING_INGEST_ENABLED: "1" })).toBe(false); // production → refused even with opt-in
    expect(isStagingIngestEnvironment({ NODE_ENV: "production", CONNECTOR_VAULT_STAGING_INGEST_ENABLED: "1" })).toBe(false);
    expect(isStagingIngestEnvironment({})).toBe(false); // unknown → refused
  });

  it("a production-like environment REFUSES ingestion: throws, stores no row, returns/leaks no token", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const c = captureConn();
    const deps = { keyProvider: encryptOnly(memKeyProvider()), kekId: KEK, store: createRunnerConnectorSecretStore(c.conn) };
    let returned: unknown = "SENTINEL_NOT_RETURNED";
    await expect((async () => { returned = await ingestStagingConnectorSecret(validInput(), deps); })()).rejects.toBeInstanceOf(ProductionIngestionBlockedError);
    expect(returned).toBe("SENTINEL_NOT_RETURNED"); // caller got nothing
    expect(c.committedSecretRows).toHaveLength(0); // no secret row
    expect(c.committedAudits).toHaveLength(0); // not even an attempted audit (blocked before any store)
    expect(c.allStatements).toHaveLength(0); // the path never touched the DB
  });

  it("the opt-in unset (default) REFUSES even in a non-production env", async () => {
    vi.unstubAllEnvs(); vi.stubEnv("VERCEL_ENV", "preview"); // no CONNECTOR_VAULT_STAGING_INGEST_ENABLED
    const c = captureConn();
    await expect(ingestStagingConnectorSecret(validInput(), { keyProvider: encryptOnly(memKeyProvider()), kekId: KEK, store: createRunnerConnectorSecretStore(c.conn) })).rejects.toBeInstanceOf(ProductionIngestionBlockedError);
    expect(c.committedSecretRows).toHaveLength(0);
  });
});

describe("connector-secret-ingest — fail-closed on audit / encryption / store failure", () => {
  it("a forced store.succeeded audit failure leaves NO secret row (atomic rollback, no compensating delete)", async () => {
    const c = captureConn({ failSucceededAudit: true });
    await expect(ingestStagingConnectorSecret(validInput(), { keyProvider: encryptOnly(memKeyProvider()), kekId: KEK, store: createRunnerConnectorSecretStore(c.conn) })).rejects.toBeTruthy();
    expect(c.committedSecretRows).toHaveLength(0);
    // attempted + failed audit recorded; no succeeded; the sentinel never appears.
    expect(c.committedAudits.map((a) => a.action)).toContain("connector_secret.store.failed");
    expect(c.committedAudits.map((a) => a.action)).not.toContain("connector_secret.store.succeeded");
    expect(dump(c)).not.toContain(SENTINEL);
  });

  it("an encryption failure fails closed (no secret row, no token leaked)", async () => {
    const c = captureConn();
    await expect(ingestStagingConnectorSecret(validInput(), { keyProvider: encryptOnly(memKeyProvider({ failGenerate: true })), kekId: KEK, store: createRunnerConnectorSecretStore(c.conn) })).rejects.toBeTruthy();
    expect(c.committedSecretRows).toHaveLength(0);
    expect(dump(c)).not.toContain(SENTINEL);
  });

  it("the ingestion path never writes to the console", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = captureConn();
    await ingestStagingConnectorSecret(validInput(), { keyProvider: encryptOnly(memKeyProvider()), kekId: KEK, store: createRunnerConnectorSecretStore(c.conn) });
    expect(spy).not.toHaveBeenCalled(); expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("connector-secret-ingest — source is server-only + scope-fenced (no decrypt / no Slack API / no real token)", () => {
  it("imports only sibling vault modules; no fetch/decrypt/oauth/slack-api/route/real-token", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./connector-secret-ingest.ts", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./secret-audit", "./secret-vault"]);
    expect(src).toMatch(/server-only and must not be imported in client code/);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["fetch(", "oauth.v2.access", "decryptConnectorSecret", "loadConnectorSecret", "createClient", "@supabase", "NextRequest", "NextResponse", "xoxb-", "process.env.SLACK"]) {
      expect(code).not.toContain(bad);
    }
  });
});
