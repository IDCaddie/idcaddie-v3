// Pure navigation map for the authenticated shell — NO React / next / "use client", so it is
// unit-testable and shared by the client `AppNav`. `href === null` means the area is NOT built yet
// (rendered as a disabled "Not built yet" item). Only routes that actually exist are linkable; nothing
// here implies an unbuilt module works. The set of linkable routes is intentionally tiny (the current
// v3 skeleton): the breadth here reflects the full-parity ROADMAP (docs 40/41), not shipped features.

export type NavItem = { label: string; href: string | null; note?: string };
export type NavSection = { title: string; items: NavItem[] };

// The real, implemented authenticated routes that may be linked. Keep in sync with the route tree;
// the test asserts every linked NavItem.href is one of these (so an unbuilt area can never be linked).
export const IMPLEMENTED_ROUTES = ["/", "/apps", "/contracts", "/people", "/reports", "/audit", "/admin"] as const;

export const NAV_SECTIONS: NavSection[] = [
  {
    title: "Workspace",
    items: [
      { label: "Home", href: "/" },
      { label: "Dashboards", href: null },
    ],
  },
  {
    title: "Applications",
    items: [
      { label: "Apps", href: "/apps" },
      { label: "Connectors", href: null },
      { label: "AI / Analysis", href: null },
    ],
  },
  {
    title: "Contracts & files",
    items: [
      { label: "Contracts", href: "/contracts" },
      { label: "Files / Documents", href: null, note: "attach files on a contract" },
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
