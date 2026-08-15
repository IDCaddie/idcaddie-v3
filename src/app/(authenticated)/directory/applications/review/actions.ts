"use server";

// Phase 18F-B — the `"use server"` boundary the match-review controls call. A thin wrapper over the 0088 decision command in
// src/lib/data/application-match-review.ts, which is where the owner/admin gate and the bounded status vocabulary live.
//
// What this deliberately does NOT contain:
//   · no propose, and no matcher run — a control that regenerated proposals would sit one click away from the settled
//     decisions this queue exists to preserve, and 0088's candidate key already makes re-proposing a no-op that can never
//     resurrect a rejection. Nothing here needs to say that, because nothing here can start one;
//   · no batch verb. A decision is per candidate, on purpose: "accept all" cannot mean anything when the whole point is that
//     several records compete and at most one may win;
//   · no table write. `application_matches` is unreachable from a browser role, so the command is the only writer there is.
//
// The result is surfaced by redirecting back to the route with a status code — server-rendered truth, no client JS, no
// optimistic UI, so what the customer reads after a decision is what the database actually said.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { decideApplicationMatch } from "@/lib/data/application-match-review";
import { isDecision } from "@/lib/canonical/application-match-review";

const ROUTE = "/directory/applications/review";

/**
 * Record one human decision about one proposed candidate.
 *
 * Both inputs come from hidden fields, and both are validated before the command is called: the match id must be non-empty
 * and the decision must be one of the two the command admits. `proposed` is not admitted — it is a state, not a decision, and
 * accepting it here would let a crafted post ask the database for a transition that means nothing.
 */
export async function decideApplicationMatchAction(formData: FormData): Promise<void> {
  const matchId = (formData.get("matchId") ?? "").toString().trim();
  if (matchId === "") redirect(`${ROUTE}?status=invalid_decision`);

  const decision = (formData.get("decision") ?? "").toString();
  if (!isDecision(decision)) redirect(`${ROUTE}?status=invalid_decision`);

  const res = await decideApplicationMatch(matchId, decision);
  revalidatePath(ROUTE);
  if (!res.ok) redirect(`${ROUTE}?status=${res.error}`);
  redirect(`${ROUTE}?status=${res.status}`);
}
