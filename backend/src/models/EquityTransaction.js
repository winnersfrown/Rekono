import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// An owner-facing equity event: money in from owners, money out to them, or
// the company trading in its own shares.
//
// These are all postable as raw journal entries already, so the point of a
// typed record isn't the posting -- it's that the statement of
// stockholders' equity cannot be built without one. A credit to an equity
// account tells you equity went up; it does not tell you whether that was
// a capital contribution, a stock issuance, or a reissue of treasury
// shares, and those are three different lines on the statement. The type
// is the thing a journal entry can't carry.
export const EQUITY_TRANSACTION_TYPES = [
  "contribution", // owners put capital in
  "distribution", // owners take capital out (an LLC/S-corp draw)
  "dividend_declared", // declared but not yet paid -- creates a payable
  "dividend_paid", // settles a previously declared dividend
  "treasury_purchase", // the company buys back its own shares
  "treasury_reissue", // and sells them on again
  "safe_conversion", // a SAFE/convertible note's principal becomes Common Stock + APIC
];

export const EquityTransaction = sequelize.define(
  "EquityTransaction",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    type: { type: DataTypes.ENUM(...EQUITY_TRANSACTION_TYPES), allowNull: false },
    transactionDate: { type: DataTypes.DATEONLY, allowNull: false },
    amountCents: { type: DataTypes.INTEGER, allowNull: false },
    // The account the money moved through -- or, for `safe_conversion`, the
    // liability account the principal converted out of. Null only for
    // `dividend_declared`, which moves no cash and touches no liability; it
    // only creates the obligation.
    cashAccountId: { type: DataTypes.STRING(32), allowNull: true },
    // Set together when a contribution is a share issuance rather than a
    // plain capital injection: the par portion lands in Common Stock and
    // everything above it in Additional Paid-In Capital, which is the
    // split that makes a corporation's equity section readable. Both null
    // means an unincorporated contribution, which credits Owner's Equity.
    shares: { type: DataTypes.INTEGER, allowNull: true },
    // Millionths of a dollar, not cents -- par value is routinely smaller
    // than one cent ($0.0001 is the Delaware default, $0.001 is common),
    // and rounding it to cents zeroes it out entirely. The journal entry
    // still posts in whole cents; only the per-share figure needs the
    // finer unit, because it gets multiplied by a share count before it
    // ever becomes an amount.
    parValueMicros: { type: DataTypes.INTEGER, allowNull: true },
    // What the reissued treasury shares originally cost. Only meaningful
    // for `treasury_reissue`, where the cost method needs it to work out
    // whether the difference is a credit to APIC or a charge against it.
    costBasisCents: { type: DataTypes.INTEGER, allowNull: true },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    // The entry this posted, so the record and the ledger can't drift.
    journalEntryId: { type: DataTypes.STRING(32), allowNull: true },
  },
  {
    tableName: "equity_transactions",
    indexes: [{ fields: ["orgId"] }, { fields: ["orgId", "transactionDate"] }, { fields: ["type"] }],
  }
);
