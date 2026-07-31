// Phase 2 — PURE display helpers for the Directory list pages: no I/O, no server import, safe in any bundle.
//
// Split out of directory-loaders (which reaches the server-only repository) for the same reason okta-lifecycle was split out of
// okta-connector-status: the list components need these, and importing the loader would pull `next/headers` into the browser.

// The two states a customer needs. Anything the database reports that is not `current` is evidence we have not re-seen the record in the
// latest complete discovery, which is what "stale" communicates.
export type SyncState = "current" | "stale";

// ── customer-facing label maps ────────────────────────────────────────────────────────────────────────────────────────────────────────
// The database stores bounded tokens; none of these had a human label anywhere in the app before Phase 2. Unknown tokens fall back to the
// token itself rather than to "Unknown" — a value we have not seen is better shown than hidden, and the CHECK vocabularies do drift
// (directory_groups' CHECK omits 'missing' even though the normalizer can produce it).
const GROUP_TYPE_LABEL: Record<string, string> = {
  okta_group: "Directory group",
  app_group: "Application group",
  built_in: "Built-in",
  other: "Other",
  missing: "Unspecified",
};
export const groupTypeLabel = (t: string | null): string | null => (t === null ? null : GROUP_TYPE_LABEL[t] ?? t);

const APP_STATUS_LABEL: Record<string, string> = { active: "Active", inactive: "Inactive", other: "Other", missing: "Unspecified" };
export const appStatusLabel = (t: string | null): string | null => (t === null ? null : APP_STATUS_LABEL[t] ?? t);

const SIGN_ON_LABEL: Record<string, string> = {
  saml_2_0: "SAML 2.0",
  openid_connect: "OpenID Connect",
  secure_password_store: "Password store",
  auto_login: "Auto-login",
  bookmark: "Bookmark",
  ws_federation: "WS-Federation",
  browser_plugin: "Browser plugin",
  other: "Other",
  missing: "Unspecified",
};
export const signOnLabel = (t: string | null): string | null => (t === null ? null : SIGN_ON_LABEL[t] ?? t);

// Date-only, UTC. There is no existing formatter for `stale_since` anywhere in src/, and a stale marker does not need clock precision —
// "last seen on this date" is the fact. Explicit UTC so the string does not shift with the reader's timezone.
export const formatStaleSince = (iso: string | null): string | null => {
  if (iso === null) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
