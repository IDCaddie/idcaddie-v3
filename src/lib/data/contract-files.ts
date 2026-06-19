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
//     sign an object.
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

export type ContractFileListResult =
  | { ok: true; data: ContractFileSummary[] }
  | { ok: false; error: "query_failed" };

// List the files attached to a contract that the current user may read. RLS (tenant-member SELECT)
// is the authority — a cross-tenant user reads 0 rows. `contractId` is only a filter key.
export async function listContractFilesForCurrentUser(
  contractId: string,
): Promise<ContractFileListResult> {
  if (!isUuid(contractId)) return { ok: false, error: "query_failed" };
  const supabase = await createClient();

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
    // No UPDATE/DELETE policy on the request path → the row stays 'pending'; a future worker reconciles.
    console.error("[data/contract-files] object upload failed");
    return { ok: false, error: "upload_failed" };
  }

  return { ok: true, id: fileId };
}

export type ContractFileDownloadResult =
  | { ok: true; url: string }
  | { ok: false; error: "not_found" | "sign_failed" };

// Generate a short-lived signed URL to open a file — ONLY after the RLS read confirms the user may
// read the row (tenant-member SELECT) and the Storage SELECT policy authorizes the object. The URL is
// returned for an immediate open; the storage path is never exposed. `fileId` is only a lookup key —
// an RLS-hidden / cross-tenant file returns `not_found` (indistinguishable from a missing file).
export async function getContractFileDownloadUrlForCurrentUser(
  fileId: string,
): Promise<ContractFileDownloadResult> {
  if (!isUuid(fileId)) return { ok: false, error: "not_found" };
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("files")
    .select("storage_path")
    .eq("id", fileId)
    .maybeSingle();
  if (error) {
    console.error("[data/contract-files] download row read failed");
    return { ok: false, error: "not_found" };
  }
  if (!data) return { ok: false, error: "not_found" }; // RLS hid it, or no such file

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
