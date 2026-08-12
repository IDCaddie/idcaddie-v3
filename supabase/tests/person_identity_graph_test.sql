-- 0082 — the person layer.
--
-- The property this suite exists to protect: a person link must never cross a tenant, never be guessed from a name or a
-- domain, never accept itself, and never disappear because a connector had a bad morning. Every assertion below is one of
-- those four sentences restated against real rows.

reset role;

insert into public.tenants (id, name, slug) values
  ('c3000000-0000-4000-8000-00000000000a', 'Person A', 'person-a'),
  ('c3000000-0000-4000-8000-00000000000b', 'Person B', 'person-b');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('c3000000-0000-4000-8000-0000000000c1', 'c3000000-0000-4000-8000-00000000000a', 'okta',  'Okta A',  'pending', 'discovered'),
  ('c3000000-0000-4000-8000-0000000000c2', 'c3000000-0000-4000-8000-00000000000a', 'slack', 'Slack A', 'pending', 'discovered'),
  ('c3000000-0000-4000-8000-0000000000c3', 'c3000000-0000-4000-8000-00000000000b', 'okta',  'Okta B',  'pending', 'discovered');

-- Tenant A directory identities.
--   I1 ada@   — the ordinary case, also present in Slack
--   I2 dup@   — TWO identities share one address (the duplicate-account estate), both belong to one person
--   I3 dup@
--   I4 gone@  — stale: the connector no longer confirms it
--   I5 noaddr — no address at all; there is nothing to resolve on
insert into public.identity_accounts
  (id, tenant_id, connection_id, provider, external_id, login, normalized_login, email, normalized_email, display_name, is_active, sync_status, stale_since)
values
  ('c3000000-0000-4000-8000-0000000000e1','c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','okta','I1','ada','ada','Ada@Example.Test','ada@example.test','Ada L',true,'current',null),
  ('c3000000-0000-4000-8000-0000000000e2','c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','okta','I2','dup1','dup1','dup@example.test','dup@example.test','Dup One',true,'current',null),
  ('c3000000-0000-4000-8000-0000000000e3','c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','okta','I3','dup2','dup2','dup@example.test','dup@example.test','Dup Two',true,'current',null),
  ('c3000000-0000-4000-8000-0000000000e4','c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','okta','I4','gone','gone','gone@example.test','gone@example.test','Departed',false,'stale',now()),
  ('c3000000-0000-4000-8000-0000000000e5','c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','okta','I5','noaddr','noaddr',null,null,'No Address',true,'current',null),
  -- Tenant B holds the SAME address. Nothing tenant A proposes may ever touch it.
  ('c3000000-0000-4000-8000-0000000000eb','c3000000-0000-4000-8000-00000000000b','c3000000-0000-4000-8000-0000000000c3','okta','I1','ada','ada','ada@example.test','ada@example.test','Other Ada',true,'current',null);

-- Tenant A SaaS accounts.
--   A1 ada@       — same address as I1: the ordinary join
--   A2 ada.l@     — a DIFFERENT address for the same human; only an accepted match may ever prove that
--   A3 bot@       — a bot: no person behind it
--   A4 stale@     — a stale account
insert into public.app_accounts
  (id, tenant_id, connection_id, provider, external_id, display_name, email, normalized_email, account_kind, account_status, is_admin, sync_status, stale_since)
values
  ('c3000000-0000-4000-8000-0000000000f1','c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c2','slack','U1','Ada Lovelace','ada@example.test','ada@example.test','human','active',false,'current',null),
  ('c3000000-0000-4000-8000-0000000000f2','c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c2','slack','U2','Ada L','ada.l@example.test','ada.l@example.test','human','active',false,'current',null),
  ('c3000000-0000-4000-8000-0000000000f3','c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c2','slack','B1','Deploy Bot','bot@example.test','bot@example.test','bot','active',false,'current',null),
  ('c3000000-0000-4000-8000-0000000000f4','c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c2','slack','U4','Stale Person','stale@example.test','stale@example.test','human','active',false,'stale',now());

-- ════ P0: the table is deny-all and the RPCs belong to `authenticated` alone ═══════════════════════════════════════
do $$
declare f text;
begin
  assert (select relrowsecurity from pg_class where oid = 'public.person_account_links'::regclass),
    'P0 RLS enabled on person_account_links';
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename = 'person_account_links') = 0,
    'P0 no policy — reads go through a product RPC or not at all';
  foreach f in array array[
    'public.product_propose_person_links(uuid)',
    'public.product_decide_person_link(uuid,uuid,text)']
  loop
    assert     has_function_privilege('authenticated', f, 'EXECUTE'), 'P0 authenticated EXECUTE ' || f;
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'P0 anon denied ' || f;
    assert not has_function_privilege('public', f, 'EXECUTE'), 'P0 PUBLIC denied ' || f;
    assert not has_function_privilege('connector_runner', f, 'EXECUTE'), 'P0 connector_runner denied ' || f;
    assert (select array_to_string(proconfig, ',') from pg_proc where oid = f::regprocedure) like 'search_path=%',
      'P0 pinned search_path ' || f;
  end loop;
  -- The runner writes connector evidence; a person link is a human judgement and none of it is the runner's.
  assert not has_table_privilege('connector_runner', 'public.person_account_links', 'INSERT'),
    'P0 connector_runner cannot insert a link';
  assert not has_table_privilege('authenticated', 'public.person_account_links', 'SELECT'),
    'P0 authenticated has no direct table read';
end $$;

-- ════ P1: the role gate refuses, and a refused call writes NOTHING ════════════════════════════════════════════════
do $$
declare msg text; n int;
begin
  begin
    perform public.product_propose_person_links('c3000000-0000-4000-8000-00000000000a');
    assert false, 'P1 the gate must refuse a caller with no tenant role';
  exception when insufficient_privilege then msg := sqlerrm;
  end;
  assert msg like 'not authorized%', 'P1 refused by the role gate, got: ' || msg;
  select count(*) into n from public.person_account_links;
  assert n = 0, 'P1 a refused call must write nothing, found ' || n;
  select count(*) into n from public.people where source = 'identity_graph';
  assert n = 0, 'P1 a refused call must create no person, found ' || n;
end $$;

-- ── From here on, run as a role that passes has_tenant_role. A definer function keeps its own privileges, so replacing
-- ── the gate is enough to exercise the authorized path without inventing a session.
-- Parameter NAMES must match 0001 exactly — `create or replace function` refuses to rename an input parameter.
create or replace function public.has_tenant_role(target_tenant_id uuid, allowed_roles text[])
  returns boolean language sql security definer set search_path = public stable as $$ select true $$;

-- ════ P2: deterministic resolution — the expected links, nothing auto-accepted ════════════════════════════════════
do $$
declare r jsonb; n int;
begin
  r := public.product_propose_person_links('c3000000-0000-4000-8000-00000000000a');

  -- Addresses in tenant A that resolve: ada@, dup@, gone@ is stale, stale@ is stale, bot@ is a bot, ada.l@ is a human
  -- SaaS account so it DOES get its own person (a different address is a different person until proven otherwise).
  assert (r ->> 'people_created')::int = 3, 'P2 one person per resolvable address (ada@, dup@, ada.l@), got ' || (r ->> 'people_created');
  -- I1 + I2 + I3 (ada@, dup@ twice). I4 is stale, I5 has no address.
  assert (r ->> 'identity_links_proposed')::int = 3, 'P2 three directory links, got ' || (r ->> 'identity_links_proposed');
  -- A1 + A2. A3 is a bot, A4 is stale.
  assert (r ->> 'app_account_links_proposed')::int = 2, 'P2 two application links, got ' || (r ->> 'app_account_links_proposed');
  -- Nothing is accepted yet, so the transitive pass has no person to carry.
  assert (r ->> 'transitive_links_proposed')::int = 0, 'P2 nothing transitive before a human accepts';

  select count(*) into n from public.person_account_links where status <> 'proposed';
  assert n = 0, 'P2 NOTHING auto-accepts — a human decides, found ' || n || ' decided rows';

  -- The stale identity and the address-less identity are absent entirely: no evidence, no link.
  select count(*) into n from public.person_account_links
   where identity_account_id in ('c3000000-0000-4000-8000-0000000000e4', 'c3000000-0000-4000-8000-0000000000e5');
  assert n = 0, 'P2 a stale or address-less account is not resolved, found ' || n;
  -- The bot is absent: a bot has no person behind it.
  select count(*) into n from public.person_account_links where app_account_id = 'c3000000-0000-4000-8000-0000000000f3';
  assert n = 0, 'P2 a bot is never linked to a person';
end $$;

-- ════ P3: RE-RUNNING IS IDEMPOTENT — the same facts propose the same graph, not a second copy ═════════════════════
do $$
declare before_links int; before_people int; r jsonb; after_links int; after_people int;
begin
  select count(*) into before_links from public.person_account_links;
  select count(*) into before_people from public.people where tenant_id = 'c3000000-0000-4000-8000-00000000000a';
  r := public.product_propose_person_links('c3000000-0000-4000-8000-00000000000a');
  select count(*) into after_links from public.person_account_links;
  select count(*) into after_people from public.people where tenant_id = 'c3000000-0000-4000-8000-00000000000a';
  assert (r ->> 'people_created')::int = 0, 'P3 a second run creates no person';
  assert after_links = before_links, 'P3 a second run creates no link: ' || before_links || ' -> ' || after_links;
  assert after_people = before_people, 'P3 person count unchanged: ' || before_people || ' -> ' || after_people;
end $$;

-- ════ P4: CROSS-TENANT ISOLATION — the load-bearing property ══════════════════════════════════════════════════════
do $$
declare n int;
begin
  -- Tenant B shares the ada@ address. Proposing for A must not have created a person or a link for B.
  select count(*) into n from public.people where tenant_id = 'c3000000-0000-4000-8000-00000000000b';
  assert n = 0, 'P4 proposing for tenant A created no person in tenant B, found ' || n;
  select count(*) into n from public.person_account_links where tenant_id = 'c3000000-0000-4000-8000-00000000000b';
  assert n = 0, 'P4 no link in tenant B, found ' || n;
  -- And B's identity was never attached to A's person, despite the identical address.
  select count(*) into n from public.person_account_links
   where identity_account_id = 'c3000000-0000-4000-8000-0000000000eb';
  assert n = 0, 'P4 tenant B''s identity is not in tenant A''s graph, found ' || n;

  -- The FK is what makes that structural rather than merely intended: a link naming A's tenant and B's account fails.
  begin
    insert into public.person_account_links (tenant_id, person_id, identity_account_id, method, confidence, status)
    select 'c3000000-0000-4000-8000-00000000000a', p.id, 'c3000000-0000-4000-8000-0000000000eb', 'manual', 'high', 'proposed'
      from public.people p where p.tenant_id = 'c3000000-0000-4000-8000-00000000000a' limit 1;
    assert false, 'P4 a cross-tenant endpoint must be impossible, not merely unused';
  exception when foreign_key_violation then null;
  end;
end $$;

-- ════ P5: DUPLICATE ADDRESSES — two accounts, one address, ONE person (that is the duplicate signal) ══════════════
do $$
declare n int; persons int;
begin
  select count(distinct person_id) into persons from public.person_account_links
   where identity_account_id in ('c3000000-0000-4000-8000-0000000000e2', 'c3000000-0000-4000-8000-0000000000e3');
  assert persons = 1, 'P5 both dup@ identities resolve to ONE person, got ' || persons;
  select count(*) into n from public.person_account_links
   where identity_account_id in ('c3000000-0000-4000-8000-0000000000e2', 'c3000000-0000-4000-8000-0000000000e3');
  assert n = 2, 'P5 and each account keeps its own link row, got ' || n;
end $$;

-- ════ P6: AMBIGUITY STAYS AMBIGUOUS — a different address is a different person until a human says otherwise ══════
do $$
declare same int;
begin
  select count(*) into same from public.person_account_links l1
    join public.person_account_links l2 on l1.person_id = l2.person_id
   where l1.identity_account_id = 'c3000000-0000-4000-8000-0000000000e1'   -- ada@
     and l2.app_account_id      = 'c3000000-0000-4000-8000-0000000000f2';  -- ada.l@
  assert same = 0, 'P6 ada@ and ada.l@ are NOT collapsed by name similarity';
end $$;

-- ════ P7: ALIASES — a human-accepted account match is the ONLY thing that joins two addresses ═════════════════════
do $$
declare r jsonb; lid uuid; mid uuid; same int;
begin
  -- A reviewer accepts the ada@ directory identity as this person's.
  select id into lid from public.person_account_links
   where identity_account_id = 'c3000000-0000-4000-8000-0000000000e1' and status = 'proposed';
  r := public.product_decide_person_link('c3000000-0000-4000-8000-00000000000a', lid, 'accepted');
  assert (r ->> 'updated')::int = 1, 'P7 the decision applied';

  -- And separately accepts the 0076 match saying the ada.l@ Slack account is that same directory identity.
  insert into public.app_account_identity_matches
    (tenant_id, app_account_id, identity_account_id, method, confidence, status, decided_at)
  values ('c3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-0000000000f2',
          'c3000000-0000-4000-8000-0000000000e1', 'manual', 'high', 'accepted', now())
  returning id into mid;

  -- NOW the transitive pass can carry the person across the differing address — and only now.
  r := public.product_propose_person_links('c3000000-0000-4000-8000-00000000000a');
  assert (r ->> 'transitive_links_proposed')::int = 1, 'P7 the accepted match carries the person, got ' || (r ->> 'transitive_links_proposed');

  select count(*) into same from public.person_account_links l1
    join public.person_account_links l2 on l1.person_id = l2.person_id
   where l1.identity_account_id = 'c3000000-0000-4000-8000-0000000000e1'
     and l2.app_account_id      = 'c3000000-0000-4000-8000-0000000000f2'
     and l2.method = 'accepted_account_match';
  assert same = 1, 'P7 ada.l@ now reaches ada@''s person, by evidence rather than by string';
end $$;

-- ════ P8: A DECISION IS FINAL, AND ONE ACCOUNT HAS AT MOST ONE ACCEPTED PERSON ════════════════════════════════════
do $$
declare r jsonb; lid uuid; pid uuid; other uuid;
begin
  select id into lid from public.person_account_links
   where identity_account_id = 'c3000000-0000-4000-8000-0000000000e1' and status = 'accepted';
  -- Re-deciding a decided row is a no-op, not a silent overwrite.
  r := public.product_decide_person_link('c3000000-0000-4000-8000-00000000000a', lid, 'rejected');
  assert (r ->> 'updated')::int = 0, 'P8 a decided link does not move again';
  assert (select status from public.person_account_links where id = lid) = 'accepted', 'P8 and it kept its decision';
  assert (select decided_at from public.person_account_links where id = lid) is not null, 'P8 decided_at is stamped';

  -- A second ACCEPTED person for the same account is refused by the index, not by convention.
  select person_id into pid from public.person_account_links where id = lid;
  select id into other from public.people
   where tenant_id = 'c3000000-0000-4000-8000-00000000000a' and id <> pid limit 1;
  begin
    insert into public.person_account_links (tenant_id, person_id, identity_account_id, method, confidence, status, decided_at)
    values ('c3000000-0000-4000-8000-00000000000a', other, 'c3000000-0000-4000-8000-0000000000e1', 'manual', 'high', 'accepted', now());
    assert false, 'P8 one account cannot be two accepted people';
  exception when unique_violation then null;
  end;

  -- A decided pair is never re-proposed: reject one, re-run, and it stays rejected.
  select id into lid from public.person_account_links
   where identity_account_id = 'c3000000-0000-4000-8000-0000000000e2' and status = 'proposed';
  perform public.product_decide_person_link('c3000000-0000-4000-8000-00000000000a', lid, 'rejected');
  perform public.product_propose_person_links('c3000000-0000-4000-8000-00000000000a');
  assert (select status from public.person_account_links where id = lid) = 'rejected',
    'P8 a human''s rejection survives the next proposal run';
end $$;

-- ════ P9: A PROVIDER DISAPPEARING TEMPORARILY DOES NOT UNMAKE A JUDGEMENT ═════════════════════════════════════════
do $$
declare n int; r jsonb;
begin
  -- The connector stops confirming ada@'s directory identity. The accepted link is a human's conclusion about a human;
  -- staleness is a fact about the CONNECTOR, and it must not retract one.
  update public.identity_accounts set sync_status = 'stale', stale_since = now()
   where id = 'c3000000-0000-4000-8000-0000000000e1';
  r := public.product_propose_person_links('c3000000-0000-4000-8000-00000000000a');
  select count(*) into n from public.person_account_links
   where identity_account_id = 'c3000000-0000-4000-8000-0000000000e1' and status = 'accepted';
  assert n = 1, 'P9 an accepted link survives its account going stale';

  -- And when the provider comes back, no duplicate link appears.
  update public.identity_accounts set sync_status = 'current', stale_since = null
   where id = 'c3000000-0000-4000-8000-0000000000e1';
  r := public.product_propose_person_links('c3000000-0000-4000-8000-00000000000a');
  select count(*) into n from public.person_account_links
   where identity_account_id = 'c3000000-0000-4000-8000-0000000000e1';
  assert n = 1, 'P9 recovery re-proposes nothing, found ' || n || ' links';
end $$;

-- ════ P10: ACCOUNT DELETION REMOVES THE LINK AND KEEPS THE PERSON ═════════════════════════════════════════════════
do $$
declare pid uuid; n int;
begin
  select person_id into pid from public.person_account_links
   where identity_account_id = 'c3000000-0000-4000-8000-0000000000e3';
  delete from public.identity_accounts where id = 'c3000000-0000-4000-8000-0000000000e3';
  select count(*) into n from public.person_account_links
   where identity_account_id = 'c3000000-0000-4000-8000-0000000000e3';
  assert n = 0, 'P10 the link goes with the account';
  select count(*) into n from public.people where id = pid;
  assert n = 1, 'P10 the person outlives the account — that is the point of the node';
end $$;

-- ════ P11: THE ENDPOINT IS EXACTLY ONE ════════════════════════════════════════════════════════════════════════════
do $$
declare pid uuid;
begin
  select id into pid from public.people where tenant_id = 'c3000000-0000-4000-8000-00000000000a' limit 1;
  begin
    insert into public.person_account_links (tenant_id, person_id, method, confidence, status)
    values ('c3000000-0000-4000-8000-00000000000a', pid, 'manual', 'high', 'proposed');
    assert false, 'P11 a link with no endpoint is meaningless';
  exception when check_violation then null;
  end;
  begin
    insert into public.person_account_links
      (tenant_id, person_id, identity_account_id, app_account_id, method, confidence, status)
    values ('c3000000-0000-4000-8000-00000000000a', pid, 'c3000000-0000-4000-8000-0000000000e2',
            'c3000000-0000-4000-8000-0000000000f1', 'manual', 'high', 'proposed');
    assert false, 'P11 a link to two accounts at once is two links';
  exception when check_violation then null;
  end;
end $$;

-- P7 seeded an `app_account_identity_matches` row to prove the transitive path. Every suite shares one database, and
-- saas_evidence_product_reads_test asserts a GLOBAL count on that table (an unfiltered "a refused call wrote nothing"),
-- so this file's fixture would fail a later file's assertion. Clean up our own tenant's rows rather than weaken theirs.
delete from public.app_account_identity_matches where tenant_id = 'c3000000-0000-4000-8000-00000000000a';

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

-- And prove the restore actually took, rather than trusting it: the stub returned true for everything.
do $$
begin
  assert not public.has_tenant_role('c3000000-0000-4000-8000-00000000000a', array['owner']),
    'the has_tenant_role stub must not survive this file';
end $$;
