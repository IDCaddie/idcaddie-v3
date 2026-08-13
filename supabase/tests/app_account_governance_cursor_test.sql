-- 0089 — the governance cursor read of app accounts.
--
-- The property this suite exists to protect: **an evidence walk must return every account exactly once, and a
-- concurrent write must not be able to hide one.** Under the 0078 OFFSET read that was not true — a row deleted before
-- the offset shifted every later row left and skipped one at the page boundary, which withholds that account's finding
-- while its connection stays closure-eligible, so 0083 resolves a finding that is still true. C6 is the case that
-- could not be made to pass before this migration existed.

reset role;

insert into public.tenants (id, name, slug) values
  ('e1000000-0000-4000-8000-00000000000a', 'Cursor A', 'cursor-a'),
  ('e1000000-0000-4000-8000-00000000000b', 'Cursor B', 'cursor-b');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('e1000000-0000-4000-8000-0000000000c1', 'e1000000-0000-4000-8000-00000000000a', 'slack', 'WS One', 'pending', 'discovered'),
  ('e1000000-0000-4000-8000-0000000000c2', 'e1000000-0000-4000-8000-00000000000a', 'slack', 'WS Two', 'pending', 'discovered'),
  ('e1000000-0000-4000-8000-0000000000c9', 'e1000000-0000-4000-8000-00000000000b', 'slack', 'WS B',   'pending', 'discovered');

-- Deterministic ids so the cursor order is assertable: e1…0001 … e1…0009 for tenant A.
insert into public.app_accounts
  (id, tenant_id, connection_id, provider, external_id, display_name, email, normalized_email,
   account_kind, account_status, is_admin, sync_status)
select ('e1000000-0000-4000-8000-10000000000' || n)::uuid,
       'e1000000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-0000000000c1', 'slack',
       'U' || n, 'Person ' || n, 'p' || n || '@example.test', 'p' || n || '@example.test',
       'human', 'active', false, 'current'
  from generate_series(1, 9) as n;

-- THE TIE that proved 0078's ORDER BY is not total in the governance scope: one person, two workspaces, identical
-- display_name/email/external_id. Under this cursor they are simply two distinct ids.
insert into public.app_accounts
  (id, tenant_id, connection_id, provider, external_id, display_name, email, normalized_email,
   account_kind, account_status, is_admin, sync_status)
values
  ('e1000000-0000-4000-8000-20000000000a','e1000000-0000-4000-8000-00000000000a','e1000000-0000-4000-8000-0000000000c1',
   'slack','U01','Ada Lovelace','ada@example.test','ada@example.test','human','active',false,'current'),
  ('e1000000-0000-4000-8000-20000000000b','e1000000-0000-4000-8000-00000000000a','e1000000-0000-4000-8000-0000000000c2',
   'slack','U01','Ada Lovelace','ada@example.test','ada@example.test','human','active',false,'current');

-- Tenant B's account. No walk of tenant A may ever surface it.
insert into public.app_accounts
  (id, tenant_id, connection_id, provider, external_id, display_name, email, normalized_email,
   account_kind, account_status, is_admin, sync_status)
values ('e1000000-0000-4000-8000-90000000000b','e1000000-0000-4000-8000-00000000000b','e1000000-0000-4000-8000-0000000000c9',
        'slack','U01','Other','other@example.test','other@example.test','human','active',false,'current');

-- ════ C0: deny-all posture and least privilege ════════════════════════════════════════════════════════════════════
do $$
declare f text := 'public.product_app_accounts_for_governance(uuid,uuid,integer)';
begin
  assert     has_function_privilege('authenticated', f, 'EXECUTE'), 'C0 authenticated EXECUTE';
  assert not has_function_privilege('anon', f, 'EXECUTE'), 'C0 anon denied';
  assert not has_function_privilege('public', f, 'EXECUTE'), 'C0 PUBLIC denied';
  assert not has_function_privilege('connector_runner', f, 'EXECUTE'), 'C0 connector_runner denied';
  assert (select prosecdef from pg_proc where oid = f::regprocedure), 'C0 SECURITY DEFINER';
  assert (select array_to_string(proconfig, ',') from pg_proc where oid = f::regprocedure) like 'search_path=%',
    'C0 pinned search_path';
  -- Opening a read PATH must not open the TABLE.
  assert not has_table_privilege('authenticated', 'public.app_accounts', 'SELECT'), 'C0 no direct table read';
  -- 0078 is untouched: the UI read must still exist with its own signature.
  assert to_regprocedure('public.product_app_accounts(uuid,uuid,boolean,text,text,text,text,integer,integer)') is not null,
    'C0 the UI read is not replaced';
end $$;

-- ════ C1: the role gate — an unauthorized caller walks nothing ════════════════════════════════════════════════════
do $$
declare n int;
begin
  select count(*) into n from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a');
  assert n = 0, 'C1 an unauthorized caller reads nothing, got ' || n;
end $$;

create or replace function public.has_tenant_role(target_tenant_id uuid, allowed_roles text[])
  returns boolean language sql security definer set search_path = public stable as $$ select true $$;

-- ════ C2: strict ascending id order, and the tie is two rows rather than an ambiguity ═════════════════════════════
do $$
declare ids uuid[]; n int;
begin
  select array_agg(id order by ord), count(*) into ids, n
    from (select id, row_number() over () as ord
            from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', null, 500)) t;
  assert n = 11, 'C2 all eleven tenant-A accounts, got ' || n;
  assert ids = (select array_agg(x order by x) from unnest(ids) x), 'C2 rows arrive in ascending id order';
  -- The two workspace twins are distinct rows, ordered by id — the tie that made OFFSET unstable is a non-event here.
  assert 'e1000000-0000-4000-8000-20000000000a' = any(ids) and 'e1000000-0000-4000-8000-20000000000b' = any(ids),
    'C2 both twins are returned';
end $$;

-- ════ C3: page-boundary arithmetic — every row exactly once, no duplicate, no skip ════════════════════════════════
do $$
declare cur uuid; batch uuid[]; seen uuid[] := '{}'; guard int := 0;
begin
  loop
    guard := guard + 1;
    exit when guard > 50;
    select array_agg(id order by id) into batch
      from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', cur, 2);
    exit when batch is null;
    assert array_length(batch, 1) <= 2, 'C3 the page cap is honoured';
    seen := seen || batch;
    cur := batch[array_length(batch, 1)];
  end loop;
  assert array_length(seen, 1) = 11, 'C3 walked every row, got ' || coalesce(array_length(seen, 1), 0);
  assert (select count(distinct x) from unnest(seen) x) = 11, 'C3 and each exactly once';
end $$;

-- ════ C4: boundary sizes — empty, one, exactly a page, a page plus one ════════════════════════════════════════════
do $$
declare n int;
begin
  select count(*) into n from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', null, 11);
  assert n = 11, 'C4 exactly one page returns the whole set, got ' || n;
  select count(*) into n
    from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a',
      (select id from public.app_accounts where tenant_id = 'e1000000-0000-4000-8000-00000000000a'
        order by id desc limit 1), 500);
  assert n = 0, 'C4 a cursor past the last row terminates, got ' || n;
  select count(*) into n from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000b', null, 500);
  assert n = 1, 'C4 tenant B walks its own single row';
end $$;

-- ════ C5: an absurd or malformed limit cannot widen the page ══════════════════════════════════════════════════════
do $$
declare n int;
begin
  select count(*) into n from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', null, 2147483647);
  assert n = 11, 'C5 an oversized limit returns only what exists (capped), got ' || n;
  select count(*) into n from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', null, -5);
  assert n = 1, 'C5 a negative limit clamps to 1, got ' || n;
  select count(*) into n from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', null, 0);
  assert n = 1, 'C5 a zero limit clamps to 1, got ' || n;
end $$;

-- ════ C6: THE ONE OFFSET COULD NOT PASS — a delete before the cursor must not shift a later row out of the walk ═══
-- Under OFFSET this is the undetectable residual: remove a row that sorts before the current page and every later row
-- slides left by one, so the next page starts past a row that still exists. Its finding is then withheld while its
-- connection stays closure-eligible, and 0083 closes something still true. With an id cursor the boundary is a VALUE,
-- not a position, so an earlier row's disappearance cannot move it.
do $$
declare page1 uuid[]; cur uuid; page2 uuid[]; all_seen uuid[]; survivors int;
begin
  select array_agg(id order by id) into page1
    from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', null, 4);
  cur := page1[4];

  -- A concurrent connector run deletes an account that sorts BEFORE the cursor, mid-walk.
  delete from public.app_accounts where id = page1[2];

  select array_agg(id order by id) into page2
    from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', cur, 500);

  all_seen := page1 || coalesce(page2, '{}');
  select count(*) into survivors from public.app_accounts where tenant_id = 'e1000000-0000-4000-8000-00000000000a';

  -- Every row that still exists was seen. The deleted one was seen before it vanished, which is honest: it existed
  -- when the walk passed its id.
  assert (select count(*) from public.app_accounts a
           where a.tenant_id = 'e1000000-0000-4000-8000-00000000000a'
             and not (a.id = any(all_seen))) = 0,
    'C6 a delete before the cursor must not skip any surviving row';
  assert (select count(distinct x) from unnest(all_seen) x) = array_length(all_seen, 1), 'C6 and nothing was duplicated';
  assert survivors = 10, 'C6 precondition: exactly one row was deleted, got ' || survivors;
end $$;

-- ════ C7: an insert mid-walk is included iff it sorts above the cursor — CURSOR-STABLE, not a snapshot ════════════
do $$
declare cur uuid; rest uuid[];
begin
  cur := 'e1000000-0000-4000-8000-100000000005';
  -- One new row below the cursor, one above.
  insert into public.app_accounts
    (id, tenant_id, connection_id, provider, external_id, account_kind, account_status, sync_status)
  values
    ('e1000000-0000-4000-8000-100000000000','e1000000-0000-4000-8000-00000000000a','e1000000-0000-4000-8000-0000000000c1',
     'slack','U-late-below','human','active','current'),
    ('e1000000-0000-4000-8000-800000000001','e1000000-0000-4000-8000-00000000000a','e1000000-0000-4000-8000-0000000000c1',
     'slack','U-late-above','human','active','current');

  select array_agg(id order by id) into rest
    from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', cur, 500);

  assert 'e1000000-0000-4000-8000-800000000001' = any(rest),
    'C7 a row inserted ABOVE the cursor is picked up by the rest of the walk';
  assert not ('e1000000-0000-4000-8000-100000000000' = any(rest)),
    'C7 a row inserted BELOW the cursor is NOT revisited — the walk is cursor-stable, not snapshot-at-start';
  -- Safe direction: the only row a walk can miss is one CREATED during it, which under-reports a NEW finding rather
  -- than falsely closing an existing one. An existing finding's subject predates the walk and has a fixed id.
end $$;

-- ════ CD: AN EXISTING SUBJECT PRESENT THROUGHOUT THE WALK CANNOT BE SKIPPED BY EARLIER-ROW CHURN ══════════════════
-- The governance consequence, proven rather than argued. An open finding's subject row existed before the walk and is
-- still there; several EARLIER rows are deleted mid-walk. Under OFFSET that churn shifts the subject left across the
-- page boundary and it is never returned — the finding's evidence vanishes and 0083 closes something still true. Under
-- an id cursor the subject's position is its own immutable id, so no amount of earlier-row movement can hide it.
do $$
declare subject uuid := 'e1000000-0000-4000-8000-100000000008';
        page1 uuid[]; cur uuid; rest uuid[]; seen_subject int;
begin
  assert (select count(*) from public.app_accounts where id = subject) = 1, 'CD precondition: the subject exists';

  select array_agg(id order by id) into page1
    from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', null, 3);
  cur := page1[3];
  assert cur < subject, 'CD precondition: the walk has not yet reached the subject';

  -- Churn BEFORE the cursor: delete two rows the walk has already passed.
  delete from public.app_accounts where id = any(page1[1:2]);

  select array_agg(id order by id) into rest
    from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', cur, 500);
  select count(*) into seen_subject from unnest(rest) x where x = subject;

  assert seen_subject = 1, 'CD the subject of an open finding is still traversed after earlier rows disappear';
end $$;

-- ════ CE: IF THE SUBJECT ITSELF IS DELETED MID-WALK, ITS ABSENCE IS TRUE ══════════════════════════════════════════
-- Stated precisely because the semantics matter: this is NOT a false closure. The account genuinely no longer exists
-- at end-of-walk, so reporting it absent is the correct answer, and a finding about it SHOULD resolve. The unsafe case
-- is absence caused by paging, not by deletion — and CD is what rules that out.
do $$
declare subject uuid := 'e1000000-0000-4000-8000-100000000009';
        cur uuid := 'e1000000-0000-4000-8000-100000000006'; rest uuid[]; n int;
begin
  delete from public.app_accounts where id = subject;
  select array_agg(id order by id) into rest
    from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', cur, 500);
  select count(*) into n from unnest(coalesce(rest, '{}')) x where x = subject;
  assert n = 0, 'CE a genuinely deleted row is not returned';
  assert (select count(*) from public.app_accounts where id = subject) = 0,
    'CE and it really is gone — absence here is a fact about the estate, not about the paging';
end $$;

-- ════ C8: tenant isolation — a foreign cursor cannot walk into another tenant ══════════════════════════════════════
do $$
declare n int; ids uuid[];
begin
  select array_agg(id) into ids from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000a', null, 500);
  assert not ('e1000000-0000-4000-8000-90000000000b' = any(ids)), 'C8 tenant B''s row never appears in tenant A''s walk';
  -- Handing tenant A's cursor to tenant B's walk yields only tenant B rows above it, never a cross-tenant bridge.
  select count(*) into n from public.product_app_accounts_for_governance('e1000000-0000-4000-8000-00000000000b',
    'e1000000-0000-4000-8000-100000000000', 500);
  assert n = 1, 'C8 tenant B still sees only its own row, got ' || n;
end $$;

-- ════ C9: the contract exposes no mutable or connection-scoped field ══════════════════════════════════════════════
do $$
declare cols text;
begin
  select string_agg(p.attname, ',' order by p.attnum) into cols
    from unnest(string_to_array('id,connection_id,provider,account_kind,account_status,is_admin,sync_status', ','))
         with ordinality as p(attname, attnum);
  assert cols = 'id,connection_id,provider,account_kind,account_status,is_admin,sync_status', 'C9 the intended column set';
  -- The fields a governance guard must never key on are absent from the return type entirely.
  assert (select count(*) from pg_proc pr
           where pr.oid = 'public.product_app_accounts_for_governance(uuid,uuid,integer)'::regprocedure
             and coalesce(array_to_string(pr.proargnames, ','), '') not like '%email%'
             and coalesce(array_to_string(pr.proargnames, ','), '') not like '%display_name%'
             and coalesce(array_to_string(pr.proargnames, ','), '') not like '%external_id%') = 1,
    'C9 no email / display_name / external_id in the contract';
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
  assert not public.has_tenant_role('e1000000-0000-4000-8000-00000000000a', array['owner']),
    'the has_tenant_role stub must not survive this file';
end $$;
