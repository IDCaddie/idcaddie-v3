// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/audit", () => ({ listRecentAuditEntriesForCurrentUser: vi.fn() }));

import AuditPage from "./page";
import { listRecentAuditEntriesForCurrentUser } from "@/lib/data/audit";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
const ROW_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const data = [
  { id: ROW_UUID, action: "contract.created", resourceType: "contracts", createdAt: "2026-07-06T10:00:00Z", actorRecorded: true },
  { id: "r2", action: "app.viewed", resourceType: "apps", createdAt: "2026-07-05T09:00:00Z", actorRecorded: false },
];
afterEach(cleanup);

describe("/audit render", () => {
  it("renders the search box, filters, count, and rows (no raw id / JSON)", async () => {
    asMock(listRecentAuditEntriesForCurrentUser).mockResolvedValue({ ok: true, data });
    const { container } = render(await AuditPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByPlaceholderText("action or entity")).toBeTruthy();
    expect(screen.getByText("All actions")).toBeTruthy();
    expect(screen.getByText("All entities")).toBeTruthy();
    // query the TABLE CELL (the same text also appears as a <select> option, which is role "option", not "cell")
    expect(screen.getByRole("cell", { name: "contract.created" })).toBeTruthy();
    expect(screen.getByText(/2 of 2 recent/)).toBeTruthy();
    // regression: the row id is a key only — never rendered; no before/after JSON leaks
    expect(container.textContent).not.toContain(ROW_UUID);
    expect(container.textContent).not.toContain("before_json");
    expect(container.textContent).not.toContain("after_json");
  });

  it("shows the no-match state when a filter excludes everything", async () => {
    asMock(listRecentAuditEntriesForCurrentUser).mockResolvedValue({ ok: true, data });
    render(await AuditPage({ searchParams: Promise.resolve({ q: "zzznomatch" }) }));
    expect(screen.getByText("No audit events match these filters.")).toBeTruthy();
  });

  it("filters by entity via search params (only matching rows remain)", async () => {
    asMock(listRecentAuditEntriesForCurrentUser).mockResolvedValue({ ok: true, data });
    render(await AuditPage({ searchParams: Promise.resolve({ entity: "apps" }) }));
    // the apps row remains as a table cell; the contract row's cell is gone (its <option> may still exist)
    expect(screen.getByRole("cell", { name: "app.viewed" })).toBeTruthy();
    expect(screen.queryByRole("cell", { name: "contract.created" })).toBeNull();
  });

  it("shows the no-activity empty state when there are no entries at all", async () => {
    asMock(listRecentAuditEntriesForCurrentUser).mockResolvedValue({ ok: true, data: [] });
    render(await AuditPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText("No audit entries to show")).toBeTruthy();
  });
});
