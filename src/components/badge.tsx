import type { ReactNode } from "react";
import { statusColor, type StatusTone } from "./status-tokens";

// Presentational, server-safe badge (no "use client", no hooks, no data). A shared pill so status columns read as
// one designed system. `outline` is the default (matches the existing rounded-full pill look); `solid` for emphasis.
const OUTLINE: Record<StatusTone, string> = {
  success: "border-green-500 text-green-700 dark:border-green-600 dark:text-green-400",
  attention: "border-amber-500 text-amber-700 dark:border-amber-600 dark:text-amber-400",
  danger: "border-red-500 text-red-700 dark:border-red-600 dark:text-red-400",
  neutral: "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400",
};
const SOLID: Record<StatusTone, string> = {
  success: "border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  attention: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  danger: "border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  neutral: "border-transparent bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

export function Badge({
  tone,
  variant = "outline",
  children,
}: {
  tone: StatusTone;
  variant?: "outline" | "solid";
  children: ReactNode;
}) {
  const cls = variant === "solid" ? SOLID[tone] : OUTLINE[tone];
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
}

// Colors a status string by its semantic tone and shows the string verbatim. Null/empty → a neutral "—".
export function StatusBadge({ value, variant }: { value: string | null | undefined; variant?: "outline" | "solid" }) {
  const label = value == null || value.trim() === "" ? "—" : value;
  return (
    <Badge tone={statusColor(value)} variant={variant}>
      {label}
    </Badge>
  );
}
