-- 0016_files_uploader_finalize_update.sql
--
-- Add a NARROW UPDATE policy + CORRECT the `authenticated` table privileges so the UPLOADER can FINALIZE
-- the disposition of their OWN contract-file row after the Storage object upload — closing the gap PR #76
-- left (files-row-FIRST insert, then object upload, with NO way to flip `upload_status`). Staging
-- verification (doc 41 §11/§12/§13 / PR #78) found rows stuck at `upload_status='pending'` plus one
-- orphan metadata row with no Storage object. This lets the app set `upload_status='uploaded'` on success
-- and `upload_status='failed'` on a failed object upload — WITHOUT weakening tenant/contract isolation.
--
-- PRIVILEGE CORRECTION (the important bug a first cut missed): a `GRANT UPDATE (col)` is ADDITIVE — it does
-- NOT remove any pre-existing BROAD privileges. Staging verification (doc 41 §13) found `authenticated`
-- holding **table-level UPDATE on every column, DELETE, and TRUNCATE** on `public.files` (no migration
-- granted these — they came from hosted setup), which a narrow grant alone never revoked. **TRUNCATE is
-- especially unacceptable — it bypasses row-level logic.** So this migration first REVOKEs the broad
-- mutations from the request-path role, then GRANTs back ONLY the single finalization column. Idempotent:
-- REVOKE/GRANT converge to the same end state regardless of the prior grants (so re-applying — e.g. on the
-- staging project that already received the first cut — fixes it), and the policy uses drop-if-exists.
--
-- SCOPE — deliberately minimal. NO scan/extraction worker writes, NO DELETE/`FOR ALL` POLICY, NO new
-- Storage policy, NO bucket/column change, NO service-role change. SELECT + INSERT (`0015`) are NOT
-- revoked; `service_role` (trusted, never a request path) is NOT touched; the UPDATE RLS policy is NOT
-- weakened.
--   * UPDATE POLICY "uploader finalizes own file": a caller may UPDATE only a row they UPLOADED
--     (`uploaded_by = auth.uid()`) for a contract they may write (`can_write_contract`; `paying_org` never).
--     WITH CHECK repeats it, so `uploaded_by` / `tenant_id` / `contract_id` cannot be reassigned (a moved
--     row fails the check), and the `0012` same-tenant FK still blocks any cross-tenant `contract_id`.
--   * PRIVILEGES: after this migration `authenticated` holds on `public.files` EXACTLY
--     `SELECT, INSERT, UPDATE (upload_status)` — **no DELETE, no TRUNCATE, no other UPDATE column.**
--     `upload_status` is bounded to `pending` → `uploaded` | `failed` by the `0012` check constraint.
--   * Proven by org_rls_test.sql **T36** (the uploader-finalize row scoping: uploader-only, cross-tenant /
--     cross-user denial, no-reassign) + **T37** (the privilege surface: no DELETE/TRUNCATE; UPDATE only on
--     `upload_status`, not any immutable column). The local `test-rls.sh` harness applies a blanket grant
--     that re-broadens every table AFTER the migrations; it now RE-ASSERTS the migration-intended `files`
--     grants for `authenticated` so T37 reflects the REAL hosted privilege surface (the prior masking that
--     let a broad grant slip through is the gap this PR closes).
--
-- RLS remains the authorization boundary. The Storage object SELECT/INSERT policies are unchanged.

begin;

-- Idempotent policy (re-runnable — the first cut of 0016 was already applied to staging).
drop policy if exists "uploader finalizes own file" on public.files;
create policy "uploader finalizes own file" on public.files
for update
using (
  uploaded_by = auth.uid()
  and public.can_write_contract(contract_id, tenant_id)
)
with check (
  uploaded_by = auth.uid()
  and public.can_write_contract(contract_id, tenant_id)
);

-- Privilege correction: REVOKE the broad request-path mutations, then GRANT back ONLY the finalization
-- column. SELECT + INSERT (0015) and service_role are intentionally untouched.
-- safety-ack: this REVOKEs TRUNCATE/DELETE/UPDATE from `authenticated` (privilege TIGHTENING — the
-- opposite of a destructive teardown), then re-grants only update(upload_status); reviewed.
revoke update, delete, truncate on public.files from authenticated;
grant update (upload_status) on public.files to authenticated;

commit;
