// O2A — V3's port of the O1C Okta organization-identity derivation.
//
// WHY THIS EXISTS HERE. The derivation is defined in idcaddie-connector-runner
// (`src/connector-sync/okta-organization-identity.ts`), but the O2A server action runs in V3 and must compute the fingerprint at
// configuration time. The two repositories share no package, so the algorithm is implemented in both and pinned by KNOWN-ANSWER
// VECTORS asserted in each — the same mechanism the O1B contract hash uses. If either implementation drifts, that repository's test
// fails. See `okta-org-identity.test.ts`.
//
// WHAT THE FINGERPRINT IS. An IDCaddie-derived value over normalized, server-validated inputs. It is NOT an Okta-issued
// organization id, and at configuration time it is NOT evidence of anything: no token has been minted, so no organization has been
// proven. Callers must persist it as PROPOSED. Only a successful live token exchange (O2B/O2D) may produce a verified value.
//
// PURE: no network, no DB, no secret, no token.

import { createHash } from "node:crypto";

export const OKTA_APEX_DOMAINS: readonly string[] = Object.freeze(["okta.com", "oktapreview.com", "okta-emea.com"]);
export const OKTA_IDENTITY_VERSION = 1 as const;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const INTERNAL_SUFFIX = /\.(internal|local|localdomain|lan|intranet|corp|home|test|example|invalid)$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,256}$/;
const TOKEN_PATH = "/oauth2/v1/token";

export type OktaHostReason =
  | "empty" | "too_long" | "not_a_string" | "has_scheme" | "not_https" | "has_credentials" | "has_port"
  | "has_path_or_query" | "has_whitespace" | "ip_literal" | "localhost_or_internal" | "bad_label"
  | "not_okta_apex" | "apex_only";

export type OktaHostResult =
  | { readonly ok: true; readonly host: string; readonly apex: string; readonly orgLabel: string }
  | { readonly ok: false; readonly reason: OktaHostReason };

// Canonicalize a customer-entered organization value to ONE lowercase bare host, or fail with a safe category.
// Mirrors canonicalizeOktaOrgHost in the connector-runner exactly — including the ordering of the credentials check, which must
// precede the bare-scheme rule so `user:pass@acme.okta.com` reports `has_credentials` rather than `has_scheme`.
export function canonicalizeOktaOrgHost(raw: unknown): OktaHostResult {
  if (typeof raw !== "string") return { ok: false, reason: "not_a_string" };
  let v = raw.trim();
  if (v.length === 0) return { ok: false, reason: "empty" };
  if (v.length > 255) return { ok: false, reason: "too_long" };
  if (/\s/.test(v)) return { ok: false, reason: "has_whitespace" };

  v = v.toLowerCase();
  if (v.includes("[") || v.includes("]") || v.includes("::")) return { ok: false, reason: "ip_literal" };

  if (/^[a-z][a-z0-9+.-]*:\/\//.test(v)) {
    if (v.startsWith("http://")) return { ok: false, reason: "not_https" };
    if (!v.startsWith("https://")) return { ok: false, reason: "has_scheme" };
    v = v.slice("https://".length);
  }

  if (v.includes("@")) return { ok: false, reason: "has_credentials" };
  if (/^[a-z][a-z0-9+.-]*:/.test(v) && !/^[a-z0-9.-]+:\d+$/.test(v)) return { ok: false, reason: "has_scheme" };

  if (v.endsWith("/")) v = v.slice(0, -1);
  if (v.includes("/") || v.includes("?") || v.includes("#")) return { ok: false, reason: "has_path_or_query" };
  if (v.includes(":")) return { ok: false, reason: "has_port" };
  if (v.length === 0) return { ok: false, reason: "empty" };

  if (v === "localhost" || INTERNAL_SUFFIX.test(v)) return { ok: false, reason: "localhost_or_internal" };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return { ok: false, reason: "ip_literal" };

  for (const label of v.split(".")) if (!LABEL.test(label)) return { ok: false, reason: "bad_label" };

  const apex = OKTA_APEX_DOMAINS.find((a) => v === a || v.endsWith(`.${a}`));
  if (apex === undefined) return { ok: false, reason: "not_okta_apex" };
  if (v === apex) return { ok: false, reason: "apex_only" };

  const orgLabel = v.slice(0, v.length - apex.length - 1);
  if (orgLabel.includes(".") || !LABEL.test(orgLabel)) return { ok: false, reason: "bad_label" };

  return { ok: true, host: v, apex, orgLabel };
}

export type OktaOrganizationIdentity = {
  readonly provider: "okta";
  readonly identityVersion: typeof OKTA_IDENTITY_VERSION;
  readonly canonicalOrgHost: string;
  readonly verifiedTokenEndpoint: string;
  readonly clientId: string;
  /** Identifies the ORGANIZATION. Excludes clientId, so it survives service-app recreation AND key rotation. */
  readonly organizationFingerprint: string;
  /** Identifies the organization + SERVICE APP. Changes if the app is recreated; stable across key rotation. */
  readonly serviceAppFingerprint: string;
};

export type OktaIdentityResult =
  | { readonly ok: true; readonly identity: OktaOrganizationIdentity }
  | { readonly ok: false; readonly reason: OktaHostReason | "client_id_invalid" };

// Deterministic serialization: explicit field ORDER, `key=value` lines joined by \n, version-tagged. Never JSON key ordering.
function fingerprintInput(fields: readonly (readonly [string, string | number])[]): string {
  return fields.map(([k, v]) => `${k}=${String(v)}`).join("\n");
}
const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export function deriveOktaOrganizationIdentity(params: { readonly orgHost: unknown; readonly clientId: unknown }): OktaIdentityResult {
  const host = canonicalizeOktaOrgHost(params.orgHost);
  if (!host.ok) return { ok: false, reason: host.reason };
  if (typeof params.clientId !== "string" || !CLIENT_ID.test(params.clientId)) return { ok: false, reason: "client_id_invalid" };

  const verifiedTokenEndpoint = `https://${host.host}${TOKEN_PATH}`;

  const organizationFingerprint = sha256Hex(fingerprintInput([
    ["version", OKTA_IDENTITY_VERSION],
    ["provider", "okta"],
    ["canonicalOrgHost", host.host],
    ["verifiedTokenEndpoint", verifiedTokenEndpoint],
  ]));

  const serviceAppFingerprint = sha256Hex(fingerprintInput([
    ["version", OKTA_IDENTITY_VERSION],
    ["provider", "okta"],
    ["canonicalOrgHost", host.host],
    ["verifiedTokenEndpoint", verifiedTokenEndpoint],
    ["clientId", params.clientId],
  ]));

  return {
    ok: true,
    identity: Object.freeze({
      provider: "okta",
      identityVersion: OKTA_IDENTITY_VERSION,
      canonicalOrgHost: host.host,
      verifiedTokenEndpoint,
      clientId: params.clientId,
      organizationFingerprint,
      serviceAppFingerprint,
    }),
  };
}
