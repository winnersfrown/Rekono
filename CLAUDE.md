# Working in this repo

## Where things live

The backend is Express + Sequelize under `backend/src`. The pieces that
matter most, and the order to look in:

| Concern | File |
|---|---|
| Double-entry core, chart of accounts, trial balance | `ledger.js` |
| P&L, balance sheet, cash flow | `financialStatements.js` |
| Fiscal years, period locking | `fiscalYear.js` |
| AR: customer invoices, payments, aging | `accountsReceivable.js` |
| AP: bill payments, aging | `accountsPayable.js` |
| Vendor identity + merging | `vendors.js` |
| Deferred revenue, ASC 606 | `revenueRecognition.js` |
| Adjusting entries (depreciation, accruals) | `recurringEntries.js` |
| Year-end closing entries | `yearEndClose.js` |
| Equity events, statement of stockholders' equity | `equity.js`, `stockholdersEquity.js` |
| Cap table, shares outstanding | `shareRegister.js` |
| Option pool, vesting, fully diluted | `equityAwards.js` |
| Row-level security policy list | `rls.js` |

Frontend is vanilla JS, no build step: `backend/public/app.js` (~6.4k
lines), `index.html`, `styles.css`. Tabs are `data-tab` buttons plus a
`#tab-<name>` section, wired in `switchTab`.

## Accounting conventions

These are settled decisions. Don't re-litigate them without a reason.

- **Integer cents everywhere in the ledger.** FLOAT breaks exact
  debit/credit equality, and Sequelize's SQLite dialect returns DECIMAL as
  strings. `dollarsToCents`/`centsToDollars` convert at the boundary with
  the older AP tables, which are FLOAT dollars.
- **Posted entries are immutable.** Corrections are reversing entries via
  `POST .../void`. There is no PATCH or DELETE for a journal entry.
- **`postJournalEntry` is the only write path to the ledger.** It enforces
  balance and refuses closed periods, so every posting route inherits both.
  Put new enforcement there, not in routes.
- **Voided entries stay on the books** alongside their reversal and the two
  cancel. Never filter statements to `status: "posted"` — that drops the
  original and keeps the reversal, showing the negative of the voided
  amount.
- **Retained earnings is derived** (cumulative revenue − expenses), and
  year-end closing entries are optional on top. They don't double-count:
  the closing entry zeroes the P&L accounts, so the derivation goes to zero
  as the account balance appears. The P&L excludes `closing_entry`; the
  balance sheet includes it.
- **`Invoice` has a `defaultScope` hiding sample data.** Anything that must
  reconcile to the ledger needs `.scope("withSamples")` — an approved
  sample invoice posts to AP for real.
- **Par value is carried in millionths of a dollar.** $0.0001 (the Delaware
  default) and $0.001 both round to zero cents. Multiply by the share
  count first, round once.
- **The share register is not the ledger.** Positions are replayed in date
  order rather than summed, and a wrong entry is deleted rather than
  voided — it's a claim about who owns what, not about money that moved.
  It ties to the ledger in exactly one place: Common Stock ÷ par = shares
  *issued* (not outstanding — the cost method leaves Common Stock alone on
  a buyback).
- **Granting an option issues nothing; exercising issues everything.** An
  exercise is the only award event that reaches the other two ledgers, and
  it reaches both — shares onto the register, strike money onto the P&L
  side as a capital contribution. Skip the second half and the register's
  tie-out breaks with no way to close it.
- **Vesting is computed, never stored** (`vestedShares`). Same argument as
  recurring entries: a row for a month that hasn't happened is a claim
  about the future.
- **Fully diluted includes the unallocated pool.** It belongs to nobody
  and dilutes everybody. Leaving it out produces percentages that look
  better than the ones an investor will compute.

## Adding a feature

The wiring is the same every time, and missing a step fails late:

1. Model in `src/models/`, then import + associate + export in
   `models/index.js`.
2. Register the table in `src/rls.js` (`DIRECT_ORG_TABLES` if it has its
   own `orgId`, `DERIVED_TABLES` with an EXISTS subquery if it reaches org
   through a parent). Verify: `node -e 'import("./src/rls.js").then(m=>console.log(m.RLS_TABLES.length))'`
3. New `JournalEntry` source? Add it to `JOURNAL_ENTRY_SOURCES`.
4. Route file in `src/routes/`, then import + `app.use` in `src/app.js`.
5. Tests in `backend/tests/`. Assert against the trial balance and
   statements, not just the new endpoint — a feature that looks right in
   its own API but doesn't move the right account is the bug worth
   catching.
6. Boot check: `node -e 'import("./src/app.js").then(()=>console.log("ok"))'`

## Tests

`cd backend && npm test` runs the suite against SQLite. That is the gate.
Full run is ~9 minutes and ~840 tests.

**Never run two jest processes at once.** They share one SQLite test
database, and `resetDb` in one drops tables the other is querying. The
failures look like real bugs (`SQLITE_ERROR: no such table: accounts`) and
aren't. If a run reports mass failures, check `pgrep -f node_modules/.bin/jest`
before believing it.

A second mode runs the same suite against Postgres with row-level security
live, which is the only way to exercise the policies (SQLite has no
equivalent feature):

```bash
cd backend
./scripts/setup-test-postgres.sh
REKONO_TEST_PG_URL=postgres://rekono_app:apppw@127.0.0.1:5432 npm test
```

`tests/rls.test.js` passes reliably there. The rest of the suite in that
mode is still flaky -- tests don't await their own uploads, so a background
job can be mid-write when the next test resets. See README.md's "Row-level
security" section.

## Smoke-testing locally

The env var is **`DATABASE_URL`**, not `REKONO_DB_URL`. Passing the wrong
name silently falls back to the default `backend/rekono.db`, so separate
"clean" runs share one database — that has already produced a phantom bug
report about onboarding seeding twice (it was two orgs in one file).

```bash
cd backend
DATABASE_URL=sqlite:/tmp/smoke.sqlite ALLOWED_ORIGINS=http://127.0.0.1:4600 \
  PORT=4600 node src/server.js
```

Signup takes `{email, password, org_name, full_name}`, and every
data-touching endpoint returns 402 until `POST /api/onboarding` runs
(`{role, company_size, primary_use_case, monthly_invoice_volume, plan}`
with `plan: "free"`).

For browser checks, Playwright's pinned Chromium revision usually isn't the
one baked into the image. Bridge it before launching:

```bash
SRC=$(ls -d /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell | head -1)
D=/opt/pw-browsers/chromium_headless_shell-<pinned>/chrome-headless-shell-linux64
mkdir -p "$D" && ln -sfn "$SRC" "$D/chrome-headless-shell"
touch "$(dirname "$D")/INSTALLATION_COMPLETE"
```

**Run the UI.** Several real bugs this repo has shipped fixes for were
invisible to a passing test suite and obvious on screen: a form spilling
out of its panel, a control pushed off the page, an aging report that
didn't tie to the balance sheet because tests never seed sample data.

## Version numbering

Releases are numbered `1.0`, `1.1`, `1.2`, … in order. `v1.0` is the
baseline recorded in `CHANGELOG.md`; every merged change after it takes the
next number.

Two things to do for each one:

1. **Prefix the commit subject with the version**, e.g.
   `v1.2: Add a bulk re-run action to the review queue`. One merged change
   is one version, so `git log --oneline` on `main` reads as the release
   history.
2. **Add a `CHANGELOG.md` entry** under a `## v1.2` heading saying what
   changed and why, in the same voice as the existing entries.

To find the next number, read the top entry in `CHANGELOG.md` (do not guess
from memory -- the container is rebuilt between sessions and `main` may have
moved).

Annotated git tags would be the more conventional way to do this, but
pushing `refs/tags/*` is blocked by the git proxy in the Claude Code
sandbox, so the number lives in the commit subject and the changelog
instead. If you're working outside that sandbox, tagging as well is welcome
-- just keep the changelog as the source of truth.

## Shipping a change

The working branch is `claude/rekono-invoice-ai-kdpqd4`, which is long-lived
and still carries the previous release's commits. Rebase onto `main`
**before** opening the PR — doing it after is what produces the
"405 Pull Request has merge conflicts" on the first merge attempt:

```bash
git fetch origin main -q && git reset --hard origin/main -q   # start clean
# ... work, then:
git add -A && git commit -F <message-file>
git fetch origin main <branch> -q
git rebase origin/main                    # before the PR, not after
git push --force-with-lease -u origin <branch>
# open the PR, then merge -- succeeds first time
```

Squash-merge, with the commit title `v1.X: <subject> (#<pr>)`.

## Writing style

Comments and changelog entries explain **why**, especially where the code
looks wrong but isn't: why voided entries stay in statement queries, why
the schedule remainder lands on the last month, why closing entries don't
double-count. If a future reader would file a bug against a deliberate
decision, the comment is doing real work. Skip comments that restate the
code.
