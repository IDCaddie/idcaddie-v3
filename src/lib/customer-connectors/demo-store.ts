// P5E17 — the isolated PREVIEW/demo connection state (Phase 8). Browser sessionStorage ONLY — NEVER a production DB write, a
// connector row, a credential/OAuth/token/secret record, an ECS action, or a schedule. It holds ONLY a per-provider preview
// status + the (non-persisted-server-side) org host the customer typed + a timestamp. Easy to reset (clear the one key). Import-
// safe on the server (all ops no-op / return null when there is no window). Isolated key so it can never collide with real data.

export type DemoConnectionStatus = "connected_preview" | "paused_preview";
export type DemoConnection = { status: DemoConnectionStatus; orgHost: string | null; connectedAt: string };

const KEY = "idcaddie:demo-connectors:v1";
const EVENT = "idcaddie:demo-connectors:changed";

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

function readAll(): Record<string, DemoConnection> {
  if (!hasWindow()) return {};
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, DemoConnection>) : {};
  } catch {
    return {}; // corrupt/blocked storage → treat as no demo state (fail safe)
  }
}

function writeAll(map: Record<string, DemoConnection>): void {
  if (!hasWindow()) return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* storage blocked (private mode / quota) — the preview simply won't persist; no error surfaced */
  }
}

export function getDemoConnection(provider: string): DemoConnection | null {
  return readAll()[provider] ?? null;
}

// The raw serialized snapshot (stable string when unchanged) — a useSyncExternalStore-safe getSnapshot for reading the WHOLE map.
export function getDemoRaw(): string {
  if (!hasWindow()) return "";
  try { return window.sessionStorage.getItem(KEY) ?? ""; } catch { return ""; }
}
export function parseDemoRaw(raw: string): Record<string, DemoConnection> {
  if (!raw) return {};
  try { const p = JSON.parse(raw); return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, DemoConnection>) : {}; } catch { return {}; }
}

export function setDemoConnection(provider: string, conn: DemoConnection): void {
  const map = readAll();
  map[provider] = conn;
  writeAll(map);
}

export function clearDemoConnection(provider: string): void {
  const map = readAll();
  if (provider in map) { delete map[provider]; writeAll(map); }
}

export function resetAllDemoConnections(): void {
  if (!hasWindow()) return;
  try { window.sessionStorage.removeItem(KEY); window.dispatchEvent(new CustomEvent(EVENT)); } catch { /* ignore */ }
}

// Subscribe to demo-state changes (same-tab custom event + cross-tab storage event). Returns an unsubscribe fn.
export function subscribeDemoConnections(cb: () => void): () => void {
  if (!hasWindow()) return () => {};
  const onChange = () => cb();
  const onStorage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) cb(); };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(EVENT, onChange); window.removeEventListener("storage", onStorage); };
}
