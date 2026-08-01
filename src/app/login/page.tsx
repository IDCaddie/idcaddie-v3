import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Sign in · ID Caddie" };

// Minimal, safe email + password sign-in via a Server Action (runs only on the server).
// No self-serve signup, no tenant creation, no OAuth/SAML/SCIM — accounts are provisioned
// out-of-band for this skeleton. Magic-link is avoided because it needs hosted email config.
async function signIn(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    redirect("/login?error=" + encodeURIComponent("Enter your email and password."));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Generic message — never reveal whether the email exists.
    redirect("/login?error=" + encodeURIComponent("Invalid email or password."));
  }
  redirect("/");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Sign in to ID Caddie</h1>
          <p className="text-sm text-zinc-500">Identity and SaaS access governance.</p>
        </div>
        <form action={signIn} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="email" className="block text-sm font-medium">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="password" className="block text-sm font-medium">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="w-full rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <button
            type="submit"
            className="w-full rounded bg-zinc-900 px-4 py-2 text-white dark:bg-white dark:text-zinc-900"
          >
            Sign in
          </button>
        </form>
        <p className="text-xs text-zinc-500">
          Accounts are provisioned by your administrator.
        </p>
      </div>
    </main>
  );
}
