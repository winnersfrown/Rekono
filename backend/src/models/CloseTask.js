import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// The manual half of a close checklist -- the judgment work a human has to
// do and then attest to (reconcile statements, post accruals, sign off).
// The automatic half isn't stored here at all: those are recomputed from
// the org's live data on every read (see routes/close.js's readinessChecks),
// because a stored "done" flag for "all invoices reviewed" would go stale
// the moment someone uploads another invoice.
export const CloseTask = sequelize.define(
  "CloseTask",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    closePeriodId: { type: DataTypes.STRING(32), allowNull: false },
    // Denormalized from the parent period so every query in routes/close.js
    // can scope by org directly, the same way AuditLog carries orgId rather
    // than joining through the invoice it belongs to.
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    title: { type: DataTypes.STRING(512), allowNull: false },
    done: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    completedBy: { type: DataTypes.STRING(256), allowNull: true },
    // Explicit ordering so the seeded template keeps the sequence a close
    // is actually worked in, rather than whatever order the rows come back.
    position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "close_tasks",
    updatedAt: false,
    createdAt: "createdAt",
    indexes: [{ fields: ["closePeriodId"] }, { fields: ["orgId"] }],
  }
);
