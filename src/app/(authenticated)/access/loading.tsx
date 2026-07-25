import { PageSkeleton } from "@/components/skeleton";

// Static Suspense fallback for /access — page shape while the server loader awaits (no data, no ids, no links).
export default function Loading() {
  return <PageSkeleton cards={6} />;
}
