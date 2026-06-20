// Pure navigation map for the authenticated shell — NO React / next / "use client", so it is
// unit-testable and shared by the client `AppNav`. `href === null` means the area is NOT built yet
// (rendered as a disabled "Not built yet" item). Only routes that actually exist are linkable; nothing
// here implies an unbuilt module works. The set of linkable routes is intentionally tiny (the current
// v3 skeleton): the breadth here reflects the full-parity ROADMAP (docs 40/41), not shipped features.

export type NavItem = { label: string; href: string | null; note?: string };
export type NavSection = { title: string; items: NavItem[] };

// The real, implemented authenticated routes that may be linked. Keep in sync with the route tree;
// the test asserts every linked NavItem.href is one of these (so an unbuilt area can never be linked).
export const IMPLEMENTED_ROUTES = ["/", "/apps", "/contracts"] as const;

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
      { label: "People / Users", href: null },
      { label: "Identity matching", href: null },
    ],
  },
  {
    title: "Insights",
    items: [
      { label: "Reports", href: null },
      { label: "Audit / Logs", href: null },
    ],
  },
  {
    title: "Administration",
    items: [{ label: "Admin / Settings", href: null }],
  },
];

// A nav link is "active" for the current path: exact match for "/", prefix match (own route or a
// sub-route) otherwise. So "/apps/123" highlights "Apps" and "/contracts/new" highlights "Contracts".
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}
