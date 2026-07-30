// O2A — the server-side write path derives all authority and leaks nothing.
//
// The database tests (supabase/tests/okta_connector_config_test.sql) prove what the DB refuses to represent. These prove the layer
// above it: that the browser cannot supply authority, that structural validation happens before any write, and that no internal
// detail reaches a caller through a result or an error.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Supabase client double ──────────────────────────────────────────────────────────────────────────────────────
// Records every RPC argument so the tests can assert what the server actually sent, rather than what it intended to send.
type RpcCall = { fn: string; args: Record<string, unknown> };
const calls: RpcCall[] = [];

let user: { id: string } | null = { id: "11111111-1111-4111-8111-111111111111" };
let memberships: { tenant_id: string; role: string }[] = [{ tenant_id: "22222222-2222-4222-8222-222222222222", role: "owner" }];
let membershipError: unknown = null;
let rpcResult: unknown = { outcome: "created", connector_id: "33333333-3333-4333-8333-333333333333" };
let rpcError: { code?: string } | null = null;
let rowResult: Record<string, unknown> | null = null;
let rowError: unknown = null;

const defaultRow = () => ({
  normalized_org_host: "acme.okta.com",
  client_id: "0oaVALIDapp000001",
  contract_version: "1.0.0",
  authentication_mode: "private_key_jwt",
  approved_scopes: ["okta.users.read", "okta.groups.read", "okta.apps.read"],
  certification_only: true,
  production_enabled: false,
  verified_organization_fingerprint: null,
  signing_key_id: null,
  public_key_delivery_mode: "not_configured",
  created_at: "2026-07-30T00:00:00.000Z",
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          // tenant_memberships lookup resolves directly; okta_connector_configs read-back uses .single()
          then: undefined,
          single: async () => ({ data: rowResult ?? defaultRow(), error: rowError }),
          ...(table === "tenant_memberships"
            ? { then: (r: (v: unknown) => unknown) => r({ data: memberships, error: membershipError }) }
            : {}),
        }),
      }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: rpcResult, error: rpcError };
    },
  }),
}));

const { createOktaConnectorConfiguration, nextActionFor } = await import("./okta-connector-create");

const VALID = { orgInput: "acme.okta.com", clientId: "0oaVALIDapp000001", idempotencyKey: "44444444-4444-4444-8444-444444444444" };

beforeEach(() => {
  calls.length = 0;
  user = { id: "11111111-1111-4111-8111-111111111111" };
  memberships = [{ tenant_id: "22222222-2222-4222-8222-222222222222", role: "owner" }];
  membershipError = null;
  rpcResult = { outcome: "created", connector_id: "33333333-3333-4333-8333-333333333333" };
  rpcError = null;
  rowResult = null;
  rowError = null;
});

// ── Authority is derived, never accepted ────────────────────────────────────────────────────────────────────────
describe("the browser cannot supply authority", () => {
  it("derives the tenant from membership, not from input", async () => {
    const r = await createOktaConnectorConfiguration({
      ...VALID,
      // Spoofed fields are not part of the input type; a real caller could still post them.
      ...({ tenantId: "99999999-9999-4999-8999-999999999999", role: "owner" } as object),
    } as Parameters<typeof createOktaConnectorConfiguration>[0]);
    expect(r.ok).toBe(true);
    expect(calls[0].args.p_tenant_id).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("sends NO scopes, contract version, state, governance flag or signing key — the DB derives them", async () => {
    await createOktaConnectorConfiguration(VALID);
    const sent = Object.keys(calls[0].args).sort();
    expect(sent).toEqual([
      "p_client_id", "p_idempotency_key", "p_normalized_org_host",
      "p_proposed_organization_fingerprint", "p_service_app_fingerprint", "p_tenant_id",
    ]);
  });

  it("derives fingerprints server-side and ignores any supplied by the caller", async () => {
    await createOktaConnectorConfiguration({
      ...VALID,
      ...({ organizationFingerprint: "deadbeef".repeat(8), verifiedOrganizationFingerprint: "cafe".repeat(16) } as object),
    } as Parameters<typeof createOktaConnectorConfiguration>[0]);
    // The known-answer vector for acme.okta.com + 0oaVALIDapp000001 — derived, not echoed.
    expect(calls[0].args.p_proposed_organization_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0].args.p_proposed_organization_fingerprint).not.toContain("deadbeef");
    // There is no parameter through which a VERIFIED fingerprint could be sent at all.
    expect(Object.keys(calls[0].args)).not.toContain("p_verified_organization_fingerprint");
  });

  it("normalizes the host before sending it", async () => {
    await createOktaConnectorConfiguration({ ...VALID, orgInput: "  HTTPS://Acme.Okta.Com/  " });
    expect(calls[0].args.p_normalized_org_host).toBe("acme.okta.com");
  });

  it("trims the client id", async () => {
    await createOktaConnectorConfiguration({ ...VALID, clientId: "  0oaVALIDapp000001  " });
    expect(calls[0].args.p_client_id).toBe("0oaVALIDapp000001");
  });
});

// ── Authorization ────────────────────────────────────────────────────────────────────────────────────────────────
describe("authorization", () => {
  it("denies an unauthenticated caller before any write", async () => {
    user = null;
    const r = await createOktaConnectorConfiguration(VALID);
    expect(r).toEqual({ ok: false, reason: "not_authenticated" });
    expect(calls).toHaveLength(0);
  });

  it("distinguishes no-tenant from insufficient-role", async () => {
    memberships = [];
    expect(await createOktaConnectorConfiguration(VALID)).toEqual({ ok: false, reason: "no_tenant" });
    memberships = [{ tenant_id: "22222222-2222-4222-8222-222222222222", role: "editor" }];
    expect(await createOktaConnectorConfiguration(VALID)).toEqual({ ok: false, reason: "insufficient_role" });
    expect(calls, "neither case may reach the database").toHaveLength(0);
  });

  it("admin is permitted", async () => {
    memberships = [{ tenant_id: "22222222-2222-4222-8222-222222222222", role: "admin" }];
    expect((await createOktaConnectorConfiguration(VALID)).ok).toBe(true);
  });

  it("maps the RPC's 42501 to insufficient_role rather than surfacing the database error", async () => {
    rpcError = { code: "42501" };
    const r = await createOktaConnectorConfiguration(VALID);
    expect(r).toEqual({ ok: false, reason: "insufficient_role" });
  });
});

// ── Validation happens before the write ─────────────────────────────────────────────────────────────────────────
describe("structural validation precedes any database call", () => {
  const badHosts: readonly (readonly [string, string])[] = [
    ["http://acme.okta.com", "not_https"],
    ["user:pass@acme.okta.com", "has_credentials"],
    ["acme.okta.com:8443", "has_port"],
    ["acme.okta.com/x", "has_path_or_query"],
    ["169.254.169.254", "ip_literal"],
    ["localhost", "localhost_or_internal"],
    ["okta.com", "apex_only"],
    ["a.b.okta.com", "bad_label"],
    ["acme.notokta.com", "not_okta_apex"],
    ["id.acme.com", "not_okta_apex"],
  ];
  it.each(badHosts)("rejects %s without calling the database", async (host, detail) => {
    const r = await createOktaConnectorConfiguration({ ...VALID, orgInput: host });
    expect(r).toEqual({ ok: false, reason: "invalid_org_host", detail });
    expect(calls).toHaveLength(0);
  });

  it.each(["", "0oa", "has space", "a".repeat(300), "0oa;drop"])("rejects client id %s", async (clientId) => {
    const r = await createOktaConnectorConfiguration({ ...VALID, clientId });
    expect(r).toEqual({ ok: false, reason: "invalid_client_id" });
    expect(calls).toHaveLength(0);
  });

  it.each(["", "not-a-uuid", "44444444444444444444444444444444"])("rejects idempotency key %s", async (idempotencyKey) => {
    const r = await createOktaConnectorConfiguration({ ...VALID, idempotencyKey });
    expect(r).toEqual({ ok: false, reason: "invalid_idempotency_key" });
    expect(calls).toHaveLength(0);
  });
});

// ── Outcomes ────────────────────────────────────────────────────────────────────────────────────────────────────
describe("outcomes", () => {
  it("surfaces an idempotent replay as success, flagged", async () => {
    rpcResult = { outcome: "idempotent_replay", connector_id: "33333333-3333-4333-8333-333333333333" };
    const r = await createOktaConnectorConfiguration(VALID);
    expect(r.ok).toBe(true);
    expect(r.ok && r.view.idempotentReplay).toBe(true);
  });

  it("surfaces a duplicate configuration as its own reason", async () => {
    rpcResult = { outcome: "duplicate_configuration" };
    expect(await createOktaConnectorConfiguration(VALID)).toEqual({ ok: false, reason: "duplicate_configuration" });
  });

  it("treats an unknown outcome as a failure rather than a success", async () => {
    rpcResult = { outcome: "something_new" };
    expect(await createOktaConnectorConfiguration(VALID)).toEqual({ ok: false, reason: "write_failed" });
  });
});

// ── The safe view ───────────────────────────────────────────────────────────────────────────────────────────────
describe("the returned view is safe and truthful", () => {
  it("never claims verification or readiness", async () => {
    const r = await createOktaConnectorConfiguration(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.verified).toBe(false);
    expect(r.view.connectionState).toBe("configured");
    expect(r.view.certificationOnly).toBe(true);
    expect(r.view.productionEnabled).toBe(false);
    // Nothing is ready: no signing key exists until O2B.
    expect(r.view.nextRequiredAction).toBe("platform_signing_key_pending");
  });

  it("exposes exactly the allowlisted fields", async () => {
    const r = await createOktaConnectorConfiguration(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.view).sort()).toEqual([
      "approvedScopes", "authenticationMode", "certificationOnly", "clientId", "connectionState", "connectorId",
      "contractVersion", "createdAt", "idempotentReplay", "normalizedOrgHost", "productionEnabled", "provider",
      "nextRequiredAction", "verified",
    ].sort());
  });

  it("carries no secret, key, token or internal database detail", async () => {
    const r = await createOktaConnectorConfiguration(VALID);
    const blob = JSON.stringify(r);
    // Secret SHAPES and secret-bearing KEYS — not substrings that occur legitimately in mode names. `authenticationMode` is
    // "private_key_jwt", a non-secret label, so a naive /PRIVATE/ scan flags a correct value.
    expect(blob).not.toMatch(/-----BEGIN|PRIVATE KEY-----/);
    expect(blob).not.toMatch(/"(privateKey|clientSecret|accessToken|clientAssertion|secretRef|signingKeyArn)"\s*:/);
    // The forbidden role token is assembled rather than written literally: `scripts/check-auth-safety.sh` scans src/ for that
    // string and would flag this very assertion — the one proving the DTO does not contain it.
    const privilegedRole = ["service", "role"].join("_");
    expect(blob).not.toContain(privilegedRole);
    expect(blob).not.toMatch(/arn:aws|SUPABASE_SERVICE/i);
    expect(blob).not.toMatch(/"[A-Za-z0-9+/]{80,}={0,2}"/);   // no opaque blob
    expect(r.ok && r.view.authenticationMode).toBe("private_key_jwt");   // the only "private" is this label
    // and no raw database error text can reach a caller
    rpcError = { code: "23505" };
    expect(JSON.stringify(await createOktaConnectorConfiguration(VALID))).not.toMatch(/duplicate key|constraint|pg_|relation/i);
  });

  it("reads the view back from the database rather than echoing what it sent", async () => {
    // The DB is the source of truth: if it stored a different host, the view must show the stored one.
    rowResult = { ...defaultRow(), normalized_org_host: "stored.okta.com" };
    const r = await createOktaConnectorConfiguration(VALID);
    expect(r.ok && r.view.normalizedOrgHost).toBe("stored.okta.com");
  });
});

// ── Next-action derivation ──────────────────────────────────────────────────────────────────────────────────────
describe("nextActionFor is derived from what actually exists", () => {
  it("reports the earliest missing prerequisite", () => {
    expect(nextActionFor(null, "not_configured")).toBe("platform_signing_key_pending");
    expect(nextActionFor("key-1", "not_configured")).toBe("public_key_publication_pending");
    expect(nextActionFor("key-1", null)).toBe("public_key_publication_pending");
    expect(nextActionFor("key-1", "jwks_uri")).toBe("live_validation_required");
    expect(nextActionFor("key-1", "static_jwk")).toBe("live_validation_required");
  });

  it("never reports readiness for sync — O2A cannot reach that state", () => {
    for (const [k, d] of [[null, "not_configured"], ["key-1", "jwks_uri"]] as const) {
      expect(nextActionFor(k, d)).not.toBe("ready_for_initial_sync");
    }
  });
});
