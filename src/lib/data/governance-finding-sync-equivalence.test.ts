// Phase 18E4 — migration 0091 is 0083's persistence function with ONE predicate added, and nothing else.
//
// The point of asserting this mechanically rather than by review: 0091 redefines a SECURITY DEFINER function that owns
// the entire finding lifecycle. A reviewer comparing 134 lines by eye cannot reliably prove that first_seen_at,
// reopen_count, the closure gate or the role gate survived the edit. The diff below can.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const M = "supabase/migrations";
const SRC_0083 = readFileSync(`${M}/0083_governance_finding_persistence.sql`, "utf8");
const SRC_0091 = readFileSync(`${M}/0091_governance_finding_sync_safeupdate.sql`, "utf8");
const SIGNATURE = "create or replace function public.product_sync_governance_findings(";

/** The function definition, from its CREATE through its terminating `$$;`. */
function fnBody(src: string): string {
  const start = src.indexOf(SIGNATURE);
  if (start < 0) throw new Error("function not found");
  const end = src.indexOf("$$;", start);
  if (end < 0) throw new Error("function terminator not found");
  return src.slice(start, end + 3);
}

describe("0091 replaces 0083's sync function with exactly one correction", () => {
  it("differs from 0083 by the safe-update predicate and NOTHING else", () => {
    const a = fnBody(SRC_0083).split("\n");
    const b = fnBody(SRC_0091).split("\n");
    expect(b.length).toBe(a.length);
    const changed = a.map((line, i) => [i, line, b[i]] as const).filter(([, x, y]) => x !== y);
    expect(changed).toHaveLength(1);
    const [, before, after] = changed[0];
    expect(before.trim()).toBe("delete from reported_findings;");
    expect(after.trim()).toBe("delete from reported_findings where true;");
  });

  // Each of these is a property a careless rewrite would silently drop. Asserted on 0091's own text so the migration
  // stands on its own rather than inheriting trust from 0083.
  it.each([
    ["the exact signature", /product_sync_governance_findings\(\s*p_tenant_id uuid,\s*p_engine text,\s*p_rule_version text,\s*p_findings jsonb,\s*p_complete_connection_ids uuid\[\] default '\{\}'\s*\)/],
    ["returns jsonb", /returns jsonb/],
    ["SECURITY DEFINER", /security definer/],
    ["pinned search_path", /set search_path = public/],
    ["volatile", /volatile/],
    ["the owner/admin role gate", /has_tenant_role\(p_tenant_id, array\['owner', 'admin'\]\)/],
    ["the engine domain check", /p_engine not in \('provider_local', 'cross_source'\)/],
    ["first_seen_at is never moved on conflict", /first_seen_at is NEVER moved/i],
    ["reopen_count only increments from closed", /case when public\.governance_findings\.status = 'closed' then 1 else 0 end/],
    ["closure requires evidence coverage", /evidence_connection_ids <@ p_complete_connection_ids/],
    ["withheld_from_closure is reported", /'withheld_from_closure', v_withheld/],
    ["both connection-id sets are tenant-validated", /does not belong to tenant/],
    ["a sourceless finding is refused", /every finding must declare at least one evidence connection/],
    ["classification happens before the upsert", /Classify BEFORE the upsert/],
  ])("0091 preserves %s", (_label, re) => {
    expect(fnBody(SRC_0091)).toMatch(re);
  });

  it("changes no other object — no table/column/index/policy/RLS/trigger DDL", () => {
    // The function BODY legitimately contains inserts/updates (that is the sync's own logic, inherited verbatim from
    // 0083). What must be empty is the migration OUTSIDE the function: this migration may redefine one function and
    // re-assert its grants, and do nothing else. So the body is removed before scanning.
    const outside = SRC_0091.replace(fnBody(SRC_0091), "").replace(/(^|[^:])--.*$/gm, "$1");
    for (const forbidden of [
      /create table/i, /alter table/i, /drop table/i, /add column/i, /drop column/i,
      /create index/i, /create policy/i, /alter policy/i, /enable row level security/i,
      /create trigger/i, /insert into/i, /update public\./i, /delete from public\./i,
    ]) expect(outside, `forbidden DDL outside the function: ${forbidden}`).not.toMatch(forbidden);
    // Only the two grant statements and the transaction framing remain.
    expect(outside).toMatch(/revoke execute on function public\.product_sync_governance_findings/);
    expect(outside).toMatch(/grant\s+execute on function public\.product_sync_governance_findings/);
  });

  it("redefines exactly one function", () => {
    expect(SRC_0091.match(/create or replace function/g)).toHaveLength(1);
  });
});

// ── The regression guard the whole phase exists to install ───────────────────────────────────────────────────────────
describe("no runtime migration may issue a bare DELETE or UPDATE", () => {
  // Managed Supabase preloads `safeupdate`; stock Postgres does not. A bare DELETE/UPDATE therefore passes every local
  // suite and fails only in production-like environments — the exact failure mode 0083 shipped with. This guard is a
  // static check because the property is about the SQL we ship, not about one execution path.
  const statements = (sql: string) =>
    sql.replace(/(^|[^:])--.*$/gm, "$1").split(";")
       .map(s => s.split(/\s+/).join(" ").trim())
       .filter(Boolean);

  const files = readdirSync(M).filter(f => f.endsWith(".sql")).sort();

  it("scans every migration in the chain", () => {
    expect(files.length).toBeGreaterThanOrEqual(92);
    expect(files.at(-1)).toBe("0092_google_workspace_connector_validation.sql");
  });

  // 0083 is the ONE historical exception and is deliberately not edited: rewriting a merged migration would give two
  // databases two different histories. Its broken definition is never reachable — applying 0083 only DEFINES the
  // function, and 0091 redefines it later in the same chain before anything can call it. The exception is therefore
  // allowed only while that supersession demonstrably exists, which the next test enforces.
  const SUPERSEDED = "0083_governance_finding_persistence.sql";

  const bareIn = (file: string) =>
    statements(readFileSync(`${M}/${file}`, "utf8")).filter(s => {
      const t = s.replace(/^(begin|declare .*?|do \$\$)\s+/i, "").toLowerCase().trimStart();
      if (!(t.startsWith("delete from ") || t.startsWith("update "))) return false;
      return !/\bwhere\b/.test(t);
    });

  it.each(files.filter(f => f !== SUPERSEDED))("%s issues no WHERE-less DELETE/UPDATE", file => {
    const offenders = bareIn(file);
    expect(offenders, `WHERE-less statement(s) in ${file}: ${JSON.stringify(offenders.map(o => o.slice(0, 80)))}`)
      .toEqual([]);
  });

  it(`${SUPERSEDED} carries exactly one, and 0091 supersedes it`, () => {
    // If someone "tidies up" by deleting 0091, or edits 0083 to add a second bare statement, this fails.
    expect(bareIn(SUPERSEDED)).toEqual(["delete from reported_findings"]);
    expect(files).toContain("0091_governance_finding_sync_safeupdate.sql");
    expect(SRC_0091).toContain(SIGNATURE);                                  // 0091 redefines the same function
    expect(bareIn("0091_governance_finding_sync_safeupdate.sql")).toEqual([]);
    // And 0091 must come AFTER 0083 in the applied chain, or the fix would be overwritten by the defect.
    expect("0091_governance_finding_sync_safeupdate.sql" > SUPERSEDED).toBe(true);
  });

  it("catches the exact statement 0083 shipped, so the guard is not vacuous", () => {
    const offending = statements("delete from reported_findings;").filter(s => !/\bwhere\b/i.test(s));
    expect(offending).toHaveLength(1);
    const fixed = statements("delete from reported_findings where true;").filter(s => !/\bwhere\b/i.test(s));
    expect(fixed).toHaveLength(0);
  });
});
