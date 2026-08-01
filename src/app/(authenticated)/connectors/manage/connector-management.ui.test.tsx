// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

// Phase 5 — Connector Management as the customer sees it.
//
// The property this page exists to protect: a retired directory must look RETIRED, not deleted. An operator who believes
// disconnect destroys their audit trail will leave a stale directory active instead, which is the worse outcome.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));
// Only the two loaders are mocked. The pure health derivation lives in ./connector-health and loads for real, so the reasons
// rendered on screen are the ones the product actually computes.
vi.mock("@/lib/data/connector-management", () => ({ loadConnectorManagement: vi.fn(), loadConnectorDetail: vi.fn() }));
vi.mock("./actions", () => ({ disconnectAction: vi.fn(), reconnectAction: vi.fn(), replaceAction: vi.fn() }));

import ManagePage from "./page";
import DetailPage from "./[id]/page";
import { loadConnectorManagement, loadConnectorDetail } from "@/lib/data/connector-management";
import { connectorHealth } from "@/lib/data/connector-health";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void; mock: { calls: unknown[][] } };
const CORP = "7d000000-0000-4000-8000-00000000c001";
const OLD = "7d000000-0000-4000-8000-00000000c003";

const conn = (o: Record<string, unknown> = {}) => ({
  id: CORP, provider: "okta", name: "Corporate", organization: "corp.okta.com",
  lifecycle: "discovered", lifecycleLabel: "Discovered",
  health: { state: "healthy", label: "Healthy", reason: "Verified and discovery has completed." },
  active: true, supersededBy: null, disconnectedAt: null, disconnectedReason: null,
  lastVerifiedAt: "2026-07-30T23:01:30Z", lastDiscoveryAt: "2026-07-31T17:19:51Z", createdAt: "2026-07-30T21:24:04Z",
  counts: { people: 12, groups: 7, applications: 3, memberships: 40, userAssignments: 9, groupAssignments: 5 }, ...o,
});
const mgmt = (connectors: unknown[]) => ({
  ok: true,
  data: { connectors, activeCount: connectors.filter((c) => (c as { active: boolean }).active).length,
          inactiveCount: connectors.filter((c) => !(c as { active: boolean }).active).length },
});

beforeEach(() => { vi.clearAllMocks(); asMock(loadConnectorManagement).mockResolvedValue(mgmt([conn()])); });
afterEach(cleanup);

describe("health is derived from evidence, with a stated reason", () => {
  it("never returns a state without a cause", () => {
    for (const r of [
      { lifecycle: "discovered", last_run_status: "succeeded", last_run_failure_code: null, last_discovery_at: "x" },
      { lifecycle: "verified", last_run_status: null, last_run_failure_code: null, last_discovery_at: null },
      { lifecycle: "failed", last_run_status: "failed", last_run_failure_code: "auth_rejected", last_discovery_at: null },
      { lifecycle: "disconnected", last_run_status: null, last_run_failure_code: null, last_discovery_at: null },
      { lifecycle: "superseded", last_run_status: null, last_run_failure_code: null, last_discovery_at: null },
    ]) {
      const h = connectorHealth(r);
      expect(h.reason.length, JSON.stringify(r)).toBeGreaterThan(10);
    }
  });

  it("says a retired directory is retained, not gone", () => {
    for (const l of ["disconnected", "superseded"]) {
      const h = connectorHealth({ lifecycle: l, last_run_status: null, last_run_failure_code: null, last_discovery_at: null });
      expect(h.state).toBe("inactive");
      expect(h.reason).toMatch(/retained/i);
    }
  });

  it("surfaces the bounded failure code rather than a provider error string", () => {
    const h = connectorHealth({ lifecycle: "failed", last_run_status: "failed", last_run_failure_code: "token_exchange_rejected", last_discovery_at: null });
    expect(h.reason).toContain("token exchange rejected");
  });
});

describe("the directories list", () => {
  it("shows each directory with its own counts", async () => {
    render(await ManagePage());
    expect(screen.getByRole("link", { name: "Corporate" }).getAttribute("href")).toBe(`/connectors/manage/${CORP}`);
    expect(screen.getByText("corp.okta.com")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
  });

  it("NEVER sums counts across organizations", async () => {
    // Two Okta organizations are two directories. A workspace total would be a number that is true of nothing.
    asMock(loadConnectorManagement).mockResolvedValue(mgmt([
      conn({ id: CORP, name: "Corporate", counts: { people: 12, groups: 7, applications: 3, memberships: 0, userAssignments: 0, groupAssignments: 0 } }),
      conn({ id: "7d000000-0000-4000-8000-00000000c002", name: "Subsidiary", organization: "sub.okta.com",
             counts: { people: 5, groups: 2, applications: 1, memberships: 0, userAssignments: 0, groupAssignments: 0 } }),
    ]));
    const { container } = render(await ManagePage());
    const text = container.textContent ?? "";
    expect(text).toContain("12");
    expect(text).toContain("5");
    expect(text, "17 would be a merged headcount").not.toContain("17");
    expect(container.textContent).toMatch(/separate organizations are never merged/i);
  });

  it("shows retired directories in their own section, and says nothing was deleted", async () => {
    asMock(loadConnectorManagement).mockResolvedValue(mgmt([
      conn(),
      conn({ id: OLD, name: "Old corp", active: false, lifecycle: "disconnected", lifecycleLabel: "Disconnected",
             disconnectedAt: "2026-07-31T00:00:00Z", disconnectedReason: "Office closed",
             health: { state: "inactive", label: "Disconnected", reason: "Retired by an operator. Its records and history are retained and excluded from active views." } }),
    ]));
    const { container } = render(await ManagePage());
    expect(screen.getByText("Retired (1)")).toBeTruthy();
    expect(container.textContent).toMatch(/retained —\s*they are excluded from active views, not deleted/i);
    expect(container.textContent).toMatch(/can be reconnected at any time/i);
  });

  it("does not offer a scoped access link for a retired directory", async () => {
    asMock(loadConnectorManagement).mockResolvedValue(mgmt([
      conn({ id: OLD, name: "Old corp", active: false, lifecycle: "disconnected", lifecycleLabel: "Disconnected",
             health: { state: "inactive", label: "Disconnected", reason: "Retired." } }),
    ]));
    const { container } = render(await ManagePage());
    expect([...container.querySelectorAll("a")].some((a) => (a.getAttribute("href") ?? "").startsWith("/access?connection="))).toBe(false);
    // Phase 5B replaced the "Excluded" placeholder with real actions: a retired directory can be opened, its history read, and
    // it can be reconnected.
    expect(screen.getByRole("link", { name: "Open" })).toBeTruthy();
    expect(screen.getByText("Reconnect")).toBeTruthy();
    expect(container.textContent).toMatch(/records, runs and audit history are retained/i);
  });

  it("says so when every directory has been retired", async () => {
    asMock(loadConnectorManagement).mockResolvedValue(mgmt([conn({ active: false, lifecycle: "disconnected", lifecycleLabel: "Disconnected", health: { state: "inactive", label: "Disconnected", reason: "Retired." } })]));
    const { container } = render(await ManagePage());
    expect(container.textContent).toMatch(/No active directory/i);
    expect(container.textContent).toMatch(/identity surfaces are empty/i);
  });

  it("reports forbidden and read failure differently, leaking nothing", async () => {
    asMock(loadConnectorManagement).mockResolvedValue({ ok: false, error: "forbidden" });
    render(await ManagePage()); expect(screen.getByText("Not available")).toBeTruthy(); cleanup();
    asMock(loadConnectorManagement).mockResolvedValue({ ok: false, error: "query_failed" });
    const { container } = render(await ManagePage());
    expect(screen.getByText("Could not load")).toBeTruthy();
    expect(container.textContent).not.toMatch(/query_failed|relation|SQLSTATE/i);
  });
});

describe("directory detail", () => {
  const detail = (c: unknown, runs: unknown[] = []) => ({ ok: true, data: { connector: c, runs } });
  const params = Promise.resolve({ id: CORP });

  beforeEach(() => asMock(loadConnectorDetail).mockResolvedValue(detail(conn())));

  it("links its counts to the SCOPED directory surfaces", async () => {
    const { container } = render(await DetailPage({ params }));
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    for (const p of ["/directory/people", "/directory/groups", "/directory/applications"]) {
      expect(hrefs.some((h) => h === `${p}?connection=${CORP}`), `${p} must be scoped to this directory`).toBe(true);
    }
  });

  it("renders discovery history including why a run changed nothing", async () => {
    asMock(loadConnectorDetail).mockResolvedValue(detail(conn(), [
      { id: "r1", started_at: "2026-07-31T10:00:00Z", completed_at: null, status: "succeeded", failure_code: null,
        records_seen: 12, records_imported: 12, records_failed: 0, completeness: false, termination_reason: "page_budget", review_required: true },
    ]));
    const { container } = render(await DetailPage({ params }));
    expect(screen.getByText("Incomplete")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(container.textContent).toContain("page budget");
    expect(container.textContent).toMatch(/retained permanently, including for disconnected and replaced/i);
  });

  it("offers disconnect and replace on an active directory, reconnect on a retired one", async () => {
    const { container: a } = render(await DetailPage({ params }));
    expect(within(a).getByText("Disconnect this directory")).toBeTruthy();
    expect(within(a).getByText("Replace this directory")).toBeTruthy();
    expect(within(a).queryByText("Reconnect this directory")).toBeNull();
    cleanup();

    asMock(loadConnectorDetail).mockResolvedValue(detail(conn({ active: false, lifecycle: "disconnected", lifecycleLabel: "Disconnected", disconnectedReason: "Office closed" })));
    const { container: b } = render(await DetailPage({ params }));
    expect(within(b).getByText("Reconnect this directory")).toBeTruthy();
    expect(within(b).queryByText("Disconnect this directory")).toBeNull();
    expect(b.textContent).toContain("Office closed");
  });

  it("requires a reason before retiring anything", async () => {
    const { container } = render(await DetailPage({ params }));
    const reason = container.querySelector('input[name="reason"]') as HTMLInputElement;
    expect(reason.required, "a decision someone must explain later cannot be unexplained").toBe(true);
  });

  it("states every disconnect consequence, so the operator does not have to guess", async () => {
    // Guesses about what disconnect destroys are what stop people using it — leaving a stale directory active instead.
    const { container } = render(await DetailPage({ params }));
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    for (const claim of [
      /Future verification and discovery are disabled/i,
      /leaves Home, Directory, Access and Findings/i,
      /no provider-side object is touched/i,
      /people, groups and applications are retained/i,
      /discovery runs and audit history are retained/i,
      /reconnect it at any time. Nothing is deleted/i,
    ]) expect(text, String(claim)).toMatch(claim);
    // And an explicit confirmation, not just a button.
    expect(container.querySelector('input[type="checkbox"][required]')).toBeTruthy();
  });

  it("distinguishes replace from disconnect, so neither is used for the other", async () => {
    // Needs a candidate, otherwise the form renders its "nothing to replace with" variant.
    asMock(loadConnectorManagement).mockResolvedValue(mgmt([conn(), conn({ id: "7d000000-0000-4000-8000-00000000c002", name: "New corp" })]));
    const { container } = render(await DetailPage({ params }));
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toMatch(/same organization/i);
    // Replacing two DIFFERENT organizations would hide a directory that is still real, so the form says which action to use.
    expect(text).toMatch(/different organizations, disconnect instead/i);
    expect(container.querySelector('select[name="replacementId"]')).toBeTruthy();
  });

  it("offers no replacement when there is no other active directory of the same provider", async () => {
    asMock(loadConnectorManagement).mockResolvedValue(mgmt([conn()]));   // only itself
    const { container } = render(await DetailPage({ params }));
    expect(container.textContent).toMatch(/no other active okta directory/i);
    expect(container.querySelector('select[name="replacementId"]')).toBeNull();
  });

  it("points a replaced directory at its successor instead of offering actions", async () => {
    asMock(loadConnectorDetail).mockResolvedValue(detail(conn({ active: false, lifecycle: "superseded", lifecycleLabel: "Replaced", supersededBy: OLD })));
    const { container } = render(await DetailPage({ params }));
    expect(screen.getByRole("link", { name: "Open the replacement" }).getAttribute("href")).toBe(`/connectors/manage/${OLD}`);
    expect(within(container).queryByText("Disconnect this directory")).toBeNull();
    expect(within(container).queryByText("Reconnect this directory")).toBeNull();
  });

  it("collapses missing and foreign into one not-found answer", async () => {
    asMock(loadConnectorDetail).mockResolvedValue({ ok: false, error: "not_found" });
    const { container } = render(await DetailPage({ params }));
    expect(screen.getByText("Not found")).toBeTruthy();
    expect(container.textContent).not.toMatch(/another tenant|supersed|deleted/i);
  });
});
