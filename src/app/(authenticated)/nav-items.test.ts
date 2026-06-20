import { describe, it, expect } from "vitest";
import { NAV_SECTIONS, IMPLEMENTED_ROUTES, isNavActive } from "./nav-items";

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
      "Dashboards",
      "Connectors",
      "AI / Analysis",
      "Files / Documents",
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
  });

  it("every enabled nav item maps to an implemented route (no enabled item points at an unbuilt area)", () => {
    for (const item of NAV_SECTIONS.flatMap((s) => s.items)) {
      if (item.href !== null) expect(IMPLEMENTED_ROUTES).toContain(item.href);
    }
  });
});
