import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A journal entry that has to be posted every period rather than once --
// the adjusting entries every close depends on and that nothing in this
// app automated before: depreciation, prepaid amortization, accrued
// interest, accrued wages, monthly rent under a lease.
//
// Modeled as a template plus a schedule rather than as N future-dated
// entries, because the entries themselves must not exist until they're
// posted. A pre-posted future entry would show up in a trial balance run
// today, and "the books contain next quarter's depreciation" is exactly
// the kind of thing that makes a statement wrong in a way nobody notices
// until an auditor does.
export const RECURRING_FREQUENCIES = ["monthly", "quarterly", "annually"];

export const RecurringEntry = sequelize.define(
  "RecurringEntry",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(256), allowNull: false },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    frequency: { type: DataTypes.ENUM(...RECURRING_FREQUENCIES), allowNull: false, defaultValue: "monthly" },
    // The first period this posts for. Every subsequent due date is
    // derived from this plus the frequency, so a run that was missed
    // stays due rather than being skipped -- same catch-up behavior
    // revenue recognition has, and for the same reason.
    startDate: { type: DataTypes.DATEONLY, allowNull: false },
    // Optional last period. A 36-month prepaid amortization ends; monthly
    // rent under an open-ended arrangement doesn't.
    endDate: { type: DataTypes.DATEONLY, allowNull: true },
    // The last period actually posted, as a date. Null until the first
    // run. Advanced only after a successful posting, so a refused period
    // (a closed month) leaves the template still due for it.
    lastPostedDate: { type: DataTypes.DATEONLY, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "recurring_entries",
    indexes: [{ fields: ["orgId"] }],
  }
);

// The template's lines. Same debit-XOR-credit shape as JournalLine and the
// same integer cents, because these become a real journal entry verbatim.
export const RecurringEntryLine = sequelize.define(
  "RecurringEntryLine",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    recurringEntryId: { type: DataTypes.STRING(32), allowNull: false },
    accountId: { type: DataTypes.STRING(32), allowNull: false },
    debitCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    creditCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "recurring_entry_lines",
    indexes: [{ fields: ["recurringEntryId"] }],
    timestamps: false,
  }
);
