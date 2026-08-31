import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Same status shape as the other five document pipelines -- queue -> OCR ->
// extract -> confidence-gate -> review is the same loop, a sixth document
// type and schema.
//
// "approved" means something more here than it does on the other five. On a
// lease or a tax form it's an attestation that the extraction reads
// correctly. On a check it additionally means the check has been applied to
// a bill: money moved, and a journal entry exists. See routes/checks.js's
// link/unlink -- a check reaches "approved" through linking and no other
// way, so the status can't claim a payment that isn't on the books.
export const CHECK_STATUSES = [
  "queued",
  "processing",
  "extracted", // high confidence - fast-track review
  "needs_review", // low confidence - flagged
  "approved", // linked to a bill, payment posted
  "rejected",
  "failed",
];

export const Check = sequelize.define(
  "Check",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    originalFilename: { type: DataTypes.STRING(512), allowNull: false },
    storagePath: { type: DataTypes.STRING(1024), allowNull: false },
    contentType: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "" },
    status: { type: DataTypes.ENUM(...CHECK_STATUSES), allowNull: false, defaultValue: "queued" },
    errorMessage: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    checkNumber: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" },
    checkDate: { type: DataTypes.DATEONLY, allowNull: true },
    // Who the check is made out to -- the "Pay to the order of" line. This
    // is what gets fuzzy-matched against a bill's vendor name to suggest
    // which payable it settles, so it's weighted heaviest in scoring.
    payeeName: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    // FLOAT dollars, matching Invoice.total and the other document tables
    // rather than the ledger's integer cents. Converted once at the
    // boundary (dollarsToCents) when this becomes a BillPayment, which is
    // the same crossing every other document makes -- see CLAUDE.md.
    amount: { type: DataTypes.FLOAT, allowNull: true },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    bankName: { type: DataTypes.STRING(256), allowNull: false, defaultValue: "" },

    // ONLY the last four digits of the account number, never the whole
    // thing, and the routing number is not stored at all -- see
    // extractionChecks.js's accountLast4/redactMicr. The MICR line along
    // the bottom of every check carries the full routing and account
    // number, and that pair is all anyone needs to draft an ACH debit
    // against the account. Keeping it would make this table a more
    // attractive target than the entire rest of the app put together, for
    // no product benefit: last-four is what a human uses to confirm "yes,
    // that's the operating account", and the full number is still in the
    // stored image if it's ever genuinely needed. Same reasoning, and the
    // same three-point narrowing (extraction, correction route, raw OCR),
    // as TaxDocument.recipientTinLast4.
    accountLast4: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "" },

    // The bill this check pays, once a human has confirmed the link.
    // Nullable because extraction can suggest but never decides: applying
    // a payment moves money on the books, which is not something an OCR
    // guess gets to do on its own.
    invoiceId: { type: DataTypes.STRING(32), allowNull: true },
    // The payment this check created. Stored separately from invoiceId
    // rather than derived from it, because the two answer different
    // questions and can't be recovered from one another: invoiceId is
    // "which bill does this check belong to", billPaymentId is "which
    // posting do I reverse if the link turns out to be wrong". Unlinking
    // needs the second one by id -- looking a payment up by invoice would
    // find every payment against that bill, including ones other checks
    // or the QuickBooks bank-match flow recorded.
    billPaymentId: { type: DataTypes.STRING(32), allowNull: true },

    note: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },

    // Redacted before it's stored (see checkPipeline.js) -- the raw OCR of
    // a check contains the same full MICR line accountLast4 exists to
    // avoid keeping.
    rawOcrText: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    extractionMethod: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "" }, // "llm" | "heuristic"
    fieldConfidence: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    overallConfidence: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "checks",
    indexes: [{ fields: ["orgId"] }, { fields: ["status"] }, { fields: ["invoiceId"] }],
    // Soft delete, same reasoning as the other five pipelines.
    paranoid: true,
  }
);
