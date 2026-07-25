// Phase 14 — the deterministic, injective governance finding-ID. Byte-length-tagged, domain-prefixed sha256 (the connector-vault
// canonicalAad discipline, crypto.ts:118-126) so two distinct findings can NEVER collide — even if a field value contains the separator.
// The id is folded from ONLY: a governance domain prefix + ruleId + the (tenant, connection, provider) scope triple + subjectType +
// subjectId + the SORTED relatedIds — all canonical directory ROW ids. It NEVER folds a label / external_id / email / login / name / URL /
// profile datum, so a mutable-label change never changes the id, and the same subject+related-set in ANY input order yields the same id.
// Folding the scope triple in gives cross-scope id isolation for free. Pure; no I/O.

import { createHash } from "node:crypto";
import type { GovernanceRuleId, GovernanceSubjectType, Scope } from "./types";

// server-only: keep the governance engine out of any client bundle.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("governance-analytics/finding-id is server-only and must not be imported in client code");
}

const DOMAIN = "idcaddie-governance-finding v1";

// UTF-8 byte-length tag each part so the joined form is injective (a value cannot forge the delimiter or the `len:` syntax).
const tag = (p: string): string => `${Buffer.byteLength(p, "utf8")}:${p}`;

export const scopeToken = (s: Scope): string =>
  createHash("sha256").update([DOMAIN, "scope", tag(s.tenantId), tag(s.connectionId), tag(s.provider)].join(" "), "utf8").digest("hex");

export function governanceFindingId(input: {
  ruleId: GovernanceRuleId;
  scope: Scope;
  subjectType: GovernanceSubjectType;
  subjectId: string;
  relatedIds: readonly string[];
}): string {
  const related = [...input.relatedIds].sort(); // order-independent: same set -> same id
  const parts = [
    DOMAIN,
    tag(input.ruleId),
    tag(input.scope.tenantId), tag(input.scope.connectionId), tag(input.scope.provider),
    tag(input.subjectType), tag(input.subjectId),
    tag(String(related.length)), ...related.map(tag),
  ];
  return `governance:${input.ruleId}:${createHash("sha256").update(parts.join(" "), "utf8").digest("hex")}`;
}
