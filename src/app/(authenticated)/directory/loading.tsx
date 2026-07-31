import { PageSkeleton } from "@/components/skeleton";

// One loading.tsx covers all three /directory list routes. Each pages a whole node table before first paint, so the skeleton is doing
// real work — a bare "Loading…" would sit there for the duration of the round trips.
export default function Loading() {
  return <PageSkeleton table />;
}
