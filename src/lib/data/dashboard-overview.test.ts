import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateSpend, bucketRenewals, formatMoney, type OverviewRow } from "./dashboard-overview";

// dashboard-overview.ts is PURE (no server imports), so it loads with no mock.
const row = (o: Partial<OverviewRow> & { id: string }): OverviewRow => ({
  contractName: `Contract ${o.id}`,
  vendorName: null,
  status: "active",
  totalCost: null,
  currency: "USD",
  renewalDate: null,
  endDate: null,
  noticeDeadline: null,
  ...o,
});
const NOW = new Date("2026-07-07T12:00:00Z"); // "today" = 2026-07-07 UTC

describe("aggregateSpend", () => {
  it("groups totals by currency and counts contracts with a cost, sorted by total desc", () => {
    const s = aggregateSpend([
      row({ id: "1", totalCost: 100, currency: "USD" }),
      row({ id: "2", totalCost: 200, currency: "USD" }),
      row({ id: "3", totalCost: 50, currency: "EUR" }),
      row({ id: "4", totalCost: null }), // no cost → ignored
    ]);
    expect(s.contractsWithCost).toBe(3);
    expect(s.byCurrency).toEqual([
      { currency: "USD", total: 300, contractCount: 2 },
      { currency: "EUR", total: 50, contractCount: 1 },
    ]);
  });

  it("buckets a null/blank currency under 'unspecified' and coerces string amounts", () => {
    const s = aggregateSpend([row({ id: "1", totalCost: "100.50" as unknown as number, currency: null })]);
    expect(s.byCurrency).toEqual([{ currency: "unspecified", total: 100.5, contractCount: 1 }]);
  });

  it("empty → no currencies, zero contracts with cost", () => {
    expect(aggregateSpend([])).toEqual({ byCurrency: [], contractsWithCost: 0 });
    expect(aggregateSpend([row({ id: "1", totalCost: null })])).toEqual({ byCurrency: [], contractsWithCost: 0 });
  });
});

describe("formatMoney", () => {
  it("formats a real currency, labels unspecified, and falls back for an invalid code", () => {
    expect(formatMoney(100, "USD")).toContain("100");
    expect(formatMoney(100, "unspecified")).toContain("currency unspecified");
    expect(formatMoney(100, "XX")).toContain("XX"); // invalid ISO → safe fallback, never throws
  });
});

describe("bucketRenewals", () => {
  it("categorizes due-30 / due-90 / missing, with end_date fallback and past dates excluded", () => {
    const b = bucketRenewals([
      row({ id: "d30", renewalDate: "2026-07-17" }), // +10d → due30
      row({ id: "d90", renewalDate: "2026-09-05" }), // ~+60d → due90
      row({ id: "far", renewalDate: "2027-02-01" }), // upcoming but neither bucket
      row({ id: "end", renewalDate: null, endDate: "2026-07-12" }), // +5d via end date → due30, basis "end"
      row({ id: "past", renewalDate: "2026-07-01" }), // -6d → excluded
      row({ id: "miss", renewalDate: null, endDate: null }), // → missing
    ], NOW);

    expect(b.due30.map((i) => i.id).sort()).toEqual(["d30", "end"]);
    expect(b.due90.map((i) => i.id)).toEqual(["d90"]);
    expect(b.missing).toBe(1);
    expect(b.due30.find((i) => i.id === "end")?.basis).toBe("end");
    expect(b.topUpcoming.map((i) => i.id)).not.toContain("past");
  });

  it("topUpcoming is soonest-first and capped at 5", () => {
    const rows = Array.from({ length: 8 }, (_, i) => row({ id: `r${i}`, renewalDate: `2026-08-${String(10 + i).padStart(2, "0")}` }));
    const b = bucketRenewals(rows, NOW);
    expect(b.topUpcoming).toHaveLength(5);
    expect(b.topUpcoming[0].id).toBe("r0"); // earliest date first
    expect(b.topUpcoming.every((it, i, a) => i === 0 || a[i - 1].daysUntil <= it.daysUntil)).toBe(true);
  });

  it("passes through notice_deadline when present", () => {
    const b = bucketRenewals([row({ id: "n", renewalDate: "2026-07-20", noticeDeadline: "2026-07-10" })], NOW);
    expect(b.topUpcoming[0].noticeDeadline).toBe("2026-07-10");
  });
});

describe("dashboard-overview — safety", () => {
  it("the loader + page reference no invoices/license/secret/discovery fields (comments stripped)", () => {
    const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const files = ["dashboard-overview-loader.ts", "dashboard-overview.ts", "../../app/(authenticated)/dashboards/page.tsx"];
    for (const rel of files) {
      const code = strip(readFileSync(join(__dirname, rel), "utf8"));
      for (const forbidden of ["invoices", "license_", "connector_secrets", "discovery_facts", "fact_json", "getSecretValue", "SERVICE_ROLE"]) {
        expect(code, `${rel} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
