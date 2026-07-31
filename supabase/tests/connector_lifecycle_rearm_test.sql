-- 0067 — the lifecycle re-arm that makes discovery repeatable.
--
-- The positive case is one edge. Everything else here is negative: the edges that must STAY closed, the roles that must not be
-- able to move a connector at all, and the guarantee that a re-arm moves a flag and touches nothing else.

begin;

-- ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, slug) values
  ('f0a70000-0000-4000-8000-00000000e001', 'Rearm Tenant A', 'rearm-tenant-a'),
  ('f0a70000-0000-4000-8000-00000000e002', 'Rearm Tenant B', 'rearm-tenant-b')
on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('f0a70000-0000-4000-8000-0000000000a1', 'r-owner-a@example.test'),
  ('f0a70000-0000-4000-8000-0000000000a2', 'r-editor-a@example.test'),
  ('f0a70000-0000-4000-8000-0000000000a3', 'r-viewer-a@example.test')
on conflict (id) do nothing;
insert into public.profiles (id, email) values
  ('f0a70000-0000-4000-8000-0000000000a1', 'r-owner-a@example.test'),
  ('f0a70000-0000-4000-8000-0000000000a2', 'r-editor-a@example.test'),
  ('f0a70000-0000-4000-8000-0000000000a3', 'r-viewer-a@example.test')
on conflict (id) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('f0a70000-0000-4000-8000-00000000e001', 'f0a70000-0000-4000-8000-0000000000a1', 'owner'),
  ('f0a70000-0000-4000-8000-00000000e001', 'f0a70000-0000-4000-8000-0000000000a2', 'editor'),
  ('f0a70000-0000-4000-8000-00000000e001', 'f0a70000-0000-4000-8000-0000000000a3', 'viewer')
on conflict do nothing;

insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state)
values ('f0a70000-0000-4000-8000-00000000c001', 'f0a70000-0000-4000-8000-00000000e001', 'okta', 'Rearm Fixture', 'pending', 'discovered')
on conflict (id) do nothing;

-- ── R0: grant shape — the trusted runner path only ──────────────────────────────────────────────────────────────────
do $$
declare f constant text := 'public.runner_advance_connection_state(uuid,uuid,text,text)';
begin
  assert has_function_privilege('connector_runner', f, 'EXECUTE'), 'R0 connector_runner must hold EXECUTE';
  assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'R0 authenticated must NOT hold EXECUTE';
  assert not has_function_privilege('anon', f, 'EXECUTE'), 'R0 anon must NOT hold EXECUTE';
  assert not has_function_privilege('service_role', f, 'EXECUTE'), 'R0 service_role must NOT hold EXECUTE';
end $$;

-- ── R1: no browser role can move a connector, at any privilege level ───────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"f0a70000-0000-4000-8000-0000000000a1"}', false);
set role authenticated;
do $$ begin
  begin
    perform public.runner_advance_connection_state(
      'f0a70000-0000-4000-8000-00000000c001', 'f0a70000-0000-4000-8000-00000000e001', 'discovered', 'verified');
    raise exception 'R1 an OWNER must not be able to re-arm directly';
  exception when insufficient_privilege then null;
  end;
  -- ...nor by writing the column.
  begin
    update public.connectors set connection_state = 'verified' where id = 'f0a70000-0000-4000-8000-00000000c001';
    -- Hardened by grant OR by RLS; zero rows is equally acceptable.
    if (select connection_state from public.connectors where id = 'f0a70000-0000-4000-8000-00000000c001') = 'verified' then
      raise exception 'R1 an OWNER must not be able to set connection_state directly';
    end if;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"f0a70000-0000-4000-8000-0000000000a2"}', false);
set role authenticated;
do $$ begin
  begin
    perform public.runner_advance_connection_state(
      'f0a70000-0000-4000-8000-00000000c001', 'f0a70000-0000-4000-8000-00000000e001', 'discovered', 'verified');
    raise exception 'R1 an EDITOR must not be able to re-arm';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"f0a70000-0000-4000-8000-0000000000a3"}', false);
set role authenticated;
do $$ begin
  begin
    perform public.runner_advance_connection_state(
      'f0a70000-0000-4000-8000-00000000c001', 'f0a70000-0000-4000-8000-00000000e001', 'discovered', 'verified');
    raise exception 'R1 a VIEWER must not be able to re-arm';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set role anon;
do $$ begin
  begin
    perform public.runner_advance_connection_state(
      'f0a70000-0000-4000-8000-00000000c001', 'f0a70000-0000-4000-8000-00000000e001', 'discovered', 'verified');
    raise exception 'R1 ANON must not be able to re-arm';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ── R2–R6: the transition table itself ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  C constant uuid := 'f0a70000-0000-4000-8000-00000000c001';
  TA constant uuid := 'f0a70000-0000-4000-8000-00000000e001';
  TB constant uuid := 'f0a70000-0000-4000-8000-00000000e002';
  v_state text; v_runs int; v_disc int; v_provider text; v_permitted boolean;
begin
  select count(*) into v_runs from public.connector_runs where connector_id = C;
  select count(*) into v_disc from public.connector_run_discovery d join public.connector_runs r on r.id = d.run_id where r.connector_id = C;

  -- R2: the ONE new edge works.
  perform public.runner_advance_connection_state(C, TA, 'discovered', 'verified');
  select connection_state into v_state from public.connectors where id = C;
  assert v_state = 'verified', 'R2 discovered -> verified must succeed, saw ' || v_state;

  -- R3: a repeat discovery can now actually start, which is the entire point.
  perform public.runner_advance_connection_state(C, TA, 'verified', 'discovery_pending');
  select connection_state into v_state from public.connectors where id = C;
  assert v_state = 'discovery_pending', 'R3 verified -> discovery_pending must still succeed';
  perform public.runner_advance_connection_state(C, TA, 'discovery_pending', 'discovering');
  perform public.runner_advance_connection_state(C, TA, 'discovering', 'discovered');
  select connection_state into v_state from public.connectors where id = C;
  assert v_state = 'discovered', 'R3 a full second cycle must complete';

  -- R4: the SHORTCUTS stay closed. `discovered` may re-enter discovery only through `verified`.
  --
  -- The assert runs OUTSIDE the handler, on a flag set only when the call SUCCEEDS. Raising inside the block and catching it
  -- with `when others` cannot work: `raise exception` is P0001, so the handler swallows the very failure it is meant to report —
  -- these negatives silently passed against a mutated function until the mutation run exposed it.
  v_permitted := false;
  begin
    perform public.runner_advance_connection_state(C, TA, 'discovered', 'discovery_pending');
    v_permitted := true;
  exception when others then null;
  end;
  assert not v_permitted, 'R4 discovered -> discovery_pending must be rejected';

  v_permitted := false;
  begin
    perform public.runner_advance_connection_state(C, TA, 'discovered', 'discovering');
    v_permitted := true;
  exception when others then null;
  end;
  assert not v_permitted, 'R4 discovered -> discovering must be rejected';

  v_permitted := false;
  begin
    perform public.runner_advance_connection_state(C, TA, 'discovered', 'connected_unsynced');
    v_permitted := true;
  exception when others then null;
  end;
  assert not v_permitted, 'R4 discovered -> connected_unsynced must be rejected';
  select connection_state into v_state from public.connectors where id = C;
  assert v_state = 'discovered', 'R4 a rejected transition must not move the connector, saw ' || v_state;

  -- R5: cross-tenant re-arm is refused.
  perform public.runner_advance_connection_state(C, TA, 'discovered', 'verified');
  v_permitted := false;
  begin
    perform public.runner_advance_connection_state(C, TB, 'verified', 'discovery_pending');
    v_permitted := true;
  exception when others then null;
  end;
  assert not v_permitted, 'R5 a cross-tenant transition must be rejected';
  select connection_state into v_state from public.connectors where id = C;
  assert v_state = 'verified', 'R5 a cross-tenant attempt must not move the connector';

  -- R5b: OPTIMISTIC CONCURRENCY. Claiming a p_from that is not the current state must be refused — otherwise a stale caller
  -- could blind-overwrite a connector that has since moved on. The connector is `verified` here; claim `discovered`.
  v_permitted := false;
  begin
    perform public.runner_advance_connection_state(C, TA, 'discovered', 'verified');
    v_permitted := true;
  exception when others then null;
  end;
  assert not v_permitted, 'R5b a transition claiming the wrong p_from must be rejected';
  select connection_state into v_state from public.connectors where id = C;
  assert v_state = 'verified', 'R5b a rejected optimistic transition must not move the connector';

  -- R6: the re-arm moves a FLAG and nothing else — no run, no discovery row, no provider/governance drift.
  select count(*) into v_runs from public.connector_runs where connector_id = C;
  assert v_runs = 0, 'R6 the re-arm must not create a connector run, saw ' || v_runs;
  select count(*) into v_disc from public.connector_run_discovery d join public.connector_runs r on r.id = d.run_id where r.connector_id = C;
  assert v_disc = 0, 'R6 the re-arm must not create a discovery row, saw ' || v_disc;
  select provider into v_provider from public.connectors where id = C;
  assert v_provider = 'okta', 'R6 provider must be untouched';
  -- The function does not name these columns at all; asserting it proves the claim rather than trusting the reading.
  assert (select status from public.connectors where id = C) = 'pending', 'R6 status must be untouched';
end $$;

-- ── R7: the stale gate is unchanged by this migration ──────────────────────────────────────────────────────────────
do $$
declare d text;
begin
  select pg_get_functiondef(oid) into d from pg_proc where proname = 'runner_mark_absent_okta_directory_groups_stale';
  -- Still completeness-gated, still connection-scoped, still latest-run guarded.
  assert d like '%completeness%', 'R7 stale gate must still check completeness';
  assert d like '%connection_id%', 'R7 stale gate must still be connection-scoped';
  assert d like '%last_page%', 'R7 stale gate must still require last_page';
  assert d like '%for update%', 'R7 stale gate must still take the connector lock';
end $$;

select 'ALL O2D.1 LIFECYCLE RE-ARM ASSERTIONS PASSED' as result;

rollback;
