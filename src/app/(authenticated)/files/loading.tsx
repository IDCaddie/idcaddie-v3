import { PageSkeleton } from "@/components/skeleton";

// Static Suspense fallback for /files (no data, no hooks, no links) — shows page shape while the server DAL awaits.
export default function Loading() {
  return <PageSkeleton cards={5} />;
}
