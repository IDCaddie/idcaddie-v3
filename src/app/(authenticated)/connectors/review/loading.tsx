import { PageSkeleton } from "@/components/skeleton";

// Static Suspense fallback for /connectors/review (no data, no hooks) — shows the page shape (counts + batch table)
// while the server DALs await.
export default function Loading() {
  return <PageSkeleton table />;
}
