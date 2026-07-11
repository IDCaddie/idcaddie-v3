import Link from "next/link";
import { resolveTenantContext } from "@/lib/auth/tenant-context";
import { getSyncReviewCounts, getSyncReviewPendingGroups } from "@/lib/data/sync-review";
import { getAppUserAccountPromotionReadiness } from "@/lib/data/promotion-readiness";
import { REVIEW_REJECT_REASONS } from "@/lib/data/sync-review-actions";
import { confirmReviewBatchAction, rejectReviewBatchAction } from "./actions";
import { Badge } from "@/components/badge";
import { StatCard, StatGrid } from "@/components/stat-card";

export const metadata = { title: "Sync review · ID Caddie" };

// Interactive review surface — SEPARATE from the read-only /connectors page. It shows the pending review queue as
// count-only batches grouped by (source run, fact type, provider) and lets EDITORS confirm/reject a whole batch. It
// renders NO individual discovery items and NO body/PII: only provider, fact type, the opaque source run id, a pending
// count, and timestamps. Mutations go through the user-scoped, RLS-gated, status-only helpers (#301) via server actions;
// audit is produced by the 0042 DB trigger; nothing here inserts audit_logs, promotes, or deletes.

const EDITOR_ROLES = ["owner", "admin", "editor"] as const;
const FACT_TYPE_LABEL: Record<string, string> = { app_user_account: "App user accounts", group: "Groups" };
const factTypeLabel = (t: string) => FACT_TYPE_LABEL[t] ?? t;
const REJECT_REASON_LABEL: Record<string, string> = {
  not_a_real_account: "Not a real account",
  duplicate: "Duplicate",
  out_of_scope: "Out of scope",
  test_or_noise: "Test / noise",
  wrong_app_or_provider: "Wrong app / provider",
};

// Parse the ?status= result code into a safe, count-only human banner (server-rendered; no ids/bodies).
function statusBanner(
  status: string | undefined,
): { tone: "success" | "danger" | "neutral"; text: string } | null {
  if (!status) return null;
  if (status.startsWith("confirmed_") || status.startsWith("rejected_")) {
    const [kind, nRaw] = [status.slice(0, status.indexOf("_")), status.slice(status.indexOf("_") + 1)];
    const n = Number.parseInt(nRaw, 10);
    if (!Number.isFinite(n) || n <= 0) return { tone: "neutral", text: "No pending items changed." };
    return { tone: "success", text: `${kind === "confirmed" ? "Confirmed" : "Rejected"} ${n} item${n === 1 ? "" : "s"}.` };
  }
  if (status === "noop") return { tone: "neutral", text: "No pending items changed." };
  if (status === "invalid_reason") return { tone: "danger", text: "Please choose a valid reason and try again." };
  if (status === "not_authenticated") return { tone: "danger", text: "Please sign in again to review items." };
  if (status === "update_failed") return { tone: "danger", text: "Could not update review items right now. Please try again." };
  return null;
}

export default async function SyncReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const banner = statusBanner(typeof sp.status === "string" ? sp.status : undefined);

  const ctx = await resolveTenantContext();
  const role = ctx?.activeTenant?.role ?? null;
  const canReview = role !== null && (EDITOR_ROLES as readonly string[]).includes(role);

  const counts = await getSyncReviewCounts();
  const groups = await getSyncReviewPendingGroups();
  // Read-only, COUNT-ONLY promotion-readiness for confirmed app_user_account facts (docs/70 P1). No promotion here —
  // just a readout of what confirmed data means. Same summary for viewers and editors (no controls, no server action).
  const readiness = await getAppUserAccountPromotionReadiness();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/connectors" className="text-zinc-500 hover:underline">
            ← Back to connectors
          </Link>
        </div>
        <h1 className="text-xl font-semibold">Sync review</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Review pending discovery items from connector syncs, in batches. Counts only — no item details, personal data,
          payloads, tokens, or secrets are shown. Reviewing updates status only (confirm / reject); it never creates or
          changes an account, and never deletes.
        </p>
      </header>

      {banner ? (
        <div
          className={`rounded border p-3 text-sm ${banner.tone === "danger" ? "border-red-300 text-red-700 dark:text-red-400" : banner.tone === "success" ? "border-green-300 text-green-700 dark:text-green-400" : "border-zinc-300 text-zinc-600 dark:border-zinc-700"}`}
        >
          {banner.text}
        </div>
      ) : null}

      {!canReview ? (
        <p className="text-xs text-zinc-500">
          You have read-only access here — confirming or rejecting items requires an editor role in this tenant.
        </p>
      ) : null}

      {counts.ok ? (
        <StatGrid>
          <StatCard label="Pending" value={counts.data.pending} tone={counts.data.pending > 0 ? "attention" : "neutral"} />
          <StatCard label="Needs review" value={counts.data.needsReview} tone={counts.data.needsReview > 0 ? "attention" : "neutral"} />
          <StatCard label="Confirmed" value={counts.data.confirmed} tone="success" />
          <StatCard label="Rejected" value={counts.data.rejected} tone={counts.data.rejected > 0 ? "danger" : "neutral"} />
        </StatGrid>
      ) : (
        <p className="text-sm text-red-600">Could not load the review summary right now. Please try again later.</p>
      )}

      <section className="space-y-2 text-sm">
        <h2 className="font-medium">Pending batches</h2>
        {!groups.ok ? (
          <p className="text-sm text-red-600">Could not load pending batches right now. Please try again later.</p>
        ) : groups.data.length === 0 ? (
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <div className="font-medium">No items awaiting review.</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                  <th className="py-2 pr-4 font-medium">Provider</th>
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">Sync run</th>
                  <th className="py-2 pr-4 font-medium">Pending</th>
                  <th className="py-2 pr-4 font-medium">First seen</th>
                  <th className="py-2 pr-4 font-medium">Last seen</th>
                  {canReview ? <th className="py-2 pr-4 font-medium">Review</th> : null}
                </tr>
              </thead>
              <tbody>
                {groups.data.map((g) => {
                  const key = `${g.sourceRunId ?? "—"}|${g.factType}|${g.provider}`;
                  const actionable = canReview && g.sourceRunId !== null;
                  return (
                    <tr key={key} className="border-b border-zinc-200 align-top dark:border-zinc-800">
                      <td className="py-2 pr-4"><Badge tone="neutral">{g.provider}</Badge></td>
                      <td className="py-2 pr-4">{factTypeLabel(g.factType)}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-zinc-500">{g.sourceRunId ? g.sourceRunId.slice(0, 8) : "—"}</td>
                      <td className="py-2 pr-4 tabular-nums font-medium">{g.pending}</td>
                      <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{g.firstSeen.slice(0, 10)}</td>
                      <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{g.lastSeen.slice(0, 10)}</td>
                      {canReview ? (
                        <td className="py-2 pr-4">
                          {actionable ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <form action={confirmReviewBatchAction}>
                                <input type="hidden" name="sourceRunId" value={g.sourceRunId ?? ""} />
                                <input type="hidden" name="factType" value={g.factType} />
                                <button type="submit" className="rounded border border-green-400 px-2 py-1 text-xs text-green-700 dark:text-green-400">
                                  Confirm pending
                                </button>
                              </form>
                              <form action={rejectReviewBatchAction} className="flex items-center gap-1">
                                <input type="hidden" name="sourceRunId" value={g.sourceRunId ?? ""} />
                                <input type="hidden" name="factType" value={g.factType} />
                                <select name="reason" defaultValue={REVIEW_REJECT_REASONS[0]} className="rounded border border-zinc-300 px-1 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900">
                                  {REVIEW_REJECT_REASONS.map((r) => (
                                    <option key={r} value={r}>{REJECT_REASON_LABEL[r] ?? r}</option>
                                  ))}
                                </select>
                                <button type="submit" className="rounded border border-red-400 px-2 py-1 text-xs text-red-700 dark:text-red-400">
                                  Reject pending
                                </button>
                              </form>
                            </div>
                          ) : (
                            <span className="text-xs text-zinc-400">—</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-zinc-500">
          Batches group pending items by sync run + type. Confirm / reject applies to a whole batch and updates status
          only — no item details are shown, nothing is promoted to an account, and nothing is ever deleted.
        </p>
      </section>

      <section className="space-y-3 text-sm">
        <h2 className="font-medium">Import readiness</h2>
        <p className="text-xs text-zinc-500">
          Read-only readiness for confirmed Slack app-user accounts — counts only. Nothing here imports or changes an
          account, and no accounts have been imported. This is a summary of what the confirmed data means, not an action.
        </p>
        {!readiness.ok ? (
          <p className="text-sm text-red-600">Import readiness is unavailable right now. Please try again later.</p>
        ) : readiness.data.total === 0 ? (
          <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <div className="font-medium">No confirmed accounts to assess yet.</div>
            <p className="mt-1 text-zinc-600 dark:text-zinc-400">
              Readiness counts appear here once app-user accounts are confirmed in review.
            </p>
          </div>
        ) : (
          <StatGrid>
            <StatCard label="Total confirmed accounts" value={readiness.data.total} />
            <StatCard label="Ready to add" value={readiness.data.ready} tone={readiness.data.ready > 0 ? "success" : "neutral"} />
            <StatCard label="Already represented" value={readiness.data.alreadyRepresented} />
            <StatCard label="Conflicts" value={readiness.data.conflict} tone={readiness.data.conflict > 0 ? "danger" : "neutral"} />
            <StatCard label="Missing required data" value={readiness.data.missingRequired} tone={readiness.data.missingRequired > 0 ? "attention" : "neutral"} />
            <StatCard label="Unsupported" value={readiness.data.unsupported} />
          </StatGrid>
        )}
      </section>
    </main>
  );
}
