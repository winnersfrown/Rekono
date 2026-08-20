import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One isolated SQLite DB + storage dir per Jest worker process (not per
// test file/case -- tests reset the schema themselves via
// sequelize.sync({ force: true }) in a shared beforeEach, see testUtils.js).
const dir = path.join(os.tmpdir(), `rekono-jest-worker-${process.env.JEST_WORKER_ID || "0"}`);
fs.mkdirSync(dir, { recursive: true });

process.env.DATABASE_URL = `sqlite:${path.join(dir, "test.db")}`;
process.env.STORAGE_DIR = path.join(dir, "storage");
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

process.env.GEMINI_API_KEY = "";
process.env.SECRET_KEY = "test-secret-key-not-for-production";
