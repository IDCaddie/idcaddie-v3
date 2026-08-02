-- 0081 — the durable, one-time OAuth completion job.
--
-- The property this suite exists to protect: a completion job is a hand-off and NOTHING ELSE. It is claimed once,
-- resolved once, holds the authorization code only as bytes the database cannot open, and holds none of them once it is
-- terminal. Working one confers no new capability — no run, no fact, no promotion, no stale, no credential disturbed.
--
-- NOTE ON NEGATIVE TESTS: `raise exception` is SQLSTATE P0001 and `when others` swallows it, so negatives assert on a
-- flag set OUTSIDE the handler.

reset role;

-- ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────
insert into public.tenants (id, name, slug) values
  ('e5000000-0000-4000-8000-00000000000a', 'Job A', 'job-a'),
  ('e5000000-0000-4000-8000-00000000000b', 'Job B', 'job-b');
insert into auth.users (id, email) values
  ('e5000000-0000-4000-8000-0000000000f1', 'job-owner-a@example.test'),
  ('e5000000-0000-4000-8000-0000000000f2', 'job-editor-a@example.test'),
  ('e5000000-0000-4000-8000-0000000000f3', 'job-owner-b@example.test') on conflict do nothing;
insert into public.profiles (id, email) values
  ('e5000000-0000-4000-8000-0000000000f1', 'job-owner-a@example.test'),
  ('e5000000-0000-4000-8000-0000000000f2', 'job-editor-a@example.test'),
  ('e5000000-0000-4000-8000-0000000000f3', 'job-owner-b@example.test') on conflict do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000f1', 'owner'),
  ('e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000f2', 'editor'),
  ('e5000000-0000-4000-8000-00000000000b', 'e5000000-0000-4000-8000-0000000000f3', 'owner') on conflict do nothing;

insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('e5000000-0000-4000-8000-0000000000c1', 'e5000000-0000-4000-8000-00000000000a', 'slack', 'WS A', 'pending', 'discovered'),
  ('e5000000-0000-4000-8000-0000000000c2', 'e5000000-0000-4000-8000-00000000000a', 'okta',  'Okta A','pending', 'discovered'),
  ('e5000000-0000-4000-8000-0000000000c3', 'e5000000-0000-4000-8000-00000000000b', 'slack', 'WS B', 'pending', 'discovered');

-- The authorize half. A completion job may only exist for one of these.
insert into public.oauth_pending (tenant_id, connector_id, provider, subject, state_jti, nonce_hash, intent, expires_at)
select 'e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000c1', 'slack',
       'e5000000-0000-4000-8000-0000000000f1'::uuid, j, 'nh-' || j, 'connect', now() + interval '10 minutes'
  from unnest(array['job-ok','job-fail','job-sweep','job-idem','job-conflict','job-lazy','job-stale']) j;
insert into public.oauth_pending (tenant_id, connector_id, provider, subject, state_jti, nonce_hash, intent, expires_at)
values ('e5000000-0000-4000-8000-00000000000b', 'e5000000-0000-4000-8000-0000000000c3', 'slack',
        'e5000000-0000-4000-8000-0000000000f3'::uuid, 'job-b', 'nh-job-b', 'connect', now() + interval '10 minutes');

-- A 64-byte stand-in for a sealed envelope. It is opaque to every assertion here, which is the point: nothing in the
-- migration parses it, so nothing in this suite needs to.
create or replace function pg_temp.seal(p_seed text) returns bytea language sql immutable as $$
  select decode(md5(p_seed) || md5(p_seed || ':2') || md5(p_seed || ':3') || md5(p_seed || ':4'), 'hex')
$$;

-- ════ J0: the granted surface ═════════════════════════════════════════════════════════════════════════════════════
do $$
declare f text; n int;
begin
  foreach f in array array[
    'public.oauth_completer_enqueue_oauth_completion_job(uuid,uuid,text,text,text,bytea,text,text)',
    'public.oauth_completer_claim_oauth_completion_job(uuid,uuid,text)',
    'public.oauth_completer_complete_oauth_completion_job(uuid,uuid,text)',
    'public.oauth_completer_fail_oauth_completion_job(uuid,uuid,text,text)',
    'public.oauth_completer_expire_oauth_completion_jobs()']
  loop
    assert     has_function_privilege('oauth_completer', f, 'EXECUTE'), 'J0 oauth_completer EXECUTE ' || f;
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'J0 anon denied ' || f;
    assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'J0 authenticated denied ' || f;
    assert not has_function_privilege('service_role', f, 'EXECUTE'), 'J0 service_role denied ' || f;
    assert not has_function_privilege('public', f, 'EXECUTE'), 'J0 PUBLIC denied ' || f;
    assert not has_function_privilege('connector_runner', f, 'EXECUTE'), 'J0 connector_runner denied ' || f;
    assert (select prosecdef from pg_proc where oid = f::regprocedure), 'J0 security definer ' || f;
    assert (select array_to_string(proconfig, ',') from pg_proc where oid = f::regprocedure) in ('search_path=', 'search_path=""'),
      'J0 empty search_path ' || f;
  end loop;

  -- The customer read is the MIRROR IMAGE: authenticated only, and specifically NOT the identity that works the job.
  f := 'public.product_oauth_completion_job_status(uuid,text)';
  assert     has_function_privilege('authenticated', f, 'EXECUTE'), 'J0 authenticated EXECUTE ' || f;
  assert not has_function_privilege('anon', f, 'EXECUTE'), 'J0 anon denied ' || f;
  assert not has_function_privilege('public', f, 'EXECUTE'), 'J0 PUBLIC denied ' || f;
  assert not has_function_privilege('connector_runner', f, 'EXECUTE'), 'J0 connector_runner denied ' || f;
  assert not has_function_privilege('oauth_completer', f, 'EXECUTE'),
    'J0 the identity that WORKS a job must not hold the customer read';

  -- The whole `oauth_completer_*` surface, counted. 0079 granted three, 0080 replaced one and added a fourth, 0081 adds
  -- five. An exact count is the point: a tenth wrapper must be a deliberate edit to this line.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'oauth\_completer\_%';
  assert n = 9, 'J0 exactly nine oauth_completer_* wrappers must exist, found ' || n;

  -- No OTHER security-definer function is reachable. A definer function runs with its OWNER's authority, so one
  -- reachable by this role is a privilege-escalation path — and the new product read is exactly such a function.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname not like 'oauth\_completer\_%' and p.prosecdef
     and has_function_privilege('oauth_completer', p.oid, 'EXECUTE');
  assert n = 0, 'J0 no OTHER security-definer function may be reachable by oauth_completer, found ' || n;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and (p.proname like 'runner\_%' or p.proname like 'product\_%')
     and has_function_privilege('oauth_completer', p.oid, 'EXECUTE');
  assert n = 0, 'J0 no runner_*/product_* function may be executable by oauth_completer, found ' || n;
end $$;

-- ════ J1: the table is Tier-2 deny-all, and adding it widened nothing ═════════════════════════════════════════════
do $$
declare n int; r text;
begin
  assert (select relrowsecurity from pg_class where oid = 'public.oauth_completion_jobs'::regclass), 'J1 RLS enabled';
  select count(*) into n from pg_policy where polrelid = 'public.oauth_completion_jobs'::regclass;
  assert n = 0, 'J1 the job table must carry ZERO policies (reads go through the product RPC), found ' || n;

  foreach r in array array['anon', 'authenticated', 'connector_runner', 'oauth_completer'] loop
    assert not has_table_privilege(r, 'public.oauth_completion_jobs', 'SELECT'), 'J1 no SELECT for ' || r;
    assert not has_table_privilege(r, 'public.oauth_completion_jobs', 'INSERT'), 'J1 no INSERT for ' || r;
    assert not has_table_privilege(r, 'public.oauth_completion_jobs', 'UPDATE'), 'J1 no UPDATE for ' || r;
    assert not has_table_privilege(r, 'public.oauth_completion_jobs', 'DELETE'), 'J1 no DELETE for ' || r;
  end loop;

  -- The 0079 posture, re-asserted AFTER a new table and six new functions exist.
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
     and (has_table_privilege('oauth_completer', c.oid, 'SELECT')
       or has_table_privilege('oauth_completer', c.oid, 'INSERT')
       or has_table_privilege('oauth_completer', c.oid, 'UPDATE')
       or has_table_privilege('oauth_completer', c.oid, 'DELETE'));
  assert n = 0, 'J1 oauth_completer must STILL hold zero table privileges, found ' || n;

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'S'
     and (has_sequence_privilege('oauth_completer', c.oid, 'USAGE')
       or has_sequence_privilege('oauth_completer', c.oid, 'SELECT'));
  assert n = 0, 'J1 …and zero sequence privileges, found ' || n;
end $$;

-- ════ J2: no plaintext authorization code can be named, stored or passed ══════════════════════════════════════════
-- Structural, so it cannot be reintroduced by adding a column or an argument.
do $$
declare n int; bad text := '(plaintext|authorization_code|auth_code|oauth_code|(^|_)code($|_)|token|client_secret|password|secret_value)';
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'oauth_completion_jobs' and column_name ~* bad;
  assert n = 0, 'J2 no column of the job table may name a plaintext credential, found ' || n;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and (p.proname like 'oauth\_completer\_%\_oauth\_completion\_job%' or p.proname = 'product_oauth_completion_job_status')
     and array_to_string(p.proargnames, ',') ~* bad;
  assert n = 0, 'J2 no job wrapper may take or return a plaintext credential parameter, found ' || n;

  -- The sealed payload is the ONLY place a code may live, and it is a bytea the database never parses.
  assert (select data_type from information_schema.columns
           where table_schema = 'public' and table_name = 'oauth_completion_jobs' and column_name = 'protected_payload') = 'bytea',
    'J2 the protected payload is opaque bytes';
end $$;

-- ── Behavioural checks run AS the role, the only honest way to test a privilege boundary.
set role oauth_completer;

-- ════ J3: enqueue — every binding refused before a row exists ═════════════════════════════════════════════════════
do $$
declare TA constant uuid := 'e5000000-0000-4000-8000-00000000000a';
        TB constant uuid := 'e5000000-0000-4000-8000-00000000000b';
        C1 constant uuid := 'e5000000-0000-4000-8000-0000000000c1';
        C2 constant uuid := 'e5000000-0000-4000-8000-0000000000c2';
        C3 constant uuid := 'e5000000-0000-4000-8000-0000000000c3';
        CB constant text := 'https://idcaddie-v3.vercel.app/connectors/oauth/callback';
        SC constant text := 'X25519-HKDF-SHA256-AES-256-GCM';
        KI constant text := 'worker-staging-1';
        TM constant text := 'T0FIXTURE01';
        raised boolean; msg text;
begin
  -- CROSS-TENANT: tenant B naming tenant A's connector.
  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TB, C1, 'job-ok', CB, TM, pg_temp.seal('ok'), SC, KI);
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'J3 cross-tenant enqueue must be refused';
  assert msg like '%does not belong%', 'J3 refused by the ownership gate, got: ' || msg;

  -- WRONG CONNECTOR: a connector of the right tenant that is not the one the correlation was issued for.
  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C3, 'job-ok', CB, TM, pg_temp.seal('ok'), SC, KI);
  exception when others then raised := true; end;
  assert raised, 'J3 a connector of another tenant must be refused';

  -- WRONG PROVIDER: an Okta connector can never carry a Slack completion.
  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C2, 'job-ok', CB, TM, pg_temp.seal('ok'), SC, KI);
  exception when others then raised := true; end;
  assert raised, 'J3 a non-Slack connector must be refused';

  -- WRONG REDIRECT: the code was issued against one callback and no other.
  --
  -- The REASON is asserted, not merely that something raised. Every input check below has a table CHECK behind it, so
  -- deleting the wrapper's check still produces a refusal — from a constraint, with a constraint NAME in the message and
  -- a different SQLSTATE, which is precisely what the wrapper check exists to prevent. Mutation-testing caught exactly
  -- that: a "did it raise?" assertion survived the removal of this gate.
  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(
    TA, C1, 'job-ok', 'https://attacker.example/connectors/oauth/callback', TM, pg_temp.seal('ok'), SC, KI);
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'J3 a foreign redirect must be refused';
  assert msg = 'redirect_uri not permitted', 'J3 refused by the WRAPPER, not by a constraint, got: ' || msg;
  assert msg !~* '(attacker|https?://)', 'J3 the refusal must not echo the redirect, got: ' || msg;

  -- WRONG CORRELATION: a correlation with no live authorize behind it.
  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-never-authorized', CB, TM, pg_temp.seal('ok'), SC, KI);
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'J3 a fabricated correlation must be refused';
  assert msg like '%no live authorization%', 'J3 refused by the authorize gate, got: ' || msg;

  -- Bounded inputs — each asserted on its exact bounded reason, for the reason above.
  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-ok', CB, 'not-a-workspace', pg_temp.seal('ok'), SC, KI);
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised and msg = 'invalid workspace', 'J3 a malformed workspace id must be refused by the wrapper, got: ' || msg;

  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-ok', CB, TM, pg_temp.seal('ok'), 'ROT13', KI);
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised and msg = 'unsupported payload scheme', 'J3 an unsupported scheme must be refused by the wrapper, got: ' || msg;

  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-ok', CB, TM, pg_temp.seal('ok'), SC, 'worker key!');
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised and msg = 'invalid payload key', 'J3 a malformed worker key id must be refused by the wrapper, got: ' || msg;

  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-ok', CB, TM, '\xdeadbeef', SC, KI);
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised and msg = 'invalid protected payload',
    'J3 a payload too small to be a sealed envelope must be refused by the wrapper, got: ' || msg;

  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-ok', CB, TM, null, SC, KI);
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised and msg = 'invalid protected payload', 'J3 a missing payload must be refused, got: ' || msg;

  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job ok; drop', CB, TM, pg_temp.seal('ok'), SC, KI);
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised and msg = 'invalid correlation',
    'J3 a correlation outside the grammar must be refused by the wrapper, got: ' || msg;
end $$;

reset role;
do $$
declare n int;
begin
  select count(*) into n from public.oauth_completion_jobs;
  assert n = 0, 'J3 not one refused enqueue may have created a row, found ' || n;
end $$;
set role oauth_completer;

-- ════ J4: enqueue — idempotent on the REQUEST ═════════════════════════════════════════════════════════════════════
do $$
declare TA constant uuid := 'e5000000-0000-4000-8000-00000000000a';
        C1 constant uuid := 'e5000000-0000-4000-8000-0000000000c1';
        CB constant text := 'https://idcaddie-v3.vercel.app/connectors/oauth/callback';
        SC constant text := 'X25519-HKDF-SHA256-AES-256-GCM';
        KI constant text := 'worker-staging-1';
        TM constant text := 'T0FIXTURE01';
        id1 uuid; id2 uuid; made1 boolean; made2 boolean; e1 timestamptz; e2 timestamptz;
        raised boolean; msg text; n int;
begin
  select job_id, was_created, job_expires_at into id1, made1, e1
    from public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-idem', CB, TM, pg_temp.seal('idem'), SC, KI);
  assert made1, 'J4 the first enqueue creates the job';
  assert e1 > now() and e1 <= now() + interval '10 minutes', 'J4 the job is short-lived';

  -- THE retry: the same bytes, sent again. Same job, no second row.
  select job_id, was_created, job_expires_at into id2, made2, e2
    from public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-idem', CB, TM, pg_temp.seal('idem'), SC, KI);
  assert not made2 and id2 = id1 and e2 = e1, 'J4 an identical retry returns the SAME job';

  -- A DIFFERENT sealed payload under the same correlation is a different request. This is the 0080 lesson one layer up:
  -- were the digest computed over the bound fields alone it would be a tautology here, and a SUBSTITUTED authorization
  -- code would be accepted as "already done" and reported as success.
  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-idem', CB, TM, pg_temp.seal('SUBSTITUTED'), SC, KI);
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'J4 a different payload under the same correlation must be REJECTED, not merged';
  assert msg like '%different request%', 'J4 rejected for the right reason, got: ' || msg;

  -- …and every other bound field is part of the same identity.
  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-idem', CB, 'T0FIXTURE02', pg_temp.seal('idem'), SC, KI);
  exception when others then raised := true; end;
  assert raised, 'J4 a different workspace under the same correlation must be rejected';

  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-idem', CB, TM, pg_temp.seal('idem'), SC, 'worker-staging-2');
  exception when others then raised := true; end;
  assert raised, 'J4 a different worker key under the same correlation must be rejected';

  -- The retry did not mint a second job, observed through the ONLY read this role has: the enqueue's own answer.
  select job_id, was_created into id2, made2
    from public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-idem', CB, TM, pg_temp.seal('idem'), SC, KI);
  assert not made2 and id2 = id1, 'J4 the correlation still resolves to the one original job';
end $$;

reset role;
do $$
declare n int;
begin
  select count(*) into n from public.oauth_completion_jobs j where j.correlation_id = 'job-idem';
  assert n = 1, 'J4 exactly one job exists for the correlation, found ' || n;
  select count(*) into n from public.oauth_completion_jobs;
  assert n = 1, 'J4 …and no rejected variant left a row behind, found ' || n;
end $$;
set role oauth_completer;

-- ════ J5: claim — atomic, once, and only while pending and unexpired ══════════════════════════════════════════════
do $$
declare TA constant uuid := 'e5000000-0000-4000-8000-00000000000a';
        TB constant uuid := 'e5000000-0000-4000-8000-00000000000b';
        C1 constant uuid := 'e5000000-0000-4000-8000-0000000000c1';
        C3 constant uuid := 'e5000000-0000-4000-8000-0000000000c3';
        CB constant text := 'https://idcaddie-v3.vercel.app/connectors/oauth/callback';
        SC constant text := 'X25519-HKDF-SHA256-AES-256-GCM';
        KI constant text := 'worker-staging-1';
        TM constant text := 'T0FIXTURE01';
        got boolean; why text; pay bytea; sch text; kid text; team text; att int;
begin
  perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-ok', CB, TM, pg_temp.seal('ok'), SC, KI);

  -- CROSS-TENANT and WRONG-CONNECTOR probes learn `not_found` and nothing else.
  select claimed, refusal into got, why from public.oauth_completer_claim_oauth_completion_job(TB, C1, 'job-ok');
  assert got = false and why = 'not_found', 'J5 cross-tenant claim, got ' || coalesce(why, '<null>');
  select claimed, refusal into got, why from public.oauth_completer_claim_oauth_completion_job(TA, C3, 'job-ok');
  assert got = false and why = 'not_found', 'J5 wrong-connector claim, got ' || coalesce(why, '<null>');
  select claimed, refusal into got, why from public.oauth_completer_claim_oauth_completion_job(TA, C1, 'job-nope');
  assert got = false and why = 'not_found', 'J5 unknown correlation, got ' || coalesce(why, '<null>');

  -- THE claim. It is the only path by which the sealed payload leaves the table.
  select claimed, refusal, sealed_payload, sealed_scheme, sealed_key_id, expected_workspace_id, attempts
    into got, why, pay, sch, kid, team, att
    from public.oauth_completer_claim_oauth_completion_job(TA, C1, 'job-ok');
  assert got = true and why is null, 'J5 the legitimate claim must succeed';
  assert pay = pg_temp.seal('ok'), 'J5 the claim hands back the sealed payload verbatim';
  assert sch = SC and kid = KI and team = TM, 'J5 …with the scheme, key id and bound workspace';
  assert att = 1, 'J5 the attempt is counted, got ' || att;

  -- ONE WINNER. Serialised here rather than truly concurrent (one session), but the mechanism under test is the single
  -- UPDATE's `status = 'pending'` predicate, which does not care how the second caller arrived: under READ COMMITTED it
  -- blocks on the row lock, re-evaluates against what the winner wrote, and matches nothing.
  select claimed, refusal, sealed_payload into got, why, pay
    from public.oauth_completer_claim_oauth_completion_job(TA, C1, 'job-ok');
  assert got = false and why = 'already_claimed', 'J5 a duplicate claim must be denied, got ' || coalesce(why, '<null>');
  assert pay is null, 'J5 …and must hand back no payload';
end $$;

-- ════ J6: terminal — only from claimed, exactly once, payload cleared ═════════════════════════════════════════════
do $$
declare TA constant uuid := 'e5000000-0000-4000-8000-00000000000a';
        C1 constant uuid := 'e5000000-0000-4000-8000-0000000000c1';
        CB constant text := 'https://idcaddie-v3.vercel.app/connectors/oauth/callback';
        SC constant text := 'X25519-HKDF-SHA256-AES-256-GCM';
        KI constant text := 'worker-staging-1';
        TM constant text := 'T0FIXTURE01';
        ok boolean; why text; raised boolean;
begin
  -- NO DIRECT pending -> completed. A job that was never claimed cannot be resolved.
  perform public.oauth_completer_enqueue_oauth_completion_job(TA, C1, 'job-fail', CB, TM, pg_temp.seal('fail'), SC, KI);
  select completed, refusal into ok, why from public.oauth_completer_complete_oauth_completion_job(TA, C1, 'job-fail');
  assert ok = false and why = 'not_claimed', 'J6 pending must not complete, got ' || coalesce(why, '<null>');
  select failed, refusal into ok, why from public.oauth_completer_fail_oauth_completion_job(TA, C1, 'job-fail', 'internal');
  assert ok = false and why = 'not_claimed', 'J6 pending must not fail, got ' || coalesce(why, '<null>');

  -- The claimed `job-ok` completes exactly once.
  select completed, refusal into ok, why from public.oauth_completer_complete_oauth_completion_job(TA, C1, 'job-ok');
  assert ok = true, 'J6 a claimed job completes';
  select completed, refusal into ok, why from public.oauth_completer_complete_oauth_completion_job(TA, C1, 'job-ok');
  assert ok = false and why = 'already_terminal', 'J6 a terminal row cannot transition again, got ' || coalesce(why, '<null>');
  select failed, refusal into ok, why from public.oauth_completer_fail_oauth_completion_job(TA, C1, 'job-ok', 'internal');
  assert ok = false and why = 'already_terminal', 'J6 …and cannot be failed afterwards either';

  -- The failure path, on its own job.
  perform public.oauth_completer_claim_oauth_completion_job(TA, C1, 'job-fail');
  raised := false;
  begin perform public.oauth_completer_fail_oauth_completion_job(TA, C1, 'job-fail', 'slack said: invalid_code for team T123');
  exception when others then raised := true; end;
  assert raised, 'J6 a free-form terminal reason must be refused';
  raised := false;
  begin perform public.oauth_completer_fail_oauth_completion_job(TA, C1, 'job-fail', 'expired');
  exception when others then raised := true; end;
  assert raised, 'J6 only the deadline may declare a job expired';

  select failed, refusal into ok, why from public.oauth_completer_fail_oauth_completion_job(TA, C1, 'job-fail', 'exchange_failed');
  assert ok = true, 'J6 a claimed job fails with a bounded reason';
  select completed, refusal into ok, why from public.oauth_completer_complete_oauth_completion_job(TA, C1, 'job-fail');
  assert ok = false and why = 'already_terminal', 'J6 a failed job cannot then complete';
end $$;

reset role;

-- ════ J7: what the terminal rows actually hold ════════════════════════════════════════════════════════════════════
do $$
declare n int; r record;
begin
  select * into r from public.oauth_completion_jobs j where j.correlation_id = 'job-ok';
  assert r.status = 'completed', 'J7 job-ok is completed, got ' || r.status;
  assert r.protected_payload is null and r.payload_scheme is null and r.payload_key_id is null,
    'J7 a terminal row holds NO sealed material';
  assert r.completed_at is not null and r.claimed_at is not null, 'J7 the transitions are stamped';
  assert r.terminal_reason is null, 'J7 a completed job carries no failure reason';
  assert r.attempt_count = 1, 'J7 one claim, one attempt, got ' || r.attempt_count;
  assert r.body_digest ~ '^[0-9a-f]{64}$', 'J7 the digest is a sha256 hex';

  select * into r from public.oauth_completion_jobs j where j.correlation_id = 'job-fail';
  assert r.status = 'failed' and r.terminal_reason = 'exchange_failed', 'J7 job-fail carries a bounded reason';
  assert r.protected_payload is null, 'J7 …and holds no sealed material either';

  -- THE headline: working two jobs to terminal created no evidence and disturbed no credential.
  select count(*) into n from public.connector_runs where tenant_id = 'e5000000-0000-4000-8000-00000000000a';
  assert n = 0, 'J7 a completion job must not open a run, found ' || n;
  select count(*) into n from public.discovery_facts where tenant_id = 'e5000000-0000-4000-8000-00000000000a';
  assert n = 0, 'J7 …nor write a discovery fact, found ' || n;
  select count(*) into n from public.app_accounts where tenant_id = 'e5000000-0000-4000-8000-00000000000a';
  assert n = 0, 'J7 …nor promote canonical evidence, found ' || n;
  select count(*) into n from public.connector_secrets where tenant_id = 'e5000000-0000-4000-8000-00000000000a';
  assert n = 0, 'J7 …nor touch a connector credential, found ' || n;
  select count(*) into n from public.connector_secret_lifecycle_events where tenant_id = 'e5000000-0000-4000-8000-00000000000a';
  assert n = 0, 'J7 …nor supersede one, found ' || n;
  -- The authorize half is untouched: consuming it is a separate, separately-granted operation (0079).
  select count(*) into n from public.oauth_pending where tenant_id = 'e5000000-0000-4000-8000-00000000000a' and consumed_at is not null;
  assert n = 0, 'J7 …nor consume the pending row, found ' || n;
end $$;

-- ════ J8: expiry — unusable, cleared, unrevivable ═════════════════════════════════════════════════════════════════
-- Seeded directly as a privileged role: the wrapper cannot mint a job that is already past its deadline, which is the
-- point of the wrapper.
insert into public.oauth_completion_jobs
  (tenant_id, connector_id, provider, correlation_id, redirect_uri, expected_team_id,
   protected_payload, payload_scheme, payload_key_id, body_digest, status, created_at, expires_at)
values
  ('e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000c1', 'slack', 'job-lazy',
   'https://idcaddie-v3.vercel.app/connectors/oauth/callback', 'T0FIXTURE01',
   '\x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
   'X25519-HKDF-SHA256-AES-256-GCM', 'worker-staging-1', repeat('a', 64), 'pending',
   now() - interval '20 minutes', now() - interval '10 minutes'),
  ('e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000c1', 'slack', 'job-sweep',
   'https://idcaddie-v3.vercel.app/connectors/oauth/callback', 'T0FIXTURE01',
   '\x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
   'X25519-HKDF-SHA256-AES-256-GCM', 'worker-staging-1', repeat('b', 64), 'pending',
   now() - interval '20 minutes', now() - interval '10 minutes');

-- A job claimed by a worker that never came back, now past its deadline.
insert into public.oauth_completion_jobs
  (tenant_id, connector_id, provider, correlation_id, redirect_uri, expected_team_id,
   protected_payload, payload_scheme, payload_key_id, body_digest, status, created_at, expires_at,
   claimed_at, attempt_count)
values
  ('e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000c1', 'slack', 'job-stale',
   'https://idcaddie-v3.vercel.app/connectors/oauth/callback', 'T0FIXTURE01',
   '\x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
   'X25519-HKDF-SHA256-AES-256-GCM', 'worker-staging-1', repeat('c', 64), 'claimed',
   now() - interval '20 minutes', now() - interval '10 minutes', now() - interval '19 minutes', 1);

set role oauth_completer;

do $$
declare TA constant uuid := 'e5000000-0000-4000-8000-00000000000a';
        C1 constant uuid := 'e5000000-0000-4000-8000-0000000000c1';
        CB constant text := 'https://idcaddie-v3.vercel.app/connectors/oauth/callback';
        SC constant text := 'X25519-HKDF-SHA256-AES-256-GCM';
        KI constant text := 'worker-staging-1';
        TM constant text := 'T0FIXTURE01';
        got boolean; why text; n int; raised boolean; msg text;
begin
  -- LAZY expiry: a job past its deadline is unusable even if the sweep has never run, and the claim that discovers it
  -- clears its sealed code in the same moment.
  select claimed, refusal into got, why from public.oauth_completer_claim_oauth_completion_job(TA, C1, 'job-lazy');
  assert got = false and why = 'expired', 'J8 an expired job must not be claimable, got ' || coalesce(why, '<null>');

  -- Completion is impossible afterwards, by either terminal wrapper.
  select completed, refusal into got, why from public.oauth_completer_complete_oauth_completion_job(TA, C1, 'job-lazy');
  assert got = false and why = 'already_terminal', 'J8 an expired job cannot complete, got ' || coalesce(why, '<null>');
  select failed, refusal into got, why from public.oauth_completer_fail_oauth_completion_job(TA, C1, 'job-lazy', 'internal');
  assert got = false and why = 'already_terminal', 'J8 …nor fail';

  -- THE SWEEP: the remaining pending-and-past-deadline job.
  n := public.oauth_completer_expire_oauth_completion_jobs();
  assert n = 1, 'J8 the sweep expires exactly the one remaining stale pending job, got ' || n;
  assert public.oauth_completer_expire_oauth_completion_jobs() = 0, 'J8 a second sweep has nothing left to do';

  -- An EXPIRED correlation cannot be revived. The state JTI is single-use; a new attempt needs a new authorize.
  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(
    TA, C1, 'job-sweep', CB, TM, decode(repeat('00112233445566778899aabbccddeeff', 4), 'hex'), SC, KI);
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'J8 an expired correlation must not be revived';
  assert msg like '%expired%', 'J8 refused for the right reason, got: ' || msg;
end $$;

reset role;

do $$
declare r record;
begin
  select * into r from public.oauth_completion_jobs j where j.correlation_id = 'job-lazy';
  assert r.status = 'expired' and r.terminal_reason = 'expired', 'J8 lazily expired, got ' || r.status;
  assert r.protected_payload is null and r.payload_scheme is null and r.payload_key_id is null,
    'J8 the lazily-expired job holds no sealed material';

  select * into r from public.oauth_completion_jobs j where j.correlation_id = 'job-sweep';
  assert r.status = 'expired' and r.protected_payload is null, 'J8 the swept job is expired and cleared';

  -- The stale CLAIM keeps its status — its terminal transition belongs to the worker that claimed it — but must not go
  -- on holding a sealed authorization code.
  select * into r from public.oauth_completion_jobs j where j.correlation_id = 'job-stale';
  assert r.status = 'claimed', 'J8 a stale claim is not expired underneath its worker, got ' || r.status;
  assert r.protected_payload is null and r.payload_scheme is null and r.payload_key_id is null,
    'J8 …but its sealed code is cleared';
end $$;

-- …and the worker that owns it can still finish. Neither terminal wrapper reads the payload, so clearing a stale
-- claim's sealed code costs nothing: leaving the transition to its owner is what keeps a customer from being told
-- `expired` about a connection that actually completed.
set role oauth_completer;
do $$
declare ok boolean; why text;
begin
  select failed, refusal into ok, why from public.oauth_completer_fail_oauth_completion_job(
    'e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000c1', 'job-stale', 'store_failed');
  assert ok = true, 'J8 a stale claim is still resolvable by its own worker, got ' || coalesce(why, '<null>');
end $$;
reset role;

-- ════ J9: the constraints, not the wrappers ═══════════════════════════════════════════════════════════════════════
-- Every gate above is also a table constraint, so a privileged writer cannot produce a shape the wrappers refuse.
do $$
declare raised boolean;
  P constant bytea := '\x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
begin
  -- A terminal row holding a sealed payload is IMPOSSIBLE, not merely never written.
  raised := false;
  begin update public.oauth_completion_jobs set protected_payload = P where correlation_id = 'job-ok';
  exception when others then raised := true; end;
  assert raised, 'J9 a terminal row may never regain a sealed payload';

  -- A long-lived job is impossible.
  raised := false;
  begin insert into public.oauth_completion_jobs
    (tenant_id, connector_id, provider, correlation_id, redirect_uri, expected_team_id,
     protected_payload, payload_scheme, payload_key_id, body_digest, status, created_at, expires_at)
  values ('e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000c1', 'slack', 'job-forever',
     'https://idcaddie-v3.vercel.app/connectors/oauth/callback', 'T0FIXTURE01', P,
     'X25519-HKDF-SHA256-AES-256-GCM', 'worker-staging-1', repeat('d', 64), 'pending', now(), now() + interval '2 days');
  exception when others then raised := true; end;
  assert raised, 'J9 a job may not outlive the short-lived ceiling';

  -- A second job for one correlation is impossible.
  raised := false;
  begin insert into public.oauth_completion_jobs
    (tenant_id, connector_id, provider, correlation_id, redirect_uri, expected_team_id,
     protected_payload, payload_scheme, payload_key_id, body_digest, status, created_at, expires_at)
  values ('e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000c1', 'slack', 'job-ok',
     'https://idcaddie-v3.vercel.app/connectors/oauth/callback', 'T0FIXTURE01', P,
     'X25519-HKDF-SHA256-AES-256-GCM', 'worker-staging-1', repeat('e', 64), 'pending', now(), now() + interval '5 minutes');
  exception when others then raised := true; end;
  assert raised, 'J9 one correlation may hold at most one job, forever';

  -- A cross-tenant connector binding is impossible.
  raised := false;
  begin insert into public.oauth_completion_jobs
    (tenant_id, connector_id, provider, correlation_id, redirect_uri, expected_team_id,
     protected_payload, payload_scheme, payload_key_id, body_digest, status, created_at, expires_at)
  values ('e5000000-0000-4000-8000-00000000000b', 'e5000000-0000-4000-8000-0000000000c1', 'slack', 'job-xtenant',
     'https://idcaddie-v3.vercel.app/connectors/oauth/callback', 'T0FIXTURE01', P,
     'X25519-HKDF-SHA256-AES-256-GCM', 'worker-staging-1', repeat('f', 64), 'pending', now(), now() + interval '5 minutes');
  exception when others then raised := true; end;
  assert raised, 'J9 a job may not bind another tenant''s connector';

  -- A foreign redirect and a non-Slack provider are impossible.
  raised := false;
  begin insert into public.oauth_completion_jobs
    (tenant_id, connector_id, provider, correlation_id, redirect_uri, expected_team_id,
     protected_payload, payload_scheme, payload_key_id, body_digest, status, created_at, expires_at)
  values ('e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000c1', 'slack', 'job-redir',
     'https://attacker.example/connectors/oauth/callback', 'T0FIXTURE01', P,
     'X25519-HKDF-SHA256-AES-256-GCM', 'worker-staging-1', repeat('a', 64), 'pending', now(), now() + interval '5 minutes');
  exception when others then raised := true; end;
  assert raised, 'J9 a foreign redirect may never be stored';

  raised := false;
  begin insert into public.oauth_completion_jobs
    (tenant_id, connector_id, provider, correlation_id, redirect_uri, expected_team_id,
     protected_payload, payload_scheme, payload_key_id, body_digest, status, created_at, expires_at)
  values ('e5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-0000000000c2', 'okta', 'job-okta',
     'https://idcaddie-v3.vercel.app/connectors/oauth/callback', 'T0FIXTURE01', P,
     'X25519-HKDF-SHA256-AES-256-GCM', 'worker-staging-1', repeat('a', 64), 'pending', now(), now() + interval '5 minutes');
  exception when others then raised := true; end;
  assert raised, 'J9 the provider is pinned to Slack in the table, not only in the wrapper';
end $$;

-- ════ J10: the customer read — bounded, tenant-scoped, and blind to everything protected ══════════════════════════
do $$
declare n int; cols text;
begin
  -- Structural first: the read CANNOT return a protected field, because it declares none.
  select string_agg(p.parameter_name, ',') into cols from information_schema.parameters p
   where p.specific_schema = 'public' and p.specific_name like 'product_oauth_completion_job_status%';
  assert cols !~* '(payload|nonce|digest|attempt|claimed|scheme|key_id|connector|redirect|team|workspace)',
    'J10 the customer read declares a protected column: ' || coalesce(cols, '<none>');
  select count(*) into n from information_schema.parameters p
   where p.specific_schema = 'public' and p.specific_name like 'product_oauth_completion_job_status%'
     and p.parameter_mode = 'OUT';
  assert n = 5, 'J10 the customer read returns exactly five bounded fields, got ' || n;
end $$;

select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-8000-0000000000f1"}', false);
set role authenticated;

do $$
declare TA constant uuid := 'e5000000-0000-4000-8000-00000000000a';
        r record; n int; raised boolean;
begin
  select * into r from public.product_oauth_completion_job_status(TA, 'job-ok');
  assert r.job_status = 'completed', 'J10 an owner sees the status, got ' || coalesce(r.job_status, '<none>');
  assert r.job_completed_at is not null and r.job_terminal_reason is null, 'J10 …and the bounded terminal fields';

  select count(*) into n from public.product_oauth_completion_job_status(TA, 'job-does-not-exist');
  assert n = 0, 'J10 an unknown correlation returns nothing, got ' || n;

  -- The table itself stays unreachable. An ordinary authenticated session cannot read ONE protected field.
  raised := false;
  begin perform 1 from public.oauth_completion_jobs limit 1; exception when others then raised := true; end;
  assert raised, 'J10 direct SELECT on the job table must be denied to authenticated';

  raised := false;
  begin update public.oauth_completion_jobs set status = 'completed'; exception when others then raised := true; end;
  assert raised, 'J10 …and so must any write';

  -- The completion wrappers are not a browser surface.
  raised := false;
  begin perform public.oauth_completer_claim_oauth_completion_job(TA, 'e5000000-0000-4000-8000-0000000000c1', 'job-ok');
  exception when others then raised := true; end;
  assert raised, 'J10 an authenticated user must not be able to claim a job';
end $$;

-- An EDITOR of the same tenant, and the OWNER of another tenant, are both told nothing — and cannot tell each other's
-- answer from "no such job".
select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-8000-0000000000f2"}', false);
do $$
declare n int;
begin
  select count(*) into n from public.product_oauth_completion_job_status('e5000000-0000-4000-8000-00000000000a', 'job-ok');
  assert n = 0, 'J10 an editor gets no status at all, got ' || n;
end $$;

select set_config('request.jwt.claims', '{"sub":"e5000000-0000-4000-8000-0000000000f3"}', false);
do $$
declare n int;
begin
  select count(*) into n from public.product_oauth_completion_job_status('e5000000-0000-4000-8000-00000000000a', 'job-ok');
  assert n = 0, 'J10 another tenant''s owner gets no status, got ' || n;
  -- …and naming their own tenant does not surface someone else's job either.
  select count(*) into n from public.product_oauth_completion_job_status('e5000000-0000-4000-8000-00000000000b', 'job-ok');
  assert n = 0, 'J10 a correlation is never visible outside its own tenant, got ' || n;
end $$;

reset role;
select set_config('request.jwt.claims', '', false);

-- ════ J11: no refusal carries secret, sealed, host or provider material ═══════════════════════════════════════════
do $$
declare msg text; raised boolean;
  TA constant uuid := 'e5000000-0000-4000-8000-00000000000a';
  C1 constant uuid := 'e5000000-0000-4000-8000-0000000000c1';
  SC constant text := 'X25519-HKDF-SHA256-AES-256-GCM';
begin
  set local role oauth_completer;

  raised := false;
  begin perform public.oauth_completer_enqueue_oauth_completion_job(
    TA, C1, 'job-leak', 'https://attacker.example/connectors/oauth/callback', 'T0LEAKWORKSPACE',
    decode(repeat('deadbeefcafebabe', 8), 'hex'), SC, 'worker-leak-key');
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'J11 setup';
  assert msg !~* '(attacker|https?://|T0LEAKWORKSPACE|worker-leak-key|deadbeef|xox|\\\\x)',
    'J11 the refusal leaked request material: ' || msg;

  raised := false;
  begin perform public.oauth_completer_fail_oauth_completion_job(
    TA, C1, 'job-ok', 'slack returned invalid_code for xoxb-not-a-real-token');
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'J11 setup 2';
  assert msg !~* '(xox|invalid_code|slack returned)', 'J11 the refusal echoed the caller''s reason: ' || msg;

  reset role;
end $$;
