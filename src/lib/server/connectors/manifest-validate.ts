// Validate reviewed provider manifests (docs/54, Phase 1a). INERT — reads `.json` ONLY from the reviewed, image-baked
// manifests dir; it NEVER loads a manifest from a tenant, DB row, env var, URL, or arbitrary runtime string (there is
// intentionally NO such API). On top of the strict schema it adds a secret-shape scan and a provider-id registry check.
// Fails closed. No fetch, no DB, no token, no sync. RISK-007 stays OPEN; Phase C stays BLOCKED.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderManifestSchema, type ProviderManifest } from "./manifest-schema";
import { isSupportedConnectorProvider } from "../connector-vault/provider-registry";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connectors/manifest-validate is server-only and must not be imported in client code");
}

// The ONE reviewed source of manifests (image-baked). There is intentionally no parameter to load from anywhere else.
export const MANIFESTS_DIR = fileURLToPath(new URL("./manifests", import.meta.url));

// Known secret shapes — a manifest carrying ANY of these is rejected (a manifest must never contain a credential/token).
const SECRET_SHAPES: readonly RegExp[] = [
  /xox[baprs]-[0-9A-Za-z-]{6,}/, // Slack tokens
  /xapp-[0-9A-Za-z-]{6,}/,
  /AKIA[0-9A-Z]{16}/, /ASIA[0-9A-Z]{16}/, // AWS keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /:\/\/[^/\s:@]+:[^/\s@]+@/, // credentials embedded in a URL
  /\bBearer\s+[A-Za-z0-9._-]{12,}/, // a literal bearer token
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[0-9A-Za-z_]{20,}/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/, // JWT
];

export type ManifestValidationResult = { ok: true; manifest: ProviderManifest } | { ok: false; errors: string[] };

// Validate an already-parsed object as a manifest. `source` is a label for messages only (a filename) — never a load target.
export function validateManifestObject(raw: unknown, source: string): ManifestValidationResult {
  const errors: string[] = [];
  // secret-shape scan over the RAW JSON text, independent of the schema
  const text = JSON.stringify(raw);
  for (const re of SECRET_SHAPES) {
    if (re.test(text)) { errors.push(`${source}: contains a secret-shaped string — a manifest must never carry a credential`); break; }
  }
  const parsed = ProviderManifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const iss of parsed.error.issues) errors.push(`${source}: ${iss.path.join(".") || "(root)"}: ${iss.message}`);
  } else if (!isSupportedConnectorProvider(parsed.data.provider_id)) {
    errors.push(`${source}: provider_id '${parsed.data.provider_id}' is not a supported connector provider`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: parsed.data as ProviderManifest };
}

// Validate every *.json manifest in the reviewed dir. This is the CI gate. Fails if the dir is empty.
export function validateManifestsDir(dir: string = MANIFESTS_DIR): { ok: boolean; results: Record<string, ManifestValidationResult> } {
  const results: Record<string, ManifestValidationResult> = {};
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(join(dir, f), "utf8")); }
    catch { results[f] = { ok: false, errors: [`${f}: not valid JSON`] }; continue; }
    results[f] = validateManifestObject(raw, f);
  }
  const ok = files.length > 0 && Object.values(results).every((r) => r.ok);
  return { ok, results };
}
