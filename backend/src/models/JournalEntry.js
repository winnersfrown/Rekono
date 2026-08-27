import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// Where a journal entry came from -- "manual" is a human using the Journal
// Entries tab directly, "invoice_approval" is ledger.js's auto-posting on
// invoice approval, "void" is the reversing entry a void creates. More
// values get added as later phases wire up more triggers (bank import,
// bill payment, ...); a fixed enum rather than free text so the source
// column stays meaningful for reporting/filtering as that list grows.
export const JOURNAL_ENTRY_SOURCES = ["manual", "invoice_approval", "void"];

// Posted entries are immutable by design, same reasoning real bookkeeping
// uses: a mistake is corrected with a reversing entry (ledger.js's
// voidJournalEntry), never by editing or deleting history. There is
// deliberately no PATCH or DELETE route for a journal entry -- only
// POST .../void.
export const JOURNAL_ENTRY_STATUSES = ["posted", "voided"];

export const JournalEntry = sequelize.define(
  "JournalEntry",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    entryDate: { type: DataTypes.DATEONLY, allowNull: false },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
    source: { type: DataTypes.ENUM(...JOURNAL_ENTRY_SOURCES), allowNull: false, defaultValue: "manual" },
    // Generic (sourceType, sourceId) pair rather than one nullable FK column
    // per possible source (the shape AuditLog uses) -- deliberate departure,
    // since this list is expected to keep growing as later phases wire up
    // more auto-posting triggers, and a new fixed column per trigger doesn't
    // scale as well as it does for AuditLog's fairly stable set of doc types.
    sourceType: { type: DataTypes.STRING(32), allowNull: true },
    sourceId: { type: DataTypes.STRING(32), allowNull: true },
    status: { type: DataTypes.ENUM(...JOURNAL_ENTRY_STATUSES), allowNull: false, defaultValue: "posted" },
    postedByUserId: { type: DataTypes.STRING(32), allowNull: true },
    // Set on the original entry once it's voided, pointing at the reversing
    // entry that undid it -- lets the UI show "voided, see entry X" instead
    // of just a status flag with no way to find what actually happened.
    voidedByEntryId: { type: DataTypes.STRING(32), allowNull: true },
  },
  {
    tableName: "journal_entries",
    indexes: [{ fields: ["orgId"] }, { fields: ["entryDate"] }, { fields: ["sourceType", "sourceId"] }],
  }
);
