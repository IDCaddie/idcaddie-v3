"use server";

// Contract write SERVER ACTIONS — the `"use server"` RPC boundary the contract create/edit UI calls
// (PR #31: `contract-form.tsx` on `/contracts/new` + `/contracts/[id]/edit`). They are intentionally
// thin wrappers over the user-scoped server DAL (src/lib/data/contracts.ts), where validation +
// server-side tenant resolution + the RLS-gated write live.
//
// Guarantees inherited from the DAL: user-scoped anon client only (NEVER service-role), tenant_id
// resolved server-side (never caller-supplied), RLS (0004) is the authorization boundary, and
// audit-on-write is automatic via the 0010 DB trigger. See docs/13_CONTRACT_STEWARD_WRITE_DESIGN.md
// §4 / §8. A `"use server"` module may export only async functions — the imported types are erased.

import {
  createContractForCurrentUser,
  updateContractForCurrentUser,
  type ContractWriteResult,
} from "@/lib/data/contracts";
import type { ContractWriteInput } from "@/lib/data/contract-write";

export async function createContractAction(
  input: ContractWriteInput,
): Promise<ContractWriteResult> {
  return createContractForCurrentUser(input);
}

export async function updateContractAction(
  contractId: string,
  input: ContractWriteInput,
): Promise<ContractWriteResult> {
  return updateContractForCurrentUser(contractId, input);
}
