import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as validateModule from "./manifest-validate";
import { validateManifestObject, validateManifestsDir, MANIFESTS_DIR } from "./manifest-validate";

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
