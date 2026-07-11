import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as validateModule from "./manifest-validate";
import { validateManifestObject, validateManifestsDir, MANIFESTS_DIR } from "./manifest-validate";
import { PROVIDER_HOST_ALLOWLIST } from "./manifest-schema";
import { parseDiscoveryFact } from "../connector-vault/discovery-facts";

// Phase 1a — pure contract/config validation. INERT: no fetch, no DB, no token, no sync.
type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => v as Obj;
const slack: Obj = JSON.parse(readFileSync(join(MANIFESTS_DIR, "slack.v1.json"), "utf8"));
const base = (): Obj => JSON.parse(JSON.stringify(slack)); // fresh deep clone per case
const eps = (m: Obj): Obj[] => m.endpoints as Obj[];
const users = (m: Obj): Obj => eps(m).find((e) => e.id === "users.list") as Obj;
const errs = (r: ReturnType<typeof validateManifestObject>): string[] => (r.ok ? [] : r.errors);

describe("connector manifest contract (Phase 1a — INERT)", () => {
  it("the shipped Slack v1 manifest is VALID", () => {
    const r = validateManifestObject(slack, "slack.v1.json");
    expect(errs(r).join("; ")).toBe("");
    expect(r.ok).toBe(true);
  });

  it("every manifest in the reviewed dir validates (the CI gate)", () => {
    const { ok, results } = validateManifestsDir();
    const bad = Object.entries(results).filter(([, r]) => !r.ok).map(([f, r]) => `${f}: ${errs(r).join("; ")}`);
    expect(bad).toEqual([]);
    expect(ok).toBe(true);
  });

  it("unknown keys are rejected (strict — top level and endpoint level)", () => {
    const m = base(); m.surprise = 1;
    expect(validateManifestObject(m, "x").ok).toBe(false);
    const m2 = base(); eps(m2)[0].surprise = 1;
    expect(validateManifestObject(m2, "x").ok).toBe(false);
  });

  it("a non-GET method (POST) is rejected", () => {
    const m = base(); eps(m)[0].method = "POST";
    expect(validateManifestObject(m, "x").ok).toBe(false);
  });

  it("an unsupported auth kind / header is rejected", () => {
    const m = base(); asObj(m.auth).kind = "basic";
    expect(validateManifestObject(m, "x").ok).toBe(false);
    const m2 = base(); asObj(m2.auth).header = "cookie";
    expect(validateManifestObject(m2, "x").ok).toBe(false);
  });

  it("secret-shaped strings anywhere are rejected (a manifest must carry no credential)", () => {
    const m = base(); eps(m)[0].query = { token: "xoxb-not-a-real-token-EXAMPLE" };
    const r = validateManifestObject(m, "x");
    expect(r.ok).toBe(false);
    expect(errs(r).join(" ")).toMatch(/secret-shaped/);
  });

  it("missing budget / caps are rejected", () => {
    const m1 = base(); delete m1.budget;
    expect(validateManifestObject(m1, "x").ok).toBe(false);
    const m2 = base(); delete asObj(m2.budget).max_wallclock_s;
    expect(validateManifestObject(m2, "x").ok).toBe(false);
    const m3 = base(); delete asObj(users(m3).pagination).max_pages; // a paginated endpoint must cap pages
    expect(validateManifestObject(m3, "x").ok).toBe(false);
  });

  it("field_map expressions / non-dot-paths are rejected", () => {
    for (const bad of ["a + b", "foo(bar)", "${secret}", "a.b; drop", "profile['email']", "a || b", "a.b.", ".a"]) {
      const m = base(); asObj(users(m).field_map).display_name = bad;
      expect(validateManifestObject(m, `x:${bad}`).ok, `expected reject for '${bad}'`).toBe(false);
    }
    // sanity: legit dot-paths + a single !negation still pass
    const ok = base(); asObj(users(ok).field_map).display_name = "profile.real_name"; asObj(users(ok).field_map).is_active = "!deleted";
    expect(validateManifestObject(ok, "x").ok).toBe(true);
  });

  it("an emitting endpoint must declare item_schema_ref + field_map + pagination", () => {
    const m1 = base(); delete users(m1).item_schema_ref;
    expect(validateManifestObject(m1, "x").ok).toBe(false);
    const m2 = base(); delete users(m2).field_map;
    expect(validateManifestObject(m2, "x").ok).toBe(false);
    const m3 = base(); delete users(m3).pagination;
    expect(validateManifestObject(m3, "x").ok).toBe(false);
  });

  it("base_url must be https and host-allowlisted for the provider", () => {
    const m1 = base(); m1.base_url = "https://evil.example.com/api";
    expect(validateManifestObject(m1, "x").ok).toBe(false);
    const m2 = base(); m2.base_url = "http://slack.com/api"; // not https
    expect(validateManifestObject(m2, "x").ok).toBe(false);
  });

  it("an unknown / unsupported provider_id is rejected", () => {
    const m = base(); m.provider_id = "not_a_provider";
    expect(validateManifestObject(m, "x").ok).toBe(false);
  });

  it("emitting a standalone 'group' fact is now ACCEPTED (PR #252 added the group fact; docs/54 §7)", () => {
    const m = base(); users(m).emits = "group"; // users.list already has item_schema_ref + field_map + pagination
    expect(validateManifestObject(m, "x").ok).toBe(true);
  });

  it("the shipped Slack manifest now includes usergroups.list emitting a group (valid)", () => {
    const r = validateManifestObject(slack, "slack.v1.json");
    expect(r.ok).toBe(true);
    const ug = eps(slack).find((e) => e.id === "usergroups.list");
    expect(ug).toBeDefined();
    expect(ug!.emits).toBe("group");
    expect(ug!.method).toBe("GET");
    expect((ug!.pagination as Obj).style).toBe("none");
    expect((ug!.field_map as Obj).is_active).toBe("!date_delete"); // the allowlisted ! negation
  });

  it("a group-emitting endpoint still fails without item_schema_ref / field_map / pagination", () => {
    const m1 = base(); const ep1 = eps(m1).find((e) => e.id === "usergroups.list") as Obj; ep1.emits = "group"; delete ep1.item_schema_ref;
    expect(validateManifestObject(m1, "x").ok).toBe(false);
    const m2 = base(); const ep2 = eps(m2).find((e) => e.id === "usergroups.list") as Obj; delete ep2.field_map;
    expect(validateManifestObject(m2, "x").ok).toBe(false);
    const m3 = base(); const ep3 = eps(m3).find((e) => e.id === "usergroups.list") as Obj; delete ep3.pagination;
    expect(validateManifestObject(m3, "x").ok).toBe(false);
  });

  it("NO runtime/tenant/env/remote manifest loader is exported — manifests are image-baked, reviewed-only", () => {
    const exported = Object.keys(validateModule).sort();
    expect(exported.some((k) => /env|tenant|\bdb\b|remote|fetch|runtime|fromstring|fromurl/i.test(k))).toBe(false);
    expect(exported).toEqual(["MANIFESTS_DIR", "validateManifestObject", "validateManifestsDir"]);
  });
});

// Catch the class of bug where a manifest's field_map maps to a fact field that does NOT exist on the emitted fact type
// (the executor would fail closed at runtime; this catches it at manifest-review time). A key is "recognized" iff adding it
// to a minimal fact of that type does NOT produce a zod `unrecognized_keys` issue naming it.
describe("field_map keys must be valid fields of the emitted fact type (cross-check vs discovery-facts)", () => {
  const baseFact = {
    schema_version: 1, signal_id: "s", tenant_id: "t", source_type: "identity_provider_discovery",
    source_provider: "slack", observed_at: "2026-01-01T00:00:00Z", confidence: 0.9,
  };
  const keyRecognized = (factType: string, key: string): boolean => {
    const r = parseDiscoveryFact({ ...baseFact, fact_type: factType, [key]: "x" });
    if (r.success) return true;
    return !r.error.issues.some((i) => i.code === "unrecognized_keys" && (i.keys ?? []).includes(key));
  };

  it("self-check: a bogus field is NOT recognized; a real field IS", () => {
    expect(keyRecognized("app_user_account", "not_a_real_field")).toBe(false);
    expect(keyRecognized("app_user_account", "email")).toBe(true);
    expect(keyRecognized("group", "group_name")).toBe(true);
    // regression guard for the exact bug fixed here:
    expect(keyRecognized("app_user_account", "is_active")).toBe(false);
    expect(keyRecognized("app_user_account", "usage_source_ts")).toBe(false);
  });

  it("every field_map key in every shipped manifest is a valid field of its emitted fact type", () => {
    const bad: string[] = [];
    for (const ep of (slack.endpoints as Obj[])) {
      const emits = ep.emits as string;
      const fm = ep.field_map as Record<string, string> | undefined;
      if (emits === "none" || !fm) continue;
      for (const key of Object.keys(fm)) if (!keyRecognized(emits, key)) bad.push(`${ep.id}: '${key}' is not a field of '${emits}'`);
    }
    expect(bad).toEqual([]);
  });
});

describe("scim_fixture host allowlist (P5A.1) — exact synthetic non-routable host, fail-closed", () => {
  // A structurally-valid manifest under the scim_fixture provider (reuses the Slack manifest shape; only provider_id +
  // base_url matter for the host-allowlist gate this test exercises — SCIM endpoints/schemas are a later phase).
  const scim = (): Obj => { const m = base(); m.provider_id = "scim_fixture"; m.base_url = "https://scim.fixture.invalid/scim/v2"; return m; };

  it("accepts the EXACT synthetic host (supported provider + https + allowlisted host)", () => {
    expect(validateManifestObject(scim(), "scim").ok).toBe(true);
  });
  it("rejects a lookalike subdomain of the fixture host (exact match only)", () => {
    const m = scim(); m.base_url = "https://evil.scim.fixture.invalid/scim/v2";
    expect(validateManifestObject(m, "scim").ok).toBe(false);
  });
  it("rejects a suffix-confusion host (fixture host as a prefix of a longer domain)", () => {
    const m = scim(); m.base_url = "https://scim.fixture.invalid.evil.example/scim/v2";
    expect(validateManifestObject(m, "scim").ok).toBe(false);
  });
  it("rejects HTTP where HTTPS is required, even for the allowlisted host", () => {
    const m = scim(); m.base_url = "http://scim.fixture.invalid/scim/v2";
    expect(validateManifestObject(m, "scim").ok).toBe(false);
  });
  it("rejects a host not allowlisted for scim_fixture (no cross-provider host reuse)", () => {
    const m = scim(); m.base_url = "https://slack.com/api"; // slack's host, but under scim_fixture
    expect(validateManifestObject(m, "scim").ok).toBe(false);
  });
  it("the allowlist is exact per-provider with NO wildcard/localhost/IP, and Slack's entry is unchanged", () => {
    expect(PROVIDER_HOST_ALLOWLIST.scim_fixture).toEqual(["scim.fixture.invalid"]); // exactly one, reserved .invalid TLD
    expect(PROVIDER_HOST_ALLOWLIST.slack).toEqual(["slack.com"]); // unchanged
    for (const hosts of Object.values(PROVIDER_HOST_ALLOWLIST)) {
      for (const h of hosts) {
        expect(h).not.toContain("*"); // no wildcard
        expect(h).not.toMatch(/^\.|localhost|^\d+\.\d+\.\d+\.\d+$/); // no leading-dot suffix, localhost, or bare IP
      }
    }
  });
});

// P5E0.1 — the `link` pagination style gains ONE required, bounded `next_path` field: a conservative dotted PROPERTY
// REFERENCE (e.g. Microsoft Graph `@odata.nextLink`) that IDENTIFIES the response field holding an opaque continuation URL.
// It is DATA ONLY — no expression/JSONPath/URL/host/method/query/secret/prototype access, no runtime extraction added here.
describe("link pagination next_path (P5E0.1) — bounded property reference, DATA ONLY", () => {
  // Swap the emitting users.list endpoint onto a `link` pagination shape (item_schema_ref + field_map already present).
  const link = (next_path: unknown): Obj => ({ style: "link", items_path: "value", next_path, max_pages: 5 }) as Obj;
  const withLink = (next_path: unknown): Obj => { const m = base(); users(m).pagination = link(next_path); return m; };
  const okLink = (next_path: unknown): boolean => validateManifestObject(withLink(next_path), `next_path:${String(next_path)}`).ok;

  it("ACCEPTS a valid link manifest with next_path '@odata.nextLink' (the required Microsoft Graph key shape)", () => {
    const r = validateManifestObject(withLink("@odata.nextLink"), "graph");
    expect(errs(r).join("; ")).toBe("");
    expect(r.ok).toBe(true);
  });

  it("ACCEPTS other simple dotted property paths (identifies data, no @ required)", () => {
    for (const p of ["nextLink", "pagination.next", "meta.paging.next_url", "a_1.b2"]) {
      expect(okLink(p), `expected accept for '${p}'`).toBe(true);
    }
  });

  it("REJECTS a link manifest MISSING next_path (the field is required for style 'link')", () => {
    const m = base(); users(m).pagination = { style: "link", items_path: "value", max_pages: 5 };
    expect(validateManifestObject(m, "x").ok).toBe(false);
  });

  it("REJECTS non-property-path values: empty, oversized, whitespace, brackets, wildcard, recursion, slash, URL, interpolation, empty/dup segments, control chars", () => {
    const rejected: Array<[string, unknown]> = [
      ["empty string", ""],
      ["oversized (>256)", "a".repeat(257)],
      ["whitespace", "a b"],
      ["leading space", " a"],
      ["bracket index", "profile[0]"],
      ["bracket key", "profile['next']"],
      ["wildcard", "a.*"],
      ["recursive descent", "..next"],
      ["slash path", "a/b"],
      ["url", "https://x.example/next?skip=1"],
      ["protocol-relative url", "//x.example/next"],
      ["env interpolation", "${NEXT}"],
      ["template", "`a`"],
      ["expression", "a + b"],
      ["function call", "next(1)"],
      ["leading dot", ".a"],
      ["trailing dot", "a."],
      ["empty/duplicate segment", "a..b"],
      ["newline control char", "a\nb"],
      ["tab control char", "a\tb"],
      ["null byte", "a" + String.fromCharCode(0) + "b"],
      ["at-only segment", "@"],
      ["double at", "@@odata"],
      ["digit-leading segment", "1a"],
      ["non-string number", 5],
      ["non-string object", { p: "x" }],
    ];
    for (const [label, val] of rejected) {
      expect(okLink(val), `expected reject for ${label}`).toBe(false);
    }
  });

  it("REJECTS prototype-pollution segments (with or without a leading @), anywhere in the path", () => {
    for (const p of ["__proto__", "constructor", "prototype", "a.__proto__", "a.constructor.b", "@__proto__", "meta.prototype"]) {
      expect(okLink(p), `expected reject for '${p}'`).toBe(false);
    }
  });

  it("REJECTS next_path supplied to a NON-link style (discriminated .strict() union forbids the extra field)", () => {
    // page style with an extra next_path
    const m1 = base(); users(m1).pagination = { style: "page", page_param: "page", items_path: "value", next_path: "@odata.nextLink", max_pages: 5 };
    expect(validateManifestObject(m1, "x").ok).toBe(false);
    // none style with an extra next_path
    const m2 = base(); users(m2).pagination = { style: "none", items_path: "value", next_path: "@odata.nextLink" };
    expect(validateManifestObject(m2, "x").ok).toBe(false);
  });

  it("REGRESSION: cursor / offset / none styles are unchanged; unknown styles still fail closed", () => {
    // Slack's shipped cursor manifest still validates (its cursor next_path is a plain string — unchanged by this PR)
    expect(validateManifestObject(slack, "slack.v1.json").ok).toBe(true);
    // an offset-style endpoint still validates (no next_path required/allowed)
    const off = base(); users(off).pagination = { style: "offset", offset_param: "startIndex", limit_param: "count", items_path: "value", max_pages: 5 };
    expect(validateManifestObject(off, "x").ok).toBe(true);
    // a cursor-style endpoint still validates (its own next_path grammar is untouched)
    const cur = base(); users(cur).pagination = { style: "cursor", cursor_param: "cursor", next_path: "response_metadata.next_cursor", items_path: "value", max_pages: 5 };
    expect(validateManifestObject(cur, "x").ok).toBe(true);
    // an unknown pagination style still fails closed
    const unk = base(); users(unk).pagination = { style: "graphql", items_path: "value", max_pages: 5 };
    expect(validateManifestObject(unk, "x").ok).toBe(false);
  });
});

// P5E2.1 — canonical host policy for Microsoft Entra directory discovery via Microsoft Graph: the EXACT global Graph host
// only. HTTPS-mandatory, exact hostname equality (the superRefine does `allowed.includes(url.hostname)`); no wildcard/
// suffix/subdomain/parent/sovereign/token host, and no cross-provider host reuse. Port enforcement is the RUNTIME P2
// boundary's job (the manifest schema gates https + exact hostname only) — unchanged here.
describe("microsoft_entra host allowlist (P5E2.1) — EXACT global Graph host only, fail closed, no cross-provider reuse", () => {
  const entra = (): Obj => { const m = base(); m.provider_id = "microsoft_entra"; m.base_url = "https://graph.microsoft.com/v1.0"; return m; };

  it("accepts the EXACT global Graph host over HTTPS", () => {
    expect(validateManifestObject(entra(), "entra").ok).toBe(true);
  });
  it("requires HTTPS even for the allowlisted host", () => {
    const m = entra(); m.base_url = "http://graph.microsoft.com/v1.0";
    expect(validateManifestObject(m, "entra").ok).toBe(false);
  });
  it("EXACT host only — trailing-dot / subdomain / suffix-confusion / lookalike / parent / token / sovereign / IP / localhost / wildcard all fail closed", () => {
    for (const host of [
      "https://graph.microsoft.com./v1.0",              // trailing dot
      "https://api.graph.microsoft.com/v1.0",           // subdomain
      "https://graph.microsoft.com.evil.example/v1.0",  // suffix confusion
      "https://evilgraph.microsoft.com/v1.0",           // lookalike prefix
      "https://microsoft.com/v1.0",                     // parent domain (no parent trust)
      "https://login.microsoftonline.com/token",        // token host — never allowlisted
      "https://graph.microsoft.us/v1.0",                // sovereign cloud — deliberately excluded
      "https://dod-graph.microsoft.us/v1.0",            // sovereign cloud
      "https://microsoftgraph.chinacloudapi.cn/v1.0",   // sovereign cloud
      "https://localhost/v1.0",
      "https://127.0.0.1/v1.0",
      "https://10.0.0.1/v1.0",                          // private IP literal
      "https://169.254.169.254/v1.0",                   // link-local metadata IP
      "https://*.microsoft.com/v1.0",                   // wildcard-like string
    ]) {
      const m = entra(); m.base_url = host;
      expect(validateManifestObject(m, `entra:${host}`).ok, host).toBe(false);
    }
  });
  it("CROSS-PROVIDER ISOLATION — no provider inherits another provider's hosts", () => {
    // microsoft_entra cannot use slack / scim hosts
    for (const h of ["https://slack.com/api", "https://scim.fixture.invalid/scim/v2"]) {
      const m = entra(); m.base_url = h;
      expect(validateManifestObject(m, `entra@${h}`).ok, h).toBe(false);
    }
    // slack + scim_fixture cannot use the Graph host
    const s = base(); s.provider_id = "slack"; s.base_url = "https://graph.microsoft.com/v1.0";
    expect(validateManifestObject(s, "slack@graph").ok).toBe(false);
    const sc = base(); sc.provider_id = "scim_fixture"; sc.base_url = "https://graph.microsoft.com/v1.0";
    expect(validateManifestObject(sc, "scim@graph").ok).toBe(false);
  });
  it("the allowlist entry is EXACTLY the one global host with NO wildcard; slack + scim_fixture entries unchanged", () => {
    expect(PROVIDER_HOST_ALLOWLIST.microsoft_entra).toEqual(["graph.microsoft.com"]);
    expect(PROVIDER_HOST_ALLOWLIST.slack).toEqual(["slack.com"]);
    expect(PROVIDER_HOST_ALLOWLIST.scim_fixture).toEqual(["scim.fixture.invalid"]);
    for (const h of PROVIDER_HOST_ALLOWLIST.microsoft_entra) {
      expect(h).not.toContain("*"); // no wildcard
      expect(h).not.toMatch(/^\.|localhost|^\d+\.\d+\.\d+\.\d+$/); // no leading-dot suffix, localhost, or bare IP
    }
  });
});

// Hardening — the host-allowlist lookup must be OWN-property only so an INHERITED provider_id (`constructor`, `__proto__`,
// `toString`, …) obtains NO allowlist and FAILS CLOSED without throwing (previously PROVIDER_HOST_ALLOWLIST["constructor"]
// resolved to the Object constructor — a non-array whose `.includes` threw a TypeError during validation).
describe("host allowlist fails closed for INHERITED provider_ids (no crash, no prototype leakage)", () => {
  const INHERITED = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "prototype", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"];

  it("no inherited key is an OWN entry of PROVIDER_HOST_ALLOWLIST; own entries unchanged", () => {
    for (const k of INHERITED) expect(Object.prototype.hasOwnProperty.call(PROVIDER_HOST_ALLOWLIST, k), k).toBe(false);
    expect(PROVIDER_HOST_ALLOWLIST.microsoft_entra).toEqual(["graph.microsoft.com"]);
    expect(PROVIDER_HOST_ALLOWLIST.slack).toEqual(["slack.com"]);
    expect(PROVIDER_HOST_ALLOWLIST.scim_fixture).toEqual(["scim.fixture.invalid"]);
  });

  it("a manifest with an inherited provider_id fails validation WITHOUT throwing (no inherited object treated as config)", () => {
    for (const pid of INHERITED) {
      const m = base(); m.provider_id = pid; m.base_url = "https://graph.microsoft.com/v1.0"; // otherwise-valid https URL
      let r: ReturnType<typeof validateManifestObject> | undefined;
      expect(() => { r = validateManifestObject(m, `inherited:${pid}`); }, pid).not.toThrow();
      expect(r!.ok, pid).toBe(false); // fail closed: no allowlist + unsupported provider
    }
  });

  it("REGRESSION: real providers still validate against their exact host; unknown normal strings still fail closed", () => {
    expect(validateManifestObject(slack, "slack.v1.json").ok).toBe(true);
    const e = base(); e.provider_id = "microsoft_entra"; e.base_url = "https://graph.microsoft.com/v1.0";
    expect(validateManifestObject(e, "entra").ok).toBe(true);
    const u = base(); u.provider_id = "not_a_provider"; u.base_url = "https://graph.microsoft.com/v1.0";
    expect(validateManifestObject(u, "unknown").ok).toBe(false);
  });
});
