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
export const IMPLEMENTED_ROUTES = ["/", "/apps", "/contracts", "/people", "/reports", "/audit", "/admin", "/files", "/dashboards", "/connectors", "/needs-attention", "/catalog", "/access", "/access/findings", "/directory/people", "/directory/groups", "/directory/applications"] as const;

export const NAV_SECTIONS: NavSection[] = [
  {
    title: "Workspace",
    items: [
      { label: "Home", href: "/" },
      // Read-only cleanup queue composed from existing RLS-scoped DALs (apps/contracts/connectors). No sync.
      { label: "Needs Attention", href: "/needs-attention", note: "cleanup queue" },
      // Customer connector marketplace. Okta persists a real configuration; the other providers are preview only.
      { label: "Connectors", href: "/connectors" },
    ],
  },
  {
    // The identity graph, promoted out of /access. Discovery writes `directory_*` + `identity_accounts`, and until now the
    // only way to reach any of it was to drill into the Access report — which framed the product's subject matter as an audit
    // artefact. People/Groups/Applications LIST pages land in Phase 2; their detail views already exist under /access.
    title: "Directory",
    items: [
      { label: "People", href: "/directory/people", note: "list view in progress" },
      { label: "Groups", href: "/directory/groups", note: "list view in progress" },
      { label: "Applications", href: "/directory/applications", note: "from your identity provider" },
    ],
  },
  {
    title: "Access governance",
    items: [
      // Effective access + governance findings over the canonical directory graph (owner/admin, enforced server-side).
      { label: "Access", href: "/access", note: "effective access, read-only" },
      { label: "Findings", href: "/access/findings", note: "governance findings" },
    ],
  },
  {
    // Everything below is the SaaS layer. It is unchanged and fully reachable — it has moved in the IA, not shrunk. ELU, UAR
    // and Reviews are deliberately ABSENT rather than listed as unbuilt: naming them here would imply a roadmap commitment
    // this phase has not made.
    title: "SaaS intelligence",
    items: [
      { label: "SaaS inventory", href: "/apps", note: "normalized software records" },
      { label: "App Catalog", href: "/catalog", note: "read-only" },
      // Formerly "People / Users" at the top level. Same route, same page — renamed because "People" now means the
      // DIRECTORY identity above, and two nav items called People reading from two different tables is the exact
      // confusion this restructure exists to remove. These are per-application account records, not directory identities.
      { label: "App accounts", href: "/people", note: "accounts held in SaaS apps" },
      { label: "Contracts", href: "/contracts" },
      { label: "Files / Documents", href: "/files", note: "read-only; upload on a contract" },
      { label: "Spend & renewals", href: "/dashboards", note: "on Home" },
    ],
  },
  {
    title: "Insights",
    items: [
      { label: "Reports", href: "/reports", note: "summary counts only" },
      { label: "Audit / Logs", href: "/audit", note: "recent, read-only" },
    ],
  },
  {
    title: "Administration",
    items: [
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
