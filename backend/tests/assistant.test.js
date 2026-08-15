import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

// ANTHROPIC_API_KEY is never set in the test environment (jest.setup.js),
// so every request below exercises the "not configured yet" path rather
// than an actual Claude call -- there's no live key to test the grounded
// answer against in CI. That path is still worth covering: it's what
// every visitor sees until the key is configured, and it must never
// crash or bypass auth/plan gating.

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

test("respects plan gating like every other data route", async () => {
  const token = await signup(app, request, { email: "notonboarded@askco.co", skipOnboarding: true });
  const res = await request(app)
    .post("/api/assistant/ask")
    .set(authHeader(token))
    .send({ question: "How many invoices do I have?" });
  expect(res.status).toBe(402);
  expect(res.body.onboarding_required).toBe(true);
});

test("rate limits after repeated questions from the same org in a short window", async () => {
  const token = await signup(app, request);
  let lastRes;
  for (let i = 0; i < 21; i++) {
    lastRes = await request(app)
      .post("/api/assistant/ask")
      .set(authHeader(token))
      .send({ question: "How many invoices need review?" });
  }
  expect(lastRes.status).toBe(429);
});
