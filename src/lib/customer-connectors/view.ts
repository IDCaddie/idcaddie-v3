// P5E17 — client-safe presentation derivation (label / tone / CTA) from a CustomerConnector + the sessionStorage demo state.
// PURE, no server import (type-only import of CustomerConnector is erased) so client cards/detail can use it. This is where the
// customer-facing status WORDING lives — never an internal lifecycle label.
import type { CustomerConnector } from "./catalog-types";
import type { DemoConnection } from "./demo-store";
import type { StatusTone } from "@/components/status-tokens";

export type ConnectorView = {
  statusLabel: string; // "Connected" | "Paused" | "Preview" | "Coming soon"
  statusTone: StatusTone;
  statusNote: string | null; // e.g. "Preview mode"
  cta: { label: string; href: string | null; disabled: boolean };
};

export function resolveConnectorView(c: CustomerConnector, demo: DemoConnection | null): ConnectorView {
  if (demo?.status === "verification_pending") {
    // Configuration saved, NOT verified/connected — never present this as connected/active.
    return { statusLabel: "Verification pending", statusTone: "attention", statusNote: "Configuration saved", cta: { label: "View configuration", href: `/connectors/${c.provider}/status`, disabled: false } };
  }
  if (demo?.status === "connected_preview") {
    return { statusLabel: "Connected", statusTone: "success", statusNote: "Preview mode", cta: { label: "Manage", href: `/connectors/${c.provider}/status`, disabled: false } };
  }
  if (demo?.status === "paused_preview") {
    return { statusLabel: "Paused", statusTone: "attention", statusNote: "Preview mode", cta: { label: "Manage", href: `/connectors/${c.provider}/status`, disabled: false } };
  }
  if (c.availability === "coming_soon") {
    return { statusLabel: "Coming soon", statusTone: "neutral", statusNote: null, cta: { label: "Coming soon", href: null, disabled: true } };
  }
  // availability = preview
  if (c.canConnect) {
    return { statusLabel: "Preview", statusTone: "attention", statusNote: null, cta: { label: `Connect ${c.displayName}`, href: `/connectors/${c.provider}`, disabled: false } };
  }
  return { statusLabel: "Preview", statusTone: "neutral", statusNote: "Connection coming soon", cta: { label: "View details", href: `/connectors/${c.provider}`, disabled: false } };
}

// The status-filter buckets for the marketplace.
export type StatusFilter = "all" | "connected" | "available" | "coming_soon";
export function matchesStatusFilter(c: CustomerConnector, demo: DemoConnection | null, filter: StatusFilter): boolean {
  const connected = demo?.status === "connected_preview" || demo?.status === "paused_preview";
  switch (filter) {
    case "connected": return connected;
    case "available": return !connected && c.availability === "preview";
    case "coming_soon": return !connected && c.availability === "coming_soon";
    default: return true;
  }
}
