import { describe, it, expect } from "vitest";
import { NAV_SECTIONS, IMPLEMENTED_ROUTES, isNavActive, visibleNavSections, DEMO_MODE } from "./nav-items";

describe("isNavActive", () => {
  it("Home is active only on exactly /", () => {
    expect(isNavActive("/", "/")).toBe(true);
    expect(isNavActive("/apps", "/")).toBe(false);
    expect(isNavActive("/contracts", "/")).toBe(false);
  });

  it("a route is active on itself and its sub-routes (prefix match)", () => {
    expect(isNavActive("/apps", "/apps")).toBe(true);
    expect(isNavActive("/apps/123", "/apps")).toBe(true);
    expect(isNavActive("/contracts/new", "/contracts")).toBe(true);
    expect(isNavActive("/contracts/abc/edit", "/contracts")).toBe(true);
  });

  it("does not cross-match unrelated routes (no false prefix)", () => {
    expect(isNavActive("/contracts", "/apps")).toBe(false);
    expect(isNavActive("/apps-archive", "/apps")).toBe(false); // not a sub-route of /apps
  });
});

describe("NAV_SECTIONS", () => {
  it("only links routes that actually exist (no unbuilt area is ever linkable)", () => {
    const linked = NAV_SECTIONS.flatMap((s) => s.items)
      .map((i) => i.href)
      .filter((h): h is string => h !== null);
    for (const href of linked) {
      expect(IMPLEMENTED_ROUTES).toContain(href);
    }
  });

  it("carries no speculative unbuilt placeholders", () => {
    // Phase 1 DELETED the "AI / Analysis" and "Identity matching" dead entries rather than restyling them. A nav item
    // for a thing nobody has committed to build is a roadmap promise rendered as product, and it survived this long
    // only because the filter hid it in demo mode. Nothing in the nav may be unlinkable now.
    const items = NAV_SECTIONS.flatMap((s) => s.items);
    expect(items.map((i) => i.label)).not.toContain("AI / Analysis");
    expect(items.map((i) => i.label)).not.toContain("Identity matching");
    expect(items.filter((i) => i.href === null)).toEqual([]);
  });

  it("links the implemented areas", () => {
    const byLabel = Object.fromEntries(
      NAV_SECTIONS.flatMap((s) => s.items).map((i) => [i.label, i.href]),
    );
    expect(byLabel["Home"]).toBe("/");
    expect(byLabel["Contracts"]).toBe("/contracts");
    expect(byLabel["Reports"]).toBe("/reports");
    expect(byLabel["Audit / Logs"]).toBe("/audit");
    expect(byLabel["Admin / Settings"]).toBe("/admin");
    expect(byLabel["Files / Documents"]).toBe("/files");
    expect(byLabel["Connectors"]).toBe("/connectors");
  });

  // ── Identity-first information architecture (Phase 1) ─────────────────────────────────────────────────────
  // These are the load-bearing assertions of the restructure. Each one fails if the IA silently reverts.
  const titles = () => NAV_SECTIONS.map((s) => s.title);

  it("puts Directory and Access governance BEFORE SaaS intelligence", () => {
    const t = titles();
    expect(t).toContain("Directory");
    expect(t).toContain("Access governance");
    expect(t).toContain("SaaS intelligence");
    expect(t.indexOf("Directory")).toBeLessThan(t.indexOf("SaaS intelligence"));
    expect(t.indexOf("Access governance")).toBeLessThan(t.indexOf("SaaS intelligence"));
  });

  it("gives Directory its own first-class section with the three identity objects", () => {
    const dir = NAV_SECTIONS.find((s) => s.title === "Directory");
    expect(dir?.items.map((i) => i.label)).toEqual(["People", "Groups", "Applications"]);
    // Real routes, not disabled labels — a section of dead entries is not a section.
    for (const i of dir!.items) expect(IMPLEMENTED_ROUTES).toContain(i.href!);
  });

  it("keeps EVERY pre-existing SaaS route reachable after the restructure", () => {
    // The restructure moved the SaaS layer down; it must not have dropped any of it. /people in particular was a
    // top-level item and is now "App accounts" under SaaS intelligence — same route, clearer name.
    const hrefs = NAV_SECTIONS.flatMap((s) => s.items).map((i) => i.href);
    for (const need of ["/apps", "/catalog", "/contracts", "/files", "/people", "/dashboards"]) {
      expect(hrefs, `${need} must still be reachable`).toContain(need);
    }
  });

  it("does not use the word People for two different things", () => {
    // Directory People = identities from the IdP. /people = per-app account records. Sharing a label made the two
    // data models look like one, which is the misreading this phase exists to fix.
    const peopleLabelled = NAV_SECTIONS.flatMap((s) => s.items).filter((i) => i.label === "People");
    expect(peopleLabelled).toHaveLength(1);
    expect(peopleLabelled[0].href).toBe("/directory/people");
  });

  it("every enabled nav item maps to an implemented route (no enabled item points at an unbuilt area)", () => {
    for (const item of NAV_SECTIONS.flatMap((s) => s.items)) {
      if (item.href !== null) expect(IMPLEMENTED_ROUTES).toContain(item.href);
    }
  });
});

// ── Demo presentation filter ────────────────────────────────────────────────────────────────────────────────
// The filter exists to keep "Not built yet" off a projector, NOT to change what the product is. These assert the
// honest default is untouched and that hiding is opt-in.
describe("visibleNavSections", () => {
  it("is the IDENTITY function when demo mode is off", () => {
    expect(visibleNavSections(NAV_SECTIONS, false)).toEqual(NAV_SECTIONS);
  });

  it("defaults to off, so the honest nav is what ships", () => {
    expect(DEMO_MODE).toBe(false);
  });

  it("hides unbuilt items and /people in demo mode, and empties no section by accident", () => {
    const shown = visibleNavSections(NAV_SECTIONS, true);
    const items = shown.flatMap((s) => s.items);
    expect(items.every((i) => i.href !== null), "no unbuilt item may survive").toBe(true);
    expect(items.some((i) => i.href === "/people"), "/people is hidden for the demo").toBe(false);
    expect(shown.every((s) => s.items.length > 0), "a section emptied by filtering must be dropped").toBe(true);
  });

  it("keeps every screen the demo actually visits", () => {
    const hrefs = visibleNavSections(NAV_SECTIONS, true).flatMap((s) => s.items).map((i) => i.href);
    for (const need of ["/connectors", "/access", "/apps", "/audit", "/directory/people"]) {
      expect(hrefs, `${need} must remain reachable`).toContain(need);
    }
  });

  it("hides NOTHING that is implemented except the explicitly listed route", () => {
    // Guards against the filter quietly growing: if a future edit hides more, this fails and forces the decision
    // to be made deliberately rather than in passing.
    const before = NAV_SECTIONS.flatMap((s) => s.items).filter((i) => i.href !== null).map((i) => i.href);
    const after = visibleNavSections(NAV_SECTIONS, true).flatMap((s) => s.items).map((i) => i.href);
    expect(before.filter((h) => !after.includes(h))).toEqual(["/people"]);
  });
});
