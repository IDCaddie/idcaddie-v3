-- 0078 — the canonical SaaS product read layer and the identity matcher.
--
-- The property this suite exists to protect: a read must never show one tenant another tenant's accounts, and the matcher
-- must never guess. Everything else — filters, counts, pagination — is in service of a demo being TRUE, which is the only
-- kind worth giving.

reset role;

insert into public.tenants (id, name, slug) values
  ('b2000000-0000-4000-8000-00000000000a', 'Read A', 'read-a'),
  ('b2000000-0000-4000-8000-00000000000b', 'Read B', 'read-b');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('b2000000-0000-4000-8000-0000000000c1', 'b2000000-0000-4000-8000-00000000000a', 'slack', 'WS A', 'pending', 'discovered'),
  ('b2000000-0000-4000-8000-0000000000c2', 'b2000000-0000-4000-8000-00000000000a', 'okta',  'Okta A', 'pending', 'discovered'),
  ('b2000000-0000-4000-8000-0000000000c3', 'b2000000-0000-4000-8000-00000000000b', 'slack', 'WS B', 'pending', 'discovered');

-- Accounts for tenant A / connector C1. Deliberately mixed: humans, a bot, an admin, one stale, one without an email.
insert into public.app_accounts
  (tenant_id, connection_id, provider, external_id, workspace_external_id, display_name, email, normalized_email,
   account_kind, account_status, is_admin, sync_status, stale_since)
values
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c1','slack','U1','T1','Ada Lovelace','Ada@Example.Test','ada@example.test','human','active',true,'current',null),
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c1','slack','U2','T1','Grace Hopper','grace@example.test','grace@example.test','human','active',false,'current',null),
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c1','slack','U3','T1','Alan Turing','alan@example.test','alan@example.test','human','inactive',false,'current',null),
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c1','slack','U4','T1','No Email Person',null,null,'human','active',false,'current',null),
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c1','slack','B1','T1','Deploy Bot','bot@example.test','bot@example.test','bot','active',false,'current',null),
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c1','slack','U5','T1','Departed Person','gone@example.test','gone@example.test','human','active',false,'stale',now()),
  -- Tenant B's account, same email as Ada. Nothing tenant A reads may ever surface it.
  ('b2000000-0000-4000-8000-00000000000b','b2000000-0000-4000-8000-0000000000c3','slack','U1','T2','Other Tenant Ada','ada@example.test','ada@example.test','human','active',false,'current',null);

insert into public.app_account_groups
  (tenant_id, connection_id, provider, external_id, workspace_external_id, name, handle, member_count, is_active, sync_status)
values
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c1','slack','G1','T1','Engineering','eng',12,true,'current'),
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c1','slack','G2','T1','Finance','fin',3,true,'current'),
  ('b2000000-0000-4000-8000-00000000000b','b2000000-0000-4000-8000-0000000000c3','slack','G1','T2','Other Tenant Group','otg',9,true,'current');

-- Directory identities for tenant A. Ada + Alan match by email; `dup@` exists TWICE, which must stay unmatched.
insert into public.identity_accounts
  (tenant_id, connection_id, provider, external_id, login, normalized_login, email, normalized_email, display_name, sync_status)
values
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c2','okta','I1','ada','ada','ada@example.test','ada@example.test','Ada L','current'),
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c2','okta','I2','alan','alan','alan@example.test','alan@example.test','Alan T','current'),
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c2','okta','I3','bot','bot','bot@example.test','bot@example.test','Bot Account','current'),
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c2','okta','I4','g1','g1','grace@example.test','grace@example.test','Grace A','current'),
  ('b2000000-0000-4000-8000-00000000000a','b2000000-0000-4000-8000-0000000000c2','okta','I5','g2','g2','grace@example.test','grace@example.test','Grace B','current');

-- ════ R0: grants — product reads are for `authenticated`, and for nobody else ═════════════════════════════════════
do $$
declare f text;
begin
  foreach f in array array[
    'public.product_app_accounts(uuid,uuid,boolean,text,text,text,text,integer,integer)',
    'public.product_app_account_groups(uuid,uuid,boolean,text,integer,integer)',
    'public.product_app_account_counts(uuid,uuid)',
    'public.product_connector_capabilities(uuid,uuid)',
    'public.product_propose_app_account_identity_matches(uuid,uuid)',
    'public.product_decide_app_account_identity_match(uuid,uuid,text)']
  loop
    assert     has_function_privilege('authenticated', f, 'EXECUTE'), 'R0 authenticated EXECUTE ' || f;
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'R0 anon denied ' || f;
    assert not has_function_privilege('public', f, 'EXECUTE'), 'R0 PUBLIC denied ' || f;
    -- The runner writes evidence; it has no business reading the product surface.
    assert not has_function_privilege('connector_runner', f, 'EXECUTE'), 'R0 connector_runner denied ' || f;
    -- service_role is deliberately NOT asserted: 0078 follows the 0061/0073 product-RPC precedent and does not revoke it,
    -- and this harness blanket-grants EXECUTE to service_role at test-rls.sh:78 anyway, so an assertion here would be
    -- testing the harness rather than the migration.
    assert (select array_to_string(proconfig, ',') from pg_proc where oid = f::regprocedure) like 'search_path=%', 'R0 pinned search_path ' || f;
  end loop;

  -- The tables themselves stay unreachable: the RPC is the only door.
  foreach f in array array['app_accounts','app_account_groups','app_account_group_memberships','connector_capability_state','app_account_identity_matches'] loop
    assert not has_table_privilege('authenticated', 'public.' || f, 'SELECT'), 'R0 authenticated must not SELECT ' || f || ' directly';
    assert not has_table_privilege('anon', 'public.' || f, 'SELECT'), 'R0 anon must not SELECT ' || f;
  end loop;
end $$;

-- ════ R1: a caller without the tenant role gets NOTHING, and not an error ═════════════════════════════════════════
-- has_tenant_role() is false for every tenant here (no membership rows, no auth.uid()), so these calls exercise the
-- denied path exactly as a signed-in stranger would.
do $$
declare n int; v jsonb;
begin
  select count(*) into n from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a');
  assert n = 0, 'R1 a denied accounts read returns empty, got ' || n;
  select count(*) into n from public.product_app_account_groups('b2000000-0000-4000-8000-00000000000a');
  assert n = 0, 'R1 a denied groups read returns empty, got ' || n;
  v := public.product_app_account_counts('b2000000-0000-4000-8000-00000000000a');
  assert v is null, 'R1 a denied counts read returns null';
  select count(*) into n from public.product_connector_capabilities('b2000000-0000-4000-8000-00000000000a');
  assert n = 0, 'R1 a denied capability read returns empty, got ' || n;
end $$;

-- ════ R2: the matcher refuses a caller without the role, LOUDLY ═══════════════════════════════════════════════════
-- A read denial is silent by convention; a WRITE denial must not be, or a caller believes it proposed matches.
do $$
declare raised boolean := false; msg text; n int;
begin
  begin perform public.product_propose_app_account_identity_matches('b2000000-0000-4000-8000-00000000000a');
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'R2 an unauthorized matcher call must raise';
  assert msg like 'not authorized%', 'R2 refused by the role gate, got: ' || msg;
  select count(*) into n from public.app_account_identity_matches;
  assert n = 0, 'R2 a refused matcher call must write nothing, found ' || n;
end $$;

-- ── From here on, run as a role that passes has_tenant_role. A definer function keeps its own privileges, so replacing
-- ── the gate is enough to exercise the authorized path without inventing a session.
-- Parameter NAMES must match 0001 exactly — `create or replace function` refuses to rename an input parameter.
create or replace function public.has_tenant_role(target_tenant_id uuid, allowed_roles text[])
  returns boolean language sql security definer set search_path = public stable as $$ select true $$;

-- ════ R3: tenant isolation — the load-bearing read property ═══════════════════════════════════════════════════════
do $$
declare n int; nb int;
begin
  select count(*) into n from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a');
  assert n = 6, 'R3 tenant A sees its own 6 accounts, got ' || n;
  select count(*) into nb from public.product_app_accounts('b2000000-0000-4000-8000-00000000000b');
  assert nb = 1, 'R3 tenant B sees exactly its own 1 account, got ' || nb;

  -- The same email exists in both tenants. Neither may see the other's.
  select count(*) into n from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', null, true, 'ada@example.test');
  assert n = 1, 'R3 searching a shared email must not cross tenants, got ' || n;
  assert (select display_name from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', null, true, 'ada@example.test'))
         = 'Ada Lovelace', 'R3 and it must be OUR Ada';

  select count(*) into n from public.product_app_account_groups('b2000000-0000-4000-8000-00000000000a');
  assert n = 2, 'R3 tenant A sees its own 2 groups, got ' || n;
end $$;

-- ════ R4: connector scope, staleness and filters ══════════════════════════════════════════════════════════════════
do $$
declare n int;
begin
  select count(*) into n from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', 'b2000000-0000-4000-8000-0000000000c2');
  assert n = 0, 'R4 the Okta connector holds no app accounts, got ' || n;

  select count(*) into n from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', null, false);
  assert n = 5, 'R4 excluding stale drops exactly the one stale account, got ' || n;

  select count(*) into n from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', null, true, null, 'bot');
  assert n = 1, 'R4 kind filter, got ' || n;
  select count(*) into n from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', null, true, null, null, 'inactive');
  assert n = 1, 'R4 status filter, got ' || n;
  select count(*) into n from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', null, true, 'grace');
  assert n = 1, 'R4 search matches display name or email, got ' || n;

  -- total_count is the count BEFORE the page, or pagination silently lies about how much there is.
  assert (select total_count from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', null, true, null, null, null, null, 2, 0) limit 1) = 6,
    'R4 total_count reports the full filtered set, not the page';
  select count(*) into n from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', null, true, null, null, null, null, 2, 0);
  assert n = 2, 'R4 limit applies, got ' || n;
end $$;

-- ════ R5: ordering is by DISPLAY value, not by uuid ═══════════════════════════════════════════════════════════════
do $$
declare first_name text;
begin
  select display_name into first_name from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a') limit 1;
  assert first_name = 'Ada Lovelace', 'R5 the list opens alphabetically, got ' || coalesce(first_name, '<null>');
end $$;

-- ════ R6: the matcher proposes, and refuses to guess ══════════════════════════════════════════════════════════════
do $$
declare r jsonb; n int; st text;
begin
  r := public.product_propose_app_account_identity_matches('b2000000-0000-4000-8000-00000000000a');
  -- Ada and Alan match. Grace's email hits TWO identities. The bot is excluded. No-email is excluded. Stale is excluded.
  assert (r ->> 'proposed')::int = 2, 'R6 exactly two unambiguous matches, got ' || (r ->> 'proposed');
  assert (r ->> 'ambiguous')::int = 1, 'R6 one ambiguous email reported, got ' || (r ->> 'ambiguous');

  select count(*) into n from public.app_account_identity_matches m
    join public.app_accounts a on a.id = m.app_account_id where a.account_kind <> 'human';
  assert n = 0, 'R6 a bot must never be matched to a person, found ' || n;

  select count(*) into n from public.app_account_identity_matches m
    join public.app_accounts a on a.id = m.app_account_id where a.display_name = 'Grace Hopper';
  assert n = 0, 'R6 an email matching two identities proposes NOTHING, found ' || n;

  select count(*) into n from public.app_account_identity_matches m
    join public.app_accounts a on a.id = m.app_account_id where a.sync_status = 'stale';
  assert n = 0, 'R6 stale accounts are not matched, found ' || n;

  select count(*) into n from public.app_account_identity_matches where status <> 'proposed';
  assert n = 0, 'R6 nothing is auto-accepted, found ' || n;
  assert (select method from public.app_account_identity_matches limit 1) = 'normalized_email', 'R6 the only method is email';

  -- Re-running must not stack duplicates.
  r := public.product_propose_app_account_identity_matches('b2000000-0000-4000-8000-00000000000a');
  assert (r ->> 'proposed')::int = 0, 'R6 a second run proposes nothing new, got ' || (r ->> 'proposed');
  select count(*) into n from public.app_account_identity_matches;
  assert n = 2, 'R6 and leaves exactly two rows, got ' || n;

  -- The match STATE reaches the read.
  select match_state into st from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', null, true, 'ada') limit 1;
  assert st = 'proposed', 'R6 a proposed match reads as proposed, got ' || coalesce(st, '<null>');
  select count(*) into n from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', null, true, null, null, null, 'unmatched');
  assert n = 4, 'R6 match-state filter (Grace, no-email, bot, stale), got ' || n;
end $$;

-- ════ R7: a decision sticks, and cannot be re-decided or re-proposed ══════════════════════════════════════════════
do $$
declare mid uuid; r jsonb; st text; n int;
begin
  select id into mid from public.app_account_identity_matches limit 1;

  r := public.product_decide_app_account_identity_match('b2000000-0000-4000-8000-00000000000a', mid, 'accepted');
  assert (r ->> 'updated')::int = 1, 'R7 the decision applies';
  assert (select status from public.app_account_identity_matches where id = mid) = 'accepted', 'R7 status recorded';
  assert (select decided_at is not null from public.app_account_identity_matches where id = mid), 'R7 decided_at is set';

  -- Only a PROPOSED match can be decided; a second decision must not overwrite the first silently.
  r := public.product_decide_app_account_identity_match('b2000000-0000-4000-8000-00000000000a', mid, 'rejected');
  assert (r ->> 'updated')::int = 0, 'R7 an already-decided match cannot be re-decided';
  assert (select status from public.app_account_identity_matches where id = mid) = 'accepted', 'R7 and the first decision stands';

  -- A decided pair is never re-proposed by a later run.
  r := public.product_propose_app_account_identity_matches('b2000000-0000-4000-8000-00000000000a');
  assert (r ->> 'proposed')::int = 0, 'R7 a decided pair is not re-proposed';

  -- Cross-tenant decide is a no-op, not an error and not a write.
  r := public.product_decide_app_account_identity_match('b2000000-0000-4000-8000-00000000000b', mid, 'rejected');
  assert (r ->> 'updated')::int = 0, 'R7 another tenant cannot decide our match';
  assert (select status from public.app_account_identity_matches where id = mid) = 'accepted', 'R7 and it is unchanged';

  select match_state into st from public.product_app_accounts('b2000000-0000-4000-8000-00000000000a', null, true, 'ada') limit 1;
  assert st = 'matched', 'R7 an accepted match reads as matched, got ' || coalesce(st, '<null>');

  select count(*) into n from public.identity_accounts where tenant_id = 'b2000000-0000-4000-8000-00000000000a';
  assert n = 5, 'R7 matching must never create an identity, got ' || n;
end $$;

-- ════ R8: counts are truthful, and separate current from total evidence ═══════════════════════════════════════════
do $$
declare v jsonb;
begin
  v := public.product_app_account_counts('b2000000-0000-4000-8000-00000000000a');
  assert (v -> 'accounts' ->> 'current')::int = 5, 'R8 current excludes the stale row, got ' || (v -> 'accounts' ->> 'current');
  assert (v -> 'accounts' ->> 'stale')::int = 1, 'R8 stale is reported, not hidden';
  assert (v -> 'accounts' ->> 'totalEvidence')::int = 6, 'R8 total evidence retains everything';
  assert (v -> 'accounts' ->> 'humans')::int = 4, 'R8 humans, got ' || (v -> 'accounts' ->> 'humans');
  assert (v -> 'accounts' ->> 'bots')::int = 1, 'R8 bots';
  assert (v -> 'accounts' ->> 'admins')::int = 1, 'R8 admins';
  assert (v -> 'accounts' ->> 'inactive')::int = 1, 'R8 inactive';
  assert (v -> 'groups' ->> 'current')::int = 2, 'R8 groups';

  -- Coverage is measured against HUMANS. Counting the bot as unmatched would invent a review item.
  assert (v -> 'matching' ->> 'humans')::int = 4, 'R8 coverage denominator is humans only';
  assert (v -> 'matching' ->> 'matched')::int = 1, 'R8 one accepted';
  assert (v -> 'matching' ->> 'proposed')::int = 1, 'R8 one still proposed';
  assert (v -> 'matching' ->> 'withoutEmail')::int = 1, 'R8 an account with no email is reported as such, not as unmatched-by-choice';

  -- Another tenant's identical data must not leak into our numbers.
  v := public.product_app_account_counts('b2000000-0000-4000-8000-00000000000b');
  assert (v -> 'accounts' ->> 'current')::int = 1, 'R8 tenant B counts only its own';
end $$;

-- ════ R9: the provider's member count and the count we can prove are separate numbers ═════════════════════════════
do $$
declare reported int; known int;
begin
  select reported_member_count, known_member_count into reported, known
    from public.product_app_account_groups('b2000000-0000-4000-8000-00000000000a', null, true, 'Engineering');
  assert reported = 12, 'R9 the provider says 12';
  -- No membership rows were seeded, so the honest answer is zero — never the provider's number echoed back.
  assert known = 0, 'R9 and we can prove 0, got ' || known;
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

-- And prove the restore actually took, rather than trusting it: the stub returned true for everything.
do $$
begin
  assert not public.has_tenant_role('b2000000-0000-4000-8000-00000000000a', array['owner']),
    'the has_tenant_role stub must not survive this file';
end $$;
