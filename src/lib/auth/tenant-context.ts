import { getSessionUser } from "./session";

// PLACEHOLDER — tenant/org context resolution is intentionally NOT implemented in this PR.
// It is build-sequence Stage 3 (docs/06_BUILD_SEQUENCE.md). This stub exposes only the
// authenticated user's identity so future code has a stable seam to grow into.
//
// It deliberately does NOT, and must NOT:
//   - resolve tenant/org memberships or roles (Stage 3 reads them from the membership tables),
//   - grant or deny access (Postgres RLS is the authorization boundary — docs/02),
//   - read roles from JWT custom claims or treat them as a source of truth,
//   - cache/duplicate membership state on the client or in browser storage.
// When data reads land, scoping comes from RLS via the user-scoped server client, not here.
export type TenantContext = {
  userId: string;
  email: string | null;
  // tenantId / orgIds / roles are intentionally absent until Stage 3.
};

export async function getTenantContext(): Promise<TenantContext | null> {
  const user = await getSessionUser();
  if (!user) return null;
  return { userId: user.id, email: user.email ?? null };
}
