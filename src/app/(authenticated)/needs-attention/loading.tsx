import { PageSkeleton } from "@/components/skeleton";

// Static Suspense fallback for /needs-attention (no data, no hooks, no links) — shows page shape while the DAL awaits.
export default function Loading() {
  return <PageSkeleton table />;
}
