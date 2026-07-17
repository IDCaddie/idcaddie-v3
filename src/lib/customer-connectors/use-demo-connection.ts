"use client";
import { useMemo, useSyncExternalStore } from "react";
import { getDemoRaw, parseDemoRaw, subscribeDemoConnections, type DemoConnection } from "./demo-store";

// The raw serialized snapshot of ALL demo connections (a STABLE string — Object.is-equal when unchanged, so it is a valid
// useSyncExternalStore getSnapshot). The marketplace parses it for status filtering; per-provider reads derive from it too.
export function useDemoConnectionsRaw(): string {
  return useSyncExternalStore(subscribeDemoConnections, getDemoRaw, () => "");
}

// Reactive read of the sessionStorage demo connection for one provider. Derived from the stable raw snapshot (NOT a fresh
// getDemoConnection() each render — that returns a new object every call and would break the getSnapshot stability contract).
// Keeps every card / detail / status view in sync on connect / pause / disconnect, same-tab + cross-tab. Server snapshot is null.
export function useDemoConnection(provider: string): DemoConnection | null {
  const raw = useDemoConnectionsRaw();
  return useMemo(() => parseDemoRaw(raw)[provider] ?? null, [raw, provider]);
}
