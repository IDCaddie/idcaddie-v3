// P5E18a — the STRICT SERVER-SIDE Okta organization + issuer validator (Phase 3). PURE, server-only, and makes NO network request.
// This is a SECURITY control — it does NOT trust the client-side preview normalizer. It turns a customer-entered organization value
// into three DISTINCT, separately-typed things:
//   - orgLabel:   the customer-entered label (trimmed, case-normalized) — for display/audit only, never a security input
//   - hostname:   the normalized bare Okta hostname (e.g. "acme.okta.com") — the ONLY value bound into config
//   - issuerUrl:  the eventual HTTPS issuer origin (e.g. "https://acme.okta.com") — no path, no query, no fragment
// It prevents SSRF: it accepts ONLY an Okta apex host (or an explicitly-allowlisted custom Okta domain) and rejects schemes other
// than https, credentials, ports, paths/query/fragments, whitespace, localhost/loopback, private + link-local IPs, IP literals,
// non-ASCII / malformed punycode, and non-Okta domains. It never contacts a network and never echoes a crafted value anywhere
// executable.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-org-validator is server-only and must not be imported in client code");
}

// Standard Okta apexes. Any accepted host (that is not an allowlisted custom domain) must end in one of these.
const OKTA_APEXES = [".okta.com", ".oktapreview.com", ".okta-emea.com"] as const;
// Internal / non-public suffixes that must never be treated as a live issuer.
const INTERNAL_SUFFIXES = [".local", ".localdomain", ".internal", ".intranet", ".lan", ".corp", ".home", ".test", ".example", ".invalid"];
// A strict ASCII LDH hostname: 1+ labels, each 1-63 chars of [a-z0-9] with internal hyphens, dot-separated, alpha TLD.
const HOSTNAME_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
// A single bare organization label (no dots) — expanded to "<label>.okta.com".
const BARE_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export type OktaOrgReason =
  | "empty"
  | "not_string"
  | "has_whitespace"
  | "non_https_scheme"
  | "has_credentials"
  | "has_port"
  | "has_path_or_query_or_fragment"
  | "ip_literal"
  | "loopback"
  | "private_or_link_local"
  | "localhost_or_internal"
  | "invalid_hostname"
  | "bad_punycode"
  | "not_okta_domain"
  | "not_allowed_custom_domain";

export type OktaOrgResult =
  | { ok: true; orgLabel: string; hostname: string; issuerUrl: string }
  | { ok: false; reason: OktaOrgReason };

export type OktaOrgValidateOptions = {
  // An explicit allowlist of EXACT custom Okta hostnames (e.g. "id.customer.com") a future authorized pilot may configure. Empty by
  // default (the dormant foundation accepts only standard Okta apexes). Compared case-insensitively, exact-match only.
  allowedCustomDomains?: readonly string[];
};

function classifyIpv4(host: string): OktaOrgReason | null {
  const m = IPV4_RE.exec(host);
  if (!m) return null;
  const oct = m.slice(1, 5).map((s) => Number(s));
  if (oct.some((n) => n > 255)) return "invalid_hostname"; // dotted-quad-shaped but out of range
  const [a, b] = oct;
  if (a === 127) return "loopback"; // 127.0.0.0/8
  if (a === 10) return "private_or_link_local"; // 10.0.0.0/8
  if (a === 192 && b === 168) return "private_or_link_local"; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return "private_or_link_local"; // 172.16.0.0/12
  if (a === 169 && b === 254) return "private_or_link_local"; // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return "private_or_link_local"; // 100.64.0.0/10 CGNAT
  if (a === 0) return "private_or_link_local"; // 0.0.0.0/8
  return "ip_literal"; // any other IPv4 literal is still not a valid Okta org
}

// Validate a customer-entered Okta organization value. NO network. Returns the three distinct outputs or a typed reason.
export function validateOktaOrganization(raw: unknown, opts: OktaOrgValidateOptions = {}): OktaOrgResult {
  if (typeof raw !== "string") return { ok: false, reason: "not_string" };
  const orgLabel = raw.trim();
  if (orgLabel.length === 0) return { ok: false, reason: "empty" };
  if (/\s/.test(orgLabel)) return { ok: false, reason: "has_whitespace" };
  // Reject any non-ASCII up front (homoglyph / IDN confusion). Punycode (xn--) must be pre-encoded ASCII to reach here.
  if (/[^\x00-\x7f]/.test(orgLabel)) return { ok: false, reason: "invalid_hostname" };

  let v = orgLabel.toLowerCase();

  // Hierarchical scheme: only an exact https:// prefix is tolerated (and stripped). Any other "scheme://" — http://, ftp://,
  // ws:// — is a non-HTTPS/attacker target. A live issuer MUST be HTTPS.
  if (/:\/\//.test(v)) {
    if (!v.startsWith("https://")) return { ok: false, reason: "non_https_scheme" };
    v = v.slice("https://".length);
  }

  if (v.length === 0) return { ok: false, reason: "empty" };
  if (v.includes("@")) return { ok: false, reason: "has_credentials" };
  // IPv6 literal (bracketed and/or "::") — classify loopback/link-local, else ip_literal. Done before the scheme/port checks
  // because ":" appears in IPv6. ::1 = loopback; fe80::/fc00::/fd00:: = link-local/ULA.
  if (v.includes("[") || v.includes("]") || v.includes("::")) {
    if (v === "::1" || v === "[::1]") return { ok: false, reason: "loopback" };
    if (/^\[?(fe80|fc00|fd00)/.test(v)) return { ok: false, reason: "private_or_link_local" };
    return { ok: false, reason: "ip_literal" };
  }
  // A bare (non-hierarchical) scheme like javascript:/data:/mailto: — a dotless scheme WORD immediately followed by ":". A
  // host:port has dots before the ":" (handled as has_port below), so require the pre-colon segment to contain no dot.
  const colon = v.indexOf(":");
  if (colon > 0 && !v.slice(0, colon).includes(".") && /^[a-z][a-z0-9+.-]*$/.test(v.slice(0, colon)))
    return { ok: false, reason: "non_https_scheme" };
  if (v.includes("/") || v.includes("?") || v.includes("#")) return { ok: false, reason: "has_path_or_query_or_fragment" };
  if (v.includes(":")) return { ok: false, reason: "has_port" };

  // Reserved single-label names must be rejected BEFORE the bare-label expansion below (else "localhost" would expand to
  // "localhost.okta.com" and slip through).
  if (v === "localhost") return { ok: false, reason: "loopback" };

  // Bare single label (no dot) → expand to the standard Okta domain. Only a clean label is expanded; anything else is validated
  // as a full host below. This can only ever produce "<label>.okta.com" (a safe standard apex).
  if (!v.includes(".")) {
    if (!BARE_LABEL_RE.test(v)) return { ok: false, reason: "invalid_hostname" };
    v = `${v}.okta.com`;
  }

  // IPv4 literal (dotted quad) — classify loopback/private/link-local, else ip_literal.
  const ipReason = classifyIpv4(v);
  if (ipReason) return { ok: false, reason: ipReason };

  if (v === "localhost" || v.endsWith(".localhost")) return { ok: false, reason: "loopback" };
  if (INTERNAL_SUFFIXES.some((s) => v.endsWith(s))) return { ok: false, reason: "localhost_or_internal" };

  if (!HOSTNAME_RE.test(v)) return { ok: false, reason: "invalid_hostname" };

  const allowedCustom = (opts.allowedCustomDomains ?? []).map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
  const isOktaApex = OKTA_APEXES.some((apex) => v.endsWith(apex) && v.length > apex.length);
  if (isOktaApex) {
    // A standard Okta apex host must be pure ASCII LDH with NO punycode label (Okta org hosts are ASCII); reject xn-- here so a
    // crafted punycode label can't ride the standard path. Custom punycode domains must be explicitly allowlisted (below).
    if (v.split(".").some((label) => label.startsWith("xn--"))) return { ok: false, reason: "bad_punycode" };
    return { ok: true, orgLabel, hostname: v, issuerUrl: `https://${v}` };
  }
  if (allowedCustom.includes(v)) {
    return { ok: true, orgLabel, hostname: v, issuerUrl: `https://${v}` };
  }
  // Not an Okta apex. If a custom allowlist was supplied and it's not in it → not_allowed_custom_domain; else not_okta_domain.
  return { ok: false, reason: allowedCustom.length > 0 ? "not_allowed_custom_domain" : "not_okta_domain" };
}
