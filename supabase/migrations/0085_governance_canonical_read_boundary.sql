-- 0085 — the canonical read boundary the cross-source governance loader needs, and the one fact it cannot infer.
--
-- WHY THIS EXISTS. The Phase 16 engine (`src/lib/server/cross-source-governance/`) consumes six canonical inputs. Four
-- already have authorized read paths — `product_app_accounts` / `product_connector_capabilities` (0078) and
-- `product_list_directory_identities` / `product_list_directory_applications` (0061). **Two have none:**
-- `person_account_links` (0082) shipped propose/decide only, and `application_matches` (0075) shipped RLS-on with zero
-- policies and this comment: *"The read contract will be a product RPC when a consumer exists."* The loader is that
-- consumer. This migration adds the two missing reads — and nothing else that could be inferred.
--
-- Both tables STAY DENY-ALL. No SELECT policy is added, no existing revoke is weakened, no direct table grant appears
-- anywhere below, and `service_role` is never used. The definer functions are the only read path, exactly as 0061 chose
-- for the directory graph: ordinary tenant membership is not sufficient evidence that a member may enumerate who is
-- linked to whom.
--
-- ══ THE THIRD PART, AND WHY IT IS A TABLE ════════════════════════════════════════════════════════════════════════════
-- Rule 5 of the engine must distinguish four states, and today it can distinguish only two by counting rows:
--
--   1. the matcher NEVER RAN                          -> unmatched applications are UNKNOWN
--   2. it ran and did not finish (failed / running)   -> still UNKNOWN
--   3. it COMPLETED and produced ZERO matches         -> unmatched applications really are unmanaged
--   4. it COMPLETED and produced matches              -> likewise
--
-- A row count collapses 1, 2 and 3 into one answer, and the one it picks ("unknown") silently withholds a true finding
-- forever once a real matcher exists. **A complete run that found nothing is a RESULT; never having looked is not.**
--
-- Reuse was considered and rejected on semantics, not effort. `connector_capability_state` (0076) is the natural
-- candidate and its key is `(tenant_id, connection_id, capability)` with `connection_id NOT NULL` referencing
-- `connectors`. Application matching is a TENANT-level process over already-persisted rows; it has no connection. Making
-- it fit would mean inventing a synthetic connector row, which is a lie in the shape of a foreign key. `connector_runs`
-- and `connector_run_resource_discovery` are connector-scoped for the same reason. So: one narrow table, three states,
-- no counters, no retry framework, no scheduler state, no generic job platform.
--
-- MATCHER EXECUTION STATE IS NOT MATCH TRUTH. `application_matches` remains the sole owner of which application relates
-- to which product and whether a human accepted it. This table only records whether the matching PROCESS ran to
-- completion. The two are separate facts and are never derived from one another.

-- ══ PART 1 — person_account_links READ ═══════════════════════════════════════════════════════════════════════════════
-- The engine needs four fields and no more: which person, which endpoint, and whether a human decided. It deliberately
-- returns NO email, name, rationale, decider or timestamp — a link is a judgement about a human, and the governance
-- engine reasons over row ids alone (the Phase 14 privacy rule, unchanged).
create or replace function public.product_person_account_links(
  p_tenant_id uuid, p_after_id uuid default null, p_limit integer default 500
) returns table (
  id uuid, person_id uuid, identity_account_id uuid, app_account_id uuid, status text
) language sql security definer set search_path = public stable as $$
  select l.id, l.person_id, l.identity_account_id, l.app_account_id, l.status
    from public.person_account_links l
   where public.has_tenant_role(p_tenant_id, array['owner', 'admin'])
     and l.tenant_id = p_tenant_id
     and (p_after_id is null or l.id > p_after_id)
   order by l.id
   limit greatest(1, least(coalesce(p_limit, 500), 500));
$$;

-- ══ PART 2 — application_matches READ ════════════════════════════════════════════════════════════════════════════════
-- Both endpoints plus the decision. NOT `method`, `confidence`, `rationale`, `decided_by` or `decided_at`: the engine
-- asks only "did a human accept this?", and every other column is either reviewer metadata or an attribution.
create or replace function public.product_application_matches(
  p_tenant_id uuid, p_after_id uuid default null, p_limit integer default 500
) returns table (
  id uuid, directory_application_id uuid, app_id uuid, status text
) language sql security definer set search_path = public stable as $$
  select m.id, m.directory_application_id, m.app_id, m.status
    from public.application_matches m
   where public.has_tenant_role(p_tenant_id, array['owner', 'admin'])
     and m.tenant_id = p_tenant_id
     and (p_after_id is null or m.id > p_after_id)
   order by m.id
   limit greatest(1, least(coalesce(p_limit, 500), 500));
$$;

-- ══ PART 3 — application matcher execution state ═════════════════════════════════════════════════════════════════════
-- ONE row per tenant, three states. **The absence of a row is itself the answer to "has it ever run?"** — which is why
-- there is no `has_ever_run` column: a nullable boolean that must agree with the row's own existence is two places to
-- store one fact.
--
-- `last_completed_at` survives a later failure ON PURPOSE. An older completed run remains a fact when a newer run
-- fails, and the newer failure remains a fact too. Both are visible at once, so a stale completion cannot mask a fresh
-- failure and a fresh failure cannot erase a real completion. The reader decides which matters; the table refuses to
-- choose on its behalf.
create table if not exists public.application_matcher_state (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,

  status text not null,
  constraint ams_status_chk check (status in ('running', 'completed', 'failed')),

  -- When the CURRENT (most recent) run began.
  started_at timestamptz not null,
  -- When a run last finished successfully. NULL = no run has ever completed, whatever the current status says.
  last_completed_at timestamptz,
  constraint ams_completed_implies_timestamp_chk check (status <> 'completed' or last_completed_at is not null),

  updated_at timestamptz not null default now()
);

-- Deny-all, like every canonical governance table. Reads and writes go through the definer functions below or nowhere.
-- The connector runner is revoked: matching is a tenant-level process over persisted rows, not connector evidence.
alter table public.application_matcher_state enable row level security;
revoke all on public.application_matcher_state from public, anon, authenticated, connector_runner;

-- Always exactly ONE row for an authorized caller, so "never ran" is a value rather than an empty result that could be
-- confused with a refusal. An unauthorized caller — or a tenant that does not exist — gets zero rows, identical to each
-- other, disclosing nothing (the 0061 no-existence-disclosure rule).
create or replace function public.product_application_matcher_state(p_tenant_id uuid)
returns table (
  has_ever_run boolean, status text, started_at timestamptz, last_completed_at timestamptz, has_completed boolean
) language sql security definer set search_path = public stable as $$
  select (s.tenant_id is not null) as has_ever_run,
         s.status, s.started_at, s.last_completed_at,
         (s.last_completed_at is not null) as has_completed
    from (select 1) probe
    left join public.application_matcher_state s on s.tenant_id = p_tenant_id
   where public.has_tenant_role(p_tenant_id, array['owner', 'admin']);
$$;

-- ── The write contract the MATCHER lane must call ────────────────────────────────────────────────────────────────────
-- Three verbs, no matching logic. `complete` and `fail` accept only a run that actually STARTED, so a completion cannot
-- be fabricated without one — which is what stops "complete with zero matches" from being assertable by a caller that
-- never looked at anything.
create or replace function public.product_start_application_matcher_run(p_tenant_id uuid)
returns jsonb language plpgsql security definer set search_path = public volatile as $$
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    raise exception 'not authorized for tenant %', p_tenant_id using errcode = '42501';
  end if;
  insert into public.application_matcher_state (tenant_id, status, started_at, updated_at)
  values (p_tenant_id, 'running', now(), now())
  on conflict (tenant_id) do update
    set status = 'running', started_at = now(), updated_at = now();
  -- last_completed_at is deliberately untouched: starting a new run does not un-complete the previous one.
  return jsonb_build_object('status', 'running');
end $$;

create or replace function public.product_complete_application_matcher_run(p_tenant_id uuid)
returns jsonb language plpgsql security definer set search_path = public volatile as $$
declare v_n integer := 0;
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    raise exception 'not authorized for tenant %', p_tenant_id using errcode = '42501';
  end if;
  update public.application_matcher_state
     set status = 'completed', last_completed_at = now(), updated_at = now()
   where tenant_id = p_tenant_id and status = 'running';
  get diagnostics v_n = row_count;
  return jsonb_build_object('updated', v_n);
end $$;

create or replace function public.product_fail_application_matcher_run(p_tenant_id uuid)
returns jsonb language plpgsql security definer set search_path = public volatile as $$
declare v_n integer := 0;
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    raise exception 'not authorized for tenant %', p_tenant_id using errcode = '42501';
  end if;
  -- last_completed_at is NOT cleared: an earlier successful run still happened.
  update public.application_matcher_state
     set status = 'failed', updated_at = now()
   where tenant_id = p_tenant_id and status = 'running';
  get diagnostics v_n = row_count;
  return jsonb_build_object('updated', v_n);
end $$;

-- ══ LEAST PRIVILEGE ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Hosted Supabase's ALTER DEFAULT PRIVILEGES (0045) grants EXECUTE on new public functions straight to anon/authenticated
-- and `revoke from public` alone does not remove it, so every role is named. `connector_runner` is revoked from all six:
-- it produces connector evidence and has no business reading a human judgement or driving a tenant-level process.
-- `service_role` is deliberately not named, matching the 0061/0073/0078/0082/0083 product-RPC precedent.
do $$
declare f text;
begin
  foreach f in array array[
    'public.product_person_account_links(uuid, uuid, integer)',
    'public.product_application_matches(uuid, uuid, integer)',
    'public.product_application_matcher_state(uuid)',
    'public.product_start_application_matcher_run(uuid)',
    'public.product_complete_application_matcher_run(uuid)',
    'public.product_fail_application_matcher_run(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated, connector_runner', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
