// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/contracts", () => ({ getContractDetailForCurrentUser: vi.fn() }));
vi.mock("@/lib/data/contract-files", () => ({ listContractFilesForCurrentUser: vi.fn() }));
vi.mock("@/lib/data/links", () => ({ listAppsLinkedToContract: vi.fn() }));
vi.mock("./contract-files", () => ({ ContractFiles: () => <div data-testid="contract-files" /> }));
vi.mock("@/lib/data/organizations", () => ({ listOrganizationsForCurrentUser: vi.fn() }));
// Phase 10: the page now loads the commercial view. Mocked like every other loader here — without it the import chain reaches
// access-rpc-types, whose server-only sentinel throws under jsdom.
vi.mock("@/lib/data/commercial-loader", () => ({ loadContractCommercialView: vi.fn() }));

import ContractDetailPage from "./page";
import { loadContractCommercialView } from "@/lib/data/commercial-loader";
import { getContractDetailForCurrentUser } from "@/lib/data/contracts";
import { listContractFilesForCurrentUser } from "@/lib/data/contract-files";
import { listAppsLinkedToContract } from "@/lib/data/links";
import { listOrganizationsForCurrentUser } from "@/lib/data/organizations";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
const OWNER_UUID = "99999999-8888-7777-6666-555555555555";
// A contract with no purchased line: the commercial panel renders its "not recorded" copy and nothing numeric.
const EMPTY_COMMERCIAL = {
  ok: true,
  data: { reconciliations: [], findings: [], summary: { total: 0, bySeverity: { info: 0, low: 0, medium: 0, high: 0 }, annualOpportunityByCurrency: {} }, entitlementCount: 0, discoveredEvidenceReadable: true },
};
afterEach(cleanup);

// No renewal/end date + no owner + no linked app → missing-renewal, missing-owner, no-linked-app flags.
const detail = {
  ok: true,
  data: {
    id: "contract-uuid-xyz", contractName: "Acme MSA", vendorName: "Acme", status: "active",
    startDate: null, endDate: null, renewalDate: null, noticeDeadline: null,
    totalCost: 12000, currency: "USD", billingFrequency: null, renewalResponsibility: null,
    hasOwner: false, procurementOrgId: null, payingOrgId: null, category: null,
    procurementDate: null, notes: null, poNumber: null, autoRenew: false, monthToMonth: false,
    createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z",
  },
};

describe("/contracts/[id] render", () => {
  it("shows attention flags, formatted value, and Owner assigned = No, with no raw ids", async () => {
    asMock(getContractDetailForCurrentUser).mockResolvedValue(detail);
    asMock(listAppsLinkedToContract).mockResolvedValue({ ok: true, data: [] });
    asMock(listContractFilesForCurrentUser).mockResolvedValue({ ok: true, data: [] });
    asMock(listOrganizationsForCurrentUser).mockResolvedValue({ ok: true, data: [] });
    asMock(loadContractCommercialView).mockResolvedValue(EMPTY_COMMERCIAL);

    const { container } = render(await ContractDetailPage({ params: Promise.resolve({ id: "contract-uuid-xyz" }) }));
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("No renewal or end date")).toBeTruthy();
    expect(screen.getByText("No owner assigned")).toBeTruthy();
    expect(screen.getByText(/12,000/)).toBeTruthy(); // formatted total cost
    expect(screen.getByText("Owner assigned")).toBeTruthy();
    // regression: no raw contract/owner UUID leaks into the rendered UI
    expect(container.textContent).not.toContain(OWNER_UUID);
    expect(container.textContent).not.toContain("contract-uuid-xyz");
  });

  it("resolves procurement/paying org ids to NAMES when visible, 'Assigned' when not — never a raw UUID", async () => {
    const VISIBLE = "cccc1111-2222-3333-4444-555555555555";
    const HIDDEN = "dddd9999-8888-7777-6666-555555555555";
    asMock(getContractDetailForCurrentUser).mockResolvedValue({
      ok: true,
      data: { ...detail.data, procurementOrgId: VISIBLE, payingOrgId: HIDDEN },
    });
    asMock(listAppsLinkedToContract).mockResolvedValue({ ok: true, data: [] });
    asMock(listContractFilesForCurrentUser).mockResolvedValue({ ok: true, data: [] });
    asMock(listOrganizationsForCurrentUser).mockResolvedValue({ ok: true, data: [{ id: VISIBLE, name: "OMC Procurement" }] });
    asMock(loadContractCommercialView).mockResolvedValue(EMPTY_COMMERCIAL);

    const { container } = render(await ContractDetailPage({ params: Promise.resolve({ id: "contract-uuid-xyz" }) }));
    expect(screen.getByText("OMC Procurement")).toBeTruthy(); // procurement org visible → name
    expect(screen.getByText("Assigned")).toBeTruthy(); // paying org present but not visible → "Assigned"
    expect(container.textContent).not.toContain(VISIBLE);
    expect(container.textContent).not.toContain(HIDDEN);
  });
});
