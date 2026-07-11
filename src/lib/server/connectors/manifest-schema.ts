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
export const EMIT_FACT_TYPES = ["none", "app_user_account", "app_discovery", "app_instance_identity", "group", "group_membership"] as const;

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

export const ProviderManifestSchema = z
  .object({
    manifest_version: z.literal(1),
    provider_id: z.string().min(1),
    auth: z.object({ kind: z.enum(AUTH_KINDS), token_kind: z.string().min(1), header: z.enum(AUTH_HEADERS) }).strict(),
    base_url: z.string().min(1),
    rate_limit: z.object({ rps: z.number().positive(), burst: z.number().int().positive() }).strict(),
    budget: z.object({ max_requests: z.number().int().positive(), max_items: z.number().int().positive(), max_wallclock_s: z.number().int().positive() }).strict(),
    endpoints: z.array(EndpointSchema).min(1),
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

export type ProviderManifest = z.infer<typeof ProviderManifestSchema>;
