import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const Organization = sequelize.define(
  "Organization",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    name: { type: DataTypes.STRING(256), allowNull: false },
  },
  { tableName: "organizations", updatedAt: false, createdAt: "createdAt" }
);
