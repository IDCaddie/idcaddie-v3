"use server";

// The one server action the pending page's poller calls. A thin wrapper over the user-scoped, RLS-gated status read —
// it adds no authorization logic of its own, because `product_oauth_completion_job_status` already refuses by returning
// nothing and `getSlackConnectionStatus` maps every refusal to the same customer state.
//
// It returns exactly `{ state, terminal }`. Nothing else crosses the boundary to the browser.

import { getSlackConnectionStatus, type ConnectionStatus } from "@/lib/data/oauth-completion-status";

export async function pollSlackConnectionStatusAction(correlationId: string): Promise<ConnectionStatus> {
  return getSlackConnectionStatus(correlationId);
}
