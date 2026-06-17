import { describe, it, expect } from "vitest";
import {
  validateContractPdf,
  buildContractFileObjectPath,
  sanitizeDisplayFilename,
  isUuid,
  CONTRACT_FILES_BUCKET,
  MAX_CONTRACT_FILE_BYTES,
  type PdfValidationInput,
} from "./pdf-validation";

const TENANT = "11111111-1111-1111-1111-111111111111";
const FILE_ID = "13000000-0000-0000-0000-0000000000f1";

// A well-formed PDF header ("%PDF-1.7" + bytes). validateContractPdf only inspects the first 5.
const pdfHeader = (extra = "1.7\n%abc") => new TextEncoder().encode("%PDF-" + extra);

function input(overrides: Partial<PdfValidationInput> = {}): PdfValidationInput {
  return {
    originalFilename: "Acme MSA.pdf",
    contentType: "application/pdf",
    byteSize: 1024,
    header: pdfHeader(),
    ...overrides,
  };
}

describe("validateContractPdf", () => {
  it("accepts a valid PDF and returns the sanitized display name + size", () => {
    const r = validateContractPdf(input());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.displayFilename).toBe("Acme MSA.pdf");
      expect(r.byteSize).toBe(1024);
    }
  });

  it("accepts application/pdf with content-type parameters", () => {
    expect(validateContractPdf(input({ contentType: "application/pdf; charset=binary" })).ok).toBe(true);
    expect(validateContractPdf(input({ contentType: "APPLICATION/PDF" })).ok).toBe(true);
  });

  it("rejects an invalid size (0 / negative / non-finite / fractional)", () => {
    expect(validateContractPdf(input({ byteSize: 0 }))).toEqual({ ok: false, error: "empty_file" });
    expect(validateContractPdf(input({ byteSize: -1 }))).toEqual({ ok: false, error: "empty_file" });
    expect(validateContractPdf(input({ byteSize: NaN }))).toEqual({ ok: false, error: "empty_file" });
    expect(validateContractPdf(input({ byteSize: Infinity }))).toEqual({ ok: false, error: "empty_file" });
    expect(validateContractPdf(input({ byteSize: 0.5 }))).toEqual({ ok: false, error: "empty_file" });
  });

  it("rejects an oversized file (> MAX_CONTRACT_FILE_BYTES)", () => {
    expect(validateContractPdf(input({ byteSize: MAX_CONTRACT_FILE_BYTES + 1 }))).toEqual({
      ok: false,
      error: "file_too_large",
    });
    // exactly at the cap is allowed
    expect(validateContractPdf(input({ byteSize: MAX_CONTRACT_FILE_BYTES })).ok).toBe(true);
  });

  it("rejects a wrong extension (not .pdf)", () => {
    expect(validateContractPdf(input({ originalFilename: "contract.docx" }))).toEqual({
      ok: false,
      error: "bad_extension",
    });
    expect(validateContractPdf(input({ originalFilename: "noext" }))).toEqual({
      ok: false,
      error: "bad_extension",
    });
    // a .pdf.exe double extension must NOT pass (final segment is .exe)
    expect(validateContractPdf(input({ originalFilename: "evil.pdf.exe" }))).toEqual({
      ok: false,
      error: "bad_extension",
    });
  });

  it("rejects a wrong MIME (even if extension + magic are fine)", () => {
    expect(validateContractPdf(input({ contentType: "application/octet-stream" }))).toEqual({
      ok: false,
      error: "bad_mime",
    });
    expect(validateContractPdf(input({ contentType: "image/png" }))).toEqual({
      ok: false,
      error: "bad_mime",
    });
  });

  it("rejects missing %PDF- magic bytes (a renamed non-PDF)", () => {
    expect(validateContractPdf(input({ header: new TextEncoder().encode("PK\x03\x04") }))).toEqual({
      ok: false,
      error: "bad_magic",
    });
    expect(validateContractPdf(input({ header: new Uint8Array([]) }))).toEqual({
      ok: false,
      error: "bad_magic",
    });
    // a header that contains %PDF- but not at the start is rejected
    expect(validateContractPdf(input({ header: new TextEncoder().encode("x%PDF-") }))).toEqual({
      ok: false,
      error: "bad_magic",
    });
  });

  it("enforces order: empty is reported before extension/mime/magic", () => {
    // empty + every other field also wrong -> still 'empty_file'
    expect(
      validateContractPdf({
        originalFilename: "bad.docx",
        contentType: "image/png",
        byteSize: 0,
        header: new Uint8Array([]),
      }),
    ).toEqual({ ok: false, error: "empty_file" });
  });
});

describe("sanitizeDisplayFilename", () => {
  it("strips directory components so a dangerous name is display-only", () => {
    expect(sanitizeDisplayFilename("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeDisplayFilename("a/b/c/Report.pdf")).toBe("Report.pdf");
    expect(sanitizeDisplayFilename("C:\\Windows\\evil.pdf")).toBe("evil.pdf");
  });

  it("strips control characters and trims", () => {
    expect(sanitizeDisplayFilename("  spaced.pdf  ")).toBe("spaced.pdf");
    expect(sanitizeDisplayFilename("tab\tname.pdf")).toBe("tabname.pdf"); // tab (0x09) stripped
    expect(sanitizeDisplayFilename("nl\nname.pdf")).toBe("nlname.pdf"); // newline (0x0a) stripped
  });
});

describe("buildContractFileObjectPath", () => {
  it("derives contracts/{tenant_id}/{file_id}.pdf from server UUIDs", () => {
    expect(buildContractFileObjectPath(TENANT, FILE_ID)).toBe(`contracts/${TENANT}/${FILE_ID}.pdf`);
  });

  it("lowercases UUID components for a stable path", () => {
    expect(buildContractFileObjectPath(TENANT.toUpperCase(), FILE_ID.toUpperCase())).toBe(
      `contracts/${TENANT}/${FILE_ID}.pdf`,
    );
  });

  it("a dangerous filename can never reach the path (path uses the file_id, not the name)", () => {
    const path = buildContractFileObjectPath(TENANT, FILE_ID);
    expect(path).not.toContain("passwd");
    expect(path).not.toContain("..");
    expect(path).toBe(`contracts/${TENANT}/${FILE_ID}.pdf`);
  });

  it("REJECTS a client-supplied non-UUID tenant/path/file id (traversal impossible)", () => {
    expect(() => buildContractFileObjectPath("../../other-tenant", FILE_ID)).toThrow();
    expect(() => buildContractFileObjectPath(TENANT, "../../../etc/passwd")).toThrow();
    expect(() => buildContractFileObjectPath("not-a-uuid", "also-not")).toThrow();
    expect(() => buildContractFileObjectPath(`contracts/${TENANT}/x`, FILE_ID)).toThrow();
    expect(() => buildContractFileObjectPath("", "")).toThrow();
  });
});

describe("constants / posture", () => {
  it("bucket is a stable private-bucket name and the cap is 25 MiB", () => {
    expect(CONTRACT_FILES_BUCKET).toBe("contract-files");
    expect(MAX_CONTRACT_FILE_BYTES).toBe(25 * 1024 * 1024);
  });

  it("isUuid guards path components", () => {
    expect(isUuid(TENANT)).toBe(true);
    expect(isUuid("../../x")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
