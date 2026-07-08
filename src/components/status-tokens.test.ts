import { describe, it, expect } from "vitest";
import { statusColor } from "./status-tokens";

describe("statusColor", () => {
  it("maps the success statuses", () => {
    for (const s of ["active", "succeeded", "uploaded", "confirmed", "matched"]) expect(statusColor(s)).toBe("success");
  });
  it("maps the attention statuses", () => {
    for (const s of ["pending", "trial", "queued", "review"]) expect(statusColor(s)).toBe("attention");
  });
  it("maps the danger statuses", () => {
    for (const s of ["suspended", "expired", "failed", "error", "rejected", "revoked", "disabled"]) expect(statusColor(s)).toBe("danger");
  });
  it("is case-insensitive and trims whitespace", () => {
    expect(statusColor("ACTIVE")).toBe("success");
    expect(statusColor("  Failed ")).toBe("danger");
    expect(statusColor("Pending")).toBe("attention");
  });
  it("null / undefined / empty / unknown / anything unmapped → neutral, and never throws", () => {
    expect(statusColor(null)).toBe("neutral");
    expect(statusColor(undefined)).toBe("neutral");
    expect(statusColor("")).toBe("neutral");
    expect(statusColor("inactive")).toBe("neutral");
    expect(statusColor("archived")).toBe("neutral");
    expect(statusColor("wat-42!")).toBe("neutral");
    expect(() => statusColor("💥 nonsense")).not.toThrow();
  });
});
