// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
// Stub only the DAL reads; keep the pure connectorStatusLabel/runStatusLabel/slackRunStatusLabel helpers real.
vi.mock("@/lib/data/connectors", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/connectors")>("@/lib/data/connectors");
  return { ...actual, listConnectorsForCurrentUser: vi.fn() };
});
vi.mock("@/lib/data/manual-sync-runs", () => ({
  getLatestSlackSyncRunForCurrentTenant: vi.fn(),
  getSlackAppUserPresenceCountsForCurrentTenant: vi.fn(),
}));

import ConnectorsPage from "./page";
import { listConnectorsForCurrentUser } from "@/lib/data/connectors";
import {
  getLatestSlackSyncRunForCurrentTenant,
  getSlackAppUserPresenceCountsForCurrentTenant,
} from "@/lib/data/manual-sync-runs";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
afterEach(cleanup);

describe("/connectors render", () => {
  it("renders connector + Slack-sync statuses as shared badges, keeps safe readiness copy, leaks no secrets", async () => {
    asMock(listConnectorsForCurrentUser).mockResolvedValue({
      ok: true,
      data: [
        {
          id: "conn-1",
          provider: "slack",
          displayName: "Acme Slack",
          status: "active", // → success (green)
          safeScopes: ["users:read"],
          createdAt: "2026-07-01T00:00:00Z",
          lastRun: { status: "succeeded", completedAt: "2026-07-02T00:00:00Z", failureCode: null, failureLabel: null }, // → green
        },
      ],
    });
    asMock(getLatestSlackSyncRunForCurrentTenant).mockResolvedValue({
      ok: true,
      data: {
        status: "failed", // → danger (red)
        startedAt: "2026-07-02T00:00:00Z",
        finishedAt: "2026-07-02T00:05:00Z",
        errorCode: "auth_expired",
        failedStage: "auth",
        appUsersWritten: 0,
        peopleWritten: 0,
        matchesWritten: 0,
        skipped: 0,
        appUsersMarkedStale: 0,
      },
    });
    asMock(getSlackAppUserPresenceCountsForCurrentTenant).mockResolvedValue({ ok: true, data: { active: 5, stale: 2 } });

    const { container } = render(await ConnectorsPage());
    const html = container.innerHTML;

    // connector status + last-run status render as shared badges (green success tone)
    expect(html).toContain("text-green-700");
    // the Slack-sync run status now renders as a shared badge too (red danger tone), not the old monochrome pill
    expect(html).toContain("text-red-700");

    // safe readiness copy still present; the disabled "Not built yet" affordances remain
    expect(screen.getByText("Slack sync status")).toBeTruthy();
    expect(screen.getAllByText("Not built yet").length).toBeGreaterThan(0);

    // no run-sync / connect control introduced (page is fully read-only — no interactive buttons; the
    // "Disconnect / revoke" etc. are DISABLED "Not built yet" chips, which is correct and safe).
    expect(screen.queryByRole("button")).toBeNull();

    // no LEAKED credential/secret VALUE or field name. (The page legitimately says "credentials, tokens, secrets are
    // not shown here" in its disclaimer, so we assert on real leak-field identifiers — never in safe copy — not the
    // bare words.)
    for (const forbidden of ["connector_secrets", "ciphertext", "access_token", "refresh_token", "dek_wrapped", "getsecretvalue"]) {
      expect(container.textContent?.toLowerCase()).not.toContain(forbidden);
    }
  });
});
