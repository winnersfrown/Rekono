import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";
import * as secretBox from "../secretBox.js";

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

    // Optional TOTP-based 2FA (routes/auth.js's /api/auth/2fa/* routes,
    // twoFactor.js for the TOTP/backup-code logic itself). Encrypted at
    // rest (secretBox.js, same reasoning as Organization's QuickBooks
    // tokens) -- a database compromise alone shouldn't also hand over a
    // live credential that bypasses login. Set (but totpEnabled left
    // false) as soon as setup starts, so re-running setup can swap in a
    // fresh secret if the first QR never got scanned; only flips to
    // enabled once a real code from it verifies.
    totpSecret: {
      type: DataTypes.TEXT,
      allowNull: true,
      get() {
        return secretBox.decrypt(this.getDataValue("totpSecret"));
      },
      set(value) {
        this.setDataValue("totpSecret", secretBox.encrypt(value));
      },
    },
    totpEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // SHA-256 hashes only (see twoFactor.js) -- same reasoning as
    // passwordResetTokenHash, since these are random tokens, not
    // user-chosen secrets that need bcrypt's slow-hashing defense. Each
    // one is single-use: consuming a code removes its hash from this list.
    totpBackupCodeHashes: { type: DataTypes.JSON, allowNull: true },
  },
  { tableName: "users", updatedAt: false, createdAt: "createdAt" }
);
