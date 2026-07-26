// Phase 15 Part 2 PR D — pure CSV builders for the /access bounded exports. NO DB / no I/O: route handlers do the auth + load + filter +
// completeness/cap checks (identical to the pages), then hand the already-filtered safe view models here to project onto an EXPLICIT column
// allowlist, sanitize every cell against spreadsheet formula injection, and serialize. NEVER emits a tenant/canonical/external id, raw
// payload, credential, setting, profile, source endpoint, secret, or raw JSON evidence — only safe display labels, bounded enums, and
// integer counts (subject/identity/application LABELS are the same resolved display strings shown on-screen; no separate login/email column).

import { toCsv, sanitizeCsvCell } from "./to-csv";
import type { GovernanceFindingView, IdentityApplicationAccessView } from "./access-view-models";
import type { ApplicationIdentityAccessView } from "./access-loaders";

export const EXPORT_ROW_CAP = 10_000; // reject (never silently truncate) above this many data rows

const yesNo = (b: boolean) => (b ? "Yes" : "No");
const directCount = (c: "DIRECT" | "GROUP" | "BOTH") => (c === "GROUP" ? "0" : "1"); // at most one direct edge per (identity, app)

// Build CSV with every cell (and header) sanitized against formula injection. Deterministic column order = the header array.
function buildCsv(headers: string[], rows: string[][]): string {
  return toCsv(headers.map(sanitizeCsvCell), rows.map((r) => r.map(sanitizeCsvCell)));
}

export const FINDINGS_COLUMNS = [
  "finding_id", "severity", "confidence", "finding_type", "title", "summary",
  "subject_type", "subject_label", "stale_evidence", "evidence_summary", "review_guidance",
] as const;
export function buildFindingsCsv(findings: readonly GovernanceFindingView[]): string {
  const rows = findings.map((f) => [
    f.id, f.severity, f.confidence, f.ruleId, f.title, f.summary,
    f.subjectType, f.subject?.label ?? "", yesNo(f.staleEvidence),
    f.evidenceRows.map((e) => `${e.label}: ${e.value}`).join("; "),
    f.guidance ?? "",
  ]);
  return buildCsv([...FINDINGS_COLUMNS], rows);
}

export const IDENTITY_ACCESS_COLUMNS = [
  "identity_label", "application_label", "provider", "classification",
  "direct_assignment_count", "inherited_group_count", "inherited_group_labels", "stale_evidence",
] as const;
export function buildIdentityAccessCsv(identityLabel: string, provider: string, apps: readonly IdentityApplicationAccessView[]): string {
  const rows = apps.map((a) => [
    identityLabel, a.applicationLabel, provider, a.classification,
    directCount(a.classification), String(a.groupPaths.length),
    a.groupPaths.map((p) => p.groupLabel).join("; "), yesNo(a.staleEvidence),
  ]);
  return buildCsv([...IDENTITY_ACCESS_COLUMNS], rows);
}

export const APPLICATION_ACCESS_COLUMNS = [
  "application_label", "identity_label", "provider", "classification", "direct_assignment_count", "stale_evidence",
] as const;
export function buildApplicationAccessCsv(applicationLabel: string, provider: string, identities: readonly ApplicationIdentityAccessView[]): string {
  const rows = identities.map((i) => [
    applicationLabel, i.identityLabel, provider, i.classification, directCount(i.classification), yesNo(i.staleEvidence),
  ]);
  return buildCsv([...APPLICATION_ACCESS_COLUMNS], rows);
}

// Filenames carry only a fixed prefix + date (no identity/application names, no ids). `date` is "YYYY-MM-DD" from the caller.
export const exportFilename = (kind: "access-findings" | "identity-access" | "application-access", date: string) => `${kind}-${date}.csv`;

// A private, no-store CSV attachment response. Content is server-computed; never cached, never sniffed.
export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store, private",
    },
  });
}

// A truthful, bounded error (no stack, no id, no internal detail) for the export routes. Same anti-sniffing + no-store hardening as csvResponse.
export function exportError(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store, private" } });
}
