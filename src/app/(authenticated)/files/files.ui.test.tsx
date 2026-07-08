// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
// Stub only the DAL read; keep the pure fileStatusLabel/formatFileSize helpers real (no DB is hit — createClient is
// never called because listFilesForCurrentUser is mocked).
vi.mock("@/lib/data/files", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/files")>("@/lib/data/files");
  return { ...actual, listFilesForCurrentUser: vi.fn() };
});

import FilesPage from "./page";
import { listFilesForCurrentUser } from "@/lib/data/files";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
afterEach(cleanup);

const rows = [
  { id: "f1", filename: "invoice.pdf", contractId: "c1", contractName: "AWS EDP", uploadStatus: "uploaded", contentType: "application/pdf", byteSize: 1024, createdAt: "2026-07-01T00:00:00Z" },
  { id: "f2", filename: "broken.docx", contractId: null, contractName: null, uploadStatus: "failed", contentType: "application/msword", byteSize: null, createdAt: "2026-07-02T00:00:00Z" },
  { id: "f3", filename: "scan.png", contractId: null, contractName: null, uploadStatus: "pending", contentType: null, byteSize: 2048, createdAt: "2026-07-03T00:00:00Z" },
];
const render_ = (sp: Record<string, string | string[]> = {}) => FilesPage({ searchParams: Promise.resolve(sp) });

describe("/files render", () => {
  it("renders semantic status badges, KPI cards, search + filter + sort controls, and leaks no storage/secret fields", async () => {
    asMock(listFilesForCurrentUser).mockResolvedValue({ ok: true, data: rows });

    const { container } = render(await render_());
    const html = container.innerHTML;
    // uploaded → success (green), failed → danger (red), pending → attention (amber)
    expect(html).toContain("text-green-700");
    expect(html).toContain("text-red-700");
    expect(html).toContain("text-amber-700");
    // human status labels preserved inside the badges (also KPI + filter labels → multiple matches)
    expect(screen.getAllByText("Uploaded").length).toBeGreaterThan(0);
    expect(screen.getByText("application/pdf")).toBeTruthy();
    // KPI summary (over the shown rows)
    expect(screen.getByText("Total files")).toBeTruthy();
    expect(screen.getByText("Total size")).toBeTruthy();
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0); // KPI card + filter pill
    // search / filter / sort controls present
    expect(screen.getByPlaceholderText(/Search name/)).toBeTruthy();
    expect(screen.getByText("Has contract")).toBeTruthy();
    expect(screen.getByText("Newest")).toBeTruthy();
    expect(screen.getByText("Name A–Z")).toBeTruthy();

    // regression: no storage path / hash / raw tenant / uploader / connector secret leaks into the UI
    for (const forbidden of ["storage_path", "storage_bucket", "sha256", "tenant_id", "uploaded_by", "connector_secrets", "discovery_facts", "fact_json"]) {
      expect(container.textContent).not.toContain(forbidden);
      expect(html).not.toContain(forbidden);
    }
  });

  it("applies a status filter server-side over already-fetched rows (filter=failed → only the failed row)", async () => {
    asMock(listFilesForCurrentUser).mockResolvedValue({ ok: true, data: rows });
    render(await render_({ filter: "failed" }));
    expect(screen.getByText("broken.docx")).toBeTruthy();
    expect(screen.queryByText("invoice.pdf")).toBeNull();
    expect(screen.queryByText("scan.png")).toBeNull();
    expect(screen.getByText(/1 of 3 files/)).toBeTruthy();
  });

  it("shows a filter-aware empty state when nothing matches (distinct from the no-data state)", async () => {
    asMock(listFilesForCurrentUser).mockResolvedValue({ ok: true, data: rows });
    render(await render_({ q: "zzznomatch" }));
    expect(screen.getByText("No files match your search/filters")).toBeTruthy();
    expect(screen.getByText("clear them")).toBeTruthy();
    expect(screen.queryByText("invoice.pdf")).toBeNull();
  });

  it("shows the true no-data empty state when there are zero files", async () => {
    asMock(listFilesForCurrentUser).mockResolvedValue({ ok: true, data: [] });
    render(await render_());
    expect(screen.getByText("No files to show")).toBeTruthy();
  });
});
