import { describe, it, expect } from "vitest";
import {
  buildFindingsCsv, buildIdentityAccessCsv, buildApplicationAccessCsv,
  FINDINGS_COLUMNS, IDENTITY_ACCESS_COLUMNS, APPLICATION_ACCESS_COLUMNS,
  exportFilename, csvResponse, exportError, EXPORT_ROW_CAP,
} from "./access-export";
import type { GovernanceFindingView, IdentityApplicationAccessView } from "./access-view-models";
import type { ApplicationIdentityAccessView } from "./access-loaders";

const UUID = "11111111-2222-4333-8444-555555555555";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const finding = (over: Partial<GovernanceFindingView> = {}): GovernanceFindingView => ({ id: "governance:redundant_direct_access:abc123", ruleId: "redundant_direct_access", subjectType: "identity", severity: "medium", severityLabel: "Medium", severityTone: "attention", confidence: "high", confidenceLabel: "High confidence", title: "Direct and group-based access overlap", summary: "Has a direct assignment and group access.", guidance: "Review both paths.", subject: { kind: "identity", label: "Ada Lovelace", href: `/access/identities/${UUID}` }, evidenceRows: [{ label: "Direct assignments", value: "1" }, { label: "Group paths", value: "2" }], staleEvidence: false, ...over });

describe("buildFindingsCsv", () => {
  it("emits the exact allowlisted header row in fixed order", () => {
    expect(buildFindingsCsv([]).split("\r\n")[0]).toBe(FINDINGS_COLUMNS.join(","));
  });
  it("projects only safe fields; subject is the LABEL (never the id/href/uuid); evidence is a summarized string", () => {
    const csv = buildFindingsCsv([finding()]);
    const [, row] = csv.split("\r\n");
    expect(row).toContain("Ada Lovelace");
    expect(row).toContain("Direct assignments: 1; Group paths: 2");
    expect(row).toContain("redundant_direct_access"); // finding_type + deterministic finding_id (not a canonical uuid)
    expect(csv).not.toMatch(UUID_RE);                 // no canonical/external uuid anywhere
    expect(csv).not.toContain(UUID);
    expect(csv.toLowerCase()).not.toContain("external_id");
    expect(csv.toLowerCase()).not.toContain("raw_payload");
    expect(csv).not.toContain("/access/identities/");  // no href
  });
  it("neutralizes formula injection in any cell (e.g. a hostile finding title)", () => {
    const csv = buildFindingsCsv([finding({ title: "=HYPERLINK(\"http://evil\")" })]);
    expect(csv).toContain(`"'=HYPERLINK`); // prefixed with ' then quoted (contains a quote/paren-safe but the '=' triggers, quote triggers quoting)
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/); // never a bare =HYPERLINK at a cell boundary
  });
});

describe("buildIdentityAccessCsv", () => {
  const app = (over: Partial<IdentityApplicationAccessView> = {}): IdentityApplicationAccessView => ({ applicationId: UUID, applicationLabel: "Salesforce", classification: "BOTH", classificationLabel: "Direct and through group", explanation: "", groupPaths: [{ groupLabel: "Engineering", staleEvidence: false }, { groupLabel: "Sales", staleEvidence: true }], staleEvidence: true, ...over });
  it("emits the allowlisted header + derives direct_assignment_count, group count/labels, stale Yes/No", () => {
    const csv = buildIdentityAccessCsv("Ada Lovelace", "okta", [app(), app({ applicationLabel: "Slack", classification: "GROUP", groupPaths: [{ groupLabel: "All", staleEvidence: false }], staleEvidence: false })]);
    const [header, r1, r2] = csv.split("\r\n");
    expect(header).toBe(IDENTITY_ACCESS_COLUMNS.join(","));
    expect(r1).toBe('Ada Lovelace,Salesforce,okta,BOTH,1,2,Engineering; Sales,Yes'); // BOTH → direct_assignment_count 1
    expect(r2).toBe("Ada Lovelace,Slack,okta,GROUP,0,1,All,No");                     // GROUP → 0
    expect(csv).not.toMatch(UUID_RE);
  });
});

describe("buildApplicationAccessCsv", () => {
  const id = (over: Partial<ApplicationIdentityAccessView> = {}): ApplicationIdentityAccessView => ({ identityId: UUID, identityLabel: "Ada", classification: "DIRECT", classificationLabel: "Direct", staleEvidence: false, ...over });
  it("emits the allowlisted header + direct count + stale marker; no uuid", () => {
    const csv = buildApplicationAccessCsv("Salesforce", "okta", [id(), id({ identityLabel: "Grace", classification: "GROUP", staleEvidence: true })]);
    const [header, r1, r2] = csv.split("\r\n");
    expect(header).toBe(APPLICATION_ACCESS_COLUMNS.join(","));
    expect(r1).toBe("Salesforce,Ada,okta,DIRECT,1,No");
    expect(r2).toBe("Salesforce,Grace,okta,GROUP,0,Yes");
    expect(csv).not.toMatch(UUID_RE);
  });
});

describe("filenames, response headers, error, cap", () => {
  it("filenames carry only a fixed prefix + date (no names, no ids)", () => {
    expect(exportFilename("access-findings", "2026-07-25")).toBe("access-findings-2026-07-25.csv");
    expect(exportFilename("identity-access", "2026-07-25")).toBe("identity-access-2026-07-25.csv");
  });
  it("csvResponse is a private, no-store, nosniff CSV attachment", async () => {
    const res = csvResponse("A\r\n1", "access-findings-2026-07-25.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="access-findings-2026-07-25.csv"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(await res.text()).toBe("A\r\n1");
  });
  it("exportError carries no cache + nosniff + no body detail beyond the message", () => {
    const res = exportError(413, "Too many rows.");
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("the row cap is 10,000", () => {
    expect(EXPORT_ROW_CAP).toBe(10_000);
  });
});
