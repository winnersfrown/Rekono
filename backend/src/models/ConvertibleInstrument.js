import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A SAFE or convertible note: cash an investor put in before there was a
// priced round to put it in at. Neither instrument is equity yet -- a SAFE
// holder isn't a shareholder and a note holder is a creditor -- so the cash
// received books as a liability (convertibleInstruments.js's Convertible
// Notes & SAFEs Payable) until conversion moves it onto the cap table, or
// repayment retires it in cash instead.
//
// This is why the instrument lives here rather than as another
// EquityTransaction type: an EquityTransaction is definitionally an event
// where equity moved, and issuing a SAFE is the opposite of that -- nothing
// on the cap table changes the day the check clears.
export const CONVERTIBLE_INSTRUMENT_TYPES = ["safe", "convertible_note"];

// Only meaningful for a "safe": which side of the round size the cap and
// discount apply against. Informational -- Rekono books the conversion
// terms the user brings (see convertibleInstruments.js's recordConversion)
// rather than deriving a conversion price itself, the same discipline
// incomeTax.js and stockCompensation.js apply to rates and fair values that
// require a judgment call this app has no basis for making.
export const SAFE_TYPES = ["pre_money", "post_money"];

export const CONVERTIBLE_INSTRUMENT_STATUSES = ["outstanding", "converted", "repaid", "voided"];

export const ConvertibleInstrument = sequelize.define(
  "ConvertibleInstrument",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    // The investor. A real row in Shareholder rather than a name string, so
    // that when this converts the holder issuing shares onto the register
    // and the holder who wrote the check are provably the same person --
    // and so a SAFE holder who never converts still shows up wherever the
    // rest of the app looks people up by Shareholder, just off the cap
    // table until they are actually on it.
    shareholderId: { type: DataTypes.STRING(32), allowNull: false },
    instrumentType: { type: DataTypes.ENUM(...CONVERTIBLE_INSTRUMENT_TYPES), allowNull: false },
    safeType: { type: DataTypes.ENUM(...SAFE_TYPES), allowNull: true },
    issueDate: { type: DataTypes.DATEONLY, allowNull: false },
    principalCents: { type: DataTypes.INTEGER, allowNull: false },
    // Terms, not money moved -- carried for reference and for whoever is
    // working out a conversion price by hand, never read by this app to
    // compute one itself.
    valuationCapCents: { type: DataTypes.INTEGER, allowNull: true },
    discountRatePercent: { type: DataTypes.FLOAT, allowNull: true },
    // Notes only. A rate and a maturity date are contract terms; accruing
    // interest onto the books month by month is an adjusting entry someone
    // decides to post (recurringEntries.js already exists for exactly that)
    // rather than something this record does on its own.
    interestRatePercent: { type: DataTypes.FLOAT, allowNull: true },
    maturityDate: { type: DataTypes.DATEONLY, allowNull: true },
    // Where the investment cash landed, for the issuance posting.
    cashAccountId: { type: DataTypes.STRING(32), allowNull: false },
    status: { type: DataTypes.ENUM(...CONVERTIBLE_INSTRUMENT_STATUSES), allowNull: false, defaultValue: "outstanding" },
    // The issuance posting. Cleared on void the same way EquityTransaction
    // clears journalEntryId, so a voided instrument stops being counted as
    // outstanding liability without losing the record of what happened.
    journalEntryId: { type: DataTypes.STRING(32), allowNull: true },
    // Set together on conversion: the EquityTransaction that split the
    // principal into Common Stock and APIC, and the ShareTransaction that
    // put the resulting shares in the holder's hands. Two links because the
    // dollars and the shares are two different ledgers, same as every other
    // funding event in shareRegister.js.
    conversionEquityTransactionId: { type: DataTypes.STRING(32), allowNull: true },
    conversionShareTransactionId: { type: DataTypes.STRING(32), allowNull: true },
    repaymentJournalEntryId: { type: DataTypes.STRING(32), allowNull: true },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
  },
  {
    tableName: "convertible_instruments",
    indexes: [{ fields: ["orgId"] }, { fields: ["orgId", "status"] }, { fields: ["shareholderId"] }],
  }
);
