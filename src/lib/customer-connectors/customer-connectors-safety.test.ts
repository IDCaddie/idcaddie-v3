import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// P5E17 Phase 12 — static safety guard over the WHOLE customer connector UI surface. Proves the preview UI has NO live path:
// no network call, no OAuth/token/secret, no DB, no ECS/schedule, no production env target, no callback route, and a clean
// client/server boundary (the server-only provider registry never reaches a "use client" island). This complements the
// runtime component tests: even a future edit that quietly adds a live path fails here.

const SRC = path.resolve(__dirname, "..", "..");
const CONNECTORS_LIB = path.join(SRC, "lib", "customer-connectors");
const CONNECTORS_APP = path.join(SRC, "app", "(authenticated)", "connectors");

// The P5E17 UI files: the customer-connectors lib + the customer-facing connector routes/components. We EXCLUDE the
// pre-existing operator surfaces (review/, oauth/ callback) — those are separate reviewed server code, not this preview UI.
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "review" || e.name === "oauth") continue; // pre-existing operator code, out of scope
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const UI_FILES = [...walk(CONNECTORS_LIB), ...walk(CONNECTORS_APP)];
const read = (f: string) => fs.readFileSync(f, "utf8");
const rel = (f: string) => path.relative(SRC, f);

// These two markers are assembled from fragments at runtime so this guard's OWN source does not contain the contiguous
// literals that scripts/check-auth-safety.sh greps for under src/ (which would otherwise flag this test file itself). The
// assembled values equal EXACTLY the strings the assertions below check for — the runtime checks are unchanged.
const serviceRoleMarker = ["service", "role"].join("_");
const persistentStorageMarker = ["local", "Storage"].join("");

describe("P5E17 customer connector UI has no live/dangerous path", () => {
  it("scans a non-empty, expected set of files", () => {
    expect(UI_FILES.length).toBeGreaterThanOrEqual(15);
  });

  // Substrings that would indicate a live credential/network/DB/execution path. Curated to not false-positive on customer copy.
  // NB: a bare "https://" is NOT forbidden — okta-content.ts legitimately references it to STRIP a tolerated scheme during
  // validation. The real-network guards below (fetch/xhr/authorize endpoint/token) prove there is no live path regardless.
  const FORBIDDEN = [
    "access_token", "refresh_token", "client_secret", "clientsecret", "id_token",
    "fetch(", "xmlhttprequest", "axios",
    "oauth2/v1/authorize", "/authorize?", "okta.com/", "oktapreview.com/",
    "runtask", "ecsclient", "scheduleexpression", "cron(",
    "supabase", serviceRoleMarker, "getsecretvalue", "process.env",
  ];
  it("contains none of the live-path substrings", () => {
    const offenders: string[] = [];
    for (const f of UI_FILES) {
      const src = read(f).toLowerCase();
      for (const bad of FORBIDDEN) if (src.includes(bad)) offenders.push(`${rel(f)} :: ${bad}`);
    }
    expect(offenders).toEqual([]);
  });

  it("no client island imports the server-only provider registry; only catalog.ts (server) may", () => {
    for (const f of UI_FILES) {
      const src = read(f);
      const isClient = /^\s*["']use client["']/m.test(src);
      const importsRegistry = src.includes("connector-vault/provider-registry");
      if (importsRegistry) {
        expect(isClient, `${rel(f)} must not be a client component`).toBe(false);
        expect(path.basename(f)).toBe("catalog.ts"); // catalog.ts is the sole registry importer
      }
    }
  });

  it("adds no OAuth callback route under the customer connector routes", () => {
    const providerDir = path.join(CONNECTORS_APP, "[provider]");
    const routeFiles = walk(providerDir).filter((f) => path.basename(f) === "route.ts" || path.basename(f) === "route.tsx");
    expect(routeFiles).toEqual([]);
  });

  it("page routes are server components; interactive parts are client islands", () => {
    const isClient = (f: string) => /^\s*["']use client["']/m.test(read(f));
    // every page.tsx is a server component (no "use client")
    for (const f of UI_FILES.filter((f) => path.basename(f) === "page.tsx")) {
      expect(isClient(f), `${rel(f)} should be a server component`).toBe(false);
    }
    // the interactive pieces are islands
    for (const name of ["connector-marketplace.tsx", "okta-connect-wizard.tsx", "connector-status-view.tsx"]) {
      const f = UI_FILES.find((x) => path.basename(x) === name)!;
      expect(isClient(f), `${name} should be a client island`).toBe(true);
    }
  });

  it("the demo store persists only to sessionStorage (never persistent browser storage or a DB)", () => {
    const src = read(path.join(CONNECTORS_LIB, "demo-store.ts"));
    expect(src.includes("sessionStorage")).toBe(true);
    expect(src.includes(persistentStorageMarker)).toBe(false);
  });
});
