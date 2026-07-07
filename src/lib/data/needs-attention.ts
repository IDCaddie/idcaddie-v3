// Read-only "Needs Attention" cleanup queue — composed ENTIRELY from existing RLS-scoped DALs. No new
// tables/views, no migration, no connector_secrets, no discovery_facts / fact_json, no PII beyond the
// app/contract/connector names already shown elsewhere. Every section fails closed to a safe state on a DAL
// error (never crashes) and lists only rows the signed-in user may read ("visible to you", RLS-scoped).

// TYPE-ONLY imports of the DALs (erased at runtime) so this pure module pulls in NO server-only graph
// (@/lib/supabase/server / next/headers). The fetch wrapper lives in ./needs-attention-loader.
import type { listAppsWithCountsForCurrentUser, listAppOwnershipForCurrentUser } from "./apps";
import type { listContractsForCurrentUser } from "./contracts";
import type { listConnectorsForCurrentUser } from "./connectors";
import type { getReportsSummaryForCurrentUser } from "./reports";

export type AttentionItem = { label: string; sublabel?: string; href: string };
export type AttentionState = "ok" | "empty" | "error" | "deferred";
export type AttentionSection = {
  key: string;
  title: string;
  explanation: string;
  state: AttentionState;
  count: number; // total matching items (may exceed items.length when capped)
  items: AttentionItem[];
  href?: string; // section-level link (when there is no per-item detail page)
};
export type NeedsAttention = { sections: AttentionSection[] };

const CAP = 8; // top-N items rendered per section

// Exact return types of the underlying DALs — no re-declared shapes, no name clashes.
type AppsCountsResult = Awaited<ReturnType<typeof listAppsWithCountsForCurrentUser>>;
type AppsOwnershipResult = Awaited<ReturnType<typeof listAppOwnershipForCurrentUser>>;
type ContractsResult = Awaited<ReturnType<typeof listContractsForCurrentUser>>;
type ConnectorsResult = Awaited<ReturnType<typeof listConnectorsForCurrentUser>>;
type ReportsResult = { ok: true; data: Awaited<ReturnType<typeof getReportsSummaryForCurrentUser>> } | { ok: false };

export type NeedsAttentionInputs = {
  appsCounts: AppsCountsResult;
  appsOwnership: AppsOwnershipResult;
  contracts: ContractsResult;
  connectors: ConnectorsResult;
  reports: ReportsResult;
};

const BAD_CONNECTOR_STATUS = new Set(["error", "revoked", "disabled"]);
const BAD_RUN_STATUS = new Set(["failed", "timed_out"]);

// Turn a filtered row set into a section, capping the rendered items but reporting the true total.
function section(
  key: string,
  title: string,
  explanation: string,
  ok: boolean,
  items: AttentionItem[],
  href?: string,
): AttentionSection {
  if (!ok) return { key, title, explanation, state: "error", count: 0, items: [], href };
  return {
    key,
    title,
    explanation,
    state: items.length === 0 ? "empty" : "ok",
    count: items.length,
    items: items.slice(0, CAP),
    href,
  };
}

// PURE — categorizes already-fetched DAL results. Testable without a DB.
export function buildNeedsAttention(input: NeedsAttentionInputs): NeedsAttention {
  const sections: AttentionSection[] = [];

  // 1. Apps missing an owner (business OR technical). Exposes only the app name/status + a detail link.
  sections.push(
    section(
      "apps-missing-owner",
      "Apps missing an owner",
      "Apps with no business or technical owner assigned. Assign one so someone is accountable.",
      input.appsOwnership.ok,
      input.appsOwnership.ok
        ? input.appsOwnership.data
            .filter((a) => !a.hasOwner)
            .map((a) => ({ label: a.name, sublabel: a.status, href: `/apps/${a.id}` }))
        : [],
    ),
  );

  // 2. Apps with no linked contract.
  sections.push(
    section(
      "apps-missing-contract",
      "Apps missing a contract",
      "Apps you can read that have no linked contract — spend/renewal for them is untracked.",
      input.appsCounts.ok,
      input.appsCounts.ok
        ? input.appsCounts.data
            .filter((a) => a.linkedContractCount === 0)
            .map((a) => ({ label: a.name, sublabel: a.vendorName ?? undefined, href: `/apps/${a.id}` }))
        : [],
    ),
  );

  // 3. Unmanaged apps — DEFERRED. There is no reliable managed/unmanaged signal in the current schema
  //    ("unmatched" accounts are NOT the same as an "unmanaged" app — see identity matching). Shown as a
  //    deferred placeholder rather than inventing a signal.
  sections.push({
    key: "unmanaged-apps",
    title: "Unmanaged apps",
    explanation:
      "Deferred — the current schema has no reliable “managed vs unmanaged” signal (an app being unmatched is not the same as unmanaged). This will light up once that signal exists.",
    state: "deferred",
    count: 0,
    items: [],
  });

  // 4. Contracts with no renewal date and no end date — renewal tracking is impossible for them.
  sections.push(
    section(
      "contracts-missing-renewal",
      "Contracts missing a renewal date",
      "Contracts with neither a renewal date nor an end date — they can’t be tracked for renewal.",
      input.contracts.ok,
      input.contracts.ok
        ? input.contracts.data
            .filter((c) => c.renewalDate == null && c.endDate == null)
            .map((c) => ({ label: c.contractName, sublabel: c.vendorName ?? undefined, href: `/contracts/${c.id}` }))
        : [],
    ),
  );

  // 5. Connector issues — bad connector status OR bad latest-run status. Uses ONLY the safe exposed
  //    fields (status / run status / failure label); never health/last_sync_at/secrets. No per-connector
  //    detail page, so items link to /connectors.
  sections.push(
    section(
      "connector-issues",
      "Connector issues",
      "Connectors in an error/revoked/disabled state, or whose last run failed or timed out.",
      input.connectors.ok,
      input.connectors.ok
        ? input.connectors.data
            .filter(
              (c) =>
                BAD_CONNECTOR_STATUS.has(c.status) ||
                (c.lastRun != null && BAD_RUN_STATUS.has(c.lastRun.status)),
            )
            .map((c) => ({
              label: c.displayName ?? c.provider,
              sublabel: c.lastRun?.failureLabel ?? c.status,
              href: "/connectors",
            }))
        : [],
      "/connectors",
    ),
  );

  // 6. Unmatched accounts — a safe AGGREGATE count only (no discovery facts, no PII). Links to /people
  //    where the matched/unmatched status is already surfaced.
  const reportsOk = input.reports.ok;
  const unmatched = reportsOk ? input.reports.data.accountsUnmatched : null;
  sections.push({
    key: "unmatched-accounts",
    title: "Unmatched accounts",
    explanation:
      "Discovered app accounts with no matched person yet (visible to you). Review them on People. Count only — no account details are shown here.",
    state: !reportsOk || unmatched == null ? "error" : unmatched === 0 ? "empty" : "ok",
    count: unmatched ?? 0,
    items: reportsOk && unmatched != null && unmatched > 0 ? [{ label: `${unmatched} unmatched accounts`, href: "/people" }] : [],
    href: "/people",
  });

  return { sections };
}
