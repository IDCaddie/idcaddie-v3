// Phase 7B — the canonical SOURCE CAPABILITY model.
//
// The problem this exists to solve: today a surface asks "did Okta give me groups?" and every other provider falls through to a
// zero. A zero is a claim — it says "we looked and there are none". For an unconnected or unimplemented source the truth is
// "we cannot know", and those are different answers that must never render the same way.
//
// TWO ORTHOGONAL AXES, deliberately not collapsed:
//
//   SUPPORT   Has ID Caddie built this capability for this provider?     Static. Same for every customer.
//   STATE     What does THIS workspace's connector actually have?        Per connector, per tenant.
//
// A provider can be `planned` for Usage while a workspace has a healthy connector — the answer is still "not built yet", not
// "0 active users". And a provider can be `implemented` for Groups while a workspace has no connector — the answer is "connect
// one", not "0 groups". Collapsing the axes is what produces the zero.
//
// PURE. No I/O, no server import. Callers pass in the connector facts they already loaded.

export const CAPABILITIES = [
  "identity", "groups", "directory_applications", "memberships", "assignments",
  "app_accounts", "roles", "usage", "licenses",
  "contracts", "invoices", "spend",
  "hr_manager", "hr_department",
  "browser_discovery", "files", "activity",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

// Capabilities are named for what a SOURCE PROVIDES, not for the metric a page renders from them. "Identity records" is a
// capability; "People" is a metric derived from it. Using the metric name here made the two indistinguishable on screen.
export const CAPABILITY_LABEL: Record<Capability, string> = {
  identity: "Identity records", groups: "Group records", directory_applications: "Directory application records",
  memberships: "Group memberships", assignments: "Application assignments",
  app_accounts: "Application accounts", roles: "Roles", usage: "Usage", licenses: "Licenses",
  contracts: "Contracts", invoices: "Invoices", spend: "Spend",
  hr_manager: "Manager", hr_department: "Department",
  browser_discovery: "Browser discovery", files: "Files", activity: "Activity",
};

// Has ID Caddie BUILT this? Not "could this provider do it" — providers can do far more than we read.
//   implemented    — there is a discovery path, a persistence model and a read contract, proven end to end
//   planned        — on the roadmap; no ingestion exists, so no workspace can have this data
//   not_applicable — this provider does not expose it at all; it will never light up
export type Support = "implemented" | "planned" | "not_applicable";

// What this workspace can actually see. Nine states, none of which is a number.
export type SourceState =
  | "available"        // implemented, connected, discovered, current
  | "not_connected"    // implemented, but this workspace has no connector for the provider
  | "source_required"  // implemented, but needs a DIFFERENT provider that is not connected
  | "incomplete"       // connector exists; discovery has not produced this capability yet
  | "stale"            // last observation is not current
  | "failed"           // the last attempt failed
  | "review_required"  // discovery completed but was flagged for review
  | "unavailable"      // ID Caddie has not built it (planned / not_applicable)
  | "unknown";         // we could not determine it — a READ FAILURE, never a zero

export type CapabilityStatus = {
  readonly capability: Capability;
  readonly label: string;
  readonly provider: string | null;      // which provider owns it, when one does
  readonly connectorId: string | null;
  readonly support: Support;
  readonly state: SourceState;
  readonly lastObservedAt: string | null;
  readonly confidence: "high" | "medium" | "low" | "none";
  // The sentence a customer reads. Never "0", never a bare state name.
  readonly explanation: string;
};

// ── the support matrix ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Only Okta has any `implemented` capability today, and only for the five directory ones. Everything else is `planned`. That is
// the honest state of the product, and writing it down is what stops a surface guessing.
const DIRECTORY: Capability[] = ["identity", "groups", "directory_applications", "memberships", "assignments"];

const SUPPORT: Record<string, Partial<Record<Capability, Support>>> = {
  okta: Object.fromEntries([
    ...DIRECTORY.map((c) => [c, "implemented" as Support]),
    ...(["app_accounts", "roles", "usage", "licenses"] as Capability[]).map((c) => [c, "planned" as Support]),
    ...(["contracts", "invoices", "spend", "browser_discovery", "files", "activity"] as Capability[]).map((c) => [c, "not_applicable" as Support]),
    ["hr_manager", "planned"], ["hr_department", "planned"],
  ]) as Partial<Record<Capability, Support>>,
  microsoft_entra: Object.fromEntries(DIRECTORY.map((c) => [c, "planned" as Support])) as Partial<Record<Capability, Support>>,
  slack: Object.fromEntries((["app_accounts", "roles", "usage", "activity"] as Capability[]).map((c) => [c, "planned" as Support])) as Partial<Record<Capability, Support>>,
  google_workspace: Object.fromEntries(DIRECTORY.map((c) => [c, "planned" as Support])) as Partial<Record<Capability, Support>>,
};

// Unlisted provider/capability pairs are `not_applicable`: we make no claim that a provider we have not modelled offers something.
export const supportFor = (provider: string, c: Capability): Support => SUPPORT[provider]?.[c] ?? "not_applicable";

// Which provider OWNS a capability for the product. One owner per capability — the rule that stops two surfaces disagreeing.
const OWNER: Partial<Record<Capability, string>> = {
  identity: "okta", groups: "okta", directory_applications: "okta", memberships: "okta", assignments: "okta",
};
export const ownerOf = (c: Capability): string | null => OWNER[c] ?? null;

// ── resolution ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type ConnectorFacts = {
  readonly id: string; readonly provider: string;
  readonly active: boolean;
  readonly lifecycle: string;                  // from the connector inventory
  readonly healthState: "healthy" | "attention" | "failed" | "inactive" | "pending";
  readonly lastDiscoveryAt: string | null;
  readonly hasCurrentData: boolean;            // this capability produced at least one current row
  readonly hasStaleData: boolean;
};

const EXPLAIN: Record<SourceState, (label: string, provider: string | null) => string> = {
  available: (l) => `${l} is current from the connected directory.`,
  not_connected: (l, p) => `${l} requires a connected ${p ?? "source"} connector. Nothing has been connected yet.`,
  source_required: (l, p) => `${l} comes from ${p ?? "another source"}, which is not connected.`,
  incomplete: (l) => `${l} has not been discovered yet for this connector.`,
  stale: (l) => `${l} was last seen in an earlier discovery and has not been re-observed.`,
  failed: (l) => `The last attempt to read ${l.toLowerCase()} failed.`,
  review_required: (l) => `${l} was discovered but flagged for review before it can be relied on.`,
  unavailable: (l, p) => `${l} is not available for ${p ?? "this provider"} yet.`,
  unknown: (l) => `${l} could not be determined. This is not a statement that there is none.`,
};

// Resolve ONE capability against the connectors a workspace has. `connectors` is what the caller already loaded — this function
// fetches nothing.
export function resolveCapability(c: Capability, connectors: readonly ConnectorFacts[], readFailed = false): CapabilityStatus {
  const label = CAPABILITY_LABEL[c];
  const owner = ownerOf(c);

  // A read failure is its own answer. It must be checked FIRST: deciding "not connected" from a failed read would be a claim
  // about an estate we could not see.
  if (readFailed) {
    return { capability: c, label, provider: owner, connectorId: null, support: "planned", state: "unknown", lastObservedAt: null, confidence: "none", explanation: EXPLAIN.unknown(label, owner) };
  }

  // Candidates: active connectors whose provider has this capability IMPLEMENTED.
  const candidates = connectors.filter((x) => x.active && supportFor(x.provider, c) === "implemented");

  if (candidates.length === 0) {
    // Is it unbuilt, or just unconnected? A workspace with a healthy Slack connector still cannot have Usage, because Usage is
    // not built — answering "not connected" there would send someone to connect something they already have.
    const anyImplemented = connectors.some((x) => supportFor(x.provider, c) === "implemented")
      || (owner !== null && Object.values(SUPPORT[owner] ?? {}).length > 0 && supportFor(owner, c) === "implemented");
    if (!anyImplemented) {
      return { capability: c, label, provider: owner, connectorId: null, support: "planned", state: "unavailable", lastObservedAt: null, confidence: "none", explanation: EXPLAIN.unavailable(label, owner) };
    }
    const state: SourceState = connectors.some((x) => x.active) ? "source_required" : "not_connected";
    return { capability: c, label, provider: owner, connectorId: null, support: "implemented", state, lastObservedAt: null, confidence: "none", explanation: EXPLAIN[state](label, owner) };
  }

  // Best candidate: the one furthest along. A failure anywhere is reported rather than hidden behind a healthier sibling only
  // when no sibling actually has the data.
  const withData = candidates.filter((x) => x.hasCurrentData);
  const best = withData[0] ?? candidates.find((x) => x.healthState === "failed") ?? candidates[0];

  let state: SourceState;
  if (best.healthState === "failed") state = "failed";
  else if (best.hasCurrentData) state = "available";
  else if (best.hasStaleData) state = "stale";
  else state = "incomplete";

  return {
    capability: c, label, provider: best.provider, connectorId: best.id,
    support: "implemented", state, lastObservedAt: best.lastDiscoveryAt,
    confidence: state === "available" ? "high" : state === "stale" ? "medium" : "none",
    explanation: EXPLAIN[state](label, best.provider),
  };
}

export const resolveAll = (connectors: readonly ConnectorFacts[], readFailed = false): Record<Capability, CapabilityStatus> =>
  Object.fromEntries(CAPABILITIES.map((c) => [c, resolveCapability(c, connectors, readFailed)])) as Record<Capability, CapabilityStatus>;

// A capability may show a NUMBER only when it is genuinely available. Every other state renders its explanation instead — this is
// the single guard that keeps "unsupported" from ever appearing as 0.
export const canShowValue = (s: CapabilityStatus): boolean => s.state === "available" || s.state === "stale";
