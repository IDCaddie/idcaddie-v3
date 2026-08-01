-- 0074 — the explicit count contract.
--
-- Two readings of the same tables, for two different jobs:
--   current       what the directory contains now — the customer-facing answer
--   totalEvidence every retained row — the conservative bound the too-large gate must keep using
--
-- The property that matters most: the bound must not weaken. `totalEvidence` reproduces exactly the numbers the gate used before
-- this migration, and `current` is strictly smaller whenever anything is stale. Getting these the wrong way round would either
-- lie to a customer or let an unsafe response through.

reset role;

-- ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Tenant A: an ACTIVE connector holding a mix of current and stale rows, a DISCONNECTED one, and a SUPERSEDED one — the two
-- exclusions must survive the new contract. Plus a second ACTIVE connector, so all-active mode has something to sum.
insert into public.tenants (id, name, slug) values ('6e000000-0000-4000-8000-00000000000a', 'Counts A', 'cnt-a'), ('6e000000-0000-4000-8000-00000000000b', 'Counts B', 'cnt-b');
insert into auth.users (id, email) values ('6e000000-0000-4000-8000-0000000000f1', 'cnt-owner@example.test') on conflict do nothing;
insert into public.profiles (id, email) values ('6e000000-0000-4000-8000-0000000000f1', 'cnt-owner@example.test') on conflict do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role) values ('6e000000-0000-4000-8000-00000000000a', '6e000000-0000-4000-8000-0000000000f1', 'owner') on conflict do nothing;

insert into public.connectors (id, tenant_id, provider, display_name, status, connection_state) values
  ('6e000000-0000-4000-8000-0000000000c1', '6e000000-0000-4000-8000-00000000000a', 'okta', 'Active',       'pending', 'discovered'),
  ('6e000000-0000-4000-8000-0000000000c2', '6e000000-0000-4000-8000-00000000000a', 'okta', 'Second active','pending', 'discovered'),
  ('6e000000-0000-4000-8000-0000000000c3', '6e000000-0000-4000-8000-00000000000a', 'okta', 'Disconnected', 'pending', 'discovered'),
  ('6e000000-0000-4000-8000-0000000000c4', '6e000000-0000-4000-8000-00000000000a', 'okta', 'Superseded',   'pending', 'discovered'),
  ('6e000000-0000-4000-8000-0000000000c5', '6e000000-0000-4000-8000-00000000000b', 'okta', 'Other tenant', 'pending', 'discovered');

-- C1: one current + one stale of every resource. C2: one current identity only. C3/C4: one current identity each, to be excluded.
do $$
declare
  TA constant uuid := '6e000000-0000-4000-8000-00000000000a';
  C1 constant uuid := '6e000000-0000-4000-8000-0000000000c1';
  c uuid; s text; i uuid; i2 uuid; g uuid; g2 uuid; a uuid; a2 uuid;
begin
  foreach c in array array[C1] loop
    foreach s in array array['current', 'stale'] loop
      insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, sync_status)
      values (TA, c, 'okta', 'u-' || s, s || '@example.test', s) returning id into i;
      insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, group_type_category, sync_status)
      values (TA, c, 'okta', 'g-' || s, 'G ' || s, 'okta_group', s) returning id into g;
      insert into public.directory_applications (tenant_id, connection_id, provider, external_id, name, label, status_category, sync_status)
      values (TA, c, 'okta', 'a-' || s, 'app', 'A ' || s, 'active', s) returning id into a;
      insert into public.directory_group_memberships (tenant_id, connection_id, provider, directory_group_id, identity_account_id, sync_status)
      values (TA, c, 'okta', g, i, s);
      insert into public.directory_application_user_assignments (tenant_id, connection_id, provider, directory_application_id, identity_account_id, sync_status)
      values (TA, c, 'okta', a, i, s);
      insert into public.directory_application_group_assignments (tenant_id, connection_id, provider, directory_application_id, directory_group_id, sync_status)
      values (TA, c, 'okta', a, g, s);
    end loop;
  end loop;
  update public.identity_accounts set stale_since = now() where connection_id = C1 and sync_status = 'stale';
  update public.directory_groups set stale_since = now() where connection_id = C1 and sync_status = 'stale';
  update public.directory_applications set stale_since = now() where connection_id = C1 and sync_status = 'stale';

  insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, sync_status) values
    (TA, '6e000000-0000-4000-8000-0000000000c2', 'okta', 'u-second', 'second@example.test', 'current'),
    (TA, '6e000000-0000-4000-8000-0000000000c3', 'okta', 'u-disc',   'disc@example.test',   'current'),
    (TA, '6e000000-0000-4000-8000-0000000000c4', 'okta', 'u-sup',    'sup@example.test',    'current');
  insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, sync_status)
  values ('6e000000-0000-4000-8000-00000000000b', '6e000000-0000-4000-8000-0000000000c5', 'okta', 'u-tb', 'tb@example.test', 'current');
end $$;

update public.connectors set disconnected_at = now(), disconnected_reason = 'test' where id = '6e000000-0000-4000-8000-0000000000c3';
update public.connectors set superseded_by = '6e000000-0000-4000-8000-0000000000c1', superseded_at = now(), superseded_reason = 'test' where id = '6e000000-0000-4000-8000-0000000000c4';

-- ════ K1: the three readings, and the invariant that ties them together ═══════════════════════════════════════════
do $$
declare
  TA constant uuid := '6e000000-0000-4000-8000-00000000000a';
  C1 constant uuid := '6e000000-0000-4000-8000-0000000000c1';
  j jsonb; k text;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','6e000000-0000-4000-8000-0000000000f1')::text, true);

  j := public.product_directory_access_counts(TA, C1);
  -- One current and one stale of every resource: current=1, stale=1, total=2, on all six.
  foreach k in array array['identities','groups','applications','memberships','userAssignments','groupAssignments'] loop
    assert (j -> 'current' ->> k)::int = 1, 'K1 current ' || k || ' should be 1, got ' || (j -> 'current' ->> k);
    assert (j -> 'stale' ->> k)::int = 1, 'K1 stale ' || k || ' should be 1, got ' || (j -> 'stale' ->> k);
    assert (j -> 'other' ->> k)::int = 0, 'K1 other ' || k || ' should be 0 — nothing writes review_required/disconnected today';
    assert (j -> 'totalEvidence' ->> k)::int = 2, 'K1 totalEvidence ' || k || ' should be 2, got ' || (j -> 'totalEvidence' ->> k);
    -- THE INVARIANT. `other` is a named term rather than folded into `stale`, so this is an equality, not an approximation.
    assert (j -> 'totalEvidence' ->> k)::int = (j -> 'current' ->> k)::int + (j -> 'stale' ->> k)::int + (j -> 'other' ->> k)::int,
      'K1 totalEvidence must equal current + stale + other for ' || k;
    -- The deprecated flat key keeps its ORIGINAL meaning: total evidence. Nothing changed under an existing caller.
    assert (j ->> k)::int = (j -> 'totalEvidence' ->> k)::int, 'K1 the deprecated flat key must still mean total evidence for ' || k;
  end loop;
end $$;

-- ════ K2: the safety bound did not weaken ═════════════════════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '6e000000-0000-4000-8000-00000000000a';
  C1 constant uuid := '6e000000-0000-4000-8000-0000000000c1';
  j jsonb; k text;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','6e000000-0000-4000-8000-0000000000f1')::text, true);
  j := public.product_directory_access_counts(TA, C1);
  -- A stale row still occupies a row in any response that includes stale evidence, so the bound must be >= what would be
  -- returned. current is strictly smaller here, which is exactly why gating on it would under-count the worst case.
  foreach k in array array['identities','groups','applications','memberships','userAssignments','groupAssignments'] loop
    assert (j -> 'totalEvidence' ->> k)::int >= (j -> 'current' ->> k)::int, 'K2 the bound must never be below the current count for ' || k;
    assert (j -> 'totalEvidence' ->> k)::int > (j -> 'current' ->> k)::int, 'K2 with stale rows present the bound must be strictly larger for ' || k;
  end loop;
end $$;

-- ════ K3: connector scope, exclusions and all-active aggregation ══════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '6e000000-0000-4000-8000-00000000000a';
  TB constant uuid := '6e000000-0000-4000-8000-00000000000b';
  C1 constant uuid := '6e000000-0000-4000-8000-0000000000c1';
  C2 constant uuid := '6e000000-0000-4000-8000-0000000000c2';
  C3 constant uuid := '6e000000-0000-4000-8000-0000000000c3';
  C4 constant uuid := '6e000000-0000-4000-8000-0000000000c4';
  j jsonb;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','6e000000-0000-4000-8000-0000000000f1')::text, true);

  -- Scoped: only the selected connector's evidence.
  assert (public.product_directory_access_counts(TA, C1) -> 'current' ->> 'identities')::int = 1, 'K3 scoped to C1';
  assert (public.product_directory_access_counts(TA, C2) -> 'current' ->> 'identities')::int = 1, 'K3 scoped to C2';
  assert (public.product_directory_access_counts(TA, C1) -> 'current' ->> 'groups')::int = 1, 'K3 C2 has no groups of its own';
  assert (public.product_directory_access_counts(TA, C2) -> 'current' ->> 'groups')::int = 0, 'K3 the other connector''s groups must not appear';

  -- All-active: the two ACTIVE connectors summed. Disconnected and superseded contribute nothing, in either reading.
  j := public.product_directory_access_counts(TA);
  assert (j -> 'current' ->> 'identities')::int = 2, 'K3 all-active should sum the two active connectors, got ' || (j -> 'current' ->> 'identities');
  assert (j -> 'totalEvidence' ->> 'identities')::int = 3, 'K3 all-active total = 2 current + 1 stale, got ' || (j -> 'totalEvidence' ->> 'identities');

  -- Explicitly asking for an excluded connector returns zero, not its data.
  assert (public.product_directory_access_counts(TA, C3) -> 'totalEvidence' ->> 'identities')::int = 0, 'K3 a disconnected connector contributes nothing';
  assert (public.product_directory_access_counts(TA, C4) -> 'totalEvidence' ->> 'identities')::int = 0, 'K3 a superseded connector contributes nothing';

  -- Cross-tenant: no existence signal at all.
  assert public.product_directory_access_counts(TB) is null, 'K3 another tenant returns null, not zeros';
  assert (public.product_directory_access_counts(TA, '6e000000-0000-4000-8000-0000000000c5') -> 'totalEvidence' ->> 'identities')::int = 0,
    'K3 another tenant''s connector id under our own tenant reveals nothing';
end $$;

-- ════ K4: all-active SUMS, it does not deduplicate ════════════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '6e000000-0000-4000-8000-00000000000a';
  C2 constant uuid := '6e000000-0000-4000-8000-0000000000c2';
  j jsonb;
begin
  -- Give the second connector an identity with the SAME external id, login and email as the first. Two organizations may
  -- legitimately contain the same person; collapsing them would erase a real record from a real directory.
  reset role;
  insert into public.identity_accounts (tenant_id, connection_id, provider, external_id, login, email, display_name, sync_status)
  values (TA, C2, 'okta', 'u-current', 'current@example.test', 'current@example.test', 'Same Person', 'current');

  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','6e000000-0000-4000-8000-0000000000f1')::text, true);
  j := public.product_directory_access_counts(TA);
  assert (j -> 'current' ->> 'identities')::int = 3, 'K4 duplicates across connectors must both count, got ' || (j -> 'current' ->> 'identities');

  reset role;
  delete from public.identity_accounts where connection_id = C2 and external_id = 'u-current';
end $$;

-- ════ K5: a re-promoted row moves stale -> current without changing the total ═════════════════════════════════════
do $$
declare
  TA constant uuid := '6e000000-0000-4000-8000-00000000000a';
  C1 constant uuid := '6e000000-0000-4000-8000-0000000000c1';
  before_total int; after_total int; j jsonb;
begin
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','6e000000-0000-4000-8000-0000000000f1')::text, true);
  before_total := (public.product_directory_access_counts(TA, C1) -> 'totalEvidence' ->> 'groups')::int;

  reset role;
  -- What re-promotion does: status flips and the stale timestamp clears (0070's invariant). The row itself is the same row.
  update public.directory_groups set sync_status = 'current', stale_since = null
   where connection_id = C1 and sync_status = 'stale';

  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','6e000000-0000-4000-8000-0000000000f1')::text, true);
  j := public.product_directory_access_counts(TA, C1);
  after_total := (j -> 'totalEvidence' ->> 'groups')::int;
  assert after_total = before_total, 'K5 re-promotion must not change total evidence — the row already existed';
  assert (j -> 'current' ->> 'groups')::int = 2, 'K5 current should rise to 2';
  assert (j -> 'stale' ->> 'groups')::int = 0, 'K5 stale should fall to 0';

  reset role;
  update public.directory_groups set sync_status = 'stale', stale_since = now()
   where connection_id = C1 and external_id = 'g-stale';
end $$;

-- ════ K6: an unusual row state is reported as `other`, never as stale ═════════════════════════════════════════════
do $$
declare
  TA constant uuid := '6e000000-0000-4000-8000-00000000000a';
  C1 constant uuid := '6e000000-0000-4000-8000-0000000000c1';
  j jsonb;
begin
  -- Nothing writes `review_required` today, but the CHECK permits it. Folding it into `stale` would be a silent
  -- miscategorisation that only surfaces the day something starts writing it.
  reset role;
  insert into public.directory_groups (tenant_id, connection_id, provider, external_id, name, group_type_category, sync_status)
  values (TA, C1, 'okta', 'g-review', 'Needs review', 'okta_group', 'review_required');

  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub','6e000000-0000-4000-8000-0000000000f1')::text, true);
  j := public.product_directory_access_counts(TA, C1);
  assert (j -> 'other' ->> 'groups')::int = 1, 'K6 review_required must count as other, got ' || (j -> 'other' ->> 'groups');
  assert (j -> 'stale' ->> 'groups')::int = 1, 'K6 it must NOT inflate stale';
  assert (j -> 'current' ->> 'groups')::int = 1, 'K6 nor current';
  assert (j -> 'totalEvidence' ->> 'groups')::int = 3, 'K6 and the total accounts for it';
  assert (j -> 'totalEvidence' ->> 'groups')::int = (j -> 'current' ->> 'groups')::int + (j -> 'stale' ->> 'groups')::int + (j -> 'other' ->> 'groups')::int,
    'K6 the invariant must hold with a third state present';

  reset role;
  delete from public.directory_groups where connection_id = C1 and external_id = 'g-review';
end $$;

-- ════ K7: authorization is unchanged ══════════════════════════════════════════════════════════════════════════════
do $$
declare
  TA constant uuid := '6e000000-0000-4000-8000-00000000000a';
  ed uuid := '6e000000-0000-4000-8000-0000000000e1';
begin
  reset role;
  insert into auth.users (id, email) values (ed, 'cnt-editor@example.test') on conflict do nothing;
  insert into public.profiles (id, email) values (ed, 'cnt-editor@example.test') on conflict do nothing;
  insert into public.tenant_memberships (tenant_id, user_id, role) values (TA, ed, 'editor') on conflict do nothing;
  set local role postgres;
  perform set_config('request.jwt.claims', json_build_object('sub', ed)::text, true);
  assert public.product_directory_access_counts(TA) is null, 'K7 an editor still gets no counts at all';
end $$;
