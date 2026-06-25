-- 0034_oauth_pending_b2a_reason_codes.sql
--
-- B2a (docs/42 §90.2): the OAuth state validation now binds + compares all eight fields and emits four NEW safe
-- reason CODES — `session_required`, `subject_mismatch`, `redirect_uri_mismatch`, `correlation_mismatch`. The
-- `oauth_pending.last_rejected_code` column records the safe rejection code for a failed callback attempt (a SAFE
-- CODE only — never a secret/nonce/state/code value), gated by a CHECK allowlist. This migration WIDENS that
-- allowlist to include the four new codes so a rejected B2a callback attempt can record its reason.
--
-- This is the SMALLEST possible change: it only DROPs + re-ADDs the CHECK constraint on `last_rejected_code` (a
-- widening — every previously-allowed value is still allowed). No table/column is added or dropped, no data is
-- mutated or purged, no grant changes (the runner already has the `update (consumed_at, attempt_count,
-- last_rejected_code)` grant from 0021). `database.types.ts` is unaffected (a CHECK constraint is not a column/type).
--
-- B2a adds NO real token, NO OAuth exchange, NO Slack API call, NO callback route that exchanges a code, NO live
-- connector, NO request-path decrypt, NO production enablement. RISK-007 remains OPEN.

alter table public.oauth_pending drop constraint oauth_pending_last_rejected_code_check;

alter table public.oauth_pending add constraint oauth_pending_last_rejected_code_check
  check (last_rejected_code is null or last_rejected_code in
    ('missing_state','malformed_state','bad_signature','missing_nonce','expired','replayed',
     'session_required','subject_mismatch','tenant_mismatch','provider_mismatch','connector_mismatch',
     'redirect_uri_mismatch','correlation_mismatch'));
