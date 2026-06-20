import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { resolveTenantContext } from "@/lib/auth/tenant-context";
import { AppNav } from "./nav";

// Server-side guard for the whole authenticated route group. This is the authoritative auth
// gate for these routes (Proxy adds a per-request optimistic redirect). Authorization over
// tenant/org DATA is still RLS's job once we query it (docs/02_SECURITY_AND_RLS.md).
//
// The persistent shell (AppNav) shows the full-parity navigation roadmap — only the implemented
// routes are linked; unbuilt old-app areas are disabled "Not built yet" items. Tenant/user context
// (email + active tenant name/role; never the tenant id) comes from the existing RLS-scoped resolver.
export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // Read-only, RLS-scoped context for the shell chrome (never service-role). A failed/empty context
  // simply shows no active tenant — it never blocks rendering (the layout already guards the session).
  const ctx = await resolveTenantContext();

  return (
    <div className="flex min-h-screen">
      <AppNav
        email={ctx?.email ?? user.email ?? null}
        tenantName={ctx?.activeTenant?.name ?? null}
        tenantRole={ctx?.activeTenant?.role ?? null}
      />
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
