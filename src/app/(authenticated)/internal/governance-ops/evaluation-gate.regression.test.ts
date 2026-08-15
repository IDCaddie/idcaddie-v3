// Phase 18F-C · THE BLOCKER REGRESSION.
//
// ══ WHAT WENT WRONG ══════════════════════════════════════════════════════════════════════════════════════════════════
// Rule 5 opens a finding whose `evidence_connection_ids` is the application's connection, and it fires only while the
// matcher's CURRENT status is `completed`. Migration 0083 closes any open finding of this engine that is ABSENT from a
// run's payload and whose evidence connections are all in `p_complete_connection_ids` — a FLAT subset test that knows
// nothing about which rule produced a finding, or whether that rule ran at all.
//
// Those two facts collide. With the matcher `running` or `failed`, rule 5 is withheld and its findings go missing from
// the payload, while the connector stays healthy and therefore closure-eligible. 0083 reads "absent + covered" as "the
// condition ended" and CLOSES a finding that is still true — counted in `closed`, never in `withheld_from_closure`.
//
// Phase 18F-C2 (#436) fixed that collision IN THE ENGINE: `closureEligibleConnections` now withdraws the
// directory-application connections from the closure licence whenever the matcher has run before and its current
// status is not `completed`. Correctness therefore no longer depends on this lane's guard, and these tests assert the
// merged behaviour rather than emulating the old bug.
//
// What the guard still buys is COMPLETENESS: an evaluation run while rule 5 is withheld says nothing about unmanaged
// applications and conservatively withholds closures, so the operator is asked to run the matcher first.
//
// ══ WHAT THIS TEST IS ════════════════════════════════════════════════════════════════════════════════════════════════
// The REAL action, the REAL reader, the REAL loader and the REAL engine, over a fake Supabase client whose
// `product_sync_governance_findings` implements 0083's closure predicate exactly as the SQL states it:
//
//     close  ⇔  status = 'open'  ∧  finding_key ∉ reported  ∧  evidence_connection_ids ⊆ p_complete_connection_ids
//
// Nothing here weakens the persistence function — it is emulated faithfully so the unsafe path is demonstrable without
// a database. The action is driven through its real exported signature; no I/O is injected into it, because a
// `"use server"` export takes its arguments from the client and must never accept one.

import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = { value: { ok: true, tenantId: "t-a" } as { ok: boolean; tenantId?: string } };
const rpcNames: string[] = [];

const OKTA = "22222222-2222-4222-8222-222222222222";
const APP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FLAG = "ID_CADDIE_INTERNAL_GOVERNANCE_OPS_ENABLED";
const RULE5 = "discovered_application_unmanaged_by_idp";

type Finding = { finding_key: string; status: "open" | "closed"; evidence_connection_ids: string[]; rule_id: string };

/** Mutable per-test world: the persisted findings, the matcher row, and an accepted-match switch. */
const world = {
  matcher: { has_ever_run: true, status: "completed" as string | null, last_completed_at: "2026-01-01T00:00:00Z" as string | null },
  stored: [] as Finding[],
  accepted: false,
  /** Flips the matcher row the first time the engine reads it — the concurrency race, made deterministic. */
  flipOnEngineRead: null as null | { has_ever_run: boolean; status: string | null; last_completed_at: string | null },
  matcherReads: 0,
};

async function rpc(name: string, args: Record<string, unknown>) {
  rpcNames.push(name);
  if (name === "product_application_matcher_state") {
    world.matcherReads++;
    // read #1 is the action's precondition; read #2 is the engine's own, inside the load.
    const row = world.flipOnEngineRead !== null && world.matcherReads > 1 ? world.flipOnEngineRead : world.matcher;
    return { data: [row], error: null };
  }
  if (name === "product_connector_capabilities") {
    // HEALTHY connector throughout. Only the matcher is ever unwell — that is the whole point.
    return { data: [{ connection_id: OKTA, capability: "directory_applications", state: "available" }], error: null };
  }
  if (name === "product_list_directory_applications") {
    return { data: args.p_after_id ? [] : [{ id: APP, connection_id: OKTA, provider: "okta", sync_status: "current" }], error: null };
  }
  if (name === "product_application_matches") {
    return { data: args.p_after_id || !world.accepted ? [] : [{ id: "m1", directory_application_id: APP, status: "accepted" }], error: null };
  }
  if (name === "product_sync_governance_findings") {
    const reported = args.p_findings as Finding[];
    const complete = args.p_complete_connection_ids as string[];
    const keys = new Set(reported.map(f => f.finding_key));
    let opened = 0, refreshed = 0, closed = 0, withheld = 0;
    for (const r of reported) {
      const existing = world.stored.find(s => s.finding_key === r.finding_key);
      if (!existing) { world.stored.push({ ...r, status: "open" }); opened++; } else { existing.status = "open"; refreshed++; }
    }
    for (const s of world.stored) {
      if (s.status !== "open" || keys.has(s.finding_key)) continue;
      if (s.evidence_connection_ids.every(c => complete.includes(c))) { s.status = "closed"; closed++; } else { withheld++; }
    }
    return { data: { reported: reported.length, opened, reopened: 0, refreshed, closed, withheld_from_closure: withheld }, error: null };
  }
  return { data: [], error: null };
}

vi.mock("@/lib/data/access-repository", () => ({ accessGate: async () => gate.value }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc,
    from: () => ({ select: () => ({ eq: async () => ({ data: [{ id: OKTA, provider: "okta" }], error: null }) }) }),
  }),
}));

const { evaluateTenantCrossSourceGovernance } = await import("@/lib/data/cross-source-governance-loader");
const { runEvaluationAction } = await import("./actions");

const COMPLETED = { has_ever_run: true, status: "completed", last_completed_at: "2026-01-01T00:00:00Z" };
const FAILED_WITH_HISTORY = { has_ever_run: true, status: "failed", last_completed_at: "2026-01-01T00:00:00Z" };
const RUNNING_WITH_HISTORY = { has_ever_run: true, status: "running", last_completed_at: "2026-01-01T00:00:00Z" };

const reset = (matcher: typeof COMPLETED | { has_ever_run: boolean; status: string | null; last_completed_at: string | null }) => {
  world.matcher = { ...matcher };
  world.stored = [];
  world.accepted = false;
  world.flipOnEngineRead = null;
  world.matcherReads = 0;
  rpcNames.length = 0;
};

/** Seed a genuinely open rule 5 finding via a healthy run, then leave the world at `after`. */
async function seedOpenFinding(after: { has_ever_run: boolean; status: string | null; last_completed_at: string | null }) {
  reset(COMPLETED);
  await evaluateTenantCrossSourceGovernance();
  expect(world.stored).toHaveLength(1);
  expect(world.stored[0].status).toBe("open");
  world.matcher = { ...after };
  world.matcherReads = 0;
  rpcNames.length = 0;
}

beforeEach(() => {
  gate.value = { ok: true, tenantId: "t-a" };
  process.env[FLAG] = "1";
  reset(COMPLETED);
});

// ── STEP 1 · the healthy baseline the blocker needs something to destroy ────────────────────────────────────────────
describe("baseline — a completed matcher opens the rule 5 finding", () => {
  it("reports rule 5, and the sync opens it on connection OKTA", async () => {
    const r = await evaluateTenantCrossSourceGovernance();
    expect(r.ok && r.summary.opened).toBe(1);
    expect(world.stored[0].rule_id).toBe(RULE5);
    expect(world.stored[0].evidence_connection_ids).toEqual([OKTA]);
  });
});

// ── STEP 2 · the ENGINE now protects the finding, with or without this lane's guard (#436) ─────────────────────────
describe("the engine is the correctness boundary", () => {
  it.each([
    ["failed with a surviving last_completed_at", FAILED_WITH_HISTORY],
    ["running with a surviving last_completed_at", RUNNING_WITH_HISTORY],
  ])("matcher %s: an UNGUARDED evaluation leaves the still-true finding OPEN", async (_label, matcher) => {
    await seedOpenFinding(matcher);

    // Calling the engine directly — bypassing this lane's guard entirely, as any other caller would.
    const r = await evaluateTenantCrossSourceGovernance();

    expect(r.ok).toBe(true);
    expect(r.ok && r.summary.withheldRules.map(x => x.ruleId)).toContain(RULE5);
    // #436: the directory-application connection is no longer closure-eligible while the matcher cannot re-prove it,
    // so the finding is WITHHELD from closure rather than closed.
    expect(r.ok && r.summary.closed).toBe(0);
    expect(r.ok && r.summary.withheldFromClosure).toBeGreaterThan(0);
    expect(world.stored[0].status).toBe("open");
  });
});

// ── STEP 3 · the guard. This is what the lane owns. ─────────────────────────────────────────────────────────────────
describe("C1–C5 · the action refuses unless the matcher is CURRENTLY completed", () => {
  it.each([
    ["C1 never run", { has_ever_run: false, status: null, last_completed_at: null }, /before evaluating governance/i],
    ["C2 running, no history", { has_ever_run: true, status: "running", last_completed_at: null }, /in flight/i],
    ["C2 running WITH history", RUNNING_WITH_HISTORY, /in flight/i],
    ["C3 failed, no history", { has_ever_run: true, status: "failed", last_completed_at: null }, /currently failed/i],
    ["C4 failed WITH history", FAILED_WITH_HISTORY, /currently failed/i],
  ])("%s → refused before the sync, finding untouched", async (_label, matcher, copy) => {
    await seedOpenFinding(matcher);

    const state = await runEvaluationAction(null);

    expect(state?.ok).toBe(false);
    expect(state?.message).toMatch(copy);
    expect(state?.counts).toEqual([]);
    // The engine was never entered: no sync, and no evidence read either.
    expect(rpcNames).not.toContain("product_sync_governance_findings");
    expect(rpcNames).not.toContain("product_list_directory_applications");
    // Exactly one matcher read — the precondition — and nothing else.
    expect(rpcNames).toEqual(["product_application_matcher_state"]);
    // C6: the finding survives.
    expect(world.stored[0].status).toBe("open");
  });

  it("C4 explicitly: a surviving last_completed_at does NOT unlock the evaluation", async () => {
    await seedOpenFinding(FAILED_WITH_HISTORY);
    expect(world.matcher.last_completed_at).not.toBeNull(); // history is present …
    const state = await runEvaluationAction(null);
    expect(state?.ok).toBe(false);                          // … and irrelevant
    expect(world.stored[0].status).toBe("open");
  });

  it("C5 completed → allowed, and the sync runs", async () => {
    const state = await runEvaluationAction(null);
    expect(state?.ok).toBe(true);
    expect(rpcNames).toContain("product_sync_governance_findings");
  });

  it("C7 a genuinely resolved condition still closes normally on a completed matcher", async () => {
    await seedOpenFinding(COMPLETED);
    world.accepted = true; // the customer accepted a match, so rule 5 legitimately stops reporting
    const state = await runEvaluationAction(null);
    expect(state?.ok).toBe(true);
    expect(world.stored[0].status).toBe("closed"); // a REAL closure still works — the guard is not a blanket freeze
  });
});

// ── STEP 4 · the residual race is DETECTED, not claimed impossible ──────────────────────────────────────────────────
describe("C11 · a mid-run matcher state change reports an INCOMPLETE run, not corruption", () => {
  it("authorized while completed, engine then reads failed → finding still open, bounded incompleteness note", async () => {
    await seedOpenFinding(COMPLETED);
    // Precondition read sees `completed`; the engine's own read (the second) sees `failed` — a concurrent matcher run.
    // This is the race the operator guard structurally cannot prevent, which is why #436 handles it in the engine.
    world.flipOnEngineRead = FAILED_WITH_HISTORY;

    const state = await runEvaluationAction(null);

    expect(state?.ok).toBe(true);                      // the sync did happen …
    expect(world.stored[0].status).toBe("open");       // … and #436 kept the still-true finding open
    expect(state?.notes.join(" ")).toMatch(/INCOMPLETE/);
    expect(state?.notes.join(" ")).toMatch(/Nothing was wrongly closed/);
    // The old corruption language must never come back: it would send an operator chasing damage that cannot occur.
    expect(state?.notes.join(" ")).not.toMatch(/wrongly closed findings|reopen anything|corruption/i);
  });

  it("the note is only raised when rule 5 was actually withheld", async () => {
    await seedOpenFinding(COMPLETED);
    const state = await runEvaluationAction(null);     // no flip — a clean, complete run
    expect(state?.notes.join(" ")).not.toMatch(/INCOMPLETE/);
  });
});

// ── STEP 5 · authority still precedes everything ───────────────────────────────────────────────────────────────────
describe("C9/C10 · authority and flag precede the precondition", () => {
  it("C9 editor/viewer → refused before any RPC", async () => {
    gate.value = { ok: false };
    const state = await runEvaluationAction(null);
    expect(state?.ok).toBe(false);
    expect(rpcNames).toEqual([]);
  });

  it("C10 flag disabled → refused before access and before any RPC", async () => {
    delete process.env[FLAG];
    const state = await runEvaluationAction(null);
    expect(state?.ok).toBe(false);
    expect(state?.message).toMatch(/not enabled/);
    expect(rpcNames).toEqual([]);
  });
});

// ── C8 · the UI is not the control ─────────────────────────────────────────────────────────────────────────────────
describe("C8 · a direct invocation, exactly as a hostile or stale client would make it", () => {
  it("refuses even though the UI would have disabled the button", async () => {
    await seedOpenFinding(FAILED_WITH_HISTORY);
    // Every test in this file already calls the exported server action DIRECTLY — there is no page, no form and no
    // `blockedReason` prop in this process. That is the point: the button is a courtesy, the action is the authority.
    const state = await runEvaluationAction(null);
    expect(state?.ok).toBe(false);
    expect(rpcNames).not.toContain("product_sync_governance_findings");
    expect(world.stored[0].status).toBe("open");
  });

  it("a hostile prevState cannot pre-authorize the run", async () => {
    await seedOpenFinding(FAILED_WITH_HISTORY);
    const hostile = { ok: true, message: "authorized", counts: [], notes: [], allowed: true } as never;
    const state = await runEvaluationAction(hostile);
    expect(state?.ok).toBe(false);
    expect(world.stored[0].status).toBe("open");
  });
});

// ── The emulation is pinned to the real SQL, so this file cannot quietly prove a fiction ────────────────────────────
describe("0083/0091 closure predicate — the emulation above matches the shipped SQL", () => {
  it("the closable CTE still tests status=open, absence from reported, and evidence ⊆ complete", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/0091_governance_finding_sync_safeupdate.sql", "utf8");
    expect(sql).toMatch(/g\.status\s*=\s*'open'/);
    expect(sql).toMatch(/not exists \(select 1 from reported_findings r where r\.finding_key = g\.finding_key\)/);
    expect(sql).toMatch(/g\.evidence_connection_ids <@ p_complete_connection_ids/);
    // …and that it is NOT scoped by rule — which is precisely why a withheld rule is unsafe to sync in.
    expect(sql).not.toMatch(/closable[\s\S]{0,400}rule_id/);
  });
});
