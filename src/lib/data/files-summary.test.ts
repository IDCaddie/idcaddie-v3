import { describe, it, expect } from "vitest";
import { summarizeFiles } from "./files-summary";
import type { FileSummary } from "./files";

const row = (o: Partial<FileSummary>): FileSummary => ({
  id: "f",
  filename: "f.pdf",
  contractId: null,
  contractName: null,
  uploadStatus: "uploaded",
  contentType: "application/pdf",
  byteSize: 100,
  createdAt: "2026-07-01T00:00:00Z",
  ...o,
});

describe("summarizeFiles", () => {
  it("counts total + uploaded/pending/failed, sums size, counts distinct types", () => {
    const s = summarizeFiles([
      row({ uploadStatus: "uploaded", byteSize: 1000, contentType: "application/pdf" }),
      row({ uploadStatus: "uploaded", byteSize: 500, contentType: "image/png" }),
      row({ uploadStatus: "pending", byteSize: null, contentType: "application/pdf" }),
      row({ uploadStatus: "failed", byteSize: 200, contentType: null }),
    ]);
    expect(s.total).toBe(4);
    expect(s.uploaded).toBe(2);
    expect(s.pending).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.totalBytes).toBe(1700); // 1000 + 500 + 200; null skipped
    expect(s.distinctTypes).toBe(2); // pdf + png; null skipped
  });

  it("empty input → all zeros", () => {
    expect(summarizeFiles([])).toEqual({ total: 0, uploaded: 0, pending: 0, failed: 0, totalBytes: 0, distinctTypes: 0 });
  });

  it("null / negative byteSize is safe (skipped, no NaN)", () => {
    const s = summarizeFiles([row({ byteSize: null }), row({ byteSize: -5 }), row({ byteSize: 300 })]);
    expect(s.totalBytes).toBe(300);
    expect(Number.isNaN(s.totalBytes)).toBe(false);
  });
});
