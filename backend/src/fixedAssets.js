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
import { LedgerError, centsToDollars, dollarsToCents } from "./ledger.js";
import { accountsExist, dueDates, straightLineDepreciationCents } from "./recurringEntries.js";
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
  const { name, costCents, salvageCents, usefulLifeMonths, acquisitionDate, assetAccountId, expenseAccountId, accumulatedDepreciationAccountId } = data;

  if (!(await accountsExist(orgId, [assetAccountId, expenseAccountId, accumulatedDepreciationAccountId]))) {
    throw new LedgerError("The asset, expense, and accumulated depreciation accounts must all be ones you own.");
  }
  const assetAccount = await Account.findOne({ where: { id: assetAccountId, orgId } });
  if (assetAccount.type !== "asset") {
    throw new LedgerError("The asset account must be an asset-type account.");
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
  });
}

// Accumulated depreciation as the ledger actually shows it -- summed from
// posted journal lines against this asset's own RecurringEntry, not from
// schedule math. Depreciation isn't automatic (running due entries is a
// separate action, same as every other adjusting entry), so a schedule-math
// figure would claim depreciation that hasn't been posted yet. Same
// argument as vestedShares being computed rather than stored: the true
// answer is derived from what already happened, never projected forward.
export async function accumulatedDepreciationCents(fixedAsset) {
  const entries = await JournalEntry.findAll({
    where: { orgId: fixedAsset.orgId, sourceType: "recurring_entry", sourceId: fixedAsset.recurringEntryId },
    attributes: ["id"],
    raw: true,
  });
  if (!entries.length) return 0;

  const lines = await JournalLine.findAll({
    where: { journalEntryId: { [Op.in]: entries.map((e) => e.id) }, accountId: fixedAsset.accumulatedDepreciationAccountId },
    attributes: ["debitCents", "creditCents"],
    raw: true,
  });
  return lines.reduce((sum, l) => sum + l.creditCents - l.debitCents, 0);
}

export async function serializeFixedAsset(fixedAsset, recurringEntry = null) {
  const template = recurringEntry || (await RecurringEntry.findByPk(fixedAsset.recurringEntryId));
  const accumulatedCents = await accumulatedDepreciationCents(fixedAsset);
  const depreciableCents = fixedAsset.costCents - fixedAsset.salvageCents;

  return {
    id: fixedAsset.id,
    name: fixedAsset.name,
    asset_account_id: fixedAsset.assetAccountId,
    expense_account_id: fixedAsset.expenseAccountId,
    accumulated_depreciation_account_id: fixedAsset.accumulatedDepreciationAccountId,
    recurring_entry_id: fixedAsset.recurringEntryId,
    acquisition_date: fixedAsset.acquisitionDate,
    method: fixedAsset.method,
    cost: centsToDollars(fixedAsset.costCents),
    salvage_value: centsToDollars(fixedAsset.salvageCents),
    useful_life_months: fixedAsset.usefulLifeMonths,
    monthly_amount: centsToDollars(straightLineDepreciationCents(fixedAsset.costCents, fixedAsset.salvageCents, fixedAsset.usefulLifeMonths)),
    accumulated_depreciation: centsToDollars(accumulatedCents),
    book_value: centsToDollars(fixedAsset.costCents - accumulatedCents),
    fully_depreciated: accumulatedCents >= depreciableCents,
    active: template?.active ?? true,
    next_due: template ? dueDates(template, new Date().toISOString().slice(0, 10))[0] || null : null,
  };
}

export function dollarsToFixedAssetCents({ cost, salvage_value = 0 }) {
  return { costCents: dollarsToCents(cost), salvageCents: dollarsToCents(salvage_value) };
}
