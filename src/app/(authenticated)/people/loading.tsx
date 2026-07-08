import { PageSkeleton } from "@/components/skeleton";

// Static Suspense fallback for /people (no data, no hooks, no links) — shows page shape while the server DAL awaits.
export default function Loading() {
  return <PageSkeleton cards={4} />;
}
