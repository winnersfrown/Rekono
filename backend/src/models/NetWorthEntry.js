import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// One row per balance snapshot, written whenever a NetWorthAccount's
// currentBalance changes (see routes/netWorth.js). Append-only, so the trend
// chart is drawn from what each balance actually was at the time rather than
// reconstructed after the fact.
//
// asOfDate is a plain calendar date rather than a timestamp: net worth moves
// on the scale of days, and a DATEONLY column means two edits on the same day
// collapse into one point on the chart instead of an ever-growing paper trail
// of typo corrections.
export const NetWorthEntry = sequelize.define(
  "NetWorthEntry",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    accountId: { type: DataTypes.STRING(32), allowNull: false },
    balance: { type: DataTypes.FLOAT, allowNull: false },
    asOfDate: { type: DataTypes.DATEONLY, allowNull: false },
  },
  {
    tableName: "net_worth_entries",
    // Nothing reads an entry's updatedAt -- a same-day correction overwrites
    // the balance in place and the chart only cares about asOfDate.
    updatedAt: false,
    indexes: [{ fields: ["accountId"] }, { fields: ["asOfDate"] }],
  }
);
