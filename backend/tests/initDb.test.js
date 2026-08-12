import { sequelize } from "../src/db.js";
import { initDb } from "../src/models/index.js";

// Render's rolling deploys briefly run the new container's initDb() while the
// previous container is still up, so two instances can race sequelize.sync()
// against the same persistent database. Reproduced locally (outside this
// suite, against real Postgres) by running two processes' initDb() at once:
// depending on timing, Postgres throws 42P07 (duplicate table/index), 42710
// (duplicate object), or 23505 (unique_violation on pg_type, when two
// `CREATE TABLE IF NOT EXISTS` collide) -- all of which just mean the other
// instance already created the schema, not that anything is actually broken.
// These tests fake that shape of error without needing a real Postgres race.

function pgError(code, message) {
  const parent = new Error(message);
  parent.code = code;
  const err = new Error(message);
  err.name = "SequelizeDatabaseError";
  err.parent = parent;
  err.original = parent;
  return err;
}

async function withMockedSync(mockImpl, run) {
  const original = sequelize.sync;
  sequelize.sync = mockImpl;
  try {
    await run();
  } finally {
    sequelize.sync = original;
  }
}

test.each(["42P07", "42710", "23505"])(
  "swallows a %s sync race instead of crashing the process",
  async (code) => {
    await withMockedSync(
      async () => {
        throw pgError(code, `relation already exists (${code})`);
      },
      async () => {
        await expect(initDb()).resolves.toBeUndefined();
      }
    );
  }
);

test("still throws on an unrelated sync failure", async () => {
  await withMockedSync(
    async () => {
      throw pgError("28P01", "password authentication failed");
    },
    async () => {
      await expect(initDb()).rejects.toThrow(/password authentication failed/);
    }
  );
});

test("resolves normally when sync succeeds", async () => {
  await withMockedSync(
    async () => {},
    async () => {
      await expect(initDb()).resolves.toBeUndefined();
    }
  );
});
