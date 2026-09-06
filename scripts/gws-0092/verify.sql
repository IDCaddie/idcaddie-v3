-- GWS-E4a — post-apply proof for migration 0092 on hosted staging.
--
-- READ-ONLY. Every statement is a SELECT or an assertion; nothing here writes, and it runs inside a transaction that
-- ends in ROLLBACK so even an accidental write could not survive.
--
-- It proves two different things, and both matter:
--   (A) every object, grant and authority boundary 0092 promised actually exists on THIS database;
--   (B) applying it created no data and advanced no state — no connector row, no lifecycle change, no audit entry.
--
-- Run:  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/gws-0092/verify.sql
-- Any failed assertion aborts with the assertion's own message.

begin;
set local transaction read only;

-- ── A0. the ledger says 0092, and nothing beyond it ─────────────────────────────────────────────────────────────────
do $$
declare n int; head text;
begin
  select count(*) into n from supabase_migrations.schema_migrations where version = '0092';
  assert n = 1, 'A0 0092 is not recorded in the migration ledger';
  select count(*) into n from supabase_migrations.schema_migrations where version = '0086';
  assert n = 1, 'A0 0086 must still be recorded';
  select max(version) into head from supabase_migrations.schema_migrations;
  assert head = '0092', 'A0 chain head is ' || head || ', expected 0092';
end $$;

-- ── A1. the evidence table exists with the shape 0092 declared ──────────────────────────────────────────────────────
do $$
declare n int;
begin
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname = 'google_workspace_connector_validations' and c.relkind = 'r';
  assert n = 1, 'A1 the evidence table does not exist';

  -- RLS enabled and ZERO policies: the definer function is the only way in.
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname = 'google_workspace_connector_validations' and c.relrowsecurity;
  assert n = 1, 'A1 row level security is not enabled on the evidence table';
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'google_workspace_connector_validations';
  assert n = 0, 'A1 the evidence table must carry NO policy, found ' || n;

  -- every column the evidence package needs
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'google_workspace_connector_validations'
     and column_name in ('tenant_id','connector_id','validation_status','validation_error_category',
                         'last_validation_attempt_at','last_validated_at','verified_kid','verified_contract_version',
                         'validation_run_id','verified_customer_fingerprint','verified_service_account_fingerprint');
  assert n = 11, 'A1 expected 11 evidence columns, found ' || n;
end $$;

-- ── A2. the CHECK constraints that make evidence all-or-nothing ─────────────────────────────────────────────────────
do $$
declare c text; n int;
begin
  foreach c in array array[
    'google_workspace_validation_status_chk',
    'google_workspace_validation_error_category_chk',
    'google_workspace_validation_category_requires_failure_chk',
    'google_workspace_validation_success_requires_evidence_chk',
    'google_workspace_validation_evidence_requires_success_chk',
    'google_workspace_validation_customer_fp_chk',
    'google_workspace_validation_service_account_fp_chk',
    'google_workspace_validation_connector_unique',
    'google_workspace_validation_connector_same_tenant']
  loop
    select count(*) into n from pg_constraint where conname = c;
    assert n = 1, 'A2 missing constraint ' || c;
  end loop;
end $$;

-- ── A3. the recording function exists with the EXACT reviewed signature ─────────────────────────────────────────────
do $$
declare n int; sec boolean; sp text;
begin
  -- Types, not the rendered argument string: `pg_get_function_identity_arguments` includes parameter NAMES on this
  -- server, so comparing against a type list would fail on a function that is in fact correct.
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'runner_record_google_workspace_validation'
     and p.pronargs = 9
     and oidvectortypes(p.proargtypes) = 'uuid, uuid, uuid, text, text, text, text, text, text'
     and p.prorettype = 'jsonb'::regtype;
  assert n = 1, 'A3 the recording function does not exist with the reviewed 9-argument jsonb signature';

  select p.prosecdef, array_to_string(p.proconfig, ',') into sec, sp
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'runner_record_google_workspace_validation';
  assert sec, 'A3 the function must be SECURITY DEFINER';
  assert sp like '%search_path=%', 'A3 the function must pin search_path, found ' || coalesce(sp, '<null>');
end $$;

-- ── A4. THE AUTHORITY BOUNDARY — runner only, by privilege, not by intent ───────────────────────────────────────────
do $$
declare f constant text := 'public.runner_record_google_workspace_validation(uuid,uuid,uuid,text,text,text,text,text,text)';
        t constant text := 'public.google_workspace_connector_validations';
begin
  assert has_function_privilege('connector_runner', f, 'EXECUTE'), 'A4 connector_runner must hold EXECUTE';
  assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'A4 authenticated must NOT hold EXECUTE';
  assert not has_function_privilege('anon', f, 'EXECUTE'),          'A4 anon must NOT hold EXECUTE';
  assert not has_function_privilege('service_role', f, 'EXECUTE'),  'A4 service_role must NOT hold EXECUTE';

  -- the table is deny-all: not even the runner touches it directly.
  assert not has_table_privilege('authenticated', t, 'SELECT'),   'A4 authenticated must NOT read the evidence table';
  assert not has_table_privilege('anon', t, 'SELECT'),            'A4 anon must NOT read the evidence table';
  -- service_role is NOT asserted here, deliberately. It is the trusted server-side principal that holds table access
  -- across this whole schema by Supabase's default privileges, and 0092 follows the established deny-all set used by
  -- 0076 and 0085 (public, anon, authenticated, connector_runner) rather than inventing a different one. What 0092
  -- DOES guarantee about service_role is the line below: it cannot EXECUTE the recording function, so it cannot earn
  -- `verified` through the sanctioned path. A service_role holder with direct table access is a credential-handling
  -- concern, not something this migration can or claims to close.
  assert not has_table_privilege('connector_runner', t, 'SELECT'),'A4 connector_runner must NOT read the evidence table';
  assert not has_table_privilege('connector_runner', t, 'INSERT'),'A4 connector_runner must NOT write the evidence table';

  -- and the runner still cannot write connectors directly, which is what makes `verified` reachable only through the
  -- function above.
  assert not has_table_privilege('connector_runner', 'public.connectors', 'UPDATE'),
    'A4 connector_runner must NOT hold UPDATE on connectors';
  assert not has_table_privilege('connector_runner', 'public.connectors', 'INSERT'),
    'A4 connector_runner must NOT hold INSERT on connectors';
  assert not has_table_privilege('authenticated', 'public.connectors', 'INSERT'),
    'A4 authenticated must NOT hold INSERT on connectors';
  assert not has_table_privilege('authenticated', 'public.connectors', 'UPDATE'),
    'A4 authenticated must NOT hold UPDATE on connectors';
end $$;

-- ── A5. `verified` stays EARNED: the generic state machine offers no route ──────────────────────────────────────────
do $$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'runner_advance_connection_state';
  assert src is not null, 'A5 runner_advance_connection_state is missing';
  assert src !~* '''configured''\s*,\s*''verified''',
    'A5 runner_advance_connection_state now authorizes configured -> verified; the recording function is no longer the only route';
  -- and the recording function is the thing that does write it
  select pg_get_functiondef(p.oid) into src from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'runner_record_google_workspace_validation';
  assert src ~* 'connection_state\s*=\s*''verified''', 'A5 the recording function does not write verified';
  assert src ~* 'connection_state is not configured', 'A5 the start-state gate is missing from the recording function';
end $$;

-- ── A6. blast radius: 0086 and Okta are untouched ───────────────────────────────────────────────────────────────────
do $$
declare o text; n int;
begin
  foreach o in array array[
    'runner_promote_directory_users','runner_promote_directory_groups','runner_promote_directory_group_memberships',
    'runner_mark_absent_directory_users_stale','runner_record_directory_discovery_metrics',
    'runner_assert_parameterized_provider','runner_open_connector_run','runner_finish_connector_run',
    'runner_insert_discovery_fact','runner_record_okta_connector_validation','runner_record_okta_capability_evidence']
  loop
    select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and p.proname = o;
    assert n >= 1, 'A6 pre-existing function ' || o || ' is missing after apply';
  end loop;
  -- the Okta config table and its rows are untouched
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relname = 'okta_connector_configs';
  assert n = 1, 'A6 okta_connector_configs is missing';
  -- and the google_workspace discovery policy 0086 seeded is still there
  select count(*) into n from public.connector_discovery_policy where provider = 'google_workspace';
  assert n = 1, 'A6 the google_workspace discovery policy row is missing';
end $$;

-- ── B. NO DATA, NO STATE. Applying 0092 must have created nothing. ──────────────────────────────────────────────────
do $$
declare n int;
begin
  -- the evidence table is empty: the migration seeds no row, and nothing has recorded yet
  select count(*) into n from public.google_workspace_connector_validations;
  assert n = 0, 'B no evidence row may exist after a pure apply, found ' || n;

  -- NO connector row was created for this provider
  select count(*) into n from public.connectors where provider = 'google_workspace';
  assert n = 0, 'B applying 0092 must create NO google_workspace connector row, found ' || n;

  -- NO google_workspace connector is in any lifecycle state beyond the one it was configured in. Scoped to THIS
  -- provider on purpose: a time-window assertion over all connectors would fire on unrelated Okta activity, which is
  -- noise this proof must not produce.
  select count(*) into n from public.connectors
   where provider = 'google_workspace' and connection_state is distinct from 'configured';
  assert n = 0, 'B no google_workspace connector may be past `configured` after a pure apply, found ' || n;

  -- NO run exists for a google_workspace connector
  select count(*) into n from public.connector_runs r
    join public.connectors c on c.id = r.connector_id
   where c.provider = 'google_workspace';
  assert n = 0, 'B applying 0092 must leave no google_workspace connector run, found ' || n;

  -- NO audit row under either new action
  select count(*) into n from public.audit_logs
   where action in ('google_workspace_connector_validation_succeeded',
                    'google_workspace_connector_validation_failed');
  assert n = 0, 'B applying 0092 must write no validation audit row, found ' || n;
end $$;

select 'GWS-0092 POST-APPLY PROOF PASSED — objects, grants and authority boundary present; no data, no state, no run' as result;

rollback;
