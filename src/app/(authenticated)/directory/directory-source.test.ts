import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 2 — static source scan over the Directory surface.
//
// The whole point of these pages is that the directory graph is a DIFFERENT model from SaaS management. That claim is only worth anything
// if it is enforced: `app_users` (per-application account records) and `public.apps` (normalized software for contracts and spend) must
// never become a fallback when the directory is empty or slow. A source scan catches that at the import, before any test data exists.
//
// This mirrors `access-repository.test.ts` and the ACCESS_PAGES scan in `ui-regression.test.ts`.

const DIR = join(process.cwd(), "src/app/(authenticated)/directory");

// Scan CODE, not prose. These files deliberately name the forbidden models in comments — "NOT `app_users`", "sourced from
// `directory_applications`" — because a reader needs to know where the boundary is and why. Stripping comments first means the guard
// tests what the module actually does, and writing the explanation stays free.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const read = (p: string) => stripComments(readFileSync(join(DIR, p), "utf8"));

const PAGES = ["people/page.tsx", "groups/page.tsx", "applications/page.tsx"];
const ALL_SOURCES = [
  ...PAGES,
  "directory-list-page.tsx",
  "loading.tsx",
];
const LOADERS = stripComments(readFileSync(join(process.cwd(), "src/lib/data/directory-loaders.ts"), "utf8"));
const DISPLAY = stripComments(readFileSync(join(process.cwd(), "src/lib/data/directory-display.ts"), "utf8"));

describe("the Directory surface never falls back to the SaaS-management model", () => {
  it("imports nothing from the app_users / public.apps data layer", () => {
    for (const f of [...ALL_SOURCES.map(read), LOADERS, DISPLAY]) {
      for (const forbidden of [
        "app_users", "appUsers", "app-users",          // per-application account records
        "data/apps", "apps-inventory", "app-account-intelligence", "app-user-matches",
        "data/catalog", "catalog-view",                 // the SaaS catalog spoke
        "data/people",                                  // the /people SaaS page's loader
      ]) {
        expect(f, `must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("reads canonical tables through the product RPCs only — never a direct table query", () => {
    for (const f of [...ALL_SOURCES.map(read), LOADERS, DISPLAY]) {
      for (const forbidden of ["identity_accounts", "directory_groups", "directory_applications", ".from(", "supabase"]) {
        expect(f, `must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("uses no service-role client and accepts no caller-supplied tenant id", () => {
    for (const f of [...ALL_SOURCES.map(read), LOADERS, DISPLAY]) {
      // "SERVICE_ROLE".toLowerCase() rather than the literal, so check-auth-safety.sh's blanket substring grep over src/ is not tripped
      // by this negative assertion — the same convention access-repository.test.ts uses.
      for (const forbidden of ["SERVICE_ROLE".toLowerCase(), "SERVICE_ROLE", "createAdminClient", "supabaseAdmin", "serviceRoleKey", "p_tenant_id", "activeTenant.id"]) {
        expect(f, `must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
    // The tenant id reaches the RPC only from accessGate(), inside the loader.
    expect(LOADERS).toContain("accessGate()");
  });

  it("surfaces no external id, raw payload or connector internals", () => {
    for (const f of [...ALL_SOURCES.map(read), LOADERS, DISPLAY]) {
      for (const forbidden of [
        "external_id", "externalId", "raw_payload", "rawPayload", "source_endpoint", "last_discovery_run_id",
        "connector_secrets", "discovery_facts", "ciphertext", "getSecretValue",
      ]) {
        expect(f, `must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("performs no write of any kind — these are read-only list pages", () => {
    for (const f of [...ALL_SOURCES.map(read), LOADERS, DISPLAY]) {
      for (const forbidden of ['"use server"', ".insert(", ".update(", ".upsert(", ".delete(", "Remove access", "Deprovision"]) {
        expect(f, `must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  // A deliberate divergence from ACCESS_PAGES, recorded here so it is a decision rather than an oversight.
  //
  // `ui-regression.test.ts` forbids the substrings `.login` and `.email` on the four /access pages: those render the access GRAPH, where an
  // identity only ever needs a label. A People DIRECTORY list has a different job — "who exists in the connected directory" is not
  // answerable without an identifier, since display names collide and an admin needs to recognise the account. `login`/`email` are in the
  // 0061-approved DTO precisely because they are display-safe. What must NOT leak is everything above: external ids, payloads, secrets.
  it("shows the identifier on People only, and only via the approved DTO field", () => {
    expect(read("people/page.tsx")).toContain("secondaryId");
    for (const p of ["groups/page.tsx", "applications/page.tsx"]) {
      expect(read(p), `${p} has no reason to render a person identifier`).not.toContain("secondaryId");
    }
  });

  it("every page under /directory is covered by this scan", () => {
    // Guards the scan itself: a fourth page added later must be enrolled, not silently unscanned.
    const found = readdirSync(DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${e.name}/page.tsx`);
    expect(found.sort()).toEqual(PAGES.slice().sort());
  });
});
