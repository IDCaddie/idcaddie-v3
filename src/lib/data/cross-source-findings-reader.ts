// Phase 18F Lane A — the SERVER-ONLY read boundary for PERSISTED cross-source governance findings.
//
// THE FIRST CONSUMER `product_governance_findings` (0083) has ever had. Everything the customer sees comes from rows
// the engine wrote and 0083 owns the lifecycle of — this module reads them, drops anything that fails its contract,
// and turns them into browser-safe view models. It computes NO governance conclusion of its own: no severity, no
// subject, no threshold, no "if this then a finding". Re-deriving any of that here would give the product two answers
// to one question, and the persisted row is the answer.
//
// It reads ONLY the authorized product RPC through the user-scoped, cookie-bound, RLS-governed server client — the
// same one `access-repository` uses. NEVER service-role. `accessGate()` establishes owner/admin and the tenant; the
// RPC re-verifies both via `has_tenant_role`, so the tenant is checked twice and never comes from the browser.

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { accessGate } from "./access-repository";
import { crossSourceProse, severityLabel, severityTone, confidenceLabel } from "./governance-presenter";
import type { StatusTone } from "@/components/status-tokens";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("cross-source-findings-reader is server-only and must not be imported in client code");
}

/** Bounded failure vocabulary, matching `access-loaders`. None of these can carry SQL, a row, or a stack. */
export type FindingsError = "forbidden" | "query_failed";
export type CrossSourceFindingsResult =
  | { readonly ok: true; readonly data: CrossSourceFindingsData }
  | { readonly ok: false; readonly error: FindingsError };

/**
 * One finding, as the customer sees it.
 *
 * `id` is the PERSISTED row id and is the ONLY thing keyed on. It is deliberately not the remediation subtype: a
 * subject moving between subtypes is one finding being refreshed (0083 keeps `first_seen_at` and the row), so keying
 * on the subtype would make the same problem appear to disappear and come back as a new one.
 */
export type CrossSourceFindingView = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly guidance: string | null;
  readonly severityLabel: string;
  readonly severityTone: StatusTone;
  readonly confidenceLabel: string;
  /** A customer-facing noun for what the finding is about — never the engine's `subject_type` literal. */
  readonly subjectKind: string;
  /** Human-readable age, or null when the timestamp is unusable. Never a raw timestamp string. */
  readonly firstSeenLabel: string | null;
  /** "New", "Ongoing" or "Returned" — the lifecycle state, computed from persisted fields only. */
  readonly lifecycleLabel: "New" | "Ongoing" | "Returned";
  /** Bounded, label:value pairs from the evidence counts. Never a raw id, payload or external identifier. */
  readonly evidenceRows: readonly { readonly label: string; readonly value: string }[];
  /** Where the customer should go to act, or null when this build has no surface for it yet. */
  readonly action: { readonly label: string; readonly href: string } | null;
};

export type CrossSourceFindingsData = {
  readonly findings: readonly CrossSourceFindingView[];
  readonly total: number;
  /** Rows the RPC returned that failed their contract. Surfaced so a silent drop can never read as "all clear". */
  readonly unreadable: number;
};

// Strict-by-default: zod strips unknown keys, so a column a future RPC change adds cannot reach the browser.
const rowSchema = z.object({
  id: z.string().min(1),
  rule_id: z.string().min(1),
  subject_type: z.string().min(1),
  severity: z.enum(["high", "medium", "low", "info"]),
  confidence: z.enum(["high", "medium", "low"]),
  title_key: z.string().min(1),
  status: z.enum(["open", "closed"]),
  first_seen_at: z.string().nullable().optional().transform(v => v ?? null),
  reopen_count: z.number().nullable().optional().transform(v => v ?? 0),
  evidence_json: z.unknown().optional(),
});
type Row = z.infer<typeof rowSchema>;

const evidenceSchema = z.object({
  counts: z.record(z.string(), z.number()).optional(),
}).passthrough();

/**
 * A customer noun for the engine's `subject_type`. A subject type this build does not know renders as the neutral
 * "Finding" rather than the raw literal — an unmapped enum must never become customer copy.
 */
const SUBJECT_KIND: Record<string, string> = {
  directory_application: "Application",
  app_account: "Application account",
  person: "Person",
};

/**
 * `applications` -> "Applications", `duplicateAccounts` -> "Duplicate accounts".
 *
 * SENTENCE CASE, not title case: the split of a camelCase key is a word boundary, not a proper noun, and "Duplicate
 * Accounts" reads like a product name. Bounded to the engine's own count keys; never interpolates a value.
 */
export function humanizeCountKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Whole days, phrased. Returns null rather than guessing when the timestamp cannot be parsed. */
export function firstSeenLabel(firstSeenAt: string | null, now: Date): string | null {
  if (!firstSeenAt) return null;
  const then = Date.parse(firstSeenAt);
  if (Number.isNaN(then)) return null;
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days < 0) return null;                       // a clock disagreement is not "0 days ago"
  if (days === 0) return "First seen today";
  if (days === 1) return "First seen yesterday";
  return `First seen ${days} days ago`;
}

/**
 * Where a finding sends the customer.
 *
 * ROUTES ARE VALIDATED AGAINST WHAT THIS BUILD ACTUALLY HAS. Lane B owns the match-review surface; until it exists,
 * the unaccepted-match action resolves to null and the UI renders a non-broken disabled affordance rather than a link
 * to a 404. `KNOWN_ROUTES` is the single place that decides, so a route appearing later is a one-line change here.
 */
export const KNOWN_ROUTES = {
  directoryApplications: "/directory/applications",
  saasAccounts: "/saas/accounts",
  people: "/directory/people",
  /** Lane B's contract. `null` until that lane ships — deliberately not a guessed path. */
  applicationMatchReview: null as string | null,
} as const;

export function actionFor(row: Pick<Row, "rule_id" | "subject_type">, reason: string | null): CrossSourceFindingView["action"] {
  if (row.rule_id === "discovered_application_unmanaged_by_idp") {
    if (reason === "operational_match_unaccepted") {
      return KNOWN_ROUTES.applicationMatchReview
        ? { label: "Review available matches", href: KNOWN_ROUTES.applicationMatchReview }
        : null;
    }
    // Both remaining subtypes start from the application itself.
    return { label: "View application", href: KNOWN_ROUTES.directoryApplications };
  }
  if (row.subject_type === "app_account") return { label: "View application accounts", href: KNOWN_ROUTES.saasAccounts };
  if (row.subject_type === "person") return { label: "View people", href: KNOWN_ROUTES.people };
  return null;
}

/** Persisted lifecycle → a word. `reopen_count` and `first_seen_at` are 0083's; nothing is inferred. */
export function lifecycleLabel(row: Pick<Row, "reopen_count" | "first_seen_at">, now: Date): CrossSourceFindingView["lifecycleLabel"] {
  if ((row.reopen_count ?? 0) > 0) return "Returned";
  const label = firstSeenLabel(row.first_seen_at, now);
  return label === "First seen today" ? "New" : "Ongoing";
}

export function toView(row: Row, now: Date): CrossSourceFindingView {
  const prose = crossSourceProse(row.title_key);
  const ev = evidenceSchema.safeParse(row.evidence_json ?? {});
  const reason = ev.success && typeof (ev.data as { reason?: unknown }).reason === "string"
    ? (ev.data as { reason: string }).reason
    : null;
  const counts = ev.success ? (ev.data.counts ?? {}) : {};
  return {
    id: row.id,
    // A finding whose copy this build cannot resolve still gets a truthful, non-empty sentence — never a raw key and
    // never an empty card. `crossSourceProse` already falls back to the rule's broad copy for an unknown subtype.
    title: prose?.title ?? "Governance finding",
    summary: prose?.summary ?? "This finding needs review.",
    guidance: prose?.guidance ?? null,
    severityLabel: severityLabel(row.severity),
    severityTone: severityTone(row.severity),
    confidenceLabel: confidenceLabel(row.confidence),
    subjectKind: SUBJECT_KIND[row.subject_type] ?? "Finding",
    firstSeenLabel: firstSeenLabel(row.first_seen_at, now),
    lifecycleLabel: lifecycleLabel(row, now),
    evidenceRows: Object.entries(counts).map(([k, v]) => ({ label: humanizeCountKey(k), value: String(v) })),
    action: actionFor(row, reason),
  };
}

/** The injected seam, so the reader is testable without a database. */
export type FindingsIo = {
  readonly rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

export async function createFindingsIo(): Promise<FindingsIo> {
  const supabase = await createClient();
  type RpcFn = (n: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;
  return { rpc: async (name, args) => await rpc(name, args) };
}

/**
 * Load this tenant's OPEN cross-source findings.
 *
 * `p_status: 'open'` is the product decision: a closed finding is a resolved one, and listing it beside live work
 * would make the queue read as bigger than it is. The lifecycle is still visible — a finding that closed and returned
 * carries `reopen_count > 0` and renders as "Returned".
 */
export async function loadCrossSourceFindings(io?: FindingsIo, now: Date = new Date()): Promise<CrossSourceFindingsResult> {
  const gate = await accessGate();
  if (!gate.ok) return { ok: false, error: "forbidden" };
  const resolved = io ?? (await createFindingsIo());

  let data: unknown;
  try {
    const r = await resolved.rpc("product_governance_findings", {
      p_tenant_id: gate.tenantId, p_engine: "cross_source", p_status: "open", p_limit: 100,
    });
    if (r.error) { console.error("[data/cross-source-findings] rpc query_failed"); return { ok: false, error: "query_failed" }; }
    data = r.data;
  } catch {
    console.error("[data/cross-source-findings] rpc threw");
    return { ok: false, error: "query_failed" };
  }
  if (!Array.isArray(data)) {
    // A non-array is contract drift, not an empty estate. Reporting it as "no findings" is the one failure this
    // module must never produce.
    console.error("[data/cross-source-findings] rpc returned a non-array");
    return { ok: false, error: "query_failed" };
  }

  const findings: CrossSourceFindingView[] = [];
  let unreadable = 0;
  for (const raw of data) {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) { unreadable++; continue; }
    findings.push(toView(parsed.data, now));
  }
  if (unreadable > 0) console.error(`[data/cross-source-findings] ${unreadable} row(s) failed their contract`);

  return { ok: true, data: { findings, total: findings.length, unreadable } };
}
