// Fixed assets: a cost/salvage/useful-life record that owns the
// RecurringEntry which actually posts its depreciation. See
// models/FixedAsset.js for why this exists (routes/adjustments.js's old
// one-shot /recurring-entries/depreciation calculator discarded these
// inputs after building the template).
//
// This file deliberately does not duplicate any ledger-posting logic --
// creating a FixedAsset builds a RecurringEntry the exact same way the
// calculator it replaces did, and depreciation still posts through
// recurringEntries.js's runRecurringEntries like every other adjusting
// entry. All this adds is the record and the account-tied bookkeeping
// around it.

import { Op } from "sequelize";
import { LedgerError, centsToDollars, dollarsToCents, postJournalEntry } from "./ledger.js";
import { accountsExist, addMonthsClamped, dueDates, straightLineDepreciationCents } from "./recurringEntries.js";
import { Account, FixedAsset, JournalEntry, JournalLine, RecurringEntry, RecurringEntryLine } from "./models/index.js";

function addMonthsClampedEnd(startDate, usefulLifeMonths) {
  // Ends one month before the (n+1)th occurrence, i.e. after exactly
  // usefulLifeMonths postings -- the asset is fully depreciated the month
  // its life runs out, not one month short or one month over.
  const d = new Date(`${startDate}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (usefulLifeMonths - 1), 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = String(Math.min(d.getUTCDate(), lastDay)).padStart(2, "0");
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${day}`;
}

export async function createFixedAsset(orgId, data) {
  const {
    name,
    costCents,
    salvageCents,
    usefulLifeMonths,
    acquisitionDate,
    assetAccountId,
    expenseAccountId,
    accumulatedDepreciationAccountId,
    method = "straight_line",
    decliningBalanceRatePercent = null,
  } = data;

  if (!(await accountsExist(orgId, [assetAccountId, expenseAccountId, accumulatedDepreciationAccountId]))) {
    throw new LedgerError("The asset, expense, and accumulated depreciation accounts must all be ones you own.");
  }
  const assetAccount = await Account.findOne({ where: { id: assetAccountId, orgId } });
  if (assetAccount.type !== "asset") {
    throw new LedgerError("The asset account must be an asset-type account.");
  }

  if (method === "declining_balance") {
    if (!(decliningBalanceRatePercent > 0)) {
      throw new LedgerError("Enter the declining-balance rate you want applied (e.g. 200 for double-declining).");
    }
    // No RecurringEntry: a declining-balance asset's amount changes every
    // period, so it posts through its own action (runDecliningBalanceDepreciation)
    // rather than a fixed-amount template.
    return FixedAsset.create({
      orgId,
      name,
      assetAccountId,
      expenseAccountId,
      accumulatedDepreciationAccountId,
      acquisitionDate,
      costCents,
      salvageCents,
      usefulLifeMonths,
      method,
      decliningBalanceRatePercent,
    });
  }

  const monthlyCents = straightLineDepreciationCents(costCents, salvageCents, usefulLifeMonths);
  if (monthlyCents <= 0) {
    throw new LedgerError("That works out to less than a cent a month.");
  }

  const recurringEntry = await RecurringEntry.create({
    orgId,
    name,
    memo: `Depreciation -- ${name}`,
    frequency: "monthly",
    startDate: acquisitionDate,
    endDate: addMonthsClampedEnd(acquisitionDate, usefulLifeMonths),
  });
  await RecurringEntryLine.bulkCreate([
    { recurringEntryId: recurringEntry.id, accountId: expenseAccountId, debitCents: monthlyCents, position: 0 },
    { recurringEntryId: recurringEntry.id, accountId: accumulatedDepreciationAccountId, creditCents: monthlyCents, position: 1 },
  ]);

  return FixedAsset.create({
    orgId,
    name,
    assetAccountId,
    expenseAccountId,
    accumulatedDepreciationAccountId,
    recurringEntryId: recurringEntry.id,
    acquisitionDate,
    costCents,
    salvageCents,
    usefulLifeMonths,
    method,
  });
}

// Every date this asset's declining-balance schedule is due for, up to and
// including asOf and not yet posted -- same shape as recurringEntries.js's
// dueDates, but derived from usefulLifeMonths directly since there's no
// RecurringEntry.endDate to read it from.
export function decliningBalanceDueDates(fixedAsset, asOf) {
  const dates = [];
  for (let i = 0; i < fixedAsset.usefulLifeMonths; i++) {
    dates.push(addMonthsClamped(fixedAsset.acquisitionDate, i));
  }
  return dates.filter((d) => d <= asOf && (!fixedAsset.lastDepreciationDate || d > fixedAsset.lastDepreciationDate));
}

// One period's declining-balance expense: the rate applied to whatever
// book value is left, monthly, floored so it never depreciates past
// salvage value -- the last period is whatever's left, not a full month's
// worth run past the floor.
export function decliningBalancePeriodCents(bookValueCents, salvageCents, ratePercent) {
  if (bookValueCents <= salvageCents) return 0;
  const raw = Math.round((bookValueCents * ratePercent) / 100 / 12);
  return Math.min(raw, bookValueCents - salvageCents);
}

// Accumulated depreciation as the ledger actually shows it -- summed from
// posted journal lines, not from schedule math. Depreciation isn't
// automatic (running due entries/depreciation is a separate action, same
// as every other adjusting entry), so a schedule-math figure would claim
// depreciation that hasn't been posted yet. Same argument as vestedShares
// being computed rather than stored: the true answer is derived from what
// already happened, never projected forward. A straight-line asset's
// entries are found via the RecurringEntry they were posted from; a
// declining-balance asset has no template, so its own id is the key
// instead (see runDecliningBalanceDepreciation).
export async function accumulatedDepreciationCents(fixedAsset) {
  const where =
    fixedAsset.method === "declining_balance"
      ? { orgId: fixedAsset.orgId, sourceType: "fixed_asset_depreciation", sourceId: fixedAsset.id }
      : { orgId: fixedAsset.orgId, sourceType: "recurring_entry", sourceId: fixedAsset.recurringEntryId };
  const entries = await JournalEntry.findAll({ where, attributes: ["id"], raw: true });
  if (!entries.length) return 0;

  const lines = await JournalLine.findAll({
    where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) }, accountId: fixedAsset.accumulatedDepreciationAccountId },
    attributes: ["debitCents", "creditCents"],
    raw: true,
  });
  return lines.reduce((sum, l) => sum + l.creditCents - l.debitCents, 0);
}

// Posts every due, not-yet-posted period for a declining-balance asset up
// through asOf, one journal entry per period. Each period's amount is
// computed from the accumulated balance the ledger actually shows right
// before it -- never from a running total kept in memory -- so posting
// out of order or catching up several missed months at once is always
// self-correcting instead of compounding drift.
export async function runDecliningBalanceDepreciation(orgId, fixedAssetId, asOf, { postedByUserId = null } = {}) {
  const asset = await FixedAsset.findOne({ where: { id: fixedAssetId, orgId } });
  if (!asset) throw new LedgerError("Fixed asset not found.", 404);
  if (asset.method !== "declining_balance") {
    throw new LedgerError("This asset doesn't use declining-balance depreciation.");
  }
  if (!asset.active) throw new LedgerError("This asset's depreciation is paused.");

  const dates = decliningBalanceDueDates(asset, asOf);
  const posted = [];
  for (const date of dates) {
    const accumulated = await accumulatedDepreciationCents(asset);
    const bookValueCents = asset.costCents - accumulated;
    const amountCents = decliningBalancePeriodCents(bookValueCents, asset.salvageCents, asset.decliningBalanceRatePercent);
    if (amountCents <= 0) break; // fully depreciated -- nothing left to post for this or any later period

    const entry = await postJournalEntry(orgId, {
      entryDate: date,
      memo: `Depreciation -- ${asset.name}`,
      source: "fixed_asset_depreciation",
      sourceType: "fixed_asset_depreciation",
      sourceId: asset.id,
      postedByUserId,
      lines: [
        { accountId: asset.expenseAccountId, debitCents: amountCents },
        { accountId: asset.accumulatedDepreciationAccountId, creditCents: amountCents },
      ],
    });
    asset.lastDepreciationDate = date;
    await asset.save();
    posted.push({ entry_date: date, journal_entry_id: entry.id, amount: centsToDollars(amountCents) });
  }
  return posted;
}

export async function serializeFixedAsset(fixedAsset, recurringEntry = null) {
  const template = fixedAsset.recurringEntryId ? recurringEntry || (await RecurringEntry.findByPk(fixedAsset.recurringEntryId)) : null;
  const accumulatedCents = await accumulatedDepreciationCents(fixedAsset);
  const depreciableCents = fixedAsset.costCents - fixedAsset.salvageCents;
  const bookValueCents = fixedAsset.costCents - accumulatedCents;
  const isDecliningBalance = fixedAsset.method === "declining_balance";
  const today = new Date().toISOString().slice(0, 10);

  return {
    id: fixedAsset.id,
    name: fixedAsset.name,
    asset_account_id: fixedAsset.assetAccountId,
    expense_account_id: fixedAsset.expenseAccountId,
    accumulated_depreciation_account_id: fixedAsset.accumulatedDepreciationAccountId,
    recurring_entry_id: fixedAsset.recurringEntryId ?? null,
    acquisition_date: fixedAsset.acquisitionDate,
    method: fixedAsset.method,
    declining_balance_rate_percent: fixedAsset.decliningBalanceRatePercent ?? null,
    cost: centsToDollars(fixedAsset.costCents),
    salvage_value: centsToDollars(fixedAsset.salvageCents),
    useful_life_months: fixedAsset.usefulLifeMonths,
    // The next period's amount -- fixed for straight-line, an estimate off
    // today's book value for declining-balance (it only becomes real once
    // actually posted).
    monthly_amount: centsToDollars(
      isDecliningBalance
        ? decliningBalancePeriodCents(bookValueCents, fixedAsset.salvageCents, fixedAsset.decliningBalanceRatePercent)
        : straightLineDepreciationCents(fixedAsset.costCents, fixedAsset.salvageCents, fixedAsset.usefulLifeMonths)
    ),
    accumulated_depreciation: centsToDollars(accumulatedCents),
    book_value: centsToDollars(bookValueCents),
    fully_depreciated: accumulatedCents >= depreciableCents,
    active: isDecliningBalance ? fixedAsset.active : template?.active ?? true,
    next_due: isDecliningBalance
      ? decliningBalanceDueDates(fixedAsset, today)[0] || null
      : template
      ? dueDates(template, today)[0] || null
      : null,
  };
}

export function dollarsToFixedAssetCents({ cost, salvage_value = 0 }) {
  return { costCents: dollarsToCents(cost), salvageCents: dollarsToCents(salvage_value) };
}
