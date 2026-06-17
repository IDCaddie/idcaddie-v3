// Pure, IO-free server-side validation + storage-path helpers for the contract-file (PDF) upload path.
// NO Supabase, NO next/headers, NO DB, NO network — so it is fully unit-testable (pdf-validation.test.ts),
// the same pure/IO split as contract-write.ts (pure) vs the future upload action (IO).
//
// SECURITY POSTURE (docs/16 §3/§4, docs/19, docs/20):
//   * These helpers DO NOT authorize. Postgres RLS (the 0013 `files` INSERT policy = contract-write
//     authority) + the future Storage object policy are the authorization boundaries. These only shape +
//     validate bytes at the trust boundary and DERIVE the storage path server-side.
//   * The storage path is ALWAYS server-derived from a resolved tenant_id + a server-issued file_id —
//     never client-controlled. `buildContractFileObjectPath` rejects any non-UUID component, so a
//     traversal/poisoned value (e.g. "../../etc") can never become a path.
//   * The original filename is display metadata ONLY. It is never used for the path or any security
//     decision. `sanitizeDisplayFilename` produces a safe label; the path uses the file_id, not the name.
//   * `byteSize` and the magic-byte `header` must be measured SERVER-SIDE from the actual uploaded bytes,
//     never trusted from a client-declared Content-Length / content-type alone.
//
// Bucket is a single PRIVATE Supabase Storage bucket (no public bucket, no public URL). The bucket
// itself + its object RLS policies live in the Supabase `storage` schema, which the local migration/test
// harness (plain postgres:16 + an `auth` shim) cannot host — so they are NOT created here and are
// applied + tested via the hosted path (docs/20). This module is the locally-testable core those use.

// A single private bucket for contract documents. The object path namespaces by tenant within it.
export const CONTRACT_FILES_BUCKET = "contract-files";

// Max accepted contract-file size (server-enforced from the real byte count). 25 MiB (docs/16 §3).
export const MAX_CONTRACT_FILE_BYTES = 25 * 1024 * 1024;

// The PDF magic-byte header. Every real PDF starts with these 5 bytes: "%PDF-".
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // % P D F -

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// Caller-safe rejection reasons. Stable labels (no path/byte details leak to the caller).
export type PdfValidationError =
  | "empty_file"
  | "file_too_large"
  | "bad_extension"
  | "bad_mime"
  | "bad_magic";

export type PdfValidationInput = {
  // Display name from the client — NEVER trusted for path/security; only its extension is checked.
  originalFilename: string;
  // The HTTP content type the client declared — checked, but never sufficient on its own (magic bytes are).
  contentType: string;
  // The ACTUAL byte length, measured server-side from the uploaded bytes (not a client Content-Length).
  byteSize: number;
  // At least the first 5 bytes of the ACTUAL uploaded file, read server-side (for the magic-byte check).
  header: Uint8Array;
};

export type PdfValidationResult =
  | { ok: true; displayFilename: string; byteSize: number }
  | { ok: false; error: PdfValidationError };

// Strip any directory components + control chars from a client filename so it is safe to STORE/DISPLAY
// as metadata. This value is NEVER used to build the storage path or make a security decision.
export function sanitizeDisplayFilename(name: string): string {
  const base =
    String(name)
      .replace(/[\\/]+/g, "/") // normalize separators
      .split("/")
      .pop() ?? ""; // keep only the final segment — no directory traversal survives
  // strip ASCII control chars (0x00-0x1F, 0x7F) so the stored display name is safe
  return base.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 255);
}

function hasPdfExtension(name: string): boolean {
  return sanitizeDisplayFilename(name).toLowerCase().endsWith(".pdf");
}

// content-type may carry params (e.g. "application/pdf; charset=binary") — compare the media type only.
function isPdfMime(contentType: string): boolean {
  return String(contentType).split(";")[0].trim().toLowerCase() === "application/pdf";
}

function startsWithPdfMagic(header: Uint8Array): boolean {
  if (header.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (header[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

// Validate a candidate contract PDF at the server trust boundary. Order: non-empty -> size -> extension
// -> MIME -> magic bytes. Returns a caller-safe result; on success, the sanitized display filename + size.
export function validateContractPdf(input: PdfValidationInput): PdfValidationResult {
  const { originalFilename, contentType, byteSize, header } = input;

  // byteSize must be a positive INTEGER (it is the actual server-measured byte count). Number.isInteger
  // also rejects NaN/Infinity/fractional values.
  if (!Number.isInteger(byteSize) || byteSize <= 0) return { ok: false, error: "empty_file" };
  if (byteSize > MAX_CONTRACT_FILE_BYTES) return { ok: false, error: "file_too_large" };
  if (!hasPdfExtension(originalFilename)) return { ok: false, error: "bad_extension" };
  if (!isPdfMime(contentType)) return { ok: false, error: "bad_mime" };
  if (!startsWithPdfMagic(header)) return { ok: false, error: "bad_magic" };

  return { ok: true, displayFilename: sanitizeDisplayFilename(originalFilename), byteSize };
}

// Build the SERVER-DERIVED object path inside CONTRACT_FILES_BUCKET: `contracts/{tenant_id}/{file_id}.pdf`.
// Both components MUST be server-issued UUIDs (tenant from resolved context, file_id a fresh UUID). Any
// non-UUID input is rejected — a client-supplied tenant/path/filename can never reach the path. This is a
// programmer/abuse guard, so it THROWS rather than returning a label (the server controls these inputs).
export function buildContractFileObjectPath(tenantId: string, fileId: string): string {
  if (!isUuid(tenantId) || !isUuid(fileId)) {
    throw new Error("buildContractFileObjectPath: tenantId and fileId must be server-issued UUIDs");
  }
  return `contracts/${tenantId.toLowerCase()}/${fileId.toLowerCase()}.pdf`;
}
