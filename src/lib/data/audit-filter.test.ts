import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterAuditEntries, auditFacets, parseAuditDays } from "./audit-filter";
import type { AuditEntry } from "./audit";

const NOW = new Date("2026-07-07T12:00:00Z");
const entry = (o: Partial<AuditEntry> & { id: string }): AuditEntry => ({
  action: "contract.created",
  resourceType: "contracts",
  createdAt: "2026-07-06T10:00:00Z",
  actorRecorded: true,
  ...o,
});
const rows: AuditEntry[] = [
  entry({ id: "1", action: "contract.created", resourceType: "contracts", createdAt: "2026-07-06T10:00:00Z" }), // ~1d
  entry({ id: "2", action: "contract.updated", resourceType: "contracts", createdAt: "2026-06-20T10:00:00Z" }), // ~17d
  entry({ id: "3", action: "app.viewed", resourceType: "apps", createdAt: "2026-04-01T10:00:00Z" }), // ~97d
];
const ids = (es: AuditEntry[]) => es.map((e) => e.id);

describe("filterAuditEntries", () => {
  it("no filters → all entries (existing list still works)", () => {
    expect(ids(filterAuditEntries(rows, {}, NOW))).toEqual(["1", "2", "3"]);
  });
  it("search matches action OR entity (case-insensitive), narrows only", () => {
    expect(ids(filterAuditEntries(rows, { q: "contract" }, NOW))).toEqual(["1", "2"]);
    expect(ids(filterAuditEntries(rows, { q: "APPS" }, NOW))).toEqual(["3"]);
    expect(filterAuditEntries(rows, { q: "zzz" }, NOW)).toEqual([]);
  });
  it("action + entity filters", () => {
    expect(ids(filterAuditEntries(rows, { action: "contract.created" }, NOW))).toEqual(["1"]);
    expect(ids(filterAuditEntries(rows, { entity: "apps" }, NOW))).toEqual(["3"]);
  });
  it("date window filters over createdAt (7 / 30 / 90 days)", () => {
    expect(ids(filterAuditEntries(rows, { days: 7 }, NOW))).toEqual(["1"]);
    expect(ids(filterAuditEntries(rows, { days: 30 }, NOW))).toEqual(["1", "2"]);
    expect(ids(filterAuditEntries(rows, { days: 90 }, NOW))).toEqual(["1", "2"]); // #3 is ~97d, excluded
  });
  it("combines filters (all must match)", () => {
    expect(ids(filterAuditEntries(rows, { q: "contract", days: 30 }, NOW))).toEqual(["1", "2"]);
    expect(ids(filterAuditEntries(rows, { action: "contract.updated", days: 7 }, NOW))).toEqual([]); // #2 is >7d
  });
  it("an unparseable timestamp is excluded from a dated window (fail-safe)", () => {
    const bad = [entry({ id: "x", createdAt: "not-a-date" })];
    expect(filterAuditEntries(bad, { days: 30 }, NOW)).toEqual([]);
    expect(ids(filterAuditEntries(bad, {}, NOW))).toEqual(["x"]); // no window → still shown
  });
});

describe("parseAuditDays", () => {
  it("accepts only 7/30/90; anything else → null (all-time, no false narrowing)", () => {
    expect(parseAuditDays("7")).toBe(7);
    expect(parseAuditDays("30")).toBe(30);
    expect(parseAuditDays("90")).toBe(90);
    expect(parseAuditDays("5")).toBeNull();
    expect(parseAuditDays("abc")).toBeNull();
    expect(parseAuditDays(undefined)).toBeNull();
  });
});

describe("auditFacets", () => {
  it("distinct sorted actions + entities present in the visible set", () => {
    expect(auditFacets(rows)).toEqual({ actions: ["app.viewed", "contract.created", "contract.updated"], entities: ["apps", "contracts"] });
    expect(auditFacets([])).toEqual({ actions: [], entities: [] });
  });
});

describe("audit data safety", () => {
  it("audit page/DAL/filter render or return no raw-JSON / actor-id / ip / ua fields (comments stripped)", () => {
    const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const files = [
      "audit-filter.ts",
      "audit.ts",
      "../../app/(authenticated)/audit/page.tsx",
    ];
    for (const rel of files) {
      const code = strip(readFileSync(join(__dirname, rel), "utf8"));
      for (const f of ["before_json", "after_json", "ip_address", "user_agent", "raw_payload", "fact_json", "connector_secrets", "discovery_facts", "SERVICE_ROLE"]) {
        expect(code, `${rel} must not reference ${f}`).not.toContain(f);
      }
    }
  });
});
