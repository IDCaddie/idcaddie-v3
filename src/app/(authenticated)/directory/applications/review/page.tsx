import Link from "next/link";
import { Badge } from "@/components/badge";
import { loadApplicationMatchReview } from "@/lib/data/application-match-review";
import { isDecideStatus, type MatchCandidateView, type MatchStatus } from "@/lib/canonical/application-match-review";
import { decideApplicationMatchAction } from "./actions";

export const metadata = { title: "Application match review · ID Caddie" };

// Phase 18F-B — the human review surface for application-match proposals.
//
// THE QUESTION ON THE SCREEN, and it is the only one: *is this application from your identity provider the same thing as this
// operational record?* Everything the layout does is in service of not answering it on the customer's behalf.
//
// Why no candidate is emphasised, ordered first, scored, or pre-selected: the evidence behind a proposal proves the PRODUCT
// (the provider's identifier resolved to a confirmed canonical product) and never the INSTANCE — and that stays true when
// exactly one record exists, where the candidate set is exhaustive by cardinality rather than by evidence. Every candidate row
// is therefore built from the same fields, with the same controls, in one alphabetical order. The read this page uses does not
// even return `confidence`, so there is nothing here to rank by; the ordering lives in the pure layer where a test pins it.
//
// Why there is no re-run control: a settled accept/reject is immutable through the decision command, and re-proposing the same
// pair is a no-op that can never resurrect it. A "check again" button would suggest otherwise on a page whose whole job is to
// hold decisions still.
//
// Read/write boundary: the queue is loaded by an owner/admin-gated loader; the two controls post to a server action that calls
// the one governed decision command. This page performs no query, holds no tenant id, and mutates nothing itself.

const STATE: Record<MatchStatus, { tone: "success" | "neutral" | "attention"; label: string }> = {
  proposed: { tone: "attention", label: "Awaiting your decision" },
  accepted: { tone: "success", label: "Accepted" },
  rejected: { tone: "neutral", label: "Rejected" },
};

// The `?status=` code from the last decision, as a sentence. Note what is NOT an error here: a replayed decision and a lost
// race both changed nothing and both are perfectly ordinary, so neither is dressed as a failure. Nothing from the database
// besides these fixed codes ever reaches this function, so no query detail can reach the screen.
function banner(status: string | undefined): { tone: "success" | "danger" | "neutral"; text: string } | null {
  if (status === undefined) return null;
  if (status === "query_failed") {
    return { tone: "danger", text: "We could not record that decision just now. Nothing changed — please try again." };
  }
  if (!isDecideStatus(status)) return null;
  switch (status) {
    case "accepted":
      return { tone: "success", text: "Accepted. This application now corresponds to that operational record." };
    case "rejected":
      return {
        tone: "success",
        text: "Recorded: not that operational record. Every other record for the same software is still an open question.",
      };
    case "already_decided":
    case "already_accepted":
    case "already_rejected":
      return { tone: "neutral", text: "That candidate had already been decided, so nothing changed." };
    case "already_proposed":
      return { tone: "neutral", text: "That candidate is still awaiting a decision, so nothing changed." };
    case "accepted_exists":
      return {
        tone: "neutral",
        text: "Another operational record for this application was accepted first, so nothing changed. This candidate is still awaiting a decision.",
      };
    case "not_allowed":
      return {
        tone: "danger",
        text: "Deciding which operational record an application matches needs an owner or administrator role in this workspace.",
      };
    case "invalid_decision":
      return { tone: "danger", text: "That is not a decision we can record. Nothing changed — please try again." };
  }
}

// One candidate row. Every candidate gets this function, so there is no branch in which one of them renders differently from
// its siblings — the equal treatment is structural rather than a styling convention somebody has to remember.
function CandidateRow({ c }: { c: MatchCandidateView }) {
  const state = STATE[c.status];
  return (
    <tr className="border-b border-zinc-200 align-top dark:border-zinc-800">
      <td className="py-2 pr-4">
        <span className="inline-flex flex-wrap items-center gap-2">
          <Link href={`/apps/${c.appId}`} className="font-medium underline-offset-2 hover:underline">
            {c.recordLabel ?? "Unnamed record"}
          </Link>
          {/* Only when another candidate here carries the same name AND the same instance. Two rows a reader cannot tell
              apart is how somebody accepts the wrong one, so the short reference appears exactly where it is needed and
              nowhere else — it is a tie-breaker, never the label. */}
          {c.ambiguous ? <span className="font-mono text-xs text-zinc-500">#{c.matchId.slice(0, 8)}</span> : null}
        </span>
      </td>
      <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
        {c.instanceLabel ?? <span className="text-zinc-400">—</span>}
      </td>
      <td className="py-2 pr-4">
        <Badge tone={state.tone}>{state.label}</Badge>
      </td>
      <td className="py-2 pr-4">
        {c.status === "proposed" ? (
          <div className="flex flex-wrap items-center gap-2">
            <form action={decideApplicationMatchAction}>
              <input type="hidden" name="matchId" value={c.matchId} />
              <input type="hidden" name="decision" value="accepted" />
              <button type="submit" className="rounded border border-green-400 px-2 py-1 text-xs text-green-700 dark:text-green-400">
                Accept this record
              </button>
            </form>
            <form action={decideApplicationMatchAction}>
              <input type="hidden" name="matchId" value={c.matchId} />
              <input type="hidden" name="decision" value="rejected" />
              <button type="submit" className="rounded border border-zinc-400 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300">
                Not this record
              </button>
            </form>
          </div>
        ) : (
          <span className="text-xs text-zinc-500">Settled — kept as a record of the decision.</span>
        )}
      </td>
    </tr>
  );
}

export default async function ApplicationMatchReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const note = banner(typeof sp.status === "string" ? sp.status : undefined);
  const result = await loadApplicationMatchReview();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/directory/applications" className="text-zinc-500 hover:underline">
            ← Back to directory applications
          </Link>
        </div>
        <h1 className="text-xl font-semibold">Application match review</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Your identity provider&rsquo;s own identifier tells us which software an application is. It never tells us which of
          your operational records that software is — a product you hold two records for, production and a sandbox, looks like
          one thing from the provider&rsquo;s side. So each application below lists every operational record that could be its
          match, and the choice is yours to make.
        </p>
      </header>

      {note ? (
        <div
          className={`rounded border p-3 text-sm ${note.tone === "danger" ? "border-red-300 text-red-700 dark:text-red-400" : note.tone === "success" ? "border-green-300 text-green-700 dark:text-green-400" : "border-zinc-300 text-zinc-600 dark:border-zinc-700"}`}
        >
          {note.text}
        </div>
      ) : null}

      {!result.ok ? (
        result.error === "not_allowed" ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Deciding which operational record an application matches needs an owner or administrator role in this workspace.
            Ask someone with that role to review these matches.
          </p>
        ) : (
          <p className="text-sm text-red-600">Could not load the match review list right now. Please try again later.</p>
        )
      ) : result.data.groups.length === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No application is waiting on a match decision.</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            An application appears here once one of your operational records has been put forward as its match.
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Accepting a record says this application corresponds to that record. Choosing{" "}
            <span className="font-medium">Not this record</span> says only that — it never says the application is not the
            software named below, and every other record for that software stays an open question you can still answer.
          </p>

          {result.data.groups.map((g) => (
            <section key={g.directoryApplicationId} className="space-y-2 text-sm">
              <h2 className="font-medium">{g.applicationLabel ?? "Application no longer listed by your provider"}</h2>
              <p className="text-xs text-zinc-500">
                {g.productLabel !== null ? (
                  <>
                    Recognised as <span className="font-medium text-zinc-700 dark:text-zinc-300">{g.productLabel}</span> — that
                    much is already settled. What is open is which record below it is.
                  </>
                ) : (
                  <>The software behind this application has not been settled from a confirmed identifier.</>
                )}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                      <th className="py-2 pr-4 font-medium">Operational record</th>
                      <th className="py-2 pr-4 font-medium">Instance</th>
                      <th className="py-2 pr-4 font-medium">State</th>
                      <th className="py-2 pr-4 font-medium">Your decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.candidates.map((c) => (
                      <CandidateRow key={c.matchId} c={c} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          <p className="text-xs text-zinc-500">
            Records are listed by name, in no order of preference — nothing here has guessed which one is right. At most one
            record can be accepted for an application; if two people accept at the same moment, one wins and the other is told
            plainly that nothing changed.
          </p>
        </>
      )}
    </main>
  );
}
