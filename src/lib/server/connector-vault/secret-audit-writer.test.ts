import { describe, it, expect } from "vitest";
import { buildAuditInsertStatement, INSERT_AUDIT_LOG_SQL } from "./secret-audit-writer";
import { buildConnectorSecretAuditEvent } from "./secret-audit";

const TENANT = "00000000-0000-0000-0000-0000000d8a70";
const CONNECTOR = "00000000-0000-0000-0000-0000000d8a71";

describe("buildAuditInsertStatement — enlists the #166 record as a 4-column audit INSERT", () => {
  it("emits the parameterized INSERT naming ONLY the four 0031-granted columns", () => {
    const record = buildConnectorSecretAuditEvent({ event: "connector_secret.store.succeeded", tenantId: TENANT, connectorId: CONNECTOR, secretKind: "api_key", version: 1 });
    const stmt = buildAuditInsertStatement(record);
    expect(stmt.sql).toBe(INSERT_AUDIT_LOG_SQL);
    expect(stmt.sql).toBe("insert into public.audit_logs (tenant_id, action, resource_type, after_json) values ($1, $2, $3, $4)");
    // never names a non-granted column.
    for (const bad of ["actor_user_id", "resource_id", "before_json", "ip_address", "user_agent"]) expect(stmt.sql).not.toContain(bad);
    // params map 1:1 to the granted columns: tenant_id, action, resource_type, after_json(json string).
    expect(stmt.params[0]).toBe(TENANT);
    expect(stmt.params[1]).toBe("connector_secret.store.succeeded");
    expect(stmt.params[2]).toBe("connector_secret");
    expect(JSON.parse(String(stmt.params[3]))).toEqual({ event: "connector_secret.store.succeeded", connector_id: CONNECTOR, secret_kind: "api_key", version: 1, result: "succeeded" });
    expect(stmt.params).toHaveLength(4);
  });

  it("forwards ONLY the record's allowlisted after_json — the #166 builder already dropped any hostile field", () => {
    // even if a caller smuggled extra fields into the #166 input, the record's after_json is allowlisted; the
    // writer serializes only that. (Defense proven in secret-audit.test.ts; here we confirm no extra passthrough.)
    const record = buildConnectorSecretAuditEvent({ event: "connector_secret.load.failed", tenantId: TENANT, connectorId: CONNECTOR, secretKind: "api_key", version: 2, errorClass: "ambiguous_match" });
    const after = JSON.parse(String(buildAuditInsertStatement(record).params[3]));
    expect(Object.keys(after).sort()).toEqual(["connector_id", "error_class", "event", "result", "secret_kind", "version"]);
    expect(after.error_class).toBe("ambiguous_match");
  });
});

describe("secret-audit-writer.ts is pure server-only (no connection / role / transaction of its own)", () => {
  it("imports only the #166 record type; opens no DB/supabase/aws/fetch/process.env, owns no transaction", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./secret-audit-writer.ts", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["./secret-audit"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["createClient", "@supabase", "@aws-sdk", "pg.Client", "new Client(", "fetch(", "process.env", ["service", "role", "key"].join("_"), "runSequence", "begin", "commit"]) {
      expect(code).not.toContain(bad);
    }
    expect(src).toMatch(/server-only/);
    expect(src).toMatch(/globalThis[^\n]*window/);
  });
});
