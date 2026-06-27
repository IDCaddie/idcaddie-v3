"use server";

// Internal-dev Slack sync trigger — the `"use server"` boundary the internal page's form calls. A THIN wrapper over the
// server-only orchestrator (src/lib/server/sync/internal-slack-trigger.ts), where the env-flag guard + server-side
// auth/tenant/write-role authorization + the RLS-gated chain live. It takes NO input (tenant/connector are resolved
// server-side, never caller-supplied) and returns nothing — the safe run summary is surfaced via the revalidated
// "Last run" status (RLS-scoped manual_sync_runs read). Never service-role; disabled outside local dev + opt-in.

import { revalidatePath } from "next/cache";
import { runInternalSlackSync } from "@/lib/server/sync/internal-slack-trigger";

export async function runInternalSlackSyncAction(): Promise<void> {
  await runInternalSlackSync(); // re-guards env + auth + write-role server-side; never trusts the caller
  revalidatePath("/internal/slack-sync");
}
