"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { validateOktaOrgHost, normalizeOrgInput, ORG_HOST_MESSAGE, OKTA_CONTENT, type OrgHostReason } from "@/lib/customer-connectors/okta-content";
import { setDemoConnection, clearDemoConnection } from "@/lib/customer-connectors/demo-store";

type Step = "org" | "permissions" | "authorize" | "check" | "success" | "failed";

// Four customer-facing steps. The connection "check" is an internal confirmation folded into the authorize→connected transition
// (it stays step 3 — Authorize), so the customer only ever sees a clean 4-step flow.
const CUSTOMER_STEPS = ["Organization", "Permissions", "Authorize", "Connected"] as const;
function customerIndex(step: Step): number {
  switch (step) {
    case "org": return 0;
    case "permissions": return 1;
    case "authorize":
    case "check": return 2;
    case "success": return 3;
    default: return -1; // "failed" is terminal — never announced as a numbered step
  }
}

const primary = "inline-flex items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 dark:bg-white dark:text-zinc-900";
const secondary = "inline-flex items-center justify-center rounded-md border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700";

// The Okta preview connection wizard, inside a centered setup card. A SIMULATED, clearly-labelled preview flow — NO real OAuth
// redirect, NO network request, NO token/secret/credential, NO DB write. The only persisted state is the browser-sessionStorage
// preview connection (on success). One preview banner; a strong 4-step progress bar; concrete, honest connection checks.
export function OktaConnectWizard({ provider }: { provider: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("org");
  const [orgInput, setOrgInput] = useState("");
  const [orgHost, setOrgHost] = useState<string | null>(null);
  const [customDomain, setCustomDomain] = useState(false);
  const [error, setError] = useState<OrgHostReason | null>(null);
  const orgId = useId();

  const current = customerIndex(step);
  const terminal = step === "success" || step === "failed";
  const stepName = current >= 0 ? CUSTOMER_STEPS[current] : "Not connected";

  function submitOrg(e: React.FormEvent) {
    e.preventDefault();
    // Normalize a bare label ("your-company" → "your-company.okta.com") then run the UNCHANGED strict SSRF-safe validator.
    const r = validateOktaOrgHost(normalizeOrgInput(orgInput, { customDomain }));
    if (!r.ok) { setError(r.reason); return; }
    setError(null);
    setOrgHost(r.host);
    setStep("permissions");
  }

  function complete() {
    // The ONLY state write: the isolated sessionStorage preview connection. No server/DB/credential/token/OAuth/ECS action.
    setDemoConnection(provider, { status: "connected_preview", orgHost, connectedAt: new Date().toISOString() });
    setStep("success");
  }

  return (
    <div className="w-full rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-8">
      <div className="space-y-6">
        {/* ONE preview banner — non-terminal only (the success/failed panels carry their own preview framing) */}
        {!terminal && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <span className="font-semibold">Preview mode</span> — this walkthrough does not contact Okta or create a real connection.
          </div>
        )}

        {/* Progress bar — hidden on terminal states. Current segment is strong; completed segments are a muted fill. */}
        {!terminal && (
          <div>
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">{stepName}</span>
              <span className="text-zinc-400 dark:text-zinc-500">Step {current + 1} of 4</span>
            </div>
            <ol className="mt-2 flex gap-1.5" aria-label={`Step ${current + 1} of 4: ${stepName}`}>
              {CUSTOMER_STEPS.map((label, i) => (
                <li key={label} aria-current={i === current ? "step" : undefined}
                  className={`h-2 flex-1 rounded-full ${i === current ? "bg-zinc-900 dark:bg-white" : i < current ? "bg-zinc-400 dark:bg-zinc-500" : "bg-zinc-200 dark:bg-zinc-800"}`}>
                  <span className="sr-only">{label}{i < current ? " (completed)" : i === current ? " (current)" : ""}</span>
                </li>
              ))}
            </ol>
            {/* SR step announcement (non-terminal only; terminal states are announced by their own role="status" panels) */}
            <div aria-live="polite" className="sr-only">{`Step ${current + 1} of 4: ${stepName}`}</div>
          </div>
        )}

        {step === "org" && (
          <form onSubmit={submitOrg} className="space-y-4" noValidate>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Your Okta organization</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Enter the address your team uses to sign in to Okta.</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={orgId} className="block text-sm font-medium">Okta organization address</label>
              <input id={orgId} value={orgInput} onChange={(e) => { setOrgInput(e.target.value); setError(null); }}
                placeholder={customDomain ? "your-company.oktapreview.com" : "your-company.okta.com"} autoComplete="off" spellCheck={false}
                aria-invalid={error != null} aria-describedby={error ? `${orgId}-err` : `${orgId}-hint`}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-950" />
              {error ? (
                <p id={`${orgId}-err`} role="alert" className="text-sm text-red-600 dark:text-red-400">{ORG_HOST_MESSAGE[error]}</p>
              ) : (
                <p id={`${orgId}-hint`} className="text-xs text-zinc-500">We use this only to prepare the connection. Nothing is contacted or stored yet.</p>
              )}
              <label className="flex items-center gap-2 pt-1 text-xs text-zinc-500 dark:text-zinc-400">
                <input type="checkbox" checked={customDomain} onChange={(e) => { setCustomDomain(e.target.checked); setError(null); }}
                  className="rounded border-zinc-300 dark:border-zinc-600" />
                Use a custom Okta domain
              </label>
            </div>
            <div className="flex gap-2">
              <button type="submit" className={primary}>Continue</button>
              <Link href={`/connectors/${provider}`} className={secondary}>Cancel</Link>
            </div>
          </form>
        )}

        {step === "permissions" && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Permissions</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">ID Caddie requests read-only access to:</p>
            </div>
            <ul className="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
              {OKTA_CONTENT.requestsReadOnly.map((r) => (
                <li key={r} className="flex items-center gap-2"><span aria-hidden="true" className="text-green-600">✓</span>{r}</li>
              ))}
            </ul>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Technical scope</div>
              <code className="text-sm text-zinc-700 dark:text-zinc-300">{OKTA_CONTENT.scopeLabel}</code>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{OKTA_CONTENT.permissionsAssurance}</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep("authorize")} className={primary}>Continue to Okta</button>
              <button type="button" onClick={() => setStep("org")} className={secondary}>Back</button>
            </div>
          </div>
        )}

        {step === "authorize" && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Authorize with Okta</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">In the live version, you’ll be redirected securely to Okta to approve read-only access.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setStep("check")} className={primary}>Simulate approval</button>
              <button type="button" onClick={() => setStep("failed")} className={secondary}>Simulate a failed approval</button>
              <Link href={`/connectors/${provider}`} className={secondary}>Cancel</Link>
            </div>
          </div>
        )}

        {step === "check" && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Approval received</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Finishing your preview connection.</p>
            </div>
            <ul className="space-y-2 text-sm">
              {["Okta organization confirmed", "Read-only access approved", "No data imported yet", "Ready for first sync"].map((c) => (
                <li key={c} className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300"><span aria-hidden="true" className="text-green-600">✓</span>{c}</li>
              ))}
            </ul>
            <button type="button" onClick={complete} className={primary}>Complete connection</button>
          </div>
        )}

        {step === "success" && (
          <div className="space-y-4" role="status">
            <div className="rounded-lg border border-green-300 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950">
              <h2 className="text-lg font-semibold text-green-800 dark:text-green-300">Okta connected in preview mode</h2>
              <p className="mt-1 text-sm text-green-800 dark:text-green-300">Your connection is ready for a supervised first sync. No data has been imported yet.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href={`/connectors/${provider}/status`} className={primary}>View connection</Link>
              <Link href="/connectors" className={secondary}>Return to connectors</Link>
              <button type="button" onClick={() => { clearDemoConnection(provider); router.push(`/connectors/${provider}`); }} className={secondary}>Disconnect preview</button>
            </div>
          </div>
        )}

        {step === "failed" && (
          <div className="space-y-4" role="status">
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
              <h2 className="text-lg font-semibold text-red-800 dark:text-red-300">Connection not completed</h2>
              <p className="mt-1 text-sm text-red-800 dark:text-red-300">The preview authorization was not approved. No connection was made and no data was accessed.</p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep("authorize")} className={primary}>Try again</button>
              <Link href={`/connectors/${provider}`} className={secondary}>Back to connector</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
