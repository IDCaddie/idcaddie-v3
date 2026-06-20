import { createClient } from "@/lib/supabase/server";

// Server-only, read-only data access for the standalone Files / Documents page. Same discipline as
// contract-files.ts: imports the user-scoped server client (NEVER service-role / admin), takes NO
// tenant_id from the caller, and relies entirely on RLS to scope what the signed-in user may read
// (`files` SELECT RLS = `is_tenant_member(tenant_id)`, `0013`). No writes, no upload, no delete, no
// export, no signed URLs here.
//
// SAFE DTO by construction: we select + expose ONLY filename / contract link / upload status / content
// type / size / created date. We DELIBERATELY never select or expose `storage_path`, `storage_bucket`,
// the raw object name, `sha256`, `tenant_id`, `uploaded_by`, any signed URL, or the extraction blobs.
// Standalone open/download is NOT built — the file links to its contract, where the existing verified
// open flow (getContractFileDownloadUrlForCurrentUser + the contract-file action) lives.

export type FileSummary = {
  id: string;
  filename: string;
  contractId: string | null; // a lookup key for the contract link — never a tenant/storage id
  contractName: string | null; // null when the contract is not separately readable
  uploadStatus: string;
  contentType: string | null;
  byteSize: number | null;
  createdAt: string;
};

export type FileListResult =
  | { ok: true; data: FileSummary[] }
  | { ok: false; error: "query_failed" };

// Human-readable upload status — mirrors the contract-detail attachment labels. Only an "uploaded"
// file is openable (on its contract); pending/failed are explicitly marked not-openable.
export function fileStatusLabel(uploadStatus: string): string {
  if (uploadStatus === "uploaded") return "Uploaded";
  if (uploadStatus === "failed") return "Upload failed — not openable";
  return "Pending — not yet openable";
}

// Compact size label; null/unknown → "—". Never throws.
export function formatFileSize(byteSize: number | null): string {
  if (byteSize == null || byteSize < 0) return "—";
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

// List the files the current user may read (RLS-scoped), with a safe contract name for linking. Two
// RLS-filtered reads: `files` (the safe column subset) + `contracts` (id → name); a file whose
// contract the user cannot separately read shows contractName = null but still lists. No tenant filter.
export async function listFilesForCurrentUser(): Promise<FileListResult> {
  const supabase = await createClient();

  const { data: files, error: filesErr } = await supabase
    .from("files")
    // Explicit safe column subset — NEVER storage_path / storage_bucket / sha256 / tenant_id / uploaded_by.
    .select("id, contract_id, original_filename, upload_status, content_type, byte_size, created_at")
    .order("created_at", { ascending: false });
  if (filesErr) {
    console.error("[data/files] listFilesForCurrentUser files query failed");
    return { ok: false, error: "query_failed" };
  }

  // Contract names (RLS-scoped) for linking — id → name. Non-fatal: on failure, names show as null but
  // the files still list (a missing contract name must not erase a readable file row).
  const { data: contracts, error: contractsErr } = await supabase
    .from("contracts")
    .select("id, contract_name");
  if (contractsErr) {
    console.error("[data/files] listFilesForCurrentUser contracts query failed (non-fatal)");
  }
  const contractName = new Map((contracts ?? []).map((c) => [c.id, c.contract_name]));

  return {
    ok: true,
    data: (files ?? []).map((f) => ({
      id: f.id,
      filename: f.original_filename,
      contractId: f.contract_id,
      contractName: f.contract_id ? (contractName.get(f.contract_id) ?? null) : null,
      uploadStatus: f.upload_status,
      contentType: f.content_type,
      byteSize: f.byte_size,
      createdAt: f.created_at,
    })),
  };
}
