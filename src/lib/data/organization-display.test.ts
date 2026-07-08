import { describe, it, expect } from "vitest";
import { buildOrgNameLookup, orgDisplayName } from "./organization-display";

describe("orgDisplayName", () => {
  const lookup = buildOrgNameLookup([
    { id: "o1", name: "Flywheel" },
    { id: "o2", name: "OMC" },
  ]);

  it("returns the org NAME for an id visible to the caller", () => {
    expect(orgDisplayName("o1", lookup)).toBe("Flywheel");
    expect(orgDisplayName("o2", lookup)).toBe("OMC");
  });
  it("returns 'Assigned' for an id present but NOT in the visible set (never the raw id)", () => {
    expect(orgDisplayName("11111111-2222-3333-4444-555555555555", lookup)).toBe("Assigned");
  });
  it("returns '—' for null / undefined", () => {
    expect(orgDisplayName(null, lookup)).toBe("—");
    expect(orgDisplayName(undefined, lookup)).toBe("—");
  });
  it("an empty lookup (org read failed/empty) → present ids fall back to 'Assigned', null → '—'", () => {
    const empty = buildOrgNameLookup([]);
    expect(orgDisplayName("o1", empty)).toBe("Assigned");
    expect(orgDisplayName(null, empty)).toBe("—");
  });
});
