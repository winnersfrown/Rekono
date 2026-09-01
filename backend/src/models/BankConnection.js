// One row per Plaid "Item" -- a single login at one financial institution,
// which can expose more than one account (checking + savings at the same
// bank, say). See models/BankAccount.js for the accounts underneath it, and
// plaid.js/routes/plaid.js for the connect/sync flow itself.

import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";
import * as secretBox from "../secretBox.js";

export const BankConnection = sequelize.define(
  "BankConnection",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },

    institutionName: { type: DataTypes.STRING(256), allowNull: false, defaultValue: "" },
    plaidItemId: { type: DataTypes.STRING(128), allowNull: false },

    // Encrypted at rest (secretBox.js) -- same reasoning as
    // Organization.quickbooksAccessToken: a database compromise alone
    // shouldn't also hand over a live credential into a customer's real
    // bank connection. Transparent to every other read/write in the app,
    // which all go through `connection.accessToken` directly.
    accessToken: {
      type: DataTypes.TEXT,
      allowNull: false,
      get() {
        return secretBox.decrypt(this.getDataValue("accessToken"));
      },
      set(value) {
        this.setDataValue("accessToken", secretBox.encrypt(value));
      },
    },

    // "active" | "login_required" -- Plaid sets an Item's access token to
    // stop working (expired consent, changed password) without revoking
    // it outright; the next sync attempt against it fails with
    // ITEM_LOGIN_REQUIRED, which flips this so the UI can prompt a
    // reconnect instead of silently failing every sync forever.
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "active" },
  },
  { tableName: "bank_connections", indexes: [{ fields: ["orgId"] }] }
);
