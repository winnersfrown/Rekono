import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A pending team invite -- becomes a real User (see routes/team.js's accept
// endpoint) once the invitee sets a name + password. tokenHash follows the
// same pattern as User.passwordResetTokenHash: only a SHA-256 hash is ever
// stored, so a leaked database row can't be used to accept the invite.
export const Invite = sequelize.define(
  "Invite",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    email: { type: DataTypes.STRING(320), allowNull: false },
    invitedByUserId: { type: DataTypes.STRING(32), allowNull: false },
    tokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    status: { type: DataTypes.ENUM("pending", "accepted", "revoked"), allowNull: false, defaultValue: "pending" },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
  },
  { tableName: "invites", updatedAt: false, createdAt: "createdAt", indexes: [{ fields: ["orgId"] }] }
);
