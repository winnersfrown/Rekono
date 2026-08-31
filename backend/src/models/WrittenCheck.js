import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A check the org wrote itself -- check number, payee, memo -- as opposed
// to models/Check.js, which is a check somebody else wrote that got
// scanned in. The two are different things with different lifecycles (this
// one is authored here and posts immediately; that one arrives via OCR,
// gets reviewed, and is matched to a bill after the fact), so this is its
// own table rather than a "source" flag bolted onto Check -- Check's
// upload/OCR/status-machine routes all assume a real uploaded file and an
// extraction pipeline, neither of which exists for a check nobody scanned.
//
// A WrittenCheck always represents a real, already-posted bill payment:
// billPaymentId is set the moment it's created (see writtenChecks.js), not
// filled in later. There's no draft state -- writing the check and posting
// the payment are the same action, same as clicking "Record payment"
// already is on the Bill Payments tab; this only adds the paper trail
// (check number, payee, a printable layout) around that existing posting.
export const WrittenCheck = sequelize.define(
  "WrittenCheck",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    checkNumber: { type: DataTypes.STRING(32), allowNull: false },
    payeeName: { type: DataTypes.STRING(256), allowNull: false },
    checkDate: { type: DataTypes.DATEONLY, allowNull: false },
    amountCents: { type: DataTypes.INTEGER, allowNull: false },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    paymentAccountId: { type: DataTypes.STRING(32), allowNull: false },
    invoiceId: { type: DataTypes.STRING(32), allowNull: false },
    billPaymentId: { type: DataTypes.STRING(32), allowNull: false },
  },
  {
    tableName: "written_checks",
    indexes: [{ fields: ["orgId"] }],
  }
);
