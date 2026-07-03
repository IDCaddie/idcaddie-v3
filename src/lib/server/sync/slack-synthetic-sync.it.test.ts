import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseSlackResolverStore } from "./supabase-slack-resolver-store";
import { createSupabaseManualSyncRunRecorder } from "./manual-sync-run-recorder";
import { recordedSlackSyncRun, type RecordedRunResult } from "./recorded-slack-sync-run";
import { createSlackClient } from "./slack/slack-client";
import { emitSlackDiscoveryFacts } from "../connector-vault/slack-discovery-emitter";
import { applySlackDiscoveryResolution } from "../connector-vault/slack-resolver-write";
import {
  fixtureSlackHttpClient,
  makeFixtureSlackHttpClient,
  fixtureProviderTokenSource,
  FIXTURE_SLACK_TOKEN,
  FIXTURE_CONNECTOR_ID,
  FIXTURE_TEAM_ID,
  SLACK_FIXTURE_EXPECTED,
} from "./slack/slack-sync-fixture";

// END-TO-END SYNTHETIC Slack sync — drives the WHOLE pipeline (fixture http client → createSlackClient → emit → resolve →
// recordedSlackSyncRun/manual_sync_runs lifecycle) against the LOCAL Supabase stack, as a tenant-member JWT (RLS). NO live
// Slack, NO real token, NO AWS/KMS/Secrets Manager, NO production. Runs only under `npm run test:store-it` (SUPABASE_IT_*);
// SKIPPED in plain CI. Service-role is used for FIXTURE SETUP + verification READS + teardown ONLY — the sync writes
// exclusively as the member JWT.

const URL = process.env.SUPABASE_IT_URL;
const ANON = process.env.SUPABASE_IT_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_IT_SERVICE_ROLE_KEY ?? "";
const RUN = !!URL && !!ANON && !!SERVICE;

// Inject a dev-enabled env into the deps (NOT process.env) so recordedSlackSyncRun's local-dev gate opens for the
// synthetic run without mutating the global environment.
const DEV_ENV = { NODE_ENV: "development", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" } as const;
const OBSERVED = "2026-07-03T00:00:00.000Z";

describe.runIf(RUN)("synthetic Slack sync — end-to-end pipeline over the fixture (real DB/RLS)", () => {
  const sfx = (process.env.SUPABASE_IT_SUFFIX ?? String(Date.now())).slice(-9);
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  const pw = `it-pw-${sfx}-syn`;
  const emailA = `it_syn_a_${sfx}@example.test`;
  const emailB = `it_syn_b_${sfx}@example.test`;
  let admin: SupabaseClient;
  let storeA: ReturnType<typeof createSupabaseSlackResolverStore>;
  let storeB: ReturnType<typeof createSupabaseSlackResolverStore>;
  let recorderA: ReturnType<typeof createSupabaseManualSyncRunRecorder>;
  let recorderB: ReturnType<typeof createSupabaseManualSyncRunRecorder>;
  const authUserIds: string[] = [];

  async function memberClient(email: string) {
    const auth = createClient(URL!, ANON, { auth: { persistSession: false } });
    const { data, error } = await auth.auth.signInWithPassword({ email, password: pw });
    if (error || !data.session) throw new Error("IT signin failed");
    return createClient(URL!, ANON, { global: { headers: { Authorization: `Bearer ${data.session.access_token}` } }, auth: { persistSession: false } });
  }

  const runSynthetic = (store: typeof storeA, recorder: typeof recorderA, tenantId: string): Promise<RecordedRunResult> =>
    recordedSlackSyncRun(
      { env: DEV_ENV, tokenSource: fixtureProviderTokenSource, httpClient: fixtureSlackHttpClient, store, identity: { tenantId, connectorId: FIXTURE_CONNECTOR_ID }, observedAt: OBSERVED },
      recorder,
    );

  // absence-run variant: a custom observedAt (so a later run can mark earlier-seen users stale) + optional excluded
  // member ids (simulate users who LEFT the workspace — absent from users.list).
  const runSyntheticAt = (store: typeof storeA, recorder: typeof recorderA, tenantId: string, observedAt: string, excludeUserIds: readonly string[] = []): Promise<RecordedRunResult> =>
    recordedSlackSyncRun(
      { env: DEV_ENV, tokenSource: fixtureProviderTokenSource, httpClient: makeFixtureSlackHttpClient({ excludeUserIds }).client, store, identity: { tenantId, connectorId: FIXTURE_CONNECTOR_ID }, observedAt },
      recorder,
    );

  async function graphCounts(tenantId: string) {
    const c = async (table: string) => (await admin.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", tenantId)).count ?? -1;
    return { apps: await c("apps"), appUsers: await c("app_users"), people: await c("people"), matches: await c("app_user_identity_matches") };
  }

  beforeAll(async () => {
    admin = createClient(URL!, SERVICE, { auth: { persistSession: false } });
    for (const [email, tenant, name, slug] of [
      [emailA, tenantA, "Syn Tenant A", `syn-a-${sfx}`],
      [emailB, tenantB, "Syn Tenant B", `syn-b-${sfx}`],
    ] as const) {
      const { data: u, error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
      if (error || !u.user) throw new Error("IT createUser failed");
      authUserIds.push(u.user.id);
      const seed = (label: string, r: { error: unknown }) => { if (r.error) throw new Error(`IT fixture ${label} failed: ${JSON.stringify(r.error)}`); };
      seed("profiles", await admin.from("profiles").insert({ id: u.user.id, email }));
      seed("tenants", await admin.from("tenants").insert({ id: tenant, name, slug }));
      seed("memberships", await admin.from("tenant_memberships").insert({ tenant_id: tenant, user_id: u.user.id, role: "owner", status: "active" }));
    }
    storeA = createSupabaseSlackResolverStore(await memberClient(emailA));
    storeB = createSupabaseSlackResolverStore(await memberClient(emailB));
    recorderA = createSupabaseManualSyncRunRecorder(await memberClient(emailA));
    recorderB = createSupabaseManualSyncRunRecorder(await memberClient(emailB));
  }, 30_000);

  afterAll(async () => {
    if (!admin) return;
    for (const t of [tenantA, tenantB]) {
      for (const table of ["app_user_identity_matches", "app_users", "people", "apps", "manual_sync_runs"]) await admin.from(table).delete().eq("tenant_id", t);
      await admin.from("tenant_memberships").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of authUserIds) { await admin.from("profiles").delete().eq("id", id); await admin.auth.admin.deleteUser(id).catch(() => {}); }
  }, 30_000);

  it("first synthetic run creates the expected graph and a succeeded manual_sync_runs row", async () => {
    const r = await runSynthetic(storeA, recorderA, tenantA);
    expect(r.summary.ok).toBe(true);
    expect(r.runId).toBeTruthy();
    expect(await graphCounts(tenantA)).toEqual({ apps: SLACK_FIXTURE_EXPECTED.apps, appUsers: SLACK_FIXTURE_EXPECTED.appUsers, people: SLACK_FIXTURE_EXPECTED.people, matches: SLACK_FIXTURE_EXPECTED.matches });
    // bot + slackbot excluded from app_users
    for (const botId of SLACK_FIXTURE_EXPECTED.excludedBotIds) {
      const { count } = await admin.from("app_users").select("id", { count: "exact", head: true }).eq("tenant_id", tenantA).eq("external_user_id", botId);
      expect(count).toBe(0);
    }
    // deleted user IS represented (not hard-deleted); emailless user has an app_user but NO match
    const del = await admin.from("app_users").select("id").eq("tenant_id", tenantA).eq("external_user_id", SLACK_FIXTURE_EXPECTED.deletedAppUserExternalId);
    expect(del.data?.length).toBe(1);
    const eless = await admin.from("app_users").select("id").eq("tenant_id", tenantA).eq("external_user_id", SLACK_FIXTURE_EXPECTED.emaillessAppUserExternalId);
    expect(eless.data?.length).toBe(1);
    const elessMatch = await admin.from("app_user_identity_matches").select("id", { count: "exact", head: true }).eq("tenant_id", tenantA).eq("app_user_id", eless.data![0].id);
    expect(elessMatch.count).toBe(0);
    // mixed-case duplicate emails fold to ONE person
    const alice = await admin.from("people").select("id", { count: "exact", head: true }).eq("tenant_id", tenantA).eq("primary_email", SLACK_FIXTURE_EXPECTED.dedupedPersonEmail);
    expect(alice.count).toBe(1);
    // one manual_sync_runs row, succeeded
    const runs = await admin.from("manual_sync_runs").select("status, source, connector_id").eq("tenant_id", tenantA);
    expect(runs.data).toHaveLength(1);
    expect(runs.data![0]).toMatchObject({ status: "succeeded", source: "slack", connector_id: FIXTURE_CONNECTOR_ID });
  }, 30_000);

  it("second run is idempotent — identical graph, no duplicate rows, a second run row", async () => {
    const before = await graphCounts(tenantA);
    const r = await runSynthetic(storeA, recorderA, tenantA);
    expect(r.summary.ok).toBe(true);
    expect(await graphCounts(tenantA)).toEqual(before); // no dupes across apps/app_users/people/matches
    const runs = await admin.from("manual_sync_runs").select("id", { count: "exact", head: true }).eq("tenant_id", tenantA);
    expect(runs.count).toBe(2); // two distinct runs recorded
  }, 30_000);

  it("mismatched-tenant facts are SKIPPED and tenant B's graph stays empty", async () => {
    // Emit facts for tenant A, then resolve them through tenant B's store with authTenantId = tenant B → spoof guard skips all.
    const client = createSlackClient({ tokenSource: fixtureProviderTokenSource, httpClient: fixtureSlackHttpClient, identity: { tenantId: tenantA, connectorId: FIXTURE_CONNECTOR_ID } });
    const { facts } = emitSlackDiscoveryFacts({ workspace: await client.authTest(), users: await client.listUsers() }, tenantA, { observedAt: OBSERVED });
    const res = await applySlackDiscoveryResolution(storeB, tenantB, facts);
    expect(res.skipped).toBe(facts.length); // every tenant-A fact skipped by tenant B
    expect(res.appsUpserted + res.appUsersUpserted + res.peopleUpserted + res.matchesUpserted).toBe(0);
    expect(await graphCounts(tenantB)).toEqual({ apps: 0, appUsers: 0, people: 0, matches: 0 });
  }, 30_000);

  it("a direct cross-tenant write is RLS-denied (SQLSTATE 42501)", async () => {
    let failure: { table?: string; op?: string; code?: string | null } | undefined;
    try {
      await storeB.upsertApp({ tenantId: tenantA, externalInstanceId: FIXTURE_TEAM_ID, name: "spoof" });
      expect.unreachable();
    } catch (e) {
      failure = (e as { failure?: typeof failure }).failure;
    }
    expect(failure).toMatchObject({ table: "apps", op: "upsert_app", code: "42501" }); // real RLS denial, not any error
    expect(await graphCounts(tenantA)).toMatchObject({ apps: SLACK_FIXTURE_EXPECTED.apps }); // unchanged
  }, 30_000);

  it("the active-run lock refuses a concurrent run; the graph is untouched", async () => {
    const held = await recorderA.start({ tenantId: tenantA, source: "slack", connectorId: FIXTURE_CONNECTOR_ID });
    expect(held.ok).toBe(true);
    try {
      const before = await graphCounts(tenantA);
      const r = await runSynthetic(storeA, recorderA, tenantA);
      expect(r.summary.ok).toBe(false);
      expect(r.summary.ok ? "" : r.summary.errorCode).toBe("run_already_active");
      expect(await graphCounts(tenantA)).toEqual(before); // chain never ran → no writes
    } finally {
      if (held.ok) await recorderA.finish({ runId: held.runId, summary: { ok: false, errorCode: "it_cleanup" } });
    }
  }, 30_000);

  it("the run result carries no token / email / name / raw provider payload", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
    const r = await runSynthetic(storeA, recorderA, tenantA);
    for (const s of spies) s.mockRestore();
    const blob = JSON.stringify(r) + "\n" + logs.join("\n");
    for (const needle of [FIXTURE_SLACK_TOKEN, "bob@example.com", "Bob Normal", "carol@example.com", "alice@example.com"]) expect(blob).not.toContain(needle);
  }, 30_000);

  // 0040 absence/stale marking end-to-end (on the clean tenant B — the cross-tenant test wrote nothing there).
  const OBS_1 = OBSERVED, OBS_2 = "2026-07-03T01:00:00.000Z";
  const inst = (t: unknown) => new Date(t as string).getTime(); // compare timestamptz by INSTANT (PG normalizes the string)
  const seenAt = async (ext: string) => (await admin.from("app_users").select("sync_status, last_seen_at, raw_payload").eq("tenant_id", tenantB).eq("external_user_id", ext)).data?.[0];

  it("absence: a first sync leaves everyone active with last_seen_at set (0 stale)", async () => {
    const r = await runSyntheticAt(storeB, recorderB, tenantB, OBS_1);
    expect(r.summary.ok && r.summary.staleMarked).toBe(0);
    const bob = await seenAt("U0000001");
    expect(bob?.sync_status).toBe("active");
    expect(inst(bob?.last_seen_at)).toBe(inst(OBS_1));
    const runs = await admin.from("manual_sync_runs").select("app_users_marked_stale").eq("tenant_id", tenantB);
    expect(runs.data?.[0]?.app_users_marked_stale).toBe(0);
  }, 40_000);

  it("absence: a later sync missing a prior user marks ONLY that user stale — row kept, count recorded, others active", async () => {
    const before = await graphCounts(tenantB);
    const r = await runSyntheticAt(storeB, recorderB, tenantB, OBS_2, ["U0000001"]); // U0000001 (bob) departs
    expect(r.summary.ok && r.summary.staleMarked).toBe(1);
    const bob = await seenAt("U0000001");
    expect(bob?.sync_status).toBe("stale"); // marked, NOT deleted
    expect(inst(bob?.last_seen_at)).toBe(inst(OBS_1)); // last-seen PRESERVED at run-1 (not touched by run 2)
    const u2 = await seenAt("U0000002");
    expect(u2?.sync_status).toBe("active");
    expect(inst(u2?.last_seen_at)).toBe(inst(OBS_2)); // still present → refreshed
    expect(await graphCounts(tenantB)).toEqual(before); // NO hard delete — every row survives
    const staleRun = await admin.from("manual_sync_runs").select("app_users_marked_stale").eq("tenant_id", tenantB).eq("status", "succeeded").order("started_at", { ascending: false }).limit(1);
    expect(staleRun.data?.[0]?.app_users_marked_stale).toBe(1); // persisted audit count
  }, 40_000);

  it("absence: a returning user reactivates; a Slack-deleted-but-present user stays active with slack_is_deleted provenance", async () => {
    const r = await runSyntheticAt(storeB, recorderB, tenantB, "2026-07-03T02:00:00.000Z"); // full fixture again — bob returns
    expect(r.summary.ok).toBe(true);
    expect(await seenAt("U0000001")).toMatchObject({ sync_status: "active" }); // stale → active (reversible)
    const dana = await seenAt("U0000004"); // Slack `deleted:true`, always RETURNED ⇒ present ⇒ active, distinct from absent
    expect(dana).toMatchObject({ sync_status: "active" });
    expect((dana!.raw_payload as Record<string, unknown>).slack_is_deleted).toBe(true);
  }, 40_000);
});
