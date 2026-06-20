"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_SECTIONS, isNavActive } from "./nav-items";

// Persistent authenticated shell sidebar. Active state is derived from the current path (usePathname).
// It renders ONLY the user's own email + active tenant name/role (no tenant id — that stays on the
// home/debug page; we do not add new id exposure to the chrome). It carries NO authorization itself —
// the server layout guards the session and RLS governs all data. "Not built yet" items are disabled
// spans (no link), so an unbuilt old-app area can never look or behave as if it works.

export function AppNav({
  email,
  tenantName,
  tenantRole,
}: {
  email: string | null;
  tenantName: string | null;
  tenantRole: string | null;
}) {
  const pathname = usePathname();

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
      <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
        <div className="font-semibold">ID Caddie</div>
        <div className="mt-2 truncate text-xs text-zinc-500" title={email ?? undefined}>
          {email ?? "—"}
        </div>
        <div className="truncate text-xs text-zinc-600 dark:text-zinc-400">
          {tenantName ? (
            <>
              {tenantName}
              {tenantRole ? <span className="text-zinc-500"> · {tenantRole}</span> : null}
            </>
          ) : (
            <span className="text-zinc-500">No active tenant</span>
          )}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-3 text-sm">
        {NAV_SECTIONS.map((section) => (
          <div key={section.title} className="mb-4">
            <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              {section.title}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((item) =>
                item.href ? (
                  <li key={item.label}>
                    <Link
                      href={item.href}
                      aria-current={isNavActive(pathname, item.href) ? "page" : undefined}
                      className={`block rounded px-2 py-1 ${
                        isNavActive(pathname, item.href)
                          ? "bg-zinc-100 font-medium dark:bg-zinc-800"
                          : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-900"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                ) : (
                  <li key={item.label}>
                    <span
                      aria-disabled="true"
                      title="Not built yet"
                      className="flex items-center justify-between gap-2 rounded px-2 py-1 text-zinc-400"
                    >
                      <span className="truncate">{item.label}</span>
                      <span className="shrink-0 rounded-full border border-zinc-300 px-1.5 text-[10px] text-zinc-400 dark:border-zinc-700">
                        Not built yet
                      </span>
                    </span>
                    {item.note ? (
                      <span className="block px-2 pb-0.5 text-[10px] text-zinc-400">{item.note}</span>
                    ) : null}
                  </li>
                ),
              )}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <p className="mb-2 text-[11px] text-zinc-400">
          Items marked “Not built yet” are old-app areas not yet implemented in v3.
        </p>
        <form action="/logout" method="post">
          <button
            type="submit"
            className="w-full rounded border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
