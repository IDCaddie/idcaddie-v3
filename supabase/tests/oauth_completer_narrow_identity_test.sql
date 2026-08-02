-- 0079 — the narrow `oauth_completer` identity.
--
-- The property this suite exists to protect: if the public web tier is fully compromised, the attacker can complete an
-- OAuth flow for a connector that already has a pending row, and can do NOTHING else. Not read a customer's evidence,
-- not write a fact, not stale an account, not reach a table.
--
-- Everything else here — provider pinning, replay, idempotency — is in service of that.

reset role;

insert into public.tenants (id, name, slug) values
  ('c3000000-0000-4000-8000-00000000000a', 'OC A', 'oc-a'),
  ('c3000000-0000-4000-8000-00000000000b', 'OC B', 'oc-b');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('c3000000-0000-4000-8000-0000000000c1', 'c3000000-0000-4000-8000-00000000000a', 'slack', 'WS A', 'pending', 'discovered'),
  ('c3000000-0000-4000-8000-0000000000c2', 'c3000000-0000-4000-8000-00000000000a', 'okta',  'Okta A', 'pending', 'discovered'),
  ('c3000000-0000-4000-8000-0000000000c3', 'c3000000-0000-4000-8000-00000000000b', 'slack', 'WS B', 'pending', 'discovered');

insert into public.connector_app_secrets
  (app_env, provider, secret_kind, version, ciphertext, dek_wrapped, aead_nonce, aead_tag, aad_digest, kek_id, envelope_version, aead_alg, is_active)
values
-- Version 91 rather than 1: the app-secret identity key is (app_env, provider, secret_kind, version) with no tenant,
-- and another suite in this same database already seeds version 1. A distinct version keeps this file independent AND
-- lets C4 assert the highest-active-version rule rather than just 'a row came back'.
  ('staging', 'slack', 'oauth_client_secret', 91, '\x01', '\x02', '\x03', '\x04', 'digest-app-91', 'kek-1', 1, 'AES-256-GCM', true);

-- ════ C0: the granted surface is EXACTLY three functions ══════════════════════════════════════════════════════════
do $$
declare f text; n int;
begin
  foreach f in array array[
    'public.oauth_completer_read_app_client_secret_envelope(text,uuid,uuid)',
    'public.oauth_completer_consume_oauth_pending(uuid,uuid,text,text,uuid,text,timestamptz)',
    'public.oauth_completer_store_connector_secret_envelope(uuid,uuid,integer,bytea,bytea,bytea,bytea,text,text,integer,text,text)']
  loop
    assert has_function_privilege('oauth_completer', f, 'EXECUTE'), 'C0 oauth_completer EXECUTE ' || f;
    -- Every other role is denied, including the runner: it has its own path and must not gain a second one.
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'C0 anon denied ' || f;
    assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'C0 authenticated denied ' || f;
    assert not has_function_privilege('service_role', f, 'EXECUTE'), 'C0 service_role denied ' || f;
    assert not has_function_privilege('public', f, 'EXECUTE'), 'C0 PUBLIC denied ' || f;
    assert not has_function_privilege('connector_runner', f, 'EXECUTE'), 'C0 connector_runner denied ' || f;
    -- security definer + a pinned EMPTY search_path.
    assert (select prosecdef from pg_proc where oid = f::regprocedure), 'C0 security definer ' || f;
    -- Postgres stores `set search_path = ''` as the quoted-empty form. Asserting the EMPTY value specifically (not
    -- merely "a search_path is pinned") is the point: `search_path=public` would still be a pinned path, and would
    -- still let an unqualified reference resolve somewhere this function never intended.
    assert (select array_to_string(proconfig, ',') from pg_proc where oid = f::regprocedure) in ('search_path=', 'search_path=""'),
      'C0 empty search_path ' || f || ' got ' || coalesce((select array_to_string(proconfig, ',') from pg_proc where oid = f::regprocedure), '<null>');
  end loop;

  -- THE headline assertion, stated precisely.
  --
  -- Postgres grants EXECUTE on every new function to PUBLIC by default, so a bare
  -- `has_function_privilege('oauth_completer', ...)` is true for every function that has not explicitly revoked from
  -- PUBLIC — roughly 45 ordinary helpers here. Revoking those from the ROLE does not remove a PUBLIC grant, and
  -- revoking them from PUBLIC would change the posture for every other role, which is not this migration's business.
  --
  -- What actually matters is that no SECURITY DEFINER function outside the three wrappers is reachable: a definer
  -- function runs with its OWNER's authority, so one reachable by this role is a privilege-escalation path. A plain
  -- (invoker) function grants nothing, because the role holds no table privilege for it to borrow — which C1 proves.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname not like 'oauth\_completer\_%'
     and p.prosecdef
     and has_function_privilege('oauth_completer', p.oid, 'EXECUTE');
  assert n = 0, 'C0 no OTHER security-definer function may be reachable by oauth_completer, found ' || n;

  -- …and specifically none of the runner or product surface.
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and (p.proname like 'runner\_%' or p.proname like 'product\_%')
     and has_function_privilege('oauth_completer', p.oid, 'EXECUTE');
  assert n = 0, 'C0 no runner_*/product_* function may be executable, found ' || n;
end $$;

-- ════ C1: ZERO table and sequence privileges ══════════════════════════════════════════════════════════════════════
do $$
declare n int;
begin
  select count(*) into n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
     and (has_table_privilege('oauth_completer', c.oid, 'SELECT')
       or has_table_privilege('oauth_completer', c.oid, 'INSERT')
       or has_table_privilege('oauth_completer', c.oid, 'UPDATE')
       or has_table_privilege('oauth_completer', c.oid, 'DELETE')
       or has_table_privilege('oauth_completer', c.oid, 'TRUNCATE'));
  assert n = 0, 'C1 oauth_completer must hold ZERO table privileges, found ' || n;

  -- Named explicitly as well as counted, so a future table cannot quietly become the exception.
  foreach n in array array[1] loop null; end loop;
  assert not has_table_privilege('oauth_completer', 'public.connector_app_secrets', 'SELECT'), 'C1 no app-secret SELECT';
  assert not has_table_privilege('oauth_completer', 'public.connector_secrets', 'SELECT'), 'C1 no connector-secret SELECT';
  assert not has_table_privilege('oauth_completer', 'public.connector_secrets', 'INSERT'), 'C1 no connector-secret INSERT';
  assert not has_table_privilege('oauth_completer', 'public.oauth_pending', 'UPDATE'), 'C1 no pending UPDATE';
  assert not has_table_privilege('oauth_completer', 'public.discovery_facts', 'INSERT'), 'C1 no discovery-fact INSERT';
  assert not has_table_privilege('oauth_completer', 'public.app_accounts', 'SELECT'), 'C1 no canonical evidence SELECT';
  assert not has_table_privilege('oauth_completer', 'public.identity_accounts', 'SELECT'), 'C1 no identity SELECT';
  assert not has_table_privilege('oauth_completer', 'public.connector_runs', 'INSERT'), 'C1 cannot open a run';

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'S'
     and (has_sequence_privilege('oauth_completer', c.oid, 'USAGE') or has_sequence_privilege('oauth_completer', c.oid, 'SELECT')
       or has_sequence_privilege('oauth_completer', c.oid, 'UPDATE'));
  assert n = 0, 'C1 oauth_completer must hold ZERO sequence privileges, found ' || n;
end $$;

-- ════ C2: role attributes and no membership in broader roles ══════════════════════════════════════════════════════
do $$
declare r record; n int;
begin
  select * into r from pg_roles where rolname = 'oauth_completer';
  assert r.rolcanlogin, 'C2 login';
  assert not r.rolsuper, 'C2 NOSUPERUSER';
  assert not r.rolcreatedb, 'C2 NOCREATEDB';
  assert not r.rolcreaterole, 'C2 NOCREATEROLE';
  assert not r.rolreplication, 'C2 NOREPLICATION';
  assert not r.rolbypassrls, 'C2 NOBYPASSRLS';

  select count(*) into n from pg_auth_members m
    join pg_roles g on g.oid = m.roleid
    join pg_roles mem on mem.oid = m.member
   where mem.rolname = 'oauth_completer';
  assert n = 0, 'C2 oauth_completer must be a member of NO role, found ' || n;
end $$;

-- ════ C3: no plaintext parameter exists on any wrapper ════════════════════════════════════════════════════════════
-- A wrapper that ACCEPTED a token would put plaintext across a privilege boundary and into a query log. The absence is
-- asserted structurally, so it cannot be reintroduced by adding an argument.
do $$
declare n int;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'oauth\_completer\_%'
     and (array_to_string(p.proargnames, ',') ~* '(plaintext|token|secret_value|client_secret|password|access_token)');
  assert n = 0, 'C3 no wrapper may take a plaintext parameter, found ' || n;

  -- And no wrapper RETURNS plaintext either — the read returns an envelope, never a decrypted value.
  select count(*) into n from information_schema.parameters
   where specific_schema = 'public' and specific_name like 'oauth_completer%'
     and parameter_name ~* '(plaintext|access_token|client_secret)';
  assert n = 0, 'C3 no wrapper may return a plaintext column, found ' || n;
end $$;

-- ── Run the behavioural checks AS the role, which is the only honest way to test a privilege boundary.
set role oauth_completer;

-- ════ C4: the app-secret read — envelope only, tenant/connector/provider pinned ═══════════════════════════════════
do $$
declare n int; raised boolean; msg text;
begin
  select count(*) into n from public.oauth_completer_read_app_client_secret_envelope(
    'staging', 'c3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-0000000000c1');
  assert n = 1, 'C4 exactly one envelope is returned, got ' || n;
  -- The HIGHEST active version, not merely any row.
  assert (select version from public.oauth_completer_read_app_client_secret_envelope(
    'staging', 'c3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-0000000000c1')) = 91,
    'C4 the newest active version wins';

  -- Wrong tenant for that connector.
  raised := false;
  begin perform public.oauth_completer_read_app_client_secret_envelope(
    'staging', 'c3000000-0000-4000-8000-00000000000b', 'c3000000-0000-4000-8000-0000000000c1');
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'C4 wrong tenant must be refused';
  assert msg like '%does not belong%', 'C4 refused by the ownership gate, got: ' || msg;

  -- A connector that is not Slack.
  raised := false;
  begin perform public.oauth_completer_read_app_client_secret_envelope(
    'staging', 'c3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-0000000000c2');
  exception when others then raised := true; end;
  assert raised, 'C4 a non-Slack connector must be refused';

  -- An unknown connector.
  raised := false;
  begin perform public.oauth_completer_read_app_client_secret_envelope(
    'staging', 'c3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-0000000000ff');
  exception when others then raised := true; end;
  assert raised, 'C4 an unknown connector must be refused';

  -- A different app_env.
  raised := false;
  begin perform public.oauth_completer_read_app_client_secret_envelope(
    'production', 'c3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-0000000000c1');
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'C4 another app_env must be refused';
  assert msg not like '%staging%', 'C4 the refusal must not echo the environment';
end $$;

-- ════ C5: direct table access is denied even holding the role ═════════════════════════════════════════════════════
do $$
declare raised boolean;
begin
  raised := false;
  begin perform 1 from public.connector_app_secrets limit 1; exception when others then raised := true; end;
  assert raised, 'C5 direct SELECT on connector_app_secrets must be denied';

  raised := false;
  begin perform 1 from public.connector_secrets limit 1; exception when others then raised := true; end;
  assert raised, 'C5 direct SELECT on connector_secrets must be denied';

  raised := false;
  begin update public.oauth_pending set consumed_at = now(); exception when others then raised := true; end;
  assert raised, 'C5 direct UPDATE on oauth_pending must be denied';

  raised := false;
  begin insert into public.discovery_facts (tenant_id, schema_version, fact_type, source_type, source_provider, observed_at)
        values ('c3000000-0000-4000-8000-00000000000a', '1', 'group', 'deep_provider_sync', 'slack', now());
  exception when others then raised := true; end;
  assert raised, 'C5 an OAuth completion must not be able to create a discovery fact';

  raised := false;
  begin insert into public.connector_runs (tenant_id, connector_id, status)
        values ('c3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-0000000000c1', 'running');
  exception when others then raised := true; end;
  assert raised, 'C5 an OAuth completion must not be able to open a run';
end $$;

reset role;

-- Seed pending rows as a privileged role (the web tier never creates them; the authorize half does).
insert into public.oauth_pending (tenant_id, connector_id, provider, subject, state_jti, nonce_hash, intent, expires_at)
values
  ('c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','slack','c3000000-0000-4000-8000-00000000f001'::uuid,'jti-ok','hash-ok','connect', now() + interval '10 minutes'),
  ('c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','slack','c3000000-0000-4000-8000-00000000f001'::uuid,'jti-expired','hash-exp','connect', now() - interval '1 minute');

set role oauth_completer;

-- ════ C6: consume — single use, full context, bounded refusals ════════════════════════════════════════════════════
do $$
declare ok boolean; why text;
  CB constant text := 'https://idcaddie-v3.vercel.app/connectors/oauth/callback';
begin
  -- Wrong redirect is refused BEFORE the row is touched, so it cannot burn a legitimate pending row.
  select consumed, reason into ok, why from public.oauth_completer_consume_oauth_pending(
    'c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','jti-ok','hash-ok','c3000000-0000-4000-8000-00000000f001'::uuid,
    'https://attacker.example/connectors/oauth/callback', now());
  assert ok = false and why = 'redirect_uri_mismatch', 'C6 redirect mismatch, got ' || coalesce(why,'<null>');

  -- Wrong tenant.
  select consumed, reason into ok, why from public.oauth_completer_consume_oauth_pending(
    'c3000000-0000-4000-8000-00000000000b','c3000000-0000-4000-8000-0000000000c1','jti-ok','hash-ok','c3000000-0000-4000-8000-00000000f001'::uuid, CB, now());
  assert ok = false, 'C6 wrong tenant must not consume';

  -- Wrong connector.
  select consumed, reason into ok, why from public.oauth_completer_consume_oauth_pending(
    'c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c3','jti-ok','hash-ok','c3000000-0000-4000-8000-00000000f001'::uuid, CB, now());
  assert ok = false, 'C6 wrong connector must not consume';

  -- Wrong subject.
  select consumed, reason into ok, why from public.oauth_completer_consume_oauth_pending(
    'c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','jti-ok','hash-ok','c3000000-0000-4000-8000-00000000f009'::uuid, CB, now());
  assert ok = false, 'C6 wrong subject must not consume';

  -- Expired.
  select consumed, reason into ok, why from public.oauth_completer_consume_oauth_pending(
    'c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','jti-expired','hash-exp','c3000000-0000-4000-8000-00000000f001'::uuid, CB, now());
  assert ok = false and why = 'expired', 'C6 expired, got ' || coalesce(why,'<null>');

  -- The legitimate consume, exactly once.
  select consumed, reason into ok, why from public.oauth_completer_consume_oauth_pending(
    'c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','jti-ok','hash-ok','c3000000-0000-4000-8000-00000000f001'::uuid, CB, now());
  assert ok = true, 'C6 the legitimate consume must succeed';

  -- REPLAY.
  select consumed, reason into ok, why from public.oauth_completer_consume_oauth_pending(
    'c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','jti-ok','hash-ok','c3000000-0000-4000-8000-00000000f001'::uuid, CB, now());
  assert ok = false and why = 'already_consumed', 'C6 replay must be denied, got ' || coalesce(why,'<null>');

  -- Unknown state.
  select consumed, reason into ok, why from public.oauth_completer_consume_oauth_pending(
    'c3000000-0000-4000-8000-00000000000a','c3000000-0000-4000-8000-0000000000c1','jti-nope','hash-nope','c3000000-0000-4000-8000-00000000f001'::uuid, CB, now());
  assert ok = false and why = 'not_found', 'C6 unknown state, got ' || coalesce(why,'<null>');
end $$;

-- ════ C7: store — envelope only, versioned, superseding, idempotent ═══════════════════════════════════════════════
do $$
declare id1 uuid; v1 int; created1 boolean; id2 uuid; v2 int; created2 boolean; raised boolean;
  ten constant uuid := 'c3000000-0000-4000-8000-00000000000a';
  conn constant uuid := 'c3000000-0000-4000-8000-0000000000c1';
begin
  select secret_id, version, created into id1, v1, created1 from public.oauth_completer_store_connector_secret_envelope(
    ten, conn, 1, '\xaa', '\xbb', '\xcc', '\xdd0102030405060708090a0b0c0d0e0f', 'digest-1', 'kek-1', 1, 'AES-256-GCM', 'corr-1');
  assert created1, 'C7 the first envelope is created';
  assert v1 = 1, 'C7 versioning starts at 1, got ' || v1;

  -- Idempotent: the same digest returns the SAME row, not a second version.
  select secret_id, version, created into id2, v2, created2 from public.oauth_completer_store_connector_secret_envelope(
    ten, conn, 1, '\xaa', '\xbb', '\xcc', '\xdd0102030405060708090a0b0c0d0e0f', 'digest-1', 'kek-1', 1, 'AES-256-GCM', 'corr-1');
  assert not created2 and id2 = id1 and v2 = v1, 'C7 a retry must not mint a second credential';

  -- A genuinely new envelope supersedes the previous one and records it.
  select secret_id, version, created into id2, v2, created2 from public.oauth_completer_store_connector_secret_envelope(
    ten, conn, 2, '\x11', '\x22', '\x33', '\x44f10203040506ff08090a0b0c0d0e0f', 'digest-2', 'kek-1', 1, 'AES-256-GCM', 'corr-2');
  assert created2 and v2 = 2, 'C7 a new envelope is version 2, got ' || v2;

  -- Wrong tenant / non-Slack connector are refused.
  raised := false;
  begin perform public.oauth_completer_store_connector_secret_envelope(
    'c3000000-0000-4000-8000-00000000000b', conn, 3, '\x11','\x22','\x33','\x44f10203040506ff08090a0b0c0d0e0f','digest-x','kek-1',1,'AES-256-GCM','c');
  exception when others then raised := true; end;
  assert raised, 'C7 wrong tenant must be refused';

  raised := false;
  begin perform public.oauth_completer_store_connector_secret_envelope(
    ten, 'c3000000-0000-4000-8000-0000000000c2', 3, '\x11','\x22','\x33','\x44f10203040506ff08090a0b0c0d0e0f','digest-y','kek-1',1,'AES-256-GCM','c');
  exception when others then raised := true; end;
  assert raised, 'C7 a non-Slack connector must be refused';

  -- An incomplete envelope is refused rather than stored as an unopenable credential.
  raised := false;
  begin perform public.oauth_completer_store_connector_secret_envelope(
    ten, conn, 3, '\x11', null, '\x33','\x44f10203040506ff08090a0b0c0d0e0f','digest-z','kek-1',1,'AES-256-GCM','c');
  exception when others then raised := true; end;
  assert raised, 'C7 an incomplete envelope must be refused';
end $$;

reset role;

-- ════ C8: what the store actually wrote — envelope-only, superseded, audited, and NO evidence ═════════════════════
do $$
declare n int;
begin
  select count(*) into n from public.connector_secrets s
   where s.connector_id = 'c3000000-0000-4000-8000-0000000000c1' and s.secret_kind = 'oauth_access';
  assert n = 2, 'C8 exactly two versions exist, got ' || n;

  select count(*) into n from public.connector_secrets s
   where s.connector_id = 'c3000000-0000-4000-8000-0000000000c1' and s.is_active;
  assert n = 1, 'C8 exactly one is active, got ' || n;

  -- Only oauth_access was ever written; no other purpose is reachable through this wrapper.
  select count(*) into n from public.connector_secrets s
   where s.connector_id = 'c3000000-0000-4000-8000-0000000000c1' and s.secret_kind <> 'oauth_access';
  assert n = 0, 'C8 the wrapper can only write oauth_access';

  -- The supersession is recorded with bounded metadata.
  select count(*) into n from public.connector_secret_lifecycle_events e
   where e.connector_id = 'c3000000-0000-4000-8000-0000000000c1' and e.lifecycle_event_type = 'superseded';
  assert n = 1, 'C8 the previous credential was superseded and recorded, got ' || n;

  -- THE headline: an OAuth completion created no evidence of any kind.
  select count(*) into n from public.discovery_facts where tenant_id = 'c3000000-0000-4000-8000-00000000000a';
  assert n = 0, 'C8 an OAuth completion must create no discovery facts, found ' || n;
  select count(*) into n from public.app_accounts where tenant_id = 'c3000000-0000-4000-8000-00000000000a';
  assert n = 0, 'C8 …and no canonical SaaS evidence, found ' || n;
  select count(*) into n from public.connector_runs where tenant_id = 'c3000000-0000-4000-8000-00000000000a';
  assert n = 0, 'C8 …and no connector run, found ' || n;
end $$;

-- ════ C9: no refusal carries a secret, ciphertext, host, email or environment value ═══════════════════════════════
do $$
declare msg text; raised boolean;
begin
  set local role oauth_completer;
  raised := false;
  begin perform public.oauth_completer_read_app_client_secret_envelope(
    'production', 'c3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-0000000000c1');
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'C9 setup';
  assert msg !~* '(staging|production|xox|secret|ciphertext|@|https?://|kek-|digest-)', 'C9 refusal leaked context: ' || msg;

  raised := false;
  begin perform public.oauth_completer_store_connector_secret_envelope(
    'c3000000-0000-4000-8000-00000000000b', 'c3000000-0000-4000-8000-0000000000c1',
    3, '\x11','\x22','\x33','\x44f10203040506ff08090a0b0c0d0e0f','digest-leak','kek-leak',1,'AES-256-GCM','corr');
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'C9 setup 2';
  assert msg !~* '(digest-leak|kek-leak|xox|ciphertext|aes-|\\\\x)', 'C9 refusal leaked envelope material: ' || msg;
  reset role;
end $$;
