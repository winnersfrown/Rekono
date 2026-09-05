// SAFEs and convertible notes: cash an investor put in before there was a
// priced round to price it against.
//
// Neither instrument is equity on the day it's issued -- a SAFE holder
// isn't a shareholder yet and a note holder is a creditor, not an owner --
// so the investment books as a liability (Convertible Notes & SAFEs
// Payable) and stays there until one of two things happens: it converts,
// which extinguishes the liability and issues shares (equity.js's
// "safe_conversion" plus a share register "issue", exactly the two ledgers
// a priced-round issuance already touches), or it's repaid in cash instead,
// which is a plain liability payoff with nothing equity about it.
//
// What this module deliberately does not do: derive a conversion price. A
// valuation cap and a discount are terms, not a number -- turning them into
// a price-per-share means knowing the round's price and the company's
// fully-diluted share count *as the SAFE itself defines "capitalization,"*
// which is genuinely contested even between two SAFEs from the same
// financing. incomeTax.js and stockCompensation.js already draw this same
// line for tax rates and fair values: book what the user brings, refuse to
// guess. The cap and discount are kept here for reference; the conversion
// price and share count come from the round's own paperwork.

import { LedgerError, centsToDollars, postJournalEntry, voidJournalEntry } from "./ledger.js";
import { recordEquityTransaction, voidEquityTransaction } from "./equity.js";
import { recordShareTransaction } from "./shareRegister.js";
import { Account, ConvertibleInstrument, Shareholder } from "./models/index.js";

const CONVERTIBLE_NOTES_PAYABLE_SUBTYPE = "convertible_notes_payable";

export async function ensureConvertibleNotesPayableAccount(orgId) {
  const existing = await Account.findOne({ where: { orgId, type: "liability", subtype: CONVERTIBLE_NOTES_PAYABLE_SUBTYPE } });
  if (existing) return existing;
  return Account.create({
    orgId,
    code: "2250",
    name: "Convertible Notes & SAFEs Payable",
    type: "liability",
    subtype: CONVERTIBLE_NOTES_PAYABLE_SUBTYPE,
    isSystemAccount: true,
  });
}

async function requireOutstanding(orgId, id) {
  const instrument = await ConvertibleInstrument.findOne({ where: { id, orgId } });
  if (!instrument) throw new LedgerError("Convertible instrument not found.", 404);
  if (instrument.status !== "outstanding") {
    throw new LedgerError(`This instrument is already ${instrument.status}, not outstanding.`);
  }
  return instrument;
}

// Records the issuance: cash in, a liability recognized. Same
// create-then-post-then-unwind-on-failure shape as recordEquityTransaction,
// because the row has to exist before the journal entry can name it as its
// source.
export async function recordIssuance(orgId, input, { postedByUserId = null } = {}) {
  const holder = await Shareholder.findOne({ where: { id: input.shareholderId, orgId } });
  if (!holder) throw new LedgerError("That investor is not a shareholder on file yet -- add them first.", 404);

  const [cash, liability] = await Promise.all([
    Account.findOne({ where: { id: input.cashAccountId, orgId } }),
    ensureConvertibleNotesPayableAccount(orgId),
  ]);
  if (!cash || cash.type !== "asset") {
    throw new LedgerError("The account the investment arrived in must be an asset account you own.");
  }

  const instrument = await ConvertibleInstrument.create({
    orgId,
    shareholderId: input.shareholderId,
    instrumentType: input.instrumentType,
    safeType: input.safeType ?? null,
    issueDate: input.issueDate,
    principalCents: input.principalCents,
    valuationCapCents: input.valuationCapCents ?? null,
    discountRatePercent: input.discountRatePercent ?? null,
    interestRatePercent: input.interestRatePercent ?? null,
    maturityDate: input.maturityDate ?? null,
    cashAccountId: input.cashAccountId,
    memo: input.memo || "",
  });

  let entry;
  try {
    entry = await postJournalEntry(orgId, {
      entryDate: input.issueDate,
      memo: input.memo || `${input.instrumentType === "safe" ? "SAFE" : "Convertible note"} issued to ${holder.name}`,
      source: "convertible_instrument_issued",
      sourceType: "convertible_instrument",
      sourceId: instrument.id,
      postedByUserId,
      lines: [
        { accountId: cash.id, debitCents: input.principalCents },
        { accountId: liability.id, creditCents: input.principalCents },
      ],
    });
  } catch (err) {
    await instrument.destroy();
    throw err;
  }

  instrument.journalEntryId = entry.id;
  await instrument.save();
  return { instrument, entry };
}

// Converts the instrument in full: the liability is extinguished, Common
// Stock and APIC are credited for the same principal, and the resulting
// shares land on the holder's position in the register -- the same two
// postings, in the same order, that a priced-round issuance already makes
// through recordEquityTransaction/recordShareTransaction. `shares` and
// `parValueMicros` come from the caller because they come from the round's
// own paperwork, not from anything this app derives.
export async function recordConversion(orgId, id, input, { postedByUserId = null } = {}) {
  const instrument = await requireOutstanding(orgId, id);
  const liability = await ensureConvertibleNotesPayableAccount(orgId);

  const { transaction: equityTransaction } = await recordEquityTransaction(
    orgId,
    {
      type: "safe_conversion",
      transactionDate: input.transactionDate,
      amountCents: instrument.principalCents,
      cashAccountId: liability.id,
      shares: input.shares,
      parValueMicros: input.parValueMicros,
      memo: input.memo || `Conversion of ${instrument.instrumentType === "safe" ? "SAFE" : "convertible note"}`,
    },
    { postedByUserId }
  );

  let shareTransaction;
  try {
    shareTransaction = await recordShareTransaction(orgId, {
      type: "issue",
      shareClassId: input.shareClassId,
      transactionDate: input.transactionDate,
      shares: input.shares,
      toShareholderId: instrument.shareholderId,
      equityTransactionId: equityTransaction.id,
      memo: input.memo || "",
    });
  } catch (err) {
    // The equity transaction posted successfully but the share movement it
    // was meant to fund didn't -- unwind it the same way a refused posting
    // unwinds its transaction row, so the instrument isn't left half
    // converted with a liability that's gone and no shares to show for it.
    await voidEquityTransaction(orgId, equityTransaction.id, { postedByUserId });
    throw err;
  }

  instrument.status = "converted";
  instrument.conversionEquityTransactionId = equityTransaction.id;
  instrument.conversionShareTransactionId = shareTransaction.id;
  await instrument.save();

  return { instrument, equityTransaction, shareTransaction };
}

// Repays the instrument in cash instead of converting it -- a note past
// maturity that the company pays off rather than the holder extending or
// converting. A plain liability payoff, not an equity event, so it posts
// directly rather than through equity.js.
export async function recordRepayment(orgId, id, input, { postedByUserId = null } = {}) {
  const instrument = await requireOutstanding(orgId, id);
  const [cash, liability] = await Promise.all([
    Account.findOne({ where: { id: input.cashAccountId, orgId } }),
    ensureConvertibleNotesPayableAccount(orgId),
  ]);
  if (!cash || cash.type !== "asset") {
    throw new LedgerError("The account the repayment left from must be an asset account you own.");
  }

  const entry = await postJournalEntry(orgId, {
    entryDate: input.transactionDate,
    memo: input.memo || `Repayment of convertible note`,
    source: "convertible_instrument_repaid",
    sourceType: "convertible_instrument",
    sourceId: instrument.id,
    postedByUserId,
    lines: [
      { accountId: liability.id, debitCents: input.amountCents },
      { accountId: cash.id, creditCents: input.amountCents },
    ],
  });

  instrument.status = "repaid";
  instrument.repaymentJournalEntryId = entry.id;
  await instrument.save();
  return { instrument, entry };
}

// Voids the issuance -- an instrument entered by mistake, before it ever
// converted or was repaid. The record stays, like every other voided
// financial record; only "outstanding" is reversible this way, because a
// converted instrument's shares are already on the register and a repaid
// one's cash has already gone out the door.
export async function voidIssuance(orgId, id, { postedByUserId = null } = {}) {
  const instrument = await requireOutstanding(orgId, id);
  if (instrument.journalEntryId) {
    await voidJournalEntry(orgId, instrument.journalEntryId, { postedByUserId });
  }
  instrument.status = "voided";
  await instrument.save();
  return instrument;
}

export function serializeConvertibleInstrument(i, { shareholdersById = null, accountsById = null } = {}) {
  return {
    id: i.id,
    shareholder_id: i.shareholderId,
    shareholder_name: shareholdersById?.get(i.shareholderId)?.name ?? null,
    instrument_type: i.instrumentType,
    safe_type: i.safeType,
    issue_date: i.issueDate,
    principal: centsToDollars(i.principalCents),
    valuation_cap: i.valuationCapCents === null ? null : centsToDollars(i.valuationCapCents),
    discount_rate_percent: i.discountRatePercent,
    interest_rate_percent: i.interestRatePercent,
    maturity_date: i.maturityDate,
    cash_account_id: i.cashAccountId,
    cash_account_name: accountsById?.get(i.cashAccountId)?.name ?? null,
    status: i.status,
    journal_entry_id: i.journalEntryId,
    conversion_equity_transaction_id: i.conversionEquityTransactionId,
    conversion_share_transaction_id: i.conversionShareTransactionId,
    repayment_journal_entry_id: i.repaymentJournalEntryId,
    memo: i.memo,
  };
}
