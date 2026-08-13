// Phase 17D — which reader owns which RPC.
//
// 0089 exists because the SaaS accounts PAGE and the governance EVIDENCE WALK ask different questions. The page needs
// alphabetical order, an offset pager and a total; the walk needs every account exactly once, in immutable-id order.
// Pointing either at the other's contract is a silent regression that no type error would catch:
//
//   * UI -> governance RPC   = a customer gets UUID-ordered pages with no total (the 0061 mistake, again).
//   * governance -> UI RPC   = the walk goes back to a non-total ORDER BY over OFFSET, where a delete before the
//                              offset skips a surviving row and 0083 closes a finding that is still true.
//
// This is a static guard over the source text on purpose: the ownership is a fact about which module calls which name,
// and asserting it where it is written costs nothing and survives refactors that mocks would hide.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const UI = readFileSync("src/lib/data/saas-accounts.ts", "utf8");
const GOVERNANCE = readFileSync("src/lib/data/cross-source-governance-loader.ts", "utf8");

const UI_RPC = "product_app_accounts";
const GOVERNANCE_RPC = "product_app_accounts_for_governance";

describe("the SaaS accounts page keeps the display-ordered offset read", () => {
  it("calls the original RPC, not the governance cursor", () => {
    expect(UI).toContain(`"${UI_RPC}"`);
    expect(UI).not.toContain(GOVERNANCE_RPC);
  });

  it("still pages by offset and still asks for a total", () => {
    // `total` feeds the <Pager>; offset is how a human walks a table. Neither exists on the governance contract.
    expect(UI).toMatch(/p_offset:/);
    expect(UI).toMatch(/total/);
  });
});

describe("the governance evidence walk keeps the id cursor", () => {
  it("calls only the governance RPC for app accounts", () => {
    expect(GOVERNANCE).toContain(`"${GOVERNANCE_RPC}"`);
    // The UI name must not appear even as a substring match target: `product_app_accounts_for_governance` contains
    // `product_app_accounts`, so compare against the quoted call form the loader actually uses.
    expect(GOVERNANCE).not.toContain(`"${UI_RPC}"`);
  });

  it("uses no OFFSET anywhere in the governance read path", () => {
    expect(GOVERNANCE).not.toMatch(/p_offset/);
  });
});
