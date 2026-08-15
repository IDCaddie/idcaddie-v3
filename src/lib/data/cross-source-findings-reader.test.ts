// Phase 18F Lane A — the read boundary between persisted findings and the customer.
//
// The property this suite protects: the customer sees what the ENGINE concluded, in reviewed copy, and never an
// internal enum, a raw key, a raw id, or an empty card standing in for a dropped row.

import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const gate = vi.hoisted(() => ({ value: { ok: true, tenantId: "t-a" } as { ok: boolean; tenantId?: string } }));
vi.mock("./access-repository", () => ({ accessGate: async () => gate.value }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => { throw new Error("must not build a real client"); } }));

import {
  loadCrossSourceFindings, toView, firstSeenLabel, lifecycleLabel, actionFor, KNOWN_ROUTES, DISPLAY_CAP,
  type FindingsIo,
} from "./cross-source-findings-reader";

const NOW = new Date("2026-08-15T12:00:00Z");
const STEM = "crossSource.discovered_application_unmanaged_by_idp";

const row = (o: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  rule_id: "discovered_application_unmanaged_by_idp",
  subject_type: "directory_application",
  severity: "low", confidence: "medium",
  title_key: `${STEM}.product_unresolved.title`,
  status: "open",
  first_seen_at: "2026-08-10T12:00:00Z",
  reopen_count: 0,
  evidence_json: { counts: { applications: 1 }, reason: "product_unresolved" },
  ...o,
});
const io = (data: unknown, error: unknown = null): FindingsIo => ({ rpc: async () => ({ data, error }) });

beforeEach(() => { gate.value = { ok: true, tenantId: "t-a" }; });

describe("A2/A3/A4/A5 — result states", () => {
  it("A4 one finding renders reviewed copy, not keys", async () => {
    const r = await loadCrossSourceFindings(io([row()]), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = r.data.findings[0];
    expect(f.title).toBe("Application needs identification");
    expect(f.summary).toContain("has not been matched to a recognized software product");
    expect(f.title).not.toContain("crossSource.");
    expect(f.severityLabel).toBe("Low");
    expect(f.subjectKind).toBe("Application");
  });

  it("A5 multiple findings all render", async () => {
    const r = await loadCrossSourceFindings(io([row(), row({ id: "22222222-2222-4222-8222-222222222222" })]), NOW);
    expect(r.ok && r.data.shown).toBe(2);
  });

  it("A2 an empty estate is an empty list, not an error", async () => {
    const r = await loadCrossSourceFindings(io([]), NOW);
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.shown).toBe(0);
    expect(r.ok && r.data.unreadable).toBe(0);
    expect(r.ok && r.data.truncated).toBe(false);
  });

  it("A3 a backend error is query_failed, never an empty list", async () => {
    const r = await loadCrossSourceFindings(io(null, { message: "relation does not exist at 1:2" }), NOW);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("query_failed");
  });

  it("A3 a thrown transport error does not escape as a stack", async () => {
    const thrower: FindingsIo = { rpc: async () => { throw new Error("ECONNREFUSED db.internal:5432"); } };
    const r = await loadCrossSourceFindings(thrower, NOW);
    expect(r.ok === false && r.error).toBe("query_failed");
  });

  // The one failure this module must never produce: contract drift reported as a clean estate.
  it("A3 a non-array response FAILS rather than rendering as 'no findings'", async () => {
    const r = await loadCrossSourceFindings(io({ unexpected: "shape" }), NOW);
    expect(r.ok === false && r.error).toBe("query_failed");
  });

  it("a row that fails its contract is COUNTED, not silently dropped", async () => {
    const r = await loadCrossSourceFindings(io([row(), { id: "x" }]), NOW);
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.shown).toBe(1);
    expect(r.ok && r.data.unreadable).toBe(1);
  });

  // The half the original suite missed: when EVERY row is dropped the result still carries the drop count, so the
  // page has something to distinguish "we read nothing" from "there is nothing". Pinned here AND at the render layer.
  it("ALL rows unreadable still reports the drops — never a silent empty estate", async () => {
    const r = await loadCrossSourceFindings(io([{ id: "x" }, { id: "y" }, { bad: true }]), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.shown).toBe(0);
    expect(r.data.unreadable, "an empty list with dropped rows must not claim zero drops").toBe(3);
    expect(r.data.truncated).toBe(false);
  });

  it("A12 a non-owner/admin is refused before any read", async () => {
    gate.value = { ok: false };
    let called = false;
    const spy: FindingsIo = { rpc: async () => { called = true; return { data: [], error: null }; } };
    const r = await loadCrossSourceFindings(spy, NOW);
    expect(r.ok === false && r.error).toBe("forbidden");
    expect(called, "must not query on behalf of an unauthorized caller").toBe(false);
  });

  it("asks only for OPEN cross_source findings, scoped to the gated tenant, with the +1 sentinel", async () => {
    let args: Record<string, unknown> | null = null;
    const spy: FindingsIo = { rpc: async (_n, a) => { args = a; return { data: [], error: null }; } };
    await loadCrossSourceFindings(spy, NOW);
    expect(args).toEqual({ p_tenant_id: "t-a", p_engine: "cross_source", p_status: "open", p_limit: DISPLAY_CAP + 1 });
  });
});

// ══ THE BOUNDED COUNT ═════════════════════════════════════════════════════════════════════════════════════════════
// The read has no count query, so the only honest claims are "exactly N" (fewer rows came back than we asked for) and
// "more than the cap" (the sentinel row came back). Asking for the cap and reporting the row count — the original
// shape — makes the two indistinguishable and states a page size as the tenant's total.
describe("bounded result count — exact below the cap, explicitly truncated above it", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => row({ id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111` }));

  it.each([0, 1, 99, DISPLAY_CAP])("%i rows is an EXACT count, never truncated", async n => {
    const r = await loadCrossSourceFindings(io(rows(n)), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.shown).toBe(n);
    expect(r.data.truncated, `${n} rows is the whole estate`).toBe(false);
  });

  it("the sentinel row marks the page truncated and is NOT rendered", async () => {
    const r = await loadCrossSourceFindings(io(rows(DISPLAY_CAP + 1)), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.shown, "the sentinel is never shown to a customer").toBe(DISPLAY_CAP);
    expect(r.data.findings).toHaveLength(DISPLAY_CAP);
    expect(r.data.truncated).toBe(true);
  });

  // The sentinel answers "is there more", nothing else. A malformed sentinel must not be counted as a dropped row on
  // the page the customer is actually looking at.
  it("a malformed SENTINEL row does not pollute the visible page's drop count", async () => {
    const r = await loadCrossSourceFindings(io([...rows(DISPLAY_CAP), { garbage: true }]), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.shown).toBe(DISPLAY_CAP);
    expect(r.data.unreadable).toBe(0);
    expect(r.data.truncated).toBe(true);
  });
});

// ══ THE STATUS CONTRACT ═══════════════════════════════════════════════════════════════════════════════════════════
// `status` is requested as 'open' and never rendered, so it is easy to read the field in `rowSchema` as dead weight
// and delete it. It is the defence that survives the RPC's filter changing: a row whose status this build does not
// recognise is UNREADABLE, not silently rendered as an open, actionable finding. The accepted set stays exactly
// 0083's CHECK (`open` | `closed`) — narrowing it to 'open' alone would turn every closed row into a false "could not
// be displayed" alarm, which is a worse failure than the one it guards.
describe("rowSchema pins the persisted status contract", () => {
  it.each([
    ["a status this build does not know", { status: "archived" }],
    ["a missing status", { status: undefined }],
    ["a null status", { status: null }],
    ["a non-string status", { status: 1 }],
  ])("%s makes the row UNREADABLE rather than an actionable open finding", async (_label, patch) => {
    const bad = row(patch);
    if (patch.status === undefined) delete (bad as Record<string, unknown>).status;
    const r = await loadCrossSourceFindings(io([bad]), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.shown, "an unrecognised status must not reach the list").toBe(0);
    expect(r.data.unreadable).toBe(1);
  });

  it("accepts exactly the two statuses 0083's CHECK permits, and no more", async () => {
    for (const status of ["open", "closed"]) {
      const r = await loadCrossSourceFindings(io([row({ status })]), NOW);
      expect(r.ok && r.data.shown, `${status} must parse`).toBe(1);
    }
  });
});

describe("A6/A7/A8 — the three Rule 5 remediations", () => {
  // The marker is checked against summary+guidance specifically — a title alone could match while the body said
  // something else entirely, which is exactly the mix-up this test exists to catch.
  it.each([
    ["product_unresolved", "Application needs identification", "software product"],
    ["operational_instance_absent", "Application is not linked to an operational record", "no operational application record"],
    ["operational_match_unaccepted", "Application match needs review", "candidates"],
  ])("%s renders its own reviewed copy", (reason, title, marker) => {
    const v = toView(row({ title_key: `${STEM}.${reason}.title`, evidence_json: { counts: {}, reason } }) as never, NOW);
    expect(v.title).toBe(title);
    expect(`${v.summary} ${v.guidance ?? ""}`.toLowerCase()).toContain(marker);
  });

  it("the three subtypes produce three DIFFERENT bodies, not one shared sentence", () => {
    const bodies = ["product_unresolved", "operational_instance_absent", "operational_match_unaccepted"].map(reason =>
      toView(row({ title_key: `${STEM}.${reason}.title`, evidence_json: { counts: {}, reason } }) as never, NOW).summary);
    expect(new Set(bodies).size).toBe(3);
  });

  // A2/A7 of the phase brief: the customer must never see the engine's own vocabulary.
  it.each(["product_unresolved", "operational_instance_absent", "operational_match_unaccepted"])(
    "%s never leaks the internal reason string into customer copy", reason => {
      const v = toView(row({ title_key: `${STEM}.${reason}.title`, evidence_json: { counts: {}, reason } }) as never, NOW);
      const blob = `${v.title} ${v.summary} ${v.guidance ?? ""} ${v.subjectKind} ${v.lifecycleLabel}`;
      for (const internal of ["product_unresolved", "operational_instance_absent", "operational_match_unaccepted",
                              "crossSource.", "discovered_application_unmanaged_by_idp"]) {
        expect(blob, `leaked "${internal}"`).not.toContain(internal);
      }
    });

  it("the unaccepted-match copy never says 'proposed' and never implies exactly one", () => {
    const v = toView(row({
      title_key: `${STEM}.operational_match_unaccepted.title`,
      evidence_json: { counts: {}, reason: "operational_match_unaccepted" } }) as never, NOW);
    const blob = `${v.title} ${v.summary} ${v.guidance ?? ""}`.toLowerCase();
    for (const t of ["proposed", "proposal", "a candidate", "exactly one", "the only"]) expect(blob).not.toContain(t);
    expect(blob).toContain("candidates");
  });

  it("claims no contract, spend or licence fact", () => {
    for (const reason of ["product_unresolved", "operational_instance_absent", "operational_match_unaccepted"]) {
      const v = toView(row({ title_key: `${STEM}.${reason}.title`, evidence_json: { counts: {}, reason } }) as never, NOW);
      const blob = `${v.title} ${v.summary} ${v.guidance ?? ""}`.toLowerCase();
      for (const t of ["contract", "spend", "licen", "cost", "savings"]) expect(blob, `${reason}: "${t}"`).not.toContain(t);
    }
  });
});

describe("A10 — copy fallback and prototype safety", () => {
  it("an unknown SUBTYPE falls back to the rule's broad copy", () => {
    const v = toView(row({ title_key: `${STEM}.a_state_this_build_never_heard_of.title` }) as never, NOW);
    expect(v.title).toBe("Application is not linked to an operational record");
    expect(v.summary.length).toBeGreaterThan(0);
  });

  it("an unknown RULE still renders a truthful non-empty card, never a raw key", () => {
    const v = toView(row({ title_key: "crossSource.a_rule_this_build_lacks.title" }) as never, NOW);
    expect(v.title).toBe("Governance finding");
    expect(v.summary).toBe("This finding needs review.");
    expect(v.title).not.toContain("crossSource.");
  });

  // The reader must not reintroduce the prototype hole the presenter fixed in 18E.
  it.each(["constructor", "toString", "__proto__", "valueOf"])("a %s title_key cannot leak a prototype member", key => {
    const v = toView(row({ title_key: key }) as never, NOW);
    expect(typeof v.title).toBe("string");
    expect(typeof v.summary).toBe("string");
    expect(v.title).toBe("Governance finding");
    expect(v.title).not.toMatch(/function|\[object/);
  });

  it("an unmapped subject_type renders a neutral noun, not the raw literal", () => {
    const v = toView(row({ subject_type: "some_future_subject" }) as never, NOW);
    expect(v.subjectKind).toBe("Finding");
  });
});

describe("A9/A11 — lifecycle and identity", () => {
  it("A9 a reopened finding reads as Returned", () => {
    expect(lifecycleLabel({ reopen_count: 1, first_seen_at: "2026-01-01T00:00:00Z" }, NOW)).toBe("Returned");
    expect(lifecycleLabel({ reopen_count: 0, first_seen_at: "2026-08-15T01:00:00Z" }, NOW)).toBe("New");
    expect(lifecycleLabel({ reopen_count: 0, first_seen_at: "2026-08-01T00:00:00Z" }, NOW)).toBe("Ongoing");
  });

  it("age is phrased, never a raw timestamp, and refuses to guess", () => {
    expect(firstSeenLabel("2026-08-15T01:00:00Z", NOW)).toBe("First seen today");
    expect(firstSeenLabel("2026-08-14T01:00:00Z", NOW)).toBe("First seen yesterday");
    expect(firstSeenLabel("2026-08-10T12:00:00Z", NOW)).toBe("First seen 5 days ago");
    expect(firstSeenLabel("not-a-date", NOW)).toBeNull();
    expect(firstSeenLabel(null, NOW)).toBeNull();
    expect(firstSeenLabel("2027-01-01T00:00:00Z", NOW), "a future stamp is not '0 days ago'").toBeNull();
  });

  // THE LIFECYCLE PROPERTY. 0083 refreshes one row as the subtype changes; the UI must key on the row, so the same
  // problem does not appear to vanish and return as a new item.
  it("A11 identity is the persisted row id and survives every subtype change", () => {
    const ids = ["product_unresolved", "operational_instance_absent", "operational_match_unaccepted"].map(reason =>
      toView(row({ title_key: `${STEM}.${reason}.title`, evidence_json: { counts: {}, reason } }) as never, NOW).id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe("11111111-1111-4111-8111-111111111111");
    // ...while the customer-visible advice genuinely changed.
    const titles = ["product_unresolved", "operational_instance_absent", "operational_match_unaccepted"].map(reason =>
      toView(row({ title_key: `${STEM}.${reason}.title`, evidence_json: { counts: {}, reason } }) as never, NOW).title);
    expect(new Set(titles).size).toBe(3);
  });
});

describe("A4/A13 — actions and identifiers", () => {
  it("A13 no raw UUID is used as a customer-facing label", async () => {
    const r = await loadCrossSourceFindings(io([row()]), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = r.data.findings[0];
    const visible = [f.title, f.summary, f.guidance ?? "", f.subjectKind, f.severityLabel,
                     f.confidenceLabel, f.lifecycleLabel, f.firstSeenLabel ?? "",
                     ...f.evidenceRows.flatMap(e => [e.label, e.value]), f.action?.label ?? ""].join(" ");
    expect(visible).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  });

  // A13, the half a UUID check misses. `toView` must PHRASE the age; passing the persisted timestamp straight
  // through would put `2026-08-10T12:00:00Z` in front of a customer, and a UUID-shaped assertion would not notice.
  it("A13 no raw timestamp reaches a customer-visible field", () => {
    const v = toView(row() as never, NOW);
    expect(v.firstSeenLabel).toBe("First seen 5 days ago");
    const visible = [v.title, v.summary, v.guidance ?? "", v.subjectKind, v.severityLabel, v.confidenceLabel,
                     v.lifecycleLabel, v.firstSeenLabel ?? "",
                     ...v.evidenceRows.flatMap(e => [e.label, e.value])].join(" ");
    expect(visible, "an ISO timestamp is not customer copy").not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(visible).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("evidence renders humanized labels and bounded values only", () => {
    const v = toView(row({ evidence_json: { counts: { applications: 1, duplicateAccounts: 3 } } }) as never, NOW);
    expect(v.evidenceRows).toEqual([
      { label: "Applications", value: "1" },
      { label: "Duplicate accounts", value: "3" },
    ]);
  });

  // A4 of the brief: never hard-code a route this build does not have.
  //
  // This assertion used to read "must stay null" — correct while #433 was unmerged, and stale by design the moment the
  // queue landed on main. Phase 18F-E turns it into the positive contract rather than deleting it, because the property
  // worth holding was never "null": it is that this href and the route registry agree.
  it("the unaccepted-match action links to the match-review queue that is now on main", () => {
    expect(KNOWN_ROUTES.applicationMatchReview).toBe("/directory/applications/review");
    const a = actionFor({ rule_id: "discovered_application_unmanaged_by_idp", subject_type: "directory_application" },
      "operational_match_unaccepted");
    expect(a).not.toBeNull();
    expect(a?.href).toBe("/directory/applications/review");
    // The label weighs nothing. Lane B has no ranking and rejected candidates coexist with open ones, so the CTA may
    // not promise a winner, a count, or a correct answer — it may only offer the review.
    expect(a?.label).toBe("Review available matches");
    for (const forbidden of [/recommended/i, /best match/i, /proposed match/i, /exactly one/i, /correct/i, /suggested/i]) {
      expect(a?.label ?? "", `the CTA label must not imply a winner (${forbidden})`).not.toMatch(forbidden);
    }
  });

  // PARAMETERLESS IS THE CONTRACT, not a detail. `actionFor` is handed only (rule_id, subject_type, reason) and
  // `rowSchema` omits `subject_id`, so a deep link is not merely absent — there is no id in scope to build one from.
  it("the match-review href carries no query string, fragment or path parameter", () => {
    const href = KNOWN_ROUTES.applicationMatchReview ?? "";
    expect(href).toBe("/directory/applications/review");
    expect(href).not.toMatch(/[?#=]/);
    // Asserted through the public surface: the view a real row produces carries the href and no subject id.
    const view = toView(row({ evidence_json: { reason: "operational_match_unaccepted" } }) as never, NOW);
    expect(view.action?.href).toBe("/directory/applications/review");
    expect(JSON.stringify(view)).not.toMatch(/subject_id/);
  });

  // The invariant the registry exists for, asserted in the direction that bites: a non-null href MUST be implemented.
  it("a non-null KNOWN_ROUTE implies the app implements it", async () => {
    const { IMPLEMENTED_ROUTES } = await import("@/app/(authenticated)/nav-items");
    const href = KNOWN_ROUTES.applicationMatchReview;
    expect(href).not.toBeNull();
    expect(IMPLEMENTED_ROUTES as readonly string[],
      `${href} is emitted by KNOWN_ROUTES but is not in IMPLEMENTED_ROUTES`).toContain(href!);
  });

  // THE JOIN between this file and the render test. The governance page cannot import this module in jsdom — both carry
  // a server-only sentinel — so its render test necessarily asserts against the action object rather than the real
  // mapping. That is only sound while the page renders the href it was HANDED. A literal in the page would satisfy the
  // render test and quietly ignore this module; that is what this refuses.
  it("the governance page renders the mapped href, never a route literal of its own", () => {
    const page = fs.readFileSync(
      path.join(process.cwd(), "src/app/(authenticated)/access/governance/page.tsx"), "utf8");
    expect(page, "the page must render the action's own href").toContain("href={f.action.href}");
    expect(page, "the page must render the action's own label").toContain("{f.action.label}");
    const code = page.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const known of Object.values(KNOWN_ROUTES)) {
      if (known === null) continue;
      expect(code, `${known} must come from KNOWN_ROUTES, not a literal in the page`).not.toContain(`"${known}"`);
    }
  });

  it.each([
    ["product_unresolved", "directory_application", "/directory/applications"],
    ["operational_instance_absent", "directory_application", "/directory/applications"],
  ])("%s routes to an EXISTING page", (reason, subject, href) => {
    const a = actionFor({ rule_id: "discovered_application_unmanaged_by_idp", subject_type: subject }, reason);
    expect(a?.href).toBe(href);
  });

  it("the other rules route by subject to pages that exist", () => {
    expect(actionFor({ rule_id: "active_saas_account_without_accepted_identity", subject_type: "app_account" }, null)?.href)
      .toBe("/saas/accounts");
    expect(actionFor({ rule_id: "duplicate_active_accounts_for_one_person", subject_type: "person" }, null)?.href)
      .toBe("/directory/people");
  });

  // The guard that makes the two tests above meaningful: every route this module can emit must be a real one.
  it("every href KNOWN_ROUTES can emit is a route the app implements", async () => {
    const { IMPLEMENTED_ROUTES } = await import("@/app/(authenticated)/nav-items");
    for (const href of Object.values(KNOWN_ROUTES)) {
      if (href === null) continue;
      expect(IMPLEMENTED_ROUTES as readonly string[], `${href} is not an implemented route`).toContain(href);
    }
  });
});
