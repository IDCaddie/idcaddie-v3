// P5E17 — customer-facing Okta connection copy + the SSRF-safe organization-host validator (Phase 5/6). PURE + client-safe: no
// network, no secret/token/OAuth, no DB. Plain-language only — never internal governance wording.

export const OKTA_CONTENT = {
  title: "Connect Okta",
  valueStatement: "Discover users and account status from your Okta organization.",
  // "What ID Caddie can access" — only fields the current connector model actually reads.
  accessTitle: "What ID Caddie can access",
  reads: ["Users", "Account status", "Basic profile information, such as name, username, and email address"],
  noAccessTitle: "What ID Caddie cannot access",
  doesNotAccess: ["Passwords", "MFA information", "Password resets", "System logs", "Application changes", "Account lifecycle changes", "Write permissions"],
  // Initial scope — three concise indicators + one plain-language reassurance line.
  initialScope: ["Users only", "Read-only", "No automatic sync"],
  scopeNote: "Nothing is imported until the connection is approved and the first sync is started.",
  // Permissions step: plain-language read-only requests + the one explicit technical scope + a reassurance line.
  requestsReadOnly: ["View users", "View account status", "View basic profile information"],
  scopeLabel: "okta.users.read",
  permissionsAssurance: "ID Caddie cannot change users, passwords, MFA settings, or applications.",
  setupTime: "Setup takes about 2 minutes",
} as const;

// Okta API Services onboarding copy (service application — NO browser OAuth, NO redirect, NO consent, NO refresh token). The
// customer creates a service app in Okta Admin, registers ID Caddie's approved public key, grants the scope, assigns a
// least-privileged admin role, then enters the issuer + client id here. The private key stays in the operator's secret store.
export const OKTA_SETUP = {
  title: "Set up Okta API Services",
  intro: "Okta connects as a background service application. Create it in your Okta admin, then enter the issuer and client ID below. There is no browser sign-in step.",
  adminSteps: [
    "In Okta Admin, create an API Services app integration (not a Web app).",
    "Register ID Caddie's approved public key on the app.",
    "Grant only the okta.users.read scope.",
    "Assign a least-privileged read-only admin role (scoped to users).",
  ],
  scopeStepTitle: "Required scope",
  scopeStepNote: "Grant only this scope on the app's API Scopes tab.",
  roleStepTitle: "Required admin role",
  roleStepNote: "Assign a least-privileged Read-Only Administrator role, scoped to users where possible.",
  keyStepTitle: "Public-key registration",
  keyStepNote: "Confirm you registered ID Caddie's approved public key (below) on the app. The private key is never entered here.",
  issuerLabel: "Okta issuer",
  clientIdLabel: "API Services client ID",
  clientIdHint: "The app's client ID (starts with 0oa…). This is non-secret.",
  clientIdError: "Enter the API Services client ID (starts with 0oa…).",
  reviewTitle: "Review configuration",
  savedTitle: "Verification pending",
  savedMessage: "Your Okta service application configuration has been saved. ID Caddie has not yet verified the connection or imported any data.",
  declareScope: "I have granted okta.users.read on the app",
  declareRole: "I have assigned a least-privileged admin role to the app",
  declareKey: "I have registered the approved public key on the app",
} as const;

// The approved public signing-key identifier to display (NON-secret; the private key is never here).
export const OKTA_APPROVED_PUBLIC_KID = "i-Wptr6usN1tpkNp17vHXv_Mar4NPz53rn-bmlTq8j4" as const;

// Client-safe Okta client-id SHAPE check (the server-only okta-live validator can't be imported into the client wizard). Opaque
// `0oa…` id — a bounded safe-charset string. NON-secret; validates shape only.
const OKTA_CLIENT_ID = /^0oa[A-Za-z0-9]{10,40}$/;
export function validateOktaClientId(raw: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof raw !== "string") return { ok: false };
  const v = raw.trim();
  return OKTA_CLIENT_ID.test(v) ? { ok: true, value: v } : { ok: false };
}

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

// Near-one-click convenience: if the user typed a BARE organization label (a single DNS label — no dot, scheme, space, or other
// punctuation), assume the standard Okta domain and append ".okta.com". Anything already qualified (has a dot), any https:// form,
// or the advanced custom-domain mode passes through UNCHANGED — so validateOktaOrgHost below stays exactly as strict and NO new
// host shape is ever accepted. Pure, no network. `customDomain` (advanced) disables the append so the user supplies the full host.
export function normalizeOrgInput(raw: string, opts?: { customDomain?: boolean }): string {
  if (opts?.customDomain) return raw;
  const v = raw.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9-]*$/.test(v)) return `${v}.okta.com`;
  return raw;
}

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
