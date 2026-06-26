import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { readSecretFromStream, ingestClientSecret } from "./client-secret-ingest-harness";
import type { AppSecretEnvelopeStore } from "./slack-client-secret-store";
import type { ConnectorVaultKeyProvider } from "./crypto";

// Phase C-pre: prove the Slack client secret (the OAuth master credential) can NEVER silently remain on disk.
// The B2 incident was a `shred`-on-macOS no-op leaving a 0600 temp file. The ingest CODE PATH must touch no disk at
// all, and the OPERATOR GUIDANCE must never recommend a bare `shred` (portable fail-loud only).
const SENTINEL = "MUSTNOTLEAK-c-pre-ingest-no-disk-sentinel";
const HERE = path.resolve(__dirname);
const REPO = path.resolve(HERE, "..", "..", "..", "..");
const CODE_MODULES = ["client-secret-ingest-harness.ts", "slack-client-secret-store.ts", "crypto.ts"];

const memKeyProvider: ConnectorVaultKeyProvider = {
  async generateDataKey() { return { dek: Buffer.alloc(32, 7), wrappedDek: Buffer.from("wrapped") }; },
  async unwrapDataKey() { return Buffer.alloc(32, 7); },
};
const memStore = (): AppSecretEnvelopeStore => ({
  async insertEnvelope() { return { secretId: "appsec-1" }; },
  async loadActiveEnvelope() { return null; },
});

describe("ingest path: the client secret never touches disk", () => {
  // SOUND proof (allowlist, not denylist): any on-disk write needs fs / fs/promises / child_process / os(tmpdir).
  // Asserting the ONLY imports are `node:crypto` + relative intra-package modules forecloses every disk path,
  // regardless of quote style / dynamic import / aliased sink name. Catches `from 'fs'`, require('fs'), import('fs').
  it("the code modules import ONLY node:crypto + relative modules (no fs/os/child_process)", () => {
    const SPEC = /(?:from\s+|(?:require|import)\s*\(\s*|import\s+)["']([^"']+)["']/g;
    const allowed = (s: string) => s.startsWith(".") || s === "node:crypto";
    for (const mod of CODE_MODULES) {
      const src = fs.readFileSync(path.join(HERE, mod), "utf8");
      const bad = [...src.matchAll(SPEC)].map((m) => m[1]).filter((s) => !allowed(s));
      expect(bad, `${mod} may import only node:crypto + relative modules — a disk/proc module would let the secret reach disk: ${bad.join(", ")}`).toEqual([]);
    }
  });

  // Defense-in-depth: even via a relative re-export, forbid the actual write/temp-file sink names.
  it("the code modules name no filesystem-write / temp-file sink", () => {
    const sinks = ["writeFile", "createWriteStream", "appendFile", "openSync", "writeSync", "writevSync", "tmpdir", "mkdtemp", "Bun.write", "Deno.write", "/tmp"];
    for (const mod of CODE_MODULES) {
      const src = fs.readFileSync(path.join(HERE, mod), "utf8");
      for (const tok of sinks) expect(src, `${mod} must not reference ${tok}`).not.toContain(tok);
    }
  });

  it("a full stdin → ingest run writes NO file containing the plaintext sentinel", async () => {
    const tmp = os.tmpdir();
    const before = new Set(fs.readdirSync(tmp));
    const plaintext = await readSecretFromStream(Readable.from([Buffer.from(SENTINEL + "\n")]));
    const result = await ingestClientSecret({ plaintext, appEnv: "staging", version: 1 }, { keyProvider: memKeyProvider, kekId: "kek-1", store: memStore() });
    expect(result).toEqual({ ok: true, secretId: "appsec-1" }); // redacted id only
    // inspect ONLY files created during the run (ignore unrelated pre-existing tmp files → no shared-tmpdir flakiness):
    for (const name of fs.readdirSync(tmp)) {
      if (before.has(name)) continue;
      const full = path.join(tmp, name);
      let body = "";
      try { if (fs.statSync(full).isFile()) body = fs.readFileSync(full, "utf8"); } catch { /* unreadable — skip */ }
      expect(body.includes(SENTINEL), `new temp file ${name} must not contain the secret`).toBe(false);
    }
  });

  it("operator guidance contains NO bare `shred` — every `shred -u` is paired with an `|| rm` portable fallback", () => {
    for (const rel of ["scripts/b2c-ingest-client-secret.mjs", "docs/45_B2C_RUN_FIRST_REAL_TOKEN_RUNBOOK.md"]) {
      const src = fs.readFileSync(path.join(REPO, rel), "utf8");
      const offenders = src.split("\n").filter((l) => /shred -u/.test(l) && !/\|\| rm/.test(l));
      expect(offenders, `${rel} has a bare \`shred -u\` (no \`|| rm\` fallback): ${offenders.join(" | ")}`).toEqual([]);
    }
  });
});
