// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SkeletonBlock, SkeletonCard, SkeletonGrid, SkeletonTable, PageSkeleton } from "./skeleton";

afterEach(cleanup);

describe("skeleton components", () => {
  it("render without data or crashing", () => {
    expect(render(<SkeletonBlock />).container.firstChild).toBeTruthy();
    cleanup();
    expect(render(<SkeletonCard />).container.firstChild).toBeTruthy();
    cleanup();
    expect(render(<SkeletonGrid count={3} />).container.firstChild).toBeTruthy();
    cleanup();
    expect(render(<SkeletonTable rows={2} cols={3} />).container.firstChild).toBeTruthy();
  });

  it("PageSkeleton exposes a visible-to-screen-reader Loading status, with no data/ids/secrets", () => {
    render(<PageSkeleton cards={4} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();

    const { container } = render(<PageSkeleton cards={5} table />);
    for (const forbidden of ["connector_secrets", "discovery_facts", "fact_json", "token", "secret", "tenant_id"]) {
      expect(container.textContent?.toLowerCase()).not.toContain(forbidden);
    }
    expect(container.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });
});

describe("route loading.tsx files are static (source scan)", () => {
  const ROUTES = ["dashboards", "apps", "contracts", "files", "people", "connectors", "audit", "needs-attention"];
  const SRC = join(process.cwd(), "src");

  it("import no data/DB, run no fetch/await, and contain no secret/tenant fields", () => {
    const files = [
      join(SRC, "components/skeleton.tsx"),
      ...ROUTES.map((r) => join(SRC, "app/(authenticated)", r, "loading.tsx")),
    ];
    for (const f of files) {
      // strip line comments so prose like `no "use client"` in a doc comment doesn't false-positive
      const src = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
      for (const bad of ["@/lib/data", "@/lib/supabase", "createClient", "fetch(", "await ", "use client", "connector_secrets", "discovery_facts", "fact_json", "tenant_id"]) {
        expect(src.includes(bad), `${f} must not contain ${bad}`).toBe(false);
      }
      if (f.endsWith("loading.tsx")) {
        expect(src).toContain("export default function Loading()");
        expect(src).toContain("PageSkeleton");
      }
    }
  });
});
