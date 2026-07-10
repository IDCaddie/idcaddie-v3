-- 0042_discovery_facts_audit_on_write.sql
--
-- DB-side audit-on-write for the discovery_facts REVIEW transition, mirroring 0010
-- (contracts_audit_on_write). Records every ACCEPTED review-status change (confirm /
-- reject / other review update) with METADATA ONLY, so an audit trail exists BEFORE any
-- confirm/reject UI or server action is built. PR A prepares the trigger only — it does
-- NOT authorize or implement the confirm/reject actions or any UI (docs/68).
--
-- WHY DB-SIDE (not an app route): audit_logs is append-only with NO `authenticated`
-- INSERT policy (0001 SELECT-only + 0002 reject_audit_mutation), so a normal request path
-- CANNOT write audit rows. The only safe writer is a SECURITY DEFINER trigger owned by the
-- migration owner — never a service-role app client (which would also bypass tenant RLS).
--
-- WHAT THIS DOES NOT CHANGE:
--   * discovery_facts write AUTHORIZATION is untouched — the existing 0025 RLS
--     (`editors update discovery_facts` = has_tenant_role owner/admin/editor; members read;
--     editors insert; NO DELETE) still decides who may write. This trigger only RECORDS an
--     accepted review update.
--   * No policy is added/removed on discovery_facts or audit_logs. No `authenticated` INSERT
--     on audit_logs. No new grant (connector_runner still has NOTHING on discovery_facts).
--     No service-role path. No DELETE/FOR ALL. No RLS/BYPASSRLS/FORCE change.
--   * No user-visible behavior changes (invisible backend audit).
--
-- SCOPE (metadata only — NEVER a body): the audit row carries the table name, the
-- discovery_fact id, tenant_id, the old/new review_status, rejected_reason (a fixed
-- short code, never free text), reviewed_by, reviewed_at, and the actor (auth.uid()).
-- It NEVER carries fact_json, natural_key, signal_id, source_record_id, provenance_json,
-- observed body, names, emails, provider ids, payloads, tokens, or secrets.
--
-- UPDATE ONLY, and only when a review column actually changes: `AFTER UPDATE OF
-- review_status, reviewed_by, reviewed_at, rejected_reason` + a `WHEN (... IS DISTINCT
-- FROM ...)` guard. INSERT and DELETE do NOT fire it (a fresh sync ingest is not a review
-- event; discovery_facts has no DELETE). AFTER ROW → only rows the statement actually wrote
-- (an RLS-blocked write reaches 0 rows and is not audited); same-transaction rollback drops
-- the audit row too.
--
-- ACTOR under SECURITY DEFINER: SECURITY DEFINER changes the EXECUTING ROLE (to the function
-- owner, which may append to audit_logs) but NOT session GUCs — auth.uid() still reads the
-- caller's JWT sub, so the actor is the writing user, never the owner or service_role.

begin;

create or replace function public.audit_discovery_fact_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Curated, non-sensitive allowlist ONLY — never the fact body. before_json stays NULL
  -- (we record an accepted review event + the status transition, not a full row diff).
  insert into public.audit_logs (
    tenant_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    after_json
  )
  values (
    new.tenant_id,
    auth.uid(),
    case new.review_status
      when 'confirmed' then 'discovery_fact.confirmed'
      when 'rejected'  then 'discovery_fact.rejected'
      else 'discovery_fact.reviewed'
    end,
    'discovery_fact',
    new.id,
    jsonb_build_object(
      'table', 'discovery_facts',
      'discovery_fact_id', new.id,
      'tenant_id', new.tenant_id,
      'operation', 'review',
      'old_review_status', old.review_status,
      'new_review_status', new.review_status,
      'rejected_reason', new.rejected_reason,   -- a fixed short code (never free text / PII)
      'reviewed_by', new.reviewed_by,
      'reviewed_at', new.reviewed_at
    )
  );
  return null;  -- AFTER ROW trigger: return value is ignored
end;
$$;

-- A trigger function cannot be invoked directly (Postgres rejects a non-trigger call), so
-- there is no way to call this to forge an audit row outside an actual discovery_facts review.

drop trigger if exists discovery_facts_audit_on_write on public.discovery_facts;
create trigger discovery_facts_audit_on_write
  after update of review_status, reviewed_by, reviewed_at, rejected_reason
  on public.discovery_facts
  for each row
  when (
    old.review_status   is distinct from new.review_status
    or old.reviewed_by     is distinct from new.reviewed_by
    or old.reviewed_at     is distinct from new.reviewed_at
    or old.rejected_reason is distinct from new.rejected_reason
  )
  execute function public.audit_discovery_fact_review();

commit;
