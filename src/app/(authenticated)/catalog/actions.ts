"use server";
import { revalidatePath } from "next/cache";
import { declareApplicationAlias } from "@/lib/data/application-aliases";

// Phase 18A — the single product-side entry point for declaring canonical application identity.
//
// "This directory application's provider identifier IS this canonical app product." That is a human judgement, so an authorized
// editor makes it; the connector may not. `connector_runner` holds no grant on app_aliases/app_products/vendors/apps and gains
// none here — raw provider evidence stays connector-owned, canonical identity stays product-owned.
//
// Authorization is never decided here. This layer only maps a bounded outcome to reviewed copy; the tenant is resolved
// server-side inside declareApplicationAlias and no tenant id is accepted from the browser. The provider identifier is likewise
// read from the directory application row rather than the form, so a caller cannot submit an identifier of their choosing.
//
// NO UI CALLS THIS YET — deliberately. The brief for this phase excludes UI; this is the seam a later phase renders against, and
// it is exercised directly by application-aliases tests.

export type DeclareAliasState = { ok: boolean; message: string } | null;

const MESSAGE: Record<string, string> = {
  declared: "Recorded. This provider identifier now identifies that product.",
  unchanged: "Already recorded — this identifier already identifies that product.",
  unsupported_alias_type: "That identifier type cannot be declared. Only an application's provider identifier is supported today.",
  source_not_eligible: "That directory application is no longer current, so it cannot establish a new canonical identity. Re-sync the directory first.",
  conflict_different_product: "That identifier already identifies a different product. Changing it is a review decision, not a re-submission.",
  conflict_rejected: "Someone previously rejected this mapping. Reopening it is a review decision.",
  not_allowed: "You don’t have permission to record that.",
  invalid_input: "That request was not valid.",
  query_failed: "Could not record that right now. Please try again later.",
};

export async function declareApplicationAliasAction(_prev: DeclareAliasState, form: FormData): Promise<DeclareAliasState> {
  const result = await declareApplicationAlias({
    directoryApplicationId: String(form.get("directoryApplicationId") ?? ""),
    appProductId: String(form.get("appProductId") ?? ""),
    aliasType: String(form.get("aliasType") ?? ""),
  });

  if (result.ok) {
    revalidatePath("/catalog");
    return { ok: true, message: MESSAGE[result.outcome] };
  }
  const key = result.error === "conflict" ? `conflict_${result.reason ?? "different_product"}` : result.error;
  return { ok: false, message: MESSAGE[key] ?? MESSAGE.query_failed };
}
