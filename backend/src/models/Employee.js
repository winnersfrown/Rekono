import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Someone the org pays wages to -- the payroll counterpart to Vendor/
// Customer, for the same reason those exist: a name typed once per pay
// run (rather than free text on every one) is how the same person's
// history stays attributable to them, and how a payroll list is anything
// more than a pile of disconnected journal entries.
export const Employee = sequelize.define(
  "Employee",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(256), allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    // Deactivated rather than deleted, same reasoning as Vendor.active --
    // someone with pay-run history has to stay resolvable forever.
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "employees",
    indexes: [{ fields: ["orgId"] }],
  }
);
