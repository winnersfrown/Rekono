import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const MatchResult = sequelize.define(
  "MatchResult",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    invoiceId: { type: DataTypes.STRING(32), allowNull: false },
    matchEntryId: { type: DataTypes.STRING(32), allowNull: true },
    status: { type: DataTypes.ENUM("matched", "partial", "unmatched"), allowNull: false },
    score: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    reasoning: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
  },
  { tableName: "match_results", updatedAt: false, createdAt: "createdAt", indexes: [{ fields: ["invoiceId"] }] }
);
