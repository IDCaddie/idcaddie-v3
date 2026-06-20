import { describe, it, expect, vi, beforeEach } from "vitest";

// App-layer test for listFilesForCurrentUser + the pure status/size helpers. The DTO exposes ONLY safe
// fields — never storage_path, storage_bucket, the raw object name, sha256, tenant_id, uploaded_by, or
// a signed URL. DB-level tenant-scoping is the `files` SELECT RLS (is_tenant_member, 0013); this covers
// the safe-projection + assembly wiring.

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import { listFilesForCurrentUser, fileStatusLabel, formatFileSize } from "./files";

type TableData = { data: unknown[] | null; error: unknown };

// `.from(table).select(cols)` is awaitable directly (contracts) AND chainable with `.order()` (files).
function makeSupabase(byTable: Record<string, TableData>) {
  const query = (table: string) => {
    const result = byTable[table] ?? { data: [], error: null };
    const p = Promise.resolve(result);
    return {
      order: () => p,
      then: (...a: Parameters<Promise<TableData>["then"]>) => p.then(...a),
    };
  };
  return { from: (table: string) => ({ select: () => query(table) }) };
}

beforeEach(() => createClient.mockReset());

describe("fileStatusLabel", () => {
  it("formats uploaded / failed / pending", () => {
    expect(fileStatusLabel("uploaded")).toBe("Uploaded");
    expect(fileStatusLabel("failed")).toBe("Upload failed — not openable");
    expect(fileStatusLabel("pending")).toBe("Pending — not yet openable");
    expect(fileStatusLabel("anything-else")).toBe("Pending — not yet openable");
  });
});

describe("formatFileSize", () => {
  it("formats bytes / KB / MB and unknown", () => {
    expect(formatFileSize(null)).toBe("—");
    expect(formatFileSize(-1)).toBe("—");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(53826)).toBe("52.6 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("listFilesForCurrentUser", () => {
  it("assembles a SAFE DTO (no storage path/bucket/sha256/tenant_id/uploaded_by) + contract name", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        files: {
          data: [
            {
              id: "f1",
              contract_id: "c1",
              original_filename: "synthetic-test.pdf",
              upload_status: "uploaded",
              content_type: "application/pdf",
              byte_size: 53826,
              created_at: "2026-06-18T12:10:00Z",
              // Forbidden columns present in the source row to prove they never reach the DTO:
              tenant_id: "tttt",
              storage_path: "contracts/tttt/f1.pdf",
              storage_bucket: "contract-files",
              sha256: "deadbeef",
              uploaded_by: "uuuu",
            },
            {
              id: "f2",
              contract_id: null,
              original_filename: "orphan.pdf",
              upload_status: "pending",
              content_type: null,
              byte_size: null,
              created_at: "2026-06-17T00:00:00Z",
            },
          ],
          error: null,
        },
        contracts: { data: [{ id: "c1", contract_name: "Storage Test Contract A1" }], error: null },
      }),
    );

    const res = await listFilesForCurrentUser();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0]).toEqual({
      id: "f1",
      filename: "synthetic-test.pdf",
      contractId: "c1",
      contractName: "Storage Test Contract A1",
      uploadStatus: "uploaded",
      contentType: "application/pdf",
      byteSize: 53826,
      createdAt: "2026-06-18T12:10:00Z",
    });
    expect(res.data[1].contractName).toBeNull(); // no contract_id → no name, still listed

    // Exact safe key set; every forbidden internal provably absent.
    expect(Object.keys(res.data[0]).sort()).toEqual(
      ["byteSize", "contentType", "contractId", "contractName", "createdAt", "filename", "id", "uploadStatus"].sort(),
    );
    const flat = JSON.stringify(res.data);
    for (const forbidden of ["storage_path", "storageBucket", "storage_bucket", "sha256", "tenant_id", "uploaded_by", "deadbeef", "contracts/tttt"]) {
      expect(flat).not.toContain(forbidden);
    }
  });

  it("a file whose contract is not readable still lists (contractName null), not erased", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        files: { data: [{ id: "f1", contract_id: "cX", original_filename: "a.pdf", upload_status: "uploaded", content_type: null, byte_size: null, created_at: "2026-06-18T00:00:00Z" }], error: null },
        contracts: { data: [], error: null }, // contract not visible
      }),
    );
    const res = await listFilesForCurrentUser();
    expect(res.ok && res.data).toHaveLength(1);
    expect(res.ok && res.data[0].contractName).toBeNull();
    expect(res.ok && res.data[0].contractId).toBe("cX");
  });

  it("empty file list → empty result", async () => {
    createClient.mockResolvedValue(makeSupabase({ files: { data: [], error: null } }));
    expect(await listFilesForCurrentUser()).toEqual({ ok: true, data: [] });
  });

  it("a failed files read fails closed with a safe label", async () => {
    createClient.mockResolvedValue(makeSupabase({ files: { data: null, error: { message: "boom" } } }));
    expect(await listFilesForCurrentUser()).toEqual({ ok: false, error: "query_failed" });
  });
});
