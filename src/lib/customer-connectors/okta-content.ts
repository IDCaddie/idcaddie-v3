// P5E17 — customer-facing Okta connection copy + the SSRF-safe organization-host validator (Phase 5/6). PURE + client-safe: no
// network, no secret/token/OAuth, no DB. Plain-language only — never internal governance wording.

export const OKTA_CONTENT = {
  title: "Connect Okta",
  valueStatement:
    "Discover users and account status from your Okta organization so ID Caddie can identify active, suspended, deactivated, and unmanaged accounts.",
  reads: ["Users", "User status", "Approved profile fields"],
  doesNotAccess: ["Passwords", "MFA factors", "Password resets", "System logs", "Application changes", "Lifecycle changes", "Write permissions"],
  initialScope: ["Users only", "Read-only", "No automatic scheduling", "No changes to your accounts"],
  scopeLabel: "okta.users.read",
  setupTime: "About 2 minutes",
} as const;

// The organization host validation. Accepts only a bare Okta-shaped hostname; rejects schemes, IPs, localhost, internal/private
// hosts, paths, query strings, fragments, credentials, and ports. NO network request. Returns the normalized bare host or a
// reason class (never echoing a crafted value into anything executable). The customer may type either `your-company.okta.com`
// or (tolerated) a full `https://your-company.okta.com` which is stripped to the host and re-validated.
export type OrgHostResult = { ok: true; host: string } | { ok: false; reason: OrgHostReason };
export type OrgHostReason =
  | "empty" | "has_scheme" | "has_path_or_query" | "has_credentials_or_port" | "ip_literal" | "localhost_or_internal"
  | "bad_shape" | "not_okta_domain";

const BARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// Accept the Okta apexes (customers use `<org>.okta.com` / `.oktapreview.com` / `.okta-emea.com`) so an arbitrary domain can't be
// entered. (Custom vanity domains are a later, separately-designed concern — not accepted in this preview.)
const OKTA_APEX = /\.(okta\.com|oktapreview\.com|okta-emea\.com)$/;
const INTERNAL_SUFFIX = /\.(internal|local|localdomain|lan|intranet|corp|home|test|example|invalid)$/;

export function validateOktaOrgHost(raw: unknown): OrgHostResult {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  let v = raw.trim().toLowerCase();
  if (v.length === 0) return { ok: false, reason: "empty" };
  // An IPv6 literal (bracketed and/or `::`) is classified up-front so it reads as an IP, not a stray scheme. Still rejected either way.
  if (v.includes("[") || v.includes("]") || v.includes("::")) return { ok: false, reason: "ip_literal" };
  // A scheme is tolerated ONLY as an exact https:// prefix that we strip; any other scheme (http/ftp/javascript/data/…) is rejected.
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(v)) {
    if (!v.startsWith("https://")) return { ok: false, reason: "has_scheme" };
    v = v.slice("https://".length);
  } else if (/:/.test(v) && !/^[a-z0-9.-]+:\d+$/.test(v)) {
    // a bare `scheme:` with no `//` (e.g. `javascript:…`, `mailto:…`) — reject
    return { ok: false, reason: "has_scheme" };
  }
  if (v.includes("@")) return { ok: false, reason: "has_credentials_or_port" }; // user:pass@host
  if (v.includes("/") || v.includes("?") || v.includes("#") || /\s/.test(v)) return { ok: false, reason: "has_path_or_query" };
  if (v.includes(":")) return { ok: false, reason: "has_credentials_or_port" }; // a port
  if (v === "localhost" || INTERNAL_SUFFIX.test(v)) return { ok: false, reason: "localhost_or_internal" };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v) || /^\[?[0-9a-f:]+\]?$/.test(v)) return { ok: false, reason: "ip_literal" }; // IPv4 / IPv6 literal
  if (!BARE_HOST.test(v)) return { ok: false, reason: "bad_shape" };
  const tld = v.slice(v.lastIndexOf(".") + 1);
  if (!/[a-z]/.test(tld)) return { ok: false, reason: "ip_literal" }; // numeric TLD = an IP-ish literal
  if (!OKTA_APEX.test(v)) return { ok: false, reason: "not_okta_domain" };
  return { ok: true, host: v };
}

export const ORG_HOST_MESSAGE: Record<OrgHostReason, string> = {
  empty: "Enter your Okta organization address.",
  has_scheme: "Enter just the address (for example your-company.okta.com), without a link scheme.",
  has_path_or_query: "Enter just the organization address, without any path or extra characters.",
  has_credentials_or_port: "Enter just the organization address, without a username or port.",
  ip_literal: "Enter your Okta organization address, not an IP address.",
  localhost_or_internal: "Enter your public Okta organization address.",
  bad_shape: "That doesn’t look like a valid Okta organization address.",
  not_okta_domain: "Enter your Okta address ending in .okta.com.",
};
