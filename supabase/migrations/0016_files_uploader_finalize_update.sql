-- 0016_files_uploader_finalize_update.sql
--
-- Add a NARROW UPDATE policy + a column-scoped grant so the UPLOADER can FINALIZE the disposition of
-- their OWN just-created contract-file row after the Storage object upload completes — closing the gap
-- PR #76 left (files-row-FIRST insert, then object upload, with NO way to flip `upload_status`). Manual
-- staging verification (doc 41 §11 / PR #77) found rows stuck at `upload_status='pending'` (successful
-- uploads were never finalized) plus one orphan metadata row with no Storage object (a failed upload
-- that could not be marked `failed`). This lets the app set `upload_status='uploaded'` on success and
-- `upload_status='failed'` on a failed object upload — WITHOUT weakening tenant/contract isolation.
--
-- SCOPE — deliberately minimal. The `0013` header explicitly deferred a broad user UPDATE; this is NOT
-- that. It adds NO scan/extraction worker writes, NO DELETE, NO `FOR ALL`, NO new Storage policy, NO
-- bucket change, NO service-role, NO `anon`. It does not edit an applied migration (0001–0015).
--
--   * UPDATE POLICY "uploader finalizes own file": a caller may UPDATE only a row they UPLOADED
--     (`uploaded_by = auth.uid()`) for a contract they may write (`can_write_contract` — the `0004`/`0013`
--     authority; `paying_org` never). The WITH CHECK repeats the same predicate, so the resulting row
--     must STAY theirs + authorized: `uploaded_by` / `tenant_id` / `contract_id` cannot be reassigned (a
--     moved row fails the check), and the `0012` same-tenant FK still blocks any cross-tenant
--     `contract_id`. No cross-tenant and no cross-user update is possible. Proven by org_rls_test.sql T36.
--
--   * COLUMN-SCOPED GRANT: `update (upload_status)` ONLY. Even with the policy, a caller can change ONLY
--     `upload_status` (`pending` → `uploaded` | `failed`, bounded by the `0012` check constraint) — never
--     `storage_path` / `sha256` / `original_filename` / `contract_id` / `tenant_id` / `uploaded_by`.
--     (The local `scripts/test-rls.sh` harness applies a broad blanket grant that MASKS this column
--     narrowing — the same gap class as `0015` — so the column grant is enforced at the HOSTED privilege
--     layer; the RLS policy's row scoping is what T36 proves locally. Either way, an attempt to change a
--     non-granted column fails closed: hosted by the column grant, local by the WITH CHECK.)
--
-- RLS remains the authorization boundary. The Storage object SELECT/INSERT policies are unchanged, so a
-- self-asserted `upload_status='uploaded'` on a row with no object still cannot read a missing/foreign
-- object (the object policy re-derives authority from the path; download is also gated server-side on
-- `upload_status='uploaded'`).

begin;

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

-- Base privilege for the policy, narrowed to the single finalization column.
grant update (upload_status) on public.files to authenticated;

commit;
