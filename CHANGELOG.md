# Changelog

Versions are numbered `1.0`, `1.1`, `1.2`, … in order. Each release is one
merged change, and its commit subject carries the number (`v1.1: ...`), so
`git log --oneline` reads as the release history without needing tags.

## v1.88

Added SAFE and convertible note tracking -- the instrument almost every
pre-seed company actually raises on before there's a priced round to put
shares against, and something QuickBooks has no concept of at all. Neither
instrument is equity the day it's issued (a SAFE holder isn't a shareholder
yet, and a note holder is a creditor, not an owner), so the cash books as a
new liability, Convertible Notes & SAFEs Payable, and stays there until one
of two things happens: it converts, or it's repaid in cash instead.

Conversion reuses the exact two postings a priced-round share issuance
already makes -- `equity.js` gets a new `safe_conversion` type that splits
the principal into Common Stock and APIC (pulled the par/premium math out
into a shared `issueSharesLines` helper once a second caller needed it),
and the resulting shares land on the share register through the same
`recordShareTransaction` path a contribution funds. `shareRegister.js`'s
funding-type check now accepts either a contribution or a SAFE conversion
as valid payment for a share issuance. If the share register refuses the
issuance (over-authorized, say), the equity posting that already went
through gets voided rather than left half-done with a liability that's
gone and no shares to show for it.

What this deliberately doesn't do: turn a valuation cap and a discount into
a conversion price. That needs the round's own price and a definition of
"fully diluted" that two SAFEs from the same financing can define
differently -- the same reason `incomeTax.js` and `stockCompensation.js`
refuse to derive a tax rate or a fair value. The cap and discount are kept
for reference; the share count and price at conversion come from the
round's paperwork.

New Cap Table section: issue, convert, repay, or void an instrument, with
outstanding principal called out separately since none of it is on the cap
table above until it converts.

## v1.87

Surfaced the audit trail that already existed for every document type
(invoices, expenses, vendor documents, leases, tax documents, checks) but
had no frontend at all -- the backend has written `uploaded`,
`extraction_completed`, `human_correction`, `approved`, and a dozen other
events since early in this app's history, and none of them were visible
anywhere. Every detail pane now has a collapsed "Audit trail" section,
fetched only when first expanded (matching the lazy-load pattern the close
checklist already uses) so it doesn't add a request to the common case.
System events render with the context that made the decision -- extraction
confidence and cross-check result, the reason auto-approval fired, the
spot-check sample rate -- and human corrections render as a field-by-field
before/after rather than a raw JSON blob. This is the trust story this app
should be leading with: every number on the books traces back to who (or
what) touched it and why, not just what the current value is.

Fixed a real mobile overflow bug found while checking the new audit trail
at 390px: the two-column review/expense/vendor-doc/lease/tax-doc/check
queue layout never collapsed to one column below 900px, and none of the
six queue tables nor the line-items table had their own scroll container,
so the whole page scrolled sideways instead of just the table. The queue
layout's media query needed `minmax(0, 1fr)`, not bare `1fr` -- the same
implicit-minimum trap as flexbox's `min-width: auto`, where a single grid
track still grows to its content's min-content width unless told not to.

## v1.86

Added a board report: cash on hand, burn rate, and runway alongside an
income statement, balance sheet, budget vs actual, and cap table, all
pulled from the same statements this app already computes and tests
independently rather than a second copy of the numbers to keep in sync.
Burn and runway are new arithmetic (`boardReport.js`) -- averaged over the
trailing three months, since one month alone swings on invoice timing --
and null-safe: a board that isn't spending faster than it's earning shows
"Not burning," not a divide-by-zero or a misleading 0-month runway.

New endpoint `GET /api/reports/board`, and a Board Report tab with a
"Print / Save PDF" button that hides everything but the report itself
(`@media print`, visibility-based rather than hiding every other tab
individually, so it can't miss one).

Pulled `currentFiscalYearEndYear` out of routes/budget.js into
fiscalYear.js once boardReport.js needed the identical five lines a
second time, and added `computeCashPosition` to financialStatements.js
for the same reason no other report needed a cash-only figure before.

## v1.85

Added a stored trial-balance snapshot at close, from the roadmap: closing a
period has always been a human attestation with nothing behind it but the
attestation itself. Close automation (`closeAutomation.js`) can say what a
month's books are missing, but there was no record of what the books
actually said the moment someone signed off on them -- so reopening a
period to catch a late entry and closing it again just overwrote the only
frozen picture that ever existed, leaving nothing to compare against.

Every close (and every re-close) now creates a `ClosePeriodSnapshot`: the
trial balance as of the last day of the period, frozen at that moment.
History, not a single field -- a period reopened and re-closed multiple
times (the routine reason is a late adjusting entry) keeps every one of its
attestations. Three new endpoints under `/api/close/periods/:id`:
`snapshots` lists every close taken for a period, `snapshots/:snapshotId`
returns one frozen trial balance in full, and `snapshots/diff` compares the
two most recent snapshots account-by-account so a controller can see
exactly what a re-close changed instead of just a new number with nothing
to check it against. The close tab's UI grew a "Close history" panel
showing the same thing.

## v1.84

Fixed five UI defects found by actually running the marketing site and
dashboard rather than trusting a green test suite -- this repo's backend
tests can't see the frontend at all, so several of these had shipped
invisibly:

- The line-item editor's table fought its own panel for width. The panel
  around it was widened for exactly this form, but `.line-item-table` was
  a flex child with no `min-width: 0`, so it grew to fit its own content
  and blew out the panel (and every ancestor up to the page) instead of
  scrolling in its own box. Added `width: 100%; min-width: 0` alongside
  the existing `overflow-x: auto`.
- Most tables in the app (32 of 34) were bare `<table>` elements with no
  scroll wrapper. Financial tables routinely run 6-8 columns, more than a
  phone screen fits, so on mobile they blew out the page the same way the
  line-item table did. `.tab-panel > table, .panel > table` now render
  `display: block; overflow-x: auto` so the table's own box scrolls
  instead of the page -- tables already wrapped in `.table-scroll` or
  `.line-item-table` are excluded by the child-combinator scoping.
- Number inputs' default rendered width was narrower than several of this
  app's own placeholders ("Optional", "No limit", "e.g. 50 for
  double-declining"), clipping them mid-word on the vendor, equity, and
  fixed-asset forms. Gave `input[type="number"]` the same minimum width
  the line-item table already uses for its own number columns.
- Five groups of document-type filter buttons (expenses, vendor docs,
  leases, tax docs, checks) were missing the shared `.filter-btn` class
  their styling depends on, so they rendered as unstyled buttons instead
  of filter chips.
- The demo org's chart of accounts had two different accounts on account
  code `5080` -- "Rent" and `accountsPayable.js`'s reserved "Purchases
  Discounts Taken" (created on demand the first time an early-payment
  discount is taken, which the demo's vendor terms do exercise). Nothing
  in the ledger was actually wrong -- `Account.code` isn't a uniqueness
  constraint -- but it read as a bug on the trial balance and chart of
  accounts. Moved the demo's Rent account to `5085`.

## v1.83

Fixed a silent-failure gap across every extraction module (invoices,
receipts, tax documents, vendor documents, checks, leases): when the LLM
call failed, the fallback to the heuristic extractor swallowed the error
completely, with nothing printed anywhere -- so a misconfigured or failing
LLM provider looked identical in the logs to one that was never
configured at all. `transactionCategorization.js` already logged its own
LLM failures for exactly this reason; the six extraction modules were the
outliers. All six now log the real error before falling back, so a bad
API key, an unsupported model, or a rate limit shows up in the logs
instead of just quietly degrading every extraction to heuristic mode.

Also closed a related gap in the test suite itself: `jest.setup.js`
cleared `GEMINI_API_KEY` to keep the suite deterministic, but never
cleared `OPENROUTER_API_KEY`/`OPENROUTER_MODEL` -- so a developer with a
real OpenRouter key in their local `.env` would have the suite silently
attempt real network calls instead of exercising the heuristic path every
LLM-backed test assumes. Now cleared alongside the Gemini key.

## v1.82

Added bad debt write-offs for customer invoices -- recognizing a customer
balance as uncollectible without pretending the sale never happened. A
write-off posts Debit Bad Debt Expense / Credit Accounts Receivable, dated
to when it was written off; the original revenue stays booked exactly as
billed. Deliberately not a void: a void reverses the sale itself, a
write-off is a separate claim about collectibility made later. Supports
partial write-offs (a second write-off can finish one), can't exceed
what's still actually outstanding once payments and credit memos are
netted out, and only applies to invoices that were actually sent (a draft
or void has no receivable to write off). Written-off amounts drop off AR
aging, show up on the customer statement at their own date, and are
audit-logged like every other balance-changing action here.

## v1.81

Added vendor statements -- the AP mirror of v1.80's customer statements. A
vendor's own AP activity over a period with a running balance, for
reconciling against a vendor's own statement or answering "what do we
still owe them."

Built the same way the AR side is, with one real wrinkle: a customer
invoice posts at its own issue date, but `postInvoiceApproval` never takes
an entryDate -- every bill approval posts dated to whenever the approval
actually ran (see accountsPayable.js's header comment). So a bill's
statement line can't use its own invoice date; it looks up the journal
entry the approval actually posted and uses that date, or excludes the
bill entirely if approval never posted (a closed period, most likely) --
same reasoning `computeApAging` only counts a bill once it's actually a
payable. Payments and vendor credit memos both already carry their own
accurate posting date. Resolved by vendor identity (the same resolver AP
aging uses), so a bill approved before a merge still lands on the right
statement once merged.

New "Statement" action on each vendor in the Vendors tab, sharing the same
period-picker modal and printable output the Customers tab already added.

## v1.80

Added customer statements -- a customer's own AR activity over a period
with a running balance, for the "here's what you owe" email or collections
call that AR aging alone can't answer (aging says who's overdue right now;
a statement says how a balance got to where it is).

Built from the same three events that actually move a customer's AR
balance in the ledger, each dated to when it did: an invoice at its issue
date (Debit AR), a payment at its payment date (Credit AR), and a credit
memo at its own issue date -- not whichever invoice it's later applied to,
since `postCustomerCreditMemo` credits AR the moment the memo posts.
Activity before the requested period folds into an opening balance instead
of appearing as a line, the same convention a bank statement uses.

New "Statement" action on each customer in the Customers tab: pick a
period, and it opens a printable statement in a new window (same pattern
the Bill Payments tab already uses for printing a check).

Added prepaid expense amortization -- the AP mirror of the deferred
revenue engine, for money paid up front for something consumed over time
(a year of insurance, a prepaid lease, an annual license). Until now the
full amount hit expense the moment it was paid, overstating that month
and understating every month the payment actually covered.

Recording one posts Debit Prepaid Expenses / Credit the payment account
immediately -- the cash left, but nothing has been consumed yet. A month
of amortization posts Debit the expense account / Credit Prepaid Expenses
for everything due through the requested period, catching up any earlier
month nobody ran, one journal entry per month.

Deliberately its own record (`PrepaidExpense`) rather than something
threaded through `postInvoiceApproval` -- that function is called from
four different bill-approval paths with no per-bill input today, and a
prepaid expense is the exception, not the rule. It reuses
`revenueRecognition.js`'s `buildSchedule` directly (day-prorated, rounding
remainder on the last month, already covered by its own tests) rather
than reimplementing the same math on the AP side. A prepaid expense can
only be voided before any month has been amortized, same reasoning voiding
an applied credit memo is refused: unwinding history already fed into a
reported-on period is a conversation, not something to silently reverse.

New "Prepaid Expenses" tab under Payables, mirroring the Revenue
Recognition tab: record, preview an amortization run before posting it,
run it, and a waterfall of what's left and when it releases.

## v1.78

Added vendor credit memos -- a return, a billing error, or a goodwill
adjustment a vendor issues against what you owe them. The AP mirror of
v1.77's customer credit memos, and closes the last asymmetry between the
two sides of the ledger this app models.

A vendor credit memo (`VendorCreditMemo`) posts immediately on creation --
Debit Accounts Payable / Credit the expense account it reverses -- with no
draft stage, same reasoning as the AR side: something already billed needs
correcting, so there's no "not on the books yet" state worth modeling.
Unlike `CustomerCreditMemo`, there's no line-item sub-table: `postInvoiceApproval`
has never split an approved bill's total across more than one expense
account, so a credit against that bill mirrors the same one-account,
one-amount shape `RecurringBill` already settled on for the identical
reason.

Applying a credit to a specific bill (`VendorCreditMemoApplication`) posts
no journal entry of its own -- the money already moved when the memo
posted -- and is validated against the bill's *resolved* vendor identity
(via the same `vendors.js` resolver AP aging uses), not a raw name match,
so a credit can't be misapplied to a similarly-named vendor's bill.
`amountCreditedCents` is added alongside `amountPaidCents` everywhere a
bill's outstanding balance is computed (Bill Payments, AP aging), so a
bill settled partly by credit drops off both the same way a cash payment
would.

## v1.77

Added customer credit memos -- a return, a billing error, or a goodwill
adjustment that reduces what a customer owes. Until now the only way to
correct a sent invoice was voiding it outright, which refuses once any
payment exists, or leaving the AR balance simply wrong.

A credit memo is its own document (`CustomerCreditMemo` + line items, its
own `CM-0001` numbering) rather than a reversal of specific invoice lines,
and posts immediately -- Debit each line's revenue account (+ the taxable
share of Sales Tax Payable) / Credit Accounts Receivable -- with no draft
stage: by the time someone cuts a credit, there's no future commitment to
stage the way an invoice has. It doesn't unwind a deferred-revenue
schedule even when crediting a line that was originally billed on a
service period; working out how much of that line was already recognized
is a judgment call this app punts to a manual journal entry rather than
guess at silently.

Applying a credit to a specific invoice (`CustomerCreditMemoApplication`)
posts no journal entry of its own -- the money already moved when the
memo posted, so this is bookkeeping for the AR sub-ledger only, same
relationship a payment has to the invoice it's recorded against.
`amountCreditedCents` is added alongside `amountPaidCents` everywhere an
invoice's outstanding balance is computed (status, aging, the invoice
API's `amount_outstanding`), so a customer settled by credit instead of
cash behaves identically everywhere: the invoice flips to paid, and it
drops off AR aging the same way a cash payment would.

A credit memo can only be voided before it's been applied to anything
(mirrors the existing rule for a paid invoice), and an application is
bounded on both sides -- it can't exceed what the memo has left unapplied,
and it can't exceed what the invoice still owes.

## v1.76

Added recurring vendor bills -- the AP mirror of v1.69's recurring customer
invoices, for rent, subscriptions, and retainers you pay every period
instead of billing to someone else. Save a template once (vendor, expense
account, amount, frequency) and each period creates a real bill in the
Review Queue for a human to approve, or check "Auto-approve" to have it
post to Accounts Payable on its own.

An occurrence is a real `Invoice` row (the AP bill model), not a separate
table -- it goes through the same Review Queue, the same
`postInvoiceApproval`, and the same AP aging every manually-entered bill
does, so a recurring bill can't drift from what one looks like. There's no
line-item sub-table the way `RecurringInvoice` has one: `postInvoiceApproval`
has never split an approved bill's total across more than one expense
account, so a template mirrors that shape with one flat amount and one
account rather than modeling a breakdown the ledger would ignore anyway.

One thing worth knowing if you go looking for the posted entry: unlike the
AR side's `postCustomerInvoice` (dated to the invoice's own `issueDate`),
`postInvoiceApproval` has never taken an `entryDate` -- every bill approval,
recurring or manual, posts dated to whenever the approval actually ran. An
auto-approved occurrence for a back-dated period still shows up on the
books today, not on the period it's for.

## v1.75

Fixed "Ask Rekono" showing new messages at the top of the thread instead
of the bottom. The widget's `#ask-thread` is a plain top-to-bottom column
(not reversed), but each new question/answer was `prepend`ed into it --
so asking a second question pushed the first one down instead of adding
below it, and a longer conversation read newest-first, backwards from
every other chat surface. `prepend` is now `append`, with the thread
scrolled to the bottom on both the question appearing and the answer
replacing "Thinking…" (a long answer can grow the entry after the first
scroll already landed). This is exactly the kind of bug the backend test
suite can't see -- `backend/public/` has no automated coverage, so it
shipped and sat unnoticed until someone actually opened the widget and
had a two-question conversation.

## v1.74

Added budget vs actual, the last of this batch's six improvement ideas.
Set an annual revenue or expense target per account and see it against
what the ledger actually shows -- until now, that comparison meant
exporting the P&L and building it by hand every time someone wanted to
know whether the year was on pace.

A budget is set against the exact same accounts `computeProfitAndLoss`
reports on, and `budget.js`'s notion of "actual" reuses that function's
own normal-balance convention and closing-entry exclusion, so budget vs
actual agrees with the P&L for the same accounts and period by
construction -- not by two implementations happening to match. Budgets are
keyed by fiscal year using the org's own configured year-end
(`fiscalYear.js`), not a hardcoded calendar year, and an annual figure
splits evenly across those months with the remainder on the last one, the
same rounding rule `revenueRecognition.js`'s schedule uses for the same
reason: a plan that doesn't sum to the number someone typed in is worse
than not having one.

An account with real activity but no budget line still shows up on the
report rather than silently missing -- an unbudgeted expense is exactly
the kind of thing this report exists to catch. Variance favorability is
computed once, server-side, because the same sign means opposite things
for revenue (over plan is good news) and expense (over plan is bad news):
the frontend colors a green/red column from that computed answer instead
of re-deriving it from a raw number and risking getting it backwards. A
`through_month` filter turns the report into "on pace so far this year"
instead of only ever comparing full-year figures against a
partly-elapsed one.

## v1.73

Added declining-balance depreciation as a second method alongside
straight-line. `models/FixedAsset.js` used to scope this out on purpose --
"declining-balance and MACRS are tax concepts more than bookkeeping ones" --
and that reasoning still holds for full MACRS: the IRS's recovery-period
tables and half-year/mid-quarter conventions are a tax-filing lookup this
app has no business guessing, the same reason `incomeTax.js` refuses to
invent a tax rate. Declining-balance itself, though, is just a different
real ledger calculation, and the objection was specifically to *picking a
method for the user* -- so this adds it as an explicit opt-in where the
user supplies the annual rate directly (e.g. 50% for double-declining on a
4-year asset), never derived or defaulted.

The harder problem was mechanical: every existing consumer of
`RecurringEntry` (accruals, rent, prepaid amortization, straight-line
depreciation itself) posts the same fixed line amount every occurrence --
`runRecurringEntries` reads a template's lines once and replays them
unchanged across every due date in a run. A declining-balance asset's
amount shrinks every period, which that machinery has no way to express,
so retrofitting it there risked every other adjusting entry to serve one
new method. Instead, a declining-balance asset skips the template
entirely and posts through its own action
(`runDecliningBalanceDepreciation`), computing each period's amount off
the *actual* accumulated balance the ledger shows right before it, not a
running total kept in memory -- so posting several missed months at once,
or in any order, is self-correcting rather than compounding drift. It
floors at salvage value and simply stops, since pure declining-balance
never reaches zero on its own; a real switch-to-straight-line convention
is exactly the kind of MACRS-specific rule this stays out of.

## v1.72

Added 1099-NEC prep: which vendors this org paid enough, and by what
method, to owe them a Form 1099-NEC for the year. Before this, answering
"who do we need to send a 1099 to" meant pulling every vendor's payment
history by hand and remembering, vendor by vendor, which of those payments
even count.

Two rules do the filtering, both straight from the form's own
instructions rather than anything invented here: $600 or more in a
calendar year, and paid by cash, check, or bank transfer -- a payment made
by credit card is excluded by statute (IRC 6050W), since the card network
reports it on a 1099-K instead, and reporting the same payment on both
forms is the actual bug this guards against. `paymentAccountId`'s own
subtype on `BillPayment` is the signal `form1099.js` uses: `credit_card`
means it doesn't count, anything else does.

Whether a given vendor is a corporation (generally exempt from 1099-NEC
regardless of amount) is not something Rekono can know without asking, so
that's a vendor-level flag a human sets, defaulting to *not* exempt -- an
unmarked vendor over the threshold shows up as needing attention rather
than silently dropping off the report. `Vendor.taxIdLast4` keeps the same
last-four-only stance `TaxDocument.recipientTinLast4` already established
for the exact same reason: a full SSN in a database column is a liability
with no matching upside for what this app needs a TIN for.

## v1.71

Added a real bank reconciliation: tying a cash account's book balance to
what a bank statement actually reports, with outstanding checks and
deposits in transit called out by name. Before this, the only way to
sanity-check a Cash account against a real statement was to eyeball the
ledger --
there was no record of which transactions the bank had actually seen, and
no way to see, deposit by deposit and check by check, why a running
balance didn't match paper.

`BankReconciliation` and its `ReconciledJournalLine` join table
(`bankReconciliation.js`) never touch `JournalLine` itself -- posted
entries stay immutable, exactly as `ledger.js` requires; "cleared" is
reconciliation bookkeeping recorded alongside the ledger, not a fact
stamped onto it. Starting a reconciliation asks for the statement's ending
balance (supplied, never derived, the same "don't invent a number" stance
`incomeTax.js` and `salesTax.js` already take on their own inputs); ticking
off a line moves it out of "outstanding," and the reconciliation reports
its difference as the statement balance against what's actually been
cleared per the books, not a guess. A line can only ever be claimed by one
reconciliation -- once one completes, its cleared lines are locked in, so
a later statement can't accidentally re-clear the same check. Completing a
reconciliation is an attestation like a period close, not an enforced
gate: it doesn't stop a later entry from landing on the account, it just
records that a human tied out to this statement, and it can be reopened if
that attestation turns out to be wrong.

## v1.70

Added sales tax as its own liability, instead of it disappearing into
revenue. Tax collected from a customer isn't this org's money -- it's
held on behalf of the state until remitted -- so treating it as revenue
overstated income and left nothing on the books tracking what's actually
owed.

An org sets one `sales_tax_rate_percent` in Settings; a customer can be
marked `tax_exempt` and a line can be marked non-taxable (shipping,
already-taxed resale, etc.), both overriding the org rate down to zero for
that scope. `postCustomerInvoice` now splits a sent invoice's total into
the existing AR debit and revenue credit, plus a new credit to a
`Sales Tax Payable` liability account (code 2300, created on demand the
same way `incomeTax.js` creates its own accounts) for the tax portion --
mirroring `salesTax.js`'s design on `incomeTax.js`'s running-balance and
on-demand-account pattern throughout. `recurringInvoices.js`'s auto-send
path applies the same computation, so a recurring invoice's tax isn't a
second implementation of the same rule. Remitting collected tax
(`POST /api/sales-tax/remit`) debits the payable and credits cash the same
way a bill payment does, and is refused past whatever is actually accrued
-- there's no way to remit tax the org never collected.

As with the tax provision in `incomeTax.js`, the rate is supplied, never
guessed: no rate configured means no tax charged, not a default rate
invented on the org's behalf.

## v1.69

Added recurring customer invoices -- the AR equivalent of the recurring
adjusting entries `recurringEntries.js` already handled on the ledger side.
A customer on a retainer or subscription had no way to be billed on a
schedule; someone had to re-create the invoice by hand every period, with
every chance that implies to forget a month or bill the wrong amount.

A `RecurringInvoice` template (customer, lines, frequency, start/end dates)
reuses `recurringEntries.js`'s own `dueDates` schedule arithmetic rather
than reimplementing it, and issues each occurrence as a draft
`CustomerInvoice` -- reviewed and sent like any other invoice. An optional
`auto_send` flag posts and sends the occurrence immediately instead, for
templates trusted to run unattended; if the ledger refuses the send (a
closed period), the draft still stands and the failure comes back as
`send_error` rather than leaving a stuck draft with no explanation. The
three-step "post, schedule, mark sent" logic the manual Send button already
did was factored out into `accountsReceivable.js`'s `sendCustomerInvoice`
so auto-send reuses the exact same path instead of a second copy of it.

## v1.68

Refreshed the `/graphify` code-graph model (`graphify-out/`) — it hadn't been
rebuilt since v1.53, so everything shipped since (the full ledger/AR/AP/
payroll/equity/income-tax accounting core through v1.67, the investor demo
enrichment, and this release's own auto-reversing entries) was invisible to
graph queries. Incremental update over the 65 changed files: 2247 nodes,
5535 edges, 165 labeled communities, clean health check. No application
code changed — this is a developer-tooling artifact, not a product change.

## v1.67

Recurring entries (`recurringEntries.js`) covered adjusting entries but not
the one piece of the accounting cycle they're conventionally paired with:
reversing entries. An accrual posted for accrued wages, accrued interest, or
an expense incurred but not yet billed had no way to *un*-post itself before
the real bill or payroll run landed, so a strict reading of the accounting
cycle -- record, post, adjust, close, reverse -- was missing its last step.

A `RecurringEntry` template can now be flagged `auto_reverse`. Each occurrence
still posts exactly as before, but if the flag is set, its mirror image
(debits and credits swapped, same shape `voidJournalEntry` already uses for a
correction) posts immediately after, dated the first of the *following*
month regardless of the template's own day-of-month or frequency -- the one
date guaranteed to be in place before whatever real transaction the accrual
was standing in for arrives sometime that month. Left off by default:
depreciation and prepaid amortization are never replaced by a later real
transaction, so reversing them would just re-create the expense they
correctly recorded.

If the reversal's target period turns out to already be closed, the accrual
still stands -- a downstream posting problem in a future period doesn't
retroactively invalidate an entry that's correct on its own -- and the
failure comes back as `reversal_error` on the run response rather than being
swallowed, the same "named, not silently skipped" contract a refused period
already gets.

## v1.65

A bill paid with an early-payment discount (v1.64) never showed as fully
paid outside the trial balance and AP Aging: the Bill Payments list
(`GET /api/bills`) and a bill's own detail view each summed
`BillPayment.amountCents` alone in a second, independent calculation that
predates the discount column and was never updated for it, so a bill
settled for cash+discount sat at "$X outstanding" on the Bill Payments tab
forever, and its own detail page called it "partial" rather than "paid".
Both now count amount+discount, matching the shared `amountPaidCents` the
rest of the app already used correctly. Caught by actually watching the
richer demo data added next (v1.66) flow through every screen, rather than
just the report that happened to already be right.

## v1.66

Every accounting feature shipped since v1.56 -- real AR invoicing, AP
vendor bills with early-payment discounts, payroll, equity events, income
tax -- was invisible in the investor demo. Receivables, Payroll, Equity,
and Income Tax read as completely empty tabs, and the Documents tab's
sample bills were never actually posted to the books, so approving one in
the demo did nothing to Payables or the ledger. The demo's entire
Accounting section ran on a separate set of raw journal entries with no
connection to the AP-automation documents sitting right next to it.

Adds, all posted through the same real functions a customer's data goes
through (never raw inserted rows, so nothing can post out of balance):
two vendor bills approved for real and paid -- one via a written check
that takes its vendor's 2%/10-day early-payment discount, the other
partially, so AP Aging has a real outstanding balance to show; two
customers with invoices across every lifecycle stage (draft, sent and
overdue, sent and partially paid, sent and fully paid), populating AR
Aging and the Sales/Cash Receipts journals for the first time; two
employees with a couple of pay periods; the founder contribution and an
owner distribution as real equity transactions instead of one raw entry;
and an income tax provision with a partial payment against it. A visitor
clicking through any tab in the demo now finds real, current data instead
of an empty state that undersells what the product actually does.

## v1.64

The purchases and cash payments journals get the specialized columns a
traditional set of books gives them, instead of the generic date/memo/doc
#/journal/total layout every journal shared. Purchases journal: Date,
Account title, Doc #, Post ref., and a single Amount column (debit and
credit are the same figure by construction, so one column is both, per how
these journals are usually kept). Cash payments journal: Date, Account
title, Doc #, Post ref., Debit, Credit, plus three named columns --
Accounts Payable debit, Purchases Discount credit, Cash credit -- for the
common case of paying a bill; a cash payment that isn't paying a vendor
bill (payroll, an income tax payment, an equity distribution) falls into
the generic columns instead of leaving the AP-specific ones sitting empty
for something they were never meant to describe.

Building "Purchases discount credit" surfaced that the app already
computed early-payment discounts (the AP Aging report has quoted "Save
$X by paying before Y" for a while) but never let anyone actually take
one -- paying a bill only ever posted the full cash amount. Recording a
payment or writing a check now takes an optional discount amount; it
posts as a credit to a new on-demand "Purchases Discounts Taken" account
(a contra-expense, so it reduces the P&L's expense total, which is what
taking a discount should do) and fully relieves the payable for
amount+discount rather than leaving the discount portion outstanding
forever.

Both journals are identified from the ledger's own data, not by
source-specific special-casing: a new `account_subtype` field on each
journal line lets the frontend recognize "the Accounts Payable line" or
"the cash line" by what the account actually is, which keeps working even
if someone renames or recodes those accounts.

## v1.63

Every journal (general, sales, purchases, cash receipts, cash payments)
was only ever shown as one summary row per entry -- date, memo, source,
total, status -- with no way to see the actual lines: no account title,
no debit/credit split, no doc number, no post reference. That's every
column a manual ledger is expected to carry, missing from all five at
once, since they're all filters over this same table.

Two additions close the gap. A "Doc #" column and optional field on the
manual entry form record the paper document an entry corresponds to
(check, invoice, receipt, memorandum) -- populated automatically from the
vendor invoice number on approval, the customer invoice number on billing,
and the check number on a written check, and left blank where no such
document exists (a payroll run, an equity event) rather than inventing
one. Clicking any entry now expands it in place to show its lines: account
title, post ref. (the account's code -- the real-time equivalent of the
ledger page a paper post ref points to), debit, and credit.

## v1.62

Every account amount on the trial balance, income statement, and balance
sheet is now a link -- click it and a drill-down shows the actual posted
journal lines that sum to it, oldest first, with a running balance, ending
in the same total the report shows. There was previously no way to see
that from the app itself; the only route was reading the raw journal
entries tab and adding lines up by hand. New endpoint: `GET
/api/accounts/:id/ledger` (optional `from`/`to`), reusing
financialStatements.js's own normal-balance-by-account-type logic so the
drill-down can't drift out of sync with what the reports actually compute.
Each row also lists the other account(s) the entry touched, so a payroll
run or bill payment reads as the transaction it was, not a bare debit or
credit.

## v1.61

A bookkeeping rule the special-purpose journals (v1.56) didn't fully
enforce: anything that actually moves cash belongs in the cash receipts or
cash payments journal, never the general journal -- even when it's also an
equity or tax event. Five equity events were falling through: a capital
contribution or a treasury reissue brings cash in; a distribution, a paid
dividend, or a treasury purchase pays cash out. All five previously shared
one `equity_transaction` source with dividend *declarations* (which don't
move cash), so all of them landed on the general journal. Same issue with
an income tax payment, which shared a source with the non-cash provision
accrual. Each now posts its own source value and is routed into cash
receipts or cash payments accordingly; declaring a dividend and accruing
the tax provision correctly stay on the general journal, since neither
moves cash yet. New tests in subJournals.test.js cover all five events plus
the two that correctly stay put.

## v1.60

A command palette (⌘K / Ctrl+K, plus a visible "Search" button in the top
bar) for the app's ~30 destinations, spread across the six top-bar menus
(Documents, Workflow, Receivables, Payables, Accounting, Admin) -- reported
as too many categories to keep track of. Rather than cut real destinations
to shrink the count, this adds a second, faster path to all of them: type
a name and jump straight there instead of knowing which menu it lives
under. The menus themselves are unchanged.

The palette's index is built from the nav's own `[data-tab]` buttons at
open time, not a hand-maintained second list -- a destination added to a
menu shows up here for free, and the staff-only tab (gated on `is_staff`)
is excluded the same way it's excluded from the menu, with nothing to keep
in sync. Filtering matches on both the destination's name and its menu
group, so "pay" finds Vendors/Bill Payments/AP Aging (the Payables group)
alongside Payroll. Arrow keys move the selection, Enter jumps, Escape or a
click on the backdrop closes it. Verified live: 31 destinations indexed,
filtering, keyboard navigation, and both open paths (button and Ctrl+K) all
confirmed working, on desktop and mobile, no console errors.

## v1.59

Two "Website UI/Design" items reported as still broken after v1.56 closed
them. Both reports were right; v1.56 had answered adjacent questions.

**"Add an account" on Home now adds an account.** The complaint was that it
was missing account code, equity, revenue and expenses. v1.56 read that as
being about the dashboard's quick-action button and pointed it at the Chart
of Accounts tab -- but the thing someone lands on when they go looking for
"add an account" on the home page is the *Net Worth widget's form*, which
was headed exactly that and offers Name, Category, Balance and Notes, with
categories running cash/investment/property/credit card/loan. No code
field, and no equity, revenue or expense, because a net-worth tracker has
no use for any of them. The report described that form precisely.

Two forms on one page were claiming the same name, so the fix is in two
parts. The net-worth form is now headed "Add a net worth account" (and
"Edit net worth account"), which is what it has always been. The Home quick
action opens a real Chart of Accounts form in a modal -- name, the full
asset/liability/equity/revenue/expense type set, category, and the code
whose absence was reported -- rather than navigating to another tab, since
"fix adding an account on the home page" is not answered by leaving the
home page.

Both that modal and the Chart of Accounts form post through one
`createAccount()`, so the POST, the two cache invalidations and the reload
exist once rather than twice. The modal loads the account-subtype taxonomy
on open: it's otherwise fetched only when the Chart of Accounts tab opens,
and reaching this modal from Home doesn't go through that tab, so the
Category dropdown would have offered nothing but "Uncategorized" until
you'd visited that tab once. On a rejected save the modal stays open with
its fields intact and names what failed, same reasoning as v1.45's
correction handler -- a duplicate name is fixed in the field you just
filled in.

**Invoice upload and the review queue are one tab.** Every other document
type -- Expenses, Vendor Docs, Leases, Tax Docs, Checks -- has always had
its upload form sitting directly above its own queue. Invoices were the
sole exception, split across two tabs, and v1.56 added cross-links between
them. The ask was to make switching between the two easier, and the way to
do that is to remove the switch rather than signpost it.

The upload form now sits at the top of the review tab, which is titled
"Invoices" and carries a "Review queue" heading over the list. The separate
Upload tab, its two cross-links, and the post-upload "open the review
queue" button are gone -- that button pointed at the page you were already
on. The Documents menu drops from seven entries to six, one per document
type.

Verified by running the UI, since `backend/public/` has no automated
coverage: created a revenue account with code 4200 from Home (checking the
type list, the code field, and that categories repopulate when the type
changes), confirmed a duplicate name keeps the modal open with a readable
message and the typing intact, and confirmed the merged tab renders the
upload form above the queue with no orphaned references to the removed tab.

## v1.58

Two real craft fixes found by actually rendering both surfaces (not just
reading the code) after the editorial redesign, rather than a broad
"make it look better" pass -- the redesign itself is already deliberate
and thorough (see `DESIGN.md`), so this looks for what it missed:

- **The hero's trial-balance workpaper wrapped account names on narrow
  screens.** Below ~860px of panel width (a phone, and the ~768px tablet
  width where the two-column hero layout is at its tightest), "Accounts
  Receivable" and similar names wrapped to a second line while the
  debit/credit figures stayed on the first -- a real misalignment on the
  one artifact whose whole thesis is a ledger that ties out, precisely.
  The account cell now truncates with an ellipsis instead of wrapping,
  verified at 390/640/768/834/1440px; the desktop table is pixel-identical
  since truncation never engages there.
- **The floating "Ask Rekono" widget had no shadow.** The redesign
  neutralised `--shadow-lg`/`--glass-shadow` to invisible everywhere,
  correctly, since the product is ruled rather than floated -- except this
  widget is a `position: fixed` layer that sits over arbitrary page
  content, which is exactly the "genuinely floating layer" DESIGN.md
  carves out for `--shadow-modal`. Without a shadow it read as a flat
  rectangle clipping into whatever panel happened to be underneath it
  rather than a layer above the page. It now uses `--shadow-modal`, same
  as the contact/upgrade modals.

## v1.57

New logomark, on both surfaces. The previous mark was an "R" traced from
Bitter Bold's own glyph in a blue-gradient badge; the new one is a ledger
cell with its top-right corner cut like a closed page, closed off by the
two rules a real statement ends on -- a thin one, then the heavier rule
beneath it, with the accent spent on exactly that closing rule. White
fill with an ink outline rather than a filled badge, sized (chamfer and
corner radius both scaled up from the first sketch) to hold its shape
down to a 16px browser tab.

`website/src/components/Logomark.jsx` no longer needs the per-instance
gradient-id plumbing the old mark carried (Nav and Footer both render it
on the same page at once) -- no gradient, nothing to collide. Regenerated
`favicon.svg`, `favicon-16.png`, `favicon-32.png` and `apple-touch-icon.png`
on both `backend/public/` and `website/public/` from the same source SVG
via a headless-Chromium rasterize (no image tooling installed in this
container otherwise); `website/dist/` picks up the new marks on next
build, unrelated to this commit since it's gitignored.

## v1.56

Manual payroll and the traditional special-purpose journals, plus two
smaller accounting/UI fixes -- the remainder of a checklist covering the
"Accounting" and "Website UI/Design" sections. A few items on that
checklist ("Write invoices", "Write checks", "Sales journal, purchases,
cash receipts...", per-account debit/credit normal balances, the
uploads/review-queue switch, and a full invoice search sheet sortable by
vendor) turned out to already be built, so this release covers what
wasn't:

- **Payroll.** A new Payroll tab (Accounting) records a pay run's
  already-computed numbers -- gross wages, withholding, employer taxes --
  and posts the journal entry they imply (Debit wages expense + employer
  payroll tax expense, Credit cash and payroll liabilities). Rekono
  doesn't calculate tax tables itself; that's the payroll provider's or
  spreadsheet's job. New `Employee`/`PayrollRun` models, `payroll.js` for
  the posting/void logic, and `routes/payroll.js` for the HTTP surface,
  mirroring the existing bill-payment record/void pattern.
- **The four special-purpose journals.** Sales, Purchases, Cash Receipts,
  and Cash Payments journals, as filter tabs over the Journal Entries
  view -- `GET /api/journal-entries?journal=...` filters by the
  `JournalEntry.source` values each one already carries (customer
  invoices, invoice approvals, customer payments, bill payments and
  payroll runs), rather than writing to a second ledger. "General journal"
  is what's left over once those four are carved out.
- **Chart of Accounts: a third grouping level.** Accounts were already
  grouped by type and by balance-sheet/income-statement classification;
  each account's subtype (Cash & bank, Accounts receivable, Cost of
  revenue, ...) is now its own heading within that, so "which accounts
  fit under which categories" reads directly off the page instead of
  requiring the per-row category dropdown to answer it.
- **A real "Add an account" shortcut from Home.** The dashboard's quick
  action used to only add a personal Net Worth account (no code, no
  liability/equity/revenue/expense types) instead of a real Chart of
  Accounts entry. It now jumps to Chart of Accounts and focuses the name
  field there.

## v1.55

Fixed a real-world matching miss caught while testing v1.54's Plaid sync
against a Plaid Sandbox custom test account: a "Staples Advantage
800-3333330 MA" transaction synced in, but matching it against a genuine
"Staples Advantage" invoice for the exact same amount and date only
scored 58/100 on vendor name -- a "partial" match, not the confident
"matched" it should have been.

The cause: Plaid's own transaction enrichment (`merchant_name`) had
simplified the descriptor down to just "Staples", which the sync route
preferred over the fuller raw descriptor. `routes/plaid.js` now runs the
raw descriptor through this app's own `normalizeMerchant`
(`transactionCategorization.js`, already used for card-statement
categorization) instead -- it strips the reference-number/location noise
a fuzzy match would choke on while keeping the actual brand name intact
("staples advantage" rather than "staples"), scoring far better against a
real vendor name. 4 new tests pinning this exact regression.

## v1.54

Connect a real bank account for reconciliation, via Plaid, instead of only
uploading a bank statement CSV by hand.

A new "Connected bank accounts" panel on the Matching/Reconciliation tab
lets a user link a bank through Plaid's hosted Link widget (the actual
bank-login step happens in an iframe Plaid controls -- credentials never
touch this app). On success, every account behind that login gets its own
row (name, mask, live balance) with a "Sync now" button. Syncing pulls the
last 90 days of transactions and appends them as `MatchEntry` rows on a
`MatchSource` created for that account the same way a CSV upload would --
a Plaid-connected account rides the existing matching engine rather than
needing a second reconciliation path, and shows up in the same "Uploaded
sources" list a CSV creates. Re-syncing dedupes by Plaid's own transaction
id, so clicking it again only appends what's new.

New `BankConnection` (one row per Plaid Item/login, its access token
encrypted at rest the same way QuickBooks' is) and `BankAccount` (one row
per real account under it) models. `plaid.js` wraps the Plaid SDK the same
way `quickbooks.js` wraps Intuit's API -- every network call takes an
injectable client, "expected" failures (not configured, Plaid rejected the
request, the connection needs re-authing) come back as `{ error }` rather
than throwing. Degrades the same way every other paid integration here
does: no `PLAID_CLIENT_ID`/`PLAID_SECRET` set means a clean 503 instead of
a crash. Content-Security-Policy's `script-src`/`frame-src` extended for
Plaid's own CDN and Link iframe, the one piece of this app's UI not served
by itself.

27 new tests: `plaid.test.js` exercises every Plaid API call directly
against an injected fake client (link token creation, the public-token
exchange, account/transaction fetching including pagination, the
ITEM_LOGIN_REQUIRED reconnect-needed path), `plaidRoutes.test.js` covers
the route surface (the 503 gates, org isolation, that the encrypted access
token never serializes out, connect/disconnect).

## v1.53

Two independent additions landed on this branch together: the `graphify`
knowledge-graph skill (project-scoped install plus the first
`graphify-out/` build), and a real product fix -- bills now inherit
`vendor.paymentTermsDays` as a due-date fallback the way customer
invoices already do.

**graphify**: `graphify install --project` was reviewed before committing
anything it touched -- the `PreToolUse` hooks it registers in
`.claude/settings.json` were read directly from the installed package's
source, not taken on faith (nudge-only, fails open, no network calls),
and `CLAUDE.md`'s auto-generated section was rewritten by hand since it
claimed a graph already existed. The first build followed: 2,016 nodes,
5,178 edges, 152 communities over the whole repo. Structural extraction
(AST, 1,803 nodes) needed no LLM; semantic extraction (docs, the sample
invoice PDF) ran through 3 parallel subagents since no Gemini key was
configured in this environment. Skipped the 14 favicon/icon assets from
semantic extraction -- vision passes on 16-32px brand icons add no graph
value for the cost of 14 extra subagent dispatches. The health check
flagged ~700 dangling-endpoint edges, expected for a repo-wide AST pass
(they mostly point at external library symbols never modeled as nodes)
and noted rather than hidden, per the skill's own honesty rules.

**Vendor payment terms**: `Vendor.paymentTermsDays` has carried a comment
since it was added -- "used to fill in a due date when a bill arrives
without one" -- that nothing ever actually did. Fixed in `vendors.js`'s
`attachVendorToInvoice`, the single place `ledger.js`'s
`postInvoiceApproval` resolves a bill's vendor identity for all four
approval paths: when a bill still has no due date at approval time, it's
backfilled as `invoiceDate + vendor.paymentTermsDays`, the same math
`receivables.js` already does for customers. Never overwrites a due date
the document (or a human) already supplied, and a bill with no invoice
date extracted has nothing to count days from and is left as-is.

Also fixed a date-boundary flake in `dashboardTrends.test.js` that turned
CI red on this PR, unrelated to either change above: its month-over-month
test hardcoded a fixture at noon UTC on the 1st, which lands in the
future (and gets excluded from `documents_processed.current`, which
counts through the real current instant) whenever the suite runs before
noon UTC on the 1st of the month -- as it did here.

## v1.52

Close out most of what the first Scorecard run (v1.51) flagged, for real
rather than by gaming the number.

- **Fixed the 5 open vulnerabilities.** Backend: `uuid` (pulled in
  transitively by `exceljs` and `sequelize`) was <11.1.1, vulnerable to
  GHSA-w5hq-g745-h8pq. `npm audit fix` wanted to "fix" this by downgrading
  `exceljs` and `sequelize` to years-old major versions -- instead, a
  `package.json` `overrides` entry forces `uuid` to 11.1.1 everywhere
  without touching either direct dependency. Website: `vite`/`esbuild`
  carried 4 known CVEs (GHSA-67mh-4wv8-2f99, GHSA-4w7w-66w2-5vf9,
  GHSA-fx2h-pf6j-xcff, GHSA-v6wh-96g9-6wx3); the fix only exists past the
  5.x line, so `vite` moves to ^6.4.3 and `@vitejs/plugin-react` to ^4.7.0
  (the last major compatible with vite 6). Verified: `npm audit` reports 0
  vulnerabilities in both, and the marketing site still builds clean.
- **Pinned the Docker base image by digest** rather than the floating
  `node:22-slim` tag, so two builds of the same commit can't silently pull
  different underlying images.
- **Added `.github/dependabot.yml`** covering both npm projects, the Docker
  image, and GitHub Actions, so none of this goes stale silently again.
- **Added `SECURITY.md`**, pointing at GitHub's private vulnerability
  reporting rather than an email address nobody could verify is monitored.
- **Added `.github/workflows/codeql.yml`** (CodeQL SAST) and
  **`.github/workflows/ci.yml`** (the backend test suite plus a marketing
  site build check) -- this repo had no CI test workflow at all before
  this, only Vercel's deploy check. The CI job installs the same
  `tesseract-ocr`/`poppler-utils` packages the Dockerfile does, so the OCR
  pipeline tests that need `pdftoppm` actually pass instead of failing on
  a runner that doesn't have it.

Left alone, deliberately: GitHub Actions themselves aren't pinned by commit
SHA (this session's GitHub access is scoped to this repo only, so there was
no way to verify the real SHAs behind `actions/checkout@v4` etc. without
guessing -- Dependabot's `github-actions` ecosystem entry will track them
going forward instead). Branch protection on `main` and enabling GitHub's
private vulnerability reporting both need repo Settings access this session
doesn't have either -- both are one-time manual steps, not code.

## v1.51

Add the OpenSSF Scorecard GitHub Action (`.github/workflows/scorecard.yml`),
run weekly and on push to `main`. Publishes results to the public
Scorecard API (`api.securityscorecards.dev`) -- safe to do here since the
repo is already public, and it's the only way a criticality score shows up
in the dataset some maintainer-eligibility criteria (e.g. Claude for OSS's
"critical infrastructure" bar) check against.

## v1.50

Add check writing. "Record payment" on the Bill Payments tab has always
posted a real AP payment, but there was no check number, payee, or memo
anywhere in that flow, and the only `Check` entity in the codebase was
scan-only (OCR upload of a check someone else wrote). `models/WrittenCheck.js`
is a check the org writes itself: check number, payee, memo, a printable
layout with the amount spelled out in words -- posted through the exact
same `recordBillPayment` path "Record payment" already uses, so writing a
check has the identical ledger effect (same validation: an approved bill,
a valid non-AP/AR payment account, no overpay). Voiding one reverses the
payment (a real reversing entry, same as every other void in this ledger)
and destroys the payment row alongside the check record -- matching
routes/payables.js's own payment-removal route, which does both, not just
the reversal.

Deliberately its own table rather than a flag on `Check`: that model's
routes all assume an uploaded file and an OCR status machine (upload,
extract, review, approve/reject), neither of which exists for a check
nobody scanned. Reusing it would have meant auditing every one of those
routes for a case they were never written to handle.

## v1.49

Add a tracked fixed-asset record. Straight-line depreciation used to be a
one-shot calculator (`POST /api/recurring-entries/depreciation`) that built
a monthly RecurringEntry template and then discarded the cost/salvage/
useful-life/acquisition-date inputs that produced it -- nothing recorded
that the asset existed, or how much of its life was left, and there was no
UI for it at all. `models/FixedAsset.js` is the record that was missing: a
FixedAsset owns exactly one RecurringEntry (the same schedule-and-post
machinery every other adjusting entry uses -- nothing new was built for
posting), and ties back to the actual chart-of-accounts row carrying the
asset's cost rather than being a bare number.

Two things worth calling out. First, accumulated depreciation on the Fixed
Assets list is computed from what's *actually posted* to the ledger, not
from schedule math -- running due entries is a separate, deliberate action
(same as every other recurring entry), so a schedule-projected figure would
claim depreciation that hasn't happened yet. Second, this closes a latent
gap in `closeAutomation.js`'s undepreciated-asset suggestion: it checked
whether any recurring template's lines touched the asset account itself,
which a real depreciation entry never does (only Depreciation Expense and
Accumulated Depreciation move) -- so the suggestion would have kept nagging
about an asset forever, even with a correct schedule running against it.
It now also checks for a FixedAsset tied to the account directly.

Replaces the old one-shot endpoint outright rather than keeping both --
it had no frontend caller and existed only as an internal calculator.

## v1.48

Give the chart of accounts a real sub-category taxonomy. `Account.subtype`
was a free string with no picker anywhere in the UI -- the create-account
form only collected name/type/code, and `models/Account.js`'s own comment
called statement classification (current vs. fixed assets, and so on) "a
later phase's concern, not enforced yet." This is that phase, added as a
label-and-classify layer rather than a DB enum: `accountTaxonomy.js` defines
a canonical subtype list per account type (built from the subtype strings
already scattered across ledger.js/equity.js/incomeTax.js/
revenueRecognition.js/stockCompensation.js, plus new ones -- `fixed_asset`,
`current_asset`, `long_term_liability` -- for the gaps none of those filled),
served at `GET /api/accounts/subtypes` and surfaced on every account as
`subtype_label`/`classification`. An account with an unrecognized subtype
(hand-typed before this existed, or created on demand by equity.js) still
gets a label -- its own raw string -- rather than being rejected, so nothing
that already has data breaks.

The Chart of Accounts UI gets a Category column (a picker, populated from
the new endpoint, editable per row) and a second-level heading within each
balance-sheet type -- Current / Fixed / Long-term -- computed client-side
from `classification` rather than relied on from server order, since
ledger.js's liquidity ranking only ranks a handful of subtypes and leaves
the rest in code order.

## v1.47

Commit and PR creation no longer wait for a per-task go-ahead. Added a
standing authorization to `CLAUDE.md`'s shipping section: once a change is
verified, commit and open the PR following the existing rebase-then-push
workflow without asking first. Destructive or irreversible git operations
(force-push over someone else's history, merging, deleting a branch) are
carved out and still need a person's sign-off.

## v1.46

Fix the repo's LICENSE, which contradicted its own package.json. The root
`LICENSE` file was BSD 2-Clause -- a permissive open-source grant -- while
`backend/package.json` declared `"license": "UNLICENSED"`, npm's convention
for "proprietary, no rights granted." Rekono is closed-source commercial
software, so the BSD text was the wrong one: replaced it with an
all-rights-reserved proprietary notice, and added the matching
`"license": "UNLICENSED"` field to `website/package.json`, which had none.

## v1.45

Scan checks and apply them to the bills they pay, and close two gaps in
document reading along the way. One squash covering three changes that
landed together: a contributor's first PR to this codebase.

**Read more PO and invoice-number label variants, on top of v1.44's fix.**
v1.44 taught the heuristic extractor to recognize `Purchase Order` spelled
out and to skip a vendor's own `PO Box` return address. This goes further:
`Order No.`, `Your Order #`, `Customer PO`, and `Order Reference` are all
purchase-order labels real invoices use, and none of them matched. Bare
`Order` is too common a word to accept on a label alone, so it requires an
explicit marker after it (`Order No.`, `Order #`) -- which is how it's
printed when it does name a PO -- and a captured value must contain a
digit, which is what keeps a `Purchase Order Terms` heading from extracting
`Terms`. The invoice number gained `Invoice ID`/`Invoice Ref` as labels,
and `/` in its character class: an invoice numbered `2026/0007` was being
truncated to `2026`, which every other invoice that vendor sent in 2026
also truncates to, and duplicate detection matches on vendor plus invoice
number. On the LLM path, both fields now carry a description naming the
label variants and naming the other field as what it is *not* -- a model
reading a document with two similar-looking numbers doesn't fail by being
unable to read them, it fails by spending one on the other's field and
leaving that one blank.

**Say when a correction doesn't save, instead of silently wiping the
form.** `saveCorrections` never checked whether the `PATCH` succeeded. It
handed the response body straight to `renderDetail`, and on a rejected save
that body is an error, not an invoice -- so every field read back
`undefined`, `escapeHtml` rendered each one as `""`, and the review form
redrew completely blank with no message anywhere. What that looks like from
the outside is the fields refusing to accept input: fill in the invoice
number and the PO reference, save, and both are empty again, with nothing
on screen saying why -- and the typing wasn't only erased, it was never
stored, since the correction route validates the whole payload at once and
one field over its limit takes the rest down with it. The handler now
checks `res.ok`, reports the failure, and returns *before* `renderDetail` --
leaving the DOM untouched keeps the user's typing on screen instead of
forcing a re-entry from the document. `errorText` renders a zod issue array
as "Terms: string must contain at most 64 characters" instead of the
`[object Object]` a bare `body.detail || "..."` produced on a 422. The same
unchecked pattern was in `approveInvoice`, `rejectInvoice`, `selectInvoice`,
and the processing poll -- four more places that could blank the panel the
same silent way.

**Scan checks and apply them to the bills they pay.** A sixth document
pipeline, same shape as the five before it (upload → OCR → LLM/heuristic
extraction → confidence-gated review), with a second half none of the
others have. A lease or a tax form gets filed. A check gets *applied*:
`POST /api/checks/:id/link` records a real `BillPayment` and posts a real
journal entry, Debit Accounts Payable / Credit whatever the money left
from. That posting goes through `accountsPayable.js`'s `recordBillPayment`
rather than writing a payment of its own -- the same function the manual
payments screen and the QuickBooks bank-match confirmation call, which
already refuses to relieve a payable that never posted and already unwinds
its own row when the ledger rejects the entry. A check arriving by camera
instead of by keyboard is not a reason for the money to reach the books
down a second road that has to be kept in step by hand.

Three decisions are specific to this document type. **The MICR line is
narrowed to four digits and the routing number is not stored at all** --
that pair is the whole of what someone needs to draft an ACH debit against
the account, narrowed at the same three points the tax module narrows a
TIN: extraction, the correction route (no `maxlength`, since a 4-character
cap keeps the *first* four digits), and the raw OCR text before it's
persisted. **The payment is dated from the check, not from the scan** -- a
check written on the 28th and photographed on the 3rd belongs in the month
it was written, and using the upload date would move real money across a
period boundary quietly. **Suggestions score against the outstanding
balance, not the bill's face value** -- a $500 check against a $2,000 bill
with $1,500 already paid is an exact match, and fully paid bills drop out
of the list rather than being offered and then refused as an overpayment.
The scoring reuses `matching.js`'s `scorePair` (now exported) so the amount
tolerance and date window stay one configuration rather than two that
drift.

Linking is the only way a check reaches `approved`, so the status can never
claim a payment that isn't on the books. Once linked it can't be corrected,
re-extracted, or deleted -- its fields are what the posted payment was
based on. Unlinking reverses the journal entry (both halves stay on the
books and cancel, same as every other correction in this ledger) and sends
the check back to `needs_review` rather than to `extracted`: a link that
had to be undone is evidence something was misread.

## v1.44

The heuristic PO-reference extractor recognized the abbreviation and
nothing else.

`PO Number: 4471` matched; `Purchase Order Number: 4471` -- spelled out in
full, which real invoices do just as often -- silently came back empty.
Only the no-LLM fallback path was affected (the LLM path already
understands either phrasing from context), which is exactly the path a
fresh local install with no API key, or CI, exercises by default.

Added as a second alternative on the same regex rather than loosening the
first: the spelled-out form still requires a `:`, `-`, `#`, "No.", or
"Number" right after it, so "the purchase order was approved..." in body
prose can't turn into a false match. `(?!\s*box)` came along for the same
reason -- a vendor's own "PO Box 5000" return address matches the original
pattern's shape exactly, and nothing was excluding it.

## v1.43

Early-payment discount terms on vendors, surfaced on AP Aging.

A vendor offering "2/10 net 30" -- 2% off if paid within 10 days of the
invoice, full amount due in 30 -- had nowhere to record that: `Vendor`
carried net terms and nothing else. It now also carries
`earlyPayDiscountPct` and `earlyPayDiscountDays`, and the AP Aging report
computes, per vendor and in total, what's still available to save and the
date the window closes -- money a controller would otherwise leave on the
table simply because nothing was watching for it.

- **Anchored to the invoice date, not the due date.** That's what the
  terms actually count from. The two are deliberately independent: a bill
  can be squarely "current" in the aging sense, due date weeks out, while
  its discount window already closed.
- **Computed off the outstanding balance, not the original total.** A
  partial payment already made isn't eligible for a discount on money
  that's already gone.
- **Nullable columns, no default** -- same reasoning as every column added
  to an existing table since this app's schema-drift incidents (see
  `Invoice.quickbooksBillId`): a NOT NULL default fails to add against a
  `vendors` table that already has rows, on Postgres's 23502. Null on
  either field means no discount is offered; the aging computation treats
  that exactly like an explicit zero, so there's nothing to keep in sync.
- `buildVendorResolver` now carries a resolved vendor's own fields
  alongside its identity instead of just `{key, vendorId, name}` -- the
  first caller (AP Aging's discount calculation) that needed more than a
  name, so re-querying `Vendor` a second time wasn't worth it.

No new column on `Invoice`, no new journal entries: this is a read-time
report enhancement over data the ledger already has, same shape as the
rest of AP Aging.

## v1.42

Point the OpenAI-dialect adapter at any endpoint, not just OpenRouter.

Nothing in that adapter was ever OpenRouter-specific past two attribution
headers -- it is a plain `POST /chat/completions` with a bearer token, and
the URL was a module constant. `OPENAI_COMPATIBLE_BASE_URL` makes it a
config value, so a self-hosted gateway (LiteLLM, OmniRoute), a local
runtime (vLLM, Ollama, llama.cpp) or an Azure deployment is a line in the
environment rather than a third provider branch in `llm.js`. Everything
else about that path is unchanged: `OPENROUTER_MODEL` still names the
model, and it still has to support tool calling.

Two details that only show up once the endpoint isn't OpenRouter:

- The URL is built per call rather than captured at import, so a changed
  base URL takes effect instead of whichever value the first import saw.
- Errors name the host they actually came from. "OpenRouter request
  failed" against a box on localhost sends whoever reads the log to the
  wrong place entirely.

Verified end to end against a real OmniRoute instance on `127.0.0.1:20128`:
`scripts/check-llm.mjs` built the request, the gateway answered in OpenAI
dialect, and the failure surfaced as `127.0.0.1:20128 request failed: No
active credentials for provider: openai` -- the whole path minus a
provider key.

**README gains a "Self-hosted gateways: read this first" note**, because
that experiment turned up something worth writing down. A gateway
terminates your provider credentials and sees every prompt, which for this
app means invoice contents. The specific trap: the OmniRoute npm package
ships a committed `.env` whose `JWT_SECRET` (dashboard session signing) and
`API_KEY_SECRET` (documented in that same file as encrypting provider keys
at rest) are byte-identical in every install, and a default `npm i` plus
`omniroute serve` does not rotate them -- it generates a fresh
`STORAGE_ENCRYPTION_KEY` and leaves those two alone. It binds localhost by
default, which contains it; exposing the port would not. That is a
property of one gateway at one version, so the note asks the general
question instead: does it ship fixed secrets, what does it bind, and where
does an unrouted request go?

Nothing here adopts a gateway. It makes using one a config change, and
says what to check first.

## v1.41

Remodel both surfaces, and give the product the width it was already
drawing at.

**The product had a 760px cap on `.panel`.** That is the wrong thing to
measure. It kept forms readable, which was its job, but it also meant every
page that is a stack of panels -- Settings, Close, Export, Team -- drew a
narrow strip down the left of a 1400px window with 560px of blank paper
beside it. Wide margins are not the same thing as room; that reads as an
unfinished layout, which is what "make everything more spread out" was
actually pointing at.

The cap moved off the panel and onto the panel's *contents*. A field column
still stops at 760px, because a text input that spans thirteen hundred
pixels is unusable and prose that does is unreadable. Everything else --
tables, schedules, checklists -- takes the page. Pages that are a stack of
independent panels lay them out two-up (`.panel-columns`) instead of
leaving the second column empty.

The rest of the product pass is the same idea applied a step down:

- **The `--sp-*` scale now exists in the product stylesheet**, not only the
  marketing one. It was defined in DESIGN.md for both surfaces and
  implemented on one, so the product's spacing was hand-picked rem values
  that had drifted from the document -- 0.55rem gaps under a heading that
  says 24px. Every layout rule touched here reads a named step.
- **Form labels had no gap at all.** The only rule was the flex row on
  `<form>`, so Settings read as "Full nameAlex Rivera" in one visual run.
  Labels stay beside their fields rather than above them, because several
  of them are sentences with the control set into them ("Flag anything
  below `[80]`% confidence") and stacking breaks each text run onto its own
  line.
- **The review queue's list was the narrow half of the split.** At 1fr
  against the detail pane's 1.3fr it got 560px, which wrapped almost every
  real company name onto two lines and pushed the status badge onto the
  confidence column. The ratio inverts, and vendor gets a fixed share of
  the table instead of the remainder after three fixed-width columns.
- **An income statement is one schedule, not four tables.** Each `<table>`
  was sizing its own columns from its own content, so the account names
  started at a different x in the revenue section than in cost of revenue,
  and the amount column stepped left and right down the page. `.report`
  fixes the code and amount columns as a share of the table.
- **The dashboard's side column could not hold a filename and its badge on
  one line**, so `NEEDS_REVIEW` overflowed the panel and sat on the rule.
  300px, and the filename gets `min-width: 0` so its ellipsis actually
  engages.

On the **marketing site**, the recurring problem was a layout whose columns
were not all carrying something. The five-stage schedule ran
`[number][prose capped at 54ch][tag]` inside a 1fr twice that wide, so
every row had a 400px hole in the middle and the mono tag hung alone at the
far right. Title and tag now share a spine and the prose takes the rest of
the measure. Section heads set their heading and lede side by side on the
baseline instead of stacking two short paragraphs down the left edge. The
FAQ's heading column is sticky, so the space beside eight accordion rows
is the section head rather than blank paper.

## v1.40

Organize the chart of accounts, and the navigation.

**The chart of accounts is grouped by category and ordered within each
one**, by two different rules, because the two statements are read
differently.

Balance sheet accounts (asset, liability, equity) sort by **liquidity**:
how soon the thing turns into cash, or how soon the obligation comes due.
Cash, then receivables, then everything else. That is the order every
balance sheet in the world is printed in, and it is why the traditional
1000/1100/1500 numbering exists at all -- the codes encode the liquidity
order. Sorting by code alone gets it right only for an org that follows the
convention; ranking by subtype first gets it right for an org that doesn't,
and falls back to the code within each rank.

Income statement accounts (revenue, expense) sort by **the order they were
added**. There is no natural ordering for them -- one expense is not
"sooner" than another -- so the honest order is the one the user built.
Cost of revenue leads and income tax trails, because the statement
subtotals in that order.

Two smaller things fell out of it. Codes now compare **numerically**, so
"900" sorts before "1100" instead of after it the way a string compare had
it. And an account with no code sorts after the ones that have codes: a
coded account is part of a deliberate structure, an uncoded one was added
in a hurry.

The Type column is gone from the table, since it repeated on every row what
the heading above it already said.

**Every account picker is grouped too**, via `<optgroup>`, using the same
ordering. Forty accounts in one flat `<select>` is a wall of text, and the
type of the account you want is the first thing you know about it. All
seven pickers now go through one helper, so the Chart of Accounts page and
a dropdown can't disagree about the order.

**The top bar menus have section headings.** Accounting held eight
destinations spanning three different jobs -- the ledger, the statements
that are views over it, and the equity registers that are a separate book --
in one undifferentiated column. It is now Ledger / Statements / Equity.
Workflow splits into Review / Month end, Documents into its action and its
queues. Labels rather than bare dividers: a rule alone says "these are
separate" without saying what either group is.

**Upload and the review queue link to each other.** Finishing an upload now
offers the review queue directly instead of leaving the only route there as
reopening a menu, and the queue offers the way back.

One bug found on the way, worth recording because the existing suite caught
it and no amount of reading the diff would have. Adding shipping, discount
and payment terms to the invoice field map in v1.39 also added them to the
quick-review queue, which reads a *missing* confidence entry as zero. So
every invoice grew three extra review rows for charges that were never on
the document, and a reviewer would have been asked to confirm a shipping
amount on an invoice with no shipping line. Optional fields are now skipped
when they are both absent and empty. Absent and empty means absent.

## v1.39

*Landed in the same pull request as v1.40, so `git log` on `main` shows one
squash commit for the two. They are separate entries here because they are
separate changes: this one is about what an invoice says, the next is about
how the chart of accounts is arranged.*

Everything between the subtotal and the total.

The extraction schema went subtotal, tax, total, with nothing in between.
So `confidence.js`'s cross-check computed `subtotal + tax` and compared it
to the stated total -- and **every invoice carrying a shipping line failed
its own cross-check**, had its confidence dragged down for it, and landed
in the review queue captioned "the numbers don't add up" against a document
that added up perfectly. The failure was the checker's, not the invoice's.

What the schema now carries:

- **Shipping** and **discount** as their own fields. They are the two that
  recur on most invoices, and a discount needs to be identifiable on its own
  to be stated as a percentage of the subtotal.
- **Other charges** as a labelled list -- handling, service charge,
  surcharge, deposit applied, "Fuel adjustment". The set is genuinely open,
  and a charge the schema cannot name is a charge the cross-check cannot
  reconcile. Signed, so a credit is negative.
- **Payment terms** as printed: "2/10 n/30", "Net 30", "Due on receipt".
  Deliberately not parsed into a discount rate and a due date -- the notation
  has real regional variation, and inventing a due date from a misread term
  is how a bill gets paid late. It is shown so a human can act on it.

The cross-check is now `subtotal + charges - discount + tax = total`, and
when it fails it names what it counted (`Subtotal (100) + adjustments (5) +
tax (8) = 113, but total is 999`) so the disagreement is debuggable from the
review queue instead of requiring the document.

**Tax and discount percentages** are derived from the figures already on the
record and shown beside their fields, never stored. A rate is a fact about
two numbers that are both already there; storing it would give it its own
chance to drift out of step with them. Null rather than zero when there is
no subtotal to divide by, so the label omits the parenthetical instead of
printing a confident "0.0%".

**Whether the bill has been paid** now appears on the invoice, from the
payments actually recorded against it rather than from a status flag that
would have to be kept in step with them. "Partially paid" is its own state:
a bill with one of three instalments against it is neither paid nor unpaid,
and collapsing it into either is how somebody pays it twice.

Three quieter fixes that were the same bug wearing different hats:

- **The heuristic (no-LLM) extractor reads the new lines too.** Fixing the
  cross-check only for the LLM path would leave an org running without an
  API key still failing its own extractions. Shipping and discount are read
  the way tax already was -- last non-percentage figure on the line -- so
  "Discount 10% $45.00" yields 45, not 10.
- **A correction now re-scores the invoice.** The PATCH route never re-ran
  the cross-check, so a reviewer who supplied the missing shipping amount
  still saw the old failure on screen. Same complaint, different place.
- **Quick review was building its own scoring input** and would have omitted
  the new fields, re-introducing the false failure the moment anyone used
  it. Both routes now share one `scoringFieldsFor`.

`other_charges` is excluded from quick review on purpose: that flow is one
scalar field at a time, and a labelled list has no sensible single-value
prompt. It is corrected in the full detail view.

## v1.38

The income statement becomes multi-step, and the demo finally has books.

Two things that turned out to be one problem. The income statement already
existed -- it is the tab labelled Profit & Loss, and since v1.34 it carried
revenue, expenses, income before taxes, tax and net income. What it did not
do was separate **cost of revenue** from operating expenses, so it could
not report gross profit. And it was blank in the demo, along with every
other accounting tab, which is the more likely reason it read as missing.

**Multi-step.** The statement now walks:

    Revenue
    less  Cost of revenue        <- subtype cost_of_revenue
    =     Gross profit
    less  Operating expenses
    =     Operating income
    less  Income tax expense     <- subtype income_tax_expense
    =     Net income

Each subtotal answers a different question, which is the whole reason to
separate them: gross profit says whether the thing being sold makes money
at all, and operating income says whether the company around it does. A
single-step statement (revenue minus one lump of expenses) cannot tell
those two failures apart, and that distinction is most of what an investor
or a lender reads an income statement for.

Cost of revenue is an account **subtype**, not a new account type. It is
still an expense in every other sense: debit-normal, closes into retained
earnings, and the trial balance doesn't care. Only the statement treats it
differently, and it finds it by subtype rather than by name for the same
reason the tax line does -- an org can rename its accounts and the
arithmetic must not follow the label.

**Nothing is reclassified behind anyone's back.** An org with no account
carrying the new subtype has zero cost of revenue, so its gross profit
equals its revenue, `expenses.total` is the number it always was, and the
statement collapses back to the single-step one it had before. The UI hides
the cost-of-revenue block entirely in that case rather than showing an
empty table and a gross profit line that just repeats total revenue. That
is what makes this safe to add to live books, and it is the same
compatibility argument v1.34's tax split made.

`operating_income` and `income_before_taxes` are both in the response and
are the same figure today. They are kept apart because the moment anything
non-operating is classified (interest, FX, a one-off gain) they diverge,
and the tax provision is defined against pre-tax income specifically. The
UI draws one line and names which figure the provision is computed on,
rather than printing two identical numbers with different labels.

**The demo now seeds a ledger.** Until now `seedDemoOrg` created the
Organization directly and never called `seedDefaultChartOfAccounts`, so a
demo org had zero accounts and zero journal entries. Chart of Accounts,
Journal Entries, Trial Balance, the income statement, Balance Sheet, Cash
Flow, the aging reports, the cap table and Close all rendered blank. The
public sandbox showed the document pipelines and none of the accounting
that is now most of the product.

It now seeds six months of trading through `postJournalEntry` -- the same
single write path a real posting uses, so the demo's books are subject to
the same balance checks a customer's are. Revenue grows month over month,
cost of revenue tracks it at roughly 38% so gross margin is a number worth
looking at, receivables are collected the following month so AR and the
cash flow statement have something real, and an open close period with
half its checklist ticked means the Close tab shows a close in progress
instead of "No close period open yet".

Two gaps in that data are deliberate: a month of rent that never posted,
and a fixed asset with nothing depreciating it. Those are exactly the two
things `closeAutomation.js` looks for, so the Close tab surfaces genuine
suggestions rather than handing a visitor a clean bill of health that
teaches them nothing about what the feature does.

The tab is relabelled **Income Statement**, keeping "profit & loss" in the
description since both names are in daily use. The tab id stays
`profitandloss` -- it is in every deep link.

## v1.37

Back to Bitter and the blue palette, keeping everything else v1.36 built.

v1.36 changed two things at once: the *skin* (an oxblood-on-warm-paper
palette set in Fraunces and Geist) and the *structure* (ruled panels
instead of glass, right-aligned money columns with double-ruled totals,
one filled accent button per screen, and the spacious density that was the
actual request). Only the skin is reverted here. Bitter, IBM Plex Sans and
IBM Plex Mono are back, on `#4B86F7` over `#F4F7FD`, and every layout,
spacing and typographic-hierarchy decision from the editorial pass stays.

That split is the point worth recording: what makes a ledger read like a
workpaper is the ruled schedule, the money column you can scan for
magnitude, and the room to breathe. None of it depends on the palette.

**Three accent tokens, not two.** The blue accent is *light*, and that
changes what a flat fill can carry. Measured:

- White on `--accent` is **3.47:1** — fails AA. The old button got away
  with a white-ish look only because it was a gradient with a dark navy
  label, and flattening it exposed the problem.
- So the accent's label is now its own token, `--accent-ink` (the dark
  navy), at **4.97:1**. On `--accent-deep` — the hover — the fill is dark
  enough that the label has to flip back to white, which the rule now does
  explicitly.
- `--accent-text` is a third job again: text on a light ground. The
  palette's own `#2F6FE0` measures **4.38:1** on the page ground, just
  under the 4.5:1 bar for the label sizes it is used at, so it is one step
  darker at `#2C68D6` — visually the same blue, and clear of the bar on the
  page ground, a panel and a sunk row alike.

The lesson generalises past this palette: a *dark* accent and a *light*
accent need opposite label colours, so a design system with one accent
token has a latent contrast bug waiting for whichever direction it swaps
in. Check with a contrast calculation, not by eye — 4.38:1 and 4.82:1 look
identical.

Also cleaned up while the palette was open: several hover rules still
carried a `translateY(-1.5px)` lift paired with a shadow token v1.36
neutralised, so what actually shipped was a button that moved on hover
without lifting. Those are gone, along with the last two hardcoded radii
and two shadow tokens nothing read any more.

## v1.36

A new visual identity, applied to both surfaces.

Rekono looked like every other AI-native accounting product: cool blue-grey,
a geometric sans, translucent glass panels floating on a field of coloured
blobs, gradient buttons, generous bubble radius. That visual language says
*this will be easy*. It is the wrong promise for this product. Rekono's
actual differentiator is the opposite one: it refuses to value an option,
compute an effective tax rate, or book a tax benefit on a loss. Its
personality is *we will not guess on your behalf*. A controller is
personally accountable when a number is wrong, and trust in that job comes
from looking like the profession's own reference material, not like a
banking app.

So: **design toward the workpaper, not the wallet.**

- **Warm paper, not cool white.** `#FAF8F4` reads as document at a glance.
- **Oxblood, not blue.** Ledger binding and legal seal. Blue was Rekono's
  own colour and is the category default; nobody here owns oxblood.
- **Fraunces over Geist over Geist Mono.** An optical-sized serif for
  headings, a neutral sans with real tabular figures for everything that is
  a number, and a mono reserved for things that are *codes* rather than
  words -- account numbers, entry references, period labels. All three
  self-hosted as variable woff2, which also removed the two cross-origin
  Google Fonts requests the product made in front of first paint.
- **Hairline rules, not shadows.** A statement is ruled; it is not floated.
  The glass material and the whole elevation scale are gone. The one
  remaining shadow is on the one genuinely floating layer, a modal.
- **Money right-aligns and totals carry a double rule.** Both are real
  conventions from the printed statement, and the alignment is the single
  most legible thing you can do to a column of figures -- a left-aligned
  dollar column cannot be scanned for magnitude at all.

The Render app is also **noticeably more spread out**, which was the
explicit ask. "Spacious" is defined as three checkable floors rather than a
feeling: 52px table rows, 32px panel padding, and 96px between sections on
the marketing site. `DESIGN.md` at the repo root is now the source of truth
for all of it, and `CLAUDE.md` says to read it before any visual decision.

Two things worth knowing about how this was done:

- The old token `--paper` meant *primary text* and the new one means *page
  ground*. That collision is why the rename ran through uppercase
  placeholders rather than an ordered find-and-replace, which would have
  silently produced dark text on a dark fill in a handful of places. One
  case still needed a human eye afterwards: the topbar wordmark is a
  `<button>`, so it inherited the filled button's new white label and went
  white-on-white until it was given an explicit `color`.
- The `--glass-*` and `--shadow-*` tokens are neutralised rather than
  deleted. Around forty selectors still ask for them; redefining the recipe
  turned every translucent panel opaque in one edit instead of forty, and
  kept the diff readable.

Also: `--accent` and `--accent-text` are separate tokens on purpose. A fill
sits against the page ground and a label sits against a panel, and
lightening a single accent token for a dark theme turns the primary button
a washed-out pink that reads as *disabled*. The dark palette is specified
in `DESIGN.md` but deliberately not wired yet -- the product stylesheet
still holds semi-transparent literals that assume a light ground, so a
token-only dark block would render half-converted.

The marketing site's copy moved with it, from "invoice extraction" to what
the product has actually become: a double-entry ledger with the AP work in
front of it. The hero's artifact is now a trial balance tying out with the
month's two close exceptions underneath it, which is the thesis of the
product in one panel.

## v1.35

Close automation: noticing what a close is missing.

The close checklist Rekono already had asks document-workflow questions --
are the invoices reviewed, is anything still extracting, is approved spend
matched. Every one of those looks at the queue. **None of them looks at the
ledger**, so the failure that actually matters at month-end went unnoticed:
the month where rent simply never got posted. That is the gap the README
has called "the remaining AI-shaped piece" for several releases.

Two suggestions, both derived from what the books already say rather than
from anything the user had to configure:

- **An expense that posts every month and didn't.** Three of the last four
  months is the bar. Not four of four: an expense that skipped one month
  earlier in the window is still plainly monthly, and demanding a perfect
  run would silence exactly the accounts most worth watching. Not two of
  four either -- that is a coincidence, not a pattern.
- **A fixed asset with nothing depreciating it.** Reported with the
  arithmetic already done, so accepting it is one step rather than a
  spreadsheet.

Details that matter more than they look:

- **Expenses only.** A revenue account with nothing in it is a slow month,
  which is a business fact and not a bookkeeping omission. Assets and
  liabilities move irregularly by nature. Rent, payroll, software,
  insurance -- the things that recur and get forgotten -- are all expenses.
- **The median, not the mean.** A double payment in one month would drag a
  mean and misstate what you should expect; the median is the whole reason
  to collect the amounts rather than just count the months.
- **No double-reporting.** An expense already due on a recurring template
  is surfaced by the recurring-entries preview, which can also *post* it.
  Reporting the same rent through two mechanisms would have someone
  chasing one problem across two screens.
- **Depreciation is a question, not an assertion.** Land is never
  depreciated, an asset bought this month may not be in service, and a
  deposit in an asset account isn't a fixed asset at all. Cash and
  receivables are never suggested; an asset a recurring template already
  posts against is left alone.
- **Nothing posts and nothing blocks.** `routes/close.js` is right that a
  close is a human attestation and there are legitimate reasons to sign off
  with a known exception. The job is making sure the exception is one
  somebody saw.

The last point is what running the UI caught, and it was the real find of
this release. The close banner's "Everything checks out" state is computed
from the readiness checks alone, so it sat directly above a list saying
rent was missing and equipment wasn't depreciated. That is precisely how
somebody signs off on a month with a hole in it. The banner now reads
"Checks all pass, with suggestions below" and names the count, while
staying non-blocking.

Also caught before it shipped: the missing-expense suggestion linked to a
`journal` tab, which does not exist -- the tab is `journalentries`. A dead
button, found by checking the link target against the actual tab list
rather than trusting the string.

## v1.34

The income tax provision, and a P&L that finally shows pre-tax income.

The README has said for several releases that Rekono computes no tax, and
that the defensible first step is booking a provision the user supplies
rather than deriving one. This is that step, and the boundary is stated as
plainly in the UI as it is in the code:

> **This is not a tax calculation.** It multiplies pre-tax book income by
> an effective rate you provide. It knows nothing about entity type,
> apportionment, book-tax differences, deferred taxes, valuation
> allowances, credits or loss carryforwards, all of which change the real
> number. What it gives you is a provision accrued on the books, not a
> return and not advice.

Same stance v1.33 takes with grant-date fair value: book the number the
user brings, refuse to invent one. There is deliberately no default rate,
because a plausible-looking default is exactly the kind of invented number
this feature exists to avoid.

**The circularity.** A provision is a percentage of *pre-tax* income, so
the base has to exclude income tax expense itself. Computed against net
income it would feed on itself: post $10k of tax, income drops $10k, the
next run wants less tax, and it oscillates forever. `preTaxIncomeCents` is
the whole reason this module doesn't just call `computeProfitAndLoss`, and
a test pins it -- a second run at the same rate must post nothing.

**A loss accrues no benefit.** Booking one asserts the loss will shelter
future income: a deferred tax asset, recognizable only if you believe
you'll be profitable enough to use it, and one most companies at this stage
offset with a full valuation allowance. That judgment is not the app's to
make, so the provision floors at zero. Tax on profit, never a receivable on
a loss.

**Cumulative-to-date, with true-ups**, because that is how a real provision
behaves quarter to quarter: you recompute the full-year expectation and
post the difference. Raising the rate posts the increment. A quarter where
income *fell* posts a negative increment, which is correct rather than an
error to suppress -- and like the stock-comp reversal it posts as a genuine
credit to expense with the lines flipped, since the ledger has no signed
values.

Accruing is Debit Income Tax Expense / Credit Income Taxes Payable and
moves no cash. Paying is a separate event that settles the liability and
touches neither the P&L nor equity, since the expense was recognized at
accrual. Overpaying what's accrued is refused, as is paying Income Taxes
Payable out of itself.

**The P&L now presents tax properly** -- revenue, operating expenses,
income before income taxes, income tax expense, net income. That is not
cosmetic: a statement that buries tax inside the expense total gives the
reader no way to check the number against the rate. Income tax is found by
account subtype rather than by name, so renaming the account can't break
the arithmetic. An org that has never booked a provision has zero tax, so
`net_income` still equals `income_before_taxes` and nothing about the old
shape moves.

Running the UI caught two things again. The Preview button sat between the
hint and the submit, crowding the footer's right edge where the floating
assistant widget lives; previewing live on change is fewer controls and
better anyway, since the point is to see what a rate produces before
committing. And "accrued and unpaid" didn't say *as of when* -- a payment
dated after the as-of date correctly doesn't count against it, which
without the date on the label reads exactly like a bug.

## v1.33

Stock compensation expense (ASC 718) -- the gap v1.31's own changelog
named and declined to fill.

v1.31 tracks what an option grant does to *ownership*. This is what it does
to the *income statement*, and they are not the same thing: a grant is
compensation paid in equity instead of cash, and it is an expense in the
period the employee earns it even though no cash ever moves.

Rekono still does not value an option. That needs Black-Scholes inputs and
a 409A valuation of the underlying, and a wrong number flows straight into
reported net income. The grant-date fair value per share is **supplied**,
exactly the way the README says an income tax provision would be: booking
a number the user brings is defensible, deriving one is not. An award with
no fair value on file is never expensed, which is how every grant made
before this release stays out of the P&L.

**Expense recognition is not the vesting curve.** This is the thing worth
reading twice. Under a 12-month cliff nothing *vests* for a year -- but the
employee renders service the whole time, so a year of expense is
recognized. `vestedShares` answers "how many shares could they exercise",
and during a cliff the answer is zero; recognition asks "how much service
has been rendered", and the answer is twelve months' worth. Reusing the
vesting curve would defer a year of real compensation cost and then dump it
in one month.

**Forfeiture reverses expense, but only on the unvested part.** When an
award is cancelled before it vests, ASC 718-10-35-3 requires the cost
already recognized against those shares to come back off -- the company
never received the service it was paying for. Shares that had already
vested keep their expense: that service was rendered whatever happened
afterwards. Whether a share had vested is asked of `vestedShares` rather
than approximated straight-line, and those answers differ exactly where it
matters: an employee who leaves at five months against a twelve-month cliff
has vested *nothing*, so the whole grant forfeits and every cent reverses.
A straight-line approximation would say a tenth had vested and would strand
that expense on the P&L forever. That was a real bug, caught by a test.

Mechanically each month's charge is the *change* in cumulative expense
rather than a recomputed slice, which is what makes forfeiture fall out
without a special case: the month an award is cancelled, cumulative expense
drops and the delta comes out negative. A negative month posts as a genuine
credit to expense with the lines flipped, since the ledger requires every
line to be a debit or a credit and never a signed value. Runs are
idempotent on the period month, the same way revenue recognition is.

The entry is Debit Stock Compensation Expense / Credit Additional Paid-In
Capital. No cash moves, and the two sides cancel within equity -- the cost
moves value from retained earnings to paid-in capital and total equity is
unchanged, which is exactly what a non-cash equity-settled expense should
do.

Two things running the UI caught that the tests did not:

- **A forfeited award reported a rising vested count forever.**
  `summarizeAward` computed vested purely from the date, so an employee who
  left two years ago went on visibly earning equity. Capped at what
  survives cancellation, with tests.
- **The expense schedule was unbounded** -- one row per month since the
  first grant, so a four-year plan is 48 near-identical rows and the months
  still needing to be posted get buried under three years of "Posted".
  Everything unposted is now always shown, the posted tail is capped, and
  the count of folded-away months is stated.

Also corrects v1.32, which claimed the ruflo plugin path "writes nothing
into the repo". It doesn't write at install time, but it writes the moment
its hooks fire or any `ruflo` command runs -- `.claude-flow/` at the root, a
proven-config pair under `.claude/`, and a `.claude/security-scans/`
directory created inside whatever tree `ruflo security scan` is pointed at,
which in our case was `backend/src/`. All of it is local tooling state that
regenerates on demand, so it is gitignored rather than committed.

## v1.32

Installs ruflo (github.com/ruvnet/ruflo) from the SessionStart hook, so it
survives the container swap between sessions the same way gstack does.

Tooling only -- no application code changes, and the plugin writes nothing
into the repo.

The part worth recording is the ordering, because it is not obvious and it
is expensive to get wrong. `ruflo-core` registers PreToolUse and PostToolUse
hooks that fire on **every** Bash, Write and Edit. Those hooks prefer a
locally installed `ruflo` binary and fall back to `npx` when there isn't
one, and on this image that fallback measures ~6s per tool call against
~450ms with the CLI present -- 27s on a cold npx cache. Over the few hundred
tool calls in a working session that is the difference between a tolerable
tax and roughly ten minutes of dead time, spent on hooks that without the
CLI write telemetry into a `.claude-flow/` store that doesn't exist. So the
hook installs the CLI *before* enabling the plugin, and the comment there
says why so nobody later "simplifies" it by dropping the install.

Two things checked before wiring this in, both because this is a private
codebase: the hook manifest advertises that "telemetry runs in both paths",
which turns out to be local -- the hook script makes no HTTP calls, and the
outbound URLs in the CLI package are documentation links from bundled
dependencies. And the whole thing is MIT with no paid tier; API keys are
optional and only for routing to non-Claude models.

Costs, so the trade is on the record: ~1.8GB of disk, about a minute added
to a cold session start, and ~450ms on every Bash/Write/Edit thereafter.
`claude plugin disable ruflo-core@ruflo` turns the per-call cost off without
unpicking the hook.

## v1.31

The option pool, and the fully-diluted ownership that falls out of it.

v1.30's register answers "who owns what" in issued shares. That is the
wrong denominator for almost every question a founder or an investor
actually asks: a company with a 15% option pool does not own the
percentages its register shows. Fully diluted is the number on the term
sheet, and the gap between the two is this release.

Three things sit in that gap -- granted awards that haven't been exercised,
the unallocated reserve nobody has been promised yet, and exercised awards
that are already real stock. The middle one is the one people leave out,
and it is the one that gets negotiated: an unallocated pool dilutes the
existing holders and nobody else, which is the whole substance of the
"pool shuffle" argument in a priced round. It is counted, and it gets its
own row rather than being assigned to a person.

- **A plan is a board reserve, not stock.** Nothing moves in the register
  when a plan is created or when a grant is made from it. Shares become
  real only on exercise. That is not a simplification -- it is the
  definition, and it is why outstanding and fully diluted differ at all.
- **Vesting is computed, never stored.** A row per vesting month would be
  a copy of what one function knows exactly, and rows for months that
  haven't happened are claims about the future -- the same argument
  `recurringEntries.js` makes for keeping a template instead of pre-writing
  entries. Months are counted by anniversary with the same clamping the
  recurring schedule uses, so a vesting start on the 31st has its February
  anniversary on the 28th; the rounding remainder lands on the final month,
  so a grant finishes at exactly the number of shares it was for.
- **Cancelled shares return to the pool; exercised ones don't.** Exercised
  shares left it permanently the moment they became real stock and are
  counted by the register from then on. Counting them in both places is
  the double-count the arithmetic exists to avoid.
- **Options, RSUs and warrants are one table**, because they dilute
  identically. What differs is tax treatment, which Rekono deliberately
  doesn't compute. An RSU is refused a strike price rather than being
  allowed to carry a number that means nothing.
- **Events can't be dated in the future.** Every gate here is evaluated at
  the event's own date, so without this rule a grant that had barely
  started could be exercised in full by typing a date four years out. The
  share register deliberately has no equivalent rule: a transfer between
  two shareholders has no time-based gate to bypass. The asymmetry is the
  point.

**Exercising posts.** This is the part the browser caught and the tests
did not. An exercise issues stock through the register's own
`recordShareTransaction`, so it inherits the authorized-capital check for
free -- but issuing stock without posting the cash paid for it left Common
Stock where it was while the register's issued count climbed, and v1.30's
tie-out immediately began reporting a difference that nothing could close.
So an exercise now also posts its own capital contribution, and the
reconciliation survives it.

Naming a cash account is optional (a historical exercise may already have
its own entry, or predate the books), but it is the **default** in the UI
rather than the opt-out: skipping it is what breaks the tie-out, and a
default that quietly does that is wrong most of the time. If the register
then refuses the issuance -- past the authorized ceiling, say -- the
contribution is voided rather than left on the books as cash raised
against shares that will never exist. An RSU has no strike price and so no
cash to post; the expense side of one is ASC 718 stock compensation, which
Rekono doesn't compute and won't guess at.

## v1.30

The share register: who owns how much of the company.

v1.29 gave an equity transaction a share count, which was enough to split
par from premium on an issuance and no more. A count on a transaction
can't answer the questions a register exists for -- how many shares are
outstanding, who holds them, what percentage each holder owns, whether the
charter's authorized limit is used up. Those are *positions*, and positions
need their own ledger.

So this is a second ledger beside the financial one, denominated in shares
instead of dollars. It is deliberately not derived from the journal: a
transfer between two shareholders moves no company money and posts nothing
at all, and it is still the most common event in a real register.
Deriving positions from dollars would miss it entirely.

- **Four kinds of movement**: issue, transfer, repurchase, reissue. `shares`
  is always positive and direction is carried by which ends name a
  shareholder, not by a signed quantity -- a signed quantity makes "who
  lost these shares" unanswerable for a transfer, which is exactly what a
  register exists to answer.
- **Issued never comes back down.** Shares bought back are still issued,
  just no longer outstanding, which is why treasury shares keep consuming
  authorized capital and why a reissue is its own type rather than a second
  issuance. Outstanding is issued minus treasury and is never stored.
- **Issuing past the authorized ceiling is refused**, not warned about --
  it's void as a matter of corporate law, not untidy data. A class with no
  stated ceiling reports null rather than zero remaining.
- **Positions are replayed in date order, not summed.** This is the part
  worth the code. A transfer dated last March can look perfectly valid
  against today's balances and still be impossible -- the holder may not
  have owned the shares yet in March, or may have sold them in April. Only
  a replay sees either case, and both have tests.
- **Share classes and shareholders are their own records**, deactivated
  rather than deleted, for the same reason Customer and Vendor are: a
  position has to stay attributable to somebody forever. Par value can't be
  edited after the fact, because every issuance already posted split par
  from premium using it.

**The tie-out.** Common Stock is credited with par value on every issuance,
so its balance divided by par is the number of shares issued -- and the
register knows that number independently. `GET
/api/share-register/reconciliation` compares the two. Issued, not
outstanding, is the right side of that equation: the cost method debits
Treasury Stock on a buyback and leaves Common Stock exactly where it was.

Where they disagree, the endpoint also names the equity transactions that
record shares with no movement on the register, which turns "you are off by
$100" into a list to go fix. Where the equation doesn't apply -- no-par
stock, where `equity.js` puts full proceeds into Common Stock, or nothing
issued yet -- it says so in words rather than reporting a difference of
zero, since "doesn't apply" and "reconciles" otherwise look identical.

A share movement can name the equity transaction that funded it, and that
link is checked rather than decorative: the equity transaction has to be
the type that pays for that kind of movement, its share count has to
agree, it can't be voided, and it can't already be claimed by another
movement. A transfer has no link at all, because no company money moves.

Unlike everything on the ledger side, a wrong share movement is **deleted
rather than voided**, and the deletion is refused if a later movement
depends on it. A journal entry is a claim about money that moved and has to
be corrected by a second entry saying so; a register entry is a claim about
who owns what, and a wrong one leaves the wrong name on the cap table. The
funding equity transaction keeps its own immutable journal entry either
way -- that's where the dollars live.

Two things the browser found that the tests could not. `input[type=number]`
was missing from the app-wide input styling, so every numeric field in the
app rendered as the browser's default pale rectangle next to dark rounded
text fields; four of them in one row on the cap table made it impossible to
miss. And share counts in refusal messages were ungrouped -- "short by
91750000" is a different reading experience from "short by 91,750,000" at
the moment someone is checking a number against a certificate.

## v1.29

Stockholders' equity: the owner-facing side of the balance sheet, and the
fourth statement. The balance sheet says equity is $X; this says why.

Every one of these postings was expressible as a raw journal entry
already. What was missing is **classification**. A credit to an equity
account tells you equity went up; it does not tell you whether that was a
capital contribution, a share issuance, or a treasury reissue -- and those
are three different lines on a statement of stockholders' equity. The type
is the thing a journal entry can't carry, so each event is now recorded
with one and posted through `ledger.js` like everything else.

- **Six typed events**: contribution, distribution, dividend declared,
  dividend paid, treasury purchase, treasury reissue.
- **Declaring and paying a dividend are separate**, because a
  declared-but-unpaid dividend is a liability the balance sheet has to
  show. Paying it moves cash and clears the liability; equity is unchanged,
  since the reduction was recognized on declaration. Counting it twice is
  the classic error here, and there's a test pinning it.
- **A contribution splits par from premium only if you give shares and a
  par value** -- par to Common Stock, the rest to Additional Paid-In
  Capital. Without them it's an unincorporated capital injection and
  credits Owner's Equity. That's driven by the transaction, not by an
  org-level "are you a corporation" flag, because the same company can do
  both. Issuing below par is refused.
- **Treasury stock uses the cost method.** A buyback is carried at what was
  paid; no gain or loss is ever recognized on a company's own shares, or a
  company could book profit by trading in itself. Reissuing above cost
  credits paid-in capital. Reissuing below cost charges paid-in capital
  first and only reaches retained earnings once that's exhausted --
  charging earnings first would understate accumulated profit while
  leaving APIC that exists precisely to absorb this.
- **Distributions and treasury stock are contra-equity**, carrying debit
  balances. Nothing special was needed to make them reduce equity:
  `financialStatements.js` already computes an equity account's normal
  balance as credit minus debit, so a debit-balance equity account
  subtracts on its own.
- New equity accounts (Common Stock, APIC, Treasury Stock, Distributions,
  Dividends Payable) are created **on demand** rather than seeded, since a
  sole proprietor never needs them and an empty Treasury Stock line on
  every new org's chart is clutter. Retained Earnings is reused from
  `yearEndClose.js` rather than redefined, so two modules can't race to
  create it under different codes.

**The statement is a roll-forward that ties by construction.** Beginning
and ending totals are read straight from `computeBalanceSheet` at the two
dates, so it can never disagree with the balance sheet beside it. The
movements are attributed from the typed transactions plus net income, and
whatever they don't account for lands on an explicit `other` line.

That last part is deliberate. Equity accounts are reachable by a plain
manual journal entry, so a hand-posted credit to Owner's Equity is always
possible. A statement that silently swallowed it would be wrong; one that
refused to balance would be useless. Naming it keeps the report honest and
points at the thing to go look at. It also stays correct after a formal
year-end close, which moves earnings from the derived half of equity to a
posted Retained Earnings balance -- both ends come from the balance sheet,
so the move is invisible to the roll-forward.

**Par value is carried in millionths of a dollar, not cents.** Found by
smoke-testing with a realistic figure: $0.001 par is common and $0.0001 is
the Delaware default, and both round to *zero* cents. Converting per-share
par to cents before multiplying by the share count destroyed the par
entirely and emitted a zero-value journal line, which the ledger rejects
outright -- so a normal seed round failed with a confusing error about
lines being neither debit nor credit. Multiplying first and rounding once
fixes it. Where par is genuinely too small to register across the whole
issuance, no-par treatment applies and everything goes to Common Stock
rather than posting a zero line.

The statement's period is now labelled above the table, because the
transactions list below it is not period-filtered -- without the label, a
transaction dated outside the window read as one the statement had
forgotten.

## v1.28

Moved what a session keeps re-deriving into `CLAUDE.md`, which loads
automatically, from `README.md`, which has to be read.

The two files had drifted into the wrong proportions: `CLAUDE.md` was 427
tokens and carried only versioning and the test command, while `README.md`
is 29k tokens and gets read in pieces on nearly every task. The fix is not
more documentation -- it is putting the high-frequency facts in the file
that is already free.

What moved in is what actually got re-derived, not what seemed useful:

- **The module map.** Which file owns the ledger, the statements, AR, AP,
  vendors, revenue recognition, adjusting entries, closing entries.
- **The settled accounting decisions** -- integer cents, immutable posted
  entries, `postJournalEntry` as the only ledger write path, why statements
  must not filter to `status: "posted"`, why derived and posted retained
  earnings don't double-count, and the `withSamples` scope. These are the
  ones where the code looks wrong and isn't, so re-deriving them costs a
  full investigation each time.
- **The feature-wiring checklist**: model, `models/index.js`, `rls.js`,
  journal entry source, route, `app.js`, tests. Eight releases (v1.20
  through v1.27) each re-derived this.
- **The shipping sequence.** The first push is rejected and the first merge
  attempt 405s, every time; writing down that both are expected saves
  treating them as problems.
- **Two traps that produced wrong conclusions rather than errors.** The
  local server reads `DATABASE_URL`, not `REKONO_DB_URL` -- the wrong name
  falls back to the default database, which is how a phantom "onboarding
  seeds twice" bug got reported (it was two orgs sharing one file). And two
  concurrent `jest` runs share one SQLite test database, so `resetDb` in
  one drops tables the other is mid-query on; the failures read as real
  bugs and aren't.
- **A note to actually run the UI.** Several shipped fixes were invisible
  to a passing suite and obvious on screen: a form spilling out of its
  panel, a control pushed off the page, an aging report that didn't tie to
  the balance sheet because tests never seed sample data.

Net cost is about 1,940 tokens per session, roughly 0.2% of the context
window, against work that repeatedly cost far more than that to redo.

## v1.27

Adjusting entries and year-end closing entries -- the two things a close
actually consists of, and the pair Rekono was missing. Closing a month
locked the period and ticked a checklist, but posted nothing: the "closed"
books were missing exactly the depreciation and accruals a close exists to
record.

- **Recurring entries** are a template plus a schedule (monthly, quarterly,
  annually): depreciation, prepaid amortization, accrued interest, accrued
  wages, rent. Deliberately not a queue of future-dated entries -- an entry
  that exists before its period would show up in a trial balance run today,
  and books containing next quarter's depreciation are wrong in a way
  nobody notices until an audit.
- **A period nobody ran stays due.** Due dates derive from the start date
  and frequency rather than from "last one plus an interval", so a skipped
  month is posted late rather than lost. A template that hits a closed
  period stops there rather than posting over the gap: books with April and
  June but no May are harder to spot than a template that visibly stopped.
- **Templates must balance at creation**, not at posting time. An
  unbalanced template is a trap -- it looks saved, then fails silently
  every month with an error nobody is watching for.
- **A month starting on the 31st clamps** to the 30th in April and the 28th
  (or 29th) in February rather than rolling into the next month, because an
  adjusting entry landing in the wrong period is the whole failure mode.
- **Straight-line depreciation** gets a helper that turns cost, salvage and
  useful life into the monthly amount and ends the template when the asset
  is fully depreciated. Declining-balance and MACRS are deliberately absent:
  they're a tax concept more than a bookkeeping one, and guessing which a
  user wants is worse than making them say so.
- **Year-end closing entries** zero revenue and expense into a Retained
  Earnings account, so a fiscal year's books are formally shut. One entry
  rather than the textbook Income Summary three-step: that intermediate
  account exists to make the arithmetic visible by hand, and in a system
  that posts atomically it adds an account that is always zero and a second
  entry that can only be a transcription of the first. Reversible.

**Closing entries and derived retained earnings coexist without
double-counting**, which is worth spelling out because it looks like it
shouldn't. Rekono derives retained earnings from cumulative revenue minus
expenses; a closing entry also credits a Retained Earnings *account*. They
don't both count, because the closing entry debits every revenue account to
zero -- so that year's contribution to the derivation becomes exactly zero
at the same instant its net income lands in the account. The earnings move
from the derived half of equity to the posted half and the total never
changes. There's a test pinning it at $6,000 either way.

The one thing that did need handling: a P&L over a closed year would
otherwise include the closing entry and report zero revenue -- the report
going blank precisely because the books were closed properly. The income
statement now excludes closing entries; the balance sheet still counts
them.

**A closed year that picks up later activity is flagged.** Found by using
it: a recurring run posted into a year that had already been closed, since
period locking is a separate mechanism. Nothing breaks -- the balance sheet
derives whatever the closing entry didn't capture, so the totals stay
right -- but "closed" no longer means the accounts stand at zero. The
year-end preview now says so and names the amount, rather than reporting
the leftover as if it were the year's income.

Detecting that also fixed a real bug in the first version, which filtered
closing entries out by source when working out what was left to close.
That reads as obviously correct and is wrong in three of four cases -- most
seriously after a reopen, since `voidJournalEntry` posts its reversal with
source `void`, so excluding only closing entries would have counted the
reversal alone and doubled the balances. Counting current balances instead
handles open, closed, stale and reopened years with no special cases.

## v1.26

Revenue recognition (ASC 606) -- the thing a subscription business cannot
run accounting without, and the reason the AR work in v1.23 came first.

Before this, sending a customer an annual invoice in January credited
twelve months of revenue into January. The P&L then showed a spike that
didn't happen and eleven months that looked dead, and neither figure was
something you could hand an investor. What's actually true on day one is
that a receivable exists and the org now *owes twelve months of service* --
a liability, not income.

- **A line with a service period credits Deferred Revenue** instead of its
  revenue account, and a monthly run releases each month's earned share as
  it's delivered. A line without one is unchanged: point-in-time delivery
  is earned when billed, so a setup fee and a subscription on the same
  invoice are each treated on their own terms.
- **Straight-line over days, not equal twelfths.** A term almost never
  starts on the 1st -- Jan 15 to Jan 14 is 17 days of the first January and
  14 of the last, and calling both "one month" overstates one end and
  understates the other. The rounding remainder lands on the final month so
  the schedule sums to the line *exactly*; rounding each month
  independently would strand a cent in deferred revenue that never clears
  and that nobody can explain a year later.
- **`RevenueScheduleEntry`** stores the plan rather than recomputing it,
  for the same reason journal entries are stored while statements are
  derived: the schedule is a document someone reconciles against, and once
  a month is recognized it carries the entry that did it. Recomputing would
  silently rewrite history the first time a rounding rule changed.
- **Recognition posts into the month it recognizes**, dated to that month's
  last day rather than the day someone ran the job -- otherwise a
  subscription's revenue smears across whichever months the operator
  happened to be at their desk. One journal entry per period, so each
  month stays a reviewable document.
- **A later run catches up every month nobody ran.** A period missed in
  March shouldn't sit in deferred revenue forever, so running April picks
  it up too. `GET /api/revenue/pending` previews exactly what would post
  before it does -- this writes into months that may already have been
  reported on, so seeing the number first is the difference between a
  review and a surprise.
- **Deferred revenue waterfall** (`GET /api/reports/deferred-revenue`):
  what's still unearned and which month each part releases in. Derived from
  the schedule rather than the ledger, because the ledger only knows what
  has already happened.
- Recognition is a normal posting, so a closed period refuses it and the
  month stays pending rather than being marked recognized against an entry
  that never posted. Voiding an invoice drops its unearned months and
  leaves the recognized ones alone -- those were really earned.
- **New Revenue Recognition tab** under Receivables, and service-period
  columns on the invoice line editor. `Deferred Revenue` (2200) joins the
  seeded chart of accounts, created on demand for orgs that predate it.

**Line-editor column widths.** Adding two date columns pushed the row's
Remove control past the panel edge at full width. The overflow container
added in v1.23 did its job -- the table scrolled rather than clipping --
but a control you have to scroll to find by default is still the wrong
default. Date and numeric inputs in a line table now get widths matched to
what they hold instead of the browser's defaults, which fits the row back
inside the panel and gives the description column the space back.

## v1.25

Vendors are a real table. AP aging used to group by normalizing the
extracted vendor name, which handles "Acme Inc." vs "  ACME Inc. " and
nothing else -- the moment the same company's name arrived genuinely
differently ("Acme Inc" one month, "Acme Incorporated" the next, which OCR
and a change of letterhead both produce), the report showed one vendor as
two and every collections decision made off it was wrong. No cleverer
normalizer fixes that, because nothing can know those two strings are one
company. The fix is a stable identity plus a way for a human to say so.

- **`Vendor`** is the AP counterpart to `Customer`, carrying payment terms,
  an email, and an identity that survives however the name is spelled next
  time. Created automatically the first time a bill naming it is approved
  -- at approval rather than at extraction, so OCR noise on a document
  nobody approves doesn't litter the vendor list.
- **`Invoice.vendorName` is untouched.** It's what the document said, and
  overwriting it with a canonical name would destroy the one thing an audit
  needs to be able to check. `Invoice.vendorId` is the resolved identity
  alongside it.
- **Merging is the point.** `POST /api/vendors/:id/merge` moves every bill
  across, carries the remembered expense-account categorization with it,
  and records the merged-away spelling as an alias so the next bill
  carrying it resolves on its own instead of recreating the duplicate. It
  is presentational only -- regrouping never moves a cent, and there's a
  test pinning that AP aging still reconciles to the balance sheet
  afterwards.
- **Retroactive by construction.** AP aging resolves identity at read time
  through vendors and aliases rather than reading a stored column, so a
  merge regroups history immediately with no invoice rewritten -- and bills
  approved before this release, which have no `vendorId` at all, still
  group by name rather than vanishing. No backfill, no migration.
- **New Vendors tab** under Payables, listing each vendor with its other
  known spellings, bill count, and outstanding balance -- the number that
  tells you whether a suspected duplicate is worth merging.

**One normalizer, shared.** `vendorAlias.js` and `vendorExpenseAccount.js`
each had their own copy of trim-and-lowercase, with comments explaining
they were separate modules precisely so the two couldn't drift. Now that
the `Vendor` table is keyed off the same fold, all three import one
implementation from `vendors.js`.

It also folds slightly more than before: repeated internal whitespace and
trailing punctuation, so "Acme Inc" and "ACME INC." are one vendor without
anyone merging them. The line is drawn at what carries no information --
case, whitespace, trailing punctuation. Anything that could conceivably
distinguish two companies (dropping "Inc"/"Ltd", edit-distance matching,
internal punctuation) stays out, because the costs are asymmetric: a missed
fold is one visible merge click, while a wrong one silently combines two
real companies and is nearly impossible to notice. Aliases and expense
accounts stored under the old fold whose keys ended in punctuation will
miss once and be relearned on the next correction.

## v1.24

Bill payments -- the other half of accounts payable, and the asymmetry
v1.23 made obvious. Approving a vendor bill has posted Debit expense /
Credit Accounts Payable since v1.20, but nothing ever relieved that
payable: AP only grew, and the balance sheet showed every bill the org had
ever approved as still owed. Paying a bill now posts Debit Accounts
Payable / Credit whatever account the money left from.

- **`BillPayment`** is the AP mirror of `CustomerPayment` -- its own table
  rather than a `paidAt` flag on the invoice, because partial payments are
  normal and each one is a dated event the cash flow statement needs. Same
  guards the AR side learned: overpayment refused, a posting the ledger
  refuses unwinds its own row, and the payment is dated to when the money
  actually moved.
- **A credit card is a valid thing to pay from.** Paying a bill with one
  swaps one liability for another rather than spending cash, and the ledger
  models that correctly, so it would be wrong to restrict this to bank
  accounts. Accounts Payable and Accounts Receivable are both refused:
  paying from AP posts Debit AP / Credit AP, which balances and moves
  nothing, and crediting AR to pay a vendor reads as a customer having
  settled their invoice.
- **You can only relieve a payable that exists.** Approving a bill is what
  credits AP, and that posting can be skipped (a bill approved into a
  closed period), so an `approved` status alone isn't proof it landed.
  Debiting AP for a bill that never credited it drives the balance negative
  against nothing. Refused, and recoverable -- re-approving re-runs the
  idempotent `postInvoiceApproval`.
- **AP aging**, the mirror of v1.23's AR aging: what's owed, bucketed by
  days past due, grouped by vendor. Vendor names are normalized for
  grouping (trimmed and case-folded, first spelling kept for display),
  which is a weaker key than AR's real `Customer` table -- noted in the
  code as the known limitation rather than papered over.
- **New Payables nav group**: Bill Payments (approved bills and what's
  still owed, with a payment action) and AP Aging. `GET /api/bills`
  backs the first, deliberately its own endpoint rather than the invoice
  list plus a payments call per row -- that shape is an N+1, and the
  invoice list serializer carries neither a due date nor any payment
  state.
- **Confirming a QuickBooks bank match now posts the payment too.** That
  loop previously closed only in QuickBooks' direction -- the bill was
  marked paid there and Accounts Payable kept it forever. Best-effort by
  design: the QuickBooks fact is true whether or not the ledger accepts the
  posting, so a refusal records a `journal_posting_skipped` audit entry
  instead of failing the match.

**AP aging counts approved sample invoices.** Found by running the UI, not
by a test: the Review Queue deliberately shows the seeded sample and lets
it be approved like any other invoice, and approving it posts to Accounts
Payable for real. `Invoice`'s default scope hides sample data, which is
right for usage metrics and wrong here -- it left the aging report
disagreeing with the balance sheet by exactly the sample's amount. Both the
report and the payments endpoints now use the `withSamples` scope, so a
sample that shows as owed can also be paid.

**CORS refusals are no longer reported as 500s.** Rejecting a disallowed
origin by passing an `Error` handed it to the generic error handler, so a
request understood perfectly and refused on policy came back as "Internal
server error" -- and a misconfigured `ALLOWED_ORIGINS` looked like a bug in
the app. The middleware now omits the CORS headers instead (which is what
actually enforces this -- the browser blocks the response), and a preflight
from a disallowed origin gets an honest 403 rather than falling through to
the SPA catch-all and returning 200 with an HTML body.

## v1.23

Accounts receivable -- customers, customer invoices, payments, and the AR
aging report. Phase 4 of the accounting pivot, and the half of the ledger
that was missing: until now Rekono could only record money going *out*.

- **Customers** are a real table rather than a name string on each invoice
  (the shape the AP side's `Invoice.vendorName` uses). A customer carries
  payment terms and a billing email that every invoice inherits, and the
  aging report groups by customer -- which free text makes unreliable the
  first time someone types "Acme Inc." one place and "Acme, Inc" another.
- **Customer invoices** are draft until sent. A draft posts nothing --
  it isn't a receivable yet and has no business touching revenue. Sending
  posts Debit Accounts Receivable / Credit revenue, one credit line per
  revenue account so the P&L keeps the breakout the invoice was written
  with. Numbers are sequential per org (`INV-0001`), derived from the
  highest existing rather than a stored counter.
- **Payments** post Debit [deposit account] / Credit Accounts Receivable,
  dated to the payment date rather than today so the cash flow statement
  attributes the money to the period it actually arrived in. An invoice
  becomes `paid` once payments cover it and drops back to `sent` if one is
  removed -- derived from the payments, so the two can't disagree.
  Overpayment is refused rather than silently creating a credit balance.
- **AR aging** buckets outstanding invoices by days past *due* (not days
  since issue) into Current / 1-30 / 31-60 / 61-90 / 90+, grouped by
  customer. That's what makes it a collections tool rather than a list
  sorted by age.
- Everything posts through `postJournalEntry`, so AR inherits the same
  guarantees as the rest of the ledger for free: balanced entries only,
  closed periods refused, voids as reversing entries. Voiding an invoice
  that already has payments against it is refused -- unapply the payments
  first.
- Two consistency guards on the payment path, both for failure modes the
  ledger's own checks can't see. The payment row has to exist before the
  journal entry can name it as its source, so a posting the ledger refuses
  (a closed period, most likely) now deletes the row on the way out --
  otherwise a refused payment still counted as collected in the aging
  report. And Accounts Receivable is refused as a deposit account: Debit AR
  / Credit AR balances, passes every check, and moves nothing, which would
  leave an invoice marked paid against an entry that did nothing.

**Bug fix in the cash flow statement.** v1.21 classified cash movements by
the counter-account's *type*, which meant collecting a receivable read as
an investing activity (AR is an asset) and paying a vendor bill would read
as financing (AP is a liability). Both are plainly operating: investing is
buying and selling long-term assets, financing is raising and returning
capital, and neither describes collecting what you're owed or settling
what you owe. Now matched on subtype first, with tests pinning both sides.
The bug was invisible before AR existed, because nothing yet moved cash
against either account.

**Layout fix for the line-item forms.** The global `form { display: flex }`
rule is written for one-row forms, and applied to a form built out of
repeating line items it laid the header fields, the line table and the
buttons out side by side in a single row -- so the table spilled out of its
panel and the submit button ended up off the right edge of the page. v1.20
shipped the manual journal entry form in that state and it was never caught
in a browser; the new invoice form would have been the second. Both now use
a shared `.line-item-form` layout: header fields wrap in a row above the
table, the table scrolls inside its own box on a narrow window instead of
widening the page, and the add-line control, running total and submit
button share a footer row. Recording a payment also moved off a
`window.prompt` onto a real modal, since it needs three answers and the
old flow silently picked the first asset account it found as the deposit
account.

## v1.22

Closed the two real gaps in v1.21's balance sheet: it conflated prior-year
retained earnings with current-year earnings, and nothing anywhere stopped
a backdated entry from silently rewriting already-reported financials.

- **Fiscal year** (`Organization.fiscalYearEndMonth`, default December,
  settable under Settings -> Accounting). `fiscalYear.js` computes the
  boundaries and handles non-calendar years properly -- a June year-end
  means FY2026 runs 2025-07-01 to 2026-06-30 -- with the last day of the
  year-end month computed rather than hardcoded, so a leap February lands
  on the 29th.
- **The balance sheet now splits earnings into two labeled equity lines**,
  matching how every other GL presents them: *retained earnings* (prior
  fiscal years -- settled history) and *current year earnings* (the year in
  progress, which reconciles exactly to a P&L run over the same fiscal
  year). Both stay derived rather than posted: QuickBooks and Xero compute
  current-year earnings the same way, and deriving the prior years too
  means changing the fiscal year end re-slices the split instantly with
  nothing to un-post. The split is presentational -- totals are unchanged
  and the sheet still balances either way.
- **Closing a month now locks it.** `postJournalEntry` refuses any entry
  dated into a closed period, so a backdated entry can't rewrite
  financials you already reported. Enforced in the ledger rather than the
  routes, so it covers every posting path from one place; reopening the
  period unlocks it again. Before this, `ClosePeriod` was a pure checklist
  that touched nothing in the ledger -- this is what finally gives
  month-end close teeth.
- One deliberate exception: invoice approval must never *fail* because the
  ledger refused a posting. Auto-posting carries today's date, so it only
  hits a closed period if the current month was closed early. When that
  happens the approval still succeeds and a `journal_posting_skipped`
  audit entry records why -- findable at close time rather than surfacing
  months later as an unexplained variance.

Two v1.21 tests were updated rather than fixed: they asserted the old
single-line semantics where `retained_earnings` meant all cumulative
earnings. Under the split, activity dated today is current-year earnings
and retained earnings covers prior years only -- the assertions moved to
match, and the totals they check are unchanged.

## v1.21

Added the three financial statements -- profit & loss, balance sheet, and
cash flow -- computed directly from v1.20's general ledger. Phase 2 of the
accounting pivot, and the first thing that makes Rekono legible as
accounting software to someone who has never opened the invoice queue.

- **`financialStatements.js`** derives all three from posted journal
  lines. No new tables, no stored balances, no write path -- a stored
  statement is a second copy of the truth that can drift from the ledger
  it came from, so every figure is recomputed per request.
- **P&L** is accrual basis (an approved invoice counts before it's paid),
  **balance sheet** is a point-in-time snapshot, **cash flow** is the
  direct method: every entry that moved cash, classified by what the cash
  moved against (revenue/expense counter-accounts are operating, other
  assets investing, equity and debt financing).
- **Retained earnings is derived rather than posted.** Rekono never posts
  year-end closing entries, so revenue and expenses accumulate forever and
  belong to no equity account -- a naive assets-vs-liabilities+equity
  comparison would be off by exactly the cumulative net income, every
  time. Rather than posting closing entries (which would mean picking a
  fiscal year end and writing entries the user never asked for), the
  balance sheet computes retained earnings as cumulative revenue minus
  expenses through its as-of date and presents it as its own labeled
  equity line. Same number a closing entry would have moved, arrived at by
  derivation instead of mutation. A test asserts it equals the P&L's own
  independently-computed net income for the same window.
- Three new tabs in the Accounting nav group, each with its own period
  picker defaulting to the same window the API does.

**Fixed a latent v1.20 bug these surfaced**: `computeTrialBalance`
filtered to `status: "posted"`, which dropped a voided entry while keeping
the reversing entry that cancels it -- leaving the account showing the
exact *negative* of the voided amount. It stayed invisible in that report
because a reversal is itself balanced, so the `balanced` flag never went
false; only a statement that reads per-account totals could expose it.
Voided entries are now included alongside their reversals, which is what
nets them to zero. A regression test pins it, and because a reversal
carries its own later date, an entry voided in a subsequent period now
correctly reverses in the period it was corrected rather than rewriting
history.

Still ahead (unchanged from v1.20's list, minus financial statements):
revenue recognition, AR/customer invoicing, live bank feeds, and
AI-driven close automation.

## v1.20

Added a real double-entry general ledger -- Phase 1 of turning Rekono from
an AP-automation tool into actual accounting software, positioned against
Rillet (AI-native ERP for venture-backed SaaS companies) rather than
QuickBooks, which Rekono still just integrates with one-way. Confirmed via
a full codebase pass before writing anything: no chart-of-accounts,
journal-entry, ledger, debit/credit, or trial-balance concept existed
anywhere in this app until now.

- **Three new tables** (`Account`, `JournalEntry`, `JournalLine`,
  `ledger.js`). `postJournalEntry` is the one place a line ever gets
  written, and it rejects (with a clean `422`) any entry with fewer than 2
  lines or where debits don't exactly equal credits -- nothing that
  reaches the database can be unbalanced. Amounts are stored as integer
  cents, not `FLOAT` (the rest of this app's money fields) and not
  `DECIMAL` either -- floating-point rounding error is a real problem
  specifically here, and Sequelize's SQLite dialect can hand `DECIMAL`
  columns back as strings depending on the value, which would silently
  break the sum(debit) === sum(credit) check.
- **A starter chart of accounts, seeded at onboarding** (same hook point
  `sampleSeed.js`'s sample invoice uses): Cash, Accounts Receivable,
  Accounts Payable, Credit Card, Owner's Equity, Uncategorized Revenue,
  one expense account per `ExpenseReceipt.EXPENSE_CATEGORIES` value, and
  Uncategorized Expense -- so every org has a working ledger from day one.
- **Approving an invoice auto-posts it**: Debit the matched expense
  account, Credit Accounts Payable. Reuses
  `invoice.quickbooksExpenseAccountName` -- the *existing*
  AI-suggested-or-vendor-learned field from the QuickBooks integration --
  to pick the account, falling back to "Uncategorized Expense." Zero new
  categorization logic: the AI already knew this. Every path that can
  approve an invoice (the single approve route, bulk-action, quick-review
  auto-approval, and pipeline.js's own auto-approval) calls the same
  function, which checks for an already-posted entry first so it's safe
  to call from all of them without double-posting. Rejecting or deleting
  a previously-approved invoice reverses its entry automatically.
- **Posted entries are immutable** -- no edit or delete route, only
  `POST /api/journal-entries/:id/void`, which posts the entry's exact
  mirror image and marks the original voided. Corrections are always a
  new entry, never a rewrite of history.
- **`GET /api/ledger/trial-balance`**: every account's debit/credit
  totals, and whether they balance to zero -- the simplest report that
  proves the ledger is internally consistent.
- New **Accounting** nav group (Chart of Accounts, Journal Entries, Trial
  Balance), available on every plan rather than gated to Business/Scale
  like the confidence-threshold/auto-approval features are -- this is
  meant to be core to what the product is now, not an advanced add-on.

Deliberately not built in this pass: financial statements (P&L, balance
sheet, cash flow -- each a query over `JournalLine` now that a real
ledger exists, genuinely small once this foundation is here), revenue
recognition (deferred-revenue schedules -- the actual Rillet
differentiator), accounts receivable/customer invoicing (money coming in,
not just out), live bank feeds replacing manual CSV import, and
AI-driven close automation. Named explicitly so it's clear this is the
foundation, not the whole repositioning -- see README.md's new "General
ledger" section and the updated Roadmap.

## v1.19

Reverted v1.17's optional AWS S3 + SQS backend. Explicit decision to not
build on AWS at all -- not even a dormant, off-by-default integration --
after a separate conversation about moving deployment off Render onto AWS
didn't pan out. `storage.js`, `jobs.js`, and `ocr.js` are back to their
pre-v1.17 shape (local disk, in-process queue only); the `@aws-sdk/*`
dependencies, `AWS_S3_BUCKET`/`AWS_SQS_QUEUE_URL`/`AWS_REGION` config, and
their tests are removed. `render.yaml` is unchanged otherwise -- Render
remains the deployment target.

## v1.18

Added a global "slow network" loading indicator -- a thin bar at the top
of the page that appears whenever a request is genuinely taking a while,
so a click on bad wifi reads as "working on it" instead of "did that
register at all?"

Deliberately not a spinner on every click regardless of speed: the bar
only appears once a request has been in flight for 250ms, so a normal
connection never sees it (auth endpoints are an expected exception --
bcrypt's deliberate cost means even signup/login on a fast connection
takes a couple hundred ms, and the bar reflects that honestly rather than
special-casing it away). It creeps toward 80% width over a few seconds
while waiting, then jumps to 100% and fades out the moment the response
actually lands, rather than sitting frozen at some arbitrary point.

Implemented by wrapping `window.fetch` itself once in `auth.js`, not by
touching `apiFetch` or any individual button handler -- this covers every
request in the app uniformly, including the pre-login screens' direct
`fetch()` calls (sign in, create account, password reset) that run before
`apiFetch`'s bearer-token wrapping even applies, with no per-call-site
plumbing to add or forget on the next feature.

Verified live in a browser rather than with a new Jest suite: this
codebase's frontend (`backend/public/`) has never had jsdom test
coverage, and introducing one just for a single small feature would be
more infrastructure than the feature warrants. Confirmed instead that a
normal-speed request never shows the bar, an artificially delayed one
(simulating bad wifi) does, and it correctly resets to hidden once the
response lands.

## v1.17

Added an optional AWS S3 + SQS backend, so this app can run on more than
one instance -- came out of a conversation about whether to move off
Render onto AWS Lambda for scale; Lambda would need a real rewrite (the
in-process job queue and local-disk storage don't translate), but the
actual blocker at any scale is narrower than that: local disk storage and
the in-process job queue both silently assume exactly one running
instance, which breaks the moment a second one is added purely for
request capacity. This closes that gap without changing the deployment
model at all.

- **`AWS_S3_BUCKET`** switches document storage (the 5 OCR/LLM pipelines)
  from local disk to S3. `storage.js` dispatches every operation --
  save, serve, delete, and the temp-file download OCR needs to shell out
  to pdftoppm/tesseract against -- on the *shape* of a record's
  `storagePath` (a plain path vs. an `s3://` string), not on whether S3 is
  currently configured, so demoSeed.js's always-local sample files keep
  working unmodified either way, and a record written under one mode
  still resolves correctly if the deployment's mode changes later. A
  document is always streamed through this server when served back, never
  redirected to a presigned URL -- the bearer token that authorized the
  request is the only thing that should ever prove access to it.
- **`AWS_SQS_QUEUE_URL`** switches the background job queue (`jobs.js`)
  from an in-memory array to SQS, which every instance polls -- the actual
  fix for "instance B never processes a job instance A queued." SQS's own
  visibility timeout replaces the local queue's boot-time orphaned-job
  recovery: a message that's received but never deleted (its instance
  crashed mid-job) simply becomes receivable again once the timeout
  expires, so `recoverOrphanedJobs` is skipped entirely in SQS mode rather
  than risking a duplicate enqueue of a message that's just waiting out
  its timeout.
- Both independent, both off by default -- unset, everything behaves
  exactly as it always has. Credentials come from the AWS SDK's own
  standard chain, not a Rekono-specific setting.
- As a side effect, `AWS_S3_BUCKET` alone also fixes Render's free-tier
  ephemeral-disk problem (uploaded files lost on every restart/redeploy)
  even on a single instance -- see render.yaml.

Tested down to the configured/unconfigured branch via a mocked S3/SQS
client (`tests/storage.test.js`, `tests/sqsQueue.test.js`), same pattern
as this app's Stripe/Google/QuickBooks coverage; not against a live AWS
account. See README.md's new "Scaling past one instance" section. Reverted
in v1.19 above -- see that entry for why.

## v1.16

Added a staff-only cross-org usage dashboard -- the "Rekono operator" view
deliberately left out of the last three analytics releases (v1.13-v1.15,
all customer-facing) because it needed something new and security-relevant:
a request that intentionally opts out of the per-org row-level security
this app has otherwise built and tested throughout.

- **`STAFF_EMAILS`** (comma-separated, case-insensitive): an email
  allowlist rather than a database column, since no signup flow should
  ever be able to grant this, and a config value only whoever holds the
  deployment's env vars can change is a much smaller blast radius than a
  boolean a bug could flip on a row. Empty by default -- fail-closed,
  nobody (not even the first org's owner) can reach staff routes until
  this is explicitly configured, matching every other optional integration
  in `config.js`.
- **`requireStaff`** (`auth.js`): a separate middleware from the
  customer-facing `requireAuth`, not a flag added to it -- two small,
  distinctly-named functions make "does this route see one org or every
  org" a property of which one a route imports, visible at the call site,
  rather than a boolean that could default wrong. The key difference: it
  never calls `setOrgContext`, so the request stays in the system context
  `rlsRequestContext` already starts every request in, and plain
  unscoped queries genuinely see every tenant.
- **`GET /api/staff/overview`** (`routes/staff.js`): aggregate-only --
  org/plan counts, a 13-week signup trend, an activation funnel (signed
  up -> onboarded -> uploaded a real document -> approved one), document
  volume, and subscription health. Never a way to read any single
  customer's actual documents, vendor names, or dollar amounts -- that's a
  much bigger exposure than "how is the product doing" calls for. Demo
  orgs and seeded sample invoices (v1.11) are excluded from every figure.
  Each call logs a `staff_metrics_viewed` `AuditLog` entry against the
  staff member's own org, since there's no cross-org-shaped audit target
  to log it against instead.
- A "Staff" nav tab in the app shell, shown only when `/api/auth/me`'s new
  `is_staff` field is true -- UX only, since the server-side gate above is
  what actually matters.

Tests specifically prove the isolation properties that make this safe: 401
(not logged in) vs. 403 (logged in, not staff) are distinct; a staff user
genuinely sees multiple different orgs' data in one response; an ordinary
per-org request immediately after a staff request still can't see across
tenants (no context leakage between requests); demo orgs are excluded; and
the empty-`STAFF_EMAILS` default really does lock everyone out.

## v1.15

Added richer business KPIs to the dashboard's Trends panel, the last of
the three analytics improvements from this run (v1.13's marketing GA4,
v1.14's per-org team activity, now the org's own numbers):

- **13-week trend charts** for touchless rate and average confidence --
  the main dashboard's touchless/confidence figures are single snapshots,
  so there was no way to see whether automation quality is improving or
  slipping over time. Weekly, not daily: a single day's rate is noise at
  typical SMB volume.
- **Top vendors by approved spend, all-time** -- every existing KPI is a
  single rolled-up number; this is the AP-team question ("who are we
  actually paying the most") none of them answer.
- **Month-over-month tiles** for approved value, documents processed, and
  touchless rate -- this month to date vs. the same number of days into
  last month (not all of last month), so an early-month comparison
  doesn't read as a slump every time regardless of actual pace. Limited
  to flow metrics (things that happened in a window); outstanding AP is
  deliberately excluded since it's a snapshot with no clean "as of a
  month ago" value without reconstructing history the app doesn't record.

New `GET /api/dashboard/trends` endpoint, separate from the main
`/api/dashboard` -- a trends view is heavier (three weeks-long queries)
and not something every dashboard load needs to pay for.

Caught one bug writing the tests: Sequelize force-touches `updatedAt` to
"now" on every `create()`/`save()` regardless of what's passed, unless
`{ silent: true }` is set -- the month-over-month tests need control over
which month an invoice landed in, and without `silent` every "last
month" fixture was silently landing in the current month instead.

## v1.14

Added a per-org "Activity" panel to the Team tab (owner-only), breaking
down each teammate's uploads/approvals/rejections/corrections over the
last 30 days from existing AuditLog data -- distinct from the marketing
site analytics in v1.13, which is about whether Rekono itself is getting
traction, not how a specific customer's team uses it day to day. Every
current member shows up even at all-zero, since who *isn't* using it is
at least as useful to an owner as who is. Deliberately excludes
account-management actions (password changes, team invites, ...) and
anything with no human userId attached (auto-approvals) -- this counts
work on documents, not account housekeeping.

A platform-wide, cross-org usage view for Rekono's own team was
considered and deliberately deferred: it would need a new staff/
superadmin concept that intentionally opts out of the row-level security
this app has already built and tested against tenant isolation, which is
a big enough decision to warrant its own dedicated conversation rather
than folding it into this change.

## v1.13

Wired up marketing site analytics (previously off with no account at all).
`website/src/lib/analytics.js` adds GA4 -- genuinely free with no trial or
usage cap, unlike Plausible's hosted option, and self-hosting an
open-source alternative isn't realistic for a static site with no server.
It's a no-op until `VITE_GA_MEASUREMENT_ID` is set at build time (Vercel
env vars), matching the "missing config degrades gracefully" pattern every
other optional integration in this app already follows.

Once configured it tracks more than pageviews: every "Get started"/"Sign
in"/demo link across Nav, Hero, Pricing, FinalCTA, and MobileStickyCTA
fires a `cta_click` event naming where it was clicked, and a successful
contact-form submission fires GA4's recommended `generate_lead` event --
the actual conversion signal, not just a click. Initial config sets
`transport_type: "beacon"` so those click events survive the tab
navigating away immediately after, which is what every one of these CTAs
does by design.

## v1.12

Added optional TOTP-based two-factor authentication. Settings has a new
"Two-factor authentication" panel: Enable generates a secret and a QR code
(otplib + qrcode, both free/open-source), confirming a code from it turns
2FA on and hands back 8 single-use backup codes (shown once, like an API
key). Login for an account with 2FA on becomes two steps -- password (or
Google) succeeds, then a short-lived pending token exchanges for the real
access token once a TOTP or backup code verifies (POST /api/auth/2fa/verify).
Disabling 2FA and regenerating backup codes are gated behind the existing
password re-auth check (auth.js's requireReauth), same as disconnecting
QuickBooks or removing a team member.

Google sign-in also respects it: an account with 2FA enabled gets routed
through the same pending-token verification after a Google login succeeds,
rather than 2FA being a promise the app doesn't keep for anyone who's also
linked Google.

User.totpSecret is encrypted at rest (secretBox.js, the same mechanism
already protecting QuickBooks OAuth tokens) and backup codes are stored as
SHA-256 hashes, never plaintext. Caught one real bug while writing tests:
otplib's verify() throws (rather than returning invalid) for anything that
isn't 6 digits, which is exactly what a backup code is -- fixed in
twoFactor.js so submitting one doesn't 500 instead of falling through to
the backup-code check.

## v1.11

Seeds one realistic sample invoice into a brand-new org's Review Queue as
soon as onboarding completes (free plan, or a paid plan once checkout
confirms), so a first login has something to actually review instead of
relying only on the empty-state prompt from v1.10. It's marked
`needs_review` with a below-threshold confidence score, matching the
product's own pitch of an imperfect extraction getting caught before it
hits the books, and shows a "Sample" badge plus an explanatory banner in
the detail pane.

The sample must never look like real financial activity: `Invoice` gets an
`isSampleData` column and a `defaultScope` that excludes it everywhere
except the Review Queue's own routes (which opt back in via a `withSamples`
scope) -- dashboard KPIs, CSV/Excel exports, the AP/bank matching engine,
QuickBooks sync, the AI assistant's context, and the monthly document quota
all continue to see only real data, with no per-callsite changes needed
anywhere else. Seeding itself reuses demoSeed.js's `seedInvoice` (now
exported) rather than duplicating the synthetic-PDF-plus-audit-log logic
that already exists for the investor demo.

`tests/testUtils.js`'s shared `signup()` helper strips the sample back out
after onboarding, since dozens of other test files use it for "a normal
working account" and assert exact invoice counts of their own fixtures --
tests that want to verify the seeding itself drive `/api/onboarding`
directly instead, same as the existing onboarding tests already did.

## v1.10

Gave the invoice Review Queue a real empty state for brand-new orgs.
It was previously the thinnest of the five document-type queues: a bare
"No invoices." table cell and a generic "Select an invoice..." detail
pane, with no indication of what to do next -- landing there right after
signup looked broken rather than empty. Now a genuinely-empty org (no
invoices ever uploaded, not just a filter matching zero) gets an
"Upload your first invoice" prompt in both the table and the detail
pane, matching the pattern the dashboard's own empty state already used.
A filter or search that happens to match nothing still shows a plain
"No invoices match this filter." instead, so the CTA doesn't mislead
someone who already has invoices.

## v1.9

Added Vercel Speed Insights to the marketing site (`@vercel/speed-insights`,
mounted in `src/main.jsx`) now that it's deployed on Vercel, to get
real-user performance data on the now-client-rendered React page.

## v1.8

Moved the marketing site's deployment from GitHub Pages to Vercel.
GitHub Pages required building straight into the repo root with fixed
(non-hashed) filenames and `emptyOutDir: false`, since it served the repo
as-is with no build step -- all workarounds Vercel doesn't need, since it
builds `website/` in its own CI on every push and serves the output
itself. `vite.config.js` now builds to a normal disposable `dist/`
(gitignored) with Vite's default content-hashed filenames, and the
`/Rekono/` base path is gone since Vercel serves from its domain root.
`robots.txt`, `sitemap.xml`, and `404.html` moved from the repo root into
`website/public/` so Vite copies them into the build output; the old
committed build output at the repo root (`index.html`, `assets/`, the
favicon/icon files) is removed since it's no longer how the site is
served. `website/README.md`'s deploy section is rewritten to match.

The stale `winnersfrown.github.io` references in `robots.txt`,
`sitemap.xml`, and `website/index.html`'s canonical/Open Graph tags are
left as `TODO`s pending the real `*.vercel.app` domain, which Vercel
assigns on project creation -- a manual dashboard step, not something
scriptable from here.

## v1.7

Corrected README's row-level-security section: it claimed Neon "hand[s]
out ordinary roles by default," which is wrong, and cost a live outage to
find out. Every role Neon's Console, API, or CLI creates -- including a
project's own default role and anything added through the dashboard's
Roles page -- is automatically a `neon_superuser` member, which carries
`BYPASSRLS`. That membership can't be revoked afterward: `ALTER ROLE ...
NOBYPASSRLS` fails with `permission denied` no matter which role runs it,
including the project owner. `REASSIGN OWNED` and `DROP ROLE` hit the
same wall for the same reason (both require membership Neon's owner role
doesn't actually have over independently-created roles).

The only way to get a role Postgres will actually enforce RLS against on
Neon is creating it with plain SQL instead of the UI/API -- that path
skips the `neon_superuser` grant entirely. README now documents the exact
sequence: `CREATE ROLE` by SQL, `GRANT rekono_app TO neondb_owner` (needed
before `AUTHORIZATION rekono_app` can act as it), a fresh `public` schema
owned by the new role from creation (sidesteps per-table GRANT fights
against tables `neondb_owner` already owns), and `ALTER ROLE ... SET
search_path = public` (without it, table creation fails with "no schema
has been selected to create in" even though the schema exists and the
role owns it -- a role's default search_path isn't tied to what it owns).

No code changed -- this is corrected operational documentation for a
deployment step, discovered the hard way while bringing the app back
after the v1.6 Render migration.

## v1.6

Render suspended the whole account (unrelated to v1.5's fix -- happened
before it, likely an automated response to the same Safe Browsing flag).
Recovering it meant a new Render account, which meant a new service name
and a new onrender.com URL: rekono-couj.onrender.com, replacing
rekono-ai-new.onrender.com everywhere it was hardcoded --
website/src/lib/constants.js's APP_URL, config.js's ALLOWED_ORIGINS
default, a CORS test's expected origin, and the Lovable integration doc.
Rebuilt the marketing site bundle so the new URL actually ships in
assets/index.js, not just the source. Left the old URL untouched in this
changelog's own v1.5 entry -- that's a historical record of what was true
then, not a live reference to update.

## v1.5

Google Search Console flagged the live app (rekono-ai-new.onrender.com,
not the marketing site) as a "Deceptive pages" site -- Chrome would show
visitors a red warning. `Sample URLs: N/A`, so nothing to inspect directly;
had to reason out the actual cause from the code.

Ruled out first: no third-party/ad scripts, no `eval`, no redirects, no
phishing-style copy anywhere in the built site. The one meta tag that
looked suspicious on sight (`strix-verification`) turned out to be
legitimate and already explained by an earlier commit in this repo's own
history (#53) -- domain verification for a security-scanning tool, not
evidence of compromise.

The real cause: self-serve signup lets anyone set an organization's name to
literally anything (`org_name: z.string().min(1).max(256)`, no other
constraint), and that name rendered verbatim -- `You've been invited to
join ${org_name} on Rekono.` -- on the invite-accept page, which is
reachable with **no account**, by design, so an invitee can see the invite
before creating one. That's a free-text billboard on a legitimate domain,
sitting directly above a form asking for a name and password. Sign up once,
rename the org to something that reads like an urgent account-suspension
notice, generate one invite link, and the resulting URL is a phishing page
hosted on Rekono's own domain -- exactly what this flag describes, and
exactly the kind of thing that stops being reproducible (hence `Sample
URLs: N/A`) once the attacker's free trial or the invite token expires.

Fixed on two layers, since neither alone is sufficient:

- **Content**: `orgName.js`'s `orgNameSchema` rejects a name that's itself
  a URL (`http(s)://`, `www.`, or a bare `name.tld`), applied at both
  signup and org rename. Cheap, zero false-positive risk, closes the most
  mechanical version of the attack -- but a blocklist can't catch every
  phishing phrase, so it's not the real fix by itself.
- **Structure** (the actual fix): the invite-accept page no longer weaves
  the org name into a first-party-sounding sentence. It's quoted, under a
  fixed "Team invite" heading and a permanent disclaimer -- "Rekono doesn't
  verify organization names. If this doesn't look right, don't enter your
  password below." -- placed directly above the password field. This holds
  regardless of what the org name says, which a content filter alone never
  can.

Also: the whole app shell (`backend/public/index.html`) now sends
`noindex, nofollow`. It's an authenticated app shell that happens to also
serve the invite/reset panels, not marketing content -- there's no reason
for a crafted invite URL to be organically discoverable via search on top
of everything above.

Verified live, not just by reading the diff: signed up, created a real
invite, hit the actual invite-accept page with a real token, and confirmed
the org name renders quoted inside the new framing with the disclaimer
directly above the password field (screenshot taken via Playwright against
the running app). `tests/orgName.test.js` covers the schema directly plus
both real routes that accept an org name (signup, org rename) rejecting a
URL. Full suite: 634 passing, 0 failing (up from 624).

One earlier claim in this investigation turned out to be wrong and is
recorded here rather than quietly dropped: a missing `.nojekyll` file was
flagged as letting GitHub Pages serve the entire repo (source code
included) publicly. That's incorrect -- Jekyll's default processing only
excludes dotfiles/dotdirs, not regular directories like `backend/`, so
`.nojekyll` wouldn't have changed what's exposed either way. Not
implemented; whether the marketing-site repo being public already covers
this is a separate question for the user's own judgment call.

## v1.4

The marketing site read too small and too sparse -- both had a specific,
fixable cause rather than being a matter of taste.

**Too small:** `html`/`body` set `font-size: 15px`, 6% under the browser
default. Every rem-based size on the page -- headings, body text, buttons,
badges -- inherited that shrink uniformly. Back to 16px.

**Too sparse:** every major section (`HowItWorks`, `Features`, `Pricing`,
`FAQ`, `FinalCTA`) used `py-24` (96px top and bottom), so two adjacent
sections stacked to nearly 200px of pure whitespace between them -- visible
in a screenshot as a gap roughly as tall as the FAQ heading sitting above
it. Cut to `py-16` (`ProofStrip` to `py-10`, `Hero`'s asymmetric top/bottom
scaled down to match), which keeps each section legible as its own block
without the page reading like mostly blank space between five lines of
actual content.

Verified with real screenshots (Playwright against the production build, an
iPhone-width viewport matching the one in the report) at the hero and at
the pricing-to-FAQ boundary specifically, since that's where the gap was
most visible -- not just a visual guess that the numbers "should" look
better.

## v1.3

Adds `backend/scripts/check-llm.mjs`, a one-command preflight for whichever
LLM provider is configured. It calls `src/llm.js`'s `callTool` and
`generateText` directly -- the same code path extraction, categorization,
QuickBooks, and Ask Rekono all use -- so a pass here means those features
actually work, not just that a request shape looks right.

Exists because this sandbox can't verify that itself: `openrouter.ai` is
policy-blocked at the proxy level (`connect_rejected`, confirmed via the
proxy's own status endpoint), so v1.2 shipped with the wire format tested
against a stub and a local fake server, but no live call. This script is
what to run, with real credentials, wherever that block doesn't apply:

```
OPENROUTER_API_KEY=... OPENROUTER_MODEL=vendor/model-name node scripts/check-llm.mjs
```

Two checks: a forced tool call (adds two numbers via a `record_answer`
schema, so a pass also confirms the model gets simple arithmetic right
before it's trusted on invoice totals), then plain text. Failures are
specific rather than generic -- a model with no tool-calling support gets
told exactly that, since extraction, categorization, and both QuickBooks
suggestions all depend on it and silently fall back to the heuristic
extractor otherwise.

## v1.2

Any LLM call in the app -- extraction for all five document types, merchant
categorization, the two QuickBooks suggestions, and Ask Rekono -- can now run
on [OpenRouter](https://openrouter.ai) instead of Gemini. `llm.js` is the
only file that knows which provider is active; everything else asks it for a
forced tool call or for text.

Set `OPENROUTER_API_KEY` **and** `OPENROUTER_MODEL` to use it. There is no
default model on purpose: slugs are specific and change as models come and
go, so a key with no model is treated as unconfigured and logs why, rather
than guessing one and failing at the first real extraction. The chosen model
must support tool/function calling -- extraction forces a JSON schema
through a named function, which is what produces a confidence per field. A
model without it fails every extraction into the heuristic path, and says
so. With both providers configured OpenRouter wins; `LLM_PROVIDER=gemini`
overrides. With neither, the heuristic fallback behaves exactly as before.

Worth recording: the first pass converted three call sites, which was wrong.
There were nine, across six files -- the four non-invoice document
extractors and both QuickBooks suggestions also built their own Gemini
client. Converting only the three would have left invoices on OpenRouter
while receipts, leases, vendor documents and tax documents silently dropped
to the heuristic extractor, which reads as the model getting worse rather
than as a half-finished migration.

## v1.1

Started numbering releases, with v1.0 as the baseline. Adds this changelog
and `CLAUDE.md`, which records the convention so it survives the container
being rebuilt between sessions.

Annotated git tags would be the conventional way to mark these, but the git
proxy in the Claude Code sandbox rejects `refs/tags/*` pushes, so the number
lives in the commit subject and here instead.

## v1.0

The first numbered version. Everything below already existed at the point
numbering started -- it's recorded here as the baseline the later entries
build on, not as work done for this release.

**Document pipeline.** Upload a PDF or image; Tesseract/Poppler lift the
text, a language model parses it into a fixed schema, and per-field
confidence plus a cross-check on the arithmetic decides whether it can be
auto-approved or needs a human. Falls back to a heuristic regex extractor
when no model key is configured, so the pipeline runs end to end without
one. Five document types on the same shape: invoices, expense receipts,
vendor documents, leases, and tax documents.

**Review and correction.** A reviewer sees the extracted fields beside the
source document, corrects what's wrong, and approves or rejects. Every
extraction, correction, approval and match decision writes an audit row. A
corrected vendor name is remembered and auto-applied next time the same raw
text comes in.

**Matching.** Fuzzy vendor matching with configurable amount tolerance and a
date window, plus exact PO/reference matching as a strong signal. Uploading
goods receipts switches it from two-way to three-way automatically, which
answers the question AP actually has before paying: was this ordered, did it
arrive, and does the bill agree with both.

**Multi-tenancy.** Every table that holds customer data carries an `orgId`,
every route scopes to the caller's org, and Postgres row-level security
enforces the same boundary underneath the application code, so a query that
forgets its scope returns nothing rather than another tenant's rows.

**Accounts and billing.** Email/password and Google sign-in, team invites
with per-plan seat caps, onboarding, Stripe-backed plans with a trial, and
per-plan monthly document caps.

**Integrations and export.** QuickBooks Online (OAuth connect, Bill push,
bank-transaction reconciliation) with tokens encrypted at rest; CSV and
Excel export with formula-injection neutralized.

**Hardening.** Rate limiting per account and per IP, re-authentication on
destructive actions, a fixed CORS allowlist, CSP and the standard security
headers, upload content-type derived from an extension allowlist rather than
the client's claim, and an error handler that never echoes internals.

**Surfaces.** The review UI (vanilla JS, no build step, served by Express)
and the marketing site (React + Vite + Tailwind, built into the repo root
for GitHub Pages).
