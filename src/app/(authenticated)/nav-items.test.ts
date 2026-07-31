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

  it("marks the unbuilt old-app areas as not built (href null)", () => {
    const byLabel = Object.fromEntries(
      NAV_SECTIONS.flatMap((s) => s.items).map((i) => [i.label, i.href]),
    );
    for (const label of [
      "AI / Analysis",
      "Identity matching", // read-only match STATUS is on /people; the resolution workflow is not built
    ]) {
      expect(byLabel[label]).toBeNull();
    }
  });

  it("links the implemented areas", () => {
    const byLabel = Object.fromEntries(
      NAV_SECTIONS.flatMap((s) => s.items).map((i) => [i.label, i.href]),
    );
    expect(byLabel["Home"]).toBe("/");
    expect(byLabel["Apps"]).toBe("/apps");
    expect(byLabel["Contracts"]).toBe("/contracts");
    expect(byLabel["People / Users"]).toBe("/people");
    expect(byLabel["Reports"]).toBe("/reports");
    expect(byLabel["Audit / Logs"]).toBe("/audit");
    expect(byLabel["Admin / Settings"]).toBe("/admin");
    expect(byLabel["Files / Documents"]).toBe("/files");
    expect(byLabel["Dashboards"]).toBe("/dashboards");
    expect(byLabel["Connectors"]).toBe("/connectors");
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
    for (const need of ["/connectors", "/access", "/apps", "/audit"]) {
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
