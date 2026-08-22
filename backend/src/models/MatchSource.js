import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const MatchSource = sequelize.define(
  "MatchSource",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    orgId: { type: DataTypes.STRING(32), allowNull: false },
    name: { type: DataTypes.STRING(512), allowNull: false },
    // "receiving" (goods receipts / delivery notes) is what turns the
    // engine's two-way check into a real three-way match -- see
    // matching.js's findThreeWayMatch. Adding a value to an existing
    // Postgres enum is safe here specifically because Sequelize's sync
    // emits `ALTER TYPE ... ADD VALUE IF NOT EXISTS` for it (verified in
    // its postgres query-generator), which is both supported by the
    // additive-only sync in models/index.js and idempotent under the
    // concurrent rolling-deploy race that file already guards against.
    sourceType: { type: DataTypes.ENUM("po", "bank", "receiving"), allowNull: false },
  },
  { tableName: "match_sources", updatedAt: false, createdAt: "uploadedAt", indexes: [{ fields: ["orgId"] }] }
);
