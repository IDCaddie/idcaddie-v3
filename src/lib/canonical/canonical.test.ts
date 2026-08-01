import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CAPABILITIES, canShowValue, ownerOf, resolveAll, resolveCapability, supportFor, type ConnectorFacts,
} from "./capabilities";
import { METRICS, REFRESH_PATHS, metric } from "./lineage";

// Phase 7B — the canonical layer.
//
// One idea underpins every test here: a number is a claim, and a claim requires a source. Where there is no source, the product
// must say so in words. "0 active users" and "requires a Slack connector" are different statements and only one is true.

const conn = (o: Partial<ConnectorFacts> = {}): ConnectorFacts => ({
  id: "c1", provider: "okta", active: true, lifecycle: "discovered", healthState: "healthy",
  lastDiscoveryAt: "2026-07-31T00:00:00Z", hasCurrentData: true, hasStaleData: false, ...o,
});

// ── unsupported is never zero ────────────────────────────────────────────────────────────────────────────────────────────────
describe("an unsupported capability is a STATE, never a value", () => {
  it("refuses to show a value for anything ID Caddie has not built", () => {
    const s = resolveCapability("usage", [conn()]);
    expect(s.state).toBe("unavailable");
    expect(canShowValue(s), "no number may be rendered").toBe(false);
    expect(s.explanation).toMatch(/not available for/i);
    expect(s.explanation).not.toMatch(/\b0\b/);
  });

  it("distinguishes NOT BUILT from NOT CONNECTED — they need different actions", () => {
    // A workspace with a healthy Slack connector still cannot have Usage: it is not built. Telling them to connect something
    // they already have would be the wrong instruction.
    const withSlack = resolveCapability("usage", [conn({ provider: "slack" })]);
    expect(withSlack.state).toBe("unavailable");

    // Groups IS built, for Okta. With no connector at all the answer is "connect one".
    const nothing = resolveCapability("groups", []);
    expect(nothing.state).toBe("not_connected");
    expect(nothing.explanation).toMatch(/requires a connected okta connector/i);
  });

  it("says SOURCE REQUIRED when the workspace has connectors but not the right one", () => {
    const s = resolveCapability("groups", [conn({ provider: "slack" })]);
    expect(s.state).toBe("source_required");
    expect(canShowValue(s)).toBe(false);
  });

  it("treats a READ FAILURE as unknown, never as absence", () => {
    // Deciding "not connected" from a failed read is a claim about an estate we could not see.
    const s = resolveCapability("groups", [], true);
    expect(s.state).toBe("unknown");
    expect(s.explanation).toMatch(/not a statement that there is none/i);
    expect(canShowValue(s)).toBe(false);
  });

  it("every state carries a customer sentence, and none of them is a number", () => {
    for (const c of CAPABILITIES) {
      for (const facts of [[], [conn()], [conn({ provider: "slack" })], [conn({ healthState: "failed", hasCurrentData: false })]]) {
        const s = resolveCapability(c, facts);
        expect(s.explanation.length, `${c}`).toBeGreaterThan(15);
        expect(s.explanation, `${c} must not state a count`).not.toMatch(/^\d/);
      }
    }
  });
});

// ── current vs stale ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("current and stale are distinct capability states", () => {
  it("reports available only when there is CURRENT data", () => {
    expect(resolveCapability("groups", [conn({ hasCurrentData: true })]).state).toBe("available");
    expect(resolveCapability("groups", [conn({ hasCurrentData: false, hasStaleData: true })]).state).toBe("stale");
    expect(resolveCapability("groups", [conn({ hasCurrentData: false, hasStaleData: false })]).state).toBe("incomplete");
  });

  it("downgrades confidence for stale, and gives none to anything unavailable", () => {
    expect(resolveCapability("groups", [conn()]).confidence).toBe("high");
    expect(resolveCapability("groups", [conn({ hasCurrentData: false, hasStaleData: true })]).confidence).toBe("medium");
    expect(resolveCapability("usage", [conn()]).confidence).toBe("none");
  });

  it("a failure outranks a healthy-looking lifecycle", () => {
    const s = resolveCapability("groups", [conn({ healthState: "failed", hasCurrentData: false })]);
    expect(s.state).toBe("failed");
    expect(canShowValue(s)).toBe(false);
  });
});

// ── ownership and scope ──────────────────────────────────────────────────────────────────────────────────────────────────────
describe("one source owns each capability", () => {
  it("names an owner for every implemented capability, and none for the rest", () => {
    for (const c of CAPABILITIES) {
      const owner = ownerOf(c);
      if (owner) expect(supportFor(owner, c), `${c} owner must implement it`).toBe("implemented");
    }
  });

  it("makes no claim about a provider it has not modelled", () => {
    for (const c of CAPABILITIES) expect(supportFor("some_new_provider", c), c).toBe("not_applicable");
  });

  it("resolves every capability, so no surface can ask about one that is missing", () => {
    const all = resolveAll([conn()]);
    expect(Object.keys(all).sort()).toEqual([...CAPABILITIES].sort());
  });

  it("only considers ACTIVE connectors", () => {
    // Disconnected and superseded connectors are excluded everywhere else; a capability must not light up from one.
    expect(resolveCapability("groups", [conn({ active: false })]).state).toBe("not_connected");
  });
});

// ── lineage ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("every product metric has exactly one documented owner", () => {
  it("has no duplicate metric ids", () => {
    const ids = METRICS.map((m) => m.id);
    expect(new Set(ids).size, "two entries claiming one metric is how two surfaces disagree").toBe(ids.length);
  });

  it("gives every metric a capability, a formula, an unavailable state and a security boundary", () => {
    for (const m of METRICS) {
      expect(CAPABILITIES, `${m.id} capability`).toContain(m.capability);
      expect(m.formula.length, `${m.id} formula`).toBeGreaterThan(20);
      expect(m.security.length, `${m.id} security`).toBeGreaterThan(10);
      // The whole point: an unavailable metric renders a sentence, so the sentence must exist and must not be a number.
      expect(m.unavailableState.length, `${m.id} unavailable state`).toBeGreaterThan(10);
      expect(m.unavailableState, `${m.id} must not offer 0 as its unavailable state`).not.toMatch(/^0\b/);
      expect(m.staleBehaviour.length, `${m.id} stale behaviour`).toBeGreaterThan(2);
    }
  });

  it("never lets a directory metric claim it is unscoped", () => {
    for (const id of ["people", "groups", "directory_applications", "effective_access", "high_findings"]) {
      expect(metric(id)!.connectorScoped, `${id} must follow the connector scope`).toBe(true);
    }
    // And the SaaS spoke is genuinely not connector-scoped — it has no connector.
    expect(metric("saas_inventory")!.connectorScoped).toBe(false);
  });

  it("keeps the directory and SaaS spokes on separate tables", () => {
    const dir = METRICS.filter((m) => m.connectorScoped).flatMap((m) => m.tables);
    const saas = METRICS.filter((m) => !m.connectorScoped && m.id !== "connector_health").flatMap((m) => m.tables);
    expect(dir).not.toContain("apps");
    expect(saas).not.toContain("directory_applications");
  });

  it("routes every refresh trigger at real routes", () => {
    const routes = new Set(readdirSync(join(process.cwd(), "src/app/(authenticated)"), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => `/${e.name}`));
    for (const [trigger, paths] of Object.entries(REFRESH_PATHS)) {
      for (const p of paths) {
        expect(routes.has(`/${p.split("/")[1]}`), `${trigger} -> ${p} must be a real route`).toBe(true);
      }
    }
  });

  it("invalidates the identity surfaces on directory discovery", () => {
    // If discovery does not invalidate a surface it feeds, that surface shows yesterday's directory forever.
    for (const p of ["/dashboards", "/directory/people", "/directory/groups", "/directory/applications", "/access", "/access/findings"]) {
      expect(REFRESH_PATHS.directory_discovery).toContain(p);
    }
  });
});

// ── the application match model ──────────────────────────────────────────────────────────────────────────────────────────────
describe("the directory/SaaS match model never merges by name", () => {
  const SQL = readFileSync(join(process.cwd(), "supabase/migrations/0075_application_match_model.sql"), "utf8");

  it("requires a bounded confidence and a review status on every match", () => {
    expect(SQL).toMatch(/confidence text not null/);
    expect(SQL).toMatch(/check \(confidence in \('high', 'medium', 'low'\)\)/);
    expect(SQL).toMatch(/check \(status in \('proposed', 'accepted', 'rejected'\)\)/);
  });

  it("joins on canonical ids only — never a name, label or domain string", () => {
    const body = SQL.slice(SQL.indexOf("create table"), SQL.indexOf("comment on table"));
    for (const forbidden of ["normalized_name", "lower(name)", "on a.name", "= b.name", "ilike"]) {
      expect(body, `matching must not use ${forbidden}`).not.toContain(forbidden);
    }
    expect(body).toContain("directory_application_id uuid not null references public.directory_applications");
    expect(body).toContain("app_id uuid not null references public.apps");
  });

  it("allows two directory applications to share one SaaS record", () => {
    // Two Okta organizations both exposing Salesforce legitimately map to one contract. Constraining that would force an
    // operator to choose which organization "owns" a contract covering both.
    expect(SQL).toMatch(/create unique index[\s\S]*?one_accepted_dir_idx/);
    expect(SQL).not.toMatch(/create unique index[\s\S]*?one_accepted_app_idx/);
  });

  it("keeps the table unreadable from a browser until a consumer exists", () => {
    expect(SQL).toContain("enable row level security");
    expect(SQL).toMatch(/revoke all on public\.application_matches from public, anon, authenticated/);
  });
});
