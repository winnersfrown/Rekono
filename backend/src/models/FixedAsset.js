import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Straight-line only, matching recurringEntries.js's straightLineDepreciationCents
// -- declining-balance and MACRS are tax concepts more than bookkeeping ones,
// and this file exists to remove the guesswork from the common case, not to
// add a second one by picking a method for the user.
export const DEPRECIATION_METHODS = ["straight_line"];

// A tracked fixed asset: cost, salvage value, useful life, and which three
// accounts its depreciation posts through. Before this, straight-line
// depreciation was a one-shot calculator (routes/adjustments.js's
// /recurring-entries/depreciation) that built a RecurringEntry template and
// then discarded the inputs that produced it -- nothing recorded that the
// asset existed, what it cost, or how much of its life was left. This is
// the record that was missing: a FixedAsset owns exactly one RecurringEntry
// (recurringEntryId) that actually posts the monthly entry, so the ledger
// integration is unchanged -- this only adds the bookkeeping in front of it.
export const FixedAsset = sequelize.define(
  "FixedAsset",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(256), allowNull: false },
    // The existing chart-of-accounts row that carries this asset's cost --
    // e.g. an "Office Equipment" account a purchase was already posted to.
    // Depreciation itself never touches this account (a proper entry only
    // moves Depreciation Expense and Accumulated Depreciation); it's kept
    // here so a fixed asset is a claim about a *specific* balance sheet
    // line, not just a number typed into a calculator.
    assetAccountId: { type: DataTypes.STRING(32), allowNull: false },
    expenseAccountId: { type: DataTypes.STRING(32), allowNull: false },
    accumulatedDepreciationAccountId: { type: DataTypes.STRING(32), allowNull: false },
    // The RecurringEntry this asset's creation built. Owned 1:1 -- deleting
    // the asset deletes its schedule (see fixedAssets.js), same as deleting
    // a RecurringEntry template directly stops future postings without
    // touching what it already posted.
    recurringEntryId: { type: DataTypes.STRING(32), allowNull: false },
    acquisitionDate: { type: DataTypes.DATEONLY, allowNull: false },
    costCents: { type: DataTypes.INTEGER, allowNull: false },
    salvageCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    usefulLifeMonths: { type: DataTypes.INTEGER, allowNull: false },
    method: { type: DataTypes.ENUM(...DEPRECIATION_METHODS), allowNull: false, defaultValue: "straight_line" },
  },
  {
    tableName: "fixed_assets",
    indexes: [{ fields: ["orgId"] }],
  }
);
