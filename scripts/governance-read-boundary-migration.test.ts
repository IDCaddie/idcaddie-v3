// Static guard over migration 0085 — the canonical governance read boundary.
//
// WHY A STATIC TEST EXISTS AT ALL. `scripts/test-rls.sh` blanket-grants on every table after migrations run and then
// re-revokes a named set. That masking means a migration which handed a table grant to `connector_runner` still
// produces a GREEN SQL suite — mutation-testing confirmed exactly that here: adding
// `grant select on public.application_matcher_state to connector_runner` to 0085 did not fail the DB suite, because the
// harness revoked it again moments later. The same masking is documented for 0079 in
// `scripts/oauth-completer-migration.test.ts`; this file is that guard for 0085's three tables.
//
// The property being guarded is the whole point of the migration: 0085 opens a READ PATH onto two deny-all tables, and
// must not open the TABLES. Reading the migration text is the honest way to assert that.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync("supabase/migrations/0085_governance_canonical_read_boundary.sql", "utf8");

// Comments would otherwise satisfy a naive `toContain` and, worse, a `grant` inside one would not be flagged.
const CODE = SRC.split("\n")
  .filter(l => !l.trimStart().startsWith("--"))
  .join("\n");

const DENY_ALL_TABLES = ["person_account_links", "application_matches", "application_matcher_state"];

const FUNCTIONS = [
  "product_person_account_links",
  "product_application_matches",
  "product_application_matcher_state",
  "product_start_application_matcher_run",
  "product_complete_application_matcher_run",
  "product_fail_application_matcher_run",
];

describe("0085 — the read path must not open the table", () => {
  it.each(DENY_ALL_TABLES)("grants no table privilege on %s to any role", table => {
    // Any `grant <anything> on [table] public.<t> to ...`. The definer functions are the only read path; a table grant
    // would let PostgREST serve the rows directly, bypassing the tenant-role gate entirely.
    const grant = new RegExp(`grant\\s+[\\s\\S]{0,80}?\\son\\s+(table\\s+)?public\\.${table}\\b`, "i");
    expect(CODE).not.toMatch(grant);
  });

  it.each(DENY_ALL_TABLES)("never adds a policy to %s", table => {
    expect(CODE).not.toMatch(new RegExp(`create\\s+policy[\\s\\S]{0,200}?on\\s+public\\.${table}\\b`, "i"));
  });

  it("keeps the new table deny-all and revokes every request-path role", () => {
    expect(CODE).toMatch(/alter table public\.application_matcher_state enable row level security;/);
    expect(CODE).toMatch(
      /revoke all on public\.application_matcher_state from public, anon, authenticated, connector_runner;/,
    );
  });

  it("weakens no existing revoke", () => {
    // 0075 and 0082 revoked these; 0085 must not hand any of it back.
    expect(CODE).not.toMatch(/grant[\s\S]{0,80}?public\.person_account_links/i);
    expect(CODE).not.toMatch(/grant[\s\S]{0,80}?public\.application_matches/i);
  });
});

describe("0085 — every function is a pinned, tenant-gated definer", () => {
  // The trailing least-privilege block legitimately uses `execute format(...)` to loop the grants; it is not part of any
  // function body, so bound the slice there rather than letting the last function swallow it. The bound must be a
  // CODE line, not the section comment — `CODE` has already stripped comments, so a comment marker is never found.
  const GRANT_BLOCK = CODE.indexOf("do $$\ndeclare f text;");
  const DECLARATIONS = GRANT_BLOCK === -1 ? CODE : CODE.slice(0, GRANT_BLOCK);
  const bodyOf = (fn: string): string => {
    const start = DECLARATIONS.indexOf(`function public.${fn}(`);
    expect(start, `${fn} must exist`).toBeGreaterThan(-1);
    const next = DECLARATIONS.indexOf("create or replace function", start + 10);
    return DECLARATIONS.slice(start, next === -1 ? DECLARATIONS.length : next);
  };

  it.each(FUNCTIONS)("%s is SECURITY DEFINER with a pinned search_path", fn => {
    const body = bodyOf(fn);
    expect(body).toMatch(/security definer/);
    expect(body).toMatch(/set search_path = public/);
  });

  it.each(FUNCTIONS)("%s derives authority from has_tenant_role, never from a caller-supplied claim", fn => {
    expect(bodyOf(fn)).toMatch(/has_tenant_role\(\s*p_tenant_id,\s*array\['owner',\s*'admin'\]\s*\)/);
  });

  // Readers filter on the tenant; writers key on it. Asserted separately so each says what it actually means, and so a
  // reader silently losing its predicate cannot be excused by a writer's pattern.
  const READERS = FUNCTIONS.slice(0, 3);
  const WRITERS = FUNCTIONS.slice(3);

  it.each(READERS)("%s filters rows on the caller's tenant", fn => {
    expect(bodyOf(fn)).toMatch(/tenant_id\s*=\s*p_tenant_id/);
  });

  it.each(WRITERS)("%s writes only within the caller's tenant", fn => {
    const body = bodyOf(fn);
    expect(body).toMatch(/values\s*\(\s*p_tenant_id|where tenant_id = p_tenant_id/);
  });

  it("uses no dynamic SQL in any function body", () => {
    for (const fn of FUNCTIONS) expect(bodyOf(fn)).not.toMatch(/\bexecute\s+format\(/i);
  });

  it("grants EXECUTE to authenticated only, revoking public, anon and connector_runner", () => {
    expect(CODE).toMatch(/revoke execute on function %s from public, anon, authenticated, connector_runner/);
    expect(CODE).toMatch(/grant execute on function %s to authenticated/);
    for (const fn of FUNCTIONS) expect(CODE).toContain(`public.${fn}(`);
  });

  it("never reaches for service_role", () => {
    expect(CODE).not.toMatch(/service_role/i);
  });
});

describe("0085 — the read contract exposes no PII", () => {
  // A person link is a judgement about a human and an application match carries a reviewer's prose. The engine reasons
  // over row ids, so neither read may widen into attribution or free text.
  const FORBIDDEN = ["email", "primary_email", "full_name", "display_name", "login", "rationale", "decided_by"];

  it.each(FORBIDDEN)("does not return %s", column => {
    const returnBlocks = [...CODE.matchAll(/returns table \(([\s\S]*?)\)\s*language/g)].map(m => m[1]);
    expect(returnBlocks.length).toBeGreaterThan(0);
    for (const block of returnBlocks) expect(block).not.toContain(column);
  });
});
