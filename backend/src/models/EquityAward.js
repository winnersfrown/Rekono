import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A board-authorized reserve of shares set aside for employee equity --
// the "2026 Stock Plan" on a term sheet.
//
// The reserve is not issued stock. Nothing in the share register moves when
// a plan is created, and nothing moves when a grant is made out of it:
// shares become real only on exercise. That gap is the entire reason
// outstanding and fully-diluted are different numbers, and it's why the
// pool lives here rather than as some flavour of ShareTransaction.
export const EquityPlan = sequelize.define(
  "EquityPlan",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(128), allowNull: false },
    shareClassId: { type: DataTypes.STRING(32), allowNull: false },
    // Increased by a board amendment, never edited down below what's
    // already granted -- see equityAwards.js.
    reservedShares: { type: DataTypes.INTEGER, allowNull: false },
    adoptedDate: { type: DataTypes.DATEONLY, allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "equity_plans",
    indexes: [{ fields: ["orgId"] }],
  }
);

// Options are the common case; RSUs settle rather than being exercised for
// cash, and warrants are the same instrument granted to an investor or
// lender instead of an employee. All three dilute identically, which is
// what this table is for -- the differences are tax treatment, which
// Rekono deliberately does not compute (see README on the tax provision).
export const EQUITY_AWARD_TYPES = ["option", "rsu", "warrant"];

// A grant. Not a share transaction: granting issues nothing.
export const EquityAward = sequelize.define(
  "EquityAward",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    equityPlanId: { type: DataTypes.STRING(32), allowNull: false },
    // The recipient, reusing the register's Shareholder table rather than
    // standing up a parallel person table. A grantee isn't a shareholder
    // yet -- that's exactly what exercising makes them -- but they are a
    // name on the cap table from the grant date, and two tables of people
    // would need reconciling to each other the first time someone is both.
    shareholderId: { type: DataTypes.STRING(32), allowNull: false },
    type: { type: DataTypes.ENUM(...EQUITY_AWARD_TYPES), allowNull: false, defaultValue: "option" },
    grantDate: { type: DataTypes.DATEONLY, allowNull: false },
    shares: { type: DataTypes.INTEGER, allowNull: false },
    // What the holder pays per share to exercise. Millionths of a dollar
    // for the same reason par value is: a sub-cent strike is ordinary at
    // the seed stage and rounds to zero in cents. Null on an RSU, which
    // has no exercise price at all.
    strikePriceMicros: { type: DataTypes.INTEGER, allowNull: true },

    // Vesting is described, not enumerated. A row per vesting month would
    // be a stored copy of something a function computes exactly, and rows
    // for months that haven't happened are claims about the future -- the
    // same reason recurringEntries.js keeps a template and a schedule
    // instead of pre-writing future journal entries.
    vestingStartDate: { type: DataTypes.DATEONLY, allowNull: false },
    vestingMonths: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 48 },
    // Nothing vests until the cliff, then everything earned up to it vests
    // at once. Zero means no cliff, which is normal for a founder or an
    // advisor.
    cliffMonths: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 12 },

    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
  },
  {
    tableName: "equity_awards",
    indexes: [{ fields: ["orgId"] }, { fields: ["equityPlanId"] }, { fields: ["shareholderId"] }],
  }
);

// What happened to part of an award. Kept as events against the award
// rather than as columns on it, because an award is exercised in pieces far
// more often than all at once -- a single `exercisedShares` counter loses
// the dates, and the dates are what a 409A valuation and an ISO holding
// period are both computed from.
export const AWARD_EVENT_TYPES = ["exercise", "cancel"];

export const AwardEvent = sequelize.define(
  "AwardEvent",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    equityAwardId: { type: DataTypes.STRING(32), allowNull: false },
    type: { type: DataTypes.ENUM(...AWARD_EVENT_TYPES), allowNull: false },
    eventDate: { type: DataTypes.DATEONLY, allowNull: false },
    shares: { type: DataTypes.INTEGER, allowNull: false },
    // The share issuance an exercise produced. Null on a cancellation,
    // which issues nothing -- it hands shares back to the pool.
    shareTransactionId: { type: DataTypes.STRING(32), allowNull: true },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
  },
  {
    tableName: "award_events",
    indexes: [{ fields: ["orgId"] }, { fields: ["equityAwardId"] }],
  }
);
