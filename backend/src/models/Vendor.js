import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Someone the org buys from -- the AP counterpart to Customer, and the
// thing AP has been missing since the ledger arrived. Before this, an
// invoice carried only `vendorName`, free text straight off the document,
// and AP aging grouped by normalizing that string. That works right up
// until the same vendor's name arrives genuinely differently -- "Acme Inc"
// on one invoice, "Acme Incorporated" on the next -- which OCR makes a
// matter of when, not if. Normalization can't fix that; only a stable
// identity plus a way to say "these two are the same" can.
//
// `Invoice.vendorName` deliberately stays as it is: it's what the document
// said, and overwriting it would destroy the record of what was actually
// extracted. `Invoice.vendorId` is the resolved identity alongside it.
export const Vendor = sequelize.define(
  "Vendor",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(256), allowNull: false },
    email: { type: DataTypes.STRING(320), allowNull: false, defaultValue: "" },
    // Net terms in days, used to fill in a due date when a bill arrives
    // without one. 30 is the near-universal default, same as Customer.
    paymentTermsDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
    notes: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    // Deactivated rather than deleted, same reasoning as Account.active and
    // Customer.active -- a vendor with historical bills has to stay
    // resolvable forever.
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // Set when this vendor was created by resolving an extracted name
    // rather than typed in by a human. Only used to sort the "probably
    // needs a look" ones to the top of the merge UI -- an auto-created
    // vendor is exactly the kind that turns out to be a duplicate.
    autoCreated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: "vendors",
    indexes: [{ fields: ["orgId"] }],
  }
);
