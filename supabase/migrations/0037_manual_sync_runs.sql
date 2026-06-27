-- 0037 — manual_sync_runs: an auditable run-lifecycle/status record for the LOCAL/DEV manual Slack sync (docs/47 PR 6+).
-- Additive + tenant-scoped + RLS. This is DISTINCT from public.connector_runs (0017): that table is keyed to an
-- OAuth-connected `connectors` row (connector_id FK → connectors(id, tenant_id)) and is reserved for the future
-- server-only runner. The dev manual sync has NO connectors/vault row (that is RISK-007/OAuth, still OPEN), so reusing
-- connector_runs would force creating a `connectors` row (implying a "connected" connector that does not exist) and
-- expanding the connectors write surface. This small dedicated table avoids that entanglement; `connector_id` here is a
-- plain LABEL (e.g. "slack-dev"), NOT a foreign key into the OAuth connectors table.
--
-- Safety: the record holds ONLY safe aggregates — counts, a SAFE error_code/failed_stage enum, and timestamps. It must
-- NEVER hold a Slack token, JWT, auth header, email, name, raw Slack response, raw user record, or raw DB payload.

create table public.manual_sync_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  source text not null,                                   -- provider label (NEVER a secret); P0 = 'slack'
  connector_id text not null,                             -- a connector/workspace LABEL — NOT an FK into the OAuth connectors table
  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_code text,                                        -- SAFE code only (e.g. 'resolve_failed','invalid_auth') — never a raw message
  failed_stage text,                                      -- SAFE enum (e.g. 'upsert_app') — never a value
  users_fetched integer,
  facts_emitted integer,
  facts_rejected integer,
  app_users_written integer,
  people_written integer,
  matches_written integer,
  match_conflicts integer,
  skipped integer,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null, -- actor from the JWT; preserved if the user is deleted
  created_at timestamptz not null default now(),
  constraint manual_sync_runs_source_check  check (source in ('slack')),
  constraint manual_sync_runs_status_check  check (status in ('running','succeeded','failed')),
  constraint manual_sync_runs_counts_nonneg check (
    (users_fetched     is null or users_fetched     >= 0) and
    (facts_emitted     is null or facts_emitted     >= 0) and
    (facts_rejected    is null or facts_rejected    >= 0) and
    (app_users_written is null or app_users_written >= 0) and
    (people_written    is null or people_written    >= 0) and
    (matches_written   is null or matches_written   >= 0) and
    (match_conflicts   is null or match_conflicts   >= 0) and
    (skipped           is null or skipped           >= 0)
  )
);

-- "latest run" reads + status sweeps, tenant-scoped.
create index manual_sync_runs_tenant_source_started_idx on public.manual_sync_runs (tenant_id, source, started_at desc);
create index manual_sync_runs_tenant_status_idx         on public.manual_sync_runs (tenant_id, status);

-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────
-- Tenant members READ; owner/admin/editor WRITE (mirrors the resolver write roles). No DELETE policy — runs are an
-- append-only audit log. tenant_id is the boundary; no cross-tenant access by source/connector label alone.
alter table public.manual_sync_runs enable row level security;

create policy "members read tenant manual_sync_runs" on public.manual_sync_runs
  for select using (public.is_tenant_member(tenant_id));

-- INSERT pins the actor to the JWT: created_by must equal auth.uid() (the column default fills it when omitted, so the
-- recorder's omit-the-column path passes; an attempt to set a DIFFERENT created_by is rejected). Mirrors 0016 files.
create policy "writers insert tenant manual_sync_runs" on public.manual_sync_runs
  for insert with check (
    public.has_tenant_role(tenant_id, array['owner','admin','editor'])
    and created_by = auth.uid()
  );

create policy "writers update tenant manual_sync_runs" on public.manual_sync_runs
  for update using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));

-- Append-only integrity: identity/anchor columns are immutable, and a COMPLETED run (succeeded/failed) is final — only
-- the single running→terminal close is allowed. This makes the no-DELETE table genuinely append-only and pins the actor
-- (alongside the INSERT check). Plain BEFORE UPDATE trigger (no SECURITY DEFINER needed — it only compares OLD/NEW).
create or replace function public.manual_sync_runs_guard_update()
returns trigger language plpgsql as $$
begin
  if new.created_by   is distinct from old.created_by
     or new.tenant_id    is distinct from old.tenant_id
     or new.source       is distinct from old.source
     or new.connector_id is distinct from old.connector_id
     or new.started_at   is distinct from old.started_at
     or new.created_at   is distinct from old.created_at then
    raise exception 'manual_sync_runs: identity columns are immutable';
  end if;
  if old.status <> 'running' then
    raise exception 'manual_sync_runs: a completed run is immutable';
  end if;
  return new;
end $$;

create trigger manual_sync_runs_guard_update_trg
  before update on public.manual_sync_runs
  for each row execute function public.manual_sync_runs_guard_update();

-- ── Grants (least privilege; RLS still filters rows) ─────────────────────────────────────────────────
revoke all on public.manual_sync_runs from anon, authenticated;
grant select, insert, update on public.manual_sync_runs to authenticated; -- NO delete (append-only audit log)
