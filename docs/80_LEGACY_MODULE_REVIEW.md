# 80 · Legacy Module Review

**Canonical source for: what to do with each pre-identity-first module.** Phase 7B classification. Nothing here is acted on by
Phase 7B — this is the decision record that lets later phases move without re-litigating each module.

## Classification

| class | meaning |
|---|---|
| **Safe to port** | correct as-is; reuse unchanged |
| **Backend reusable** | data layer sound, presentation superseded |
| **Formula needs verification** | produces a number nobody has re-derived; must not reach an executive surface until checked |
| **Needs redesign** | the model is wrong for a multi-directory product |
| **Replace completely** | superseded by canonical work |

---

## SaaS-management spoke — safe to port

These read `apps` / `contracts` / `files` and have no directory involvement. They are correct, tenant-scoped, and already feed the
SaaS Intelligence section.

`apps.ts` · `apps-inventory.ts` · `contracts.ts` · `contracts-summary.ts` · `contract-write.ts` · `contract-files.ts` ·
`files.ts` · `files-inventory.ts` · `files-summary.ts` · `catalog.ts` · `catalog-view.ts` · `audit.ts` · `audit-filter.ts` ·
`organizations.ts` · `reports.ts`

## Formula needs verification — do NOT surface on Home

| module | why |
|---|---|
| `dashboard-overview.ts`, `dashboard-charts.ts` | spend and renewal aggregations from `contracts` fields only. The **numbers are truthful** for what they read, but "tracked contract spend" is not total spend — there is no invoice or licence source. Fine where it is, labelled; must not become "Spend" on an executive card. |
| `contract-attention.ts` | renewal-window heuristics. Thresholds have not been re-derived against the current contract model. |
| `account-match-summary.ts`, `app-user-matches.ts`, `app-account-intelligence.ts` | matching between `app_users` and people. **Predates the canonical match model** and matches on identity attributes. Superseded in principle by `application_matches` (0075), which is application-level; the person-level equivalent does not exist yet. |
| `promotion-readiness.ts` | gating heuristics from an earlier connector model. |

## Needs redesign — single-directory assumptions

| module | problem |
|---|---|
| `people.ts` (`app_users`) | per-application account records with no connector scope. Correct for the SaaS spoke, but the name collides with directory People and it cannot answer "which directory". |
| `needs-attention.ts` / `needs-attention-loader.ts` | six cheap parallel reads over the SaaS spoke only. Integrating findings would add a counts RPC plus up to six table sweeps — **a change to the page's cost model**, deferred with reason since Phase 4. The executive attention queue on Home now covers the identity side. |
| `connectors.ts` (`listConnectorsForCurrentUser`) | pre-dates the connector inventory; does not know about supersession or disconnection. Still used by the operator sync-review route only. |

## Replace completely — already done

| module | replaced by |
|---|---|
| `customer-connectors/view.ts` | `provider-instances.ts` (Phase 5B) — **deleted** |
| `dashboards/identity-overview.tsx` | `executive-panels.tsx` (Phase 7A) — **deleted** |

## Security review

No module in this inventory uses a service-role client, accepts a browser tenant id, or bypasses RLS — `access-repository.test.ts`
and `check-auth-safety.sh` enforce that repo-wide. **No module is classified "security obsolete."**

The one standing gap is not a module but a *naming* hazard: `people.ts` serves `/people` ("App accounts") while
`directory-loaders.ts` serves `/directory/people`. Phase 1 renamed the nav entry precisely because two surfaces called "People"
reading two different tables is the confusion this product exists to remove.
