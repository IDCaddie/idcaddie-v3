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

  it("connected → status, data access, sync settings; first sync is disabled", () => {
    connect();
    render(<ConnectorStatusView connector={okta} />);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Data access")).toBeTruthy();
    expect(screen.getByText("Users")).toBeTruthy();
    // sync settings communicate nothing is live
    expect(screen.getByText("Never")).toBeTruthy();
    expect(screen.getByText("Not scheduled")).toBeTruthy();
    const firstSync = screen.getByRole("button", { name: "Run supervised first sync" });
    expect((firstSync as HTMLButtonElement).disabled).toBe(true);
  });

  it("Pause / Resume toggle only the preview state", () => {
    connect();
    render(<ConnectorStatusView connector={okta} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause connection" }));
    expect(getDemoConnection("okta")?.status).toBe("paused_preview");
    expect(screen.getByText("Paused")).toBeTruthy();
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
