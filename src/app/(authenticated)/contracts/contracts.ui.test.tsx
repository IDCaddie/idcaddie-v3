// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/contracts", () => ({ listContractsForCurrentUser: vi.fn() }));
let captured: { headers: string[]; rows: string[][]; filename: string } | null = null;
vi.mock("./export-csv-button", () => ({
  ExportCsvButton: (p: { headers: string[]; rows: string[][]; filename: string }) => {
    captured = p;
    return <button>Export CSV</button>;
  },
}));

import ContractsPage from "./page";
import { listContractsForCurrentUser } from "@/lib/data/contracts";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
// A renewal ~10 days out (relative to render time) so the ≤30d badge fires; no owner → chip; a value to format.
const soon = new Date();
soon.setDate(soon.getDate() + 10);
const soonStr = soon.toISOString().slice(0, 10);
afterEach(cleanup);

describe("/contracts render", () => {
  it("renders formatted value, a renewal badge, and a no-owner chip", async () => {
    asMock(listContractsForCurrentUser).mockResolvedValue({
      ok: true,
      data: [
        { id: "c1", contractName: "AWS EDP", vendorName: "AWS", status: "active", category: "Cloud", renewalDate: soonStr, endDate: null, totalCost: 25000, currency: "USD", hasOwner: false, renewalResponsibility: null },
      ],
    });
    render(await ContractsPage());
    expect(screen.getByText("AWS EDP")).toBeTruthy();
    expect(screen.getAllByText(/25,000/).length).toBeGreaterThan(0); // formatted value (KPI card + table cell)
    expect(screen.getByText("≤30d")).toBeTruthy(); // renewal attention badge
    expect(screen.getByText("no owner")).toBeTruthy(); // ownership chip
    // KPI summary row (computed from the already-fetched rows)
    expect(screen.getByText("Total contracts")).toBeTruthy();
    expect(screen.getByText("Tracked value")).toBeTruthy();
    expect(screen.getByText("Renewing soon")).toBeTruthy();
    expect(screen.getByText("Missing owner")).toBeTruthy();
  });

  it("renders the empty state", async () => {
    asMock(listContractsForCurrentUser).mockResolvedValue({ ok: true, data: [] });
    render(await ContractsPage());
    expect(screen.getByText("No contracts to show")).toBeTruthy();
  });

  it("hands the export button ONLY the allowed columns — no id/raw fields, hasOwner as Yes/No, value formatted", async () => {
    captured = null;
    asMock(listContractsForCurrentUser).mockResolvedValue({
      ok: true,
      data: [
        { id: "contract-uuid-1", contractName: "AWS EDP", vendorName: "AWS", status: "active", category: "Cloud", renewalDate: "2027-01-01", endDate: null, totalCost: 25000, currency: "USD", hasOwner: false, renewalResponsibility: "vendor" },
      ],
    });
    render(await ContractsPage());
    expect(captured).not.toBeNull();
    expect(captured!.headers).toEqual(["Name", "Vendor", "Status", "Category", "Renewal date", "End date", "Value", "Owner assigned"]);
    expect(captured!.filename).toBe("contracts-export.csv");
    expect(captured!.rows[0][0]).toBe("AWS EDP");
    expect(captured!.rows[0][6]).toMatch(/25,000/); // Value uses formatMoney
    expect(captured!.rows[0][7]).toBe("No"); // hasOwner → No
    expect(captured!.rows[0][5]).toBe(""); // null endDate → ""
    const cells = captured!.rows.flat();
    expect(cells).not.toContain("contract-uuid-1"); // no raw id
    expect(cells).not.toContain("vendor"); // renewalResponsibility is NOT exported (detail-only field)
  });

  it("renders NO export button when the list read fails (fail-safe)", async () => {
    captured = null;
    asMock(listContractsForCurrentUser).mockResolvedValue({ ok: false, error: "query_failed" });
    render(await ContractsPage());
    expect(screen.queryByText("Export CSV")).toBeNull();
  });
});
