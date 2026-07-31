// O1B — fail-closed consistency between the canonical Okta contract artifact, V3's server-only provider contract, and the
// customer-facing setup copy.
//
// The MIRROR of idcaddie-connector-runner's test/connector-sync/okta-contract-consistency.test.ts. Both repositories assert the
// SAME pinned hash over the SAME artifact; neither checks out the other, so divergence shows up as a one-line diff instead of a
// live connection that fails after the customer has already configured their Okta application.
//
// Reads only NON-SECRET declarations. No private key, no token, no Okta call.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { OKTA_APPROVED_SCOPES, OKTA_PROHIBITED_SCOPES, scopesExactlyApproved, OKTA_LIFECYCLE } from "./okta-provider-contract";
import { OKTA_CONTENT, OKTA_SETUP, OKTA_APPROVED_PUBLIC_KID, validateOktaOrgHost, normalizeOrgInput } from "@/lib/customer-connectors/okta-content";

// ── The pinned cross-repository contract ────────────────────────────────────────────────────────────────────────
// This exact literal also appears in the connector-runner's mirror of this test. Changing the contract REQUIRES bumping
// contract_version and updating this literal in BOTH repositories.
const PINNED_CONTRACT_VERSION = "1.2.0";
const PINNED_CONTRACT_HASH = "9fa5f390e91c5323de527ff608640a5daa624fc1e44723e9432064113e114654";

// Superseded values live HERE, in the test — never in the artifact or in shipped copy, where a consumer could read one by mistake.
const STALE_KID = "i-Wptr6usN1tpkNp17vHXv_Mar4NPz53rn-bmlTq8j4";
// Retired by the O2C.2 cutover. Like STALE_KID it must never appear in the artifact or in customer-facing copy; unlike it, prose
// in docs/ may still record it as superseded, so it is applied to active declarations rather than to a repo-wide text scan.
const RETIRED_KID = "VDkZAQoJl_prLRU83WiPreOBGoP6Fib3qC0CG880wz0";
const SUPERSEDED_KIDS: readonly string[] = [STALE_KID, RETIRED_KID];
const SUPERSEDED_SCOPE_SETS: readonly (readonly string[])[] = [
  ["okta.users.read"],
  ["okta.users.read", "okta.groups.read"],
];

const CONTRACT_PATH = join(process.cwd(), "contracts", "okta-provider-contract.v1.json");
const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as Record<string, unknown>;

// Same canonicalization as the runner: keys sorted, no insignificant whitespace. Formatting must not change the hash.
function canonicalize(o: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) ordered[k] = o[k];
  return JSON.stringify(ordered);
}

describe("okta contract artifact — identical to the connector-runner's", () => {
  it("matches the pinned version and hash", () => {
    expect(contract.contract_version).toBe(PINNED_CONTRACT_VERSION);
    expect(createHash("sha256").update(canonicalize(contract), "utf8").digest("hex")).toBe(PINNED_CONTRACT_HASH);
  });

  it("declares the authoritative three read scopes, sorted", () => {
    expect(contract.approved_scopes).toEqual(["okta.apps.read", "okta.groups.read", "okta.users.read"]);
  });

  it("declares the authoritative staging KID, read-only, private_key_jwt, certificationOnly", () => {
    expect(contract.staging_public_key_kid).toBe("p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto");
    expect(contract.read_only).toBe(true);
    expect(contract.auth_mode).toBe("oauth_private_key_jwt");
    expect(contract.lifecycle_status).toBe("certificationOnly");
    // Repository consistency is NOT proof the key is registered on the real Okta application.
    expect(contract.live_kid_verification).toBe("verified");
  });

  it("carries no stale KID and no write scope", () => {
    const text = readFileSync(CONTRACT_PATH, "utf8");
    for (const k of SUPERSEDED_KIDS) expect(text).not.toContain(k);
    expect(text).not.toMatch(/okta\.[a-z.]+\.(manage|write)/);
    expect(text).not.toMatch(/BEGIN|PRIVATE KEY/);
  });
});

// ── Server contract agrees with the artifact ─────────────────────────────────────────────────────────────────────
describe("okta-provider-contract agrees with the artifact", () => {
  it("OKTA_APPROVED_SCOPES equals the contract set, order-independently", () => {
    expect([...OKTA_APPROVED_SCOPES].sort()).toEqual(contract.approved_scopes);
  });

  it("no approved scope is also prohibited — the O1B apps.read contradiction cannot return", () => {
    for (const s of OKTA_APPROVED_SCOPES) {
      expect(OKTA_PROHIBITED_SCOPES as readonly string[], `${s} is both approved and prohibited`).not.toContain(s);
    }
    // The specific regression: okta.apps.read was listed as prohibited while the runner required it.
    expect(OKTA_PROHIBITED_SCOPES as readonly string[]).not.toContain("okta.apps.read");
    // …while application WRITES stay prohibited. That is the distinction that was conflated.
    expect(OKTA_PROHIBITED_SCOPES as readonly string[]).toContain("okta.apps.manage");
    expect(OKTA_PROHIBITED_SCOPES as readonly string[]).toContain("okta.groups.manage");
    expect(OKTA_PROHIBITED_SCOPES as readonly string[]).toContain("okta.users.manage");
  });

  it("every approved scope is a read scope", () => {
    for (const s of OKTA_APPROVED_SCOPES) expect(s.endsWith(".read")).toBe(true);
  });

  it("lifecycle is certificationOnly, matching the contract", () => {
    expect(OKTA_LIFECYCLE).toBe(contract.lifecycle_status);
  });
});

// ── The validator matrix ────────────────────────────────────────────────────────────────────────────────────────
describe("scopesExactlyApproved", () => {
  it("accepts all three required scopes", () => {
    expect(scopesExactlyApproved(["okta.users.read", "okta.groups.read", "okta.apps.read"])).toEqual({ ok: true });
  });

  it("scope ordering is irrelevant", () => {
    const orders = [
      ["okta.apps.read", "okta.groups.read", "okta.users.read"],
      ["okta.groups.read", "okta.users.read", "okta.apps.read"],
      ["okta.apps.read", "okta.users.read", "okta.groups.read"],
      ["okta.users.read", "okta.apps.read", "okta.groups.read"],
    ];
    for (const o of orders) expect(scopesExactlyApproved(o), o.join(",")).toEqual({ ok: true });
  });

  it("rejects the superseded two-scope set as incomplete, naming the missing scope", () => {
    expect(scopesExactlyApproved(["okta.users.read", "okta.groups.read"]))
      .toEqual({ ok: false, reason: "missing_required_scope", missing: ["okta.apps.read"] });
  });

  it("rejects the users-only set as incomplete, naming both missing scopes", () => {
    expect(scopesExactlyApproved(["okta.users.read"]))
      .toEqual({ ok: false, reason: "missing_required_scope", missing: ["okta.groups.read", "okta.apps.read"] });
  });

  it("rejects every superseded set", () => {
    for (const set of SUPERSEDED_SCOPE_SETS) {
      const r = scopesExactlyApproved(set);
      expect(r.ok, set.join(",")).toBe(false);
      expect(r.ok === false && r.reason).toBe("missing_required_scope");
    }
  });

  it("rejects a manage scope as prohibited, not merely unknown", () => {
    for (const bad of ["okta.users.manage", "okta.groups.manage", "okta.apps.manage", "okta.users.write", "okta.apps.write"]) {
      expect(scopesExactlyApproved([...OKTA_APPROVED_SCOPES, bad]), bad).toEqual({ ok: false, reason: "prohibited" });
    }
  });

  it("rejects a manage scope even when it is the ONLY scope", () => {
    expect(scopesExactlyApproved(["okta.users.manage"])).toEqual({ ok: false, reason: "prohibited" });
  });

  it("rejects an unknown write-verb scope the prohibited list does not enumerate", () => {
    // The explicit list cannot be exhaustive; the `.manage`/`.write` suffix rule is the backstop.
    expect(scopesExactlyApproved([...OKTA_APPROVED_SCOPES, "okta.devices.manage"])).toEqual({ ok: false, reason: "prohibited" });
  });

  it("rejects an extra unknown READ scope — the policy is the exact set", () => {
    // `okta.devices.read` is a real Okta read scope that is NOT on the prohibited list — so it exercises the exact-set rule
    // rather than the prohibited rule.
    expect(scopesExactlyApproved([...OKTA_APPROVED_SCOPES, "okta.devices.read"]))
      .toEqual({ ok: false, reason: "unknown_scope", extra: ["okta.devices.read"] });
    expect(scopesExactlyApproved([...OKTA_APPROVED_SCOPES, "openid"]))
      .toEqual({ ok: false, reason: "unknown_scope", extra: ["openid"] });
  });

  it("an ENUMERATED read scope still reports as prohibited, not merely unknown", () => {
    // okta.logs.read and okta.factors.read are explicitly prohibited capabilities. Reporting them as a generic unknown extra
    // would understate what the customer granted.
    expect(scopesExactlyApproved([...OKTA_APPROVED_SCOPES, "okta.logs.read"])).toEqual({ ok: false, reason: "prohibited" });
    expect(scopesExactlyApproved([...OKTA_APPROVED_SCOPES, "okta.factors.read"])).toEqual({ ok: false, reason: "prohibited" });
  });

  it("duplicates are REJECTED, not de-duplicated — a caller's inconsistent view is not silently repaired", () => {
    expect(scopesExactlyApproved(["okta.users.read", "okta.users.read", "okta.groups.read", "okta.apps.read"]))
      .toEqual({ ok: false, reason: "duplicate" });
  });

  it("normalizes surrounding whitespace and case only", () => {
    expect(scopesExactlyApproved([" okta.users.read ", "OKTA.GROUPS.READ", "Okta.Apps.Read"])).toEqual({ ok: true });
    // a duplicate created BY normalization is still caught
    expect(scopesExactlyApproved(["okta.users.read", " OKTA.USERS.READ ", "okta.groups.read", "okta.apps.read"]))
      .toEqual({ ok: false, reason: "duplicate" });
  });

  it("rejects a malformed name rather than repairing it", () => {
    for (const bad of ["okta users read", "okta.users read", "okta.\tusers.read"]) {
      expect(scopesExactlyApproved([bad, "okta.groups.read", "okta.apps.read"]), bad).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("rejects empty, whitespace-only, null and non-array input", () => {
    expect(scopesExactlyApproved([])).toEqual({ ok: false, reason: "empty" });
    expect(scopesExactlyApproved(null)).toEqual({ ok: false, reason: "empty" });
    expect(scopesExactlyApproved(undefined)).toEqual({ ok: false, reason: "empty" });
    expect(scopesExactlyApproved(["okta.users.read", ""])).toEqual({ ok: false, reason: "empty" });
    expect(scopesExactlyApproved(["okta.users.read", "   "])).toEqual({ ok: false, reason: "empty" });
    expect(scopesExactlyApproved(["okta.users.read", 42 as unknown as string])).toEqual({ ok: false, reason: "empty" });
  });

  it("diagnostics carry only scope names — no token, assertion, or raw OAuth response can leak", () => {
    const results = [
      scopesExactlyApproved(["okta.users.read"]),
      scopesExactlyApproved([...OKTA_APPROVED_SCOPES, "okta.logs.read"]),
      scopesExactlyApproved([...OKTA_APPROVED_SCOPES, "okta.users.manage"]),
      scopesExactlyApproved(["okta users read"]),
    ];
    for (const r of results) {
      const json = JSON.stringify(r);
      expect(json).not.toMatch(/access_token|refresh_token|Bearer|client_assertion|client_secret|BEGIN|PRIVATE/i);
      // the only string payloads are scope names
      if (r.ok === false && "extra" in r) for (const s of r.extra) expect(s).toMatch(/^[a-z0-9._]+$/);
      if (r.ok === false && "missing" in r) for (const s of r.missing) expect(s).toMatch(/^okta\.[a-z.]+\.read$/);
    }
  });
});

// ── O1C: host policy must agree with the connector-runner ────────────────────────────────────────────────────────
// A host this wizard ACCEPTS but the runner REJECTS produces a connection that validates and then never syncs. These cases mirror
// canonicalizeOktaOrgHost in idcaddie-connector-runner/src/connector-sync/okta-organization-identity.ts.
describe("okta host policy agrees with the runner's identity rule", () => {
  const accepted = ["acme.okta.com", "acme.oktapreview.com", "acme.okta-emea.com", "trial-5294016.okta.com", "https://acme.okta.com", "ACME.OKTA.COM"];
  const rejected = [
    "okta.com", "oktapreview.com",                        // apex with no organization label
    "a.b.okta.com", "acme.internal.okta.com",             // subdomain confusion — the org part must be ONE label
    "acme.notokta.com", "acme.myokta.com", "acme.okta.co", "acme.okta.net", "acme.oktaa.com",
    "acme.okta.com.evil.com", "okta.com.evil.com",        // real apex appears mid-host
    "acme.0kta.com", "acme.xn--okta-nsa.com",             // homoglyph / punycode lookalikes
    "id.acme.com", "sso.acme.io",                         // custom/vanity domains — unsupported in v1
    "http://acme.okta.com", "user:pass@acme.okta.com", "acme.okta.com:8443",
    "acme.okta.com/api/v1/users", "acme.okta.com?x=1", "acme.okta.com#f",
    "169.254.169.254", "10.0.0.1", "okta.internal",
  ];

  it.each(accepted)("accepts %s", (host) => {
    expect(validateOktaOrgHost(normalizeOrgInput(host)).ok, `${host} was rejected`).toBe(true);
  });

  it.each(rejected)("rejects %s", (host) => {
    expect(validateOktaOrgHost(normalizeOrgInput(host)).ok, `${host} was ACCEPTED — the runner would refuse it`).toBe(false);
  });

  it("normalizes every accepted spelling of one org to the same host the runner would fingerprint", () => {
    const hosts = new Set(["acme.okta.com", "https://acme.okta.com", "ACME.OKTA.COM", "  Acme.Okta.Com  "]
      .map((f) => { const r = validateOktaOrgHost(normalizeOrgInput(f)); return r.ok ? r.host : `REJECTED:${f}`; }));
    expect([...hosts]).toEqual(["acme.okta.com"]);
  });

  it("a bare label that LOOKS internal is still just an org label after the append", () => {
    // `localhost` is a single DNS label, so the convenience append makes it `localhost.okta.com` — a legitimate Okta org host that
    // resolves to Okta, not to a local address. The runner accepts the same normalized value, so this is agreement, not a hole.
    // Qualified internal names have a dot, so they pass through unchanged and ARE rejected (see `okta.internal` above).
    const r = validateOktaOrgHost(normalizeOrgInput("localhost"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.host).toBe("localhost.okta.com");
    expect(validateOktaOrgHost("localhost")).toEqual({ ok: false, reason: "localhost_or_internal" });
  });

  it("the bare-label convenience append only ever produces a .okta.com host", () => {
    expect(normalizeOrgInput("acme")).toBe("acme.okta.com");
    // With the advanced flag the input passes through UNCHANGED — it never widens what the validator accepts.
    expect(normalizeOrgInput("acme", { customDomain: true })).toBe("acme");
    expect(validateOktaOrgHost(normalizeOrgInput("acme", { customDomain: true })).ok).toBe(false);
  });

  it("custom/vanity domains are not claimed anywhere in the wizard copy", () => {
    const blob = JSON.stringify({ OKTA_CONTENT, OKTA_SETUP });
    expect(blob).not.toMatch(/custom (okta )?domain/i);
    expect(blob).not.toMatch(/vanity/i);
  });
});

// ── Customer-facing copy ────────────────────────────────────────────────────────────────────────────────────────
describe("okta setup copy", () => {
  it("publishes exactly the three approved scopes, matching the server contract", () => {
    expect([...OKTA_CONTENT.scopeLabels].sort()).toEqual(contract.approved_scopes);
    expect([...OKTA_CONTENT.scopeLabels].sort()).toEqual([...OKTA_APPROVED_SCOPES].sort());
  });

  it("explains every scope it lists, and lists every scope it explains", () => {
    expect(OKTA_CONTENT.scopeExplanations.map((s) => s.scope)).toEqual([...OKTA_CONTENT.scopeLabels]);
    for (const e of OKTA_CONTENT.scopeExplanations) expect(e.permits.length).toBeGreaterThan(20);
  });

  it("publishes the authoritative KID and never the stale one", () => {
    expect(OKTA_APPROVED_PUBLIC_KID).toBe(contract.staging_public_key_kid);
    for (const k of SUPERSEDED_KIDS) expect(OKTA_APPROVED_PUBLIC_KID).not.toBe(k);
  });

  it("no shipped copy anywhere contains the stale KID or a users-only scope instruction", () => {
    const blob = JSON.stringify({ OKTA_CONTENT, OKTA_SETUP, OKTA_APPROVED_PUBLIC_KID });
    for (const k of SUPERSEDED_KIDS) expect(blob).not.toContain(k);
    expect(blob).not.toMatch(/only the okta\.users\.read scope/i);
    expect(blob).not.toMatch(/\bUsers only\b/);
    // every scope named in customer copy must be an approved scope
    for (const m of blob.matchAll(/okta\.[a-z]+(?:\.[a-z]+)*\.(?:read|manage|write)/g)) {
      expect(contract.approved_scopes as string[], `copy references unapproved scope ${m[0]}`).toContain(m[0]);
    }
  });

  it("states what is NOT requested — management, access changes, remediation", () => {
    const joined = OKTA_CONTENT.notRequested.join(" ").toLowerCase();
    for (const w of ["user management", "group management", "application management", "access changes", "remediation"]) {
      expect(joined).toContain(w);
    }
  });

  it("tells the customer not to paste an API token, and that validation is server-side", () => {
    expect(OKTA_SETUP.noTokenNote).toMatch(/do not paste/i);
    expect(OKTA_SETUP.noTokenNote).toMatch(/token/i);
    expect(OKTA_SETUP.serverValidatedNote).toMatch(/server/i);
  });

  it("says where the public key is used and that the private key stays with ID Caddie", () => {
    expect(OKTA_SETUP.keyStepWhere).toMatch(/public key/i);
    expect(OKTA_SETUP.keyStepNote).toMatch(/private key/i);
    expect(`${OKTA_SETUP.keyStepNote} ${OKTA_SETUP.keyStepWhere}`).toMatch(/never entered here|stays in/i);
  });

  it("states read-only, and never claims the connection is production-enabled", () => {
    expect(OKTA_CONTENT.readOnlyStatement).toMatch(/read-only/i);
    // The status must scope itself to staging and must SAY that production sync is off. Previously this pinned the
    // literal "certification-only"; that phrase reads as "unfinished" to a customer, and the property worth
    // protecting was never the wording — it is that the copy can never be read as "production is on". So: the label
    // is scoped to staging, and the note states the production position explicitly.
    expect(OKTA_SETUP.statusLabel).toMatch(/staging/i);
    expect(OKTA_SETUP.statusLabel).not.toMatch(/production/i);
    expect(OKTA_SETUP.statusNote).toMatch(/production synchronization is disabled/i);
    const blob = JSON.stringify({ OKTA_CONTENT, OKTA_SETUP });
    expect(blob).not.toMatch(/production[- ]enabled|fully enabled|live connection is active/i);
  });

  // O1C.1 — the admin-role requirement is now RESOLVED from official Okta documentation, so the copy must NAME the role. It was
  // previously asserted to name none, which was correct while the requirement was unverified.
  it("names Read Only Administrator, requires it IN ADDITION to scopes, and never asks for Super Admin", () => {
    const blob = JSON.stringify({ OKTA_CONTENT, OKTA_SETUP });
    // Super Admin is not required by any official source and must never be REQUESTED. The copy is allowed to PROHIBIT it, so the
    // check removes that one prohibition and then asserts no other mention survives.
    expect(OKTA_SETUP.roleStepNote).toMatch(/do not assign super admin/i);
    const withoutProhibition = blob.replace(/Do not assign Super Admin\.?/gi, "");
    expect(withoutProhibition).not.toMatch(/super\s*admin/i);
    expect(OKTA_SETUP.roleStepNote).toMatch(/read only administrator/i);
    // The role is ADDITIONAL to the scopes — conflating them is the most likely setup mistake.
    expect(OKTA_SETUP.roleStepNote).toMatch(/in addition to the scopes/i);
    // The superseded pre-O1B guess must not return: a users-scoped role cannot cover okta.apps.read.
    expect(blob).not.toMatch(/scoped to users/i);
    expect(blob).not.toMatch(/Read-Only Administrator role, scoped/i);
  });

  it("states scopes and admin role as SEPARATE mechanisms", () => {
    expect(OKTA_SETUP.scopeVsRoleNote).toMatch(/both/i);
    expect(OKTA_SETUP.scopeVsRoleNote).toMatch(/scopes?/i);
    expect(OKTA_SETUP.scopeVsRoleNote).toMatch(/role/i);
    // One admin step must name the role AND that it is additional to the scopes. (The copy says "Read Only Administrator role",
    // not the generic phrase "admin role" — match the role name, not a phrase the copy never uses.)
    expect(OKTA_SETUP.adminSteps.some((s) => /read only administrator/i.test(s) && /in addition to the scopes/i.test(s))).toBe(true);
  });

  it("troubleshooting distinguishes a scope failure from a role failure", () => {
    const t = OKTA_SETUP.troubleshooting;
    expect(t.length).toBeGreaterThanOrEqual(3);
    // A scope problem fails when the token is requested; a role problem fails later, on the API call. That distinction is what tells
    // a customer which step they missed, so it must survive a copy edit.
    const scopeCase = t.find((x) => /scope/i.test(x.symptom) || /scope/i.test(x.cause));
    const roleCase = t.find((x) => /admin role/i.test(x.cause));
    expect(scopeCase, "no scope-failure guidance").toBeDefined();
    expect(roleCase, "no role-failure guidance").toBeDefined();
    expect(roleCase?.cause).toMatch(/scopes alone do not grant data access/i);
    expect(roleCase?.fix).toMatch(/read only administrator/i);
    // Every entry must be actionable.
    for (const x of t) { expect(x.symptom.length).toBeGreaterThan(10); expect(x.fix.length).toBeGreaterThan(10); }
  });

  it("troubleshooting names no secret value", () => {
    expect(JSON.stringify(OKTA_SETUP.troubleshooting)).not.toMatch(/BEGIN|PRIVATE|client_secret|access_token|SSWS/i);
  });

  it("carries no secret, token, or key material", () => {
    const blob = JSON.stringify({ OKTA_CONTENT, OKTA_SETUP, OKTA_APPROVED_PUBLIC_KID });
    expect(blob).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|client_secret|access_token|SSWS |api[_ ]token['"]/i);
  });
});
