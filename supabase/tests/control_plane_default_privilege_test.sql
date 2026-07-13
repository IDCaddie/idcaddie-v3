-- control_plane_default_privilege_test.sql — regression for the 0044 → 0045 function-privilege gap.
--
-- THE BUG: on hosted Supabase, ALTER DEFAULT PRIVILEGES grants EXECUTE on every new public-schema function directly to anon +
-- authenticated. A migration that revokes EXECUTE only "from public" (the original 0044 pattern) therefore leaves the request
-- roles able to call the function via PostgREST RPC. Neither the vanilla test Postgres (no such default privileges) nor
-- test-rls.sh (which re-revokes in a TEST-ONLY lockstep) exposed it — the migration's own revoke was never tested against the
-- real Supabase mechanism.
--
-- THIS TEST reproduces the Supabase default-privilege condition itself, then proves: (DP1) revoke-from-public alone is
-- INSUFFICIENT — anon/authenticated retain EXECUTE (the exact 0044 failure mode); (DP2) revoke-from-anon/authenticated (the 0045
-- fix) closes it. It fails if any future deny-all function reverts to the insufficient pattern. Self-contained; SYNTHETIC; the
-- default-privilege change it makes is reverted at the end. NEVER hosted.
\set ON_ERROR_STOP on
reset role;

-- Reproduce Supabase's platform default (independent of the test-rls.sh harness): new public functions auto-grant EXECUTE to
-- anon + authenticated. This is what pg_default_acl shows on the hosted project.
alter default privileges in schema public grant execute on functions to anon, authenticated;

-- A representative deny-all-style SECURITY DEFINER function (stands in for a control-plane function).
create function public._cp_defpriv_probe(x integer) returns integer language sql security definer set search_path = '' as $$ select x $$;

-- DP1 — the 0044 pattern (revoke from PUBLIC only) is INSUFFICIENT under Supabase default privileges.
revoke execute on function public._cp_defpriv_probe(integer) from public;
do $$ begin
  assert has_function_privilege('anon','public._cp_defpriv_probe(integer)','EXECUTE'),
    'DP1 (0044 failure mode): revoke-from-public leaves anon holding EXECUTE under Supabase default privileges';
  assert has_function_privilege('authenticated','public._cp_defpriv_probe(integer)','EXECUTE'),
    'DP1 authenticated likewise retains EXECUTE after revoke-from-public';
end $$;

-- DP2 — the 0045 pattern (revoke from anon, authenticated) CLOSES it: request roles get NOTHING.
revoke execute on function public._cp_defpriv_probe(integer) from anon, authenticated;
do $$ begin
  assert not has_function_privilege('anon','public._cp_defpriv_probe(integer)','EXECUTE'),
    'DP2 (0045 fix): anon EXECUTE removed';
  assert not has_function_privilege('authenticated','public._cp_defpriv_probe(integer)','EXECUTE'),
    'DP2 authenticated EXECUTE removed';
end $$;

-- cleanup: drop the probe and restore the schema's default privileges to the platform baseline for the rest of the suite.
drop function public._cp_defpriv_probe(integer);
alter default privileges in schema public revoke execute on functions from anon, authenticated;
