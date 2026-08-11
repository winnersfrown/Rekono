import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const MatchEntry = sequelize.define(
  "MatchEntry",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    sourceId: { type: DataTypes.STRING(32), allowNull: false },
    vendor: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    amount: { type: DataTypes.FLOAT, allowNull: true },
    entryDate: { type: DataTypes.DATEONLY, allowNull: true },
    reference: { type: DataTypes.STRING(256), allowNull: false, defaultValue: "" },
    rawRow: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
  },
  { tableName: "match_entries", timestamps: false, indexes: [{ fields: ["sourceId"] }] }
);
