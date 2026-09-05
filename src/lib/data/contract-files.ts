import { createClient } from "@/lib/supabase/server";
import { resolveTenantContext } from "@/lib/auth/tenant-context";
import {
  resolveWriteContextTenantId,
  classifyContractWriteError,
  isUuid,
} from "./contract-write";
import {
  validateContractPdf,
  buildContractFileObjectPath,
  CONTRACT_FILES_BUCKET,
  type PdfValidationError,
} from "../files/pdf-validation";

// Server-only data access for contract FILE attachments — the first surface over the verified
// contract-files Storage boundary + the `0012`–`0015` files foundation. Same discipline as
// src/lib/data/contracts.ts: imports the user-scoped server client (NEVER service-role / admin),
// takes NO tenant_id from the caller (it is resolved server-side), and relies entirely on RLS +
// the `storage.objects` policies for authorization — this code authorizes nothing itself.
//
// AUTHORIZATION (already tested — org_rls_test.sql T34 + the hosted Storage REST verifier 14/14):
//   * READ  — `files` SELECT RLS = tenant member; the `storage.objects` SELECT policy =
//     can_read_contract_file. A cross-tenant / non-member / org-only user reads 0 rows and cannot
//     sign an object. Because that read is narrower than the contract read union, an empty result is
//     ambiguous for an org-scoped reader — see `listContractFilesForCurrentUser`, which reports
//     `not_readable` rather than claiming the contract has no documents.
//   * WRITE — `files` INSERT RLS = can_write_contract (tenant editor+ OR procurement-org manager;
//     `paying_org` never; `uploaded_by = auth.uid()`); the same-tenant composite FK (`0012`) blocks
//     any cross-tenant attach; the `storage.objects` INSERT policy = can_write_contract_file +
//     server-derived path shape.
//
// FILES-ROW-FIRST: the Storage object policy authorizes an object only when a matching `files` row
// for (file_id, tenant_id) already exists (no orphan-object authorization, `0014`). So we INSERT the
// metadata row first (RLS-gated), then upload the bytes (Storage-policy-gated). There is no UPDATE /
// DELETE policy on `files` from the request path, so a failed object upload leaves the row at
// `upload_status='pending'` (a future worker reconciles) — we never service-role-clean it here.
//
// NO secrets, storage paths, signed URLs, or raw Supabase errors are returned to callers — the DTOs
// and result labels are deliberately minimal; errors are logged without detail.

// Safe list DTO — NEVER includes storage_path, storage_bucket, sha256, or any signed URL.
export type ContractFileSummary = {
  id: string;
  filename: string;
  uploadStatus: string;
  createdAt: string;
};

// `not_readable` is NOT an error and NOT an empty set: the caller may read the contract but cannot
// observe its file rows at all, so the product must not claim the contract has no documents.
export type ContractFileListResult =
  | { ok: true; data: ContractFileSummary[] }
  | { ok: false; error: "query_failed" | "not_readable" };

// List the files attached to a contract that the current user may read. RLS is the authority — this
// module authorizes nothing and widens nothing.
//
// WHY THE READABILITY PROBE. `files` SELECT is tenant-member-only (`0013:53-54`), which is STRICTLY
// NARROWER than the contract read union (tenant member ∪ procurement-org ∪ paying-org member,
// `0003:47-63`). An org-scoped contract reader therefore ALWAYS reads 0 file rows — a fact about
// their authorization, never a fact about the contract. Returning `[]` there made the UI print "No
// files attached yet", i.e. a false claim that the contract has no documents. We detect that case and
// say so instead.
//
// The probe reads only what the caller could already read: the contract row (RLS-gated, and they are
// on its detail page) and `tenant_memberships`, whose policy is `is_tenant_member(tenant_id)` — so it
// returns rows IFF the caller is an active member of that tenant, and returns nothing otherwise. No
// policy changes, no service-role, no new column, and `tenant_id` never leaves this module.
export async function listContractFilesForCurrentUser(
  contractId: string,
): Promise<ContractFileListResult> {
  if (!isUuid(contractId)) return { ok: false, error: "query_failed" };
  const supabase = await createClient();

  // Which tenant does this contract belong to? RLS decides whether we may see the row at all.
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("tenant_id")
    .eq("id", contractId)
    .maybeSingle();
  if (contractError) {
    console.error("[data/contract-files] contract tenant read failed");
    return { ok: false, error: "query_failed" };
  }
  // RLS hid the contract, or there is no such contract — either way the caller cannot observe its
  // file set, so we must not describe that set. Indistinguishable by design (no enumeration).
  if (!contract) return { ok: false, error: "not_readable" };

  // Is the caller a tenant member of THAT tenant? Only a tenant member can read any `files` row.
  const { data: membership, error: membershipError } = await supabase
    .from("tenant_memberships")
    .select("tenant_id")
    .eq("tenant_id", contract.tenant_id)
    .limit(1);
  if (membershipError) {
    console.error("[data/contract-files] membership probe failed");
    return { ok: false, error: "query_failed" };
  }
  // An org-scoped contract reader (procurement-org / paying-org member, no tenant membership) lands
  // here. Their empty file read proves nothing, so it is never reported as an empty document set.
  if ((membership ?? []).length === 0) return { ok: false, error: "not_readable" };

  const { data, error } = await supabase
    .from("files")
    .select("id, original_filename, upload_status, created_at")
    .eq("contract_id", contractId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[data/contract-files] list query failed");
    return { ok: false, error: "query_failed" };
  }
  return {
    ok: true,
    data: (data ?? []).map((f) => ({
      id: f.id,
      filename: f.original_filename,
      uploadStatus: f.upload_status,
      createdAt: f.created_at,
    })),
  };
}

export type ContractFileUploadInput = {
  contractId: string;
  // Display name from the client — validated for extension only, never used for the path.
  originalFilename: string;
  // Client-declared content type — checked but never sufficient alone (magic bytes decide).
  contentType: string;
  // The ACTUAL bytes, read server-side — byteSize + magic header are measured from these, not trusted.
  bytes: Uint8Array;
};

export type ContractFileUploadResult =
  | { ok: true; id: string }
  | { ok: false; error: "invalid_file"; reason: PdfValidationError }
  | {
      ok: false;
      error: "not_authenticated" | "no_tenant" | "not_allowed" | "upload_failed" | "query_failed";
    };

// Attach a file to a contract. Validates the bytes at the trust boundary, resolves tenant_id
// SERVER-SIDE (never from the caller), derives the object path server-side, inserts the RLS-gated
// `files` row FIRST, then uploads the bytes to the private bucket (Storage-policy-gated).
export async function uploadContractFileForCurrentUser(
  input: ContractFileUploadInput,
): Promise<ContractFileUploadResult> {
  const { contractId, originalFilename, contentType, bytes } = input;
  if (!isUuid(contractId)) return { ok: false, error: "not_allowed" };

  // Validate from the SERVER-measured bytes (length + first-5-byte magic header), not client claims.
  const validation = validateContractPdf({
    originalFilename,
    contentType,
    byteSize: bytes.byteLength,
    header: bytes.subarray(0, 5),
  });
  if (!validation.ok) return { ok: false, error: "invalid_file", reason: validation.error };

  const context = await resolveTenantContext();
  if (!context) return { ok: false, error: "not_authenticated" };
  if (context.status === "error") return { ok: false, error: "query_failed" };
  const tenantId = resolveWriteContextTenantId(context);
  if (!tenantId) return { ok: false, error: "no_tenant" };

  // Both path components are server-issued UUIDs (tenant from resolved context, file_id fresh) —
  // buildContractFileObjectPath throws on any non-UUID, so a client value can never reach the path.
  const fileId = crypto.randomUUID();
  const storagePath = buildContractFileObjectPath(tenantId, fileId);
  const sha256 = await sha256Hex(bytes);

  const supabase = await createClient();

  // Step 1 — metadata row FIRST (RLS INSERT = can_write_contract; uploaded_by must equal auth.uid()).
  const { error: insertError } = await supabase.from("files").insert({
    id: fileId,
    tenant_id: tenantId, // SERVER-derived, never from the caller
    contract_id: contractId,
    storage_bucket: CONTRACT_FILES_BUCKET,
    storage_path: storagePath,
    original_filename: validation.displayFilename,
    content_type: "application/pdf",
    byte_size: validation.byteSize,
    sha256,
    uploaded_by: context.userId,
    upload_status: "pending",
  });
  if (insertError) {
    console.error("[data/contract-files] metadata insert rejected");
    return { ok: false, error: classifyContractWriteError(insertError.code) };
  }

  // Step 2 — bytes to the private bucket (Storage INSERT policy = can_write_contract_file + path shape).
  const bodyBytes = new Uint8Array(bytes.byteLength); // ArrayBuffer-backed copy (BlobPart type)
  bodyBytes.set(bytes);
  const body = new Blob([bodyBytes], { type: "application/pdf" });
  const { error: uploadError } = await supabase.storage
    .from(CONTRACT_FILES_BUCKET)
    .upload(storagePath, body, { contentType: "application/pdf", upsert: false });
  if (uploadError) {
    // Disposition the orphan metadata row as 'failed' (RLS `0016`: uploader-only, same tenant) so it is
    // not an ambiguous 'pending' row with no object. The `failed` row is excluded from open/download.
    // If even this update is denied, the row stays 'pending' (we never service-role-clean it) — the UI
    // still distinguishes pending from uploaded, so it is not misleading.
    await supabase.from("files").update({ upload_status: "failed" }).eq("id", fileId);
    console.error("[data/contract-files] object upload failed; row marked failed");
    return { ok: false, error: "upload_failed" };
  }

  // Step 3 — FINALIZE: the object exists, so flip the uploader's own row to 'uploaded' (RLS `0016`).
  // The bucket/content_type/byte_size/sha256 were already persisted at insert; this confirms the
  // status. If the finalize update fails, the file is still uploaded + usable (the object exists) — we
  // return success and log; the row stays 'pending' (a rare degraded state, never a false 'uploaded').
  const { error: finalizeError } = await supabase
    .from("files")
    .update({ upload_status: "uploaded" })
    .eq("id", fileId);
  if (finalizeError) {
    console.error("[data/contract-files] finalize status update failed (object uploaded)");
  }

  return { ok: true, id: fileId };
}

export type ContractFileDownloadResult =
  | { ok: true; url: string }
  | { ok: false; error: "not_found" | "not_ready" | "sign_failed" };

// Generate a short-lived signed URL to open a file — ONLY after the RLS read confirms the user may
// read the row (tenant-member SELECT), the row is FINALIZED (`upload_status='uploaded'` ⇒ a confirmed
// Storage object), and the Storage SELECT policy authorizes the object. The URL is returned for an
// immediate open; the storage path is never exposed. `fileId` is only a lookup key — an RLS-hidden /
// cross-tenant file returns `not_found` (indistinguishable from a missing file); a `pending`/`failed`
// row (which may have no object) returns `not_ready` and is never signed.
export async function getContractFileDownloadUrlForCurrentUser(
  fileId: string,
): Promise<ContractFileDownloadResult> {
  if (!isUuid(fileId)) return { ok: false, error: "not_found" };
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("files")
    .select("storage_path, upload_status")
    .eq("id", fileId)
    .maybeSingle();
  if (error) {
    console.error("[data/contract-files] download row read failed");
    return { ok: false, error: "not_found" };
  }
  if (!data) return { ok: false, error: "not_found" }; // RLS hid it, or no such file
  // Only finalized uploads are openable — a pending/failed row may have no Storage object.
  if (data.upload_status !== "uploaded") return { ok: false, error: "not_ready" };

  // Always sign within the single private contract-files bucket — this surface only ever stores there
  // (every uploaded row sets storage_bucket = CONTRACT_FILES_BUCKET). A row pointing elsewhere simply
  // fails closed (object-not-found) rather than being signed from an unexpected bucket.
  const { data: signed, error: signError } = await supabase.storage
    .from(CONTRACT_FILES_BUCKET)
    .createSignedUrl(data.storage_path, 60); // 60s — short-lived, generated only after authorization
  if (signError || !signed) {
    console.error("[data/contract-files] signed url generation failed");
    return { ok: false, error: "sign_failed" };
  }
  return { ok: true, url: signed.signedUrl };
}

// SHA-256 hex of the uploaded bytes (lowercase, matches the files_sha256_hex check). Integrity +
// future migration byte-checksum reconciliation (doc 34 §5).
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view (the numeric-length ctor gives Uint8Array<ArrayBuffer>,
  // which digest accepts as a BufferSource — a subarray/shared buffer does not type-check).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
