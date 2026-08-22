import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const MatchResult = sequelize.define(
  "MatchResult",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    invoiceId: { type: DataTypes.STRING(32), allowNull: false },
    // The PO (or, on a two-way run, whichever single entry scored best).
    matchEntryId: { type: DataTypes.STRING(32), allowNull: true },
    // The goods-receipt leg of a three-way match -- null on a two-way run,
    // and null on a three-way run that found no receipt for this invoice
    // (which is itself the finding, see threeWayOutcome below).
    receivingEntryId: { type: DataTypes.STRING(32), allowNull: true },
    status: { type: DataTypes.ENUM("matched", "partial", "unmatched"), allowNull: false },
    // The richer three-way verdict: "matched" | "no_receipt" | "no_po" |
    // "unmatched". Null on a two-way run, so its presence is also what
    // marks a result as having come from a three-way evaluation.
    //
    // Deliberately a plain string rather than a second ENUM: `status`
    // above stays the original three values so every existing consumer
    // (the exports' match_status column, the dashboard's unmatched count,
    // the results table's badge) keeps working untouched, and a new
    // outcome can be added later without another enum migration -- the
    // same reasoning Organization.js documents for plan/subscriptionStatus.
    threeWayOutcome: { type: DataTypes.STRING(32), allowNull: true },
    score: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    reasoning: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
  },
  { tableName: "match_results", updatedAt: false, createdAt: "createdAt", indexes: [{ fields: ["invoiceId"] }] }
);
