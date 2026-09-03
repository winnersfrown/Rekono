import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Straight-line and declining-balance. Full MACRS -- the IRS's own
// recovery-period tables and half-year/mid-quarter conventions -- stays
// out of scope on purpose: that's a tax-filing lookup Rekono has no
// business guessing, the same reasoning incomeTax.js refuses to invent a
// tax rate. Declining-balance itself is just a different, real ledger
// calculation, not a tax concept -- the user supplies the rate (their own
// number, e.g. 200% for double-declining on whatever useful life they set)
// exactly the way salesTaxRatePercent is supplied rather than derived, and
// fixedAssets.js does the compounding.
export const DEPRECIATION_METHODS = ["straight_line", "declining_balance"];

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
    // touching what it already posted. Null for a declining_balance asset:
    // its monthly amount changes every period, which the recurring-entry
    // machinery has no way to express (every consumer of it -- accruals,
    // rent, straight-line depreciation -- posts the same fixed line amount
    // every occurrence), so it posts through its own dedicated action
    // instead (runDecliningBalanceDepreciation) rather than a template.
    recurringEntryId: { type: DataTypes.STRING(32), allowNull: true },
    acquisitionDate: { type: DataTypes.DATEONLY, allowNull: false },
    costCents: { type: DataTypes.INTEGER, allowNull: false },
    salvageCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    usefulLifeMonths: { type: DataTypes.INTEGER, allowNull: false },
    method: { type: DataTypes.ENUM(...DEPRECIATION_METHODS), allowNull: false, defaultValue: "straight_line" },
    // The annual rate a declining_balance asset applies to its book value
    // each period (e.g. 200 for double-declining) -- supplied, never
    // derived, same stance as Organization.salesTaxRatePercent. Null and
    // unused for straight_line.
    decliningBalanceRatePercent: { type: DataTypes.FLOAT, allowNull: true },
    // Tracks how far a declining_balance asset's own posting action has
    // caught up to -- the equivalent of RecurringEntry.lastPostedDate, kept
    // here instead since there's no template to keep it on.
    lastDepreciationDate: { type: DataTypes.DATEONLY, allowNull: true },
    // Pause/resume for a declining_balance asset, which has no
    // RecurringEntry.active to borrow (see routes/fixedAssets.js's PATCH).
    // Unused for straight_line, which still defers to its template's flag
    // so existing behavior there is unchanged.
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "fixed_assets",
    indexes: [{ fields: ["orgId"] }],
  }
);
