import { describe, it, expect } from "vitest";
import {
  REAL_OKTA_CONNECTION_AVAILABLE, oktaCustomerStateLabel, oktaCustomerStateTone, oktaDisplayState,
  type OktaCustomerConnectionState,
} from "./okta-connection-labels";

// P5E18a Phase 14/19 — the real connection is unavailable; Okta shows as Preview; labels leak no internal wording.

const ALL: OktaCustomerConnectionState[] = [
  "preview", "real_not_available", "authorization_expired", "needs_attention", "reconnect_required",
  "ready_for_supervised_first_sync", "first_sync_awaiting_approval",
];

describe("okta customer connection labels", () => {
  it("the real connection is NOT available and Okta displays as Preview", () => {
    expect(REAL_OKTA_CONNECTION_AVAILABLE).toBe(false);
    expect(oktaDisplayState()).toBe("preview");
    expect(oktaCustomerStateLabel(oktaDisplayState())).toBe("Preview");
  });

  it("every state has a plain-language label + tone with NO internal governance wording", () => {
    const forbidden = ["certificationonly", "phase c", "risk-007", "risk 007", "ecs", "credential reference", "promotion", "oauth", "token", "pkce", "connector runner"];
    for (const s of ALL) {
      const label = oktaCustomerStateLabel(s).toLowerCase();
      expect(label.length).toBeGreaterThan(0);
      expect(["neutral", "attention", "success"]).toContain(oktaCustomerStateTone(s));
      for (const f of forbidden) expect(label.includes(f), `"${oktaCustomerStateLabel(s)}" leaked "${f}"`).toBe(false);
    }
  });

  it("exposes the exact customer-safe future-state labels the GO specifies", () => {
    expect(oktaCustomerStateLabel("real_not_available")).toBe("Real connection not yet available");
    expect(oktaCustomerStateLabel("authorization_expired")).toBe("Authorization expired");
    expect(oktaCustomerStateLabel("needs_attention")).toBe("Connection needs attention");
    expect(oktaCustomerStateLabel("reconnect_required")).toBe("Reconnect required");
    expect(oktaCustomerStateLabel("ready_for_supervised_first_sync")).toBe("Ready for supervised first sync");
    expect(oktaCustomerStateLabel("first_sync_awaiting_approval")).toBe("First sync awaiting approval");
  });
});
