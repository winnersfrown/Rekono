# Changelog

Versions are numbered `1.0`, `1.1`, `1.2`, … in order. Each release is one
merged change, and its commit subject carries the number (`v1.1: ...`), so
`git log --oneline` reads as the release history without needing tags.

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
