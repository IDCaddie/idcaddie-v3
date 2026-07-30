// P5E17 — customer-facing Okta connection copy + the SSRF-safe organization-host validator (Phase 5/6). PURE + client-safe: no
// network, no secret/token/OAuth, no DB. Plain-language only — never internal governance wording.

export const OKTA_CONTENT = {
  title: "Connect Okta",
  valueStatement: "Discover users, groups, and applications from your Okta organization.",
  // "What ID Caddie can access" — only what the current connector model actually reads.
  accessTitle: "What ID Caddie can access",
  reads: [
    "Users",
    "Account status",
    "Basic profile information, such as name, username, and email address",
    "Groups, and who belongs to them",
    "Applications, and who is assigned to them",
  ],
  noAccessTitle: "What ID Caddie cannot access",
  doesNotAccess: ["Passwords", "MFA information", "Password resets", "System logs", "Application changes", "Group changes", "Access changes", "Account lifecycle changes", "Write permissions"],
  // Initial scope — three concise indicators + one plain-language reassurance line.
  initialScope: ["Read-only", "No changes to access", "No automatic sync"],
  scopeNote: "Nothing is imported until the connection is approved and the first sync is started.",
  // Permissions step: plain-language read-only requests + the explicit technical scopes + a reassurance line.
  requestsReadOnly: ["View users", "View account status", "View basic profile information", "View groups and their members", "View applications and their assignments"],
  // The three approved technical scopes. Mirrors OKTA_APPROVED_SCOPES in the server-only okta-live contract, which the client
  // wizard cannot import; okta-contract-consistency.test.ts asserts they agree.
  scopeLabels: ["okta.users.read", "okta.groups.read", "okta.apps.read"],
  // What each scope permits, in plain language — one entry per scope, same order.
  scopeExplanations: [
    { scope: "okta.users.read", permits: "Read the people in your directory and whether their accounts are active." },
    { scope: "okta.groups.read", permits: "Read your groups and who belongs to each one." },
    { scope: "okta.apps.read", permits: "Read your applications and who is assigned to each one, directly or through a group." },
  ],
  permissionsAssurance: "ID Caddie cannot change users, passwords, MFA settings, groups, applications, or anyone's access.",
  // Explicit statement of what is NOT requested — the read-only claim stated as refused capabilities, not just absent ones.
  notRequestedTitle: "ID Caddie does not request",
  notRequested: ["User management", "Group management", "Application management", "Access changes", "Remediation"],
  readOnlyStatement: "This connection is read-only. ID Caddie can see who has access to what; it cannot grant, change, or remove access.",
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
    "Grant these three read-only scopes: okta.users.read, okta.groups.read, okta.apps.read.",
    "Assign a read-only admin role to the app.",
  ],
  scopeStepTitle: "Required scopes",
  scopeStepNote: "Grant exactly these three scopes on the app's API Scopes tab — no more, no fewer. All three are read-only.",
  roleStepTitle: "Required admin role",
  // The admin-role requirement is deliberately NOT stated as a specific named role. Okta may require an admin role on an API
  // Services app in addition to the granted scopes, and the users-scoped read-only role this step previously named cannot be
  // correct for reading applications. Guessing would send customers to configure the wrong thing, so the step states what IS
  // known (read-only, least privilege) and defers the exact role. See docs/runbooks/OKTA_STAGING_APP_SETUP.md §6.
  roleStepNote: "Assign a read-only administrator role. Use the least-privileged role that still allows reading users, groups, and applications — ID Caddie will confirm the exact role with you during setup. Never assign a role that can make changes.",
  keyStepTitle: "Public-key registration",
  keyStepNote: "Confirm you registered ID Caddie's approved public key (below) on the app. The private key stays in ID Caddie's secure key store and is never entered here.",
  // Where the key id is actually used, and the one thing a customer must NOT paste.
  keyStepWhere: "You paste ID Caddie's public key into the app's Public Keys tab in Okta. The key ID below is what Okta displays once it is registered — use it to confirm you registered the right key.",
  noTokenNote: "Do not paste an Okta API token. This connection uses a service application with a registered key, so no token is needed and ID Caddie will never ask you for one.",
  serverValidatedNote: "The issuer and client ID you enter are validated on ID Caddie's servers before anything is saved.",
  issuerLabel: "Okta issuer",
  clientIdLabel: "API Services client ID",
  clientIdHint: "The app's client ID (starts with 0oa…). This is non-secret.",
  clientIdError: "Enter the API Services client ID (starts with 0oa…).",
  reviewTitle: "Review configuration",
  savedTitle: "Verification pending",
  savedMessage: "Your Okta service application configuration has been saved. ID Caddie has not yet verified the connection or imported any data.",
  declareScope: "I have granted okta.users.read, okta.groups.read, and okta.apps.read on the app",
  declareRole: "I have assigned a read-only admin role to the app",
  declareKey: "I have registered the approved public key on the app",
  // Truthful connection status. Okta is `certificationOnly` in the authoritative governance contract, so the wizard must NOT imply
  // the connection is production-enabled. Plain-language equivalent — no internal governance vocabulary.
  statusLabel: "Certification-only pilot",
  statusNote: "Okta is available for certification and staging use while ID Caddie completes its verification. Configuring this connection does not enable production data collection.",
} as const;

// The approved public signing-key identifier to display (NON-secret; the private key is never here and never in this repository).
//
// O1B — this is the authoritative staging key id, mirroring `staging_public_key_kid` in
// `contracts/okta-provider-contract.v1.json` and the OKTA_VERIFY_KID in all 12 connector-runner task definitions.
//
// SUPERSEDED: `i-Wptr…q8j4` was published here before O1B while the runner had already moved to the value below. A customer who
// followed the shipped instructions would have registered a public key whose private half ID Caddie does not hold, and every token
// request would have failed `invalid_client`. That stale value is asserted ABSENT by okta-contract-consistency.test.ts.
export const OKTA_APPROVED_PUBLIC_KID = "VDkZAQoJl_prLRU83WiPreOBGoP6Fib3qC0CG880wz0" as const;

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
// The three documented Okta organization apexes. MUST match OKTA_APEX_DOMAINS in the connector-runner's
// okta-organization-identity.ts — asserted by okta-contract-consistency.test.ts, because a host this wizard accepts but the runner
// rejects produces a connection that validates and then never syncs.
const OKTA_APEXES: readonly string[] = ["okta.com", "oktapreview.com", "okta-emea.com"];
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
  // O1C — the organization part must be EXACTLY ONE label. Without this, `a.b.okta.com` and `acme.internal.okta.com` were
  // accepted here while the connector-runner's identity rule (canonicalizeOktaOrgHost) rejects them as `bad_label`: a customer
  // could complete setup and then have every sync fail. Subdomain confusion is also not a real Okta org host.
  const apex = OKTA_APEXES.find((a) => v.endsWith(`.${a}`));
  if (apex === undefined) return { ok: false, reason: "not_okta_domain" };
  if (v.slice(0, v.length - apex.length - 1).includes(".")) return { ok: false, reason: "bad_shape" };
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
