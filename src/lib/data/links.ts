import { createClient } from "@/lib/supabase/server";
import type { AppSummary, DataResult } from "@/lib/data/apps";
import type { ContractSummary } from "@/lib/data/contracts";

// Server-only, read-only access to app↔contract LINKS, scoped by RLS. `app_contracts` gained an
// org-scoped SELECT policy in migration 0006 (PR #20): a user may read a link row iff they can
// already read the linked app OR the linked contract. These helpers list the readable rows on the
// *other* side of a link — linked apps for a contract, linked contracts for an app.
//
// Two RLS-filtered steps (defense in depth, and avoids the embedded-join FK ambiguity the 0005
// composite FKs introduce on app_contracts→apps/contracts): (1) read the visible link rows from
// `app_contracts` to get the other-side ids; (2) read those `apps`/`contracts` — RLS returns only
// the ones the user may actually read, so we never render a name the user isn't allowed to see.
// No service-role, no caller-supplied tenant_id, no writes. Touches only app_contracts/apps/
// contracts — never invoices/files/license_*/identity_* (those remain default-deny / tenant-only).

export async function listAppsLinkedToContract(
  contractId: string,
): Promise<DataResult<AppSummary[]>> {
  const supabase = await createClient();

  const { data: links, error: linkErr } = await supabase
    .from("app_contracts")
    .select("app_id")
    .eq("contract_id", contractId);
  if (linkErr) {
    console.error("[data/links] listAppsLinkedToContract link query failed");
    return { ok: false, error: "query_failed" };
  }
  const appIds = (links ?? []).map((l) => l.app_id);
  if (appIds.length === 0) return { ok: true, data: [] };

  const { data, error } = await supabase
    .from("apps")
    .select("id, name, vendor_name, category, status")
    .in("id", appIds)
    .order("name", { ascending: true });
  if (error) {
    console.error("[data/links] listAppsLinkedToContract apps query failed");
    return { ok: false, error: "query_failed" };
  }
  return {
    ok: true,
    data: (data ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      vendorName: a.vendor_name,
      category: a.category,
      status: a.status,
    })),
  };
}

export async function listContractsLinkedToApp(
  appId: string,
): Promise<DataResult<ContractSummary[]>> {
  const supabase = await createClient();

  const { data: links, error: linkErr } = await supabase
    .from("app_contracts")
    .select("contract_id")
    .eq("app_id", appId);
  if (linkErr) {
    console.error("[data/links] listContractsLinkedToApp link query failed");
    return { ok: false, error: "query_failed" };
  }
  const contractIds = (links ?? []).map((l) => l.contract_id);
  if (contractIds.length === 0) return { ok: true, data: [] };

  const { data, error } = await supabase
    .from("contracts")
    .select("id, contract_name, vendor_name, status, category, renewal_date, end_date")
    .in("id", contractIds)
    .order("contract_name", { ascending: true });
  if (error) {
    console.error("[data/links] listContractsLinkedToApp contracts query failed");
    return { ok: false, error: "query_failed" };
  }
  return {
    ok: true,
    data: (data ?? []).map((c) => ({
      id: c.id,
      contractName: c.contract_name,
      vendorName: c.vendor_name,
      status: c.status,
      category: c.category,
      renewalDate: c.renewal_date,
      endDate: c.end_date,
    })),
  };
}
