import request from "supertest";
import { app } from "../src/app.js";

// RESEND_API_KEY is never set in the test environment (jest.setup.js), so
// every valid submission below exercises the "not configured yet" path
// rather than an actual send -- there's no live API key to test against in
// CI. The honeypot and validation paths are fully covered regardless,
// since they return before the Resend call is ever made.

test("rejects missing fields", async () => {
  const res = await request(app).post("/api/contact").send({ name: "Ada" });
  expect(res.status).toBe(422);
});

test("rejects invalid email", async () => {
  const res = await request(app)
    .post("/api/contact")
    .send({ name: "Ada", email: "not-an-email", message: "Hello" });
  expect(res.status).toBe(422);
});

test("honeypot field silently short-circuits without sending", async () => {
  const res = await request(app)
    .post("/api/contact")
    .send({ name: "Bot", email: "bot@example.co", message: "spam", company: "filled in by a bot" });
  expect(res.status).toBe(202);
  expect(res.body.ok).toBe(true);
});

test("valid submission without RESEND_API_KEY configured returns 503, not a crash", async () => {
  const res = await request(app)
    .post("/api/contact")
    .send({ name: "Ada Lovelace", email: "ada@example.co", message: "Interested in a demo." });
  expect(res.status).toBe(503);
  expect(res.body.detail).toMatch(/configured/i);
});

test("rate limits after repeated submissions from the same IP", async () => {
  const payload = { name: "Ada", email: "ada@example.co", message: "Hi" };
  let lastRes;
  for (let i = 0; i < 6; i++) {
    lastRes = await request(app).post("/api/contact").send(payload);
  }
  expect(lastRes.status).toBe(429);
});
