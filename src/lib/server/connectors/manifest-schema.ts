// Provider MANIFEST contract (docs/54, Phase 1a). The reviewed, STRICT zod schema every provider manifest must satisfy.
// A manifest is DATA, not code: no expressions, no secrets, GET-only, capped. It is validated at CI + load time and is
// NEVER loaded from a tenant / DB / env at runtime (see manifest-validate.ts). INERT — this module only *describes and
// validates* a manifest; it does not fetch, sync, store a token, call a provider, or touch the DB. First provider is Slack
// but nothing here is Slack-specific. RISK-007 is a SEPARATE track: it remains OPEN; Phase C remains BLOCKED.

import { z } from "zod";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connectors/manifest-schema is server-only and must not be imported in client code");
}

// ── Allowlists (widen only via a reviewed PR) ─────────────────────────────────────────────────────────
export const AUTH_KINDS = ["oauth2", "api_key"] as const;
export const AUTH_HEADERS = ["bearer", "api_key_header"] as const;
export const HTTP_METHODS = ["GET"] as const; // GET only for Phase 1a. POST / mutations are separately gated — NOT allowed here.
export const PAGINATION_STYLES = ["cursor", "page", "offset", "link", "none"] as const;

// The fact types an endpoint may emit — a curated SUBSET of discovery-facts `FactTypeSchema`, plus "none".
// "group" is INCLUDED: the standalone `group` fact exists as of PR #252 (docs/54 §7 — additive, no schema-version bump).
// NOTE: this only allowlists the emit *type*. The per-item schema (e.g. `slack_usergroup`) is validated by the executor's
// item-schema registry (Phase 1b) — not yet built; the manifest layer treats `item_schema_ref` as an opaque string.
// "license" added by 0086. It was already a member of the shared contract's FactTypeSchema AND is now accepted by the
// write boundary (runner_insert_discovery_fact), so this allowlist being narrower than both was the last place the three
// disagreed — a declarative connector could not DECLARE a licence read that the database would happily store.
//
// Google Workspace does not depend on this: it is a native connector and declares no `endpoints`, so it never consults
// this list. The entry closes the framework gap for the NEXT provider whose licences are reachable by a plain GET.
// `role_admin` and `usage_activity` are also in the shared contract and are deliberately still absent here — nothing
// persists them, and an emit type the write boundary would reject is worse than no entry at all.
export const EMIT_FACT_TYPES = ["none", "app_user_account", "app_discovery", "app_instance_identity", "group", "group_membership", "license"] as const;

// Per-provider host allowlist. base_url's host must be listed here (EXACT hostname match — no wildcard, no suffix match).
// Extended one reviewed provider at a time.
export const PROVIDER_HOST_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  slack: ["slack.com"],
  // Synthetic SCIM proof provider — the reserved, NON-ROUTABLE `.invalid` TLD (RFC 6761). Fixture-only; cannot resolve to
  // any real service; not a vendor/customer domain. Exact host only (the superRefine below does `allowed.includes(host)`).
  scim_fixture: ["scim.fixture.invalid"],
  // Microsoft Entra directory discovery via the Microsoft Graph API — the EXACT global Graph host ONLY (canonical host
  // policy for the future fixture-certified Graph `/users` connector). Deliberately NO sovereign-cloud Graph hosts
  // (graph.microsoft.us / dod-graph.microsoft.us / microsoftgraph.chinacloudapi.cn), NO token host (login.microsoftonline.com),
  // NO parent domain, NO wildcard/suffix — exact equality only. The `microsoft_entra` provider stays inert (disabled,
  // not connectable); no Graph runtime/manifest/schema/OAuth exists yet.
  microsoft_entra: ["graph.microsoft.com"],
  // Google Workspace admin discovery. TWO exact hosts, because Google splits this one administrative surface across two
  // separate APIs — no single host serves both the directory and licences:
  //   admin.googleapis.com     — Admin SDK Directory API (users, groups, group members)
  //   licensing.googleapis.com — Enterprise License Manager API (licenceAssignments)
  // Exact equality only, as for every other provider: no wildcard, no suffix match, and deliberately NOT the parent domain
  // (`googleapis.com` fronts hundreds of unrelated Google APIs). NO token host either — oauth2.googleapis.com is reached by
  // the auth module under its own exact-host pin, never by a manifest-declared endpoint. `cloudidentity.googleapis.com` is
  // deliberately absent: nothing calls it, and an allowlisted host that no code reaches is a widened boundary for free.
  google_workspace: ["admin.googleapis.com", "licensing.googleapis.com"],
};

// field_map values are a DOT-PATH into the response item, optionally negated with ONE leading "!". NOTHING ELSE — no
// spaces, operators, function calls, brackets, templates, or interpolation. The moment a config can *compute*, it is code.
export const FIELD_MAP_VALUE = /^!?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
export const FieldMapValueSchema = z
  .string()
  .regex(FIELD_MAP_VALUE, "field_map value must be a dot-path or !dot-path (no expressions/code)");

// A NEXT-LINK PATH identifies the response field holding an OPAQUE continuation URL (e.g. Microsoft Graph's
// `@odata.nextLink`) for the `link` pagination style. It IDENTIFIES DATA ONLY — it is NOT an expression, a JSONPath
// engine, a URL, a host, an HTTP method, a query param, or code; it cannot read a secret or import anything. Grammar:
// dot-separated segments, each an identifier optionally prefixed with a SINGLE `@` (for OData annotation keys like
// `@odata`); NO empty segment (rejects leading/trailing/double dots), and no brackets, `*`, slashes, whitespace, or
// control chars. Prototype-pollution segments (`__proto__`/`constructor`/`prototype`, with or without a leading `@`) are
// rejected below. Bounded length. Extraction logic (reading the value) is a SEPARATE, later reviewed change — not here.
export const NEXT_LINK_PATH = /^@?[A-Za-z_][A-Za-z0-9_]*(\.@?[A-Za-z_][A-Za-z0-9_]*)*$/;
const NEXT_LINK_FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
export const NextLinkPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(NEXT_LINK_PATH, "next_path must be a dotted property reference (e.g. @odata.nextLink) — no expressions, URLs, brackets, wildcards, slashes, or whitespace")
  .refine(
    (p) => p.split(".").every((seg) => !NEXT_LINK_FORBIDDEN_SEGMENTS.has(seg.replace(/^@/, ""))),
    "next_path must not reference a prototype-pollution key (__proto__ / constructor / prototype)",
  );

const StaticQueryValue = z.union([z.string(), z.number(), z.boolean()]); // static, non-secret params only

// Pagination — a union of strict shapes. Every paginated style REQUIRES max_pages (a hard cap). "none" = single page.
const PaginationSchema = z.union([
  z.object({ style: z.literal("cursor"), cursor_param: z.string().min(1), next_path: z.string().min(1), items_path: z.string().min(1), max_pages: z.number().int().positive() }).strict(),
  z.object({ style: z.literal("page"), page_param: z.string().min(1), items_path: z.string().min(1), max_pages: z.number().int().positive() }).strict(),
  z.object({ style: z.literal("offset"), offset_param: z.string().min(1), limit_param: z.string().min(1), items_path: z.string().min(1), max_pages: z.number().int().positive() }).strict(),
  z.object({ style: z.literal("link"), items_path: z.string().min(1), next_path: NextLinkPathSchema, max_pages: z.number().int().positive() }).strict(),
  z.object({ style: z.literal("none"), items_path: z.string().min(1) }).strict(),
]);

const EndpointSchema = z
  .object({
    id: z.string().min(1),
    method: z.enum(HTTP_METHODS),
    path: z.string().regex(/^\/[A-Za-z0-9._/-]*$/, "path must be a leading-slash relative path"),
    query: z.record(z.string(), StaticQueryValue).optional(),
    pagination: PaginationSchema.optional(),
    emits: z.enum(EMIT_FACT_TYPES),
    item_schema_ref: z.string().min(1).optional(),
    field_map: z.record(z.string(), FieldMapValueSchema).optional(),
    response: z.object({ ok_path: z.string().min(1) }).strict().optional(),
    required_scopes: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.emits !== "none") {
      if (!e.item_schema_ref) ctx.addIssue({ code: "custom", message: `endpoint '${e.id}' emits '${e.emits}' but has no item_schema_ref` });
      if (!e.field_map || Object.keys(e.field_map).length === 0) ctx.addIssue({ code: "custom", message: `endpoint '${e.id}' emits a fact but has no field_map` });
      if (!e.pagination) ctx.addIssue({ code: "custom", message: `endpoint '${e.id}' emits a fact but declares no pagination (use style 'none' for single-page)` });
    }
  });

// ── Lifecycle envelope (O1C.1) ────────────────────────────────────────────────────────────────────────
// Provider-agnostic. Declares WHAT a provider is, never WHETHER it may run: execution authorization stays in the composition root,
// the dispatch guards, and the per-run hosted flags. A manifest is DATA — registering a capability must not grant one.
export const PROVIDER_LIFECYCLE_STATUSES = ["certification_only", "pilot_ready", "enabled"] as const;
export const PROVIDER_ACCESS_MODES = ["read_only", "read_write"] as const;

// Capability verbs a provider may declare. Read/ingest verbs only: there is deliberately NO mutate/grant/revoke/remediate verb, so a
// manifest cannot declare a write capability at all (see the superRefine access-mode check below).
export const PROVIDER_CAPABILITIES = [
  "validate", "aggregate", "persist", "paginate", "retry", "completeness", "reconcile",
] as const;

export const LifecycleSchema = z
  .object({
    status: z.enum(PROVIDER_LIFECYCLE_STATUSES),
    access_mode: z.enum(PROVIDER_ACCESS_MODES),
    execution: z
      .object({
        staging_enabled: z.boolean(),
        production_enabled: z.boolean(),
        explicit_hosted_authorization_required: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((l, ctx) => {
    // A certification-only provider can NEVER declare production execution, and can never waive explicit hosted authorization.
    // This is enforced by the SCHEMA, so no manifest input — hand-edited, generated, or otherwise — can express the combination.
    if (l.status === "certification_only") {
      if (l.execution.production_enabled) {
        ctx.addIssue({ code: "custom", path: ["execution", "production_enabled"], message: "a certification_only provider must declare production_enabled: false" });
      }
      if (!l.execution.explicit_hosted_authorization_required) {
        ctx.addIssue({ code: "custom", path: ["execution", "explicit_hosted_authorization_required"], message: "a certification_only provider must require explicit hosted authorization" });
      }
    }
  });

// ── Native-connector manifests (O1C.1) ────────────────────────────────────────────────────────────────
// WHY A SECOND KIND EXISTS. The shape above is an EXECUTOR PROGRAM: `base_url` + `endpoints` + `field_map` + `pagination` tell the
// GENERIC executor how to fetch and map. That shape cannot describe a provider like Okta, for three structural reasons:
//   1. `base_url` is one constant host, allowlisted by exact hostname — Okta's base URL is PER-TENANT (`https://<org>.okta.com`) and
//      is server-derived from the ownership-validated connection. No constant host can exist.
//   2. `field_map` is mandatory for a fact-emitting endpoint, but a native connector normalizes in reviewed TypeScript with its own
//      response schemas. Declaring a field_map would claim to drive an executor that never reads it.
//   3. `EMIT_FACT_TYPES` has no member for some native resources (e.g. application assignments).
//
// So `native_connector` declares WHAT is implemented and its lifecycle, and omits the executor program it does not use. This is a
// GENERIC kind — any future provider implemented by reviewed native code uses it — and it keeps the neutral schema authoritative
// instead of leaving a provider-specific format that only that provider's code understands.
const NativeResourceIdSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/, "resource id must be lower_snake_case");
const NativeEntrypointRoles = ["verify", "smoke", "aggregate", "persist"] as const;

const NativeEntrypointSchema = z
  .object({
    role: z.enum(NativeEntrypointRoles),
    // Repository-relative identifiers, validated for SHAPE only. The owning repository's consistency test proves they exist.
    task_file: z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/, "task_file must be a bare filename"),
    task_definition: z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/, "task_definition must be a bare filename"),
    resources: z.array(NativeResourceIdSchema),   // empty for auth-only roles such as `verify`
    persists: z.boolean(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.persists !== (e.role === "persist")) {
      ctx.addIssue({ code: "custom", path: ["persists"], message: `entrypoint '${e.task_file}' sets persists=${e.persists} for role '${e.role}'` });
    }
  });

export const NativeConnectorManifestSchema = z
  .object({
    manifest_version: z.literal(1),
    manifest_kind: z.literal("native_connector"),
    provider_id: z.string().min(1),
    // Where the base URL comes from. Stated explicitly rather than left as a missing field.
    //   server_derived — per-tenant, no constant host can exist (Okta's `https://<org>.okta.com`).
    //   manifest_multi — constant hosts, but MORE THAN ONE, because the provider splits one administrative surface across
    //                    several APIs (Google Workspace: admin / cloudidentity / licensing). The executor-program kind
    //                    cannot express this: its `base_url` is a single string. Declaring `server_derived` here would be
    //                    false — the hosts ARE constant — and this schema exists to stop a manifest stating something untrue.
    //   manifest       — a single constant host, which the executor-program kind already describes; refused below.
    base_url_source: z.enum(["manifest", "manifest_multi", "server_derived"]),
    auth: z.object({ kind: z.enum(AUTH_KINDS), token_kind: z.string().min(1), header: z.enum(AUTH_HEADERS) }).strict(),
    api_base_path: z.string().regex(/^\/[A-Za-z0-9._/-]*$/, "api_base_path must be a leading-slash relative path"),
    lifecycle: LifecycleSchema,
    resources: z.array(NativeResourceIdSchema).min(1),
    capabilities: z.array(z.enum(PROVIDER_CAPABILITIES)).min(1),
    // Free-form lower_snake_case items — this is a TRUTHFULNESS field, and constraining it to an enum would tempt an author to drop
    // an inconvenient gap rather than name it.
    not_yet_available: z.array(z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/)).default([]),
    entrypoints: z.array(NativeEntrypointSchema).min(1),
    // Budget is referenced BY NAME, never duplicated numerically: runtime code stays authoritative and cannot drift from a copy.
    budget_profile: z
      .object({ name: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/, "budget_profile.name must be an UPPER_SNAKE_CASE runtime constant"), source: z.string().min(1).max(200) })
      .strict(),
    rate_limit: z.object({ rps: z.number().positive(), burst: z.number().int().positive() }).strict(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.base_url_source === "manifest") {
      ctx.addIssue({ code: "custom", path: ["base_url_source"], message: "a native_connector with a manifest-constant base URL should use the executor-program manifest kind" });
    }
    // `manifest_multi` must EARN its exemption: the provider needs a host allowlist naming at least two hosts. Without this,
    // any single-host provider could declare `manifest_multi` and walk past the check directly above, which is the whole
    // reason that check exists. An unlisted provider fails here too — a native connector cannot reach an unallowlisted host.
    if (m.base_url_source === "manifest_multi") {
      const hosts = Object.prototype.hasOwnProperty.call(PROVIDER_HOST_ALLOWLIST, m.provider_id) ? PROVIDER_HOST_ALLOWLIST[m.provider_id] : undefined;
      if (!hosts) ctx.addIssue({ code: "custom", path: ["provider_id"], message: `no host allowlist for provider '${m.provider_id}'` });
      else if (hosts.length < 2) ctx.addIssue({ code: "custom", path: ["base_url_source"], message: `provider '${m.provider_id}' allowlists ${hosts.length} host(s); manifest_multi requires at least 2` });
    }
    // A read_only provider must not declare a persisting entrypoint for a resource it does not declare, and must declare no
    // capability outside the read/ingest verb set (the enum already guarantees the latter).
    const declared = new Set(m.resources);
    for (const e of m.entrypoints) {
      for (const r of e.resources) {
        if (!declared.has(r)) ctx.addIssue({ code: "custom", path: ["entrypoints"], message: `entrypoint '${e.task_file}' references undeclared resource '${r}'` });
      }
    }
    // Every declared resource must be reachable by BOTH an aggregate and a persist entrypoint, or the declaration overstates what
    // is implemented. (Many-to-one is allowed: one entrypoint may serve several resources.)
    for (const r of m.resources) {
      const roles = new Set(m.entrypoints.filter((e) => e.resources.includes(r)).map((e) => e.role));
      if (!roles.has("aggregate")) ctx.addIssue({ code: "custom", path: ["resources"], message: `resource '${r}' has no aggregate entrypoint` });
      if (!roles.has("persist")) ctx.addIssue({ code: "custom", path: ["resources"], message: `resource '${r}' has no persist entrypoint` });
    }
    if (m.lifecycle.access_mode === "read_only" && m.auth.header !== "bearer" && m.auth.header !== "api_key_header") {
      ctx.addIssue({ code: "custom", path: ["auth", "header"], message: "unsupported auth header" });
    }
  });

export type NativeConnectorManifest = z.infer<typeof NativeConnectorManifestSchema>;

// The EXECUTOR-PROGRAM manifest — the original shape, unchanged. `manifest_kind` is OPTIONAL here and defaults to
// "executor_program", so every existing manifest (slack.v1.json and friends) validates BYTE-UNCHANGED.
export const ExecutorProgramManifestSchema = z
  .object({
    manifest_version: z.literal(1),
    manifest_kind: z.literal("executor_program").optional().default("executor_program"),
    provider_id: z.string().min(1),
    auth: z.object({ kind: z.enum(AUTH_KINDS), token_kind: z.string().min(1), header: z.enum(AUTH_HEADERS) }).strict(),
    base_url: z.string().min(1),
    rate_limit: z.object({ rps: z.number().positive(), burst: z.number().int().positive() }).strict(),
    budget: z.object({ max_requests: z.number().int().positive(), max_items: z.number().int().positive(), max_wallclock_s: z.number().int().positive() }).strict(),
    endpoints: z.array(EndpointSchema).min(1),
    // Optional so existing manifests are unaffected; when present it is validated exactly as for a native connector.
    lifecycle: LifecycleSchema.optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    let url: URL | null = null;
    try { url = new URL(m.base_url); } catch { ctx.addIssue({ code: "custom", path: ["base_url"], message: "base_url must be a valid absolute URL" }); }
    if (url) {
      if (url.protocol !== "https:") ctx.addIssue({ code: "custom", path: ["base_url"], message: "base_url must be https" });
      // OWN-property lookup only — an inherited key (`constructor`, `__proto__`, `toString`, …) must NOT resolve to an
      // Object.prototype internal (which would be a non-array → `.includes` TypeError, or a truthy non-allowlist). Fail closed.
      const allowed = Object.prototype.hasOwnProperty.call(PROVIDER_HOST_ALLOWLIST, m.provider_id) ? PROVIDER_HOST_ALLOWLIST[m.provider_id] : undefined;
      if (!allowed) ctx.addIssue({ code: "custom", path: ["provider_id"], message: `no host allowlist for provider '${m.provider_id}'` });
      else if (!allowed.includes(url.hostname)) ctx.addIssue({ code: "custom", path: ["base_url"], message: `base_url host '${url.hostname}' is not allowlisted for '${m.provider_id}'` });
    }
  });

export type ExecutorProgramManifest = z.infer<typeof ExecutorProgramManifestSchema>;

// THE neutral manifest contract — a union over the two kinds. Native is tried first because it pins `manifest_kind` to a literal, so
// an executor-program manifest falls through to the second branch immediately.
//
// BACKWARD COMPATIBILITY is the load-bearing property: `manifest_kind` is optional on the executor branch and defaults to
// "executor_program", so every pre-O1C.1 manifest (slack.v1.json and friends) validates BYTE-UNCHANGED with no field added.
//
// A plain union rather than z.discriminatedUnion: the discriminator is optional on one branch, and both branches carry superRefine
// (so they are not bare ZodObjects). The only cost is that a MALFORMED manifest reports issues from both branches;
// manifest-validate.ts merely formats issue messages, so nothing depends on branch-specific error shapes.
export const ProviderManifestSchema = z.union([NativeConnectorManifestSchema, ExecutorProgramManifestSchema]);

export type ProviderManifest = z.infer<typeof ProviderManifestSchema>;

// Narrowing helper so callers do not re-test the discriminator by hand.
export function isNativeConnectorManifest(m: ProviderManifest): m is NativeConnectorManifest {
  return (m as { manifest_kind?: string }).manifest_kind === "native_connector";
}
