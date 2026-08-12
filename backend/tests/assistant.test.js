import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

// ANTHROPIC_API_KEY is never set in the test environment (jest.setup.js),
// so every request below exercises the "not configured yet" path rather
// than an actual Claude call -- there's no live key to test the grounded
// answer against in CI. That path is still worth covering: it's what
// every visitor sees until the key is configured, and it must never
// crash or bypass auth/trial gating.

beforeEach(resetDb);

test("rejects unauthenticated requests", async () => {
  const res = await request(app).post("/api/assistant/ask").send({ question: "How many invoices need review?" });
  expect(res.status).toBe(401);
});

test("rejects an empty question", async () => {
  const token = await signup(app, request);
  const res = await request(app).post("/api/assistant/ask").set(authHeader(token)).send({ question: "" });
  expect(res.status).toBe(422);
});

test("authenticated request without ANTHROPIC_API_KEY returns 503, not a crash", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/assistant/ask")
    .set(authHeader(token))
    .send({ question: "How many invoices need review?" });
  expect(res.status).toBe(503);
  expect(res.body.detail).toMatch(/api key/i);
});

test("respects the trial gate like every other data route", async () => {
  const token = await signup(app, request, { email: "expired@askco.co" });
  const { Organization } = await import("../src/models/index.js");
  const { sequelize } = await import("../src/db.js");
  const org = await Organization.findOne();
  const past = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const sqliteTimestamp =
    `${past.getUTCFullYear()}-${pad(past.getUTCMonth() + 1)}-${pad(past.getUTCDate())} ` +
    `${pad(past.getUTCHours())}:${pad(past.getUTCMinutes())}:${pad(past.getUTCSeconds())}.${pad(past.getUTCMilliseconds(), 3)} +00:00`;
  await sequelize.query("UPDATE organizations SET createdAt = :past WHERE id = :id", {
    replacements: { id: org.id, past: sqliteTimestamp },
  });

  const res = await request(app)
    .post("/api/assistant/ask")
    .set(authHeader(token))
    .send({ question: "How many invoices do I have?" });
  expect(res.status).toBe(402);
});
