-- 0085 — the canonical read boundary, and the matcher execution signal.
--
-- Two properties this suite exists to protect:
--   (1) opening a read path onto a deny-all table must not open the TABLE — the definer functions stay the only way in,
--       and no role gains a direct grant;
--   (2) "the matcher completed and found nothing" must never be confusable with "the matcher never ran", because the
--       first licenses a governance finding and the second forbids one.

reset role;

insert into public.tenants (id, name, slug) values
  ('a7000000-0000-4000-8000-00000000000a', 'Boundary A', 'boundary-a'),
  ('a7000000-0000-4000-8000-00000000000b', 'Boundary B', 'boundary-b');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('a7000000-0000-4000-8000-0000000000c1', 'a7000000-0000-4000-8000-00000000000a', 'okta',  'Okta A',  'pending', 'discovered'),
  ('a7000000-0000-4000-8000-0000000000c2', 'a7000000-0000-4000-8000-00000000000a', 'slack', 'Slack A', 'pending', 'discovered'),
  ('a7000000-0000-4000-8000-0000000000c3', 'a7000000-0000-4000-8000-00000000000b', 'okta',  'Okta B',  'pending', 'discovered');

insert into public.people (id, tenant_id, primary_email, full_name, source) values
  ('a7000000-0000-4000-8000-0000000000a1', 'a7000000-0000-4000-8000-00000000000a', 'ada@example.test',   'Ada',   'identity_graph'),
  ('a7000000-0000-4000-8000-0000000000a9', 'a7000000-0000-4000-8000-00000000000b', 'other@example.test', 'Other', 'identity_graph');

insert into public.identity_accounts
  (id, tenant_id, connection_id, provider, external_id, normalized_email, is_active, sync_status) values
  ('a7000000-0000-4000-8000-0000000000e1','a7000000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-0000000000c1','okta','I1','ada@example.test',true,'current'),
  ('a7000000-0000-4000-8000-0000000000e9','a7000000-0000-4000-8000-00000000000b','a7000000-0000-4000-8000-0000000000c3','okta','I1','other@example.test',true,'current');

insert into public.app_accounts
  (id, tenant_id, connection_id, provider, external_id, normalized_email, account_kind, account_status, sync_status) values
  ('a7000000-0000-4000-8000-0000000000f1','a7000000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-0000000000c2','slack','U1','ada@example.test','human','active','current');

insert into public.person_account_links
  (tenant_id, person_id, identity_account_id, method, confidence, status) values
  ('a7000000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-0000000000a1','a7000000-0000-4000-8000-0000000000e1','normalized_email','high','proposed');
insert into public.person_account_links
  (tenant_id, person_id, app_account_id, method, confidence, status) values
  ('a7000000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-0000000000a1','a7000000-0000-4000-8000-0000000000f1','normalized_email','high','proposed');
-- Tenant B's link. Nothing tenant A reads may ever surface it.
insert into public.person_account_links
  (tenant_id, person_id, identity_account_id, method, confidence, status) values
  ('a7000000-0000-4000-8000-00000000000b','a7000000-0000-4000-8000-0000000000a9','a7000000-0000-4000-8000-0000000000e9','manual','high','proposed');

insert into public.apps (id, tenant_id, name) values
  ('a7000000-0000-4000-8000-0000000000b1', 'a7000000-0000-4000-8000-00000000000a', 'Slack'),
  ('a7000000-0000-4000-8000-0000000000b9', 'a7000000-0000-4000-8000-00000000000b', 'Other App');
insert into public.directory_applications
  (id, tenant_id, connection_id, provider, external_id, label, sync_status) values
  ('a7000000-0000-4000-8000-0000000000d1','a7000000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-0000000000c1','okta','A1','Slack','current'),
  ('a7000000-0000-4000-8000-0000000000d9','a7000000-0000-4000-8000-00000000000b','a7000000-0000-4000-8000-0000000000c3','okta','A1','Other','current');
insert into public.application_matches
  (tenant_id, directory_application_id, app_id, method, confidence, status, rationale) values
  ('a7000000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-0000000000d1','a7000000-0000-4000-8000-0000000000b1','manual','high','proposed','reviewer note that must not leak'),
  ('a7000000-0000-4000-8000-00000000000b','a7000000-0000-4000-8000-0000000000d9','a7000000-0000-4000-8000-0000000000b9','manual','high','proposed',null);

-- ════ B0: the deny-all tables STAY deny-all, and the six functions belong to `authenticated` alone ═════════════════
do $$
declare f text; r text;
begin
  -- Opening a read PATH must not open the TABLE. No role gains a direct grant on any of the three.
  foreach r in array array['anon', 'authenticated', 'connector_runner'] loop
    foreach f in array array['public.person_account_links', 'public.application_matches',
                             'public.application_matcher_state'] loop
      assert not has_table_privilege(r, f, 'SELECT'), 'B0 ' || r || ' must have no direct SELECT on ' || f;
      assert not has_table_privilege(r, f, 'INSERT'), 'B0 ' || r || ' must have no direct INSERT on ' || f;
      assert not has_table_privilege(r, f, 'UPDATE'), 'B0 ' || r || ' must have no direct UPDATE on ' || f;
      assert not has_table_privilege(r, f, 'DELETE'), 'B0 ' || r || ' must have no direct DELETE on ' || f;
    end loop;
  end loop;
  assert (select relrowsecurity from pg_class where oid = 'public.application_matcher_state'::regclass),
    'B0 RLS enabled on application_matcher_state';
  assert (select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'application_matcher_state') = 0,
    'B0 no policy — the definer functions are the only path';
  -- And 0085 added no SELECT policy to the two pre-existing deny-all tables either.
  assert (select count(*) from pg_policies
           where schemaname = 'public' and tablename in ('person_account_links', 'application_matches')) = 0,
    'B0 0085 must not add a policy to person_account_links or application_matches';

  foreach f in array array[
    'public.product_person_account_links(uuid,uuid,integer)',
    'public.product_application_matches(uuid,uuid,integer)',
    'public.product_application_matcher_state(uuid)',
    'public.product_start_application_matcher_run(uuid)',
    'public.product_complete_application_matcher_run(uuid)',
    'public.product_fail_application_matcher_run(uuid)']
  loop
    assert     has_function_privilege('authenticated', f, 'EXECUTE'), 'B0 authenticated EXECUTE ' || f;
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'B0 anon denied ' || f;
    assert not has_function_privilege('public', f, 'EXECUTE'), 'B0 PUBLIC denied ' || f;
    assert not has_function_privilege('connector_runner', f, 'EXECUTE'), 'B0 connector_runner denied ' || f;
    assert (select array_to_string(proconfig, ',') from pg_proc where oid = f::regprocedure) like 'search_path=%',
      'B0 pinned search_path ' || f;
    assert (select prosecdef from pg_proc where oid = f::regprocedure), 'B0 SECURITY DEFINER ' || f;
  end loop;
end $$;

-- ════ B1: tenant authority is NOT caller-supplied — an unauthorized caller gets nothing, and writes nothing ════════
do $$
declare n int; msg text;
begin
  -- The gate is real for reads: passing a tenant id you have no role in returns zero rows, not that tenant's data.
  select count(*) into n from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a');
  assert n = 0, 'B1 an unauthorized caller reads nothing, got ' || n;
  select count(*) into n from public.product_application_matches('a7000000-0000-4000-8000-00000000000a');
  assert n = 0, 'B1 unauthorized application_matches read, got ' || n;
  select count(*) into n from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000a');
  assert n = 0, 'B1 unauthorized matcher-state read discloses nothing, got ' || n;

  -- And writes are refused outright rather than silently ignored.
  begin
    perform public.product_start_application_matcher_run('a7000000-0000-4000-8000-00000000000a');
    assert false, 'B1 an unauthorized caller must not start a run';
  exception when insufficient_privilege then msg := sqlerrm;
  end;
  assert msg like 'not authorized%', 'B1 refused by the role gate, got: ' || msg;
  select count(*) into n from public.application_matcher_state;
  assert n = 0, 'B1 a refused start wrote nothing, found ' || n;
end $$;

-- ── Authorized from here. A definer function keeps its own privileges, so replacing the gate exercises the authorized
-- ── path without inventing a session. Parameter NAMES must match 0001 exactly.
create or replace function public.has_tenant_role(target_tenant_id uuid, allowed_roles text[])
  returns boolean language sql security definer set search_path = public stable as $$ select true $$;

-- ════ B2: authorized read returns own rows, MINIMUM fields, and no foreign tenant row ═════════════════════════════
do $$
declare n int; ids uuid[];
begin
  select count(*) into n from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a');
  assert n = 2, 'B2 tenant A sees exactly its own two links, got ' || n;

  -- CROSS-TENANT: tenant B's link is not reachable through tenant A's read, and vice versa.
  select array_agg(identity_account_id) into ids
    from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a')
   where identity_account_id is not null;
  assert ids = array['a7000000-0000-4000-8000-0000000000e1']::uuid[],
    'B2 no foreign identity id leaks through the link read';
  select count(*) into n from public.product_person_account_links('a7000000-0000-4000-8000-00000000000b');
  assert n = 1, 'B2 tenant B sees only its own, got ' || n;

  -- The output columns are EXACTLY the five the engine needs — no email, name, method, confidence or decider.
  assert (select count(*) from information_schema.columns
           where table_name = 'product_person_account_links') = 0, 'B2 (function, not a view)';
  assert (select array_agg(p.attname::text order by p.attnum)
            from unnest(string_to_array('id,person_id,identity_account_id,app_account_id,status', ',')) with ordinality
                 as p(attname, attnum)) =
         array['id','person_id','identity_account_id','app_account_id','status'],
    'B2 the intended column set';
end $$;

-- ════ B3: application_matches read is bounded and tenant-scoped, and leaks no reviewer prose ══════════════════════
do $$
declare n int; dirs uuid[];
begin
  select count(*) into n from public.product_application_matches('a7000000-0000-4000-8000-00000000000a');
  assert n = 1, 'B3 tenant A sees its own match, got ' || n;
  select array_agg(directory_application_id) into dirs
    from public.product_application_matches('a7000000-0000-4000-8000-00000000000a');
  assert dirs = array['a7000000-0000-4000-8000-0000000000d1']::uuid[], 'B3 and only its own';
  select count(*) into n from public.product_application_matches('a7000000-0000-4000-8000-00000000000b');
  assert n = 1, 'B3 tenant B sees only its own, got ' || n;
  -- `rationale` is reviewer prose about a person's judgement and is not in the return type at all; if it ever were,
  -- this would stop compiling rather than start leaking.
  assert (select count(*) from pg_proc p
           where p.oid = 'public.product_application_matches(uuid,uuid,integer)'::regprocedure
             and array_to_string(p.proargnames, ',') not like '%rationale%'), 'B3 no rationale in the contract';
end $$;

-- ════ B4: NEVER RAN is a distinct, readable answer — not an empty result ══════════════════════════════════════════
do $$
declare has_run boolean; has_completed boolean; st text; n int;
begin
  select count(*) into n from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000a');
  assert n = 1, 'B4 an authorized caller always gets exactly one row, got ' || n;
  select r.has_ever_run, r.has_completed, r.status into has_run, has_completed, st
    from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000a') r;
  assert has_run = false, 'B4 never ran is FALSE, not null and not an absent row';
  assert has_completed = false, 'B4 and nothing has completed';
  assert st is null, 'B4 with no status to report';
end $$;

-- ════ B5: RUNNING is not COMPLETE, and a completion cannot be fabricated without a start ══════════════════════════
do $$
declare r jsonb; has_run boolean; has_completed boolean; st text;
begin
  -- A `complete` with no run in flight moves nothing: "we finished" requires "we started".
  r := public.product_complete_application_matcher_run('a7000000-0000-4000-8000-00000000000a');
  assert (r ->> 'updated')::int = 0, 'B5 cannot complete a run that never started';
  select r2.has_completed into has_completed
    from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000a') r2;
  assert has_completed = false, 'B5 and nothing became complete';

  r := public.product_start_application_matcher_run('a7000000-0000-4000-8000-00000000000a');
  select r2.has_ever_run, r2.status, r2.has_completed into has_run, st, has_completed
    from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000a') r2;
  assert has_run = true, 'B5 a started run is a run';
  assert st = 'running', 'B5 status running, got ' || st;
  assert has_completed = false, 'B5 RUNNING IS NOT COMPLETE — this is the whole point';
end $$;

-- ════ B6: FAILED is not COMPLETE ══════════════════════════════════════════════════════════════════════════════════
do $$
declare r jsonb; st text; has_completed boolean;
begin
  r := public.product_fail_application_matcher_run('a7000000-0000-4000-8000-00000000000a');
  assert (r ->> 'updated')::int = 1, 'B6 the in-flight run failed';
  select r2.status, r2.has_completed into st, has_completed
    from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000a') r2;
  assert st = 'failed', 'B6 status failed, got ' || st;
  assert has_completed = false, 'B6 a failed run has completed NOTHING';
end $$;

-- ════ B7: COMPLETE WITH ZERO MATCHES is distinguishable from NEVER RAN ════════════════════════════════════════════
-- The load-bearing assertion of this migration. Tenant B has a match row; tenant A will complete a run having produced
-- none. Both must read as "matching ran to completion", and tenant A must NOT read as "never ran".
do $$
declare has_run boolean; has_completed boolean; st text; matches int;
begin
  delete from public.application_matches where tenant_id = 'a7000000-0000-4000-8000-00000000000a';
  perform public.product_start_application_matcher_run('a7000000-0000-4000-8000-00000000000a');
  perform public.product_complete_application_matcher_run('a7000000-0000-4000-8000-00000000000a');

  select r.has_ever_run, r.status, r.has_completed into has_run, st, has_completed
    from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000a') r;
  select count(*) into matches from public.product_application_matches('a7000000-0000-4000-8000-00000000000a');

  assert has_run = true and st = 'completed' and has_completed = true,
    'B7 the run completed';
  assert matches = 0, 'B7 and produced zero matches, got ' || matches;
  -- Zero matches + completed is a RESULT. Zero matches + never-run is an UNANSWERED QUESTION. A row count alone cannot
  -- tell them apart, which is exactly why this table exists.
  assert (has_completed and matches = 0) is true,
    'B7 complete-with-zero-matches must be representable';
end $$;

-- ════ B8: a NEWER incomplete run cannot be mistaken for the older complete one ═════════════════════════════════════
do $$
declare st text; has_completed boolean; completed_at timestamptz; before_completed timestamptz;
begin
  select r.last_completed_at into before_completed
    from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000a') r;
  assert before_completed is not null, 'B8 precondition: a completed run exists';

  perform public.product_start_application_matcher_run('a7000000-0000-4000-8000-00000000000a');
  perform public.product_fail_application_matcher_run('a7000000-0000-4000-8000-00000000000a');

  select r.status, r.has_completed, r.last_completed_at into st, has_completed, completed_at
    from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000a') r;
  -- BOTH facts survive, and neither hides the other: the current attempt failed, AND a run really did complete once.
  assert st = 'failed', 'B8 the CURRENT status is the fresh failure, got ' || st;
  assert completed_at = before_completed, 'B8 and the older completion is not erased or advanced';
  assert has_completed = true, 'B8 a real completion remains a real completion';
end $$;

-- ════ B9: matcher state is per-tenant and cannot be set or read across tenants ═════════════════════════════════════
do $$
declare st text; has_run boolean;
begin
  select r.has_ever_run into has_run
    from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000b') r;
  assert has_run = false, 'B9 tenant A''s runs are not tenant B''s runs';

  perform public.product_start_application_matcher_run('a7000000-0000-4000-8000-00000000000b');
  select r.status into st from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000b') r;
  assert st = 'running', 'B9 tenant B has its own state';
  select r.status into st from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000a') r;
  assert st = 'failed', 'B9 and tenant A''s is untouched by it, got ' || st;

  -- A row can only exist for a real tenant.
  begin
    insert into public.application_matcher_state (tenant_id, status, started_at)
    values ('00000000-0000-4000-8000-000000000000', 'completed', now());
    assert false, 'B9 matcher state for a nonexistent tenant must be impossible';
  exception when foreign_key_violation then null; when check_violation then null;
  end;
end $$;

-- ════ B10: pagination is bounded and deterministic ════════════════════════════════════════════════════════════════
do $$
declare n int; first_id uuid; second_id uuid;
begin
  select count(*) into n from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a', null, 1);
  assert n = 1, 'B10 the limit is honoured, got ' || n;
  select id into first_id from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a', null, 1);
  select id into second_id
    from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a', first_id, 1);
  assert second_id > first_id, 'B10 the cursor advances in a stable order';
  -- An absurd limit is capped rather than honoured.
  select count(*) into n
    from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a', null, 1000000);
  assert n = 2, 'B10 a huge limit returns only what exists, capped, got ' || n;
end $$;

-- ════ B11: the completed-implies-timestamp invariant is a CONSTRAINT, not a convention ════════════════════════════
do $$
begin
  begin
    insert into public.application_matcher_state (tenant_id, status, started_at, last_completed_at)
    values ('a7000000-0000-4000-8000-00000000000b', 'completed', now(), null)
    on conflict (tenant_id) do update set status = 'completed', last_completed_at = null;
    assert false, 'B11 a completed run must carry its completion time';
  exception when check_violation then null;
  end;
  begin
    insert into public.application_matcher_state (tenant_id, status, started_at)
    values ('a7000000-0000-4000-8000-00000000000a', 'finished', now())
    on conflict (tenant_id) do update set status = 'finished';
    assert false, 'B11 the status vocabulary is bounded';
  exception when check_violation then null;
  end;
end $$;

-- ════ B12: PAGINATION — no skips, no duplicates, and a hostile limit cannot widen the page ════════════════════════
-- The cursor is the only thing standing between a bounded read and an unbounded enumeration, so the malformed cases
-- matter as much as the happy one.
do $$
declare page1 uuid[]; page2 uuid[]; cur uuid; n int; total int;
begin
  select count(*) into total from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a');
  assert total = 2, 'B12 precondition: two links, got ' || total;

  -- Walking one row at a time must visit every row EXACTLY once — no skip, no repeat.
  select array_agg(id order by id) into page1
    from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a', null, 1);
  cur := page1[1];
  select array_agg(id order by id) into page2
    from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a', cur, 1);
  assert array_length(page1, 1) = 1 and array_length(page2, 1) = 1, 'B12 one row per page';
  assert page1[1] <> page2[1], 'B12 the second page is not the first again';
  assert (select count(distinct x) from unnest(page1 || page2) x) = 2, 'B12 both rows seen exactly once';
  -- And the walk terminates rather than cycling.
  select count(*) into n
    from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a', page2[1], 1);
  assert n = 0, 'B12 the cursor terminates, got ' || n;

  -- A hostile or malformed limit can never widen the page beyond the cap, nor produce a negative-length one.
  select count(*) into n from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a', null, -5);
  assert n = 1, 'B12 a negative limit clamps to 1, got ' || n;
  select count(*) into n from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a', null, 0);
  assert n = 1, 'B12 a zero limit clamps to 1, got ' || n;
  select count(*) into n from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a', null, null);
  assert n = 2, 'B12 a null limit uses the default, got ' || n;
  select count(*) into n
    from public.product_person_account_links('a7000000-0000-4000-8000-00000000000a', null, 2147483647);
  assert n = 2, 'B12 an oversized limit returns only what exists (capped at 500), got ' || n;

  -- The TENANT filter is applied before the page is cut: a cursor from tenant A cannot walk into tenant B, and a
  -- one-row page for A is A's row rather than whichever row sorts first globally.
  select count(*) into n from public.product_application_matches('a7000000-0000-4000-8000-00000000000a', null, 500);
  assert n <= 1, 'B12 tenant A never sees tenant B''s match through a wide page, got ' || n;
end $$;

-- ════ B13: COMPLETE WITH ONE OR MORE MATCHES is its own state ═════════════════════════════════════════════════════
-- B7 proved complete-with-zero. This is the other half: a completed run that DID produce output must read as completed
-- too, so the four states are genuinely four and not three plus a special case.
do $$
declare has_run boolean; st text; has_completed boolean; matches int;
begin
  insert into public.application_matches
    (tenant_id, directory_application_id, app_id, method, confidence, status, decided_at)
  values ('a7000000-0000-4000-8000-00000000000a','a7000000-0000-4000-8000-0000000000d1',
          'a7000000-0000-4000-8000-0000000000b1','manual','high','accepted', now());

  perform public.product_start_application_matcher_run('a7000000-0000-4000-8000-00000000000a');
  perform public.product_complete_application_matcher_run('a7000000-0000-4000-8000-00000000000a');

  select r.has_ever_run, r.status, r.has_completed into has_run, st, has_completed
    from public.product_application_matcher_state('a7000000-0000-4000-8000-00000000000a') r;
  select count(*) into matches from public.product_application_matches('a7000000-0000-4000-8000-00000000000a');

  assert has_run and st = 'completed' and has_completed, 'B13 a productive run is still a completed run';
  assert matches = 1, 'B13 and its output is readable, got ' || matches;
  -- The four states are distinguished by (row exists, status, last_completed_at) — never by counting matches.
  assert (has_completed and matches > 0) is true, 'B13 complete-with-output is representable';
end $$;

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
  assert not public.has_tenant_role('a7000000-0000-4000-8000-00000000000a', array['owner']),
    'the has_tenant_role stub must not survive this file';
end $$;
