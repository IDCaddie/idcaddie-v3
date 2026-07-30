// O1C.1 — the generic lifecycle envelope and the `native_connector` manifest kind.
//
// WHY THIS EXTENSION EXISTS. The original neutral manifest is an EXECUTOR PROGRAM: `base_url` + `endpoints` + `field_map` +
// `pagination` tell the generic executor how to fetch and map. That cannot describe a provider whose base URL is per-tenant and whose
// normalization lives in reviewed TypeScript — forcing one into that shape would produce a manifest claiming to drive an executor
// that never reads it. So the neutral schema now admits a second, GENERIC kind, and stays authoritative instead of leaving a
// provider-specific format only that provider's code understands.
//
// The load-bearing compatibility property: every pre-O1C.1 manifest must validate BYTE-UNCHANGED.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ProviderManifestSchema, NativeConnectorManifestSchema, ExecutorProgramManifestSchema, LifecycleSchema,
  isNativeConnectorManifest, PROVIDER_LIFECYCLE_STATUSES, PROVIDER_ACCESS_MODES, PROVIDER_CAPABILITIES,
} from "./manifest-schema";
import { validateManifestsDir } from "./manifest-validate";

const MANIFESTS = join(process.cwd(), "src", "lib", "server", "connectors", "manifests");

// A minimal truthful native manifest. Shaped like the Okta one the connector-runner ships, but this test owns its own fixture so it
// cannot be silently weakened by an edit in the other repository.
const NATIVE = {
  manifest_version: 1,
  manifest_kind: "native_connector",
  provider_id: "okta",
  base_url_source: "server_derived",
  auth: { kind: "oauth2", token_kind: "oauth_private_key_jwt_access_token", header: "bearer" },
  api_base_path: "/api/v1",
  lifecycle: {
    status: "certification_only",
    access_mode: "read_only",
    execution: { staging_enabled: true, production_enabled: false, explicit_hosted_authorization_required: true },
  },
  resources: ["users", "groups"],
  capabilities: ["validate", "aggregate", "persist", "paginate", "retry", "completeness", "reconcile"],
  not_yet_available: ["production_acceptance"],
  entrypoints: [
    { role: "verify", task_file: "v-task.ts", task_definition: "td-v.json", resources: [], persists: false },
    { role: "aggregate", task_file: "a-task.ts", task_definition: "td-a.json", resources: ["users", "groups"], persists: false },
    { role: "persist", task_file: "p-task.ts", task_definition: "td-p.json", resources: ["users", "groups"], persists: true },
  ],
  budget_profile: { name: "OKTA_PRODUCTION_BUDGET", source: "src/connector-sync/okta-pagination.ts" },
  rate_limit: { rps: 5, burst: 2 },
} as const;

const native = (over: Record<string, unknown> = {}) => ({ ...NATIVE, ...over });
const lifecycle = (over: Record<string, unknown> = {}) => ({ ...NATIVE.lifecycle, ...over });
const execution = (over: Record<string, unknown> = {}) => lifecycle({ execution: { ...NATIVE.lifecycle.execution, ...over } });

// ── Backward compatibility ──────────────────────────────────────────────────────────────────────────────────────
describe("existing manifests are unaffected", () => {
  it("every shipped manifest still validates, with no field added", () => {
    const r = validateManifestsDir();
    expect(r.ok, JSON.stringify(r.results)).toBe(true);
    expect(Object.keys(r.results).length).toBeGreaterThan(0);
  });

  it("an executor-program manifest validates WITHOUT declaring manifest_kind", () => {
    for (const f of readdirSync(MANIFESTS).filter((x) => x.endsWith(".json"))) {
      const raw = JSON.parse(readFileSync(join(MANIFESTS, f), "utf8")) as Record<string, unknown>;
      expect(raw.manifest_kind, `${f} should not need manifest_kind`).toBeUndefined();
      expect(ProviderManifestSchema.safeParse(raw).success, `${f} no longer validates`).toBe(true);
    }
  });

  it("the default kind is executor_program, so old manifests keep their meaning", () => {
    const raw = JSON.parse(readFileSync(join(MANIFESTS, "slack.v1.json"), "utf8")) as unknown;
    const parsed = ExecutorProgramManifestSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.manifest_kind).toBe("executor_program");
  });

  it("an executor program is NOT mistaken for a native connector", () => {
    const raw = JSON.parse(readFileSync(join(MANIFESTS, "slack.v1.json"), "utf8")) as unknown;
    expect(NativeConnectorManifestSchema.safeParse(raw).success).toBe(false);
    const parsed = ProviderManifestSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(isNativeConnectorManifest(parsed.data)).toBe(false);
  });

  it("lifecycle is OPTIONAL on an executor program", () => {
    const raw = JSON.parse(readFileSync(join(MANIFESTS, "slack.v1.json"), "utf8")) as Record<string, unknown>;
    expect(raw.lifecycle).toBeUndefined();
    expect(ExecutorProgramManifestSchema.safeParse(raw).success).toBe(true);
    // …but validated when present
    expect(ExecutorProgramManifestSchema.safeParse({ ...raw, lifecycle: execution({ production_enabled: true }) }).success).toBe(false);
  });
});

// ── The native kind ─────────────────────────────────────────────────────────────────────────────────────────────
describe("native_connector manifests", () => {
  it("a truthful native manifest validates and narrows", () => {
    const parsed = ProviderManifestSchema.safeParse(NATIVE);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(isNativeConnectorManifest(parsed.data)).toBe(true);
  });

  it("declares no manifest-constant base URL — a per-tenant provider cannot have one", () => {
    expect(NATIVE.base_url_source).toBe("server_derived");
    expect(NativeConnectorManifestSchema.safeParse(native({ base_url_source: "manifest" })).success).toBe(false);
    // and the executor-program keys are simply absent, not stubbed with a fiction
    expect((NATIVE as Record<string, unknown>).base_url).toBeUndefined();
    expect((NATIVE as Record<string, unknown>).endpoints).toBeUndefined();
  });

  it("is strict — an unknown field is rejected", () => {
    expect(NativeConnectorManifestSchema.safeParse(native({ surprise: 1 })).success).toBe(false);
  });

  it("requires at least one resource, capability and entrypoint", () => {
    expect(NativeConnectorManifestSchema.safeParse(native({ resources: [] })).success).toBe(false);
    expect(NativeConnectorManifestSchema.safeParse(native({ capabilities: [] })).success).toBe(false);
    expect(NativeConnectorManifestSchema.safeParse(native({ entrypoints: [] })).success).toBe(false);
  });

  it("enforces lower_snake_case resource ids", () => {
    for (const bad of ["Users", "user-accounts", "1users", "users!", ""]) {
      expect(NativeConnectorManifestSchema.safeParse(native({ resources: [bad] })).success, bad).toBe(false);
    }
  });
});

// ── Declaration cannot overstate implementation ─────────────────────────────────────────────────────────────────
describe("resource/entrypoint coherence is enforced by the schema", () => {
  it("a resource with no aggregate entrypoint is rejected", () => {
    const r = NativeConnectorManifestSchema.safeParse(native({
      resources: ["users", "groups", "orphan"],
    }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /orphan/.test(i.message))).toBe(true);
  });

  it("a resource with no persist entrypoint is rejected", () => {
    const r = NativeConnectorManifestSchema.safeParse(native({
      resources: ["users", "groups", "readonly_only"],
      entrypoints: [
        NATIVE.entrypoints[1],
        { role: "aggregate", task_file: "x.ts", task_definition: "x.json", resources: ["readonly_only"], persists: false },
        NATIVE.entrypoints[2],
      ],
    }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /readonly_only.*persist/.test(i.message))).toBe(true);
  });

  it("an entrypoint referencing an undeclared resource is rejected", () => {
    const r = NativeConnectorManifestSchema.safeParse(native({
      entrypoints: [...NATIVE.entrypoints, { role: "aggregate", task_file: "g.ts", task_definition: "g.json", resources: ["ghost"], persists: false }],
    }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /undeclared resource 'ghost'/.test(i.message))).toBe(true);
  });

  it("MANY-TO-ONE is allowed — one entrypoint may serve several resources", () => {
    // Okta's application_user_assignments and application_group_assignments share one pair; the schema must not forbid that.
    expect(NativeConnectorManifestSchema.safeParse(NATIVE).success).toBe(true);
    expect(NATIVE.entrypoints[1].resources.length).toBeGreaterThan(1);
  });

  it("the persists flag must match the role", () => {
    expect(NativeConnectorManifestSchema.safeParse(native({
      entrypoints: [{ ...NATIVE.entrypoints[1], persists: true }, NATIVE.entrypoints[2]],
    })).success).toBe(false);
    expect(NativeConnectorManifestSchema.safeParse(native({
      entrypoints: [NATIVE.entrypoints[1], { ...NATIVE.entrypoints[2], persists: false }],
    })).success).toBe(false);
  });

  it("verify is an auth-only role and declares no resource", () => {
    const verify = NATIVE.entrypoints.find((e) => e.role === "verify");
    expect(verify?.resources).toEqual([]);
    expect(verify?.persists).toBe(false);
  });
});

// ── Execution safety — the point of the whole extension ─────────────────────────────────────────────────────────
describe("a manifest cannot declare production execution", () => {
  it("certification_only + production_enabled: true is REFUSED BY THE SCHEMA", () => {
    // The strongest available guarantee: no manifest input — hand-edited, generated, or supplied — can express the combination.
    const r = LifecycleSchema.safeParse(execution({ production_enabled: true }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/must declare production_enabled: false/);
    expect(NativeConnectorManifestSchema.safeParse(native({ lifecycle: execution({ production_enabled: true }) })).success).toBe(false);
  });

  it("certification_only cannot waive explicit hosted authorization", () => {
    expect(LifecycleSchema.safeParse(execution({ explicit_hosted_authorization_required: false })).success).toBe(false);
  });

  it("declaring the connector IMPLEMENTED does not enable production", () => {
    // Every capability declared, every resource declared — production still false, hosted authorization still required.
    const full = native({ capabilities: [...PROVIDER_CAPABILITIES] });
    const parsed = NativeConnectorManifestSchema.safeParse(full);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lifecycle.execution.production_enabled).toBe(false);
      expect(parsed.data.lifecycle.execution.explicit_hosted_authorization_required).toBe(true);
      expect(parsed.data.lifecycle.status).toBe("certification_only");
    }
  });

  it("no capability verb implies mutation — the enum has no write verb", () => {
    for (const c of PROVIDER_CAPABILITIES) expect(c).not.toMatch(/mutate|write|grant|revoke|remediat|delete|create|update|assign/);
    for (const bad of ["mutate", "write", "grant", "revoke", "remediate", "assign"]) {
      expect(NativeConnectorManifestSchema.safeParse(native({ capabilities: [bad] })).success, bad).toBe(false);
    }
  });

  it("access_mode read_only is expressible and read_write is not silently implied", () => {
    expect(PROVIDER_ACCESS_MODES).toEqual(["read_only", "read_write"]);
    expect(NATIVE.lifecycle.access_mode).toBe("read_only");
    // read_write remains representable for a FUTURE provider, but changing it is a visible manifest edit, never a default.
    expect(LifecycleSchema.safeParse(lifecycle({ access_mode: "read_write" })).success).toBe(true);
  });

  it("lifecycle status values are the known set only", () => {
    expect(PROVIDER_LIFECYCLE_STATUSES).toEqual(["certification_only", "pilot_ready", "enabled"]);
    for (const bad of ["live", "production", "ready", ""]) {
      expect(LifecycleSchema.safeParse(lifecycle({ status: bad })).success, bad).toBe(false);
    }
  });

  it("an enabled provider MAY declare production — so the gate is status-driven, not hardcoded to one provider", () => {
    // Proves the constraint is generic policy, not an Okta special case: the refinement keys off `status`.
    expect(LifecycleSchema.safeParse({ status: "enabled", access_mode: "read_only", execution: { staging_enabled: true, production_enabled: true, explicit_hosted_authorization_required: false } }).success).toBe(true);
  });
});

// ── Budget is referenced, never duplicated ──────────────────────────────────────────────────────────────────────
describe("budget_profile is a reference, not a copy", () => {
  it("names an UPPER_SNAKE_CASE runtime constant and its source", () => {
    expect(NATIVE.budget_profile.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(NATIVE.budget_profile.source.length).toBeGreaterThan(0);
  });

  it("rejects a lower-case or empty profile name", () => {
    for (const bad of ["okta_production_budget", "", "Okta_Budget"]) {
      expect(NativeConnectorManifestSchema.safeParse(native({ budget_profile: { name: bad, source: "x" } })).success, bad).toBe(false);
    }
  });

  it("the native kind has NO numeric budget block to drift from runtime", () => {
    expect((NATIVE as Record<string, unknown>).budget).toBeUndefined();
    expect(NativeConnectorManifestSchema.safeParse(native({ budget: { max_requests: 1, max_items: 1, max_wallclock_s: 1 } })).success).toBe(false);
  });
});
