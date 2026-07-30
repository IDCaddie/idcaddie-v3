"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  validateOktaOrgHost, normalizeOrgInput, ORG_HOST_MESSAGE, validateOktaClientId,
  OKTA_CONTENT, OKTA_SETUP, OKTA_APPROVED_PUBLIC_KID, type OrgHostReason,
} from "@/lib/customer-connectors/okta-content";
import { setDemoConnection } from "@/lib/customer-connectors/demo-store";

type Step = "instructions" | "organization" | "configuration" | "review" | "saved";
const STEPS = ["Instructions", "Organization", "Configuration", "Review"] as const;
function stepIndex(s: Step): number {
  switch (s) {
    case "instructions": return 0;
    case "organization": return 1;
    case "configuration": return 2;
    case "review": return 3;
    default: return -1; // "saved" is terminal
  }
}

const primary = "inline-flex items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 dark:bg-white dark:text-zinc-900";
const secondary = "inline-flex items-center justify-center rounded-md border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700";
const field = "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-950";

// The Okta API Services configuration guide, inside a centered setup card. Okta is a SERVICE APPLICATION — there is NO browser
// OAuth, NO /authorize redirect, NO consent, NO callback, NO refresh token. This wizard only collects NON-SECRET configuration
// metadata (issuer, client id, declared completions) and, on save, shows "verification pending". A real client-credentials
// verification happens later, server-side. It contacts nothing, stores no secret, and the private key is never entered here.
export function OktaConnectWizard({ provider }: { provider: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("instructions");
  const [orgInput, setOrgInput] = useState("");
  const [orgHost, setOrgHost] = useState<string | null>(null);
  const [customDomain, setCustomDomain] = useState(false);
  const [orgError, setOrgError] = useState<OrgHostReason | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientIdError, setClientIdError] = useState(false);
  const [keyRegistered, setKeyRegistered] = useState(false);
  const [scopeGranted, setScopeGranted] = useState(false);
  const [roleAssigned, setRoleAssigned] = useState(false);
  const orgId = useId();
  const clientFieldId = useId();

  const issuer = orgHost ? `https://${orgHost}` : null;
  const current = stepIndex(step);
  const terminal = step === "saved";
  const declarationsDone = keyRegistered && scopeGranted && roleAssigned;

  function submitOrg(e: React.FormEvent) {
    e.preventDefault();
    const r = validateOktaOrgHost(normalizeOrgInput(orgInput, { customDomain }));
    if (!r.ok) { setOrgError(r.reason); return; }
    setOrgError(null);
    setOrgHost(r.host);
    setStep("configuration");
  }

  function submitConfiguration(e: React.FormEvent) {
    e.preventDefault();
    const r = validateOktaClientId(clientId);
    if (!r.ok) { setClientIdError(true); return; }
    setClientIdError(false);
    setClientId(r.value);
    setStep("review");
  }

  function save() {
    // The ONLY state write: the isolated sessionStorage preview state, marked verification_pending (NOT connected). No server/DB,
    // no credential/token/OAuth/ECS action. The client id is non-secret and not retained in the demo store.
    setDemoConnection(provider, { status: "verification_pending", orgHost, connectedAt: new Date().toISOString() });
    setStep("saved");
  }

  return (
    <div className="w-full rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-8">
      <div className="space-y-6">
        {!terminal && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <span className="font-semibold">Preview mode</span> — this walkthrough does not contact Okta or create a real connection.
          </div>
        )}

        {!terminal && (
          <div>
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">{STEPS[current]}</span>
              <span className="text-zinc-400 dark:text-zinc-500">Step {current + 1} of 4</span>
            </div>
            <ol className="mt-2 flex gap-1.5" aria-label={`Step ${current + 1} of 4: ${STEPS[current]}`}>
              {STEPS.map((label, i) => (
                <li key={label} aria-current={i === current ? "step" : undefined}
                  className={`h-2 flex-1 rounded-full ${i === current ? "bg-zinc-900 dark:bg-white" : i < current ? "bg-zinc-400 dark:bg-zinc-500" : "bg-zinc-200 dark:bg-zinc-800"}`}>
                  <span className="sr-only">{label}{i < current ? " (completed)" : i === current ? " (current)" : ""}</span>
                </li>
              ))}
            </ol>
            <div aria-live="polite" className="sr-only">{`Step ${current + 1} of 4: ${STEPS[current]}`}</div>
          </div>
        )}

        {step === "instructions" && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{OKTA_SETUP.title}</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{OKTA_SETUP.intro}</p>
            </div>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
              {OKTA_SETUP.adminSteps.map((s) => <li key={s}>{s}</li>)}
            </ol>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{OKTA_SETUP.scopeStepTitle}</div>
              <p className="mt-0.5 text-xs text-zinc-500">{OKTA_SETUP.scopeStepNote}</p>
              <dl className="mt-2 space-y-1.5">
                {OKTA_CONTENT.scopeExplanations.map((s) => (
                  <div key={s.scope}>
                    <dt><code className="text-sm text-zinc-700 dark:text-zinc-300">{s.scope}</code></dt>
                    <dd className="text-xs text-zinc-500 dark:text-zinc-400">{s.permits}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{OKTA_SETUP.roleStepTitle}</div>
              <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{OKTA_SETUP.roleStepNote}</p>
              <div className="mt-2 text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{OKTA_SETUP.scopeVsRoleTitle}</div>
              <p className="mt-0.5 text-xs text-zinc-500">{OKTA_SETUP.scopeVsRoleNote}</p>
            </div>
            <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{OKTA_CONTENT.notRequestedTitle}</div>
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                {OKTA_CONTENT.notRequested.map((n) => <li key={n}>{n}</li>)}
              </ul>
              <p className="mt-2 text-xs text-zinc-500">{OKTA_CONTENT.readOnlyStatement}</p>
              <p className="mt-1 text-xs text-zinc-500">{OKTA_SETUP.noTokenNote}</p>
            </div>
            <details className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <summary className="cursor-pointer text-sm font-medium">{OKTA_SETUP.troubleshootingTitle}</summary>
              <dl className="mt-2 space-y-2">
                {OKTA_SETUP.troubleshooting.map((t) => (
                  <div key={t.symptom}>
                    <dt className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{t.symptom}</dt>
                    <dd className="text-xs text-zinc-500 dark:text-zinc-400">{t.cause} {t.fix}</dd>
                  </div>
                ))}
              </dl>
            </details>
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep("organization")} className={primary}>Start setup</button>
              <Link href={`/connectors/${provider}`} className={secondary}>Cancel</Link>
            </div>
          </div>
        )}

        {step === "organization" && (
          <form onSubmit={submitOrg} className="space-y-4" noValidate>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Your Okta organization</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Enter your Okta organization address. We use it to form the issuer.</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={orgId} className="block text-sm font-medium">Okta organization address</label>
              <input id={orgId} value={orgInput} onChange={(e) => { setOrgInput(e.target.value); setOrgError(null); }}
                placeholder={customDomain ? "your-company.oktapreview.com" : "your-company.okta.com"} autoComplete="off" spellCheck={false}
                aria-invalid={orgError != null} aria-describedby={orgError ? `${orgId}-err` : `${orgId}-hint`} className={field} />
              {orgError ? (
                <p id={`${orgId}-err`} role="alert" className="text-sm text-red-600 dark:text-red-400">{ORG_HOST_MESSAGE[orgError]}</p>
              ) : (
                <p id={`${orgId}-hint`} className="text-xs text-zinc-500">We use this only to prepare the configuration. Nothing is contacted or stored yet.</p>
              )}
              <label className="flex items-center gap-2 pt-1 text-xs text-zinc-500 dark:text-zinc-400">
                <input type="checkbox" checked={customDomain} onChange={(e) => { setCustomDomain(e.target.checked); setOrgError(null); }} className="rounded border-zinc-300 dark:border-zinc-600" />
                {/* O1C: this only disables the convenience `.okta.com` append so a preview/EMEA address can be typed in full. It has
                    never enabled vanity/custom domains — those are unsupported (the runner requires the issuer to be derivable from
                    the org host). The old label "Use a custom Okta domain" promised something the product does not do. */}
                My address ends in .oktapreview.com or .okta-emea.com
              </label>
            </div>
            <div className="flex gap-2">
              <button type="submit" className={primary}>Continue</button>
              <button type="button" onClick={() => setStep("instructions")} className={secondary}>Back</button>
            </div>
          </form>
        )}

        {step === "configuration" && (
          <form onSubmit={submitConfiguration} className="space-y-4" noValidate>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Service application details</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Enter the API Services client ID and confirm the setup steps. No secret is entered here.</p>
            </div>
            {issuer && (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/60">
                <span className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{OKTA_SETUP.issuerLabel}</span>
                <div><code className="text-zinc-700 dark:text-zinc-300">{issuer}</code></div>
              </div>
            )}
            <div className="space-y-1.5">
              <label htmlFor={clientFieldId} className="block text-sm font-medium">{OKTA_SETUP.clientIdLabel}</label>
              <input id={clientFieldId} value={clientId} onChange={(e) => { setClientId(e.target.value); setClientIdError(false); }}
                placeholder="0oa…" autoComplete="off" spellCheck={false} aria-invalid={clientIdError}
                aria-describedby={clientIdError ? `${clientFieldId}-err` : `${clientFieldId}-hint`} className={field} />
              {clientIdError ? (
                <p id={`${clientFieldId}-err`} role="alert" className="text-sm text-red-600 dark:text-red-400">{OKTA_SETUP.clientIdError}</p>
              ) : (
                <p id={`${clientFieldId}-hint`} className="text-xs text-zinc-500">{OKTA_SETUP.clientIdHint}</p>
              )}
            </div>
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{OKTA_SETUP.keyStepTitle}</div>
              <p className="mt-0.5 text-xs text-zinc-500">{OKTA_SETUP.keyStepNote}</p>
              <code className="mt-1 block break-all text-xs text-zinc-700 dark:text-zinc-300">KID {OKTA_APPROVED_PUBLIC_KID}</code>
            </div>
            <fieldset className="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
              <legend className="sr-only">Confirm the Okta admin setup steps</legend>
              <label className="flex items-start gap-2"><input type="checkbox" checked={keyRegistered} onChange={(e) => setKeyRegistered(e.target.checked)} className="mt-1 rounded border-zinc-300 dark:border-zinc-600" />{OKTA_SETUP.declareKey}</label>
              <label className="flex items-start gap-2"><input type="checkbox" checked={scopeGranted} onChange={(e) => setScopeGranted(e.target.checked)} className="mt-1 rounded border-zinc-300 dark:border-zinc-600" />{OKTA_SETUP.declareScope}</label>
              <label className="flex items-start gap-2"><input type="checkbox" checked={roleAssigned} onChange={(e) => setRoleAssigned(e.target.checked)} className="mt-1 rounded border-zinc-300 dark:border-zinc-600" />{OKTA_SETUP.declareRole}</label>
            </fieldset>
            <div className="flex gap-2">
              <button type="submit" disabled={!declarationsDone} className={primary}>Review</button>
              <button type="button" onClick={() => setStep("organization")} className={secondary}>Back</button>
            </div>
            {!declarationsDone && <p className="text-xs text-zinc-500">Confirm all three setup steps to continue.</p>}
          </form>
        )}

        {step === "review" && (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{OKTA_SETUP.reviewTitle}</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">Confirm the non-secret configuration before saving. No secret or private key is shown.</p>
            </div>
            <dl className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
              <div className="flex justify-between gap-3 px-3 py-2"><dt className="text-zinc-500">{OKTA_SETUP.issuerLabel}</dt><dd className="text-right"><code className="text-zinc-700 dark:text-zinc-300">{issuer}</code></dd></div>
              <div className="flex justify-between gap-3 px-3 py-2"><dt className="text-zinc-500">{OKTA_SETUP.clientIdLabel}</dt><dd className="text-right"><code className="break-all text-zinc-700 dark:text-zinc-300">{clientId}</code></dd></div>
              <div className="flex justify-between gap-3 px-3 py-2"><dt className="text-zinc-500">Scopes</dt><dd className="text-right">{OKTA_CONTENT.scopeLabels.map((s) => <code key={s} className="block text-zinc-700 dark:text-zinc-300">{s}</code>)}</dd></div>
              <div className="flex justify-between gap-3 px-3 py-2"><dt className="text-zinc-500">Public key</dt><dd className="text-right break-all text-zinc-700 dark:text-zinc-300">KID {OKTA_APPROVED_PUBLIC_KID}</dd></div>
              <div className="flex justify-between gap-3 px-3 py-2"><dt className="text-zinc-500">Admin role</dt><dd className="text-right text-zinc-700 dark:text-zinc-300">Read-only, assigned</dd></div>
              <div className="flex justify-between gap-3 px-3 py-2"><dt className="text-zinc-500">Access</dt><dd className="text-right text-zinc-700 dark:text-zinc-300">Read-only</dd></div>
              <div className="flex justify-between gap-3 px-3 py-2"><dt className="text-zinc-500">Status</dt><dd className="text-right text-zinc-700 dark:text-zinc-300">{OKTA_SETUP.statusLabel}</dd></div>
            </dl>
            <p className="text-xs text-zinc-500">{OKTA_SETUP.serverValidatedNote} {OKTA_SETUP.statusNote}</p>
            <div className="flex gap-2">
              <button type="button" onClick={save} className={primary}>Save configuration</button>
              <button type="button" onClick={() => setStep("configuration")} className={secondary}>Back</button>
            </div>
          </div>
        )}

        {step === "saved" && (
          <div className="space-y-4" role="status">
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
              <h2 className="text-lg font-semibold text-amber-800 dark:text-amber-300">{OKTA_SETUP.savedTitle}</h2>
              <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">{OKTA_SETUP.savedMessage}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href={`/connectors/${provider}/status`} className={primary}>View configuration</Link>
              <Link href="/connectors" className={secondary}>Return to connectors</Link>
              <button type="button" onClick={() => router.push(`/connectors/${provider}`)} className={secondary}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
