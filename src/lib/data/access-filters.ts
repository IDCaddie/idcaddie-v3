// Phase 15 Part 2 PR C — the SERVER-side (also pure/browser-safe) filter + pagination + return-context contract for the /access surface.
// One strict, reusable normalizer: it parses ONLY allowlisted values off searchParams, serializes canonical URLs, applies filters to the
// ALREADY-EVALUATED safe view models (never to raw canonical rows, never before Phase 13/14 — so filtering can't change graph semantics),
// paginates deterministically in memory over the already-bounded lists, and reconstructs back-links from an allowlist of internal /access
// route names only (never a caller-supplied URL — an open redirect is structurally impossible). Pure functions; no I/O, no DB, no engine.
//
// Pagination is OFFSET over already-bounded in-memory results (docs/72): the overview only evaluates within the node/edge caps and detail
// subgraphs are capped at SUBGRAPH_MAX_ROWS, so the full filtered list is bounded before we slice it. Cursor pagination would add no safety.

import type { GovernanceSeverity, GovernanceConfidence, GovernanceRuleId, GovernanceSubjectType } from "@/lib/server/governance-analytics/types";
import type { GovernanceFindingView, IdentityApplicationAccessView, ClassificationView } from "./access-view-models";
import type { ApplicationIdentityAccessView } from "./access-loaders";
import { RULE_PROSE } from "./governance-presenter";

// ── allowlists + guards (per-surface allowlist trio convention: readonly const + isX guard) ─────────────────────────────────────────────
export const SEVERITIES = ["high", "medium", "low", "info"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;
export const CLASSIFICATIONS = ["DIRECT", "GROUP", "BOTH"] as const;
export const SUBJECT_TYPES = ["identity", "group", "application", "assignment", "effective_access", "graph"] as const;
export const CATALOG_MATCHES = ["matched", "unmatched", "unavailable"] as const;
export const RULE_IDS = Object.keys(RULE_PROSE) as GovernanceRuleId[];

const has = <T extends readonly string[]>(arr: T, v: string): v is T[number] => (arr as readonly string[]).includes(v);
export const isSeverity = (v: string): v is GovernanceSeverity => has(SEVERITIES, v);
export const isConfidence = (v: string): v is GovernanceConfidence => has(CONFIDENCES, v);
export const isClassification = (v: string): v is ClassificationView => has(CLASSIFICATIONS, v);
export const isSubjectType = (v: string): v is GovernanceSubjectType => has(SUBJECT_TYPES, v);
export const isCatalogMatch = (v: string): v is (typeof CATALOG_MATCHES)[number] => has(CATALOG_MATCHES, v);
export const isRuleId = (v: string): v is GovernanceRuleId => (RULE_IDS as string[]).includes(v);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_RE = /^[a-z0-9_]{1,40}$/;
const MAX_QUERY = 200;      // bounded query length
const MAX_RET = 600;        // bounded return-context length
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export type AccessFilters = {
  readonly query: string | null;         // normalized (NFKC + lowercase + collapsed whitespace + bounded); null when empty
  readonly provider: string | null;
  readonly connectionId: string | null;
  readonly includeStale: boolean;
  readonly classification: ClassificationView | null;
  readonly severity: GovernanceSeverity | null;
  readonly confidence: GovernanceConfidence | null;
  readonly ruleId: GovernanceRuleId | null;
  readonly subjectType: GovernanceSubjectType | null;
  readonly catalogMatch: (typeof CATALOG_MATCHES)[number] | null;
  readonly staleEvidence: boolean | null;
  readonly page: number;                  // 1-based offset page
  readonly pageSize: number;              // clamped [1, MAX_PAGE_SIZE], default DEFAULT_PAGE_SIZE
};

export type SearchParamsInput = Record<string, string | string[] | undefined>;

// A repeated param yields an array — take the FIRST string deterministically (repeats never widen scope). Unknown params are ignored.
const first = (v: string | string[] | undefined): string | undefined =>
  typeof v === "string" ? v : Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : undefined) : undefined;

const norm = (s: string): string => s.normalize("NFKC").toLowerCase();
function normalizeQuery(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = norm(raw).replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
  return t.length > 0 ? t : null;
}
function clampInt(raw: string | undefined, min: number, max: number, dflt: number): number {
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}
const pick = <T extends string>(raw: string | undefined, guard: (v: string) => v is T): T | null =>
  raw !== undefined && guard(raw) ? raw : null;

export function parseAccessFilters(sp: SearchParamsInput): AccessFilters {
  const providerRaw = first(sp.provider);
  const connRaw = first(sp.connection);
  const staleEvid = first(sp.staleEvidence);
  return {
    query: normalizeQuery(first(sp.q)),
    provider: providerRaw !== undefined && PROVIDER_RE.test(providerRaw) ? providerRaw : null,
    connectionId: connRaw !== undefined && UUID_RE.test(connRaw) ? connRaw : null,
    includeStale: first(sp.stale) === "1",
    classification: pick(first(sp.classification), isClassification),
    severity: pick(first(sp.severity), isSeverity),
    confidence: pick(first(sp.confidence), isConfidence),
    ruleId: pick(first(sp.rule), isRuleId),
    subjectType: pick(first(sp.subjectType), isSubjectType),
    catalogMatch: pick(first(sp.catalogMatch), isCatalogMatch),
    staleEvidence: staleEvid === "1" ? true : staleEvid === "0" ? false : null,
    page: clampInt(first(sp.page), 1, 100_000, 1),
    pageSize: clampInt(first(sp.pageSize), 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE),
  };
}

// Canonical serialization: fixed key order, defaults/nulls omitted, so identical filter state always produces the identical URL.
export function accessQueryString(f: AccessFilters): string {
  const p = new URLSearchParams();
  if (f.query) p.set("q", f.query);
  if (f.provider) p.set("provider", f.provider);
  if (f.connectionId) p.set("connection", f.connectionId);
  if (f.includeStale) p.set("stale", "1");
  if (f.classification) p.set("classification", f.classification);
  if (f.severity) p.set("severity", f.severity);
  if (f.confidence) p.set("confidence", f.confidence);
  if (f.ruleId) p.set("rule", f.ruleId);
  if (f.subjectType) p.set("subjectType", f.subjectType);
  if (f.catalogMatch) p.set("catalogMatch", f.catalogMatch);
  if (f.staleEvidence !== null) p.set("staleEvidence", f.staleEvidence ? "1" : "0");
  if (f.pageSize !== DEFAULT_PAGE_SIZE) p.set("pageSize", String(f.pageSize));
  if (f.page > 1) p.set("page", String(f.page));
  return p.toString();
}

// Build an internal href off a FIXED /access base, applying a patch. Any filter change (anything other than page/pageSize) resets to page 1.
export function accessHref(base: string, f: AccessFilters, patch: Partial<AccessFilters> = {}): string {
  const changesFilter = Object.keys(patch).some((k) => k !== "page" && k !== "pageSize");
  const merged: AccessFilters = { ...f, ...patch, page: "page" in patch ? patch.page! : changesFilter ? 1 : f.page };
  const qs = accessQueryString(merged);
  return qs ? `${base}?${qs}` : base;
}

// ── deterministic offset pagination over already-bounded in-memory lists ────────────────────────────────────────────────────────────────
export type Paged<T> = {
  readonly rows: readonly T[];
  readonly page: number; readonly pageSize: number;
  readonly total: number; readonly totalPages: number;
  readonly hasPrev: boolean; readonly hasNext: boolean;
  readonly startIndex: number; readonly endIndex: number; // 1-based inclusive display range (0/0 when empty)
};
export function paginate<T>(all: readonly T[], page: number, pageSize: number): Paged<T> {
  const size = Math.min(Math.max(Math.trunc(pageSize) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(Math.trunc(page) || 1, 1), totalPages);
  const start = (current - 1) * size;
  const rows = all.slice(start, start + size);
  return {
    rows, page: current, pageSize: size, total, totalPages,
    hasPrev: current > 1, hasNext: current < totalPages,
    startIndex: total === 0 ? 0 : start + 1, endIndex: start + rows.length,
  };
}

// ── filters over already-evaluated safe view models (post Phase 13/14; never changes graph meaning) ─────────────────────────────────────
const contains = (haystack: string, q: string) => norm(haystack).includes(q); // q is already normalized

export function filterFindings(findings: readonly GovernanceFindingView[], f: AccessFilters): GovernanceFindingView[] {
  return findings.filter((v) => {
    if (f.severity && v.severity !== f.severity) return false;
    if (f.confidence && v.confidence !== f.confidence) return false;
    if (f.ruleId && v.ruleId !== f.ruleId) return false;
    if (f.subjectType && v.subjectType !== f.subjectType) return false;
    if (f.staleEvidence !== null && v.staleEvidence !== f.staleEvidence) return false;
    if (f.query && !(contains(v.title, f.query) || contains(v.summary, f.query) || (v.subject ? contains(v.subject.label, f.query) : false))) return false;
    return true;
  });
}

// Detail lists sort deterministically by display label then canonical id (stable tie-breaker) BEFORE filtering + pagination.
export function filterIdentityApplications(apps: readonly IdentityApplicationAccessView[], f: AccessFilters): IdentityApplicationAccessView[] {
  return apps
    .filter((a) => {
      if (f.classification && a.classification !== f.classification) return false;
      if (f.staleEvidence !== null && a.staleEvidence !== f.staleEvidence) return false;
      if (f.query && !contains(a.applicationLabel, f.query)) return false;
      return true;
    })
    .slice()
    .sort((a, b) => a.applicationLabel.localeCompare(b.applicationLabel) || a.applicationId.localeCompare(b.applicationId));
}

export function filterApplicationIdentities(identities: readonly ApplicationIdentityAccessView[], f: AccessFilters): ApplicationIdentityAccessView[] {
  return identities
    .filter((i) => {
      if (f.classification && i.classification !== f.classification) return false;
      if (f.staleEvidence !== null && i.staleEvidence !== f.staleEvidence) return false;
      if (f.query && !contains(i.identityLabel, f.query)) return false;
      return true;
    })
    .slice()
    .sort((a, b) => a.identityLabel.localeCompare(b.identityLabel) || a.identityId.localeCompare(b.identityId));
}

// Active-filter counts are PER-SURFACE: a filter counts only if that surface actually APPLIES it — otherwise a complete-empty scope reached
// with an unapplied param (e.g. /access/findings?classification=DIRECT) would be mislabeled "no matches" and "Clear N filters" would be a
// no-op. provider/connection/catalogMatch have no control yet and are applied by nothing, so they are never counted (nor is the includeStale
// directory-scope toggle).
export function findingsActiveFilters(f: AccessFilters): number {
  let n = 0;
  if (f.query) n++;
  if (f.severity) n++;
  if (f.confidence) n++;
  if (f.ruleId) n++;
  if (f.subjectType) n++;
  if (f.staleEvidence !== null) n++;
  return n;
}
export function detailActiveFilters(f: AccessFilters): number {
  let n = 0;
  if (f.query) n++;
  if (f.classification) n++;
  if (f.staleEvidence !== null) n++;
  return n;
}

// ── return context: allowlisted internal back-links only (no caller-supplied URL is ever honored) ──────────────────────────────────────
export const ACCESS_SOURCES = ["overview", "findings", "identity", "application"] as const;
export type AccessSource = (typeof ACCESS_SOURCES)[number];
export const isAccessSource = (v: string): v is AccessSource => (ACCESS_SOURCES as readonly string[]).includes(v);

// Serialize the CURRENT page's filter state into an opaque-but-re-validated `ret` querystring for a link OUT to a detail page.
export function returnParams(source: AccessSource, current: AccessFilters, fromId?: string): URLSearchParams {
  const p = new URLSearchParams();
  p.set("from", source);
  const qs = accessQueryString({ ...current, page: current.page }); // preserve page so "back" lands on the same page
  if (qs) p.set("ret", qs.slice(0, MAX_RET));
  if (fromId && UUID_RE.test(fromId)) p.set("fromId", fromId);
  return p;
}

// Reconstruct a safe internal back-link from `from`/`ret`/`fromId`. Returns null (fall back to the static link) when unrecognized.
// The target path is ALWAYS one of a fixed set of /access routes; `ret` is re-parsed through the allowlist parser; `fromId` must be a UUID.
export function backLink(sp: SearchParamsInput): { href: string; label: string } | null {
  const fromRaw = first(sp.from);
  if (fromRaw === undefined || !isAccessSource(fromRaw)) return null;
  const retRaw = first(sp.ret);
  const retFilters = retRaw !== undefined && retRaw.length <= MAX_RET ? parseAccessFilters(Object.fromEntries(new URLSearchParams(retRaw))) : null;
  const withRet = (base: string) => (retFilters ? accessHref(base, retFilters) : base);
  const fromId = first(sp.fromId);
  const idOk = fromId !== undefined && UUID_RE.test(fromId);
  switch (fromRaw) {
    case "overview": return { href: withRet("/access"), label: "Back to access overview" };
    case "findings": return { href: withRet("/access/findings"), label: "Back to findings" };
    case "identity": return idOk ? { href: withRet(`/access/identities/${fromId}`), label: "Back to identity access" } : null;
    case "application": return idOk ? { href: withRet(`/access/applications/${fromId}`), label: "Back to application access" } : null;
  }
}

// ── option lists for the filter <select>s (customer-facing labels; rule labels come from the reviewed presenter) ────────────────────────
export const SEVERITY_OPTIONS: { value: GovernanceSeverity; label: string }[] = [
  { value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }, { value: "info", label: "Info" },
];
export const CONFIDENCE_OPTIONS: { value: GovernanceConfidence; label: string }[] = [
  { value: "high", label: "High confidence" }, { value: "medium", label: "Medium confidence" }, { value: "low", label: "Low confidence" },
];
export const SUBJECT_TYPE_OPTIONS: { value: GovernanceSubjectType; label: string }[] = [
  { value: "identity", label: "Identity" }, { value: "group", label: "Group" }, { value: "application", label: "Application" },
  { value: "assignment", label: "Assignment" }, { value: "effective_access", label: "Effective access" }, { value: "graph", label: "Structural" },
];
export const CLASSIFICATION_OPTIONS: { value: ClassificationView; label: string }[] = [
  { value: "DIRECT", label: "Direct" }, { value: "GROUP", label: "Through group" }, { value: "BOTH", label: "Direct and through group" },
];
export const RULE_OPTIONS: { value: GovernanceRuleId; label: string }[] = RULE_IDS
  .map((id) => ({ value: id, label: RULE_PROSE[id].title }))
  .sort((a, b) => a.label.localeCompare(b.label));
