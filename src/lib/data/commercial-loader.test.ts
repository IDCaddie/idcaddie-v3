import { describe, it, expect } from "vitest";
import { provisionedCapabilityFor } from "./commercial-loader";
import type { ConnectorSummary } from "./connector-management";

// Review of PR #409 — the guard that stops a connector answering a question it cannot answer.
//
// This is the false-savings path: resolving `app_accounts` across the WHOLE workspace let a Slack connector's
// capability vouch for a line that had declared an OKTA connector. The counts RPC, correctly scoped to the Okta
// connection, then returned 0 rows — and 0 provisioned against 3,200 purchased offers the entire contract as a saving.

const connector = (over: Partial<ConnectorSummary> = {}): ConnectorSummary => ({
  id: "conn-1", provider: "slack", name: "Slack", organization: null,
  lifecycle: "discovered", lifecycleLabel: "Discovered",
  health: { state: "healthy", reason: "" } as ConnectorSummary["health"],
  active: true, supersededBy: null, disconnectedAt: null, disconnectedReason: null,
  lastVerifiedAt: null, lastDiscoveryAt: null, createdAt: null,
  counts: { people: 0, groups: 0, applications: 0, memberships: 0, userAssignments: 0, groupAssignments: 0 },
  ...over,
});

describe("provisionedCapabilityFor", () => {
  it("answers for a Slack connector, which implements app_accounts", () => {
    const s = provisionedCapabilityFor(connector(), false);
    expect(s.state).toBe("available");
    expect(s.connectorId).toBe("conn-1");
  });

  it("REFUSES to answer for an Okta connector, whose provider does not implement app_accounts", () => {
    // The bug this pins: Okta declares app_accounts as `planned`, so it can never contribute an account count. Before
    // the fix a healthy Slack connector elsewhere in the workspace made this read "available".
    const s = provisionedCapabilityFor(connector({ id: "conn-okta", provider: "okta", name: "Okta" }), false);
    expect(s.state).not.toBe("available");
    expect(s.state).not.toBe("stale");
    expect(s.explanation.length).toBeGreaterThan(0);
  });

  it("refuses for an unresolvable connection id — superseded, disconnected, or hidden from this reader", () => {
    const s = provisionedCapabilityFor(undefined, false);
    expect(s.state).not.toBe("available");
    expect(s.state).not.toBe("stale");
  });

  it("refuses for an inactive connector rather than reading its retained rows as current", () => {
    const s = provisionedCapabilityFor(connector({ active: false }), false);
    expect(s.state).not.toBe("available");
  });

  it("reports a failed connector read as unknown, never as 'not connected'", () => {
    // "We could not look" and "there is nothing to look at" are different answers; only the second would send someone
    // to connect something they already have.
    const s = provisionedCapabilityFor(connector(), true);
    expect(s.state).toBe("unknown");
    expect(s.explanation.toLowerCase()).toContain("not a statement");
  });
});
