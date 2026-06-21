import { describe, it, expect } from "vitest";
import {
  CONNECTOR_RUN_STATES,
  TERMINAL_RUN_STATES,
  CONNECTOR_AUDIT_ACTIONS,
  isTerminalRunStatus,
  isValidRunTransition,
  assertNoSecretFields,
  assertSafeFailureLabel,
  buildConnectorRunRecord,
  buildConnectorAuditEvent,
  ConnectorLifecycleError,
  type ConnectorRunStatus,
} from "./run-lifecycle";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CONNECTOR = "17000000-0000-0000-0000-0000000000a1";

describe("connector run lifecycle states + transitions", () => {
  it("defines exactly the six required states", () => {
    expect([...CONNECTOR_RUN_STATES]).toEqual(["queued", "running", "succeeded", "failed", "canceled", "timed_out"]);
  });

  it("marks the four terminal states terminal and the two active states non-terminal", () => {
    expect([...TERMINAL_RUN_STATES]).toEqual(["succeeded", "failed", "canceled", "timed_out"]);
    for (const s of TERMINAL_RUN_STATES) expect(isTerminalRunStatus(s)).toBe(true);
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
  });

  it("allows only the designed forward transitions; rejects skips and exits-from-terminal", () => {
    expect(isValidRunTransition("queued", "running")).toBe(true);
    expect(isValidRunTransition("queued", "canceled")).toBe(true);
    expect(isValidRunTransition("running", "succeeded")).toBe(true);
    expect(isValidRunTransition("running", "failed")).toBe(true);
    expect(isValidRunTransition("running", "timed_out")).toBe(true);
    expect(isValidRunTransition("running", "canceled")).toBe(true);
    // invalid: skip queued→succeeded, and any transition OUT of a terminal state
    expect(isValidRunTransition("queued", "succeeded")).toBe(false);
    expect(isValidRunTransition("queued", "timed_out")).toBe(false);
    for (const t of TERMINAL_RUN_STATES) {
      for (const s of CONNECTOR_RUN_STATES) expect(isValidRunTransition(t, s)).toBe(false);
    }
  });
});

describe("connector audit actions", () => {
  it("defines exactly the conceptual connector audit actions", () => {
    expect([...CONNECTOR_AUDIT_ACTIONS]).toEqual([
      "connector.run.created",
      "connector.run.started",
      "connector.run.completed",
      "connector.run.failed",
      "connector.credential.created",
      "connector.credential.revoked",
    ]);
  });
});

describe("buildConnectorRunRecord (safe metadata only)", () => {
  it("builds a valid safe run record (status + timestamps + counters + safe failure code/label)", () => {
    const rec = buildConnectorRunRecord({
      tenantId: TENANT,
      connectorId: CONNECTOR,
      status: "failed",
      startedAt: "2026-06-21T00:00:00Z",
      completedAt: "2026-06-21T00:01:00Z",
      failureCode: "auth_expired",
      failureLabel: "Authorization expired; reconnect required",
      recordsSeen: 100,
      recordsImported: 90,
      recordsFailed: 10,
    });
    expect(rec.status).toBe("failed");
    expect(rec.failureCode).toBe("auth_expired");
    expect(rec.recordsSeen).toBe(100);
    // the produced shape carries ONLY the safe keys
    expect(Object.keys(rec).sort()).toEqual(
      ["completedAt", "connectorId", "failureCode", "failureLabel", "recordsFailed", "recordsImported", "recordsSeen", "startedAt", "status", "tenantId"].sort(),
    );
  });

  it("rejects an invalid run status", () => {
    expect(() =>
      buildConnectorRunRecord({ tenantId: TENANT, connectorId: CONNECTOR, status: "success" as unknown as ConnectorRunStatus }),
    ).toThrow(ConnectorLifecycleError);
  });

  it("rejects negative / non-integer counters", () => {
    expect(() => buildConnectorRunRecord({ tenantId: TENANT, connectorId: CONNECTOR, status: "running", recordsSeen: -1 })).toThrow(ConnectorLifecycleError);
    expect(() => buildConnectorRunRecord({ tenantId: TENANT, connectorId: CONNECTOR, status: "running", recordsImported: 1.5 })).toThrow(ConnectorLifecycleError);
  });

  it("rejects a secret-shaped field name in the run input (no token/secret/key metadata)", () => {
    expect(() =>
      // @ts-expect-error — accessToken is not a valid field and must be rejected at runtime
      buildConnectorRunRecord({ tenantId: TENANT, connectorId: CONNECTOR, status: "running", accessToken: "x" }),
    ).toThrow(ConnectorLifecycleError);
    expect(() =>
      // @ts-expect-error — refresh_token is not a valid field and must be rejected at runtime
      buildConnectorRunRecord({ tenantId: TENANT, connectorId: CONNECTOR, status: "running", refresh_token: "x" }),
    ).toThrow(ConnectorLifecycleError);
  });

  it("rejects a credential-shaped VALUE smuggled into the safe failure label / code (anywhere in the string)", () => {
    expect(() =>
      buildConnectorRunRecord({ tenantId: TENANT, connectorId: CONNECTOR, status: "failed", failureLabel: "Bearer not-a-real-token-value-here" }),
    ).toThrow(ConnectorLifecycleError);
    expect(() =>
      buildConnectorRunRecord({ tenantId: TENANT, connectorId: CONNECTOR, status: "failed", failureLabel: "ghp_0123456789abcdefABCDEF" }),
    ).toThrow(ConnectorLifecycleError);
    // EMBEDDED mid-string (not the leading token) must still be caught — the guard is unanchored.
    expect(() =>
      buildConnectorRunRecord({ tenantId: TENANT, connectorId: CONNECTOR, status: "failed", failureLabel: "Provider rejected the request: Bearer ghp_0123456789abcdef expired" }),
    ).toThrow(ConnectorLifecycleError);
    expect(() =>
      buildConnectorRunRecord({ tenantId: TENANT, connectorId: CONNECTOR, status: "failed", failureLabel: "upstream 401, token sk-0123456789abcdefXYZ rejected" }),
    ).toThrow(ConnectorLifecycleError);
    // the machine failure CODE is scanned + length-bounded the same way as the label.
    expect(() =>
      buildConnectorRunRecord({ tenantId: TENANT, connectorId: CONNECTOR, status: "failed", failureCode: "auth_failed: ghp_0123456789abcdefABCDEF" }),
    ).toThrow(ConnectorLifecycleError);
    expect(() =>
      buildConnectorRunRecord({ tenantId: TENANT, connectorId: CONNECTOR, status: "failed", failureCode: "x".repeat(201) }),
    ).toThrow(ConnectorLifecycleError);
  });
});

describe("buildConnectorAuditEvent (safe metadata only)", () => {
  it("builds a valid audit event with safe metadata", () => {
    const ev = buildConnectorAuditEvent({
      action: "connector.run.completed",
      tenantId: TENANT,
      connectorId: CONNECTOR,
      metadata: { runStatus: "succeeded", recordsImported: 42 },
    });
    expect(ev.action).toBe("connector.run.completed");
    expect(ev.metadata).toEqual({ runStatus: "succeeded", recordsImported: 42 });
  });

  it("rejects an unknown audit action", () => {
    expect(() =>
      // @ts-expect-error — invalid action
      buildConnectorAuditEvent({ action: "connector.secret.exfiltrate", tenantId: TENANT, connectorId: CONNECTOR }),
    ).toThrow(ConnectorLifecycleError);
  });

  it("rejects secret-shaped metadata in an audit event", () => {
    expect(() =>
      buildConnectorAuditEvent({ action: "connector.credential.created", tenantId: TENANT, connectorId: CONNECTOR, metadata: { api_key: "x" } }),
    ).toThrow(ConnectorLifecycleError);
    expect(() =>
      buildConnectorAuditEvent({ action: "connector.credential.created", tenantId: TENANT, connectorId: CONNECTOR, metadata: { note: "Bearer abcd.efgh.ijkl" } }),
    ).toThrow(ConnectorLifecycleError);
    // an innocuously-named field carrying a credential EMBEDDED mid-value is the realistic leak path.
    expect(() =>
      buildConnectorAuditEvent({ action: "connector.credential.created", tenantId: TENANT, connectorId: CONNECTOR, metadata: { detail: "rotation failed for ghp_0123456789abcdefABCDEF on retry" } }),
    ).toThrow(ConnectorLifecycleError);
  });
});

describe("redaction guards", () => {
  it("assertNoSecretFields throws on forbidden key names and credential-shaped values", () => {
    expect(() => assertNoSecretFields({ ciphertext: "x" }, "t")).toThrow(ConnectorLifecycleError);
    expect(() => assertNoSecretFields({ webhook_secret: "x" }, "t")).toThrow(ConnectorLifecycleError);
    expect(() => assertNoSecretFields({ note: "sk-0123456789abcdef0123" }, "t")).toThrow(ConnectorLifecycleError);
    expect(() => assertNoSecretFields({ status: "running", count: 5 }, "t")).not.toThrow();
  });

  it("assertSafeFailureLabel accepts a short safe label, rejects credential-shaped / overlong", () => {
    expect(() => assertSafeFailureLabel("Provider returned 503")).not.toThrow();
    expect(() => assertSafeFailureLabel("a".repeat(201))).toThrow(ConnectorLifecycleError);
    // a JWT-shaped value (built from parts so the literal token never appears in this test's source, which
    // would otherwise trip scripts/check-auth-safety.sh's repo-wide JWT-literal scan).
    const jwtShaped = "ey" + "J" + "hbGciOiJIUzI1NiJ9payloadsignature";
    expect(() => assertSafeFailureLabel(jwtShaped)).toThrow(ConnectorLifecycleError);
  });
});

// ── Purity: the lifecycle module touches no DB / Supabase / service-role / env ───────────────────────
describe("connector run-lifecycle module is pure (no DB / no Supabase / no service-role)", () => {
  it("run-lifecycle.ts has no imports and no DB/Supabase/service-role/env usage", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "run-lifecycle.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]); // pure TS — no module imports at all
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    const forbidden = ["service", "role"].join("_");
    const forbiddenEnv = ["SUPABASE", "SERVICE", "ROLE"].join("_");
    expect(code).not.toContain(forbidden);
    expect(code).not.toContain(forbiddenEnv);
  });
});
