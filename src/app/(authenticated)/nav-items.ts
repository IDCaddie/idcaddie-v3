// Pure navigation map for the authenticated shell — NO React / next / "use client", so it is
// unit-testable and shared by the client `AppNav`. `href === null` means the area is NOT built yet
// (rendered as a disabled "Not built yet" item). Only routes that actually exist are linkable; nothing
// here implies an unbuilt module works. The set of linkable routes is intentionally tiny (the current
// v3 skeleton): the breadth here reflects the full-parity ROADMAP (docs 40/41), not shipped features.

export type NavItem = { label: string; href: string | null; note?: string };
export type NavSection = { title: string; items: NavItem[] };

// ── Demo presentation mode ────────────────────────────────────────────────────────────────────────────────────
// The "Not built yet" markers below are a DELIBERATE honesty feature — they exist so an unbuilt area can never be
// mistaken for a working one, and they are the right default. They are also the wrong thing to project onto a wall
// during a leadership walkthrough, where every screenshot would carry them.
//
// So this hides them; it does not delete them. Off by default: the honest nav is what ships. `/people` is hidden too
// for the same reason — it reads `app_users` (the SaaS-management surface), which is legitimately empty for a
// directory-only tenant, so in a demo it reads as broken rather than as out-of-scope.
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "1";

// Routes hidden in demo mode even though they are implemented. Keep this list SHORT and justified — anything here is
// a thing the product does that we are choosing not to show, which is a decision, not a default.
const DEMO_HIDDEN_ROUTES = new Set<string>(["/people"]);

// Presentation filter: drop unbuilt (href === null) items and demo-hidden routes, then drop any section left empty.
// Pure and total — the unfiltered NAV_SECTIONS remains the source of truth and the tests assert against it.
export function visibleNavSections(sections: NavSection[], demoMode: boolean): NavSection[] {
  if (!demoMode) return sections;
  return sections
    .map((s) => ({ ...s, items: s.items.filter((i) => i.href !== null && !DEMO_HIDDEN_ROUTES.has(i.href)) }))
    .filter((s) => s.items.length > 0);
}

// The real, implemented authenticated routes that may be linked. Keep in sync with the route tree;
// the test asserts every linked NavItem.href is one of these (so an unbuilt area can never be linked).
export const IMPLEMENTED_ROUTES = ["/", "/apps", "/contracts", "/people", "/reports", "/audit", "/admin", "/files", "/dashboards", "/connectors", "/needs-attention", "/catalog", "/access"] as const;

export const NAV_SECTIONS: NavSection[] = [
  {
    title: "Workspace",
    items: [
      { label: "Home", href: "/" },
      // Read-only summary of RLS-scoped "visible to you" counts linking to implemented pages. No builder
      // / charts / connector-spend / AI / export — see the page's "Not built yet" copy.
      { label: "Dashboards", href: "/dashboards", note: "read-only summary" },
      // Read-only cleanup queue composed from existing RLS-scoped DALs (apps/contracts/connectors). No sync.
      { label: "Needs Attention", href: "/needs-attention", note: "cleanup queue" },
    ],
  },
  {
    title: "Applications",
    items: [
      { label: "Apps", href: "/apps" },
      // Read-only canonical app graph (vendors → products → aliases) from 0024; RLS-scoped, safe projection only.
      { label: "App Catalog", href: "/catalog", note: "read-only" },
      // Customer connector marketplace (browse / search / connect in preview). Connecting runs a SIMULATED
      // preview flow only — no credentials, OAuth, sync, or provider activation. The vault is still not
      // usable for real credentials; the operator sync-review workflow lives at /connectors/review.
      { label: "Connectors", href: "/connectors", note: "preview" },
      { label: "AI / Analysis", href: null },
    ],
  },
  {
    title: "Contracts & files",
    items: [
      { label: "Contracts", href: "/contracts" },
      // Read-only file list; upload/open happen on the contract (the verified path). No standalone
      // upload/delete/export/open-download — see the page's "Not built yet" copy.
      { label: "Files / Documents", href: "/files", note: "read-only; upload on a contract" },
    ],
  },
  {
    title: "People & identity",
    items: [
      { label: "People / Users", href: "/people" },
      // Read-only match STATUS is on /people; the matching workflow (resolve/review/merge) is not built.
      { label: "Identity matching", href: null, note: "status on People; resolution not built" },
    ],
  },
  {
    title: "Insights",
    items: [
      // Read-only access governance over the canonical directory graph (owner/admin only, enforced server-side; nav is display-only).
      // Effective access + governance findings; no mutation, no exports, no usage/license/savings claims.
      { label: "Access", href: "/access", note: "governance, read-only" },
      // Read-only: summary counts (Reports) + recent audit entries (Audit). Generation/export/scheduling
      // and before/after diff are NOT built — see the pages' "Not built yet" copy.
      { label: "Reports", href: "/reports", note: "summary counts only" },
      { label: "Audit / Logs", href: "/audit", note: "recent, read-only" },
    ],
  },
  {
    title: "Administration",
    items: [
      // Read-only: account context + module status + a "Not built yet" capability list. No admin
      // writes (invitations / roles / SSO / SCIM / vault / billing / API keys / retention) — see the page.
      { label: "Admin / Settings", href: "/admin", note: "read-only context" },
    ],
  },
];

// A nav link is "active" for the current path: exact match for "/", prefix match (own route or a
// sub-route) otherwise. So "/apps/123" highlights "Apps" and "/contracts/new" highlights "Contracts".
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
