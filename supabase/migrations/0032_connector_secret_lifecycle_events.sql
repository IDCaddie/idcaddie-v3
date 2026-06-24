-- 0032_connector_secret_lifecycle_events.sql
--
-- Model B lifecycle table (docs/42 §85, RISK-007). An INSERT-only `connector_secret_lifecycle_events` table that
-- records non-secret lifecycle state (revoked / tombstoned / superseded) for a connector secret version, so the
-- runner load query can FAIL CLOSED on a revoked/tombstoned version WITHOUT mutating `connector_secrets`. This
-- keeps `connector_secrets` append-only (no UPDATE, no DELETE, no new UPDATE grant — the T50 invariant).
--
-- THIS PR (read-only): the runner gets a NARROW, COLUMN-scoped SELECT for the load eligibility check ONLY. It does
-- NOT get INSERT here — lifecycle WRITE helpers (revoke/tombstone) + the runner INSERT grant land in the next PR,
-- with the code that uses them (do not grant privileges ahead of code). The runner never gets UPDATE/DELETE; an
-- append-only trigger rejects UPDATE/DELETE for EVERY role (proven under `set role connector_runner` in T53).
--
-- SAFE METADATA ONLY: the table holds NO plaintext, provider token, ciphertext, DEK / wrapped DEK, key material,
-- AEAD tag, nonce/IV, `aad_digest`, KMS response, raw error, or env value — only the non-secret lifecycle columns.
--
-- check-migration-safety: no table-removal, no row-purge, no RLS-disable. The lifecycle rows are seeded only by
-- the test/admin setup path in this PR; the runner cannot write them.

create table public.connector_secret_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connector_id uuid not null,
  secret_kind text not null,
  version integer not null,
  lifecycle_event_type text not null,
  reason_class text,                                      -- SAFE STATIC reason class only (never free-form / raw error)
  actor_type text,                                        -- runtime/actor type if available (e.g. connector_runner)
  correlation_id text,                                    -- grammar-safe id only (uuid / run-/job- prefixed)
  audit_log_id uuid references public.audit_logs (id),    -- optional reference to the paired audit row
  created_at timestamptz not null default now(),          -- the DB owns the timestamp
  constraint connector_secret_lifecycle_kind_check
    check (secret_kind in ('oauth_access','oauth_refresh','api_key','pat','webhook_signing')),
  constraint connector_secret_lifecycle_type_check
    check (lifecycle_event_type in ('revoked','tombstoned','superseded')),
  constraint connector_secret_lifecycle_version_pos check (version > 0),
  -- same-tenant binding: a tenant-B lifecycle event can NEVER reference a tenant-A connector.
  constraint connector_secret_lifecycle_connector_same_tenant
    foreign key (connector_id, tenant_id)
    references public.connectors (id, tenant_id) on delete cascade
);

-- the index the load eligibility check (NOT EXISTS revoked/tombstoned for a version) uses.
create index connector_secret_lifecycle_lookup_idx
  on public.connector_secret_lifecycle_events (tenant_id, connector_id, secret_kind, version);

-- ── RLS: deny-all (zero policies). authenticated/anon get NO read/write; the runner (BYPASSRLS) reads via the
--    narrow column grant below; tenant scoping is by the load query's WHERE tenant_id, same as connector_secrets.
alter table public.connector_secret_lifecycle_events enable row level security;
revoke all on public.connector_secret_lifecycle_events from authenticated;
revoke all on public.connector_secret_lifecycle_events from anon;

-- ── Append-only protection: reject UPDATE/DELETE for EVERY role (incl. connector_runner). INSERT is append-only
--    by nature; this trigger blocks only mutation. (Proven under `set role connector_runner` in T53.)
create or replace function public.reject_connector_secret_lifecycle_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'connector_secret_lifecycle_events is append-only: % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists connector_secret_lifecycle_no_mutation on public.connector_secret_lifecycle_events;
create trigger connector_secret_lifecycle_no_mutation
  before update or delete on public.connector_secret_lifecycle_events
  for each row execute function public.reject_connector_secret_lifecycle_mutation();

-- ── Runner grant — SELECT ONLY, on EXACTLY the columns the load eligibility check reads. NO INSERT (deferred to
--    the write-helper PR), NO UPDATE, NO DELETE. The runner never reads reason_class/actor_type/correlation_id/
--    audit_log_id/created_at/id for the load check.
grant select (tenant_id, connector_id, secret_kind, version, lifecycle_event_type)
  on public.connector_secret_lifecycle_events to connector_runner;
