-- Phase 18C — the matcher's SEAM against the real database.
--
-- The TypeScript suites drive a fake io, which proves the orchestration logic and proves nothing about whether the
-- RPCs it calls actually accept those arguments and return those literals. This file is the narrow proof that the
-- adapter and the merged contracts agree: the exact signatures, the exact status vocabulary, and the exact state
-- transitions the matcher depends on. It deliberately does NOT re-test 0090's own matrix.

reset role;

insert into public.tenants (id, name, slug) values ('b7000000-0000-4000-8000-00000000000a', 'Matcher A', 'matcher-a');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('b7000000-0000-4000-8000-0000000000c1', 'b7000000-0000-4000-8000-00000000000a', 'okta', 'Okta A', 'pending', 'discovered');

insert into public.app_products (id, tenant_id, name, normalized_name) values
  ('b7000000-0000-4000-8000-0000000000e1', 'b7000000-0000-4000-8000-00000000000a', 'Slack', 'slack');
insert into public.apps (id, tenant_id, name, canonical_app_id) values
  ('b7000000-0000-4000-8000-0000000000f1', 'b7000000-0000-4000-8000-00000000000a', 'Slack (prod)', 'b7000000-0000-4000-8000-0000000000e1');
insert into public.directory_applications
  (id, tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('b7000000-0000-4000-8000-0000000000d1','b7000000-0000-4000-8000-00000000000a','b7000000-0000-4000-8000-0000000000c1',
   'okta','APP-1','Slack','current');
insert into public.app_aliases (tenant_id, app_product_id, alias_type, alias_value, review_status) values
  ('b7000000-0000-4000-8000-00000000000a','b7000000-0000-4000-8000-0000000000e1','provider_app_id','APP-1','confirmed');

create or replace function public.has_tenant_role(target_tenant_id uuid, allowed_roles text[])
  returns boolean language sql security definer set search_path = public stable as $$ select true $$;

-- ════ D1/D2: the adapter's ARGUMENTS match the merged signatures ══════════════════════════════════════════════════
-- If either signature changes, the matcher's io layer breaks at runtime and every mocked test stays green. Calling
-- both with EXACTLY the argument lists the adapter sends is the cheapest way to make that impossible.
do $$
declare n int;
begin
  select count(*) into n from public.product_list_directory_applications(
    'b7000000-0000-4000-8000-00000000000a'::uuid, null::uuid, null::text, false, null::uuid, 100);
  assert n = 1, format('D1 census signature + current-only filter, got %s', n);

  select count(*) into n from public.product_application_match_candidates(
    'b7000000-0000-4000-8000-00000000000a'::uuid, null::uuid, 200);
  assert n = 1, format('D2 candidate signature, got %s', n);
end $$;

-- ════ D3/D4: the proposal accepts canonical_product and creates a PROPOSED row, never an accepted one ═════════════
do $$
declare r jsonb; st text;
begin
  r := public.product_propose_application_match(
    'b7000000-0000-4000-8000-00000000000a', 'b7000000-0000-4000-8000-0000000000d1',
    'b7000000-0000-4000-8000-0000000000f1', 'canonical_product', 'medium');
  assert r ->> 'status' = 'proposed', format('D3 canonical_product is accepted as a method, got %s', r ->> 'status');

  select status into st from public.application_matches
   where tenant_id = 'b7000000-0000-4000-8000-00000000000a'
     and directory_application_id = 'b7000000-0000-4000-8000-0000000000d1';
  assert st = 'proposed', format('D4 the matcher can only ever create PROPOSED, got %s', st);

  -- A replay returns the already_ vocabulary the orchestrator switches on.
  r := public.product_propose_application_match(
    'b7000000-0000-4000-8000-00000000000a', 'b7000000-0000-4000-8000-0000000000d1',
    'b7000000-0000-4000-8000-0000000000f1', 'canonical_product', 'medium');
  assert r ->> 'status' = 'already_proposed', format('D4 replay vocabulary, got %s', r ->> 'status');
end $$;

-- ════ D5/D6: a human decision survives replay, in both directions ═════════════════════════════════════════════════
do $$
declare r jsonb; st text;
begin
  update public.application_matches set status = 'rejected', decided_at = now()
   where tenant_id = 'b7000000-0000-4000-8000-00000000000a';
  r := public.product_propose_application_match(
    'b7000000-0000-4000-8000-00000000000a', 'b7000000-0000-4000-8000-0000000000d1',
    'b7000000-0000-4000-8000-0000000000f1', 'canonical_product', 'medium');
  assert r ->> 'status' = 'already_rejected', format('D5 rejection is reported, got %s', r ->> 'status');
  select status into st from public.application_matches where tenant_id = 'b7000000-0000-4000-8000-00000000000a';
  assert st = 'rejected', 'D5 and a replay never resurrects a rejected relationship';

  update public.application_matches set status = 'accepted', decided_at = now()
   where tenant_id = 'b7000000-0000-4000-8000-00000000000a';
  r := public.product_propose_application_match(
    'b7000000-0000-4000-8000-00000000000a', 'b7000000-0000-4000-8000-0000000000d1',
    'b7000000-0000-4000-8000-0000000000f1', 'canonical_product', 'medium');
  assert r ->> 'status' = 'already_accepted', format('D6 acceptance is reported, got %s', r ->> 'status');
  select status into st from public.application_matches where tenant_id = 'b7000000-0000-4000-8000-00000000000a';
  assert st = 'accepted', 'D6 and a replay never downgrades an accepted decision back to proposed';
end $$;

-- ════ D7/D8: the exact state transitions the orchestrator branches on ═════════════════════════════════════════════
do $$
declare r jsonb; st text; completed boolean;
begin
  -- start -> complete
  r := public.product_start_application_matcher_run('b7000000-0000-4000-8000-00000000000a');
  assert r ? 'status' or r ? 'updated', 'D7 start returns a bounded object';
  r := public.product_complete_application_matcher_run('b7000000-0000-4000-8000-00000000000a');
  assert (r ->> 'updated')::int = 1, format('D7 complete transitions exactly once, got %s', r ->> 'updated');
  select s.status, s.has_completed into st, completed
    from public.product_application_matcher_state('b7000000-0000-4000-8000-00000000000a') s;
  assert st = 'completed' and completed, format('D7 state reads completed, got %s', st);

  -- A second complete with no run in flight does not transition — the orchestrator treats that 0 as a failure.
  r := public.product_complete_application_matcher_run('b7000000-0000-4000-8000-00000000000a');
  assert (r ->> 'updated')::int = 0, 'D7 completing a finished run moves nothing';

  -- start -> fail
  r := public.product_start_application_matcher_run('b7000000-0000-4000-8000-00000000000a');
  r := public.product_fail_application_matcher_run('b7000000-0000-4000-8000-00000000000a');
  assert (r ->> 'updated')::int = 1, format('D8 fail transitions, got %s', r ->> 'updated');
  select s.status into st from public.product_application_matcher_state('b7000000-0000-4000-8000-00000000000a') s;
  assert st = 'failed', format('D8 state reads failed, got %s', st);
end $$;

-- ════ D9/D10: only a COMPLETED run licenses Rule 5 ════════════════════════════════════════════════════════════════
-- The engine gates on `status = 'completed'` and deliberately NOT on `last_completed_at`, which survives a later
-- failure. This pins the two states the matcher can leave behind, from the database side.
do $$
declare st text; completed boolean;
begin
  -- The run above ended FAILED, and an earlier one had completed, so last_completed_at is set while status is not.
  select s.status, s.has_completed into st, completed
    from public.product_application_matcher_state('b7000000-0000-4000-8000-00000000000a') s;
  assert st = 'failed', 'D9 precondition: the latest run failed';
  assert completed, 'D9 precondition: an earlier run had completed, so the timestamp is set';
  -- D9: a failed latest run must not license Rule 5 even though a completion happened once. The engine reads `status`.
  assert st <> 'completed', 'D9 a failed run does not present itself as completed';

  -- D10: a fresh successful run puts it back.
  perform public.product_start_application_matcher_run('b7000000-0000-4000-8000-00000000000a');
  perform public.product_complete_application_matcher_run('b7000000-0000-4000-8000-00000000000a');
  select s.status into st from public.product_application_matcher_state('b7000000-0000-4000-8000-00000000000a') s;
  assert st = 'completed', 'D10 a completed run licenses the current Rule 5 gate';
end $$;

-- This file seeds `application_matcher_state` and `application_matches` rows. Every suite shares one database, and
-- governance_canonical_read_boundary_test's B1 asserts a GLOBAL count on the matcher-state table (an unfiltered "a
-- refused call wrote nothing"). Alphabetically this file runs first, so its fixture would fail a later file's
-- assertion. Clean up our own tenant rather than weaken theirs.
delete from public.application_matcher_state where tenant_id = 'b7000000-0000-4000-8000-00000000000a';
delete from public.application_matches where tenant_id = 'b7000000-0000-4000-8000-00000000000a';

-- Restore the real gate VERBATIM from 0001 so a later test file in the same run cannot inherit the stub.
create or replace function public.has_tenant_role(target_tenant_id uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.tenant_memberships tm
    where tm.tenant_id = target_tenant_id
      and tm.user_id = auth.uid()
      and tm.status = 'active'
      and tm.role = any(allowed_roles)
  );
$$;

do $$
begin
  assert not public.has_tenant_role('b7000000-0000-4000-8000-00000000000a', array['owner']),
    'the has_tenant_role stub must not survive this file';
end $$;
