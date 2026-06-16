import { getSessionUser } from "@/lib/auth/session";

export const metadata = { title: "ID Caddie" };

// Protected skeleton landing page. Deliberately NOT product UI — no app inventory, contracts,
// people, reports, etc. Those are future build-sequence stages (docs/06_BUILD_SEQUENCE.md).
export default async function ProtectedHome() {
  const user = await getSessionUser(); // guaranteed by the group layout; used only for display

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold">Protected skeleton</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        You are signed in{user?.email ? ` as ${user.email}` : ""}. This is the authenticated
        shell only — there is no product UI yet.
      </p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Tenant/org context is not resolved yet (next PR). Access to any data is enforced by
        Postgres RLS, not by this page.
      </p>
      <form action="/logout" method="post">
        <button
          type="submit"
          className="rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
