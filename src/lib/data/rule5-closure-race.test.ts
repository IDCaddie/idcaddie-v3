// Phase 18F-C2 — the TOCTOU race, end to end, through the REAL loader and the REAL engine.
//
// The caller-side precondition (Phase 18F-C) and the engine's own matcher read are two separate statements. A
// concurrent matcher run between them flips the state AFTER the caller has already decided, so the caller cannot
// prevent what follows. This file drives that interleaving deterministically by flipping the matcher row between the
// two reads, and asserts the property that has to hold regardless of who called: a still-true rule 5 finding is NOT
// closed by a run that could not re-prove it.
//
// `product_sync_governance_findings` is emulated from 0091's own text — asserted against the migration below rather
// than assumed, so this file cannot quietly prove a fiction:
//
//   with closable as (
//     select g.id, (g.evidence_connection_ids <@ p_complete_connection_ids) as covered
//       from public.governance_findings g
//      where g.tenant_id = p_tenant_id and g.engine = p_engine and g.status = 'open'
//        and not exists (select 1 from reported_findings r where r.finding_key = g.finding_key)
//   ), closed as (update ... where g.id = c.id and c.covered returning 1)

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const OKTA = "22222222-2222-4222-8222-222222222222";
const SLACK = "33333333-3333-4333-8333-333333333333";
const APP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RULE5 = "discovered_application_unmanaged_by_idp";

type Row = {
  finding_key: string; rule_id: string; status: "open" | "closed";
  evidence_connection_ids: string[]; first_seen_at: string; reopen_count: number; resolved_at: string | null;
};

const gate = { value: { ok: true, tenantId: "t-a" } as { ok: boolean; tenantId?: string } };

const w = {
  matcher: { has_ever_run: true, status: "completed" as string | null, last_completed_at: "2026-01-01T00:00:00Z" as string | null },
  rows: [] as Row[],
  accepted: false,
  /** Optional second capability + estate so a NON-rule-5 finding can share the OKTA connection. */
  shareOkta: false,
  orphanResolved: false,
  /** From the Nth matcher read onward, serve `flipTo` — the concurrent matcher run, made deterministic. */
  flipAtRead: 0,
  flipTo: null as null | { has_ever_run: boolean; status: string | null; last_completed_at: string | null },
  reads: 0,
  lastSummary: null as null | Record<string, number>,
};

async function rpc(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "product_application_matcher_state": {
      w.reads++;
      const row = w.flipAtRead > 0 && w.reads >= w.flipAtRead && w.flipTo ? w.flipTo : w.matcher;
      return { data: [row], error: null };
    }
    case "product_connector_capabilities": {
      // The connector is HEALTHY in every case below. Only the matcher is ever unwell — that is the whole point.
      const caps = [{ connection_id: OKTA, capability: "directory_applications", state: "available" }];
      if (w.shareOkta) {
        caps.push({ connection_id: OKTA, capability: "identity", state: "available" });
        caps.push({ connection_id: SLACK, capability: "app_accounts", state: "available" });
      }
      return { data: caps, error: null };
    }
    case "product_list_directory_identities":
      return { data: args.p_after_id || !w.shareOkta ? [] : [{ id: "i1", connection_id: OKTA, provider: "okta", sync_status: "current", is_active: true }], error: null };
    case "product_app_accounts_for_governance":
      return { data: args.p_after_id || !w.shareOkta ? [] : [{ id: "a1", connection_id: SLACK, provider: "slack", sync_status: "current", account_kind: "human", account_status: "active", is_admin: null }], error: null };
    case "product_person_account_links": {
      // Person resolution must have produced SOMETHING for the orphan rule to run at all (`resolutionHasRun`). The
      // identity-only link supplies that, while account `a1` has no accepted owner — which is the orphan condition.
      // Accepting an owner for `a1` is what genuinely resolves the finding.
      if (args.p_after_id || !w.shareOkta) return { data: [], error: null };
      const links: Record<string, unknown>[] = [
        { id: "l1", person_id: "p1", identity_account_id: "i1", app_account_id: null, status: "accepted" },
      ];
      if (w.orphanResolved) {
        links.push({ id: "l2", person_id: "p1", identity_account_id: null, app_account_id: "a1", status: "accepted" });
      }
      return { data: links, error: null };
    }
    case "product_list_directory_applications":
      return { data: args.p_after_id ? [] : [{ id: APP, connection_id: OKTA, provider: "okta", sync_status: "current" }], error: null };
    case "product_application_matches":
      return { data: args.p_after_id || !w.accepted ? [] : [{ id: "m1", directory_application_id: APP, status: "accepted" }], error: null };
    case "product_sync_governance_findings": {
      const reported = args.p_findings as { finding_key: string; rule_id: string; evidence_connection_ids: string[] }[];
      const complete = args.p_complete_connection_ids as string[];
      const keys = new Set(reported.map(f => f.finding_key));
      let opened = 0, refreshed = 0, reopened = 0, closed = 0, withheld = 0;
      const now = "2026-02-02T00:00:00Z";
      for (const r of reported) {
        const ex = w.rows.find(x => x.finding_key === r.finding_key);
        if (!ex) {
          w.rows.push({ ...r, status: "open", first_seen_at: now, reopen_count: 0, resolved_at: null });
          opened++;
        } else {
          if (ex.status === "closed") { ex.reopen_count++; reopened++; } else refreshed++;
          ex.status = "open"; ex.resolved_at = null; // first_seen_at is NEVER moved (0083)
        }
      }
      for (const g of w.rows) {
        if (g.status !== "open" || keys.has(g.finding_key)) continue;
        if (g.evidence_connection_ids.every(c => complete.includes(c))) { g.status = "closed"; g.resolved_at = now; closed++; }
        else withheld++;
      }
      w.lastSummary = { reported: reported.length, opened, reopened, refreshed, closed, withheld_from_closure: withheld };
      return { data: w.lastSummary, error: null };
    }
    default:
      return { data: [], error: null };
  }
}

vi.mock("@/lib/data/access-repository", () => ({ accessGate: async () => gate.value }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc,
    from: () => ({ select: () => ({ eq: async () => ({ data: [{ id: OKTA, provider: "okta" }, { id: SLACK, provider: "slack" }], error: null }) }) }),
  }),
}));

const { evaluateTenantCrossSourceGovernance } = await import("./cross-source-governance-loader");

const COMPLETED = { has_ever_run: true, status: "completed", last_completed_at: "2026-01-01T00:00:00Z" };
const FAILED_HIST = { has_ever_run: true, status: "failed", last_completed_at: "2026-01-01T00:00:00Z" };
const RUNNING_HIST = { has_ever_run: true, status: "running", last_completed_at: "2026-01-01T00:00:00Z" };

function reset() {
  w.matcher = { ...COMPLETED }; w.rows = []; w.accepted = false;
  w.shareOkta = false; w.orphanResolved = false;
  w.flipAtRead = 0; w.flipTo = null; w.reads = 0; w.lastSummary = null;
}

/** Open a genuine rule 5 finding with a healthy run. */
async function seedOpenFinding() {
  reset();
  const r = await evaluateTenantCrossSourceGovernance();
  expect(r.ok).toBe(true);
  expect(w.rows).toHaveLength(1);
  expect(w.rows[0].rule_id).toBe(RULE5);
  expect(w.rows[0].status).toBe("open");
  w.reads = 0; w.lastSummary = null;
}

beforeEach(() => { gate.value = { ok: true, tenantId: "t-a" }; reset(); });

it("the emulated closure predicate is the one 0091 ships", () => {
  const sql = readFileSync("supabase/migrations/0091_governance_finding_sync_safeupdate.sql", "utf8");
  expect(sql).toMatch(/g\.status\s*=\s*'open'/);
  expect(sql).toMatch(/not exists \(select 1 from reported_findings r where r\.finding_key = g\.finding_key\)/);
  expect(sql).toMatch(/g\.evidence_connection_ids <@ p_complete_connection_ids/);
  const cte = sql.slice(sql.indexOf("with closable"), sql.indexOf("into v_closed"));
  expect(cte).not.toMatch(/rule_id/); // no rule scoping — the reason the engine must withdraw the licence itself
});

describe("matcher state observed BEFORE the evaluation starts", () => {
  it.each([["failed", FAILED_HIST], ["running", RUNNING_HIST]])(
    "%s: rule 5 withheld and the still-true finding STAYS OPEN, counted as withheld from closure",
    async (_l, m) => {
      await seedOpenFinding();
      w.matcher = { ...m };

      const r = await evaluateTenantCrossSourceGovernance();

      expect(r.ok).toBe(true);
      expect(r.ok && r.summary.withheldRules.map(x => x.ruleId)).toContain(RULE5);
      expect(w.rows[0].status).toBe("open");            // ← the property
      expect(w.rows[0].resolved_at).toBeNull();
      expect(r.ok && r.summary.closed).toBe(0);
      expect(r.ok && r.summary.withheldFromClosure).toBeGreaterThan(0); // honestly reported, not silently skipped
    });
});

describe("THE RACE — matcher flips between the caller's read and the engine's own snapshot", () => {
  it.each([["failed", FAILED_HIST], ["running", RUNNING_HIST]])(
    "completed at the caller, %s at the engine snapshot → finding still stays open",
    async (_l, m) => {
      await seedOpenFinding();
      // Read #1 is a caller precondition (as Phase 18F-C's ops action performs); from read #2 — the engine's own — the
      // state has changed under it.
      w.reads = 0;
      w.flipAtRead = 1;   // the engine's read inside this evaluation is its first
      w.flipTo = { ...m };

      const r = await evaluateTenantCrossSourceGovernance();

      expect(r.ok).toBe(true);
      expect(r.ok && r.summary.withheldRules.map(x => x.ruleId)).toContain(RULE5);
      expect(w.rows[0].status).toBe("open");
      expect(r.ok && r.summary.closed).toBe(0);
      expect(r.ok && r.summary.withheldFromClosure).toBeGreaterThan(0);
    });

  it("identity is preserved — no id churn, no reopen inflation, first_seen_at untouched", async () => {
    await seedOpenFinding();
    const before = structuredClone(w.rows[0]);
    w.reads = 0; w.flipAtRead = 1; w.flipTo = { ...FAILED_HIST };
    await evaluateTenantCrossSourceGovernance();
    expect(w.rows[0].first_seen_at).toBe(before.first_seen_at);
    expect(w.rows[0].reopen_count).toBe(before.reopen_count);
    expect(w.rows[0].finding_key).toBe(before.finding_key);
  });
});

describe("the protection is a DELAY, not a freeze", () => {
  it("after the matcher completes again and the condition genuinely resolves, the finding closes", async () => {
    await seedOpenFinding();
    // A run while the matcher is failed leaves it open …
    w.matcher = { ...FAILED_HIST };
    await evaluateTenantCrossSourceGovernance();
    expect(w.rows[0].status).toBe("open");

    // … then the matcher completes and a human accepts the match, so rule 5 legitimately stops reporting.
    w.matcher = { ...COMPLETED };
    w.accepted = true;
    const r = await evaluateTenantCrossSourceGovernance();

    expect(r.ok && r.summary.evaluatedRules).toContain(RULE5);
    expect(w.rows[0].status).toBe("closed");           // the delayed closure now happens
    expect(w.rows[0].resolved_at).not.toBeNull();
    expect(r.ok && r.summary.closed).toBe(1);
  });

  it("a healthy run over an unresolved estate refreshes rather than closes", async () => {
    await seedOpenFinding();
    const r = await evaluateTenantCrossSourceGovernance();
    expect(r.ok && r.summary.refreshed).toBe(1);
    expect(r.ok && r.summary.closed).toBe(0);
    expect(w.rows[0].status).toBe("open");
  });
});

// ── PHASE 8 · the tradeoff, exercised on a real second rule ─────────────────────────────────────────────────────────
describe("a NON-rule-5 finding sharing the withdrawn connection", () => {
  const ORPHAN = "active_saas_account_without_accepted_identity";

  it("is delayed by one run while the matcher is unwell, then closes on a proven run", async () => {
    reset();
    w.shareOkta = true;                 // OKTA now serves identity AND directory_applications
    // 1. Healthy run opens BOTH findings. The orphan's evidence spans SLACK (account) + OKTA (identity).
    const first = await evaluateTenantCrossSourceGovernance();
    expect(first.ok).toBe(true);
    const orphan = w.rows.find(r => r.rule_id === ORPHAN);
    expect(orphan).toBeDefined();
    expect(orphan!.evidence_connection_ids).toContain(OKTA);
    expect(w.rows.find(r => r.rule_id === RULE5)).toBeDefined();

    // 2. The condition genuinely resolves (a person is accepted) AND the matcher is unwell.
    w.orphanResolved = true;
    w.matcher = { ...FAILED_HIST };
    const second = await evaluateTenantCrossSourceGovernance();
    expect(second.ok).toBe(true);
    expect(second.ok && second.summary.withheldRules.map(x => x.ruleId)).toContain(RULE5);
    // The orphan is genuinely resolved, but OKTA is not closure-eligible this run → DELAYED, and reported honestly.
    expect(w.rows.find(r => r.rule_id === ORPHAN)!.status).toBe("open");
    expect(second.ok && second.summary.withheldFromClosure).toBeGreaterThan(0);

    // 3. The matcher completes. The delay ends and the genuine closure happens.
    w.matcher = { ...COMPLETED };
    const third = await evaluateTenantCrossSourceGovernance();
    expect(third.ok).toBe(true);
    expect(w.rows.find(r => r.rule_id === ORPHAN)!.status).toBe("closed");
  });

  it("is NOT delayed when the matcher is healthy — the withdrawal is conditional, not permanent", async () => {
    reset();
    w.shareOkta = true;
    await evaluateTenantCrossSourceGovernance();
    w.orphanResolved = true;                       // resolves, matcher stays completed
    const r = await evaluateTenantCrossSourceGovernance();
    expect(r.ok).toBe(true);
    expect(w.rows.find(r2 => r2.rule_id === ORPHAN)!.status).toBe("closed");
  });

  it("a connection with no directory-applications capability is never withdrawn", async () => {
    reset();
    w.shareOkta = true;
    await evaluateTenantCrossSourceGovernance();
    w.matcher = { ...FAILED_HIST };
    const r = await evaluateTenantCrossSourceGovernance();
    expect(r.ok).toBe(true);
    // SLACK carries only app_accounts, so it keeps its licence even while the matcher is unwell.
    expect(r.ok && r.summary).toBeDefined();
  });
});
