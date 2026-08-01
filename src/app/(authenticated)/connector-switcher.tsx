"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ScopeConnector } from "@/lib/data/connector-scope";

// Phase 5 — the global directory scope.
//
// A workspace can hold several directories (Corporate Okta, a sandbox, a subsidiary). They are separate organizations whose graphs
// are never merged, so every identity surface reads either ONE of them or all of them — and has to say which.
//
// The scope lives in the URL (`?connection=<uuid>`), so Home, Directory, Access and Findings cannot disagree: they all read the same
// parameter, a scoped view is shareable, and the back button works. Switching preserves every other parameter except `page`, which
// is reset — page 7 of a different directory is a different set of records.
//
// Rendered only when there is more than one active directory. A single-directory workspace has no choice to make, and a control
// with one option is noise.

export function ConnectorSwitcher({ connectors }: { connectors: readonly ScopeConnector[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  if (connectors.length < 2) return null;

  const requested = params.get("connection") ?? "";
  // ELIGIBILITY: only connectors that are active (not superseded, not disconnected) reach this component — the resolver filters
  // them server-side. A configuration-only connector IS eligible: scoping to it shows an honest empty directory, which is the
  // truthful answer while it waits for verification, and excluding it would make a connector the customer just added invisible.
  //
  // FALLBACK: if the URL still names a connector that is no longer eligible — disconnected in another tab, or a stale bookmark —
  // the control shows "All directories" rather than a blank or a hidden scope. The server resolver independently drops the id, so
  // the data and the control agree; this only stops the SELECT from displaying a value it does not have.
  const current = connectors.some((c) => c.id === requested) ? requested : "";

  const onChange = (value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set("connection", value); else next.delete("connection");
    next.delete("page");
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <div className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-zinc-400">Directory</span>
        <select
          value={current}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Directory scope"
          className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
        >
          {/* "All" is a real, meaningful scope — it is not a merge. Each connector still owns its own rows; this simply does not
              filter to one of them. The counts a customer sees are still per-record, never summed across organizations. */}
          <option value="">All directories ({connectors.length})</option>
          {connectors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}{c.organization && c.organization !== c.label ? ` · ${c.organization}` : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
