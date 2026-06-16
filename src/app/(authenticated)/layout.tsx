import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";

// Server-side guard for the whole authenticated route group. This is the authoritative auth
// gate for these routes (Proxy adds a per-request optimistic redirect). Authorization over
// tenant/org DATA is still RLS's job once we query it (docs/02_SECURITY_AND_RLS.md).
export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return <>{children}</>;
}
