// Phase 5 — PURE connector presentation: no I/O, no server import, safe in any bundle.
//
// Split out of connector-management (which reaches the server-only repository) for the same reason directory-display and
// okta-lifecycle were: the management components need these, and importing the loader would drag `next/headers` into the browser.

export type ConnectorLifecycle = "configured" | "verified" | "discovering" | "discovered" | "failed" | "superseded" | "disconnected";

export const CONNECTOR_LIFECYCLE_LABEL: Record<ConnectorLifecycle, string> = {
  configured: "Configuration saved",
  verified: "Verified",
  discovering: "Discovering",
  discovered: "Discovered",
  failed: "Failed",
  superseded: "Replaced",
  disconnected: "Disconnected",
};

// Health is a READING of evidence, not a stored field — nothing writes a health column, and inventing one would let it drift from
// the facts it summarises. Each value is derived from the lifecycle plus the last run, and each has a stated reason so the page
// never shows a colour without a cause.
export type ConnectorHealth = "healthy" | "attention" | "failed" | "inactive" | "pending";
export type ConnectorHealthView = { readonly state: ConnectorHealth; readonly label: string; readonly reason: string };

export function connectorHealth(r: { lifecycle: string; last_run_status: string | null; last_run_failure_code: string | null; last_discovery_at: string | null }): ConnectorHealthView {
  if (r.lifecycle === "disconnected") return { state: "inactive", label: "Disconnected", reason: "Retired by an operator. Its records and history are retained and excluded from active views." };
  if (r.lifecycle === "superseded") return { state: "inactive", label: "Replaced", reason: "Another connector took over this organization. Its records and history are retained and excluded from active views." };
  if (r.lifecycle === "failed") return { state: "failed", label: "Needs attention", reason: r.last_run_failure_code ? `Last attempt reported: ${r.last_run_failure_code.replace(/_/g, " ")}.` : "The last verification or discovery attempt failed." };
  if (r.last_run_status === "failed") return { state: "attention", label: "Last run failed", reason: r.last_run_failure_code ? `The most recent run reported: ${r.last_run_failure_code.replace(/_/g, " ")}.` : "The most recent run did not complete." };
  if (r.lifecycle === "discovered") return { state: "healthy", label: "Healthy", reason: "Verified and discovery has completed." };
  if (r.lifecycle === "discovering") return { state: "pending", label: "Discovering", reason: "A discovery run is in progress." };
  if (r.lifecycle === "verified") return { state: "pending", label: "Awaiting discovery", reason: "Verified, but no discovery has completed yet." };
  return { state: "pending", label: "Awaiting verification", reason: "Configuration saved; the connection has not been verified yet." };
}

