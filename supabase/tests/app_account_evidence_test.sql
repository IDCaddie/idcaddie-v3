-- 0076 — canonical app-account evidence.
--
-- The property that matters most: a SaaS app account is EVIDENCE, not an identity. Slack members must be unable to become
-- people, connector scoping must hold across workspaces, and matching must be a recorded judgement rather than a merge.

reset role;

insert into public.tenants (id, name, slug) values
  ('8f000000-0000-4000-8000-00000000000a', 'AppAcct A', 'aa-a'), ('8f000000-0000-4000-8000-00000000000b', 'AppAcct B', 'aa-b');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('8f000000-0000-4000-8000-0000000000c1', '8f000000-0000-4000-8000-00000000000a', 'slack', 'Workspace one', 'pending', 'discovered'),
  ('8f000000-0000-4000-8000-0000000000c2', '8f000000-0000-4000-8000-00000000000a', 'slack', 'Workspace two', 'pending', 'discovered'),
  ('8f000000-0000-4000-8000-0000000000c3', '8f000000-0000-4000-8000-00000000000b', 'slack', 'Other tenant',  'pending', 'discovered');

-- ════ A1: Slack accounts are NOT identities ═══════════════════════════════════════════════════════════════════════
do $$
declare n int;
begin
  -- There must be no path from an app account into the identity graph. A foreign key here would be the whole failure.
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.app_accounts'::regclass and c.contype = 'f'
     and pg_get_constraintdef(c.oid) like '%identity_accounts%';
  assert n = 0, 'A1 app_accounts must not reference identity_accounts — an account is evidence, never a person';

  -- And nothing writes a Slack member into the directory.
  select count(*) into n from pg_constraint c
   where c.conrelid = 'public.identity_accounts'::regclass and c.contype = 'f'
     and pg_get_constraintdef(c.oid) like '%app_accounts%';
  assert n = 0, 'A1 identity_accounts must not reference app_accounts either';
end $$;

-- ════ A2: bots and service accounts are categorised, not forced into human ════════════════════════════════════════
do $$
declare
  TA constant uuid := '8f000000-0000-4000-8000-00000000000a';
  C1 constant uuid := '8f000000-0000-4000-8000-0000000000c1';
  blocked boolean; n int;
begin
  insert into public.app_accounts (tenant_id, connection_id, provider, external_id, display_name, email, normalized_email, account_kind, account_status)
  values (TA, C1, 'slack', 'U001', 'Ada', 'ada@example.test', 'ada@example.test', 'human', 'active'),
         (TA, C1, 'slack', 'B001', 'deploybot', null, null, 'bot', 'active'),
         (TA, C1, 'slack', 'U002', 'Departed', 'gone@example.test', 'gone@example.test', 'human', 'deleted');

  select count(*) into n from public.app_accounts where connection_id = C1 and account_kind = 'human';
  assert n = 2, 'A2 a bot must not count as a human account, saw ' || n;
  select count(*) into n from public.app_accounts where connection_id = C1 and account_status = 'deleted';
  assert n = 1, 'A2 a deleted account is retained and labelled, not removed';

  -- An unbucketed provider status cannot be stored: Okta taught us a raw lifecycle token reaches the customer unlabelled.
  blocked := true;
  begin
    insert into public.app_accounts (tenant_id, connection_id, provider, external_id, account_status)
    values (TA, C1, 'slack', 'U099', 'PROVISIONED');
    blocked := false;
  exception when others then null; end;
  assert blocked, 'A2 a raw provider status must be rejected';
end $$;

-- ════ A3: the Phase-2.1 invariant, applied from the start ═════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '8f000000-0000-4000-8000-00000000000a';
  C1 constant uuid := '8f000000-0000-4000-8000-0000000000c1';
  blocked boolean;
begin
  blocked := true;
  begin
    insert into public.app_accounts (tenant_id, connection_id, provider, external_id, sync_status, stale_since)
    values (TA, C1, 'slack', 'U100', 'current', now());
    blocked := false;
  exception when others then null; end;
  assert blocked, 'A3 a current account may not carry a stale timestamp';

  -- A genuinely stale one may.
  insert into public.app_accounts (tenant_id, connection_id, provider, external_id, sync_status, stale_since)
  values (TA, C1, 'slack', 'U101', 'stale', now());
end $$;

-- ════ A4: connector scoping — two workspaces never collide ════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '8f000000-0000-4000-8000-00000000000a';
  C1 constant uuid := '8f000000-0000-4000-8000-0000000000c1';
  C2 constant uuid := '8f000000-0000-4000-8000-0000000000c2';
  g1 uuid; a1 uuid; blocked boolean; n int;
begin
  -- The SAME Slack user id in two workspaces is two different accounts. Uniqueness is per connector, not per tenant.
  insert into public.app_accounts (tenant_id, connection_id, provider, external_id, display_name)
  values (TA, C2, 'slack', 'U001', 'Ada in workspace two');
  select count(*) into n from public.app_accounts where tenant_id = TA and external_id = 'U001';
  assert n = 2, 'A4 the same provider id in two workspaces must be two accounts, saw ' || n;

  -- A duplicate WITHIN one connector is rejected, so upserts are idempotent.
  blocked := true;
  begin
    insert into public.app_accounts (tenant_id, connection_id, provider, external_id) values (TA, C1, 'slack', 'U001');
    blocked := false;
  exception when others then null; end;
  assert blocked, 'A4 a duplicate within one connector must be rejected';

  -- A membership edge cannot cross connectors: composite endpoint FKs, the pattern proven in 0056/0059/0072.
  insert into public.app_account_groups (tenant_id, connection_id, provider, external_id, name)
  values (TA, C1, 'slack', 'S001', 'Engineering') returning id into g1;
  select id into a1 from public.app_accounts where connection_id = C2 and external_id = 'U001';
  blocked := true;
  begin
    insert into public.app_account_group_memberships (tenant_id, connection_id, provider, app_account_group_id, app_account_id)
    values (TA, C1, 'slack', g1, a1);   -- group from C1, account from C2
    blocked := false;
  exception when others then null; end;
  assert blocked, 'A4 an edge must not join rows from two different workspaces';
end $$;

-- ════ A5: matching is a judgement, and never by display name ══════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '8f000000-0000-4000-8000-00000000000a';
  C1 constant uuid := '8f000000-0000-4000-8000-0000000000c1';
  acct uuid; ident uuid; blocked boolean;
begin
  select id into acct from public.app_accounts where connection_id = C1 and external_id = 'U001';
  insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, sync_status)
  values (TA, C1, 'okta', 'ext-ada', 'ada@example.test', 'current') returning id into ident;

  -- Only two methods exist, and neither is a name. Two people share a name; one person changes theirs.
  blocked := true;
  begin
    insert into public.app_account_identity_matches (tenant_id, app_account_id, identity_account_id, method, confidence)
    values (TA, acct, ident, 'display_name', 'high');
    blocked := false;
  exception when others then null; end;
  assert blocked, 'A5 display-name matching must be impossible to record';

  -- A proposal is not a match until someone decides.
  insert into public.app_account_identity_matches (tenant_id, app_account_id, identity_account_id, method, confidence)
  values (TA, acct, ident, 'normalized_email', 'medium');
  blocked := true;
  begin
    update public.app_account_identity_matches set status = 'accepted' where app_account_id = acct;  -- no decided_at
    blocked := false;
  exception when others then null; end;
  assert blocked, 'A5 accepting a match without recording when must be rejected';

  update public.app_account_identity_matches set status = 'accepted', decided_at = now() where app_account_id = acct;

  -- One accepted identity per account…
  blocked := true;
  begin
    insert into public.app_account_identity_matches (tenant_id, app_account_id, identity_account_id, method, confidence, status, decided_at)
    values (TA, acct, ident, 'manual', 'high', 'accepted', now());
    blocked := false;
  exception when others then null; end;
  assert blocked, 'A5 an account may have only one accepted identity';
end $$;

-- ════ A6: one person may hold accounts in many applications ═══════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '8f000000-0000-4000-8000-00000000000a';
  C1 constant uuid := '8f000000-0000-4000-8000-0000000000c1';
  C2 constant uuid := '8f000000-0000-4000-8000-0000000000c2';
  a2 uuid; ident uuid;
begin
  -- Deliberately NOT unique on the identity side: constraining it would mean a person could be matched in Slack OR Zoom but
  -- not both, which is the opposite of what an access review needs.
  select id into ident from public.identity_accounts where connection_id = C1 and external_id = 'ext-ada';
  select id into a2 from public.app_accounts where connection_id = C2 and external_id = 'U001';
  insert into public.app_account_identity_matches (tenant_id, app_account_id, identity_account_id, method, confidence, status, decided_at)
  values (TA, a2, ident, 'normalized_email', 'medium', 'accepted', now());
end $$;

-- ════ A7: capability state records plan and permission limits distinctly ══════════════════════════════════════════
do $$
declare
  TA constant uuid := '8f000000-0000-4000-8000-00000000000a';
  C1 constant uuid := '8f000000-0000-4000-8000-0000000000c1';
  blocked boolean; s text;
begin
  -- A plan limit is NOT a connector failure. Recording it distinctly is what stops one gated endpoint marking an otherwise
  -- healthy connector as broken.
  insert into public.connector_capability_state (tenant_id, connection_id, capability, state, reason_code, last_success_at, observed_count)
  values (TA, C1, 'app_accounts', 'available', null, now(), 3),
         (TA, C1, 'usage', 'plan_dependent', 'requires_business_plus', null, null),
         (TA, C1, 'licenses', 'permission_dependent', 'scope_not_granted', null, null);

  select state into s from public.connector_capability_state where connection_id = C1 and capability = 'usage';
  assert s = 'plan_dependent', 'A7 a plan limit must not be recorded as failed';

  blocked := true;
  begin
    insert into public.connector_capability_state (tenant_id, connection_id, capability, state) values (TA, C1, 'roles', 'green');
    blocked := false;
  exception when others then null; end;
  assert blocked, 'A7 an unbounded state must be rejected';
end $$;

-- ════ A8: nothing is browser-readable ═════════════════════════════════════════════════════════════════════════════
do $$
declare tbl text;
begin
  foreach tbl in array array['app_accounts','app_account_groups','app_account_group_memberships','app_account_identity_matches','connector_capability_state']
  loop
    assert (select relrowsecurity from pg_class where relname = tbl), 'A8 RLS must be on for ' || tbl;
    assert (select count(*) from pg_policies where tablename = tbl) = 0, 'A8 no policy may exist yet for ' || tbl;
  end loop;
  foreach tbl in array array['app_accounts','app_account_groups','app_account_identity_matches','connector_capability_state']
  loop
    assert not has_table_privilege('authenticated', 'public.' || tbl, 'SELECT'), 'A8 authenticated must not read ' || tbl;
    assert not has_table_privilege('anon', 'public.' || tbl, 'SELECT'), 'A8 anon must not read ' || tbl;
    -- The runner writes through definer RPCs, never directly.
    assert not has_table_privilege('connector_runner', 'public.' || tbl, 'INSERT'), 'A8 connector_runner must not write ' || tbl || ' directly';
  end loop;
end $$;

-- ════ A9: no raw payload column anywhere ══════════════════════════════════════════════════════════════════════════
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public'
     and table_name in ('app_accounts','app_account_groups','app_account_group_memberships','connector_capability_state')
     and column_name in ('raw_payload', 'raw_json', 'payload', 'response', 'body');
  assert n = 0, 'A9 no raw provider payload may be persisted, found ' || n || ' column(s)';
end $$;
