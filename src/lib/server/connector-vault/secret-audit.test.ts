import { describe, it, expect } from "vitest";
import {
  buildConnectorSecretAuditEvent,
  CONNECTOR_SECRET_AUDIT_EVENTS,
  type ConnectorSecretAuditInput,
} from "./secret-audit";

// LOAD-BEARING redaction tests for the connector-secret lifecycle audit builder. The builder is allowlist-based:
// it reads ONLY the permitted fields and carries no metadata passthrough, so a hostile object's extra fields are
// structurally dropped, and a credential-shaped value in an allowed field fails closed.

const TENANT = "00000000-0000-0000-0000-0000000d8a70";
const CONNECTOR = "00000000-0000-0000-0000-0000000d8a71";

function base(event: ConnectorSecretAuditInput["event"]): ConnectorSecretAuditInput {
  return { event, tenantId: TENANT, connectorId: CONNECTOR, secretKind: "api_key", version: 1 };
}

// Every prohibited field carries this sentinel so we can assert by absence anywhere in the output.
const LEAK = "MUSTNOTLEAK";

// An intentionally hostile input: all required-valid fields PLUS every hard-prohibited field. Typed as the input
// then widened, exactly how a careless future caller might pass a fat object.
const HOSTILE = {
  event: "connector_secret.store.succeeded",
  tenantId: TENANT,
  connectorId: CONNECTOR,
  secretKind: "api_key",
  version: 1,
  // ── hard-prohibited fields (must all be dropped) ─────────────────────────────────────────────
  plaintext: `plaintext-${LEAK}`,
  providerToken: `provider-${LEAK}`,
  provider_token: `provider2-${LEAK}`,
  accessToken: `gho_${LEAK}AAAAAAAAAAAA`,
  access_token: `gho_${LEAK}BBBBBBBBBBBB`,
  refreshToken: `refresh-${LEAK}`,
  refresh_token: `refresh2-${LEAK}`,
  clientSecret: `client-${LEAK}`,
  client_secret: `client2-${LEAK}`,
  ciphertext: `ciphertext-${LEAK}`,
  dek: `dek-${LEAK}`,
  DEK: `DEK-${LEAK}`,
  wrappedDek: `wrapped-${LEAK}`,
  wrapped_dek: `wrapped2-${LEAK}`,
  keyMaterial: `keymat-${LEAK}`,
  key_material: `keymat2-${LEAK}`,
  aeadTag: `tag-${LEAK}`,
  aead_tag: `tag2-${LEAK}`,
  nonce: `nonce-${LEAK}`,
  iv: `iv-${LEAK}`,
  aadDigest: `aad-${LEAK}`,
  aad_digest: `aad2-${LEAK}`,
  kmsResponse: `kms-${LEAK}`,
  kms_response: `kms2-${LEAK}`,
  dbUrl: `postgres://u:${LEAK}@h/db`,
  db_url: `postgres://u:${LEAK}2@h/db`,
  env: { SECRET: `env-${LEAK}` },
  rawError: { message: `boom ${LEAK}`, token: `ghp_${LEAK}CCCCCCCCCCCC` },
  metadata: { anything: `meta-${LEAK}`, nested: { deep: LEAK } },
} as unknown as ConnectorSecretAuditInput;

const ALLOWED_AFTER_KEYS = ["event", "connector_id", "secret_kind", "version", "result", "actor_type", "error_class", "correlation_id"];

describe("buildConnectorSecretAuditEvent — allowlist redaction (load-bearing)", () => {
  it("drops EVERY hard-prohibited field; no prohibited name or value survives anywhere in the output", () => {
    const record = buildConnectorSecretAuditEvent(HOSTILE);
    const serialized = JSON.stringify(record);
    // No sentinel value anywhere.
    expect(serialized).not.toContain(LEAK);
    // No prohibited field NAME survives into after_json (unknown keys dropped, not redacted in place).
    for (const bad of [
      "plaintext", "providerToken", "provider_token", "accessToken", "access_token",
      "refreshToken", "refresh_token", "clientSecret", "client_secret", "ciphertext",
      "dek", "DEK", "wrappedDek", "wrapped_dek", "keyMaterial", "key_material",
      "aeadTag", "aead_tag", "nonce", "iv", "aadDigest", "aad_digest",
      "kmsResponse", "kms_response", "dbUrl", "db_url", "env", "rawError", "metadata",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(record.afterJson, bad)).toBe(false);
      expect(serialized).not.toContain(bad);
    }
  });

  it("emits ONLY allowlisted after_json fields — unknown fields are absent, not redacted-in-place", () => {
    const record = buildConnectorSecretAuditEvent(HOSTILE);
    for (const k of Object.keys(record.afterJson)) expect(ALLOWED_AFTER_KEYS).toContain(k);
    // a clean store.succeeded carries exactly these (no actor/error/correlation supplied):
    expect(Object.keys(record.afterJson).sort()).toEqual(["connector_id", "event", "result", "secret_kind", "version"]);
    // no "[REDACTED]"/placeholder smell — unknown fields are dropped entirely, not kept with a masked value.
    expect(JSON.stringify(record)).not.toMatch(/redacted|\*{3,}|<hidden>/i);
    // top-level shape maps 1:1 to audit_logs.
    expect(Object.keys(record).sort()).toEqual(["action", "afterJson", "resourceType", "tenantId"]);
    expect(record.resourceType).toBe("connector_secret");
    expect(record.action).toBe("connector_secret.store.succeeded");
    expect(record.tenantId).toBe(TENANT);
  });

  it("rejects a credential-shaped value smuggled through an ALLOWED field (correlationId), failing closed", () => {
    let threw = false;
    try {
      buildConnectorSecretAuditEvent({ ...base("connector_secret.load.failed"), correlationId: `ghp_${LEAK}DDDDDDDDDDDD` });
    } catch (e) {
      threw = true;
      // the error message itself must not echo the credential value.
      expect(String((e as Error).message)).not.toContain(LEAK);
    }
    expect(threw).toBe(true);
  });

  it("rejects secret-shaped values smuggled through the id / kind fields", () => {
    expect(() => buildConnectorSecretAuditEvent({ ...base("connector_secret.store.succeeded"), tenantId: `ghp_${LEAK}` as string })).toThrow();
    expect(() => buildConnectorSecretAuditEvent({ ...base("connector_secret.store.succeeded"), connectorId: "not-a-uuid" })).toThrow();
    expect(() => buildConnectorSecretAuditEvent({ ...base("connector_secret.store.succeeded"), secretKind: `eyJ${LEAK}` })).toThrow();
  });
});

describe("buildConnectorSecretAuditEvent — error class is a safe static label only", () => {
  it("records only an allowlisted error class on a .failed event; unknown class collapses to unknown_error", () => {
    const ok = buildConnectorSecretAuditEvent({ ...base("connector_secret.store.failed"), errorClass: "not_found" });
    expect(ok.afterJson.error_class).toBe("not_found");
    expect(ok.afterJson.result).toBe("failed");
    // an arbitrary/raw class is NOT echoed — it collapses to the safe default.
    const coerced = buildConnectorSecretAuditEvent({ ...base("connector_secret.load.failed"), errorClass: `boom ${LEAK}` as never });
    expect(coerced.afterJson.error_class).toBe("unknown_error");
    expect(JSON.stringify(coerced)).not.toContain(LEAK);
  });

  it("drops error_class entirely on non-failed events", () => {
    const r = buildConnectorSecretAuditEvent({ ...base("connector_secret.store.succeeded"), errorClass: "not_found" as never });
    expect(Object.prototype.hasOwnProperty.call(r.afterJson, "error_class")).toBe(false);
  });
});

describe("buildConnectorSecretAuditEvent — event allowlist (store/load/decrypt + revocation/tombstone)", () => {
  it("accepts exactly the fifteen supported events (store/load/decrypt + revocation/tombstone)", () => {
    expect(CONNECTOR_SECRET_AUDIT_EVENTS).toHaveLength(15);
    for (const event of CONNECTOR_SECRET_AUDIT_EVENTS) {
      const r = buildConnectorSecretAuditEvent(base(event));
      expect(r.action).toBe(event);
      expect(["attempted", "succeeded", "failed"]).toContain(r.afterJson.result);
    }
  });

  it("accepts the #170 revocation + tombstone events (the write helpers emit them)", () => {
    for (const event of [
      "connector_secret.revocation.attempted", "connector_secret.revocation.succeeded", "connector_secret.revocation.failed",
      "connector_secret.tombstone.attempted", "connector_secret.tombstone.succeeded", "connector_secret.tombstone.failed",
    ] as const) {
      expect(buildConnectorSecretAuditEvent(base(event)).action).toBe(event);
    }
  });

  it("STILL rejects rotation/delete/update events (no such behavior implemented)", () => {
    for (const bad of [
      "connector_secret.rotation.attempted",
      "connector_secret.rotation.succeeded",
      "connector_secret.rotation.failed",
      "connector_secret.delete.succeeded",
      "connector_secret.update.succeeded",
      "connector_secret.store.rotated",
      "connector.credential.revoked",
      "anything.else",
    ]) {
      expect(() => buildConnectorSecretAuditEvent({ ...base("connector_secret.store.succeeded"), event: bad as never })).toThrow();
    }
  });

  it("carries optional actor_type / correlation_id only when valid", () => {
    const r = buildConnectorSecretAuditEvent({ ...base("connector_secret.decrypt.succeeded"), actorType: "connector_runner", correlationId: "run-12ab_CD-34" });
    expect(r.afterJson.actor_type).toBe("connector_runner");
    expect(r.afterJson.correlation_id).toBe("run-12ab_CD-34");
    // a bare uuid correlation id is also accepted.
    expect(buildConnectorSecretAuditEvent({ ...base("connector_secret.load.attempted"), correlationId: CONNECTOR }).afterJson.correlation_id).toBe(CONNECTOR);
    // an unknown actor type fails closed (only connector_runner is allowed; the web/request runtime is not).
    expect(() => buildConnectorSecretAuditEvent({ ...base("connector_secret.decrypt.succeeded"), actorType: "web_request" as never })).toThrow();
  });

  it("rejects a high-entropy opaque blob (key material / DEK shaped) smuggled through correlationId", () => {
    // 64-char hex (AES-256-key shaped) and a base64-ish DEK are NOT id-shaped → rejected, not echoed.
    for (const blob of ["a".repeat(64), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "MFRg8c3kZ0lq9TzaB7xWpYvN2hLmJ4dKsQ", "x".repeat(40)]) {
      let threw = false;
      try {
        buildConnectorSecretAuditEvent({ ...base("connector_secret.store.succeeded"), correlationId: blob });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
  });
});

// Static source guard: the audit builder is pure + server-only, opens no DB/provider/route, holds no secret.
describe("secret-audit.ts source is pure server-only + scoped", () => {
  it("imports only the server-only run-lifecycle guard; no DB/supabase/service-role/route/fetch/process.env", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./secret-audit.ts", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["./run-lifecycle"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of [
      "createClient", "@supabase", "@aws-sdk", "pg.Client", "new Client(", "fetch(", "process.env",
      ["service", "role", "key"].join("_"), "NextRequest", "NextResponse", "export async function GET", "export async function POST",
      "rotation", // no rotation event/behavior exists (revocation/tombstone are now legitimately present from #170)
    ]) {
      expect(code).not.toContain(bad);
    }
    // the runtime server-only sentinel is present.
    expect(src).toMatch(/server-only/);
    expect(src).toMatch(/globalThis[^\n]*window/);
  });
});
