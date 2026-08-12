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

// Postgres codes that mean "another process already created this" rather
// than a real schema problem: 42P07 duplicate_table (a table or index by
// that name already exists), 42710 duplicate_object, 23505 unique_violation
// (concurrent `CREATE TABLE IF NOT EXISTS` racing on Postgres's own internal
// pg_type catalog -- reproduced locally by running sync() from two processes
// against the same fresh database at once). Render's rolling deploys start
// the new container and run its own sequelize.sync() while the previous
// container is still up, so two instances legitimately race to sync the
// same persistent database on every deploy -- this isn't a hypothetical.
const BENIGN_SYNC_RACE_CODES = new Set(["42P07", "42710", "23505"]);

export async function initDb() {
  try {
    // { drop: false } is the safe half of Sequelize's "alter" mode: it adds
    // any column a model declares that an existing table is missing (e.g.
    // this database predates a column that got added to a model later --
    // plain sync() never backfills that, and any query touching it then
    // fails with Postgres 42703 "column does not exist" forever). It never
    // removes a column absent from the model or changes an existing one, so
    // it can't destroy real data the way full `alter: true` could.
    await sequelize.sync({ alter: { drop: false } });
  } catch (err) {
    const code = err?.parent?.code || err?.original?.code;
    if (BENIGN_SYNC_RACE_CODES.has(code)) {
      console.warn(`sequelize.sync(): schema already present (racing another instance?), continuing (${err.parent?.message || err.message})`);
      return;
    }
    // 23502 = the column we just tried to add is NOT NULL and this table
    // already has rows predating it (e.g. Invoice.orgId, added after this
    // table's very first deploy). We can't safely invent a value for
    // legacy rows -- assigning the wrong org would leak that row across
    // tenants -- so this needs a human decision, not a guess. Log loudly
    // and keep booting: the rest of the app (auth, other tables) still
    // works, and this is strictly better than crash-looping the whole
    // process over one table's backfill.
    if (code === "23502") {
      console.error(
        `sequelize.sync(): could not add a NOT NULL column -- some existing rows predate it and need manual cleanup or a backfill. ` +
          `The app will keep booting, but queries touching that column/table will keep failing until this is resolved. (${err.parent?.message || err.message})`
      );
      return;
    }
    throw err;
  }
}

export { Organization, User, Invoice, LineItem, AuditLog, MatchSource, MatchEntry, MatchResult };
