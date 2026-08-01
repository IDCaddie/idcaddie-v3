-- 0078_saas_evidence_product_reads.sql
--
-- Phase 9 — the READ side of the canonical SaaS evidence tables, and the first producer for app_account_identity_matches.
--
-- 0076 built the tables and 0077 built the runner-only write path. Neither built a way to SEE any of it: both tables are
-- RLS-enabled with NO policy and every table grant is revoked from `authenticated`, so a Slack sweep could populate
-- app_accounts and the product would render nothing. Every other product surface in this codebase reads through a
-- `product_*` SECURITY DEFINER function (0061, 0072, 0073, 0074); this adds the missing ones, in that exact shape.
--
-- READ functions are `stable`, gate on has_tenant_role(owner|admin) and return an empty set (never an error) to a caller
-- who lacks the role — the 0061 convention, so a denied read is indistinguishable from an empty one.
--
-- ORDERING is by DISPLAY VALUE, not by uuid. The 0061 directory RPCs order by id, which produces a list no human can
-- scan and paginates in an order that means nothing; that limit is recorded and is not repeated here.
--
-- SEARCH happens IN the function. The directory loaders page the entire table and filter in TypeScript
-- (directory-loaders.ts), which is fine at fixture size and wrong at workspace size.

-- ══ 0. DUPLICATE-PROPOSAL GUARD ═══════════════════════════════════════════════════════════════════════════════════════
-- app_account_identity_matches has had no producer since 0076, so there was never a duplicate to prevent. Adding the
-- producer below makes one possible: re-running the matcher must not stack a second identical proposal. Safe to add now
-- precisely because the table is empty everywhere.
create unique index if not exists aaim_account_identity_key
  on public.app_account_identity_matches (tenant_id, app_account_id, identity_account_id);

-- ══ 1. ACCOUNTS ═══════════════════════════════════════════════════════════════════════════════════════════════════════
-- One row per SaaS account, with its match state folded in. The match is reported as a STATE, never as the matched
-- person's identity: who an account matched is a separate, deliberate read.
create or replace function public.product_app_accounts(
  p_tenant_id uuid,
  p_connection_id uuid default null,
  p_include_stale boolean default true,
  p_search text default null,
  p_kind text default null,
  p_status text default null,
  p_match_state text default null,
  p_limit integer default 200,
  p_offset integer default 0
) returns table (
  id uuid, connection_id uuid, provider text, workspace_external_id text,
  display_name text, email text,
  account_kind text, account_status text, is_admin boolean,
  sync_status text, stale_since timestamptz, last_seen_at timestamptz, first_seen_at timestamptz,
  match_state text, match_confidence text, match_method text,
  total_count bigint
) language plpgsql security definer set search_path = public stable as $$
declare v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  return query
    with scoped as (
      select a.*,
             -- The BEST match state for this account. An accepted match outranks a proposal; a rejected one leaves the
             -- account unmatched, because a rejection is a decision that it is NOT that person.
             (select m.status from public.app_account_identity_matches m
               where m.app_account_id = a.id and m.tenant_id = a.tenant_id
               order by case m.status when 'accepted' then 0 when 'proposed' then 1 else 2 end,
                        case m.confidence when 'high' then 0 when 'medium' then 1 else 2 end
               limit 1) as m_status,
             (select m.confidence from public.app_account_identity_matches m
               where m.app_account_id = a.id and m.tenant_id = a.tenant_id
               order by case m.status when 'accepted' then 0 when 'proposed' then 1 else 2 end,
                        case m.confidence when 'high' then 0 when 'medium' then 1 else 2 end
               limit 1) as m_conf,
             (select m.method from public.app_account_identity_matches m
               where m.app_account_id = a.id and m.tenant_id = a.tenant_id
               order by case m.status when 'accepted' then 0 when 'proposed' then 1 else 2 end,
                        case m.confidence when 'high' then 0 when 'medium' then 1 else 2 end
               limit 1) as m_method
        from public.app_accounts a
       where a.tenant_id = p_tenant_id
         and (p_connection_id is null or a.connection_id = p_connection_id)
         and (p_include_stale or a.sync_status = 'current')
    ), labelled as (
      select s.*,
             case when s.m_status = 'accepted' then 'matched'
                  when s.m_status = 'proposed' then 'proposed'
                  else 'unmatched' end as m_state
        from scoped s
    ), filtered as (
      select l.* from labelled l
       where (v_q is null
              or l.display_name ilike '%' || v_q || '%'
              or l.email ilike '%' || v_q || '%')
         and (p_kind is null or l.account_kind = p_kind)
         and (p_status is null or l.account_status = p_status)
         and (p_match_state is null or l.m_state = p_match_state)
    )
    select f.id, f.connection_id, f.provider, f.workspace_external_id,
           f.display_name, f.email,
           f.account_kind, f.account_status, f.is_admin,
           f.sync_status, f.stale_since, f.last_seen_at, f.first_seen_at,
           f.m_state, f.m_conf, f.m_method,
           count(*) over () as total_count
      from filtered f
     -- Display order. `nulls last` keeps unnamed accounts from heading the list.
     order by f.display_name nulls last, f.email nulls last, f.external_id
     limit greatest(0, least(coalesce(p_limit, 200), 500)) offset greatest(0, coalesce(p_offset, 0));
end $$;

-- ══ 2. GROUPS ═════════════════════════════════════════════════════════════════════════════════════════════════════════
-- `member_count` is the PROVIDER's own number, which is why it can disagree with the memberships we hold: Slack reports a
-- usergroup's count even when we have not read its members. Reported separately from the count we can prove, never merged.
create or replace function public.product_app_account_groups(
  p_tenant_id uuid,
  p_connection_id uuid default null,
  p_include_stale boolean default true,
  p_search text default null,
  p_limit integer default 200,
  p_offset integer default 0
) returns table (
  id uuid, connection_id uuid, provider text, workspace_external_id text,
  name text, handle text, description text,
  reported_member_count integer, known_member_count integer, is_active boolean,
  sync_status text, stale_since timestamptz, last_seen_at timestamptz,
  total_count bigint
) language plpgsql security definer set search_path = public stable as $$
declare v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  return query
    with filtered as (
      select g.* from public.app_account_groups g
       where g.tenant_id = p_tenant_id
         and (p_connection_id is null or g.connection_id = p_connection_id)
         and (p_include_stale or g.sync_status = 'current')
         and (v_q is null or g.name ilike '%' || v_q || '%' or g.handle ilike '%' || v_q || '%')
    )
    select f.id, f.connection_id, f.provider, f.workspace_external_id,
           f.name, f.handle, f.description,
           f.member_count as reported_member_count,
           -- What we can actually prove from memberships we hold. Zero is honest when no membership sweep has run.
           (select count(*)::integer from public.app_account_group_memberships m
             where m.tenant_id = f.tenant_id and m.app_account_group_id = f.id and m.sync_status = 'current') as known_member_count,
           f.is_active, f.sync_status, f.stale_since, f.last_seen_at,
           count(*) over () as total_count
      from filtered f
     order by f.name nulls last, f.handle nulls last, f.external_id
     limit greatest(0, least(coalesce(p_limit, 200), 500)) offset greatest(0, coalesce(p_offset, 0));
end $$;

-- ══ 3. COUNTS ═════════════════════════════════════════════════════════════════════════════════════════════════════════
-- The summary a connector page and Home need. Follows the 0074 contract exactly: CURRENT and TOTAL EVIDENCE are separate
-- numbers, because "how many accounts exist" and "how many did the last sweep confirm" are different questions, and
-- collapsing them is what made the old counts lie.
create or replace function public.product_app_account_counts(
  p_tenant_id uuid, p_connection_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public stable as $$
declare v jsonb;
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return null; end if;
  select jsonb_build_object(
    'accounts', jsonb_build_object(
      'current',       count(*) filter (where a.sync_status = 'current'),
      'stale',         count(*) filter (where a.sync_status = 'stale'),
      'totalEvidence', count(*),
      'humans',        count(*) filter (where a.sync_status = 'current' and a.account_kind = 'human'),
      'bots',          count(*) filter (where a.sync_status = 'current' and a.account_kind in ('bot', 'service')),
      'unknownKind',   count(*) filter (where a.sync_status = 'current' and a.account_kind = 'unknown'),
      'admins',        count(*) filter (where a.sync_status = 'current' and a.is_admin is true),
      'active',        count(*) filter (where a.sync_status = 'current' and a.account_status = 'active'),
      'inactive',      count(*) filter (where a.sync_status = 'current' and a.account_status = 'inactive'),
      'deleted',       count(*) filter (where a.sync_status = 'current' and a.account_status = 'deleted'),
      'lastSeenAt',    max(a.last_seen_at) filter (where a.sync_status = 'current')
    ))
    into v
    from public.app_accounts a
   where a.tenant_id = p_tenant_id and (p_connection_id is null or a.connection_id = p_connection_id);

  -- Match coverage is deliberately measured against HUMAN accounts only. A bot has no person to match, so counting it as
  -- "unmatched" would invent a review item and drag the coverage number down for a workspace that is perfectly reconciled.
  select v || jsonb_build_object(
    'groups', jsonb_build_object(
      'current',       (select count(*) from public.app_account_groups g where g.tenant_id = p_tenant_id
                          and (p_connection_id is null or g.connection_id = p_connection_id) and g.sync_status = 'current'),
      'stale',         (select count(*) from public.app_account_groups g where g.tenant_id = p_tenant_id
                          and (p_connection_id is null or g.connection_id = p_connection_id) and g.sync_status = 'stale'),
      'totalEvidence', (select count(*) from public.app_account_groups g where g.tenant_id = p_tenant_id
                          and (p_connection_id is null or g.connection_id = p_connection_id)),
      'lastSeenAt',    (select max(g.last_seen_at) from public.app_account_groups g where g.tenant_id = p_tenant_id
                          and (p_connection_id is null or g.connection_id = p_connection_id) and g.sync_status = 'current')),
    'matching', jsonb_build_object(
      'humans',    count(*) filter (where a.account_kind = 'human'),
      'matched',   count(*) filter (where a.account_kind = 'human' and mm.status = 'accepted'),
      'proposed',  count(*) filter (where a.account_kind = 'human' and mm.status = 'proposed'),
      'unmatched', count(*) filter (where a.account_kind = 'human' and mm.status is null),
      'withoutEmail', count(*) filter (where a.account_kind = 'human' and a.normalized_email is null)))
    into v
    from public.app_accounts a
    left join lateral (
      select m.status from public.app_account_identity_matches m
       where m.app_account_id = a.id and m.tenant_id = a.tenant_id and m.status in ('accepted', 'proposed')
       order by case m.status when 'accepted' then 0 else 1 end limit 1) mm on true
   where a.tenant_id = p_tenant_id and a.sync_status = 'current'
     and (p_connection_id is null or a.connection_id = p_connection_id);
  return v;
end $$;

-- ══ 4. CAPABILITY STATE ═══════════════════════════════════════════════════════════════════════════════════════════════
-- What each connector can actually do, as last observed. Without this the product infers capability from directory counts,
-- which reports a Slack connector holding real accounts as "not discovered yet".
create or replace function public.product_connector_capabilities(
  p_tenant_id uuid, p_connection_id uuid default null
) returns table (
  connection_id uuid, capability text, state text, reason_code text,
  last_success_at timestamptz, last_attempt_at timestamptz, observed_count integer
) language plpgsql security definer set search_path = public stable as $$
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then return; end if;
  return query
    select s.connection_id, s.capability, s.state, s.reason_code, s.last_success_at, s.last_attempt_at, s.observed_count
      from public.connector_capability_state s
     where s.tenant_id = p_tenant_id and (p_connection_id is null or s.connection_id = p_connection_id)
     order by s.connection_id, s.capability;
end $$;

-- ══ 5. THE MATCHER ════════════════════════════════════════════════════════════════════════════════════════════════════
-- Proposes SaaS-account → identity links on normalized email, and nothing else.
--
-- What it deliberately will not do, each for a reason that has already cost someone a bad access review:
--   * No display-name matching. Two people share a name; one person changes theirs. 0076 excluded the method from the
--     CHECK constraint on purpose and this honours that.
--   * No auto-acceptance. Every row lands `proposed`. A human decides.
--   * Bots and service accounts are excluded. A bot has no person behind it, and a bot whose address happens to collide
--     with a real one would attribute a machine's access to an employee.
--   * An email matching MORE THAN ONE identity proposes nothing. An ambiguous match is not a low-confidence match; it is
--     an unanswered question, and guessing which of two people owns an account is exactly the wrong thing to guess.
--   * Nothing is ever written to identity_accounts. A SaaS account is not a person.
create or replace function public.product_propose_app_account_identity_matches(
  p_tenant_id uuid, p_connection_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public volatile as $$
declare v_proposed integer := 0; v_ambiguous integer := 0; v_considered integer := 0;
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    raise exception 'not authorized for tenant %', p_tenant_id using errcode = '42501';
  end if;

  select count(*) into v_considered from public.app_accounts a
   where a.tenant_id = p_tenant_id and (p_connection_id is null or a.connection_id = p_connection_id)
     and a.sync_status = 'current' and a.account_kind = 'human' and a.normalized_email is not null;

  -- Candidates: exactly one CURRENT identity for this normalized email, and no decision already recorded for the pair.
  with candidate as (
    select a.id as account_id, a.normalized_email,
           (select count(*) from public.identity_accounts i
             where i.tenant_id = p_tenant_id and i.normalized_email = a.normalized_email and i.sync_status = 'current') as n,
           (select i.id from public.identity_accounts i
             where i.tenant_id = p_tenant_id and i.normalized_email = a.normalized_email and i.sync_status = 'current'
             limit 1) as identity_id
      from public.app_accounts a
     where a.tenant_id = p_tenant_id and (p_connection_id is null or a.connection_id = p_connection_id)
       and a.sync_status = 'current' and a.account_kind = 'human' and a.normalized_email is not null
  ), inserted as (
    insert into public.app_account_identity_matches
      (tenant_id, app_account_id, identity_account_id, method, confidence, status, rationale)
    select p_tenant_id, c.account_id, c.identity_id, 'normalized_email', 'high', 'proposed',
           'Exactly one directory identity shares this account''s email address.'
      from candidate c
     where c.n = 1
       -- Never re-propose a pair a human already decided, in either direction.
       and not exists (select 1 from public.app_account_identity_matches m
                        where m.tenant_id = p_tenant_id and m.app_account_id = c.account_id
                          and m.identity_account_id = c.identity_id)
    on conflict (tenant_id, app_account_id, identity_account_id) do nothing
    returning 1)
  select (select count(*) from inserted), (select count(*) from candidate where n > 1)
    into v_proposed, v_ambiguous;

  return jsonb_build_object('considered', v_considered, 'proposed', v_proposed, 'ambiguous', v_ambiguous);
end $$;

-- ══ 6. DECIDE A MATCH ═════════════════════════════════════════════════════════════════════════════════════════════════
-- Accept or reject one proposal. `decided_by` is auth.uid() from the session, never a parameter — a caller must not be
-- able to attribute a decision to somebody else.
create or replace function public.product_decide_app_account_identity_match(
  p_tenant_id uuid, p_match_id uuid, p_decision text
) returns jsonb language plpgsql security definer set search_path = public volatile as $$
declare v_n integer := 0;
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    raise exception 'not authorized for tenant %', p_tenant_id using errcode = '42501';
  end if;
  if p_decision not in ('accepted', 'rejected') then
    raise exception 'decision must be accepted or rejected';
  end if;
  update public.app_account_identity_matches m
     set status = p_decision, decided_by = auth.uid(), decided_at = now()
   where m.id = p_match_id and m.tenant_id = p_tenant_id and m.status = 'proposed';
  get diagnostics v_n = row_count;
  return jsonb_build_object('updated', v_n);
end $$;

-- ══ 7. LEAST PRIVILEGE ════════════════════════════════════════════════════════════════════════════════════════════════
-- On hosted Supabase, ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions straight to anon/authenticated
-- (0045), and `revoke from public` alone does not remove it — every role is named. These are PRODUCT reads, so
-- `authenticated` is granted back; the tenant-role gate inside each function is the actual boundary.
--
-- `connector_runner` IS revoked: the runner writes evidence through the 0077 definer functions and has no business on the
-- product read surface. `service_role` is deliberately NOT named, matching the 0061/0073 product-RPC precedent — it holds
-- table grants on everything and bypasses RLS already, so revoking EXECUTE on a read wrapper would buy nothing and would
-- put this migration permanently out of step with every other product read in the schema.
do $$
declare f text;
begin
  foreach f in array array[
    'public.product_app_accounts(uuid, uuid, boolean, text, text, text, text, integer, integer)',
    'public.product_app_account_groups(uuid, uuid, boolean, text, integer, integer)',
    'public.product_app_account_counts(uuid, uuid)',
    'public.product_connector_capabilities(uuid, uuid)',
    'public.product_propose_app_account_identity_matches(uuid, uuid)',
    'public.product_decide_app_account_identity_match(uuid, uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated, connector_runner', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
