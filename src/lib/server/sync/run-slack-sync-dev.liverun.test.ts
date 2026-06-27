import { describe, it, expect } from "vitest";
import { runSlackSyncDev, isDevSlackSyncRunEnabled } from "./run-slack-sync-dev";
import { createDevProviderTokenSource } from "./provider-token-source";
import { createDevUserScopedClient } from "./dev-user-scoped-client";
import { createSupabaseSlackResolverStore } from "./supabase-slack-resolver-store";
import { slackFetchHttpClient } from "./slack-fetch-http-client";

// THE real committed manual-run command: `npm run slack:sync:dev`. It builds the REAL deps and invokes runSlackSyncDev
// (dev-token source #187 → Slack client #188 → emitter #189 → resolver store #190 → tenant-scoped DB rows), then prints
// ONLY the safe aggregate summary. DOUBLE-gated — runs only when the dev opt-in (ID_CADDIE_DEV_SLACK_SYNC_ENABLED=1) AND
// SLACK_SYNC_LIVE=1 are both set — so it is SKIPPED in normal `npm test` and in CI, and no client/network is built at
// import time. Server-only, local/dev-only; NOT a route/action/UI button/scheduler/production path.
//
// Operator (LOCAL DEV ONLY; rotated dev Slack token + dev tenant-member JWT, both via env — never argv, never echoed):
//   ID_CADDIE_DEV_SLACK_SYNC_ENABLED=1 SLACK_SYNC_LIVE=1 ID_CADDIE_DEV_PROVIDER_TOKEN_SOURCE_ENABLED=1 \
//   ID_CADDIE_DEV_SLACK_TOKEN=<dev token> ID_CADDIE_DEV_USER_JWT=<dev member JWT> \
//   SLACK_SYNC_TENANT_ID=<tenant uuid> SLACK_SYNC_CONNECTOR_ID=<connector id> npm run slack:sync:dev

const LIVE = isDevSlackSyncRunEnabled(process.env) && process.env.SLACK_SYNC_LIVE === "1";

describe.runIf(LIVE)("LIVE manual Slack sync run (local dev only)", () => {
  it("runs the full chain and prints ONLY a safe aggregate summary (no token/JWT/email/name/raw)", async () => {
    const env = process.env;
    const summary = await runSlackSyncDev({
      env,
      tokenSource: createDevProviderTokenSource(env),
      httpClient: slackFetchHttpClient,
      store: createSupabaseSlackResolverStore(createDevUserScopedClient(env)),
      identity: { tenantId: env.SLACK_SYNC_TENANT_ID ?? "", connectorId: env.SLACK_SYNC_CONNECTOR_ID ?? "slack-dev" },
      observedAt: new Date().toISOString(),
    });
    // SAFE aggregate ONLY — RunSlackSyncSummary is counts/booleans (or a safe errorCode); no token/JWT/email/name/raw.
    console.log("[slack-sync-dev] summary:", JSON.stringify(summary));
    expect(summary.ok).toBe(true);
  }, 60_000);
});
