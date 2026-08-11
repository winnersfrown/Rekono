import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const AuditLog = sequelize.define(
  "AuditLog",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    invoiceId: { type: DataTypes.STRING(32), allowNull: true },
    userId: { type: DataTypes.STRING(32), allowNull: true },
    action: { type: DataTypes.STRING(128), allowNull: false },
    actor: { type: DataTypes.STRING(256), allowNull: false, defaultValue: "system" },
    details: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
  },
  {
    tableName: "audit_logs",
    updatedAt: false,
    createdAt: "createdAt",
    indexes: [{ fields: ["orgId"] }, { fields: ["invoiceId"] }],
  }
);
