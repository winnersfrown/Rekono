import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const LineItem = sequelize.define(
  "LineItem",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    invoiceId: { type: DataTypes.STRING(32), allowNull: false },
    position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    description: { type: DataTypes.STRING(1024), allowNull: false, defaultValue: "" },
    quantity: { type: DataTypes.FLOAT, allowNull: true },
    unitPrice: { type: DataTypes.FLOAT, allowNull: true },
    amount: { type: DataTypes.FLOAT, allowNull: true },
    confidence: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  },
  { tableName: "line_items", timestamps: false, indexes: [{ fields: ["invoiceId"] }] }
);
