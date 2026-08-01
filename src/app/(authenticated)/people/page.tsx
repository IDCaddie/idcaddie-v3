import Link from "next/link";
import { listIdentityAccountsForCurrentUser } from "@/lib/data/people";
import { DEMO_MODE } from "@/app/(authenticated)/nav-items";
import { matchRateSummary } from "@/lib/data/account-match-summary";
import { MatchRateMeter } from "@/components/match-rate-meter";

export const metadata = { title: "People / Users · ID Caddie" };

// Read-only People / Users (identity accounts) view. It renders only what the user-scoped server DAL
// returns; RLS is the authorization boundary. It shows the app-user ACCOUNTS you may read (across the
// apps you can see) with their app, the account's own fields, and a matched/unmatched STATUS — never
// person directory PII (no `people` row, no identity-provider data). This is NOT UAR, NOT the people
// directory, and NOT identity resolution; accounts are a flat list, not grouped/merged. No writes.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const NOT_BUILT_ACTIONS = [
  "Manual match / unmatch",
  "Bulk identity resolution",
  "Connector sync",
  "SCIM / IdP import",
  "AI-assisted matching",
  "Export",
  "People directory / employee records",
  "Unmanaged-account ratio (UAR)",
];

export default async function PeoplePage() {
  const result = await listIdentityAccountsForCurrentUser();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/dashboards" className="text-zinc-500 hover:underline">
            ← Back
          </Link>
        </div>
        <h1 className="text-xl font-semibold">People / Users</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Application accounts entered by an administrator, with whether each is matched to a person.
          Accounts discovered by a connector appear under <strong>Application accounts</strong>.
        </p>
      </header>

      {!result.ok ? (
        <p className="text-sm text-red-600">
          Could not load people / users right now. Please try again later.
        </p>
      ) : result.data.totalAccounts === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No app-user accounts to show</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            No manually tracked accounts yet. Accounts discovered by a connector appear under Application accounts.
          </p>
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Accounts visible to you" value={String(result.data.totalAccounts)} />
            <Stat label="Across apps" value={String(result.data.distinctApps)} />
            <Stat
              label="Matched"
              value={result.data.matchStatusAvailable ? String(result.data.matchedAccounts) : "—"}
            />
            <Stat
              label="Unmatched"
              value={result.data.matchStatusAvailable ? String(result.data.unmatchedAccounts) : "—"}
            />
          </section>

          <section className="max-w-md space-y-2 rounded border border-zinc-200 p-4 text-sm dark:border-zinc-800">
            <MatchRateMeter
              summary={matchRateSummary(result.data.matchedAccounts, result.data.unmatchedAccounts)}
              available={result.data.matchStatusAvailable}
            />
            <p className="text-xs text-zinc-500">
              This is app-account matching coverage, not a full user-access-review. It shows only whether a match
              row exists for each visible account — never who it matched, license, or identity-provider data.
            </p>
          </section>

          <section className="space-y-2 text-sm">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                    <th className="py-2 pr-4 font-medium">App</th>
                    <th className="py-2 pr-4 font-medium">Account</th>
                    <th className="py-2 pr-4 font-medium">Email</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">License</th>
                    <th className="py-2 pr-4 font-medium">Last active</th>
                    <th className="py-2 pr-4 font-medium">Identity</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.accounts.map((acct) => (
                    <tr key={acct.id} className="border-b border-zinc-200 dark:border-zinc-800">
                      <td className="py-2 pr-4">
                        <Link href={`/apps/${acct.appId}`} className="underline">
                          {acct.appName}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">{acct.displayName ?? "—"}</td>
                      <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{acct.email ?? "—"}</td>
                      <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">{acct.status ?? "—"}</td>
                      <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                        {acct.licenseType ?? "—"}
                      </td>
                      <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                        {acct.lastActiveAt ? acct.lastActiveAt.slice(0, 10) : "—"}
                      </td>
                      <td className="py-2 pr-4">
                        {!result.data.matchStatusAvailable ? (
                          <span className="text-zinc-500">—</span>
                        ) : acct.matched ? (
                          <span className="text-green-700 dark:text-green-400">matched</span>
                        ) : (
                          <span className="text-zinc-500">unmatched</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-zinc-500">
              “Account” fields are the application’s own values. “Identity” shows whether a match exists, not who it matched.
            </p>
          </section>
        </>
      )}

      {!DEMO_MODE && (
        <section className="space-y-2 text-sm">
          <h2 className="font-medium">Identity matching &amp; people management</h2>
          <p className="text-xs text-zinc-500">
            These old-app capabilities are not implemented in v3 yet — shown so the gap is explicit, not
            hidden. This surface is read-only.
          </p>
          <ul className="flex flex-wrap gap-2">
            {NOT_BUILT_ACTIONS.map((action) => (
              <li key={action}>
                <span
                  aria-disabled="true"
                  title="Not built yet"
                  className="inline-flex items-center gap-2 rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-400 dark:border-zinc-700"
                >
                  {action}
                  <span className="rounded-full border border-zinc-300 px-1.5 text-[10px] dark:border-zinc-700">
                    Not built yet
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
