// G1A — the IDCaddie V3 half of the cross-repository Google Workspace contract anchor.
//
// The connector-runner ships `contracts/google-workspace-provider-contract.v1.json` and asserts a pinned hash over it. This
// repository ships the SAME artifact at the SAME relative path and asserts the SAME literal hash. The two repositories share
// no package, so a byte-identical artifact plus an identical pinned hash in each is what turns divergence into a one-line
// diff rather than a live-connection failure nobody sees until a customer connects.
//
// It also binds the artifact to `provider-registry.requiredScopes`. That binding is the specific lesson from Slack: the
// registry's scope list is NOT display metadata — it is the set actually requested — and it sat one scope short for months
// because nothing compared it to what the connector declared it would call. Google has no executor-program manifest with
// `endpoints` to compare against (it is a native connector), so the contract artifact is the counterpart here.
//
// Reads only NON-SECRET declarations. No key, no secret value, and no Google call is involved anywhere.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getConnectorProvider } from "./provider-registry";

const ARTIFACT = join(process.cwd(), "contracts", "google-workspace-provider-contract.v1.json");

// This exact literal ALSO appears in the connector-runner's mirror of this test
// (test/connector-sync/google-workspace-contract.test.ts). Changing the contract REQUIRES bumping contract_version and
// updating this literal in BOTH repositories.
const PINNED_CONTRACT_VERSION = "1.0.0";
const PINNED_CONTRACT_HASH = "6b61bc961a36a5ce674a8c0bfec8b4737cf9f2b2cc30c385672b4eba05baec46";

type Contract = {
  contract_version: string;
  provider: string;
  auth_mode: string;
  approved_scopes: string[];
  write_capable_scopes: string[];
  allowed_hosts: string[];
  token_host: string;
  delegated_admin_required: boolean;
  lifecycle_status: string;
  read_only: boolean;
  live_key_verification: string;
};

const contract = JSON.parse(readFileSync(ARTIFACT, "utf8")) as Contract;

// The same canonicalization the runner uses: keys sorted, arrays in their already-sorted order, no insignificant
// whitespace. Kept as a few lines here rather than imported, because the point is that the two repositories agree WITHOUT
// sharing code — an imported helper could drift in lockstep and prove nothing.
function canonicalize(c: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(c).sort()) ordered[k] = c[k];
  return JSON.stringify(ordered);
}
const hash = (c: Record<string, unknown>) => createHash("sha256").update(canonicalize(c), "utf8").digest("hex");

describe("google workspace contract — cross-repository anchor", () => {
  it("matches the pinned version and hash asserted in the connector-runner", () => {
    expect(contract.contract_version).toBe(PINNED_CONTRACT_VERSION);
    expect(hash(contract as unknown as Record<string, unknown>)).toBe(PINNED_CONTRACT_HASH);
  });

  it("declares a read-only, delegated, certification-only JWT-bearer connector", () => {
    expect(contract.provider).toBe("google_workspace");
    expect(contract.auth_mode).toBe("service_account_jwt_bearer");
    expect(contract.read_only).toBe(true);
    expect(contract.delegated_admin_required).toBe(true);
    expect(contract.lifecycle_status).toBe("certificationOnly");
    expect(contract.live_key_verification).toBe("outstanding");
  });

  it("declares apps.licensing as the one write-capable scope, out loud", () => {
    // Google publishes no `.readonly` variant, so the exception is unavoidable — but it must be visible, not implicit.
    expect(contract.write_capable_scopes).toEqual(["https://www.googleapis.com/auth/apps.licensing"]);
    for (const s of contract.approved_scopes) {
      expect(s.endsWith(".readonly") || contract.write_capable_scopes.includes(s)).toBe(true);
    }
  });

  it("keeps the token host out of the API host allowlist", () => {
    expect(contract.allowed_hosts).not.toContain(contract.token_host);
    expect(contract.allowed_hosts).not.toContain("googleapis.com"); // the parent fronts hundreds of unrelated APIs
  });
});

describe("the registry requests exactly the contract's scopes", () => {
  it("provider-registry requiredScopes equals approved_scopes, order-independently", () => {
    // The Slack lesson, applied before it can bite: this list IS what gets requested, so it is compared to the
    // declaration rather than trusted as a label.
    const requested = [...(getConnectorProvider("google_workspace")?.requiredScopes ?? [])].sort();
    expect(requested).toEqual([...contract.approved_scopes].sort());
  });

  it("the reviewed set is these four and nothing else", () => {
    expect([...(getConnectorProvider("google_workspace")?.requiredScopes ?? [])].sort()).toEqual([
      "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
      "https://www.googleapis.com/auth/admin.directory.group.readonly",
      "https://www.googleapis.com/auth/admin.directory.user.readonly",
      "https://www.googleapis.com/auth/apps.licensing",
    ]);
  });

  it("requests no Gmail, Drive, Calendar or Cloud-Platform scope", () => {
    // The scopes a directory connector must never hold: they read message and file CONTENT, not access metadata.
    for (const s of getConnectorProvider("google_workspace")?.requiredScopes ?? []) {
      expect(s).not.toMatch(/gmail|drive|calendar|cloud-platform|spreadsheets|documents/i);
    }
  });

  it("requests no scope outside the Google auth namespace", () => {
    for (const s of getConnectorProvider("google_workspace")?.requiredScopes ?? []) {
      expect(s.startsWith("https://www.googleapis.com/auth/")).toBe(true);
    }
  });

  it("stays disabled and unconnectable", () => {
    const p = getConnectorProvider("google_workspace");
    expect(p?.enabled).toBe(false);
    expect(p?.status).toBe("future");
  });
});
