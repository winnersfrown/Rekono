import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One isolated SQLite DB + storage dir per Jest worker process (not per
// test file/case -- tests reset the schema themselves via
// sequelize.sync({ force: true }) in a shared beforeEach, see testUtils.js).
const dir = path.join(os.tmpdir(), `rekono-jest-worker-${process.env.JEST_WORKER_ID || "0"}`);
fs.mkdirSync(dir, { recursive: true });

// Row-level security is a Postgres feature, so the default SQLite run can't
// exercise it at all. Point REKONO_TEST_PG_URL at a Postgres server (as a
// NON-superuser role -- Postgres skips row security for superusers, which
// would make the whole suite pass while proving nothing) to run the same
// suite against Postgres with policies live. Each worker gets its own
// database, since tests reset the schema out from under each other.
// See README.md's "Row-level security" section.
if (process.env.REKONO_TEST_PG_URL) {
  const worker = process.env.JEST_WORKER_ID || "0";
  process.env.DATABASE_URL = `${process.env.REKONO_TEST_PG_URL}/rekono_test_${worker}`;
} else {
  process.env.DATABASE_URL = `sqlite:${path.join(dir, "test.db")}`;
}

process.env.STORAGE_DIR = path.join(dir, "storage");
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

process.env.GEMINI_API_KEY = "";
process.env.SECRET_KEY = "test-secret-key-not-for-production";

// The API-wide rate limits are keyed by client IP, and every request in the
// suite comes from the same one -- a single test file makes far more calls
// in its few seconds than a real client makes in the 15-minute window, so
// the real ceilings would throttle the suite rather than the app. Raised
// here instead of loosened in config.js, so production keeps its real
// numbers. The limiter itself is covered directly in rateLimit.test.js.
process.env.RATE_LIMIT_API_MAX = "1000000";
process.env.RATE_LIMIT_EXPENSIVE_MAX = "1000000";
