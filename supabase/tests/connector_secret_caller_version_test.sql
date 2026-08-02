-- 0080 — the credential version is the CALLER's, because the encryption already made it so.
--
-- The property this suite protects: a stored envelope can always be opened again. That means the version sealed into
-- the AAD and the version on the row must be the same number, forever, and a failure to store must never disarm the
-- credential that currently works.

reset role;

insert into public.tenants (id, name, slug) values
  ('d4000000-0000-4000-8000-00000000000a', 'Ver A', 'ver-a'),
  ('d4000000-0000-4000-8000-00000000000b', 'Ver B', 'ver-b');
insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('d4000000-0000-4000-8000-0000000000c1', 'd4000000-0000-4000-8000-00000000000a', 'slack', 'WS A', 'pending', 'discovered'),
  ('d4000000-0000-4000-8000-0000000000c2', 'd4000000-0000-4000-8000-00000000000a', 'okta',  'Okta A', 'pending', 'discovered'),
  ('d4000000-0000-4000-8000-0000000000c3', 'd4000000-0000-4000-8000-00000000000b', 'slack', 'WS B', 'pending', 'discovered');

-- A complete, valid envelope differing only by digest, so "same/different envelope" is the variable under test.
create or replace function pg_temp.env(p_digest text) returns text language sql immutable as $$ select p_digest $$;

-- ════ V0: the granted surface ═════════════════════════════════════════════════════════════════════════════════════
do $$
declare f text; n int;
begin
  foreach f in array array[
    'public.oauth_completer_next_connector_secret_version(uuid,uuid)',
    'public.oauth_completer_store_connector_secret_envelope(uuid,uuid,integer,bytea,bytea,bytea,bytea,text,text,integer,text,text)']
  loop
    assert     has_function_privilege('oauth_completer', f, 'EXECUTE'), 'V0 oauth_completer EXECUTE ' || f;
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'V0 anon denied ' || f;
    assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'V0 authenticated denied ' || f;
    assert not has_function_privilege('connector_runner', f, 'EXECUTE'), 'V0 connector_runner denied ' || f;
    assert (select prosecdef from pg_proc where oid = f::regprocedure), 'V0 security definer ' || f;
    assert (select array_to_string(proconfig, ',') from pg_proc where oid = f::regprocedure) in ('search_path=', 'search_path=""'),
      'V0 empty search_path ' || f;
  end loop;

  -- The version-DERIVING store must be gone, not merely superseded. Leaving it callable leaves the defect reachable.
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'oauth_completer_store_connector_secret_envelope';
  assert n = 1, 'V0 exactly one store signature must exist, found ' || n;
  assert (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
           where ns.nspname='public' and p.proname='oauth_completer_store_connector_secret_envelope'
             -- identity_arguments includes parameter NAMES, so match the named parameter itself.
             and pg_get_function_identity_arguments(p.oid) like '%p\_version integer%') = 1,
    'V0 the surviving signature is the version-accepting one, got: ' ||
    coalesce((select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
              where ns.nspname='public' and p.proname='oauth_completer_store_connector_secret_envelope' limit 1), '<none>');

  -- The role still holds no table privilege — a new function must not have widened anything.
  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind in ('r','p')
     and (has_table_privilege('oauth_completer', c.oid, 'SELECT') or has_table_privilege('oauth_completer', c.oid, 'INSERT')
       or has_table_privilege('oauth_completer', c.oid, 'UPDATE'));
  assert n = 0, 'V0 still zero table privileges, found ' || n;
end $$;


-- ════ V1: the worker learns the version BEFORE it encrypts ════════════════════════════════════════════════════════
do $$
declare TA constant uuid := 'd4000000-0000-4000-8000-00000000000a';
        C1 constant uuid := 'd4000000-0000-4000-8000-0000000000c1';
        raised boolean;
begin
  assert public.oauth_completer_next_connector_secret_version(TA, C1) = 1, 'V1 a fresh connector starts at 1';

  -- Asking changes nothing. This is what makes an abandoned attempt harmless: no reservation to leak.
  assert public.oauth_completer_next_connector_secret_version(TA, C1) = 1, 'V1 asking twice reserves nothing';

  raised := false;
  begin perform public.oauth_completer_next_connector_secret_version('d4000000-0000-4000-8000-00000000000b', C1);
  exception when others then raised := true; end;
  assert raised, 'V1 wrong tenant refused';

  raised := false;
  begin perform public.oauth_completer_next_connector_secret_version(TA, 'd4000000-0000-4000-8000-0000000000c2');
  exception when others then raised := true; end;
  assert raised, 'V1 a non-Slack connector refused';
end $$;

-- ════ V2: the stored version is EXACTLY the one supplied ══════════════════════════════════════════════════════════
do $$
declare TA constant uuid := 'd4000000-0000-4000-8000-00000000000a';
        C1 constant uuid := 'd4000000-0000-4000-8000-0000000000c1';
        v int; id1 uuid; was_created boolean; n int;
begin
  v := public.oauth_completer_next_connector_secret_version(TA, C1);
  select secret_id, version, created into id1, v, was_created from public.oauth_completer_store_connector_secret_envelope(
    TA, C1, v, '\xa1','\xb1','\xc1','\xd10102030405060708090a0b0c0d0e0f', pg_temp.env('digest-1'), 'kek-1', 1, 'AES-256-GCM', 'corr-1');
  assert was_created and v = 1, 'V2 first store lands at the supplied version, got ' || v;

  -- THE defect: the database must not pick a different number.
  select version into n from public.connector_secrets
   where connector_id = C1 and secret_kind = 'oauth_access' and id = id1;
  assert n = 1, 'V2 the ROW version must equal the sealed version, got ' || n;
end $$;

-- ════ V3: RE-AUTHORIZATION — the case that was broken ═════════════════════════════════════════════════════════════
do $$
declare TA constant uuid := 'd4000000-0000-4000-8000-00000000000a';
        C1 constant uuid := 'd4000000-0000-4000-8000-0000000000c1';
        v int; id2 uuid; was_created boolean; n int;
begin
  v := public.oauth_completer_next_connector_secret_version(TA, C1);
  assert v = 2, 'V3 the next version after one store is 2, got ' || v;

  select secret_id, version, created into id2, v, was_created from public.oauth_completer_store_connector_secret_envelope(
    TA, C1, v, '\xa2','\xb2','\xc2','\xd20102030405060708090a0b0c0d0e0f', pg_temp.env('digest-2'), 'kek-1', 1, 'AES-256-GCM', 'corr-2');
  assert was_created and v = 2, 'V3 re-authorization stores at 2, got ' || v;

  -- Exactly one active credential, and it is the new one.
  select count(*) into n from public.connector_secrets where connector_id = C1 and is_active;
  assert n = 1, 'V3 exactly one active credential, got ' || n;
  assert (select version from public.connector_secrets where connector_id = C1 and is_active) = 2, 'V3 …and it is version 2';
  -- Nothing deleted; the superseded one is retained and recorded.
  select count(*) into n from public.connector_secrets where connector_id = C1;
  assert n = 2, 'V3 the previous envelope is retained, got ' || n;
end $$;

do $$
declare n int;
begin
  select count(*) into n from public.connector_secret_lifecycle_events
   where connector_id = 'd4000000-0000-4000-8000-0000000000c1' and lifecycle_event_type = 'superseded' and version = 1;
  assert n = 1, 'V3 the supersession of version 1 is audited, got ' || n;
end $$;

-- ════ V4: a RETRY is idempotent; a DIFFERENT envelope at a taken version is refused ═══════════════════════════════
do $$
declare TA constant uuid := 'd4000000-0000-4000-8000-00000000000a';
        C1 constant uuid := 'd4000000-0000-4000-8000-0000000000c1';
        id_a uuid; v int; was_created boolean; raised boolean; msg text; n int;
begin
  -- Same version, same digest -> the existing row, and NOT a third version.
  select secret_id, version, created into id_a, v, was_created from public.oauth_completer_store_connector_secret_envelope(
    TA, C1, 2, '\xa2','\xb2','\xc2','\xd20102030405060708090a0b0c0d0e0f', pg_temp.env('digest-2'), 'kek-1', 1, 'AES-256-GCM', 'corr-2');
  assert not was_created and v = 2, 'V4 a retry returns the existing row, created=' || was_created;
  select count(*) into n from public.connector_secrets where connector_id = C1;
  assert n = 2, 'V4 a retry must not mint a duplicate, got ' || n;

  -- A SECOND, DIFFERENT seal at the same version. The digest is deliberately the SAME, because that is what production
  -- produces: aad_digest is sha256 over (tenant, connector, secret_kind, version) and nothing else, so two seals at one
  -- version ALWAYS share it. What differs is the envelope — a fresh random GCM nonce and different ciphertext.
  --
  -- Keying idempotency on the digest made this indistinguishable from a retry: the second caller was told
  -- `created = false`, reported success, and its token — already issued by Slack — was silently discarded.
  raised := false;
  begin perform public.oauth_completer_store_connector_secret_envelope(
    TA, C1, 2, '\xff','\xff','\xfe','\xfe0102030405060708090a0b0c0d0e0f', pg_temp.env('digest-2'), 'kek-1', 1, 'AES-256-GCM', 'c');
  exception when others then raised := true; msg := sqlerrm; end;
  assert raised, 'V4 a second DIFFERENT seal at a taken version must be refused, not reported as a retry';
  assert msg like '%already holds a different envelope%', 'V4 refused for the right reason, got: ' || msg;

  -- …and a genuine retry — byte-identical envelope — is still idempotent.
  select secret_id, version, created into id_a, v, was_created from public.oauth_completer_store_connector_secret_envelope(
    TA, C1, 2, '\xa2','\xb2','\xc2','\xd20102030405060708090a0b0c0d0e0f', pg_temp.env('digest-2'), 'kek-1', 1, 'AES-256-GCM', 'corr-2');
  assert not was_created, 'V4 a byte-identical retry stays idempotent';
end $$;

-- ════ V5: a FAILED store never disarms the working credential ═════════════════════════════════════════════════════
do $$
declare TA constant uuid := 'd4000000-0000-4000-8000-00000000000a';
        C1 constant uuid := 'd4000000-0000-4000-8000-0000000000c1';
        raised boolean; n int; active_version int;
begin
  -- Every failure mode, each attempted against a connector that currently HAS a working credential.
  foreach n in array array[1] loop null; end loop;

  raised := false;  -- incomplete envelope
  begin perform public.oauth_completer_store_connector_secret_envelope(
    TA, C1, 3, '\xa3', null, '\xc3','\xd30102030405060708090a0b0c0d0e0f', pg_temp.env('d3'), 'kek-1', 1, 'AES-256-GCM', 'c');
  exception when others then raised := true; end;
  assert raised, 'V5 incomplete envelope refused';

  raised := false;  -- bad tag length
  begin perform public.oauth_completer_store_connector_secret_envelope(
    TA, C1, 3, '\xa3','\xb3','\xc3','\xd3', pg_temp.env('d3'), 'kek-1', 1, 'AES-256-GCM', 'c');
  exception when others then raised := true; end;
  assert raised, 'V5 a malformed GCM tag refused';

  raised := false;  -- wrong tenant
  begin perform public.oauth_completer_store_connector_secret_envelope(
    'd4000000-0000-4000-8000-00000000000b', C1, 3, '\xa3','\xb3','\xc3','\xd30102030405060708090a0b0c0d0e0f',
    pg_temp.env('d3'), 'kek-1', 1, 'AES-256-GCM', 'c');
  exception when others then raised := true; end;
  assert raised, 'V5 wrong tenant refused';

  raised := false;  -- invalid version
  begin perform public.oauth_completer_store_connector_secret_envelope(
    TA, C1, 0, '\xa3','\xb3','\xc3','\xd30102030405060708090a0b0c0d0e0f', pg_temp.env('d3'), 'kek-1', 1, 'AES-256-GCM', 'c');
  exception when others then raised := true; end;
  assert raised, 'V5 version 0 refused';

  -- THE assertion: after four failed stores, the working credential is untouched.
  select count(*) into n from public.connector_secrets where connector_id = C1 and is_active;
  assert n = 1, 'V5 exactly one credential is still active, got ' || n;
  select version into active_version from public.connector_secrets where connector_id = C1 and is_active;
  assert active_version = 2, 'V5 and it is still version 2, got ' || active_version;
  select count(*) into n from public.connector_secrets where connector_id = C1;
  assert n = 2, 'V5 no partial row was written, got ' || n;
end $$;

-- ════ V6: concurrent re-authorizations cannot land on the same version ════════════════════════════════════════════
-- Serialised here rather than truly concurrent (one session), but the mechanism under test is the UNIQUE constraint,
-- which does not care how the second caller arrived: two callers that both read N produce one winner and one refusal.
do $$
declare TA constant uuid := 'd4000000-0000-4000-8000-00000000000a';
        C1 constant uuid := 'd4000000-0000-4000-8000-0000000000c1';
        v_both int; raised boolean; n int;
begin
  v_both := public.oauth_completer_next_connector_secret_version(TA, C1);   -- both callers read this
  assert v_both = 3, 'V6 both would read 3, got ' || v_both;

  perform public.oauth_completer_store_connector_secret_envelope(          -- caller one wins
    TA, C1, v_both, '\xaa','\xbb','\xcc','\xdd0102030405060708090a0b0c0d0e0f', pg_temp.env('digest-first'), 'kek-1', 1, 'AES-256-GCM', 'c1');

  -- Caller two: its OWN token, sealed at the same version. Same digest (production always produces the same one for a
  -- given version), different nonce and ciphertext. It must be REFUSED so it knows to re-read, re-encrypt and retry —
  -- being told "already done" would discard a token Slack has already issued.
  raised := false;
  begin perform public.oauth_completer_store_connector_secret_envelope(
    TA, C1, v_both, '\x11','\x22','\x33','\x440102030405060708090a0b0c0d0e0f', pg_temp.env('digest-first'), 'kek-1', 1, 'AES-256-GCM', 'c2');
  exception when others then raised := true; end;
  assert raised, 'V6 the loser must be refused, not silently merged';

  select count(*) into n from public.connector_secrets where connector_id = C1 and version = 3;
  assert n = 1, 'V6 exactly one envelope holds version 3, got ' || n;

  -- The loser re-reads and gets a different number, so it can retry without a collision.
  assert public.oauth_completer_next_connector_secret_version(TA, C1) = 4, 'V6 the loser retries at 4';
end $$;

-- ════ V7: uniqueness is enforced by the DATABASE, not only by the wrapper ═════════════════════════════════════════
do $$
declare raised boolean;
begin
  raised := false;
  begin
    insert into public.connector_secrets (tenant_id, connector_id, secret_kind, version, is_active, status)
    values ('d4000000-0000-4000-8000-00000000000a', 'd4000000-0000-4000-8000-0000000000c1', 'oauth_access', 3, false, 'active');
  exception when others then raised := true; end;
  assert raised, 'V7 a duplicate (connector, kind, version) must be impossible even outside the wrapper';
end $$;

-- ════ V8: the database must not CHOOSE — a supplied version that is not max+1 is honoured verbatim ════════════════
-- This is the assertion that actually pins the defect. Everywhere else the worker asks for `max+1` and stores it, so a
-- database that recomputed `max+1` would agree by construction and the bug would stay invisible. Supplying a version
-- the database would never have picked is the only way to prove whose number wins.
do $$
declare TA constant uuid := 'd4000000-0000-4000-8000-00000000000a';
        C3 constant uuid := 'd4000000-0000-4000-8000-0000000000c3';   -- tenant B's connector, untouched so far
        TB constant uuid := 'd4000000-0000-4000-8000-00000000000b';
        v int; id_x uuid; was_created boolean; stored int;
begin
  -- A fresh connector whose next version is 1; deliberately store at 10.
  assert public.oauth_completer_next_connector_secret_version(TB, C3) = 1, 'V8 fresh connector starts at 1';

  select secret_id, version, created into id_x, v, was_created from public.oauth_completer_store_connector_secret_envelope(
    TB, C3, 10, '\xe1','\xe2','\xe3','\xe40102030405060708090a0b0c0d0e0f', 'digest-v10', 'kek-1', 1, 'AES-256-GCM', 'corr-v10');
  assert was_created, 'V8 the store succeeds';
  assert v = 10, 'V8 the RETURNED version is the supplied one, got ' || v;

  select version into stored from public.connector_secrets where id = id_x;
  assert stored = 10, 'V8 the STORED version is the supplied one, not max+1 — got ' || stored;

  -- …and the next request continues from there rather than from the count of rows.
  assert public.oauth_completer_next_connector_secret_version(TB, C3) = 11, 'V8 next version follows the stored one';
end $$;
