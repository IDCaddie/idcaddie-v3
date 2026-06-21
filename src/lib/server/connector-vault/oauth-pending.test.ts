import { describe, it, expect } from "vitest";
import {
  hashOAuthValue,
  buildOAuthPendingRecord,
  OAuthPendingError,
  type OAuthPendingInput,
} from "./oauth-pending";

const BASE: OAuthPendingInput = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  provider: "github",
  stateJti: "jti-abc123",
  nonce: "the-single-use-nonce-value",
  intent: "connect",
  expiresAt: "2026-06-21T00:10:00Z",
  connectorId: "17000000-0000-0000-0000-0000000000a1",
};

describe("hashOAuthValue", () => {
  it("is deterministic for the same input (sha256 hex)", () => {
    const a = hashOAuthValue("abc");
    const b = hashOAuthValue("abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("differs for different inputs and is not the raw value", () => {
    expect(hashOAuthValue("abc")).not.toBe(hashOAuthValue("abd"));
    expect(hashOAuthValue("the-single-use-nonce-value")).not.toContain("the-single-use-nonce-value");
  });

  it("rejects empty / non-string input", () => {
    expect(() => hashOAuthValue("")).toThrow(OAuthPendingError);
    // @ts-expect-error — non-string must be rejected at runtime
    expect(() => hashOAuthValue(123)).toThrow(OAuthPendingError);
  });
});

describe("buildOAuthPendingRecord", () => {
  it("builds the safe record: nonce is hashed, the RAW nonce is never present", () => {
    const rec = buildOAuthPendingRecord(BASE);
    expect(rec.nonceHash).toBe(hashOAuthValue(BASE.nonce));
    expect(rec.nonceHash).toMatch(/^[a-f0-9]{64}$/);
    // exact safe key set — there is NO `nonce` key on the record
    expect(Object.keys(rec).sort()).toEqual(
      ["connectorId", "expiresAt", "intent", "nonceHash", "organizationId", "provider", "stateJti", "subject", "tenantId"].sort(),
    );
    expect(rec).not.toHaveProperty("nonce");
    // the raw nonce never appears anywhere in the serialized record
    expect(JSON.stringify(rec)).not.toContain(BASE.nonce);
  });

  it("defaults optional fields to null", () => {
    const rec = buildOAuthPendingRecord({ ...BASE, connectorId: undefined, organizationId: undefined, subject: undefined });
    expect(rec.connectorId).toBeNull();
    expect(rec.organizationId).toBeNull();
    expect(rec.subject).toBeNull();
  });

  it("rejects missing required fields", () => {
    for (const field of ["tenantId", "provider", "stateJti", "nonce", "intent", "expiresAt"] as const) {
      expect(() => buildOAuthPendingRecord({ ...BASE, [field]: "" })).toThrow(OAuthPendingError);
    }
  });

  it("rejects an invalid expiresAt", () => {
    expect(() => buildOAuthPendingRecord({ ...BASE, expiresAt: "not-a-date" })).toThrow(OAuthPendingError);
  });

  it("rejects a secret-shaped extra field (no raw token/secret/code may be smuggled in)", () => {
    for (const bad of ["accessToken", "refresh_token", "api_key", "authorization", "client_secret", "code", "pkce_verifier", "raw_state"]) {
      // computed key → bypasses TS excess-property check; the runtime guard is what rejects it
      expect(() => buildOAuthPendingRecord({ ...BASE, [bad]: "x" } as OAuthPendingInput)).toThrow(OAuthPendingError);
    }
  });
});

// Static guards: the helper imports only node:crypto and does no DB / token-exchange / connector_secrets.
describe("oauth-pending module is pure (no DB / no token exchange / no connector_secrets / no service-role)", () => {
  it("oauth-pending.ts imports only node:crypto and has no DB/Supabase/service-role/token-exchange string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "oauth-pending.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["node:crypto"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    const secretsTable = ["connector", "secrets"].join("_");
    expect(code).not.toContain(secretsTable);
    const forbidden = ["service", "role"].join("_");
    expect(code).not.toContain(forbidden);
    for (const tok of ["access_token", "refresh_token", "token_endpoint", "grant_type"]) {
      expect(code).not.toContain(tok);
    }
  });
});
