"use client";
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { validateOktaOrgHost, ORG_HOST_MESSAGE, OKTA_CONTENT, type OrgHostReason } from "@/lib/customer-connectors/okta-content";
import { setDemoConnection, clearDemoConnection } from "@/lib/customer-connectors/demo-store";

type Step = "org" | "permissions" | "authorize" | "check" | "success" | "failed";
const STEP_LABEL: Record<Step, string> = { org: "Organization", permissions: "Permissions", authorize: "Authorize", check: "Connection check", success: "Connected", failed: "Not connected" };
const FLOW: Step[] = ["org", "permissions", "authorize", "check", "success"];

const primary = "inline-block rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-60 dark:bg-white dark:text-zinc-900";
const secondary = "inline-block rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700";

// The Okta preview connection wizard. A SIMULATED, clearly-labelled preview flow — NO real OAuth redirect, NO network request, NO
// token/secret/credential, NO DB write. The only persisted state is the browser-sessionStorage preview connection (on success).
export function OktaConnectWizard({ provider }: { provider: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("org");
  const [orgInput, setOrgInput] = useState("");
  const [orgHost, setOrgHost] = useState<string | null>(null);
  const [error, setError] = useState<OrgHostReason | null>(null);
  const orgId = useId();
  const liveRef = useRef<HTMLDivElement>(null);

  const stepIndex = FLOW.indexOf(step);

  function submitOrg(e: React.FormEvent) {
    e.preventDefault();
    const r = validateOktaOrgHost(orgInput);
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
    <div className="max-w-xl space-y-6">
      {/* Preview banner — unmissable, on every step */}
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
        Preview mode — this is a guided walkthrough. No real connection is made and no data is accessed.
      </div>

      {/* Step progress */}
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400" aria-label="Connection steps">
        {FLOW.map((s, i) => (
          <li key={s} aria-current={s === step ? "step" : undefined} className={s === step ? "font-medium text-zinc-900 dark:text-zinc-100" : ""}>
            {i + 1}. {STEP_LABEL[s]}
          </li>
        ))}
      </ol>

      {/* SR announcement of the current step. Terminal states (success/failed) are not in FLOW, so announce just their label
          rather than a synthesized "Step 1" (stepIndex is -1 for them). */}
      <div ref={liveRef} aria-live="polite" className="sr-only">{stepIndex < 0 ? STEP_LABEL[step] : `Step ${stepIndex + 1}: ${STEP_LABEL[step]}`}</div>

      {step === "org" && (
        <form onSubmit={submitOrg} className="space-y-3" noValidate>
          <h2 className="text-lg font-semibold">Your Okta organization</h2>
          <div className="space-y-1">
            <label htmlFor={orgId} className="block text-sm font-medium">Okta organization address</label>
            <input id={orgId} value={orgInput} onChange={(e) => { setOrgInput(e.target.value); setError(null); }} placeholder="your-company.okta.com" autoComplete="off" spellCheck={false}
              aria-invalid={error != null} aria-describedby={error ? `${orgId}-err` : `${orgId}-hint`}
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
            {error ? (
              <p id={`${orgId}-err`} className="text-sm text-red-600">{ORG_HOST_MESSAGE[error]}</p>
            ) : (
              <p id={`${orgId}-hint`} className="text-xs text-zinc-500">We only use this to build your Okta address. Nothing is contacted or stored yet.</p>
            )}
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primary}>Continue</button>
            <Link href={`/connectors/${provider}`} className={secondary}>Cancel</Link>
          </div>
        </form>
      )}

      {step === "permissions" && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Permissions</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">ID Caddie will request <span className="font-medium text-zinc-800 dark:text-zinc-200">read-only</span> access to your Okta users.</p>
          <div className="rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
            <div className="font-medium">Requested access: <span className="font-normal text-zinc-600 dark:text-zinc-400">{OKTA_CONTENT.scopeLabel}</span></div>
            <ul className="mt-2 space-y-1 text-zinc-600 dark:text-zinc-400">
              <li>Read users and their status — nothing is changed</li>
              <li>No passwords, no MFA data, no app changes, no writes</li>
            </ul>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setStep("authorize")} className={primary}>Continue to Okta</button>
            <button type="button" onClick={() => setStep("org")} className={secondary}>Back</button>
          </div>
        </div>
      )}

      {step === "authorize" && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Okta authorization preview</h2>
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p>This is a <span className="font-semibold">preview</span>. In production, you’ll be redirected securely to Okta to approve access. Right now, nothing is contacted.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setStep("check")} className={primary}>Simulate approval</button>
            <button type="button" onClick={() => setStep("failed")} className={secondary}>Simulate a failed approval</button>
            <Link href={`/connectors/${provider}`} className={secondary}>Cancel</Link>
          </div>
        </div>
      )}

      {step === "check" && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Connection check</h2>
          <ul className="space-y-2 text-sm">
            {["Organization verified", "Read-only permission approved", "Connection encrypted", "Ready for supervised first sync"].map((c) => (
              <li key={c} className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300"><span aria-hidden className="text-green-600">✓</span>{c}</li>
            ))}
          </ul>
          <p className="text-xs text-zinc-500">Simulated preview checks — no data was imported and no request was made.</p>
          <button type="button" onClick={complete} className={primary}>Complete connection</button>
        </div>
      )}

      {step === "success" && (
        <div className="space-y-3" role="status">
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
        <div className="space-y-3" role="status">
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
  );
}
