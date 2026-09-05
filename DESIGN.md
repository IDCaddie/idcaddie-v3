# ID Caddie Design — v1.0

**Canonical source for: what a user is allowed to be told, and how a surface says it.**
[`ENGINEERING_STANDARDS.md`](ENGINEERING_STANDARDS.md) decides how much rigor a change earns; this
file decides what the change is permitted to claim. It sits in the **PRODUCT / DESIGN** band of the
authority hierarchy ([standards §X](ENGINEERING_STANDARDS.md#x--authority-hierarchy)) — it never
outranks current authority, and it is never a substitute for evidence.

This is **not a component library** and must not become one. It is a grammar. Primitives get built
when a need repeats, not in advance.

## North star

> Does this screen help an IT, procurement, finance, or security operator make the right decision
> from evidence they can trust, without requiring them to understand ID Caddie's schema, connectors,
> or reconciliation machinery?

If a screen only makes sense to someone who knows the data model, the screen is wrong — not the
operator.

## Principles

| Principle | What it means |
|---|---|
| **Truth before confidence.** | A hedge that is true beats a clean number that is not. |
| **Familiarity before novelty.** | Operators arrive with habits from the tools they already use. |
| **Decision before data dump.** | Lead with the decision the screen exists to support. |
| **Evidence before conclusion.** | A conclusion that cannot be traced back to evidence is not shippable. |
| **Unavailable is not empty.** | Not permitted to look ≠ looked and found nothing. |
| **Failed read is not zero.** | An error is not a count. |
| **Never-run is not complete-zero.** | A sync that never ran has no findings; it does not have *zero* findings. |
| **Stale is not absent.** | Old data is data, labelled with its age. |
| **Proposed is not accepted.** | A suggestion a human has not taken is not a fact about the company. |
| **Provider evidence is not normalized truth.** | What Slack said ≠ what we concluded. |
| **Normalized truth is not a governance conclusion.** | A linked account ≠ "unused paid license". |
| **Historical is not current.** | A past state is labelled as past, always. |
| **One primary action per decision surface.** | If everything is primary, nothing is. |
| **Exceptions and unfinished work stay visible.** | Never hide the rows that did not fit the model. |
| **Immediate interaction acknowledgement.** | Every interaction is acknowledged in the same frame it happened. |
| **Complexity belongs inside ID Caddie.** | Our reconciliation machinery is our problem, not the operator's. |
| **Visual novelty allowed; behavioral novelty requires evidence.** | Look new. Behave predictably. |

The truth-grammar principles are the same distinction the engineering standards draw between provider
fact, normalized fact, and governance truth ([§D](ENGINEERING_STANDARDS.md#d--provider-fact--normalized-fact--governance-truth)) —
carried through to the pixels.

## The truth grammar

Eight states. A surface that collapses any two of them into one is wrong, even if it looks right.
This is the single highest-value rule in this document: **most user-visible falsehoods in a governance
product are a collapsed state, not a wrong number.**

| State | Means | The user sees | Forbidden |
|---|---|---|---|
| **loading** | The read is in flight. | Shape without content — skeleton matching the coming layout; an announced `Loading…` status. | A zero, a count, an empty message, or a conclusion. |
| **true empty** | We were allowed to look, we looked, there is nothing. | A plain statement of nothing plus, where it helps, the way to add the first one. | Any wording that would also be shown when we could not look. |
| **unavailable** | We have no answer because we did not look — **not permitted** (RLS, scope, org boundary) or **never ran** (a sync/job with no first run). | Which of the two it is: that visibility is limited here and — where safe — who can see it; or that this has not run yet, and what starts it. | "None", "0", "No X yet", an empty table, a dash that reads as absence. |
| **failed** | The read was attempted and errored. | That the read failed, and the retry/next step. Raw provider or DB error text never reaches the user. | A zero, an empty state, or silence. |
| **stale** | Real data, from a known earlier point in time. | The value **and** its age/as-of time, together — never one without the other. | Presenting it as current. |
| **partial** | Some sources answered; some did not. | What is included, what is missing, and that the total is therefore a floor, not a total. | A total that silently omits the failed sources. |
| **proposed** | A machine suggestion awaiting a human. | Visibly distinct from accepted fact, with the accept/reject action and what the suggestion is based on. | Counting it in accepted totals; styling it like settled fact. |
| **accepted** | A human took the decision. | The fact, plus who accepted it and when. | Hiding the provenance once accepted. |

**Never-run** is the second cause of **unavailable**, and the one most easily mistaken for
**true empty**: a job with no first run has no findings — it does not have *zero* findings. "No
findings" and "we have not looked yet" are different sentences, and only one of them is safe to act
on. The two causes are distinguished in the copy, because the operator's next step differs: ask for
access, versus start the sync.

Working precedent in the codebase: `listContractFilesForCurrentUser` returns `not_readable` and
`query_failed` as first-class outcomes so the contract file list cannot say "No files attached yet."
about a read it was never allowed to perform. That shape — *the data layer returns the state, the
component renders the state* — is the pattern. A component that receives only an array can only ever
guess.

**Where the distinction is made:** in the data access layer, never in the component. A component that
has to infer "empty or forbidden?" from `[]` will get it wrong, and its tests will pass.

## Product behavior

### Tables
The default presentation for operator work. Column headers say what the value *is*, not which column
it came from. Sort and filter state is visible and survives navigation back to the table. Long values
truncate with the full value available — never silently. Row counts obey the truth grammar: a
filtered count says it is filtered; a partial result says so. Empty cells use one consistent mark, and
that mark means "no value", never "not permitted" — unavailable is a labelled state, not a dash.

### Navigation
The operator can always answer: where am I, what is this scoped to, how do I get back. Scope (tenant,
org, app, contract) is visible on any screen where it changes what the numbers mean. Back returns to
the list in the state it was left in. Deep links work — any screen worth discussing is worth pasting
into Slack.

### Keyboard and focus
Everything actionable is reachable and operable by keyboard, in an order that matches the visual
order. Focus is always visible — never removed, only restyled. Dialogs trap focus while open and
return it to the trigger on close. No keyboard trap anywhere else.

### Responsive behavior
Small screens are a legitimate way to check something, not the primary work surface. Layout reflows
rather than requiring horizontal page scroll; wide content (a table, a diagram) scrolls inside its own
container. Nothing decision-relevant is hidden at any width — narrow surfaces may reorder or collapse,
never drop.

### Accessibility
Not a phase. Semantic HTML first; ARIA only where semantics do not exist. Every control has an
accessible name. State changes that matter — loaded, saved, failed — are announced. Color never
carries meaning alone: the status pill carries a word, and the tone reinforces it. Text meets contrast
requirements in both themes.

### Touch targets
Interactive targets are large enough to hit on a phone and separated enough not to hit by accident.
Adjacent destructive and non-destructive actions get extra separation.

### Destructive actions
Named for what they do — never a bare "Confirm". Confirmation states the specific consequence and what
is affected. Confirmation is required in proportion to reversibility, not to how the control looks.
Irreversible actions say they are irreversible. Where undo is genuinely possible, prefer undo over a
confirmation dialog.

### Motion / reduced motion
Motion explains a relationship — where something came from, what changed. It is short and
interruptible. `prefers-reduced-motion` is honored: the transition goes away, the information does
not. Nothing decision-relevant is conveyed only by an animation.

### Evidence and provenance display
Every conclusion can be opened to its evidence, and the path back is visible on the surface that shows
the conclusion. Provenance travels with the value: which provider, which sync, as of when.
Provider evidence is shown as the provider stated it, never rewritten to match our normalization. When
we disagree with a provider, both are shown — ours labelled as ours.

## Primitives

Small, repeated-need pieces only, added when the need has already repeated. What exists today lives in
`src/components/` — a status-tone map, a badge, a skeleton set, a stat card, a connector icon, and two
small charts. That scale is the point.

**Do not build a giant component library.** Before adding a primitive, the
[pain-before-platform](ENGINEERING_STANDARDS.md#r--pain-before-platform) rule applies: name two
concrete places that already needed it. One speculative primitive is one more thing to keep true.

## Proving a design change

Design claims are claims, and [§F anti-vacuity](ENGINEERING_STANDARDS.md#f--anti-vacuity--prove-the-detector-works)
applies to them:

- A truth-grammar state is proven by a test that renders the state — the **unavailable** case must
  fail if the component starts rendering it as empty.
- An accessibility claim is proven by exercising it, not by the presence of an attribute.
- A "matches the legacy workflow" claim is proven against
  [14 Legacy UX Workflow Parity Map](docs/14_LEGACY_UX_WORKFLOW_PARITY_MAP.md), which is where
  user-visible workflow changes are approved — an unapproved user-visible change is a blocking finding
  ([07](docs/07_P0_REVIEW_CHECKLIST.md)).

A false empty / zero / no-result is a **P2 that blocks**
([§V](ENGINEERING_STANDARDS.md#v--blocker-semantics)). It is the failure mode this document exists to
prevent.
