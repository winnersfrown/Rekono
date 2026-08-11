import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const MatchSource = sequelize.define(
  "MatchSource",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(512), allowNull: false },
    sourceType: { type: DataTypes.ENUM("po", "bank"), allowNull: false },
  },
  { tableName: "match_sources", updatedAt: false, createdAt: "uploadedAt", indexes: [{ fields: ["orgId"] }] }
);
