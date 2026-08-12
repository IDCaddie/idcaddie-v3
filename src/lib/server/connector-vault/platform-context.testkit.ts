// TEST-ONLY. Installs the platform doubles on the REAL globals the runtime uses, because `exchangeForDedicatedAudience`
// deliberately has no injectable dependencies — see the trust rule in `vercel-platform-oidc.ts`. A double installed
// here cannot be reached through any production signature, which is the whole point: the previous `ExchangeDeps`
// parameter made the same doubles available to callers, and with them the raw platform token.
import { vi } from "vitest";

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

/** Install a platform request context carrying `token` (or none at all), exactly as Vercel's runtime does. */
export function withPlatformContext(token?: string): () => void {
  const g = globalThis as Record<symbol, unknown>;
  const had = VERCEL_REQUEST_CONTEXT in g;
  const prev = g[VERCEL_REQUEST_CONTEXT];
  g[VERCEL_REQUEST_CONTEXT] = { get: () => ({ headers: token === undefined ? {} : { "x-vercel-oidc-token": token } }) };
  return () => { if (had) g[VERCEL_REQUEST_CONTEXT] = prev; else delete g[VERCEL_REQUEST_CONTEXT]; };
}

/** Stub the global `fetch` the exchange uses. Returns a restore function. */
export function withFetch(impl: (url: string, init: { body?: string; signal?: AbortSignal }) => Promise<Response>): () => void {
  vi.stubGlobal("fetch", impl as unknown as typeof fetch);
  return () => vi.unstubAllGlobals();
}

/** Both at once, for the common case. */
export function withPlatform(token: string | undefined, impl: Parameters<typeof withFetch>[0]): () => void {
  const a = withPlatformContext(token);
  const b = withFetch(impl);
  return () => { b(); a(); };
}
