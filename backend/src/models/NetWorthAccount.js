import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Deliberately keyed by userId, not orgId -- every other model in this app
// belongs to an Organization because Rekono itself is AP automation for a
// company. This one is a personal net worth tracker: it isn't company data,
// it isn't shared with teammates, and it has nothing to do with invoices or
// vendors. A user's own login is the only ownership boundary that makes
// sense here, so it's the first model in the codebase with no orgId at all.
export const NET_WORTH_CATEGORIES = [
  "cash",
  "investment",
  "retirement",
  "property",
  "vehicle",
  "other_asset",
  "credit_card",
  "loan",
  "mortgage",
  "other_liability",
];

// Whether a category counts toward assets or subtracts as a liability --
// drives both the totals math and which section of the UI an account lists
// under. Kept as an explicit lookup next to the category list rather than
// inferred from naming, so adding a category later can't silently land it
// on the wrong side of net worth.
export const CATEGORY_KIND = {
  cash: "asset",
  investment: "asset",
  retirement: "asset",
  property: "asset",
  vehicle: "asset",
  other_asset: "asset",
  credit_card: "liability",
  loan: "liability",
  mortgage: "liability",
  other_liability: "liability",
};

export const NetWorthAccount = sequelize.define(
  "NetWorthAccount",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    userId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(256), allowNull: false },
    category: { type: DataTypes.ENUM(...NET_WORTH_CATEGORIES), allowNull: false },
    // The account's latest known value. A liability is stored as a positive
    // number (a $12,000 auto loan balance is 12000, not -12000) --
    // CATEGORY_KIND is what flips its sign when totals are computed, so this
    // column always reads as "what this account holds" and no caller has to
    // remember a sign convention.
    currentBalance: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    notes: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
  },
  {
    tableName: "net_worth_accounts",
    indexes: [{ fields: ["userId"] }],
    // Same paranoid soft-delete as every document model: deleting an account
    // shouldn't erase the balance history behind it.
    paranoid: true,
  }
);
