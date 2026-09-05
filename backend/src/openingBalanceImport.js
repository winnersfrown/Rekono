// Import an opening trial balance from a CSV export of another system --
// Rillet, QuickBooks, Xero, NetSuite, anything. Every general ledger can
// produce this exact shape (an account name, a type, a debit or a
// credit), so this is the one format that makes switching to Rekono not
// mean re-typing a chart of accounts and re-entering history by hand.
// Rillet's own quoted implementations run 45 days; this is the same job
// done in one upload.
//
// Posted as one journal entry, not one per row: a trial balance is a
// balanced snapshot at a moment, and posting it as anything other than a
// single entry would let ledger.js's normal per-entry balance check pass
// on each row individually while saying nothing about whether the whole
// import ties out -- which is exactly the number someone trusting an
// automated import needs checked before anything touches their books.

import { LedgerError, centsToDollars, dollarsToCents, postJournalEntry } from "./ledger.js";
import { ACCOUNT_TYPES } from "./models/Account.js";
import { Account } from "./models/index.js";

const VALID_TYPES = new Set(ACCOUNT_TYPES);

// Splits on commas outside quotes and drops a wrapping pair of quotes --
// enough for the plain, unescaped-comma CSVs every accounting system's
// trial-balance export actually produces, without a CSV library for one
// column layout.
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// A two-column (Debit, Credit) trial balance has no legitimate use for a
// negative number -- which side an amount is on is exactly what the
// column already means. Rather than guess what a stray negative or
// parenthesized figure was meant to do (flip columns? cancel the row?),
// this refuses it and says which column and row, so the fix is to edit
// the export, not to trust an inference this app has no basis for making.
function parseAmount(raw, columnLabel, line) {
  if (raw === undefined || raw === "") return 0;
  const cleaned = raw.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new LedgerError(`"${raw}" in the ${columnLabel} column on row ${line} is not a number.`);
  if (n < 0) {
    throw new LedgerError(
      `"${raw}" in the ${columnLabel} column on row ${line} is negative. Move it to the other column ` +
        `instead of writing a negative ${columnLabel.toLowerCase()}.`
    );
  }
  return n;
}

// Header names accepted for each column, tried case-insensitively -- real
// exports differ on capitalization and wording ("Account", "Account
// Name"; "Debit Amount", "Debit") far more than they differ on which
// columns exist at all.
const HEADER_ALIASES = {
  code: ["code", "account code", "account number", "number"],
  name: ["name", "account", "account name"],
  type: ["type", "account type"],
  debit: ["debit", "debit amount", "debits"],
  credit: ["credit", "credit amount", "credits"],
};

function findColumn(header, aliases) {
  const idx = header.findIndex((h) => aliases.includes(h.toLowerCase().trim()));
  return idx === -1 ? null : idx;
}

// Parses raw CSV text into rows ready to resolve against the chart of
// accounts. Throws on structural problems (no header, no name/amount
// column, an unparseable number); a row with a recognized name but no
// recognized type is still returned -- whether that's fatal depends on
// whether the account already exists, which only resolveRows knows.
export function parseTrialBalanceCsv(csvText) {
  const lines = csvText.split(/\r\n|\r|\n/).filter((l) => l.trim() !== "");
  if (!lines.length) throw new LedgerError("The file is empty.");

  const header = parseCsvLine(lines[0]);
  const columns = {
    code: findColumn(header, HEADER_ALIASES.code),
    name: findColumn(header, HEADER_ALIASES.name),
    type: findColumn(header, HEADER_ALIASES.type),
    debit: findColumn(header, HEADER_ALIASES.debit),
    credit: findColumn(header, HEADER_ALIASES.credit),
  };
  if (columns.name === null) throw new LedgerError('No "Account" / "Name" column found in the header row.');
  if (columns.debit === null && columns.credit === null) {
    throw new LedgerError('No "Debit" or "Credit" column found in the header row.');
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const name = cells[columns.name]?.trim();
    if (!name) continue; // a blank trailing row, or a "Total" line with no account name

    const debit = columns.debit !== null ? parseAmount(cells[columns.debit], "Debit", i + 1) : 0;
    const credit = columns.credit !== null ? parseAmount(cells[columns.credit], "Credit", i + 1) : 0;
    if (debit === 0 && credit === 0) continue; // most exports include zero-balance accounts

    const typeRaw = columns.type !== null ? cells[columns.type]?.trim().toLowerCase() : "";
    rows.push({
      line: i + 1,
      code: columns.code !== null ? cells[columns.code]?.trim() || "" : "",
      name,
      type: VALID_TYPES.has(typeRaw) ? typeRaw : null,
      debitCents: dollarsToCents(debit),
      creditCents: dollarsToCents(credit),
    });
  }
  if (!rows.length) throw new LedgerError("No account rows with a balance were found.");
  return rows;
}

// Matches each row against the org's existing chart of accounts by name
// (case-insensitive) -- most rows from another system are accounts
// Rekono already seeded (Cash, Accounts Payable, Retained Earnings, ...),
// so most of a real trial balance resolves without needing a type column
// at all. Shared by the preview and the actual import so they can never
// disagree about what's about to happen.
async function resolveRows(orgId, rows) {
  const existingAccounts = await Account.findAll({ where: { orgId } });
  const byName = new Map(existingAccounts.map((a) => [a.name.toLowerCase(), a]));

  let totalDebitCents = 0;
  let totalCreditCents = 0;
  const matches = rows.map((row) => {
    totalDebitCents += row.debitCents;
    totalCreditCents += row.creditCents;
    const existing = byName.get(row.name.toLowerCase());
    return { row, existingAccountId: existing?.id ?? null, willCreate: !existing };
  });

  // A row that doesn't match anything already on file needs a type to
  // create it -- refusing to guess "Marketing Software Refund" is an
  // expense rather than a contra-revenue account is the same discipline
  // incomeTax.js and stockCompensation.js already apply to rates and fair
  // values this app has no basis for inventing.
  const unresolved = matches.filter((m) => m.willCreate && !m.row.type);

  return { matches, unresolved, totalDebitCents, totalCreditCents, balances: totalDebitCents === totalCreditCents };
}

export async function previewOpeningBalances(orgId, rows) {
  const { matches, unresolved, totalDebitCents, totalCreditCents, balances } = await resolveRows(orgId, rows);
  return {
    rows: matches.map(({ row, willCreate }) => ({
      line: row.line,
      name: row.name,
      type: row.type,
      debit: centsToDollars(row.debitCents),
      credit: centsToDollars(row.creditCents),
      will_create_account: willCreate,
    })),
    accounts_to_create: matches.filter((m) => m.willCreate).length,
    accounts_matched: matches.filter((m) => !m.willCreate).length,
    total_debit: centsToDollars(totalDebitCents),
    total_credit: centsToDollars(totalCreditCents),
    balances,
    unresolved: unresolved.map(({ row }) => ({ line: row.line, name: row.name })),
  };
}

function unresolvedMessage(unresolved) {
  const n = unresolved.length;
  const names = unresolved.map(({ row }) => `"${row.name}" (row ${row.line})`).join(", ");
  return (
    `${n} account${n === 1 ? "" : "s"} in the file ${n === 1 ? "isn't" : "aren't"} already on your chart of ` +
    `accounts and ${n === 1 ? "has" : "have"} no recognized Type column, so Rekono can't create ` +
    `${n === 1 ? "it" : "them"}: ${names}. Add a Type column (asset/liability/equity/revenue/expense) and try again.`
  );
}

// Posts the import as one balanced journal entry. Accounts this creates
// are tracked and unwound if the posting itself is refused (a closed
// period, most likely) -- same reasoning recordEquityTransaction destroys
// its row when its own posting fails, so a refused import doesn't leave
// orphaned accounts on the chart with nothing posted to them.
export async function importOpeningBalances(orgId, { asOfDate, rows, postedByUserId = null }) {
  const { matches, unresolved, balances, totalDebitCents, totalCreditCents } = await resolveRows(orgId, rows);

  if (unresolved.length) throw new LedgerError(unresolvedMessage(unresolved));
  if (!balances) {
    throw new LedgerError(
      `This file doesn't balance: debits total ${centsToDollars(totalDebitCents)}, credits total ` +
        `${centsToDollars(totalCreditCents)}. Fix the export and try again.`
    );
  }

  const createdAccountIds = [];
  const lines = [];
  for (const { row, existingAccountId } of matches) {
    let accountId = existingAccountId;
    if (!accountId) {
      const account = await Account.create({ orgId, code: row.code, name: row.name, type: row.type });
      accountId = account.id;
      createdAccountIds.push(accountId);
    }
    lines.push({ accountId, debitCents: row.debitCents, creditCents: row.creditCents });
  }

  let entry;
  try {
    entry = await postJournalEntry(orgId, {
      entryDate: asOfDate,
      memo: "Opening balances imported",
      source: "opening_balance_import",
      postedByUserId,
      lines,
    });
  } catch (err) {
    if (createdAccountIds.length) await Account.destroy({ where: { id: createdAccountIds } });
    throw err;
  }

  return { entry, accountsCreated: createdAccountIds.length, accountsMatched: matches.length - createdAccountIds.length };
}
