"use server";

// Contract-file SERVER ACTIONS — the `"use server"` RPC boundary the contract detail file UI calls.
// Thin wrappers over the user-scoped server DAL (src/lib/data/contract-files.ts), where validation +
// server-side tenant resolution + the RLS/Storage-gated write + signed-URL generation live. The file
// bytes are read SERVER-SIDE here (file.arrayBuffer) so byteSize + magic header are measured from the
// real bytes, never a client-declared Content-Length. NEVER service-role; RLS + the storage.objects
// policies are the authorization boundary. A `"use server"` module exports only async functions.

import {
  uploadContractFileForCurrentUser,
  getContractFileDownloadUrlForCurrentUser,
  type ContractFileUploadResult,
  type ContractFileDownloadResult,
} from "@/lib/data/contract-files";

export async function uploadContractFileAction(
  contractId: string,
  formData: FormData,
): Promise<ContractFileUploadResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "invalid_file", reason: "empty_file" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  return uploadContractFileForCurrentUser({
    contractId,
    originalFilename: file.name,
    contentType: file.type,
    bytes,
  });
}

export async function getContractFileDownloadUrlAction(
  fileId: string,
): Promise<ContractFileDownloadResult> {
  return getContractFileDownloadUrlForCurrentUser(fileId);
}
