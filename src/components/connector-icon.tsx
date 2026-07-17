import type { IconTint } from "@/lib/customer-connectors/catalog-types";

// Presentational, server-safe provider icon. A SAFE LOCAL monogram (a tinted rounded square + the provider initial) — NO remote
// logo, no copyrighted brand asset, no network. Decorative (aria-hidden); the provider name is always shown as text alongside.
const TINT: Record<IconTint, string> = {
  sky: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  violet: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  rose: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  orange: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  slate: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  cyan: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
  teal: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
};
const SIZE = { sm: "h-8 w-8 text-sm", md: "h-11 w-11 text-lg", lg: "h-12 w-12 text-lg", xl: "h-16 w-16 text-2xl" } as const;

export function ConnectorIcon({ initial, tint, size = "md" }: { initial: string; tint: IconTint; size?: keyof typeof SIZE }) {
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-lg font-semibold ${TINT[tint]} ${SIZE[size]}`}>
      {initial}
    </span>
  );
}
