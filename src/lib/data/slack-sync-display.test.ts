import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { classifySlackSync, SLACK_SYNC_COPY } from "./slack-sync-display";

describe("classifySlackSync — identifies a connector-synced Slack app from non-secret markers", () => {
  it("is Slack-synced when external_instance_id is present AND vendor is Slack (case/space-insensitive)", () => {
    expect(classifySlackSync({ externalInstanceId: "T123", vendorName: "Slack" })).toEqual({ isSlackSynced: true, workspaceId: "T123" });
    expect(classifySlackSync({ externalInstanceId: "T123", vendorName: "slack" }).isSlackSynced).toBe(true);
    expect(classifySlackSync({ externalInstanceId: "  T9  ", vendorName: " SLACK " })).toEqual({ isSlackSynced: true, workspaceId: "T9" });
  });
  it("is NOT Slack-synced for a manual app (no external_instance_id) — even if vendor says Slack", () => {
    expect(classifySlackSync({ externalInstanceId: null, vendorName: "Slack" })).toEqual({ isSlackSynced: false, workspaceId: null });
    expect(classifySlackSync({ externalInstanceId: "", vendorName: "Slack" }).isSlackSynced).toBe(false);
    expect(classifySlackSync({ externalInstanceId: "   ", vendorName: "Slack" }).isSlackSynced).toBe(false);
  });
  it("is NOT Slack-synced when vendor is not Slack (another connector / null)", () => {
    expect(classifySlackSync({ externalInstanceId: "T1", vendorName: "Okta" }).isSlackSynced).toBe(false);
    expect(classifySlackSync({ externalInstanceId: "T1", vendorName: null }).isSlackSynced).toBe(false);
  });
  it("handles null/undefined input without crashing", () => {
    expect(classifySlackSync(null)).toEqual({ isSlackSynced: false, workspaceId: null });
    expect(classifySlackSync(undefined)).toEqual({ isSlackSynced: false, workspaceId: null });
  });
});

describe("SLACK_SYNC_COPY — read-only preview language, no false readiness, no secrets", () => {
  it("avoids every false-readiness CTA and exposes no token-shaped text", () => {
    const all = Object.values(SLACK_SYNC_COPY).join(" ").toLowerCase();
    for (const bad of ["connect slack", "run sync", "oauth ready", "oauth", "production connector ready", "xoxb"])
      expect(all, `copy must not contain "${bad}"`).not.toContain(bad);
    expect(all).toContain("read-only");
    expect(all).toContain("manual run coming next");
  });
});

describe("app detail page — read-only, no connect/sync CTA, no raw secret rendered (static scan)", () => {
  const page = fs.readFileSync(path.resolve(__dirname, "..", "..", "app", "(authenticated)", "apps", "[id]", "page.tsx"), "utf8");
  it("identifies Slack rows via the structural marker (classifySlackSync), not a display name alone", () => {
    expect(page).toContain("classifySlackSync");
  });
  it("renders NO active Slack connect / run-sync / OAuth CTA", () => {
    // an existing DISABLED "Connector sync — Not built yet" chip is allowed; an actionable connect/sync CTA is not.
    for (const bad of ["Connect Slack", "Run sync now", "Start sync", "Connect workspace", "oauth=success&connect"])
      expect(page).not.toContain(bad);
  });
  it("never renders raw_payload / source / token fields", () => {
    for (const bad of ["raw_payload", "rawPayload", "access_token", "xoxb", "Bearer "]) expect(page).not.toContain(bad);
  });
});
