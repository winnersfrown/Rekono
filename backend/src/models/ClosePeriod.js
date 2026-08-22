import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const ClosePeriod = sequelize.define(
  "ClosePeriod",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    // "YYYY-MM". A month rather than an arbitrary date range: month-end
    // close is a monthly ritual, and a plain sortable string keeps the
    // "is there a period for August?" lookup a trivial equality check
    // across both SQLite and Postgres without any date-truncation SQL.
    periodMonth: { type: DataTypes.STRING(7), allowNull: false },
    // "open" | "closed". A plain string rather than an ENUM for the same
    // reason Organization.js gives for plan/subscriptionStatus: a future
    // state ("in_review", "reopened") is then just a new value rather than
    // an enum migration on a table that will already have live rows.
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "open" },
    closedAt: { type: DataTypes.DATE, allowNull: true },
    // Denormalized actor email, same shape (and reasoning) as
    // AuditLog.actor: who closed the books is worth keeping legible even
    // if that user is later removed from the org.
    closedBy: { type: DataTypes.STRING(256), allowNull: true },
  },
  {
    tableName: "close_periods",
    updatedAt: false,
    createdAt: "createdAt",
    indexes: [
      { fields: ["orgId"] },
      // One period per month per org -- enforced in the database, not just
      // in the route, so a double-submit can't create two competing
      // checklists for the same month.
      { unique: true, fields: ["orgId", "periodMonth"] },
    ],
  }
);
