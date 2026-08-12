import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    email: { type: DataTypes.STRING(320), allowNull: false, unique: true },
    hashedPassword: { type: DataTypes.STRING(256), allowNull: false },
    fullName: { type: DataTypes.STRING(256), allowNull: false, defaultValue: "" },
    role: { type: DataTypes.ENUM("owner", "member"), allowNull: false, defaultValue: "owner" },
    // Only ever holds a SHA-256 hash of the reset token, never the token
    // itself -- same reasoning as hashedPassword. Both nullable with no
    // default, so adding them to already-deployed tables is safe (initDb's
    // additive-only sync handles new nullable columns without the NOT NULL
    // backfill problem a required column would hit).
    passwordResetTokenHash: { type: DataTypes.STRING(64), allowNull: true },
    passwordResetExpiresAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "users", updatedAt: false, createdAt: "createdAt" }
);
