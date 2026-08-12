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

test("swallows a NOT NULL violation from adding a column to a table with legacy rows", async () => {
  // Real scenario, reproduced locally against actual Postgres (not just
  // mocked here): a table predates a column that got added to its model
  // later (e.g. Invoice.orgId, added after this app's very first deploy).
  // { alter: { drop: false } } tries to add it, but the column is NOT NULL
  // with no default and existing rows have nothing to put there -- Postgres
  // rejects that with 23502. We can't safely invent a value (assigning the
  // wrong org to a legacy row would leak it across tenants), so this must
  // stay a loud warning, not a crash: the rest of the app still needs to
  // boot even though that one table/column needs a human to clean it up.
  await withMockedSync(
    async () => {
      throw pgError("23502", 'column "orgId" of relation "invoices" contains null values');
    },
    async () => {
      await expect(initDb()).resolves.toBeUndefined();
    }
  );
});

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

describe("DANGEROUSLY_RESET_DB", () => {
  const originalEnv = process.env.DANGEROUSLY_RESET_DB;
  const originalGetDialect = sequelize.getDialect;
  const originalQuery = sequelize.query;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DANGEROUSLY_RESET_DB;
    else process.env.DANGEROUSLY_RESET_DB = originalEnv;
    sequelize.getDialect = originalGetDialect;
    sequelize.query = originalQuery;
  });

  test("does nothing when unset", async () => {
    delete process.env.DANGEROUSLY_RESET_DB;
    const queryCalls = [];
    sequelize.query = (...args) => queryCalls.push(args);
    await withMockedSync(
      async () => {},
      async () => {
        await initDb();
      }
    );
    expect(queryCalls).toHaveLength(0);
  });

  // The suite's real dialect is sqlite (see jest.setup.js), so this also
  // covers the actual test environment directly, not just a simulated one:
  // even with the flag on, a non-Postgres database is never touched.
  test("does nothing on a non-Postgres database even if the flag is set", async () => {
    process.env.DANGEROUSLY_RESET_DB = "true";
    expect(sequelize.getDialect()).toBe("sqlite");
    const queryCalls = [];
    sequelize.query = (...args) => queryCalls.push(args);
    await withMockedSync(
      async () => {},
      async () => {
        await initDb();
      }
    );
    expect(queryCalls).toHaveLength(0);
  });

  test("drops and recreates the public schema when set on a Postgres database", async () => {
    process.env.DANGEROUSLY_RESET_DB = "true";
    sequelize.getDialect = () => "postgres";
    const queryCalls = [];
    sequelize.query = (...args) => {
      queryCalls.push(args);
      return Promise.resolve();
    };
    await withMockedSync(
      async () => {},
      async () => {
        await initDb();
      }
    );
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0][0]).toMatch(/DROP SCHEMA public CASCADE/);
  });
});
