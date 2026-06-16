import { describe, it, expect } from "vitest";
import {
  summarizeAccountIntelligence,
  STALE_CANDIDATE_DAYS,
  type AccountUserInput,
} from "./app-account-intelligence";

// Fixed reference "now" so stale-candidate math is deterministic.
const NOW = Date.parse("2026-06-16T00:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const user = (over: Partial<AccountUserInput> & { id: string }): AccountUserInput => ({
  status: null,
  lastActiveAt: null,
  ...over,
});

describe("summarizeAccountIntelligence", () => {
  it("0 app users → all zero, no divide-by-zero, flags true", () => {
    const s = summarizeAccountIntelligence([], [], { nowMs: NOW });
    expect(s.totalVisibleAccounts).toBe(0);
    expect(s.matchedAccounts).toBe(0);
    expect(s.unmatchedAccounts).toBe(0);
    expect(s.matchRate).toBe(0);
    expect(s.activeAccounts).toBe(0);
    expect(s.inactiveAccounts).toBe(0);
    expect(s.unknownStatusAccounts).toBe(0);
    expect(s.staleCandidates).toBe(0);
    expect(s.noPersonDataUsed).toBe(true);
    expect(s.noIdentityAccountDataUsed).toBe(true);
  });

  it("all matched → matchRate 1, unmatched 0 (distinct app_users, dedup multiple match rows)", () => {
    const users = [user({ id: "a" }), user({ id: "b" })];
    const matches = [
      { appUserId: "a" },
      { appUserId: "a" }, // two match rows for the same app_user → counts once
      { appUserId: "b" },
    ];
    const s = summarizeAccountIntelligence(users, matches, { nowMs: NOW });
    expect(s.totalVisibleAccounts).toBe(2);
    expect(s.matchedAccounts).toBe(2);
    expect(s.unmatchedAccounts).toBe(0);
    expect(s.matchRate).toBe(1);
  });

  it("some unmatched → counts + matchRate; a stray match id never inflates past total", () => {
    const users = [user({ id: "a" }), user({ id: "b" }), user({ id: "c" })];
    const matches = [{ appUserId: "a" }, { appUserId: "zzz-not-in-roster" }];
    const s = summarizeAccountIntelligence(users, matches, { nowMs: NOW });
    expect(s.totalVisibleAccounts).toBe(3);
    expect(s.matchedAccounts).toBe(1);
    expect(s.unmatchedAccounts).toBe(2);
    expect(s.matchRate).toBeCloseTo(1 / 3);
  });

  it("stale candidate threshold: older than 90d is stale, within 90d is not", () => {
    const users = [
      user({ id: "old", lastActiveAt: daysAgo(STALE_CANDIDATE_DAYS + 1) }),
      user({ id: "recent", lastActiveAt: daysAgo(STALE_CANDIDATE_DAYS - 1) }),
      user({ id: "edge", lastActiveAt: daysAgo(STALE_CANDIDATE_DAYS) }), // exactly 90d → not > threshold
    ];
    const s = summarizeAccountIntelligence(users, [], { nowMs: NOW });
    expect(s.staleCandidates).toBe(1); // only "old"
  });

  it("null last_active_at is UNKNOWN for staleness, never stale", () => {
    const users = [
      user({ id: "n1", lastActiveAt: null }),
      user({ id: "n2", lastActiveAt: null }),
      user({ id: "stale", lastActiveAt: daysAgo(200) }),
    ];
    const s = summarizeAccountIntelligence(users, [], { nowMs: NOW });
    expect(s.staleCandidates).toBe(1); // only the one with an old date; nulls excluded
  });

  it("status breakdown buckets null/unrecognized as unknown (never inferred)", () => {
    const users = [
      user({ id: "1", status: "active" }),
      user({ id: "2", status: "ACTIVE" }), // case-insensitive
      user({ id: "3", status: "inactive" }),
      user({ id: "4", status: "disabled" }),
      user({ id: "5", status: "suspended" }),
      user({ id: "6", status: null }), // unknown
      user({ id: "7", status: "provisioned" }), // unrecognized → unknown
    ];
    const s = summarizeAccountIntelligence(users, [], { nowMs: NOW });
    expect(s.activeAccounts).toBe(2);
    expect(s.inactiveAccounts).toBe(3);
    expect(s.unknownStatusAccounts).toBe(2);
    // every account is bucketed exactly once
    expect(s.activeAccounts + s.inactiveAccounts + s.unknownStatusAccounts).toBe(
      s.totalVisibleAccounts,
    );
  });

  it("needs only app_users + matches — no people/identity rows are required", () => {
    // The signature accepts only roster + match shapes; the result asserts no person/identity data used.
    const s = summarizeAccountIntelligence(
      [user({ id: "a", status: "active", lastActiveAt: daysAgo(10) })],
      [{ appUserId: "a" }],
      { nowMs: NOW },
    );
    expect(s.noPersonDataUsed).toBe(true);
    expect(s.noIdentityAccountDataUsed).toBe(true);
    expect(s.matchedAccounts).toBe(1);
  });
});
