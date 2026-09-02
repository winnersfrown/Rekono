import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Someone the org bills -- the AR counterpart to the vendors the AP side
// tracks. Deliberately a real table rather than a name string on each
// invoice (the shape Invoice.vendorName uses): a customer carries payment
// terms and a billing email that every invoice for them should inherit,
// and the AR aging report groups by customer, which a free-text name
// would make unreliable the first time someone types "Acme Inc." one
// place and "Acme, Inc" another.
export const Customer = sequelize.define(
  "Customer",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(256), allowNull: false },
    email: { type: DataTypes.STRING(320), allowNull: false, defaultValue: "" },
    // Net terms in days -- what a new invoice's due date defaults to,
    // overridable per invoice. 30 is the near-universal SMB default.
    paymentTermsDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
    notes: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    // Deactivated rather than deleted, same reasoning as Account.active --
    // a customer with historical invoices has to stay resolvable forever.
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // Government, non-profit, resale -- whatever the reason, no invoice for
    // this customer ever charges sales tax, regardless of what any
    // individual line is marked. Checked at invoice-creation time
    // (routes/receivables.js), not baked into the line's own taxable flag,
    // so a customer that later loses exempt status doesn't require going
    // back and editing every line on every template that bills them.
    taxExempt: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: "customers",
    indexes: [{ fields: ["orgId"] }],
  }
);
