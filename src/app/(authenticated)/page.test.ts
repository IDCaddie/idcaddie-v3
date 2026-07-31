import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #1: `/` is promoted to the read-only Dashboards home. The old debug/context skeleton (which rendered a
// raw tenant UUID + stale "only Apps and Contracts are implemented" copy) is gone — `/` now just redirects.
const { redirectSpy } = vi.hoisted(() => ({ redirectSpy: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

describe("authenticated root / — dashboards home", () => {
  it("redirects / to /dashboards (no skeleton rendered)", async () => {
    const mod = await import("./page");
    (mod.default as () => void)();
    expect(redirectSpy).toHaveBeenCalledWith("/dashboards");
  });

  it("no longer renders a raw tenant/org UUID or the stale 'not built' landing copy", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).not.toContain("activeTenant.id"); // the raw tenant UUID render is gone
    expect(src).not.toContain("implemented so far"); // the stale "only Apps and Contracts" copy is gone
    expect(src).not.toMatch(/Badge|not built yet|resolveTenantContext/); // the not-built badges + context read are gone
    // The landing target is now conditional, so assert BEHAVIOUR rather than a literal call. The default (shipped)
    // path must still be /dashboards; only demo mode lands on /access.
    expect(src).toContain('"/dashboards"');
    expect(src).toContain("DEMO_MODE");
  });

  it("lands on /access ONLY in demo mode; the default stays /dashboards", async () => {
    // Demo mode changes the front door, and nothing else. Both routes stay reachable either way — the risk to guard
    // against is a demo flag silently becoming the shipped default.
    const nav = await import("./nav-items");
    expect(nav.DEMO_MODE, "DEMO_MODE must default OFF so the honest nav is what ships").toBe(false);
    redirectSpy.mockClear();
    const mod = await import("./page");
    (mod.default as () => void)();
    expect(redirectSpy).toHaveBeenCalledWith("/dashboards");
  });

  it("no (authenticated) subpage Back link points at the old root '/' (they go to /dashboards)", () => {
    const dir = join(__dirname);
    const pages = [
      "apps/page.tsx", "contracts/page.tsx", "people/page.tsx", "reports/page.tsx",
      "audit/page.tsx", "admin/page.tsx", "files/page.tsx", "connectors/page.tsx",
    ];
    for (const p of pages) {
      const src = readFileSync(join(dir, p), "utf8");
      expect(src, `${p} must not Back-link to "/"`).not.toContain('<Link href="/" className="text-zinc-500');
      expect(src, `${p} must Back-link to /dashboards`).toContain('href="/dashboards" className="text-zinc-500');
    }
  });
});
