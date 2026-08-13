// Phase 16 — the cross-source engine.
//
// The property this suite exists to protect: the engine must never turn "we could not look" into "we looked and found
// none". Most of the cases below are one restatement of that; the rest pin determinism, so a finding keeps its identity
// and therefore its age.

import { describe, expect, it } from "vitest";
import { evaluateCrossSourceGovernance } from "./evaluate";
import { crossSourceFindingKey } from "./finding-id";
import type {
  AppAccountRow,
  CrossSourceGraph,
  DirectoryApplicationRow,
  IdentityAccountRow,
  PersonAccountLinkRow,
  SourceCapability,
} from "./types";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OKTA = "22222222-2222-4222-8222-222222222222";
const SLACK = "33333333-3333-4333-8333-333333333333";
const GOOGLE = "44444444-4444-4444-8444-444444444444";

const caps = (...xs: [string, string, SourceCapability["capability"], SourceCapability["state"]][]): SourceCapability[] =>
  xs.map(([connectionId, provider, capability, state]) => ({ connectionId, provider, capability, state }));

const ALL_AVAILABLE = caps(
  [OKTA, "okta", "identity", "available"],
  [SLACK, "slack", "app_accounts", "available"],
);

const identity = (o: Partial<IdentityAccountRow> & { id: string }): IdentityAccountRow => ({
  connectionId: OKTA, provider: "okta", syncStatus: "current", isActive: true, ...o,
});
const account = (o: Partial<AppAccountRow> & { id: string }): AppAccountRow => ({
  connectionId: SLACK, provider: "slack", syncStatus: "current",
  accountKind: "human", accountStatus: "active", isAdmin: null, ...o,
});
const link = (o: Partial<PersonAccountLinkRow> & { personId: string }): PersonAccountLinkRow => ({
  identityAccountId: null, appAccountId: null, status: "accepted", ...o,
});

const NEVER_RAN = { hasEverRun: false, status: null, lastCompletedAt: null } as const;
const COMPLETED = { hasEverRun: true, status: "completed", lastCompletedAt: "2026-01-01T00:00:00Z" } as const;

const graph = (o: Partial<CrossSourceGraph> = {}): CrossSourceGraph => ({
  tenantId: TENANT,
  capabilities: ALL_AVAILABLE,
  identityAccounts: [],
  appAccounts: [],
  personAccountLinks: [],
  directoryApplications: [],
  applicationMatches: [],
  matcherState: NEVER_RAN,
  ...o,
});

const ruleIds = (g: CrossSourceGraph) => evaluateCrossSourceGovernance(g).findings.map(f => f.rule_id);

describe("rule 1 — active SaaS account without an accepted identity", () => {
  // 1. accepted identity exists -> no orphan finding
  it("does not fire when a person has been accepted for the account", () => {
    const g = graph({
      appAccounts: [account({ id: "a1" })],
      personAccountLinks: [link({ personId: "p1", appAccountId: "a1" })],
    });
    expect(ruleIds(g)).not.toContain("active_saas_account_without_accepted_identity");
  });

  // 2. no accepted identity, identity source complete -> orphan finding
  it("fires when the account is unowned and the directory source is proven complete", () => {
    const g = graph({
      appAccounts: [account({ id: "a1" }), account({ id: "a2" })],
      personAccountLinks: [link({ personId: "p1", appAccountId: "a2" })],
    });
    const f = evaluateCrossSourceGovernance(g).findings;
    expect(f).toHaveLength(1);
    expect(f[0].rule_id).toBe("active_saas_account_without_accepted_identity");
    expect(f[0].subject_id).toBe("a1");
    expect(f[0].severity).toBe("medium");
    // The closure gate must name BOTH sides: the account's own connection and the identity source that proved absence.
    expect(f[0].evidence_connection_ids).toEqual([OKTA, SLACK].sort());
  });

  // 3. identity source incomplete -> no false finding
  it("is WITHHELD, not zero, when no directory source is complete", () => {
    const g = graph({
      capabilities: caps([OKTA, "okta", "identity", "failed"], [SLACK, "slack", "app_accounts", "available"]),
      appAccounts: [account({ id: "a1" })],
      personAccountLinks: [link({ personId: "p1", appAccountId: "zzz" })],
    });
    const r = evaluateCrossSourceGovernance(g);
    expect(r.findings).toHaveLength(0);
    expect(r.withheldRules.map(w => w.ruleId)).toContain("active_saas_account_without_accepted_identity");
    expect(r.evaluatedRules).not.toContain("active_saas_account_without_accepted_identity");
  });

  it("is withheld while person resolution has produced nothing — an empty link table is unknown, not orphaned", () => {
    const g = graph({ appAccounts: [account({ id: "a1" })], personAccountLinks: [] });
    const r = evaluateCrossSourceGovernance(g);
    expect(r.findings).toHaveLength(0);
    expect(r.withheldRules.find(w => w.ruleId === "active_saas_account_without_accepted_identity")?.reason)
      .toMatch(/person resolution/);
  });

  it("treats a PROPOSED link as awaiting review rather than as an orphan", () => {
    const g = graph({
      appAccounts: [account({ id: "a1" })],
      personAccountLinks: [link({ personId: "p1", appAccountId: "a1", status: "proposed" })],
    });
    expect(ruleIds(g)).toHaveLength(0);
  });

  // 5. stale SaaS account must not be treated as current active access
  it("ignores a stale account — the connector stopped confirming it, which is not evidence of access", () => {
    const g = graph({
      appAccounts: [account({ id: "a1", syncStatus: "stale" })],
      personAccountLinks: [link({ personId: "p1", appAccountId: "zzz" })],
    });
    expect(ruleIds(g)).toHaveLength(0);
  });

  it("ignores bots and non-active accounts", () => {
    const g = graph({
      appAccounts: [
        account({ id: "bot", accountKind: "bot" }),
        account({ id: "svc", accountKind: "service" }),
        account({ id: "gone", accountStatus: "deleted" }),
        account({ id: "off", accountStatus: "inactive" }),
      ],
      personAccountLinks: [link({ personId: "p1", appAccountId: "zzz" })],
    });
    expect(ruleIds(g)).toHaveLength(0);
  });
});

describe("rule 2 — inactive identity with an active SaaS account", () => {
  // 4. inactive identity + active linked SaaS account -> finding
  const leaver = () =>
    graph({
      identityAccounts: [identity({ id: "i1", isActive: false })],
      appAccounts: [account({ id: "a1" })],
      personAccountLinks: [
        link({ personId: "p1", identityAccountId: "i1" }),
        link({ personId: "p1", appAccountId: "a1" }),
      ],
    });

  it("fires and names both sides", () => {
    const f = evaluateCrossSourceGovernance(leaver()).findings.filter(
      x => x.rule_id === "inactive_identity_with_active_saas_account",
    );
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].subject_id).toBe("p1");
    expect(f[0].evidence.supportingIds).toEqual(["i1", "a1"]);
    expect(f[0].source_providers).toEqual(["okta", "slack"]);
    expect(f[0].evidence_connection_ids).toEqual([OKTA, SLACK].sort());
  });

  it("does NOT fire when the provider never said whether the identity is active", () => {
    const g = leaver();
    const withUnknown = { ...g, identityAccounts: [identity({ id: "i1", isActive: null })] };
    expect(ruleIds(withUnknown)).not.toContain("inactive_identity_with_active_saas_account");
  });

  it("does not fire on a PROPOSED link — an undecided judgement is not a fact about a person", () => {
    const g = graph({
      identityAccounts: [identity({ id: "i1", isActive: false })],
      appAccounts: [account({ id: "a1" })],
      personAccountLinks: [
        link({ personId: "p1", identityAccountId: "i1", status: "proposed" }),
        link({ personId: "p1", appAccountId: "a1", status: "proposed" }),
      ],
    });
    expect(ruleIds(g)).not.toContain("inactive_identity_with_active_saas_account");
  });

  it("is withheld when the SaaS side cannot be proven current", () => {
    const g = { ...leaver(), capabilities: caps([OKTA, "okta", "identity", "available"]) };
    const r = evaluateCrossSourceGovernance(g);
    expect(r.withheldRules.map(w => w.ruleId)).toContain("inactive_identity_with_active_saas_account");
    expect(r.findings).toHaveLength(0);
  });
});

describe("rule 3 — privileged account without an accepted identity", () => {
  // 6. privileged SaaS account without identity -> finding only when privilege is actually reported
  it("fires at HIGH severity when the provider reported admin", () => {
    const g = graph({
      appAccounts: [account({ id: "a1", isAdmin: true })],
      personAccountLinks: [link({ personId: "p1", appAccountId: "zzz" })],
    });
    const f = evaluateCrossSourceGovernance(g).findings;
    expect(f).toHaveLength(1);
    expect(f[0].rule_id).toBe("privileged_saas_account_without_accepted_identity");
    expect(f[0].severity).toBe("high");
  });

  it("does not infer privilege the provider never reported", () => {
    const g = graph({
      appAccounts: [account({ id: "a1", isAdmin: null })],
      personAccountLinks: [link({ personId: "p1", appAccountId: "zzz" })],
    });
    expect(ruleIds(g)).toEqual(["active_saas_account_without_accepted_identity"]);
  });

  it("reports one account exactly once — rule 1 yields to rule 3 for admins", () => {
    const g = graph({
      appAccounts: [account({ id: "a1", isAdmin: true })],
      personAccountLinks: [link({ personId: "p1", appAccountId: "zzz" })],
    });
    const subjects = evaluateCrossSourceGovernance(g).findings.map(f => f.subject_id);
    expect(subjects).toEqual(["a1"]);
  });
});

describe("rule 4 — duplicate active accounts for one person", () => {
  // 7. duplicate provider accounts, deterministic, no accidental duplicate ids
  it("fires for two active accounts in ONE connection", () => {
    const g = graph({
      appAccounts: [account({ id: "a1" }), account({ id: "a2" })],
      personAccountLinks: [
        link({ personId: "p1", appAccountId: "a1" }),
        link({ personId: "p1", appAccountId: "a2" }),
      ],
    });
    const f = evaluateCrossSourceGovernance(g).findings.filter(
      x => x.rule_id === "duplicate_active_accounts_for_one_person",
    );
    expect(f).toHaveLength(1);
    expect(f[0].evidence.supportingIds).toEqual(["a1", "a2"]);
    expect(f[0].evidence_connection_ids).toEqual([SLACK]);
  });

  it("does NOT fire for one account each in two different connections — that is normal", () => {
    const g = graph({
      capabilities: [
        ...ALL_AVAILABLE,
        { connectionId: GOOGLE, provider: "google", capability: "app_accounts", state: "available" },
      ],
      appAccounts: [account({ id: "a1" }), account({ id: "a2", connectionId: GOOGLE, provider: "google" })],
      personAccountLinks: [
        link({ personId: "p1", appAccountId: "a1" }),
        link({ personId: "p1", appAccountId: "a2" }),
      ],
    });
    expect(ruleIds(g)).not.toContain("duplicate_active_accounts_for_one_person");
  });

  it("gives each connection's duplicate set its own distinct finding key", () => {
    const g = graph({
      capabilities: [
        ...ALL_AVAILABLE,
        { connectionId: GOOGLE, provider: "google", capability: "app_accounts", state: "available" },
      ],
      appAccounts: [
        account({ id: "a1" }), account({ id: "a2" }),
        account({ id: "b1", connectionId: GOOGLE, provider: "google" }),
        account({ id: "b2", connectionId: GOOGLE, provider: "google" }),
      ],
      personAccountLinks: ["a1", "a2", "b1", "b2"].map(id => link({ personId: "p1", appAccountId: id })),
    });
    const keys = evaluateCrossSourceGovernance(g)
      .findings.filter(x => x.rule_id === "duplicate_active_accounts_for_one_person")
      .map(f => f.finding_key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("rule 5 — application unmanaged by the IdP", () => {
  const apps: DirectoryApplicationRow[] = [
    { id: "app1", connectionId: OKTA, provider: "okta", syncStatus: "current" },
  ];
  const appCaps = caps([OKTA, "okta", "directory_applications", "available"]);

  const reasonFor = (g: CrossSourceGraph) =>
    evaluateCrossSourceGovernance(g).withheldRules.find(w => w.ruleId === "discovered_application_unmanaged_by_idp")
      ?.reason;

  it("stays SILENT while the matcher has never run — absence is unknown, not unmanaged", () => {
    const g = graph({ capabilities: appCaps, directoryApplications: apps, matcherState: NEVER_RAN });
    expect(evaluateCrossSourceGovernance(g).findings).toHaveLength(0);
    expect(reasonFor(g)).toMatch(/never run/);
  });

  it("stays silent while a run is still in flight", () => {
    const g = graph({
      capabilities: appCaps, directoryApplications: apps,
      matcherState: { hasEverRun: true, status: "running", lastCompletedAt: null },
    });
    expect(evaluateCrossSourceGovernance(g).findings).toHaveLength(0);
    expect(reasonFor(g)).toMatch(/still in flight/);
  });

  // The one the row count could never express: a run that FAILED today must not present an older completion as
  // current, so `lastCompletedAt` being set is deliberately not enough.
  it("stays silent when the latest run failed, even though an earlier run completed", () => {
    const g = graph({
      capabilities: appCaps, directoryApplications: apps,
      matcherState: { hasEverRun: true, status: "failed", lastCompletedAt: "2026-01-01T00:00:00Z" },
    });
    expect(evaluateCrossSourceGovernance(g).findings).toHaveLength(0);
    expect(reasonFor(g)).toMatch(/did not complete/);
  });

  it("evaluates once a run COMPLETED, even though it produced zero matches", () => {
    const g = graph({
      capabilities: appCaps, directoryApplications: apps, applicationMatches: [], matcherState: COMPLETED,
    });
    const f = evaluateCrossSourceGovernance(g).findings;
    expect(f.map(x => x.subject_id)).toEqual(["app1"]);
    expect(evaluateCrossSourceGovernance(g).evaluatedRules).toContain("discovered_application_unmanaged_by_idp");
  });

  it("recognises a managed application once a completed run produced an accepted match", () => {
    const g = graph({
      capabilities: appCaps,
      directoryApplications: [...apps, { id: "app2", connectionId: OKTA, provider: "okta", syncStatus: "current" }],
      applicationMatches: [{ directoryApplicationId: "app2", status: "accepted" }],
      matcherState: COMPLETED,
    });
    const f = evaluateCrossSourceGovernance(g).findings;
    expect(f.map(x => x.subject_id)).toEqual(["app1"]);
    expect(f[0].confidence).toBe("medium");
  });

  it("treats a proposed match as not yet accepted", () => {
    const g = graph({
      capabilities: appCaps, directoryApplications: apps, matcherState: COMPLETED,
      applicationMatches: [{ directoryApplicationId: "app1", status: "proposed" }],
    });
    expect(evaluateCrossSourceGovernance(g).findings.map(x => x.subject_id)).toEqual(["app1"]);
  });
});

describe("tenant scope, determinism and empty estates", () => {
  // 8. cross-tenant rows are structurally out of reach: the engine is handed ONE tenant's rows and folds that tenant
  // into every key, so a foreign row cannot enter and a foreign key cannot collide.
  it("folds the tenant into the finding key, so two tenants never share one", () => {
    const rows = {
      appAccounts: [account({ id: "a1" })],
      personAccountLinks: [link({ personId: "p1", appAccountId: "zzz" })],
    };
    const a = evaluateCrossSourceGovernance(graph(rows)).findings[0].finding_key;
    const b = evaluateCrossSourceGovernance(graph({ ...rows, tenantId: "99999999-9999-4999-8999-999999999999" }))
      .findings[0].finding_key;
    expect(a).not.toBe(b);
  });

  // 14. deterministic rerun -> same finding keys
  it("is byte-identical across repeated evaluation, and independent of input order", () => {
    const rows = {
      identityAccounts: [identity({ id: "i1", isActive: false })],
      appAccounts: [account({ id: "a1" }), account({ id: "a2" }), account({ id: "a3" })],
      personAccountLinks: [
        link({ personId: "p1", identityAccountId: "i1" }),
        link({ personId: "p1", appAccountId: "a1" }),
        link({ personId: "p1", appAccountId: "a2" }),
      ],
    };
    const first = evaluateCrossSourceGovernance(graph(rows));
    const second = evaluateCrossSourceGovernance(graph(rows));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const reversed = evaluateCrossSourceGovernance(
      graph({
        ...rows,
        appAccounts: [...rows.appAccounts].reverse(),
        personAccountLinks: [...rows.personAccountLinks].reverse(),
      }),
    );
    expect(reversed.findings.map(f => f.finding_key)).toEqual(first.findings.map(f => f.finding_key));
  });

  it("keeps a finding's identity when a mutable attribute changes", () => {
    const base = { appAccounts: [account({ id: "a1" })], personAccountLinks: [link({ personId: "p1", appAccountId: "z" })] };
    const before = evaluateCrossSourceGovernance(graph(base)).findings[0].finding_key;
    const after = evaluateCrossSourceGovernance(
      graph({ ...base, appAccounts: [account({ id: "a1", provider: "slack-renamed" })] }),
    ).findings[0].finding_key;
    expect(after).toBe(before);
  });

  it("builds keys in the domain migration 0083 requires", () => {
    const k = crossSourceFindingKey({
      ruleId: "active_saas_account_without_accepted_identity",
      tenantId: TENANT, subjectType: "app_account", subjectId: "a1",
    });
    expect(k.startsWith("cross-source:")).toBe(true);
  });

  // 15. zero-data but COMPLETE tenant -> empty result, nothing invented
  it("invents nothing for a complete tenant that simply has no rows", () => {
    const r = evaluateCrossSourceGovernance(graph({ personAccountLinks: [link({ personId: "p", appAccountId: "x" })] }));
    expect(r.findings).toHaveLength(0);
    expect(r.evaluatedRules).toContain("active_saas_account_without_accepted_identity");
  });

  it("withholds every gated rule for a tenant with no proven sources at all", () => {
    const r = evaluateCrossSourceGovernance(graph({ capabilities: [] }));
    expect(r.findings).toHaveLength(0);
    expect(r.evaluatedRules).toHaveLength(0);
    expect(r.withheldRules).toHaveLength(5);
    expect(r.completeConnectionIds).toEqual([]);
  });

  it("hands 0083 exactly the connections it proved complete", () => {
    const r = evaluateCrossSourceGovernance(graph({}));
    expect(r.completeConnectionIds).toEqual([OKTA, SLACK].sort());
  });

  it("every emitted finding declares at least one evidence connection (0083 refuses otherwise)", () => {
    const g = graph({
      identityAccounts: [identity({ id: "i1", isActive: false })],
      appAccounts: [account({ id: "a1" }), account({ id: "a2", isAdmin: true }), account({ id: "a3" })],
      personAccountLinks: [
        link({ personId: "p1", identityAccountId: "i1" }),
        link({ personId: "p1", appAccountId: "a1" }),
      ],
    });
    const f = evaluateCrossSourceGovernance(g).findings;
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) expect(x.evidence_connection_ids.length).toBeGreaterThan(0);
  });

  it("orders findings by severity so the worst is first", () => {
    const g = graph({
      identityAccounts: [identity({ id: "i1", isActive: false })],
      appAccounts: [account({ id: "a1" }), account({ id: "a2" })],
      personAccountLinks: [
        link({ personId: "p1", identityAccountId: "i1" }),
        link({ personId: "p1", appAccountId: "a1" }),
      ],
    });
    const f = evaluateCrossSourceGovernance(g).findings;
    expect(f[0].severity).toBe("high");
  });
});

describe("provider neutrality", () => {
  // A provider the engine has never heard of must behave exactly like one it has.
  it("evaluates an unknown provider identically to a known one", () => {
    const g = graph({
      capabilities: caps(
        [OKTA, "okta", "identity", "available"],
        [GOOGLE, "google", "app_accounts", "available"],
      ),
      appAccounts: [account({ id: "a1", connectionId: GOOGLE, provider: "google" })],
      personAccountLinks: [link({ personId: "p1", appAccountId: "zzz" })],
    });
    const f = evaluateCrossSourceGovernance(g).findings;
    expect(f).toHaveLength(1);
    expect(f[0].rule_id).toBe("active_saas_account_without_accepted_identity");
    expect(f[0].source_providers).toEqual(["google"]);
  });
});

// ── Independent review of #410 ────────────────────────────────────────────────────────────────────────────────────
describe("review: does a pending proposal shield a PRIVILEGED orphan?", () => {
  const privileged = (status: PersonAccountLinkRow["status"] | "none") =>
    graph({
      appAccounts: [account({ id: "a1", isAdmin: true })],
      personAccountLinks:
        status === "none"
          ? [link({ personId: "p0", appAccountId: "other" })]
          : [link({ personId: "p1", appAccountId: "a1", status })],
    });
  const ordinary = (status: PersonAccountLinkRow["status"] | "none") =>
    graph({
      appAccounts: [account({ id: "a1" })],
      personAccountLinks:
        status === "none"
          ? [link({ personId: "p0", appAccountId: "other" })]
          : [link({ personId: "p1", appAccountId: "a1", status })],
    });

  it("ordinary account: accepted and proposed are silent; rejected and none fire", () => {
    expect(ruleIds(ordinary("accepted"))).toHaveLength(0);
    expect(ruleIds(ordinary("proposed"))).toHaveLength(0);
    expect(ruleIds(ordinary("rejected"))).toEqual(["active_saas_account_without_accepted_identity"]);
    expect(ruleIds(ordinary("none"))).toEqual(["active_saas_account_without_accepted_identity"]);
  });

  // An undecided proposal is a queue entry, not an owner. For an ADMIN account, letting one suppress the finding means
  // a proposer bug — or simply nobody reviewing — hides an unowned privileged account for as long as the queue is
  // ignored. Only an ACCEPTED owner should silence this one.
  it("privileged account: ONLY an accepted owner is silent", () => {
    expect(ruleIds(privileged("accepted"))).toHaveLength(0);
    expect(ruleIds(privileged("proposed"))).toEqual(["privileged_saas_account_without_accepted_identity"]);
    expect(ruleIds(privileged("rejected"))).toEqual(["privileged_saas_account_without_accepted_identity"]);
    expect(ruleIds(privileged("none"))).toEqual(["privileged_saas_account_without_accepted_identity"]);
  });
});

describe("review: rule 4 must not call a service account a duplicate person account", () => {
  // 0082's proposer only ever links `human` accounts, but a MANUAL link can attach anything, and the engine must not
  // depend on another component's filter. A person who owns their login plus a service account has ONE account, not two.
  it("counts only human accounts", () => {
    const g = graph({
      appAccounts: [account({ id: "a1" }), account({ id: "svc", accountKind: "service" })],
      personAccountLinks: [
        link({ personId: "p1", appAccountId: "a1" }),
        link({ personId: "p1", appAccountId: "svc" }),
      ],
    });
    expect(ruleIds(g)).not.toContain("duplicate_active_accounts_for_one_person");
  });

  it("still fires for two genuine human accounts", () => {
    const g = graph({
      appAccounts: [account({ id: "a1" }), account({ id: "a2" })],
      personAccountLinks: [
        link({ personId: "p1", appAccountId: "a1" }),
        link({ personId: "p1", appAccountId: "a2" }),
      ],
    });
    expect(ruleIds(g)).toContain("duplicate_active_accounts_for_one_person");
  });
});

describe("review: resolutionHasRun — cases A-E", () => {
  const acct = { appAccounts: [account({ id: "a1" })] };

  // A. resolution never ran
  it("A: no links at all -> orphan rules WITHHELD", () => {
    const r = evaluateCrossSourceGovernance(graph({ ...acct, personAccountLinks: [] }));
    expect(r.withheldRules.map(w => w.ruleId)).toContain("active_saas_account_without_accepted_identity");
  });

  // B/C. A run that produced nothing is INDISTINGUISHABLE from a run that never happened. 0082 proposes a link for
  // every current human account carrying a normalized_email, so an account that would be an orphan candidate cannot
  // come back link-less from a real run unless it has NO address — in which case nothing could ever resolve it.
  it("B/C: an account with no address is the only orphan candidate a real run leaves link-less", () => {
    const r = evaluateCrossSourceGovernance(
      graph({
        appAccounts: [account({ id: "withAddress" }), account({ id: "noAddress" })],
        personAccountLinks: [link({ personId: "p1", appAccountId: "withAddress", status: "proposed" })],
      }),
    );
    // The run is proven to have happened by the link it produced, so the address-less account is correctly an orphan.
    expect(r.findings.map(f => f.subject_id)).toEqual(["noAddress"]);
  });

  // D. only rejected links -> resolution demonstrably ran
  it("D: rejected links prove the run happened, and a rejected candidate is genuinely unowned", () => {
    const r = evaluateCrossSourceGovernance(
      graph({ ...acct, personAccountLinks: [link({ personId: "p1", appAccountId: "a1", status: "rejected" })] }),
    );
    expect(r.evaluatedRules).toContain("active_saas_account_without_accepted_identity");
    expect(r.findings.map(f => f.subject_id)).toEqual(["a1"]);
  });

  // E. only proposed links -> run happened; the proposed account is awaiting review, not orphaned
  it("E: proposed links prove the run happened", () => {
    const r = evaluateCrossSourceGovernance(
      graph({ ...acct, personAccountLinks: [link({ personId: "p1", appAccountId: "a1", status: "proposed" })] }),
    );
    expect(r.evaluatedRules).toContain("active_saas_account_without_accepted_identity");
    expect(r.findings).toHaveLength(0);
  });
});

describe("review: unknown is never zero", () => {
  it.each(["plan_dependent", "permission_dependent", "unavailable", "incomplete", "failed"] as const)(
    "withholds when the identity capability is %s rather than available",
    state => {
      const r = evaluateCrossSourceGovernance(
        graph({
          capabilities: caps([OKTA, "okta", "identity", state], [SLACK, "slack", "app_accounts", "available"]),
          appAccounts: [account({ id: "a1" })],
          personAccountLinks: [link({ personId: "p1", appAccountId: "zzz" })],
        }),
      );
      expect(r.findings).toHaveLength(0);
      expect(r.withheldRules.map(w => w.ruleId)).toContain("active_saas_account_without_accepted_identity");
    },
  );

  it.each(["stale", "disconnected", "review_required"] as const)(
    "never treats a %s account as live access",
    syncStatus => {
      const g = graph({
        appAccounts: [account({ id: "a1", syncStatus })],
        personAccountLinks: [link({ personId: "p1", appAccountId: "zzz" })],
      });
      expect(ruleIds(g)).toHaveLength(0);
    },
  );

  it("never treats a non-current inactive identity as proof of a leaver", () => {
    const g = graph({
      identityAccounts: [identity({ id: "i1", isActive: false, syncStatus: "disconnected" })],
      appAccounts: [account({ id: "a1" })],
      personAccountLinks: [
        link({ personId: "p1", identityAccountId: "i1" }),
        link({ personId: "p1", appAccountId: "a1" }),
      ],
    });
    expect(ruleIds(g)).not.toContain("inactive_identity_with_active_saas_account");
  });

  it("ignores rows from a connection whose capability was never declared at all", () => {
    const g = graph({
      capabilities: caps([OKTA, "okta", "identity", "available"]),
      appAccounts: [account({ id: "a1", connectionId: GOOGLE, provider: "google" })],
      personAccountLinks: [link({ personId: "p1", appAccountId: "zzz" })],
    });
    const r = evaluateCrossSourceGovernance(g);
    expect(r.findings).toHaveLength(0);
    expect(r.completeConnectionIds).toEqual([OKTA]);
  });
});

describe("review: finding identity", () => {
  const base = {
    ruleId: "active_saas_account_without_accepted_identity" as const,
    tenantId: TENANT,
    subjectType: "app_account" as const,
    subjectId: "a1",
  };

  it("folds the tenant, the rule and the subject, and nothing else", () => {
    const k = crossSourceFindingKey(base);
    expect(k).not.toBe(crossSourceFindingKey({ ...base, tenantId: "00000000-0000-4000-8000-000000000000" }));
    expect(k).not.toBe(crossSourceFindingKey({ ...base, subjectId: "a2" }));
    expect(k).not.toBe(
      crossSourceFindingKey({ ...base, ruleId: "privileged_saas_account_without_accepted_identity" }),
    );
  });

  it("is order-independent in relatedIds but sensitive to the set", () => {
    const a = crossSourceFindingKey({ ...base, relatedIds: ["x", "y", "z"] });
    expect(crossSourceFindingKey({ ...base, relatedIds: ["z", "x", "y"] })).toBe(a);
    expect(crossSourceFindingKey({ ...base, relatedIds: ["x", "y"] })).not.toBe(a);
  });

  it("cannot be forged by a value containing the delimiter", () => {
    expect(crossSourceFindingKey({ ...base, subjectId: "a", relatedIds: ["1:b"] })).not.toBe(
      crossSourceFindingKey({ ...base, subjectId: "a 1:b", relatedIds: [] }),
    );
  });

  it("is stable across repeated construction (no clock, no randomness)", () => {
    expect(crossSourceFindingKey(base)).toBe(crossSourceFindingKey(base));
  });
});
