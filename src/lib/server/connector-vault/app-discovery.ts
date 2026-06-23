// Server-only APP-GRAPH NORMALIZATION — the bridge from discovery-connector signals to ID Caddie app records
// (docs/42 §55). Discovery connectors (Okta / Google Workspace / Microsoft Entra / imports / extension)
// surface raw "an app exists" signals; this normalizes + de-duplicates them into candidate app records the
// product can later reconcile against real `apps`. **Types + ONE pure in-memory helper only.** It writes NO
// DB / no app-graph row, calls NO provider API, stores NO token/credential, touches NO `connector_secrets`.
// **No discovery connector is functional.**
//
// SAFE-METADATA-ONLY: every field is a non-secret label / count / score — never a token, OAuth code, raw
// credential, or secret. The helper is pure (deterministic, no I/O), so it is fully testable with in-memory
// fixtures and cannot reach a provider or the database.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// It has NO imports (pure TS data + logic).

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/app-discovery is server-only and must not be imported in client code");
}

// A raw "this SaaS app exists" signal from one discovery source — SAFE metadata only (no secret/token/PII
// payload). `assignedUserCount`/`loginActivitySignal` are aggregate non-secret counts/scores.
export type DiscoveredAppSignal = {
  sourceProvider: string; // a provider id, e.g. "okta" (a label, never a secret)
  appName: string; // the discovered display name
  appDomain: string | null; // the app's primary domain if known (used for matching)
  externalAppId: string | null; // the source provider's id for the app
  assignedUserCount: number | null; // aggregate count (no user identities)
  loginActivitySignal: number | null; // a safe relative activity score (no PII)
  usageSignals: readonly string[]; // safe labels (e.g. "active_30d"); never a payload
};

// How confident the normalizer is that a candidate is a single real app, and what a human/automation should
// do next. Labels only — nothing here connects, syncs, or writes.
export type AppMatchStatus = "new_candidate" | "likely_duplicate" | "merged" | "needs_review";

// A normalized candidate app record — the merge of one-or-more signals about (probably) the same app.
export type NormalizedAppCandidate = {
  normalizedName: string;
  normalizedDomain: string | null;
  externalIds: readonly { provider: string; id: string }[]; // every source's id for this candidate
  sourceProviders: readonly string[]; // the discovery sources that saw it (unique, sorted)
  assignedUserCount: number | null; // max across sources (a safe upper-bound signal)
  confidence: number; // 0..1 naive score — more corroborating sources + a domain ⇒ higher
  matchStatus: AppMatchStatus;
};

// The normalized key: prefer the domain (lowercased), else the app name (lowercased + trimmed). Two signals
// that share a key are treated as the same candidate app.
function normalizeKey(s: DiscoveredAppSignal): string {
  const domain = s.appDomain?.trim().toLowerCase();
  if (domain) return `d:${domain}`;
  return `n:${s.appName.trim().toLowerCase()}`;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// Pure in-memory normalization: group discovery signals by their normalized key and emit one candidate per
// group (merging external ids + sources, taking the max assigned-user count, scoring confidence). Writes NO
// DB and calls NO provider — it is the BRIDGE SHAPE only. Deterministic: candidates are returned sorted by
// normalizedName.
export function normalizeDiscoveredAppSignals(
  signals: readonly DiscoveredAppSignal[],
): NormalizedAppCandidate[] {
  if (!Array.isArray(signals) || signals.length === 0) return [];
  const groups = new Map<string, DiscoveredAppSignal[]>();
  for (const s of signals) {
    if (!s || typeof s.appName !== "string" || s.appName.trim().length === 0) continue; // skip malformed
    const key = normalizeKey(s);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }

  const out: NormalizedAppCandidate[] = [];
  for (const group of groups.values()) {
    const sources = [...new Set(group.map((g) => g.sourceProvider))].sort();
    const externalIds = group
      .filter((g) => g.externalAppId)
      .map((g) => ({ provider: g.sourceProvider, id: g.externalAppId as string }));
    const counts = group.map((g) => g.assignedUserCount).filter((n): n is number => typeof n === "number");
    const domain = group.find((g) => g.appDomain)?.appDomain?.trim().toLowerCase() ?? null;
    // Naive confidence: a base for any signal, +0.2 per corroborating source (capped), +0.2 if a domain
    // anchors the match. More independent sources agreeing ⇒ higher confidence it is one real app.
    const confidence = clamp01(0.4 + 0.2 * (sources.length - 1) + (domain ? 0.2 : 0));
    const matchStatus: AppMatchStatus =
      sources.length >= 2 ? "likely_duplicate" : domain ? "new_candidate" : "needs_review";
    out.push({
      normalizedName: group[0].appName.trim(),
      normalizedDomain: domain,
      externalIds,
      sourceProviders: sources,
      assignedUserCount: counts.length ? Math.max(...counts) : null,
      confidence,
      matchStatus,
    });
  }
  return out.sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));
}
