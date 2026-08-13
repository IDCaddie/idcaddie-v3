// Phase 16 — the deterministic, injective cross-source finding key.
//
// Same discipline as Phase 14's `governance-analytics/finding-id.ts`: a byte-length-tagged, domain-prefixed sha256, so
// two distinct findings can never collide even if a field value contains the separator. Deliberately a SEPARATE domain
// and a SEPARATE function rather than a parameter on Phase 14's, because the folded scope differs — Phase 14 folds
// (tenant, connection, provider); this folds the TENANT only, since a cross-source finding spans connections by
// definition and has no connection to name.
//
// The `cross-source:` prefix is not decoration: migration 0083's `gf_key_domain_chk` requires it, so the two engines'
// id spaces cannot collide into one row.
//
// It folds ONLY: the domain, ruleId, tenantId, subjectType, subjectId, and the SORTED relatedIds — all canonical ROW
// ids. NEVER a label, email, login, external_id, display name, severity, message key, or timestamp. So a finding keeps
// its identity (and therefore its age and its lifecycle) when someone is renamed, when a rule's wording changes, and
// when the same related set arrives in a different order.

import { createHash } from "node:crypto";
import type { CrossSourceRuleId, CrossSourceSubjectType } from "./types";

// server-only: keep the engine out of any client bundle.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("cross-source-governance/finding-id is server-only and must not be imported in client code");
}

const DOMAIN = "idcaddie-cross-source-finding v1";

// UTF-8 byte-length tag each part so the joined form is injective (a value cannot forge the delimiter or `len:`).
const tag = (p: string): string => `${Buffer.byteLength(p, "utf8")}:${p}`;

export function crossSourceFindingKey(input: {
  ruleId: CrossSourceRuleId;
  tenantId: string;
  subjectType: CrossSourceSubjectType;
  subjectId: string;
  relatedIds?: readonly string[];
}): string {
  const related = [...(input.relatedIds ?? [])].sort(); // order-independent: same set -> same key
  const parts = [
    DOMAIN,
    tag(input.ruleId),
    tag(input.tenantId),
    tag(input.subjectType),
    tag(input.subjectId),
    tag(String(related.length)),
    ...related.map(tag),
  ];
  return `cross-source:${input.ruleId}:${createHash("sha256").update(parts.join(" "), "utf8").digest("hex")}`;
}
