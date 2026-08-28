import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

// A class of stock: Common, Preferred Series A, and so on.
//
// Par value lives here rather than on each transaction because it's a
// property of the class, fixed in the certificate of incorporation --
// every share of a class carries the same par whoever buys it and whenever.
// Carried in millionths of a dollar for the reason v1.29 found the hard
// way: $0.0001 par is the Delaware default and rounds to zero cents.
export const ShareClass = sequelize.define(
  "ShareClass",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(128), allowNull: false },
    parValueMicros: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // What the charter permits. Issuing beyond it isn't merely a data
    // error -- it's void as a matter of corporate law, so it's refused
    // rather than warned about. Null means no stated ceiling.
    authorizedShares: { type: DataTypes.INTEGER, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "share_classes",
    indexes: [{ fields: ["orgId"] }],
  }
);

// Someone who holds stock. Deliberately its own table rather than a name
// string on each transaction, for the same reason Customer and Vendor are:
// the cap table groups by holder, and free text makes that unreliable the
// first time someone types "Jane Smith" one place and "Jane A. Smith"
// another.
export const Shareholder = sequelize.define(
  "Shareholder",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(256), allowNull: false },
    email: { type: DataTypes.STRING(320), allowNull: false, defaultValue: "" },
    notes: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    // Deactivated rather than deleted, same as Customer and Vendor -- a
    // holder with historical transactions has to stay resolvable forever,
    // even after they've sold out entirely.
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: "shareholders",
    indexes: [{ fields: ["orgId"] }],
  }
);

// A movement of shares. `shares` is always positive and direction is
// carried by which ends are filled in, not by arithmetic on a signed
// quantity -- a signed quantity would make "who lost these shares"
// unanswerable for a transfer, which is precisely what a register exists
// to answer.
//
//   issue       company -> holder    issued up, outstanding up
//   transfer    holder  -> holder    nothing changes but the holder
//   repurchase  holder  -> company   outstanding down, treasury up
//   reissue     treasury -> holder   outstanding up, treasury down
//
// Issue and reissue have the same shape (from nobody, to a holder) and are
// told apart by `type` alone, because the difference is not structural: a
// reissue sells shares the company already counted as issued, so it must
// not consume authorized capital a second time. That mirrors what the
// ledger does with the same two events -- equity.js credits Common Stock
// on an issuance and Treasury Stock on a reissue, never both.
export const SHARE_TRANSACTION_TYPES = ["issue", "transfer", "repurchase", "reissue"];

export const ShareTransaction = sequelize.define(
  "ShareTransaction",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    shareClassId: { type: DataTypes.STRING(32), allowNull: false },
    type: { type: DataTypes.ENUM(...SHARE_TRANSACTION_TYPES), allowNull: false },
    transactionDate: { type: DataTypes.DATEONLY, allowNull: false },
    shares: { type: DataTypes.INTEGER, allowNull: false },
    // Null wherever the company itself is the counterparty: an issue and a
    // reissue have no `from`, a repurchase has no `to`.
    fromShareholderId: { type: DataTypes.STRING(32), allowNull: true },
    toShareholderId: { type: DataTypes.STRING(32), allowNull: true },
    pricePerShareMicros: { type: DataTypes.INTEGER, allowNull: true },
    // The equity transaction that moved the money, when there was one. The
    // register tracks shares and the ledger tracks dollars; this is the
    // only link between them, and it's nullable because a transfer between
    // two shareholders moves no company money at all.
    equityTransactionId: { type: DataTypes.STRING(32), allowNull: true },
    memo: { type: DataTypes.STRING(512), allowNull: false, defaultValue: "" },
  },
  {
    tableName: "share_transactions",
    indexes: [
      { fields: ["orgId"] },
      { fields: ["orgId", "transactionDate"] },
      { fields: ["shareClassId"] },
    ],
  }
);
