import Link from "next/link";
import { resolveTenantContext } from "@/lib/auth/tenant-context";
import { DEMO_MODE } from "@/app/(authenticated)/nav-items";
import { toAdminContextView, ADMIN_NOT_BUILT, IMPLEMENTED_MODULES } from "./admin-view";

export const metadata = { title: "Admin / Settings · ID Caddie" };

// Read-only Admin / Settings. It reuses the existing RLS-scoped tenant-context resolver (no new DAL,
// no service-role) and projects it through toAdminContextView, which exposes ONLY the signed-in email
// + active tenant NAME/role + org membership NAMES/roles — never a raw tenant/org/user id. It is purely
// read-only: no admin write, no invitations, no role changes, no tenant switching, no billing, no
// connector/API-key/SSO/SCIM/retention/security-setting management (all shown as "Not built yet").
export default async function AdminPage() {
  const ctx = await resolveTenantContext();
  const view = ctx ? toAdminContextView(ctx) : null;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/dashboards" className="text-zinc-500 hover:underline">
            ← Back
          </Link>
        </div>
        <h1 className="text-xl font-semibold">Admin / Settings</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Your current account context. Invitations, role changes, workspace switching and billing are
          managed by ID Caddie.
        </p>
      </header>

      {!view || view.status === "error" ? (
        <p className="text-sm text-red-600">Could not load your account context right now. Please try again later.</p>
      ) : (
        <>
          <section className="space-y-3 text-sm">
            <h2 className="font-medium">Account context</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <div className="text-zinc-500">Signed in as</div>
                <div className="font-medium">{view.email ?? "—"}</div>
              </div>
              <div>
                <div className="text-zinc-500">Active tenant</div>
                <div className="font-medium">{view.activeTenantName ?? "No active tenant"}</div>
              </div>
              <div>
                <div className="text-zinc-500">Your role</div>
                <div className="font-medium">{view.role ?? "—"}</div>
              </div>
              <div>
                <div className="text-zinc-500">Tenant memberships</div>
                <div className="font-medium">
                  {view.tenantCount}
                  {view.multipleTenants ? " (tenant switcher not built yet)" : ""}
                </div>
              </div>
            </div>
            <div>
              <div className="text-zinc-500">Organization memberships ({view.orgCount})</div>
              {view.orgMemberships.length === 0 ? (
                <div className="text-zinc-600 dark:text-zinc-400">None.</div>
              ) : (
                <ul className="list-inside list-disc">
                  {view.orgMemberships.map((o, i) => (
                    <li key={`${o.name}-${i}`}>
                      {o.name} — <span className="text-zinc-500">{o.role}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-xs text-zinc-500">
              Internal identifiers are deliberately not shown here.
            </p>
          </section>

          <section className="space-y-2 text-sm">
            <h2 className="font-medium">Implemented modules</h2>
            <ul className="list-inside list-disc text-zinc-600 dark:text-zinc-400">
              {IMPLEMENTED_MODULES.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </section>
        </>
      )}

      {!DEMO_MODE && (
        <section className="space-y-2 text-sm">
          <h2 className="font-medium">Administration capabilities</h2>
          <p className="text-xs text-zinc-500">
            These old-app Admin / Settings capabilities are not implemented in v3 yet — shown so the gap is
            explicit, not hidden. This surface is read-only.
          </p>
          <ul className="flex flex-wrap gap-2">
            {ADMIN_NOT_BUILT.map((item) => (
              <li key={item.label}>
                <span
                  aria-disabled="true"
                  title="Not built yet"
                  className="inline-flex items-center gap-2 rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-400 dark:border-zinc-700"
                >
                  {item.label}
                  {item.note ? <span className="text-[10px] text-zinc-400">({item.note})</span> : null}
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
