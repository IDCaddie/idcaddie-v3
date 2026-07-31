import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveLifecycle, maskClientId, OKTA_LIFECYCLE_LABEL } from "./okta-connector-status";
import { OKTA_JWKS_URL, OKTA_SETUP } from "@/lib/customer-connectors/okta-content";

// ── Lifecycle ───────────────────────────────────────────────────────────────────────────────────────────────
// The lifecycle is what the customer reads to decide whether anything is wrong. Its job is to distinguish three
// stages that a single database enum flattens, and to never let a saved configuration read as a live connection.
describe("deriveLifecycle", () => {
  it("treats a saved-but-unverified configuration as verification pending, NOT connected", () => {
    expect(deriveLifecycle("configured", "never_validated")).toBe("verification_pending");
    expect(OKTA_LIFECYCLE_LABEL.verification_pending).toBe("Verification pending");
    // Nothing in the vocabulary may say "connected" — that word is the whole failure mode this guards.
    for (const label of Object.values(OKTA_LIFECYCLE_LABEL)) expect(label.toLowerCase()).not.toContain("connected");
  });

  it("separates verification from discovery", () => {
    expect(deriveLifecycle("verified", "succeeded")).toBe("verified");
    expect(deriveLifecycle("discovery_pending", "succeeded")).toBe("initial_discovery_pending");
    expect(deriveLifecycle("discovering", "succeeded")).toBe("discovering");
    expect(deriveLifecycle("discovered", "succeeded")).toBe("discovered");
  });

  it("lets a FAILED validation win over an optimistic connection state", () => {
    // The failure is the actionable fact. Reporting "discovered" while validation failed would bury it.
    expect(deriveLifecycle("discovered", "failed")).toBe("failed");
    expect(deriveLifecycle("configured", "failed")).toBe("failed");
    expect(deriveLifecycle("error", "never_validated")).toBe("failed");
    expect(deriveLifecycle("partial_failure", "succeeded")).toBe("failed");
  });

  it("never invents a stage for an unknown state", () => {
    expect(deriveLifecycle(null, null)).toBe("configuration_saved");
    expect(deriveLifecycle("something_new", null)).toBe("configuration_saved");
  });
});

describe("maskClientId", () => {
  it("keeps the shape recognisable without printing the whole value", () => {
    expect(maskClientId("0oa15fcokefFqDREa698")).toBe("0oa15f…a698");
  });
  it("leaves a short value alone rather than producing a misleading mask", () => {
    expect(maskClientId("0oa123")).toBe("0oa123");
  });
});

// ── Setup instructions ──────────────────────────────────────────────────────────────────────────────────────
// A customer following these must end up with an app our signer can actually authenticate against. Before O2C.2
// the copy told them to paste a static public key; the real app is configured with a JWKS URL, so that guidance
// would have produced a broken connector.
describe("Okta setup instructions", () => {
  it("names the JWKS URL, and it matches the published manifest exactly", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "src/lib/customer-connectors/okta-jwks-manifest.json"), "utf8")) as { jwks_url: string };
    expect(OKTA_JWKS_URL).toBe(manifest.jwks_url);
    expect(OKTA_JWKS_URL).toMatch(/^https:\/\//);
  });

  it("teaches the dynamic-URL method and NOT pasting a static key", () => {
    const blob = JSON.stringify(OKTA_SETUP);
    expect(blob).toMatch(/fetch keys dynamically/i);
    expect(blob).not.toMatch(/paste ID Caddie's public key/i);
    expect(blob).not.toMatch(/Public Keys tab/i);
  });

  it("says Okta generates the client ID, so it cannot read as ID Caddie issuing it", () => {
    expect(OKTA_SETUP.clientIdHint).toMatch(/Okta generates the client ID/i);
    expect(OKTA_SETUP.clientIdHint).toMatch(/ID Caddie does not issue it/i);
  });

  it("still names all three scopes and the exact admin role", () => {
    expect(OKTA_SETUP.declareScope).toMatch(/okta\.users\.read/);
    expect(OKTA_SETUP.declareScope).toMatch(/okta\.groups\.read/);
    expect(OKTA_SETUP.declareScope).toMatch(/okta\.apps\.read/);
    expect(OKTA_SETUP.roleStepNote).toMatch(/Read Only Administrator/);
    expect(OKTA_SETUP.roleStepNote).toMatch(/Do not assign Super Admin/i);
  });

  it("states the operator-assisted reality instead of promising self-service", () => {
    expect(OKTA_SETUP.operatorAssistedNote).toMatch(/operator-assisted/i);
    expect(OKTA_SETUP.operatorAssistedNote).toMatch(/ID Caddie operations/i);
    // The terminal state is named for what was achieved, not for the next stage.
    expect(OKTA_SETUP.savedTitle).toBe("Configuration saved");
    expect(OKTA_SETUP.savedTitle.toLowerCase()).not.toContain("connected");
  });

  it("carries no obsolete platform-readiness dead end", () => {
    // "no action needed from you" with no resolving action was the single worst onboarding outcome: it told a new
    // customer to wait for a platform condition that had already been satisfied.
    expect(JSON.stringify(OKTA_SETUP)).not.toMatch(/finishing its signing-key setup|no action needed from you/i);
  });
});
