# TODOs

Deferred work with enough context that picking it up later doesn't require
re-deriving the reasoning. Not a backlog of ideas -- only things that were
actually scoped and deliberately deferred.

## Run the multi-entity consolidation fake-door test

**What:** Add a "Multi-Entity Consolidation" line to the marketing site's
pricing/features area with a "Talk to us" button (reuse `ContactModal`),
wired to a 3-question follow-up (entity count, current tool/workaround,
what breaks today at close). Run for two weeks.

**Why:** A competitive-research pass identified multi-entity consolidation
as Rillet's one genuine advantage over Rekono. A full scoping session
found zero validated demand for it on Rekono's side -- three consecutive
"I don't know"s on demand, status quo, and target persona. Rather than
build a large architectural feature (touches the ledger, RLS, and every
financial statement) on inferred demand, this test gets a real signal for
~zero backend engineering cost.

**Pros:** Costs almost nothing to run; produces the exact named-person
evidence the scoping session couldn't (a real prospect, with specific
answers about their entity count and current pain); prevents the feature
from getting built later purely out of competitive anxiety with no actual
customer behind it.

**Cons:** Distribution is organic pricing-page traffic only (Rekono is
pre-launch -- there is no confirmed lost-deal contact list to email,
despite an earlier draft of this plan assuming one). Organic traffic on a
pre-launch site may be too low to produce any signal either way within two
weeks, in which case the test is inconclusive rather than a clean kill.

**Context:** Full architecture scoping (two approaches, effort estimates,
RLS/ledger impact, adversarial review, and an independent cross-model
challenge) already exists at
`docs/designs/multi-entity-consolidation.md` -- read that before building
anything, even after this test succeeds. The threshold is **1+ completed
3-question form submission**, not a raw click (a click doesn't distinguish
a real buyer from curiosity). If it succeeds, the required next step
before writing any code is confirming directly with that respondent
whether Approach A's report-only eliminations (never posted to any
ledger) would actually meet their bar -- this is a real, unverified
assumption in the design, not a solved detail.

**Depends on / blocked by:** Nothing. Not blocking anything else either --
this is deliberately not queued behind other work.
