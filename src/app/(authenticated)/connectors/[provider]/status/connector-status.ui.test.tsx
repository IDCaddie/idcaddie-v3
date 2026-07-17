// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { CustomerConnector } from "@/lib/customer-connectors/catalog-types";

// P5E17 — the connection MANAGEMENT view. Proves: not-connected empty state; connected state shows data access + sync
// settings (never scheduled / never synced); "Run supervised first sync" is DISABLED; Pause / Resume / Disconnect mutate
// ONLY the sessionStorage preview state; nothing here can launch a sync or schedule.
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));

import { ConnectorStatusView } from "./connector-status-view";
import { setDemoConnection, getDemoConnection } from "@/lib/customer-connectors/demo-store";

const okta: CustomerConnector = {
  provider: "okta", displayName: "Okta", category: "Identity", description: "d", availability: "preview",
  connectionStatus: "not_connected", capabilities: ["Users"], setupTime: "About 2 minutes", isPreview: true,
  canConnect: true, canSync: false, canSchedule: false, icon: { initial: "O", tint: "sky" },
};
const connect = () => setDemoConnection("okta", { status: "connected_preview", orgHost: "acme.okta.com", connectedAt: "2026-07-17T00:00:00Z" });

beforeEach(() => { window.sessionStorage.clear(); push.mockClear(); });
afterEach(cleanup);

describe("connector status / management", () => {
  it("not connected → empty state with a Connect CTA", () => {
    render(<ConnectorStatusView connector={okta} />);
    expect(screen.getByText("Okta is not connected")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect Okta" }).getAttribute("href")).toBe("/connectors/okta/connect");
  });

  it("connected → summary, sections, and a disabled first-sync with explanation", () => {
    connect();
    render(<ConnectorStatusView connector={okta} />);
    // "Connected" appears in the badge AND the Connection-status section — both are expected
    expect(screen.getAllByText("Connected").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Ready for a supervised first sync")).toBeTruthy(); // summary line
    expect(screen.getByText("Data access")).toBeTruthy();
    expect(screen.getByText("Account status")).toBeTruthy();
    expect(screen.getByText("Basic profile information")).toBeTruthy();
    // sync section communicates nothing is live / scheduled
    expect(screen.getByText("Not started")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
    expect(screen.getByText("Unavailable during preview")).toBeTruthy();
    // first sync is aria-disabled (NOT native disabled, so it stays focusable) + a discoverable explanation via aria-describedby
    const firstSync = screen.getByRole("button", { name: "Run supervised first sync" });
    expect(firstSync.getAttribute("aria-disabled")).toBe("true");
    expect((firstSync as HTMLButtonElement).disabled).toBe(false); // focusable → explanation is reachable
    const noteId = firstSync.getAttribute("aria-describedby");
    expect(noteId && document.getElementById(noteId)?.textContent).toMatch(/isn’t available yet/);
  });

  it("Pause / Resume toggle only the preview state", () => {
    connect();
    render(<ConnectorStatusView connector={okta} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause connection" }));
    expect(getDemoConnection("okta")?.status).toBe("paused_preview");
    expect(screen.getAllByText("Paused").length).toBeGreaterThanOrEqual(1); // badge + status section
    fireEvent.click(screen.getByRole("button", { name: "Resume connection" }));
    expect(getDemoConnection("okta")?.status).toBe("connected_preview");
  });

  it("Disconnect clears only the preview state (no server call)", () => {
    connect();
    render(<ConnectorStatusView connector={okta} />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(getDemoConnection("okta")).toBeNull();
    expect(screen.getByText("Okta disconnected")).toBeTruthy();
  });

  it("Reconnect routes back into the simulated wizard", () => {
    connect();
    render(<ConnectorStatusView connector={okta} />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(push).toHaveBeenCalledWith("/connectors/okta/connect");
  });
});
