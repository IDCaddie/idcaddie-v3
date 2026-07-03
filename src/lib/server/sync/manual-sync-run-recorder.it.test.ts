import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseManualSyncRunRecorder } from "./manual-sync-run-recorder";
import type { RunSlackSyncSummary } from "./run-slack-sync-dev";

// REAL DB + RLS integration test for the run recorder — proves the supabase-js/PostgREST query shapes + RLS the unit
// test can only mock: a tenant member writes its own run (created_by defaults to the JWT), and a cross-tenant write is
// RLS-denied. Runs against a LOCAL Supabase stack (`npm run test:store-it`); SKIPPED in normal `npm test`/CI-without-DB.
// service-role is used for FIXTURE SETUP ONLY — the recorder under test writes exclusively as a tenant-member JWT.

const URL = process.env.SUPABASE_IT_URL;
const ANON = process.env.SUPABASE_IT_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_IT_SERVICE_ROLE_KEY ?? "";
const RUN = !!URL && !!ANON && !!SERVICE;

describe.runIf(RUN)("createSupabaseManualSyncRunRecorder — real DB/RLS", () => {
  const sfx = (process.env.SUPABASE_IT_SUFFIX ?? String(Date.now())).slice(-9);
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  const pw = `it-pw-${sfx}-run`;
  const emailA = `it_run_a_${sfx}@example.test`;
  const emailB = `it_run_b_${sfx}@example.test`;
  let admin: SupabaseClient;
  let recA: ReturnType<typeof createSupabaseManualSyncRunRecorder>;
  let recB: ReturnType<typeof createSupabaseManualSyncRunRecorder>;
  const ids: { users: string[] } = { users: [] };

  async function memberRecorder(email: string) {
    const auth = createClient(URL!, ANON, { auth: { persistSession: false } });
    const { data, error } = await auth.auth.signInWithPassword({ email, password: pw });
    if (error || !data.session) throw new Error("IT signin failed");
    const client = createClient(URL!, ANON, { global: { headers: { Authorization: `Bearer ${data.session.access_token}` } }, auth: { persistSession: false } });
    return { recorder: createSupabaseManualSyncRunRecorder(client), client };
  }

  beforeAll(async () => {
    admin = createClient(URL!, SERVICE, { auth: { persistSession: false } });
    for (const [email, tenant, name, slug] of [
      [emailA, tenantA, "IT Run A", `itr-a-${sfx}`],
      [emailB, tenantB, "IT Run B", `itr-b-${sfx}`],
    ] as const) {
      const { data: u, error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
      if (error || !u.user) throw new Error("IT createUser failed");
      ids.users.push(u.user.id);
      const seed = (label: string, r: { error: unknown }) => { if (r.error) throw new Error(`IT fixture ${label} failed: ${JSON.stringify(r.error)}`); };
      seed("profiles", await admin.from("profiles").insert({ id: u.user.id, email }));
      seed("tenants", await admin.from("tenants").insert({ id: tenant, name, slug }));
      seed("memberships", await admin.from("tenant_memberships").insert({ tenant_id: tenant, user_id: u.user.id, role: "owner", status: "active" }));
    }
    recA = (await memberRecorder(emailA)).recorder;
    recB = (await memberRecorder(emailB)).recorder;
  }, 30_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from("tenants").delete().in("id", [tenantA, tenantB]); // cascades manual_sync_runs
    for (const uid of ids.users) await admin.auth.admin.deleteUser(uid).catch(() => {});
  });

  const openA = async (connectorId: string) => {
    const r = await recA.start({ tenantId: tenantA, source: "slack", connectorId });
    if (!r.ok) throw new Error(`start refused: ${r.reason}`);
    return r.runId;
  };

  it("a tenant member opens a 'running' run then closes it 'succeeded' (created_by = the member, RLS-enforced)", async () => {
    const runId = await openA("ok-run");
    const ok: RunSlackSyncSummary = { ok: true, teamPresent: true, usersFetched: 1, factsEmitted: 6, factsRejected: 0, appUsersWritten: 1, peopleWritten: 1, matchesWritten: 1, matchConflicts: 0, skipped: 2, staleMarked: 0 };
    await recA.finish({ runId, summary: ok });
    const { data } = await admin.from("manual_sync_runs").select("status, users_fetched, created_by, tenant_id").eq("id", runId).single();
    expect(data?.status).toBe("succeeded");
    expect(data?.users_fetched).toBe(1);
    expect(data?.tenant_id).toBe(tenantA);
    expect(data?.created_by).toBe(ids.users[0]); // default auth.uid() = member A
  });

  it("a failed run records failed + the safe error_code/failed_stage", async () => {
    const runId = await openA("fail-run");
    await recA.finish({ runId, summary: { ok: false, errorCode: "resolve_failed", failedStage: "upsert_app", safeReason: "rls_denied", usersFetched: 1 } });
    const { data } = await admin.from("manual_sync_runs").select("status, error_code, failed_stage").eq("id", runId).single();
    expect(data).toMatchObject({ status: "failed", error_code: "resolve_failed", failed_stage: "upsert_app" });
  });

  it("the active-run lock: a SECOND running run for the same (tenant, source, connector) is refused, NOT recorded", async () => {
    const first = await recA.start({ tenantId: tenantA, source: "slack", connectorId: "lock-c" });
    expect(first.ok).toBe(true);
    const second = await recA.start({ tenantId: tenantA, source: "slack", connectorId: "lock-c" });
    expect(second).toEqual({ ok: false, reason: "run_already_active" }); // DB partial unique index → no second record
    const { count } = await admin.from("manual_sync_runs").select("*", { count: "exact", head: true }).eq("tenant_id", tenantA).eq("connector_id", "lock-c").eq("status", "running");
    expect(count).toBe(1);
    // after the first finishes, a new run for the same key CAN start (lock released)
    if (first.ok) await recA.finish({ runId: first.runId, summary: { ok: true, teamPresent: true, usersFetched: 0, factsEmitted: 0, factsRejected: 0, appUsersWritten: 0, peopleWritten: 0, matchesWritten: 0, matchConflicts: 0, skipped: 0, staleMarked: 0 } });
    expect((await recA.start({ tenantId: tenantA, source: "slack", connectorId: "lock-c" })).ok).toBe(true);
  });

  it("the lock is TENANT-SCOPED: tenant A's active run does not block tenant B", async () => {
    expect((await recA.start({ tenantId: tenantA, source: "slack", connectorId: "shared" })).ok).toBe(true);
    expect((await recB.start({ tenantId: tenantB, source: "slack", connectorId: "shared" })).ok).toBe(true); // different tenant → own lock
  });

  it("a stale 'running' run is reconciled to failed (stale_run_reconciled), then a new run can start", async () => {
    // seed a STALE running row (service-role setup only) with an old started_at
    const { data: stale } = await admin.from("manual_sync_runs")
      .insert({ tenant_id: tenantA, source: "slack", connector_id: "stale-c", status: "running", started_at: "2020-01-01T00:00:00Z" })
      .select("id").single();
    const res = await recA.reconcileStaleRuns({ tenantId: tenantA, source: "slack", connectorId: "stale-c", staleBeforeIso: "2025-01-01T00:00:00Z" });
    expect(res.reconciled).toBe(1);
    const { data: row } = await admin.from("manual_sync_runs").select("status, error_code, finished_at, users_fetched").eq("id", stale!.id).single();
    expect(row).toMatchObject({ status: "failed", error_code: "stale_run_reconciled" });
    expect(row?.finished_at).not.toBeNull();
    expect(row?.users_fetched).toBeNull(); // no success counts invented
    expect((await recA.start({ tenantId: tenantA, source: "slack", connectorId: "stale-c" })).ok).toBe(true); // lock released
  });

  it("tenant A cannot reconcile tenant B's stale run (cross-tenant reconcile isolated)", async () => {
    await admin.from("manual_sync_runs").insert({ tenant_id: tenantB, source: "slack", connector_id: "b-stale", status: "running", started_at: "2020-01-01T00:00:00Z" });
    const res = await recA.reconcileStaleRuns({ tenantId: tenantB, source: "slack", connectorId: "b-stale", staleBeforeIso: "2025-01-01T00:00:00Z" });
    expect(res.reconciled).toBe(0); // RLS: member A may not update tenant B rows
    const { data } = await admin.from("manual_sync_runs").select("status").eq("tenant_id", tenantB).eq("connector_id", "b-stale").single();
    expect(data?.status).toBe("running"); // tenant B's stale run is untouched by A
  });

  it("finish() on an already-terminal run is a safe no-op (never trips the 0037 completed-run immutability)", async () => {
    const okSummary: RunSlackSyncSummary = { ok: true, teamPresent: true, usersFetched: 0, factsEmitted: 0, factsRejected: 0, appUsersWritten: 0, peopleWritten: 0, matchesWritten: 0, matchConflicts: 0, skipped: 0, staleMarked: 0 };
    const runId = await openA("double-finish");
    await recA.finish({ runId, summary: okSummary }); // running -> succeeded
    await expect(recA.finish({ runId, summary: { ok: false, errorCode: "resolve_failed" } })).resolves.toBeUndefined(); // 2nd close: 0 rows (not running) -> no throw, no change
    const { data } = await admin.from("manual_sync_runs").select("status").eq("id", runId).single();
    expect(data?.status).toBe("succeeded"); // unchanged — the completed run is immutable
  });

  it("RLS denies a cross-tenant run write: member B cannot open a run for tenant A (run_record_failed)", async () => {
    await expect(recB.start({ tenantId: tenantA, source: "slack", connectorId: "x" })).rejects.toThrow("run_record_failed");
    const { count } = await admin.from("manual_sync_runs").select("*", { count: "exact", head: true }).eq("tenant_id", tenantA).eq("connector_id", "x");
    expect(count).toBe(0);
  });
});
