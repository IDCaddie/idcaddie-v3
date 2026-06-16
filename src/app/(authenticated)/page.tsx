import Link from "next/link";
import { resolveTenantContext } from "@/lib/auth/tenant-context";

export const metadata = { title: "ID Caddie" };

// Protected skeleton landing page. Shows the resolved tenant/org CONTEXT only — deliberately
// NOT product UI (no app inventory, contracts, people, reports, dashboards). Those are future
// build-sequence stages (docs/06). Access to all data here is enforced by RLS, not this page.

function Badge({ label, state }: { label: string; state: "on" | "off" | "soon" }) {
  const tone =
    state === "on"
      ? "border-green-600 text-green-700 dark:text-green-400"
      : state === "soon"
        ? "border-amber-600 text-amber-700 dark:text-amber-400"
        : "border-zinc-400 text-zinc-500";
  const word = state === "on" ? "implemented" : state === "soon" ? "deferred" : "not built";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${tone}`}>
      {label}: {word}
    </span>
  );
}

export default async function ProtectedHome() {
  const ctx = await resolveTenantContext();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Protected shell</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Tenant/org context, resolved from Postgres under RLS. Not product UI.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        <Badge label="auth/session" state="on" />
        <Badge label="tenant context" state="on" />
        <Badge label="org context" state="on" />
        <Badge label="app inventory (read-only)" state="on" />
        <Badge label="tenant switching" state="soon" />
        <Badge label="hosted Supabase" state="off" />
      </div>

      <nav className="text-sm">
        <Link href="/apps" className="font-medium underline">
          → Apps inventory (read-only)
        </Link>
      </nav>

      {ctx === null ? (
        // Should not happen (layout guards), but never crash.
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Not signed in.</p>
      ) : ctx.status === "error" ? (
        <p className="text-sm text-red-600">
          Could not load your access right now. Please try again later.
        </p>
      ) : (
        <section className="space-y-5 text-sm">
          <div>
            <div className="text-zinc-500">Signed in as</div>
            <div className="font-medium">{ctx.email ?? ctx.userId}</div>
          </div>

          {ctx.activeTenant ? (
            <div className="space-y-1">
              <div className="text-zinc-500">Active tenant</div>
              <div className="font-medium">
                {ctx.activeTenant.name}{" "}
                <span className="text-zinc-500">
                  ({ctx.activeTenant.slug} · {ctx.activeTenant.id})
                </span>
              </div>
              <div className="text-zinc-500">
                Your role: <span className="font-medium">{ctx.activeTenant.role}</span>
              </div>
              {ctx.multipleTenants ? (
                <div className="text-amber-700 dark:text-amber-400">
                  You belong to {ctx.tenantMembershipCount} tenants; showing the first
                  deterministically. A tenant switcher is not built yet.
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
              <div className="font-medium">No tenant access configured yet</div>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                Your account has no active tenant membership. Access is provisioned by an
                administrator — there is no self-serve setup here.
              </p>
            </div>
          )}

          <div className="space-y-1">
            <div className="text-zinc-500">
              Organization memberships ({ctx.organizationMembershipCount})
            </div>
            {ctx.organizationMemberships.length === 0 ? (
              <div className="text-zinc-600 dark:text-zinc-400">None.</div>
            ) : (
              <ul className="list-inside list-disc">
                {ctx.organizationMemberships.map((o) => (
                  <li key={o.organizationId}>
                    {o.organizationName} — <span className="text-zinc-500">{o.role}</span>
                    {o.belongsToActiveTenant ? "" : " (other tenant)"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      <form action="/logout" method="post">
        <button
          type="submit"
          className="rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
