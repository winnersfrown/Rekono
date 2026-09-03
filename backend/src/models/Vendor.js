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
    // Early-payment discount terms, e.g. "2/10 net 30" is
    // earlyPayDiscountPct=2, earlyPayDiscountDays=10 (paymentTermsDays
    // above carries the 30). Nullable with no default, same reasoning as
    // every column added after this app's schema-drift incidents (see
    // Invoice.quickbooksBillId) -- a NOT NULL default would fail to add
    // against a vendors table that already has rows. Null on either means
    // no discount is offered; computeApAging in accountsPayable.js treats
    // that exactly the same as an explicit 0, so there's no need to
    // special-case it beyond this column being absent.
    earlyPayDiscountPct: { type: DataTypes.FLOAT, allowNull: true },
    earlyPayDiscountDays: { type: DataTypes.INTEGER, allowNull: true },
    // Deactivated rather than deleted, same reasoning as Account.active and
    // Customer.active -- a vendor with historical bills has to stay
    // resolvable forever.
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    // Set when this vendor was created by resolving an extracted name
    // rather than typed in by a human. Only used to sort the "probably
    // needs a look" ones to the top of the merge UI -- an auto-created
    // vendor is exactly the kind that turns out to be a duplicate.
    autoCreated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // ONLY the last four digits of the vendor's TIN/SSN/EIN, never the
    // whole number -- same reasoning as TaxDocument.recipientTinLast4: a
    // full SSN sitting in a database column is a liability with no
    // matching upside for what this app actually needs it for (matching a
    // 1099-NEC line to the right vendor), and last-four is the standard
    // key for that. Collected via routes/vendors.js's PATCH, which keeps
    // only the last four digits of whatever's typed in.
    taxIdLast4: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "" },
    // A human's attestation that this vendor doesn't need a 1099-NEC even
    // if paid over the threshold -- almost always because they're a
    // corporation, which Rekono has no way to know on its own (see
    // form1099.js). Defaults to false rather than true: an unmarked vendor
    // paid over the threshold should show up as needing attention, not
    // silently drop off the report.
    form1099Exempt: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    tableName: "vendors",
    indexes: [{ fields: ["orgId"] }],
  }
);
