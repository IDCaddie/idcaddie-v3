// INTERNAL scheduler tick endpoint (POST) — the cron-callable entrypoint for the Slack sync worker. THIN wrapper over
// the server-only handler (src/lib/server/sync/slack-sync-scheduler.ts), where the env-flag guard + the cron-secret
// check + the tick live. It is PRODUCTION-DISABLED (the allowlist env flag is false outside local dev) and cron-secret
// gated (NOT a public unauthenticated route); when disabled it returns 404 (hidden). It holds NO user session — the
// worker writes via the dev-user-JWT client (user-scoped RLS, never service-role). Production cron INFRA (Vercel cron)
// is NOT wired here — see docs/47. NOT customer-facing, NOT OAuth, NOT a runner.

import { handleSlackSchedulerRequest, runSlackSyncSchedulerTick, defaultSchedulerDeps } from "@/lib/server/sync/slack-sync-scheduler";

export async function POST(request: Request): Promise<Response> {
  const { status, body } = await handleSlackSchedulerRequest({
    env: process.env,
    secretHeader: request.headers.get("x-scheduler-secret"),
    runTick: () => runSlackSyncSchedulerTick(defaultSchedulerDeps()),
  });
  return Response.json(body, { status });
}
