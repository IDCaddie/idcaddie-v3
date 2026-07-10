-- ============================================================================
-- staging_sync_review_reject_verification.sql
-- STAGING-ONLY synthetic fixture for Sync Review REJECT + STALE/NO-OP human testing.
--
--   ⚠️  HUMAN, SQL-EDITOR APPLICATION ONLY. An agent must NEVER apply this (no psql, no
--       DB URL, no hosted command). Paste it into the STAGING Supabase SQL editor by hand.
--   ⚠️  Apply ONLY to staging (ycdpzduxugdsffjqyoai). NEVER to production
--       (dzbfxulvxchdemcettrx). This file targets no ref itself; the human is responsible
--       for confirming the SQL editor is pointed at the staging project before running.
--   ⚠️  SYNTHETIC verification data — NOT customer data, no real identifiers/PII. Applying it
--       does NOT close any risk and does NOT approve cutover.
--
-- WHAT IT CREATES (all in the reserved synthetic id namespace `5a9d…`, provider `test_fixture`):
--   • EXACTLY 2 `public.discovery_facts` rows, review_status='pending', sharing ONE new
--     synthetic `source_run_id` = 5a9d0000-0000-0000-0000-0000000000f0 — i.e. one new pending
--     "batch" (provider test_fixture, fact_type app_user_account) so the reviewer can:
--       – reject the batch (2 rows transition pending → rejected), then
--       – repeat-reject the same batch to prove the stale / 0-row no-op path.
--   • NO connector_runs row: `discovery_facts.source_run_id` has NO foreign key (0025 — "a free
--     uuid — no FK"), so a valid connector_runs row is NOT required. None is created (nothing
--     extra touched).
--
-- TABLES TOUCHED: public.discovery_facts (INSERT only, 2 rows). Nothing else. NO migration, NO
-- RLS/trigger/grant change, NO Storage, NO promotion to app_users/people/identity_matches, NO
-- UPDATE, NO DELETE. Idempotent (`on conflict do nothing`) — safe to re-run (never duplicates).
-- Applied as the privileged SQL-editor role (RLS bypassed for SEED only; the app's RLS still
-- governs every read + the reviewer's confirm/reject writes).
--
-- NEVER TOUCHES: the live confirmed run 25bda7ae-3698-4976-b347-2132fc56dcca or any existing
-- discovery_facts row (this fixture only INSERTs brand-new rows in the `5a9d…` namespace and
-- raises if its run id ever equals the live run id).
--
-- The 0042 audit trigger is AFTER UPDATE OF review_status/... — an INSERT does NOT fire it, so
-- seeding produces NO audit rows (audit is produced later, by the reviewer's reject UPDATE).
-- ============================================================================

do $$
declare
  v_tenant uuid;
  v_cnt    int;
  v_run    uuid := '5a9d0000-0000-0000-0000-0000000000f0';  -- reserved synthetic run id (≠ any live run)
  v_live   uuid := '25bda7ae-3698-4976-b347-2132fc56dcca';  -- the live confirmed run — must NEVER be touched
begin
  -- (a) Resolve "Storage Verifier Tenant A" safely; fail closed if missing or ambiguous.
  select count(*), min(id) into v_cnt, v_tenant from public.tenants where name = 'Storage Verifier Tenant A';
  if v_cnt = 0 then
    raise exception 'FIXTURE ABORT: tenant "Storage Verifier Tenant A" not found on this database — refusing to seed.';
  elsif v_cnt > 1 then
    raise exception 'FIXTURE ABORT: tenant name "Storage Verifier Tenant A" is ambiguous (% rows) — refusing to seed.', v_cnt;
  end if;

  -- (b) Guard: the synthetic run id must never collide with the live confirmed run id.
  if v_run = v_live then
    raise exception 'FIXTURE ABORT: synthetic run id collides with the live run id — refusing.';
  end if;

  -- (c) Insert EXACTLY 2 pending synthetic facts sharing the new run id. Deterministic synthetic
  --     ids / signal_id / natural_key; synthetic-only fact_json (no personal or external data).
  --     `on conflict do nothing` catches BOTH the (id,tenant_id) unique and the
  --     (tenant_id,source_provider,fact_type,signal_id) idem index, so a re-run inserts nothing.
  insert into public.discovery_facts
    (id, tenant_id, schema_version, fact_type, source_type, source_provider, source_run_id,
     signal_id, natural_key, observed_at, review_status, fact_json)
  values
    ('5a9d0000-0000-0000-0000-0000000000f1', v_tenant, '1', 'app_user_account', 'unknown_source', 'test_fixture', v_run,
     'synthetic:reject_verification:f1', 'synthetic:reject_verification:f1', now(), 'pending',
     '{"synthetic":true,"fixture":"reject_verification"}'::jsonb),
    ('5a9d0000-0000-0000-0000-0000000000f2', v_tenant, '1', 'app_user_account', 'unknown_source', 'test_fixture', v_run,
     'synthetic:reject_verification:f2', 'synthetic:reject_verification:f2', now(), 'pending',
     '{"synthetic":true,"fixture":"reject_verification"}'::jsonb)
  on conflict do nothing;

  raise notice 'Seeded synthetic pending batch (run 5a9d0000-…-f0, provider test_fixture, 2 rows) for tenant %.', v_tenant;
end $$;

-- ============================================================================
-- COUNT-ONLY VERIFICATION (run after applying — NEVER selects fact_json or any row body).
-- ============================================================================

-- V1 — the new synthetic batch: provider / fact_type / opaque run id / pending count (expect 2).
select source_provider,
       fact_type,
       source_run_id,
       count(*) as pending
from public.discovery_facts
where source_run_id = '5a9d0000-0000-0000-0000-0000000000f0'
  and review_status = 'pending'
group by source_provider, fact_type, source_run_id;

-- V2 — the tenant's overall review_status totals (expect after seeding: pending 2, confirmed 3,
--      rejected 0). Counts only; scoped to Storage Verifier Tenant A.
select df.review_status, count(*) as n
from public.discovery_facts df
join public.tenants t on t.id = df.tenant_id
where t.name = 'Storage Verifier Tenant A'
group by df.review_status
order by df.review_status;

-- V3 — safety check: the live confirmed run is untouched (expect confirmed 3, pending 0 for it).
select review_status, count(*) as n
from public.discovery_facts
where source_run_id = '25bda7ae-3698-4976-b347-2132fc56dcca'
group by review_status;

-- ============================================================================
-- OPTIONAL ROLLBACK — COMMENTED OUT (this fixture, as applied, DELETES NOTHING).
-- Uncomment and run by hand ONLY to remove the two synthetic fixture rows. It is triple-scoped
-- (deterministic synthetic ids AND the synthetic run id AND the test_fixture provider), so it
-- cannot touch the live run, any confirmed row, or any non-fixture data.
-- ============================================================================
-- delete from public.discovery_facts
-- where id in ('5a9d0000-0000-0000-0000-0000000000f1', '5a9d0000-0000-0000-0000-0000000000f2')
--   and source_run_id = '5a9d0000-0000-0000-0000-0000000000f0'
--   and source_provider = 'test_fixture';
