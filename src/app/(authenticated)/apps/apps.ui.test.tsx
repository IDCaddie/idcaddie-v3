// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/apps", () => ({ listAppsWithCountsForCurrentUser: vi.fn() }));
// Capture what the page hands the export button — the pre-projected, safe export data (headers/rows only).
let captured: { headers: string[]; rows: string[][]; filename: string } | null = null;
vi.mock("./export-csv-button", () => ({
  ExportCsvButton: (p: { headers: string[]; rows: string[][]; filename: string }) => {
    captured = p;
    return <button>Export CSV</button>;
  },
}));

import AppsPage from "./page";
import { listAppsWithCountsForCurrentUser } from "@/lib/data/apps";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
const rows = [
  { id: "a1", name: "Figma", vendorName: "Figma Inc", category: "Design", status: "active", linkedContractCount: 0, appUserCount: 5, hasOwner: false },
  { id: "a2", name: "Slack", vendorName: "Salesforce", category: "Comms", status: "active", linkedContractCount: 2, appUserCount: 9, hasOwner: true },
];
afterEach(cleanup);

describe("/apps render", () => {
  it("renders search box, filter/sort controls, and per-row attention chips", async () => {
    asMock(listAppsWithCountsForCurrentUser).mockResolvedValue({ ok: true, data: rows });
    render(await AppsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByPlaceholderText("Search name or vendor")).toBeTruthy();
    expect(screen.getByText("Missing owner")).toBeTruthy();
    expect(screen.getByText("Missing contract")).toBeTruthy();
    expect(screen.getByText("Figma")).toBeTruthy();
    // Figma has no owner + no contract → both chips; Slack has neither chip.
    expect(screen.getByText("no owner")).toBeTruthy();
    expect(screen.getByText("no contract")).toBeTruthy();
  });

  it("shows the 'no match' empty state when a search excludes everything", async () => {
    asMock(listAppsWithCountsForCurrentUser).mockResolvedValue({ ok: true, data: rows });
    render(await AppsPage({ searchParams: Promise.resolve({ q: "zzzznomatch" }) }));
    expect(screen.getByText("No apps match your search/filters")).toBeTruthy();
  });

  it("applies the missing_contract filter (only apps with 0 contracts remain)", async () => {
    asMock(listAppsWithCountsForCurrentUser).mockResolvedValue({ ok: true, data: rows });
    render(await AppsPage({ searchParams: Promise.resolve({ filter: "missing_contract" }) }));
    expect(screen.getByText("Figma")).toBeTruthy();
    expect(screen.queryByText("Slack")).toBeNull();
  });

  it("hands the export button ONLY the allowed columns — no id/raw fields, hasOwner as Yes/No", async () => {
    captured = null;
    asMock(listAppsWithCountsForCurrentUser).mockResolvedValue({ ok: true, data: rows });
    render(await AppsPage({ searchParams: Promise.resolve({}) }));
    expect(captured).not.toBeNull();
    expect(captured!.headers).toEqual(["Name", "Vendor", "Category", "Status", "Linked contracts", "App users", "Owner assigned"]);
    expect(captured!.filename).toBe("apps-export.csv");
    // sorted by name → Figma, Slack; hasOwner → Yes/No; counts as strings
    expect(captured!.rows).toEqual([
      ["Figma", "Figma Inc", "Design", "active", "0", "5", "No"],
      ["Slack", "Salesforce", "Comms", "active", "2", "9", "Yes"],
    ]);
    // no raw id / owner id ever reaches the export
    const cells = captured!.rows.flat();
    expect(cells).not.toContain("a1");
    expect(cells).not.toContain("a2");
    for (const cell of cells) expect(cell).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // no UUID shape
  });

  it("renders NO export button when the list read fails (fail-safe)", async () => {
    captured = null;
    asMock(listAppsWithCountsForCurrentUser).mockResolvedValue({ ok: false, error: "query_failed" });
    render(await AppsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText("Export CSV")).toBeNull();
  });
});
