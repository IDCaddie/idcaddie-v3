import { PageSkeleton } from "@/components/skeleton";

// Static Suspense fallback for /dashboards (no data, no hooks, no links) — shows page shape while the server DALs await.
export default function Loading() {
  return <PageSkeleton cards={6} table={false} />;
}
