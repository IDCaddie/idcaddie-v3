import { describe, it, expect } from "vitest";
import { filterSortFiles, isFileFilter, isFileSort } from "./files-inventory";
import type { FileSummary } from "./files";

const row = (o: Partial<FileSummary>): FileSummary => ({
  id: "f",
  filename: "doc.pdf",
  contractId: null,
  contractName: null,
  uploadStatus: "uploaded",
  contentType: "application/pdf",
  byteSize: 100,
  createdAt: "2026-07-01T00:00:00Z",
  ...o,
});

const a = row({ id: "a", filename: "AWS invoice.pdf", contractId: "c1", contractName: "AWS EDP", uploadStatus: "uploaded", contentType: "application/pdf", byteSize: 3000, createdAt: "2026-07-03T00:00:00Z" });
const b = row({ id: "b", filename: "notes.txt", contractId: null, contractName: null, uploadStatus: "pending", contentType: "text/plain", byteSize: 500, createdAt: "2026-07-01T00:00:00Z" });
const c = row({ id: "c", filename: "broken.docx", contractId: "c9", contractName: "Acme MSA", uploadStatus: "failed", contentType: "application/msword", byteSize: null, createdAt: "2026-07-02T00:00:00Z" });
const rows = [a, b, c];
const ids = (rs: FileSummary[]) => rs.map((r) => r.id);

describe("filterSortFiles — search", () => {
  it("matches filename, contract name, content type, and status (case-insensitive)", () => {
    expect(ids(filterSortFiles(rows, { q: "aws" }))).toEqual(["a"]); // filename + contract
    expect(ids(filterSortFiles(rows, { q: "acme" }))).toEqual(["c"]); // contract name
    expect(ids(filterSortFiles(rows, { q: "text/plain" }))).toEqual(["b"]); // content type
    expect(ids(filterSortFiles(rows, { q: "failed" }))).toEqual(["c"]); // upload status
    expect(ids(filterSortFiles(rows, { q: "zzz" }))).toEqual([]); // no match
  });
});

describe("filterSortFiles — filters", () => {
  it("status filters (OR among selected)", () => {
    expect(ids(filterSortFiles(rows, { filters: ["uploaded"], sort: "name" }))).toEqual(["a"]);
    expect(new Set(ids(filterSortFiles(rows, { filters: ["pending", "failed"] })))).toEqual(new Set(["b", "c"]));
  });
  it("linked-contract filters", () => {
    expect(new Set(ids(filterSortFiles(rows, { filters: ["has_contract"] })))).toEqual(new Set(["a", "c"]));
    expect(ids(filterSortFiles(rows, { filters: ["no_contract"] }))).toEqual(["b"]);
  });
  it("search + filter combine (AND)", () => {
    expect(ids(filterSortFiles(rows, { q: "a", filters: ["uploaded"] }))).toEqual(["a"]);
  });
});

describe("filterSortFiles — sort", () => {
  it("newest / oldest by created date", () => {
    expect(ids(filterSortFiles(rows, { sort: "newest" }))).toEqual(["a", "c", "b"]);
    expect(ids(filterSortFiles(rows, { sort: "oldest" }))).toEqual(["b", "c", "a"]);
  });
  it("largest / smallest by size (null size sorts smallest)", () => {
    expect(ids(filterSortFiles(rows, { sort: "largest" }))).toEqual(["a", "b", "c"]);
    expect(ids(filterSortFiles(rows, { sort: "smallest" }))).toEqual(["c", "b", "a"]);
  });
  it("name A–Z by filename", () => {
    expect(ids(filterSortFiles(rows, { sort: "name" }))).toEqual(["a", "c", "b"]);
  });
  it("does not mutate the input array", () => {
    const before = ids(rows);
    filterSortFiles(rows, { sort: "largest" });
    expect(ids(rows)).toEqual(before);
  });
  it("empty input → []", () => {
    expect(filterSortFiles([], { q: "x", sort: "newest" })).toEqual([]);
  });
});

describe("guards", () => {
  it("isFileFilter / isFileSort", () => {
    expect(isFileFilter("uploaded")).toBe(true);
    expect(isFileFilter("nope")).toBe(false);
    expect(isFileSort("largest")).toBe(true);
    expect(isFileSort("nope")).toBe(false);
  });
});
