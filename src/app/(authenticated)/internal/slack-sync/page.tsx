import { isInternalSlackTriggerEnabled } from "@/lib/server/sync/internal-slack-trigger";
import { resolveTenantContext } from "@/lib/auth/tenant-context";
import { getLatestSlackSyncRunForCurrentTenant } from "@/lib/data/manual-sync-runs";
import { runInternalSlackSyncAction } from "./actions";

export const metadata = { title: "Internal dev Slack sync · ID Caddie" };

// INTERNAL-DEV ONLY trigger page. NOT linked in the nav (hidden). The form button renders ONLY when the allowlist env
// flag is on AND the signed-in user is an owner/admin/editor of a single active tenant — so in a deployed/non-dev
// environment (flag off) the button never appears. The server action re-guards everything (it never trusts this page).
// Internal/dev MANUAL trigger only — not customer-facing. The result appears in "Last run" below (RLS-scoped, safe
// aggregates).
const WRITE_ROLES = ["owner", "admin", "editor"];

export default async function InternalSlackSyncPage() {
  if (!isInternalSlackTriggerEnabled(process.env)) {
    return (
      <main className="flex flex-1 flex-col gap-4 p-8">
        <h1 className="text-xl font-semibold">Internal dev Slack sync</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          This internal-dev trigger is not enabled in this environment.
        </p>
      </main>
    );
  }

  const context = await resolveTenantContext();
  const active = context?.activeTenant ?? null;
  const canTrigger = !!active && !context?.tenantSwitchingRequired && WRITE_ROLES.includes(active.role);
  const run = canTrigger ? await getLatestSlackSyncRunForCurrentTenant() : null;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Internal dev Slack sync</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Local/dev-only internal trigger for the manual Slack sync. It runs the existing chain and writes tenant-scoped
          rows via Postgres RLS <strong>as you</strong> (never service-role). Internal/dev only — not customer-facing.
        </p>
      </header>

      {!canTrigger ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Requires an owner/admin/editor membership in a single active tenant.
        </p>
      ) : (
        <>
          <form action={runInternalSlackSyncAction}>
            <button
              type="submit"
              className="rounded bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700"
            >
              Run internal dev Slack sync
            </button>
          </form>

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">Last run</h2>
            {!run || !run.ok ? (
              <p className="text-zinc-600 dark:text-zinc-400">Could not load run status right now.</p>
            ) : run.data === null ? (
              <p className="text-zinc-600 dark:text-zinc-400">No sync runs yet.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3 text-zinc-600 dark:text-zinc-400">
                <span className="font-medium">{run.data.status}</span>
                {run.data.status === "failed" && run.data.errorCode ? (
                  <span className="text-red-700 dark:text-red-400">error: {run.data.errorCode}</span>
                ) : null}
                <span>users {run.data.usersFetched ?? "—"}</span>
                <span>app_users {run.data.appUsersWritten ?? "—"}</span>
                <span>people {run.data.peopleWritten ?? "—"}</span>
                <span>matches {run.data.matchesWritten ?? "—"}</span>
                <span>skipped {run.data.skipped ?? "—"}</span>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
