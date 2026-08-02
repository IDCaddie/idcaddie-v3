import { getSlackConnectionStatus } from "@/lib/data/oauth-completion-status";
import { pollSlackConnectionStatusAction } from "./actions";
import { PendingStatus } from "./pending-status";

export const metadata = { title: "Completing your Slack connection · ID Caddie" };
// Always server-rendered: the whole value of this page is that a refresh shows the durable state, not a cached one.
export const dynamic = "force-dynamic";

// Where the OAuth callback sends a browser after the handoff. The connection is NOT complete when a customer arrives
// here — the completion worker is still doing the exchange — so nothing on this page may say otherwise. The first
// render already reflects the real job state, which is what makes a refresh truthful rather than a restart.
export default async function OAuthPendingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const correlationId = typeof sp.c === "string" ? sp.c : "";
  const initial = await getSlackConnectionStatus(correlationId);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <PendingStatus correlationId={correlationId} initial={initial} poll={pollSlackConnectionStatusAction} />
    </main>
  );
}
