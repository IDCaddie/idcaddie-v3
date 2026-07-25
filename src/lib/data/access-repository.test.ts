import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Static-safety scan for the access-product data layer (Phase 15 Part 1 PR B). The repository is the ONLY module allowed to call an RPC,
// and it must use ONLY the user-scoped server client (RLS-governed), never a service-role/admin client, never a direct canonical-table
// query, and never a write. Comments are stripped first (the modules legitimately NAME what they avoid in prose).
const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const read = (rel: string) => strip(readFileSync(join(__dirname, rel), "utf8"));
const ACCESS_MODULES = [
  "access-repository.ts", "access-rpc-types.ts", "access-graph-assembly.ts", "access-view-models.ts", "governance-presenter.ts", "access-loaders.ts",
];

describe("access data layer — server-only, RLS-governed, read-only", () => {
  it("uses NO service-role / admin client anywhere", () => {
    for (const m of ACCESS_MODULES) {
      const code = read(m);
      // "SERVICE_ROLE".toLowerCase() rather than the literal so check-auth-safety.sh's blanket substring grep isn't tripped by this negative assertion.
      for (const f of ["SERVICE_ROLE".toLowerCase(), "SERVICE_ROLE", "createAdminClient", "supabaseAdmin", "serviceRoleKey", "runnerClient", "createRunnerConnection"]) {
        expect(code, `${m} must not reference ${f}`).not.toContain(f);
      }
    }
  });

  it("performs NO write / mutation / server action", () => {
    for (const m of ACCESS_MODULES) {
      const code = read(m);
      for (const f of ['"use server"', ".insert(", ".update(", ".upsert(", ".delete("]) {
        expect(code, `${m} must not contain ${f}`).not.toContain(f);
      }
    }
  });

  it("the repository queries NO canonical table directly (RPC-only) and imports only the user-scoped server client + trusted tenant-context", () => {
    const repo = read("access-repository.ts");
    for (const t of ['from("identity_accounts")', 'from("directory_groups")', 'from("directory_group_memberships")', 'from("directory_applications")', 'from("directory_application_user_assignments")', 'from("directory_application_group_assignments")', '.from("directory_', ".from('directory_"]) {
      expect(repo, `repository must not query ${t} directly`).not.toContain(t);
    }
    expect(repo).toContain('from "@/lib/supabase/server"');
    expect(repo).toContain('from "@/lib/auth/tenant-context"');
    expect(repo).toContain(".rpc"); // RPC is the ONLY data path (allowed here, unlike other DALs)
  });

  it("only the repository imports the server Supabase client (assembly/view-models/presenter/rpc-types stay pure)", () => {
    for (const m of ["access-graph-assembly.ts", "access-view-models.ts", "governance-presenter.ts", "access-rpc-types.ts"]) {
      expect(read(m), `${m} must be pure (no supabase server client)`).not.toContain("@/lib/supabase/server");
    }
  });

  it("never logs a raw error object or an entity id (fixed log strings only)", () => {
    const repo = read("access-repository.ts");
    // the only console.* is a fixed-prefix rpc-name string; never error.message / ${identityId} / ${tenantId}
    expect(repo).not.toMatch(/console\.\w+\([^)]*\.message/);
    expect(repo).not.toMatch(/console\.\w+\([^)]*\$\{(identityId|applicationId|tenantId|g\.tenantId)\}/);
  });
});
