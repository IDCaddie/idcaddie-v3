// Pure, no-I/O read-model logic for the Slack P0 read-only display (PR 5). Identifies a connector-SYNCED app and
// provides the safe, no-false-readiness display copy. No DB, no client import, no secrets — only the non-secret
// AppDetail markers (external_instance_id + vendor_name) are read.
//
// Identification: an app is treated as Slack-synced when it has a connector instance id (external_instance_id — the
// resolver set this to the Slack team_id, migration 0024) AND its vendor is "Slack". The instance id is a STRUCTURAL
// marker (set by PR #190's resolver), not display-name-only inference, and not a token/secret. There is no first-class
// `provider`/`source` enum column today (the provider also lives in app_users.raw_payload, which the read DAL excludes);
// a future schema enhancement could add one — documented read-model note, not a blocker.

export type SlackSyncInput = { externalInstanceId: string | null; vendorName: string | null };
export type SlackSyncView = { isSlackSynced: boolean; workspaceId: string | null };

export function classifySlackSync(input: SlackSyncInput | null | undefined): SlackSyncView {
  const id = typeof input?.externalInstanceId === "string" ? input.externalInstanceId.trim() : "";
  const vendor = typeof input?.vendorName === "string" ? input.vendorName.trim().toLowerCase() : "";
  const isSlackSynced = id.length > 0 && vendor === "slack";
  return { isSlackSynced, workspaceId: isSlackSynced ? id : null };
}

// Safe display copy. NO false-readiness language — never "Connect Slack" / "Run sync" / "OAuth ready" / "Production
// connector ready". This is a read-only preview; the manual run trigger is a later PR.
export const SLACK_SYNC_COPY = {
  badge: "Synced from Slack",
  preview: "Read-only Slack sync preview",
  description:
    "Members discovered from your Slack workspace.",
  usersHeading: "Synced Slack users",
  emptyUsers: "No synced Slack users yet — Slack data will appear here after a sync run.",
  comingNext: "",
} as const;

// Safe, human labels for a manual_sync_runs.status — no false-readiness language. Any unknown value falls back to the
// raw string (never throws). Pure; no I/O.
export const SLACK_RUN_STATUS_LABEL: Record<"running" | "succeeded" | "failed", string> = {
  running: "In progress",
  succeeded: "Succeeded",
  failed: "Failed",
};
export function slackRunStatusLabel(status: string): string {
  return (SLACK_RUN_STATUS_LABEL as Record<string, string>)[status] ?? status;
}
