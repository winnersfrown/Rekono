// Stockholders' equity: the owner-facing side of the balance sheet, and
// the statement that explains how it moved.
//
// Every one of these postings is expressible as a raw journal entry, and
// always has been. What was missing is *classification*. A credit to an
// equity account tells you equity went up; it does not tell you whether
// that was a capital contribution, a share issuance, or a treasury
// reissue -- and those are three different lines on a statement of
// stockholders' equity. So each event is recorded with its type and then
// posted through ledger.js like everything else.
//
// The account set follows the standard corporate layout, with the two
// contra-equity accounts (Treasury Stock, Distributions) carrying debit
// balances. Nothing special is needed to make those reduce equity:
// financialStatements.js already computes an equity account's normal
// balance as credit minus debit, so a debit-balance equity account shows
// negative and subtracts on its own.

import { Op } from "sequelize";
import { LedgerError, centsToDollars, postJournalEntry, voidJournalEntry } from "./ledger.js";
import { Account, EquityTransaction, JournalEntry, JournalLine } from "./models/index.js";
// Retained Earnings is owned by yearEndClose.js, which creates it for the
// year-end close. Reusing that rather than redefining it here keeps one
// definition of the account -- two would race to create it under
// different codes and leave an org with two Retained Earnings lines.
import { ensureRetainedEarningsAccount } from "./yearEndClose.js";

export const EQUITY_SUBTYPES = {
  COMMON_STOCK: "common_stock",
  APIC: "additional_paid_in_capital",
  RETAINED_EARNINGS: "retained_earnings",
  TREASURY_STOCK: "treasury_stock",
  DISTRIBUTIONS: "distributions",
};

export const DIVIDENDS_PAYABLE_SUBTYPE = "dividends_payable";

// Created on demand rather than only at onboarding: an org that signed up
// before this release has none of these, and its first contribution
// shouldn't fail because of when it joined. Same approach
// ensureDeferredRevenueAccount and ensureRetainedEarningsAccount take.
const ON_DEMAND_ACCOUNTS = {
  [EQUITY_SUBTYPES.COMMON_STOCK]: { code: "3100", name: "Common Stock", type: "equity" },
  [EQUITY_SUBTYPES.APIC]: { code: "3150", name: "Additional Paid-In Capital", type: "equity" },
  [EQUITY_SUBTYPES.TREASURY_STOCK]: { code: "3300", name: "Treasury Stock", type: "equity" },
  [EQUITY_SUBTYPES.DISTRIBUTIONS]: { code: "3400", name: "Distributions", type: "equity" },
  [DIVIDENDS_PAYABLE_SUBTYPE]: { code: "2300", name: "Dividends Payable", type: "liability" },
};

export async function ensureAccount(orgId, subtype) {
  const spec = ON_DEMAND_ACCOUNTS[subtype];
  if (!spec) throw new LedgerError(`Unknown account subtype: ${subtype}`);
  const existing = await Account.findOne({ where: { orgId, type: spec.type, subtype } });
  if (existing) return existing;
  return Account.create({ orgId, ...spec, subtype, isSystemAccount: true });
}

// Owner's Equity (3000) is seeded for every org and is where an
// unincorporated contribution lands -- a sole proprietor or LLC member
// putting money in has no par value and no shares to split against.
async function ownersEquityAccount(orgId) {
  const account = await Account.findOne({ where: { orgId, type: "equity", code: "3000" } });
  if (!account) throw new LedgerError("No Owner's Equity account found in the chart of accounts.", 409);
  return account;
}

async function requireCashAccount(orgId, cashAccountId, label) {
  const account = await Account.findOne({ where: { id: cashAccountId, orgId } });
  // Assets and liabilities both work: money can come from a bank account
  // or go onto a credit line. Equity accounts are refused -- funding a
  // contribution "from" equity is circular and moves nothing real.
  if (!account || !["asset", "liability"].includes(account.type)) {
    throw new LedgerError(`${label} must be an asset or liability account you own.`);
  }
  return account;
}

// The current balance of one account, in its normal direction. Used by the
// treasury reissue waterfall, which has to know how much Additional
// Paid-In Capital is actually available before charging a shortfall
// against retained earnings.
export async function accountBalanceCents(orgId, accountId, { asOf = null } = {}) {
  const entryWhere = { orgId };
  if (asOf) entryWhere.entryDate = { [Op.lte]: asOf };
  const entries = await JournalEntry.findAll({ where: entryWhere, attributes: ["id"], raw: true });
  if (!entries.length) return 0;

  const lines = await JournalLine.findAll({
    where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) }, accountId },
    attributes: ["debitCents", "creditCents"],
    raw: true,
  });
  return lines.reduce((sum, l) => sum + l.creditCents - l.debitCents, 0);
}

// Builds the journal lines for one equity event. Split out from the
// posting so the routes can validate and preview without writing.
async function buildLines(orgId, { type, amountCents, cashAccountId, shares, parValueMicros, costBasisCents }) {
  switch (type) {
    case "contribution": {
      const cash = await requireCashAccount(orgId, cashAccountId, "The account the money arrived in");

      // A share issuance splits par from premium; a plain capital
      // injection doesn't. Which one this is comes from whether shares and
      // a par value were given, rather than from an org-level "are you a
      // corporation" flag -- the same company can do both.
      if (shares && parValueMicros !== null && parValueMicros !== undefined) {
        // Multiply first, round once. 1,000,000 shares at $0.001 par is
        // $1,000 of par -- but converting $0.001 to cents first gives zero
        // and loses the whole thing, which is why par is carried in
        // millionths (10,000 micros to the cent).
        const parTotal = Math.round((shares * parValueMicros) / 10000);
        if (parTotal > amountCents) {
          // Issuing below par is prohibited in most jurisdictions and
          // would produce a negative APIC, which is not a thing.
          throw new LedgerError("Shares can't be issued below par value.");
        }
        const [commonStock, apic] = await Promise.all([
          ensureAccount(orgId, EQUITY_SUBTYPES.COMMON_STOCK),
          ensureAccount(orgId, EQUITY_SUBTYPES.APIC),
        ]);
        // True no-par stock (or par so small it rounds under a cent across
        // the whole issuance) puts everything in Common Stock. Emitting a
        // zero-value par line instead would be rejected by the ledger,
        // which requires every line to be a debit or a credit.
        if (parTotal === 0) {
          return [
            { accountId: cash.id, debitCents: amountCents },
            { accountId: commonStock.id, creditCents: amountCents },
          ];
        }
        const lines = [
          { accountId: cash.id, debitCents: amountCents },
          { accountId: commonStock.id, creditCents: parTotal },
        ];
        if (amountCents > parTotal) lines.push({ accountId: apic.id, creditCents: amountCents - parTotal });
        return lines;
      }

      const equity = await ownersEquityAccount(orgId);
      return [
        { accountId: cash.id, debitCents: amountCents },
        { accountId: equity.id, creditCents: amountCents },
      ];
    }

    case "distribution": {
      const cash = await requireCashAccount(orgId, cashAccountId, "The account the money left from");
      const distributions = await ensureAccount(orgId, EQUITY_SUBTYPES.DISTRIBUTIONS);
      // Debited to a contra-equity account rather than straight to
      // Retained Earnings, so the year's distributions stay visible as
      // their own line instead of disappearing into the earnings balance.
      return [
        { accountId: distributions.id, debitCents: amountCents },
        { accountId: cash.id, creditCents: amountCents },
      ];
    }

    case "dividend_declared": {
      // Declaring creates the obligation; no cash moves until it's paid.
      // Splitting the two is the whole reason both types exist -- a
      // declared-but-unpaid dividend is a liability the balance sheet
      // has to show.
      const [distributions, payable] = await Promise.all([
        ensureAccount(orgId, EQUITY_SUBTYPES.DISTRIBUTIONS),
        ensureAccount(orgId, DIVIDENDS_PAYABLE_SUBTYPE),
      ]);
      return [
        { accountId: distributions.id, debitCents: amountCents },
        { accountId: payable.id, creditCents: amountCents },
      ];
    }

    case "dividend_paid": {
      const cash = await requireCashAccount(orgId, cashAccountId, "The account the money left from");
      const payable = await ensureAccount(orgId, DIVIDENDS_PAYABLE_SUBTYPE);
      return [
        { accountId: payable.id, debitCents: amountCents },
        { accountId: cash.id, creditCents: amountCents },
      ];
    }

    case "treasury_purchase": {
      const cash = await requireCashAccount(orgId, cashAccountId, "The account the money left from");
      const treasury = await ensureAccount(orgId, EQUITY_SUBTYPES.TREASURY_STOCK);
      // Cost method: the buyback is carried at what was paid, full stop.
      // No gain or loss is recognized on a company's own shares -- that
      // would let a company book profit by trading in itself.
      return [
        { accountId: treasury.id, debitCents: amountCents },
        { accountId: cash.id, creditCents: amountCents },
      ];
    }

    case "treasury_reissue": {
      const cash = await requireCashAccount(orgId, cashAccountId, "The account the money arrived in");
      const [treasury, apic, retained] = await Promise.all([
        ensureAccount(orgId, EQUITY_SUBTYPES.TREASURY_STOCK),
        ensureAccount(orgId, EQUITY_SUBTYPES.APIC),
        ensureRetainedEarningsAccount(orgId),
      ]);

      const cost = costBasisCents;
      const lines = [
        { accountId: cash.id, debitCents: amountCents },
        { accountId: treasury.id, creditCents: cost },
      ];

      if (amountCents > cost) {
        // Sold above cost: the excess is paid-in capital, never income.
        lines.push({ accountId: apic.id, creditCents: amountCents - cost });
      } else if (amountCents < cost) {
        // Sold below cost: the shortfall is charged against paid-in
        // capital first and only against retained earnings once that runs
        // out. Charging retained earnings first would understate
        // accumulated profit while leaving APIC that exists precisely to
        // absorb this.
        const shortfall = cost - amountCents;
        const apicAvailable = Math.max(await accountBalanceCents(orgId, apic.id), 0);
        const fromApic = Math.min(shortfall, apicAvailable);
        if (fromApic > 0) lines.push({ accountId: apic.id, debitCents: fromApic });
        if (shortfall > fromApic) lines.push({ accountId: retained.id, debitCents: shortfall - fromApic });
      }
      return lines;
    }

    default:
      throw new LedgerError(`Unknown equity transaction type: ${type}`);
  }
}

const MEMO_BY_TYPE = {
  contribution: "Capital contribution",
  distribution: "Distribution to owners",
  dividend_declared: "Dividend declared",
  dividend_paid: "Dividend paid",
  treasury_purchase: "Treasury stock purchased",
  treasury_reissue: "Treasury stock reissued",
};

// Which journal an equity event belongs in. "dividend_declared" just
// recognizes a liability -- no cash moves, so it's the one type that stays
// on the general journal's default "equity_transaction" source. Every other
// type either brings cash in or pays it out, so each gets its own source
// value to route into the cash receipts/cash payments journals
// (routes/journalEntries.js's SPECIAL_JOURNAL_SOURCES) instead.
const JOURNAL_SOURCE_BY_TYPE = {
  contribution: "equity_contribution",
  distribution: "equity_distribution",
  dividend_declared: "equity_transaction",
  dividend_paid: "equity_dividend_paid",
  treasury_purchase: "equity_treasury_purchase",
  treasury_reissue: "equity_treasury_reissue",
};

// Records the event and posts it, unwinding the row if the ledger refuses.
// Same shape as recordBillPayment: the row has to exist before the entry
// can name it as its source, so a refused posting has to delete it rather
// than leave a transaction the ledger never saw.
export async function recordEquityTransaction(orgId, input, { postedByUserId = null } = {}) {
  const lines = await buildLines(orgId, { ...input, orgId });

  const transaction = await EquityTransaction.create({
    orgId,
    type: input.type,
    transactionDate: input.transactionDate,
    amountCents: input.amountCents,
    cashAccountId: input.cashAccountId || null,
    shares: input.shares ?? null,
    parValueMicros: input.parValueMicros ?? null,
    costBasisCents: input.costBasisCents ?? null,
    memo: input.memo || "",
  });

  let entry;
  try {
    entry = await postJournalEntry(orgId, {
      entryDate: input.transactionDate,
      memo: input.memo || MEMO_BY_TYPE[input.type],
      source: JOURNAL_SOURCE_BY_TYPE[input.type],
      sourceType: "equity_transaction",
      sourceId: transaction.id,
      postedByUserId,
      lines,
    });
  } catch (err) {
    await transaction.destroy();
    throw err;
  }

  transaction.journalEntryId = entry.id;
  await transaction.save();
  return { transaction, entry };
}

// Reverses an equity transaction. The record is kept and its entry voided,
// rather than deleted -- an owner distribution that happened and was
// corrected is history someone may need to explain.
export async function voidEquityTransaction(orgId, id, { postedByUserId = null } = {}) {
  const transaction = await EquityTransaction.findOne({ where: { id, orgId } });
  if (!transaction) return null;

  const entry = await JournalEntry.findOne({
    where: { orgId, sourceType: "equity_transaction", sourceId: id, status: "posted" },
  });
  if (entry) await voidJournalEntry(orgId, entry.id, { postedByUserId });
  return transaction;
}

export function serializeEquityTransaction(t, accountsById = null) {
  return {
    id: t.id,
    type: t.type,
    transaction_date: t.transactionDate,
    amount: centsToDollars(t.amountCents),
    cash_account_id: t.cashAccountId,
    cash_account_name: t.cashAccountId ? accountsById?.get(t.cashAccountId)?.name : null,
    shares: t.shares,
    par_value: t.parValueMicros === null ? null : t.parValueMicros / 1000000,
    cost_basis: t.costBasisCents === null ? null : centsToDollars(t.costBasisCents),
    memo: t.memo,
    journal_entry_id: t.journalEntryId,
  };
}
