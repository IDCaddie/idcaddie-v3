-- ============================================================================
-- staging_sync_review_stale_verification.sql
-- STAGING-ONLY synthetic fixture for Sync Review STALE / REPEAT-NO-OP human testing.
--
--   ⚠️  HUMAN, SQL-EDITOR APPLICATION ONLY. An agent must NEVER apply this (no psql, no
--       DB URL, no hosted command). Paste it into the STAGING Supabase SQL editor by hand.
--   ⚠️  Apply ONLY to staging (ycdpzduxugdsffjqyoai). NEVER to production
--       (dzbfxulvxchdemcettrx). This file targets no ref itself; the human confirms the SQL
--       editor is pointed at the staging project before running.
--   ⚠️  SYNTHETIC verification data — NOT customer data, no real identifiers/PII.
--
-- PURPOSE — the STALE / 0-row no-op path (two browser tabs):
--   Seeds EXACTLY ONE new synthetic PENDING batch (2 rows) sharing a NEW run id
--   5a9e0000-0000-0000-0000-0000000000f0. Open /connectors/review in TWO tabs, both showing
--   this pending batch; reject it in tab 1 (2 rows transition pending → rejected); then, in the
--   now-STALE tab 2, reject the SAME batch again — the guarded pending-only UPDATE matches 0
--   rows, proving the stale / no-op path ("No pending items changed", 0 rows transitioned).
--
-- WHAT IT CREATES (reserved synthetic id namespace `5a9e…`, provider `test_fixture`):
--   • EXACTLY 2 `public.discovery_facts` rows, review_status='pending', one new source_run_id.
--   • NO connector_runs row (source_run_id has NO foreign key — 0025 — so none is required).
--
-- TABLES TOUCHED: public.discovery_facts (INSERT only, 2 rows). Nothing else. NO migration, NO
-- RLS/trigger/grant change, NO Storage, NO promotion, NO UPDATE, NO DELETE (the rollback block
-- is commented out). Idempotent (`on conflict do nothing`) — re-run inserts nothing.
--
-- NEVER TOUCHES: the live confirmed run 25bda7ae-… or the 5a9d… reject fixture rows/run. This
-- fixture only INSERTs brand-new `5a9e…` rows and raises if its run id ever equals the live run
-- or the reject-fixture run. The 0042 audit trigger is AFTER UPDATE — an INSERT does not fire it,
-- so seeding writes NO audit rows (audit is produced later, by the reviewer's reject UPDATE).
-- ============================================================================

do $$
declare
  v_tenant uuid;
  v_cnt    int;
  v_run    uuid := '5a9e0000-0000-0000-0000-0000000000f0';  -- reserved synthetic run id for the stale test
  v_live   uuid := '25bda7ae-3698-4976-b347-2132fc56dcca';  -- the live confirmed run — must NEVER be touched
  v_reject uuid := '5a9d0000-0000-0000-0000-0000000000f0';  -- the 5a9d reject fixture run — must NEVER be touched
begin
  -- (a) Resolve "Storage Verifier Tenant A" safely: count first, abort on 0 or >1, THEN
  --     `select id into strict` (which itself re-asserts exactly one row — fail-closed).
  select count(*) into v_cnt from public.tenants where name = 'Storage Verifier Tenant A';
  if v_cnt = 0 then
    raise exception 'FIXTURE ABORT: tenant "Storage Verifier Tenant A" not found on this database — refusing to seed.';
  elsif v_cnt > 1 then
    raise exception 'FIXTURE ABORT: tenant name "Storage Verifier Tenant A" is ambiguous (% rows) — refusing to seed.', v_cnt;
  end if;
  select id into strict v_tenant from public.tenants where name = 'Storage Verifier Tenant A';

  -- (b) Guard: the synthetic run id must never collide with the live run or the reject fixture run.
  if v_run = v_live or v_run = v_reject then
    raise exception 'FIXTURE ABORT: synthetic run id collides with the live run or the reject fixture run — refusing.';
  end if;

  -- (c) Insert EXACTLY 2 pending synthetic facts sharing the new run id. Deterministic synthetic
  --     ids / signal_id / natural_key (5a9e namespace, stale_verification); synthetic-only fact_json.
  --     `on conflict do nothing` catches both the (id,tenant_id) unique and the
  --     (tenant_id,source_provider,fact_type,signal_id) idem index, so a re-run inserts nothing.
  insert into public.discovery_facts
    (id, tenant_id, schema_version, fact_type, source_type, source_provider, source_run_id,
     signal_id, natural_key, observed_at, review_status, fact_json)
  values
    ('5a9e0000-0000-0000-0000-0000000000f1', v_tenant, '1', 'app_user_account', 'unknown_source', 'test_fixture', v_run,
     'synthetic:stale_verification:f1', 'synthetic:stale_verification:f1', now(), 'pending',
     '{"synthetic":true,"fixture":"stale_verification"}'::jsonb),
    ('5a9e0000-0000-0000-0000-0000000000f2', v_tenant, '1', 'app_user_account', 'unknown_source', 'test_fixture', v_run,
     'synthetic:stale_verification:f2', 'synthetic:stale_verification:f2', now(), 'pending',
     '{"synthetic":true,"fixture":"stale_verification"}'::jsonb)
  on conflict do nothing;

  raise notice 'Seeded synthetic pending batch (run 5a9e0000-…-f0, provider test_fixture, 2 rows) for the stale/no-op test, tenant %.', v_tenant;
end $$;

-- ============================================================================
-- COUNT-ONLY VERIFICATION (run after applying — NEVER selects fact_json or any row body).
-- ============================================================================

-- V1 — the new synthetic stale batch: provider / fact_type / opaque run id / pending count (expect 2).
select source_provider,
       fact_type,
       source_run_id,
       count(*) as pending
from public.discovery_facts
where source_run_id = '5a9e0000-0000-0000-0000-0000000000f0'
  and review_status = 'pending'
group by source_provider, fact_type, source_run_id;

-- V2 — the tenant's overall review_status totals BEFORE the stale test (expect: pending 2,
--      confirmed 3, rejected 2 — the new stale batch + the live confirmed batch + the already
--      rejected reject-fixture batch). Counts only; scoped to Storage Verifier Tenant A.
select df.review_status, count(*) as n
from public.discovery_facts df
join public.tenants t on t.id = df.tenant_id
where t.name = 'Storage Verifier Tenant A'
group by df.review_status
order by df.review_status;

-- V3 — safety: the live confirmed run is untouched (expect confirmed 3, pending 0 for it).
select review_status, count(*) as n
from public.discovery_facts
where source_run_id = '25bda7ae-3698-4976-b347-2132fc56dcca'
group by review_status;

-- ============================================================================
-- OPTIONAL ROLLBACK — COMMENTED OUT (this fixture, as applied, DELETES NOTHING).
-- Uncomment and run by hand ONLY to remove the two synthetic stale-fixture rows. Triple-scoped
-- (deterministic 5a9e ids AND the 5a9e run id AND the test_fixture provider), so it cannot touch
-- the live run, the 5a9d reject rows, any confirmed row, or any non-fixture data.
-- ============================================================================
-- delete from public.discovery_facts
-- where id in ('5a9e0000-0000-0000-0000-0000000000f1', '5a9e0000-0000-0000-0000-0000000000f2')
--   and source_run_id = '5a9e0000-0000-0000-0000-0000000000f0'
--   and source_provider = 'test_fixture';
