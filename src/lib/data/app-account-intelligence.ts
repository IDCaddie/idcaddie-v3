// Pure, read-only "account intelligence" summary for one app's roster. It is computed ENTIRELY from
// data the caller can already read — the visible `app_users` roster (0007) and the visible
// `app_user_identity_matches` rows (0008). It does NOT query anything: it takes already-fetched arrays
// and returns counts. No DB, no service-role, no `people`, no `identity_accounts`, no license/files/
// invoices, no PII (no person id, no identity-account id, no provider/status/raw_payload).
//
// Deliberately conservative vocabulary:
//   * "unmatched" means ONLY "no visible match row for this visible app_user" — NOT orphaned/unmanaged.
//   * "stale candidate" means ONLY "the app_user's own `last_active_at` looks older than the threshold"
//     — NOT confirmed stale/offboarded. A null `last_active_at` is UNKNOWN (never counted as stale).
//   * status buckets are derived ONLY from the app_user's own `status` text; anything unrecognized or
//     null is "unknown" (we never infer managed/deactivated). This is NOT UAR.

// Structural inputs — any object with these fields works (the real `AppUserSummary` / `AppUserMatch`
// DTOs satisfy them), so this helper needs no imports and is trivially unit-testable.
export type AccountUserInput = {
  id: string;
  status: string | null;
  lastActiveAt: string | null;
};
export type AccountMatchInput = { appUserId: string };

export type AccountIntelligenceSummary = {
  totalVisibleAccounts: number;
  matchedAccounts: number;
  unmatchedAccounts: number;
  /** matched / total, as a fraction in [0, 1]; 0 when there are no visible accounts. */
  matchRate: number;
  activeAccounts: number;
  inactiveAccounts: number;
  unknownStatusAccounts: number;
  staleCandidates: number;
  noPersonDataUsed: true;
  noIdentityAccountDataUsed: true;
};

export const STALE_CANDIDATE_DAYS = 90;
const ACTIVE_STATUSES = new Set(["active"]);
const INACTIVE_STATUSES = new Set(["inactive", "disabled", "suspended"]);

// Summarize the visible roster + visible matches. `nowMs` is injectable so the result is deterministic
// in tests; callers may omit it to use the current time. `staleDays` defaults to a fixed conservative 90.
export function summarizeAccountIntelligence(
  appUsers: readonly AccountUserInput[],
  matches: readonly AccountMatchInput[],
  opts?: { nowMs?: number; staleDays?: number },
): AccountIntelligenceSummary {
  const nowMs = opts?.nowMs ?? Date.now();
  const staleMs = (opts?.staleDays ?? STALE_CANDIDATE_DAYS) * 24 * 60 * 60 * 1000;

  // A visible app_user is "matched" if ≥1 visible match row references it. Count DISTINCT app_users,
  // and only those present in the roster (a stray match id never inflates the count past the total).
  const matchedIds = new Set(matches.map((m) => m.appUserId));

  let matched = 0;
  let active = 0;
  let inactive = 0;
  let unknownStatus = 0;
  let stale = 0;

  for (const u of appUsers) {
    if (matchedIds.has(u.id)) matched += 1;

    const s = u.status === null ? null : u.status.trim().toLowerCase();
    if (s !== null && ACTIVE_STATUSES.has(s)) active += 1;
    else if (s !== null && INACTIVE_STATUSES.has(s)) inactive += 1;
    else unknownStatus += 1; // null or unrecognized — never inferred as active/inactive

    if (u.lastActiveAt !== null) {
      const t = Date.parse(u.lastActiveAt);
      if (!Number.isNaN(t) && nowMs - t > staleMs) stale += 1;
    }
    // null (or unparseable) lastActiveAt is UNKNOWN for staleness — never a stale candidate.
  }

  const total = appUsers.length;
  return {
    totalVisibleAccounts: total,
    matchedAccounts: matched,
    unmatchedAccounts: total - matched,
    matchRate: total === 0 ? 0 : matched / total,
    activeAccounts: active,
    inactiveAccounts: inactive,
    unknownStatusAccounts: unknownStatus,
    staleCandidates: stale,
    noPersonDataUsed: true,
    noIdentityAccountDataUsed: true,
  };
}
