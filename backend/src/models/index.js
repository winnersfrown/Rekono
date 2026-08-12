import { sequelize } from "../db.js";
import { Organization } from "./Organization.js";
import { User } from "./User.js";
import { Invoice } from "./Invoice.js";
import { LineItem } from "./LineItem.js";
import { AuditLog } from "./AuditLog.js";
import { MatchSource } from "./MatchSource.js";
import { MatchEntry } from "./MatchEntry.js";
import { MatchResult } from "./MatchResult.js";

Organization.hasMany(User, { foreignKey: "orgId", as: "users" });
User.belongsTo(Organization, { foreignKey: "orgId", as: "organization" });

Invoice.hasMany(LineItem, {
  foreignKey: "invoiceId",
  as: "lineItems",
  onDelete: "CASCADE",
  hooks: true,
});
LineItem.belongsTo(Invoice, { foreignKey: "invoiceId" });

Invoice.hasMany(AuditLog, { foreignKey: "invoiceId", as: "auditLogs", onDelete: "CASCADE", hooks: true });
AuditLog.belongsTo(Invoice, { foreignKey: "invoiceId" });

Invoice.hasMany(MatchResult, {
  foreignKey: "invoiceId",
  as: "matchResults",
  onDelete: "CASCADE",
  hooks: true,
});
MatchResult.belongsTo(Invoice, { foreignKey: "invoiceId" });

MatchSource.hasMany(MatchEntry, {
  foreignKey: "sourceId",
  as: "entries",
  onDelete: "CASCADE",
  hooks: true,
});
MatchEntry.belongsTo(MatchSource, { foreignKey: "sourceId", as: "source" });

MatchResult.belongsTo(MatchEntry, { foreignKey: "matchEntryId", as: "matchEntry" });

export async function initDb() {
  try {
    await sequelize.sync();
  } catch (err) {
    // Postgres 42P07 = relation (table/index) already exists. sequelize.sync()
    // re-checks and (re)creates any index it doesn't recognize by name on every
    // boot; against a persistent database that already has the schema, that
    // recheck can still race into "already exists" instead of a clean skip.
    // That's a no-op, not a real failure -- crashing the whole process over it
    // would take down the app on every subsequent restart against this DB.
    if (err?.parent?.code === "42P07" || err?.original?.code === "42P07") {
      console.warn(`sequelize.sync(): schema already present, continuing (${err.parent?.message || err.message})`);
      return;
    }
    throw err;
  }
}

export { Organization, User, Invoice, LineItem, AuditLog, MatchSource, MatchEntry, MatchResult };
