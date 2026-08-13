"use server";

// Entitlement write SERVER ACTIONS — the `"use server"` boundary the purchased-line form calls. Thin wrappers over the
// user-scoped DAL, exactly like `contracts/actions.ts`: validation, server-side tenant resolution and the RLS-gated write all
// live there, and 0083's AFTER trigger audits an accepted write. A `"use server"` module may export only async functions, so
// the imported types are erased.
//
// No authorization here. 0083's policies (read = the parent contract's visibility; write = tenant editor+ or the contract's
// procurement-org manager) are the boundary, and a denied save returns the same generic result as a row that does not exist.

import {
  createEntitlementForCurrentUser,
  updateEntitlementForCurrentUser,
  type EntitlementWriteInput,
  type EntitlementWriteResult,
} from "@/lib/data/contract-entitlements";

export async function createEntitlementAction(input: EntitlementWriteInput): Promise<EntitlementWriteResult> {
  return createEntitlementForCurrentUser(input);
}

export async function updateEntitlementAction(
  entitlementId: string,
  input: EntitlementWriteInput,
): Promise<EntitlementWriteResult> {
  return updateEntitlementForCurrentUser(entitlementId, input);
}
