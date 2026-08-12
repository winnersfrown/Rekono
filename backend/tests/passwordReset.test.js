import crypto from "node:crypto";
import request from "supertest";
import { app } from "../src/app.js";
import { resetDb, signup } from "./testUtils.js";

// RESEND_API_KEY is never set in the test environment (jest.setup.js), so
// forgot-password never actually sends -- see the route comment for why it
// still has to return the exact same response either way (anything that
// differs based on whether the email matched an account, or whether the
// key happened to be configured, is an email-enumeration side channel).
// The reset-password happy path is tested by seeding a token directly via
// the ORM, the same way trial.test.js and assistant.test.js seed state that
// would otherwise require a real external call to reach.
//
// Both routes rate-limit per IP (see auth.js), and app.js has "trust proxy"
// on, so each test sends a distinct X-Forwarded-For -- otherwise every test
// in this file would share one in-memory bucket (supertest requests all
// originate from the same loopback address) and legitimate earlier tests
// would exhaust the budget before the dedicated rate-limit tests even run.

beforeEach(resetDb);

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.0.0.${ipCounter}`;
}

async function seedResetToken(email, { expiresInMs = 60 * 60 * 1000 } = {}) {
  const { User } = await import("../src/models/index.js");
  const user = await User.findOne({ where: { email } });
  const token = crypto.randomBytes(32).toString("hex");
  user.passwordResetTokenHash = crypto.createHash("sha256").update(token).digest("hex");
  user.passwordResetExpiresAt = new Date(Date.now() + expiresInMs);
  await user.save();
  return token;
}

test("forgot-password with an unknown email returns the generic response", async () => {
  const res = await request(app)
    .post("/api/auth/forgot-password")
    .set("X-Forwarded-For", nextIp())
    .send({ email: "nobody@example.co" });
  expect(res.status).toBe(202);
  expect(res.body.detail).toMatch(/if an account exists/i);
});

test("forgot-password with a real account returns the identical generic response and, without a configured key, does not issue a token", async () => {
  await signup(app, request, { email: "realuser@example.co" });
  const res = await request(app)
    .post("/api/auth/forgot-password")
    .set("X-Forwarded-For", nextIp())
    .send({ email: "realuser@example.co" });
  expect(res.status).toBe(202);
  expect(res.body.detail).toMatch(/if an account exists/i);

  const { User } = await import("../src/models/index.js");
  const user = await User.findOne({ where: { email: "realuser@example.co" } });
  expect(user.passwordResetTokenHash).toBeNull();
});

test("forgot-password rejects an invalid email", async () => {
  const res = await request(app)
    .post("/api/auth/forgot-password")
    .set("X-Forwarded-For", nextIp())
    .send({ email: "not-an-email" });
  expect(res.status).toBe(422);
});

test("forgot-password rate limits after repeated requests from the same IP", async () => {
  const ip = nextIp();
  let lastRes;
  for (let i = 0; i < 6; i++) {
    lastRes = await request(app)
      .post("/api/auth/forgot-password")
      .set("X-Forwarded-For", ip)
      .send({ email: `flood${i}@example.co` });
  }
  expect(lastRes.status).toBe(429);
});

test("reset-password with a valid token sets the new password and logs the user in", async () => {
  await signup(app, request, { email: "reset@example.co", password: "oldpassword123" });
  const token = await seedResetToken("reset@example.co");

  const res = await request(app)
    .post("/api/auth/reset-password")
    .set("X-Forwarded-For", nextIp())
    .send({ token, password: "brandnewpassword456" });
  expect(res.status).toBe(200);
  expect(res.body.access_token).toBeTruthy();

  const oldLogin = await request(app).post("/api/auth/login").send({ email: "reset@example.co", password: "oldpassword123" });
  expect(oldLogin.status).toBe(401);

  const newLogin = await request(app).post("/api/auth/login").send({ email: "reset@example.co", password: "brandnewpassword456" });
  expect(newLogin.status).toBe(200);
});

test("reset-password token is single-use", async () => {
  await signup(app, request, { email: "singleuse@example.co", password: "oldpassword123" });
  const token = await seedResetToken("singleuse@example.co");
  const ip = nextIp();

  const first = await request(app).post("/api/auth/reset-password").set("X-Forwarded-For", ip).send({ token, password: "firstnewpassword1" });
  expect(first.status).toBe(200);

  const second = await request(app).post("/api/auth/reset-password").set("X-Forwarded-For", ip).send({ token, password: "secondnewpassword2" });
  expect(second.status).toBe(400);
});

test("reset-password rejects an expired token", async () => {
  await signup(app, request, { email: "expired@example.co" });
  const token = await seedResetToken("expired@example.co", { expiresInMs: -1000 });

  const res = await request(app)
    .post("/api/auth/reset-password")
    .set("X-Forwarded-For", nextIp())
    .send({ token, password: "newpassword123" });
  expect(res.status).toBe(400);
});

test("reset-password rejects an unknown token", async () => {
  const res = await request(app)
    .post("/api/auth/reset-password")
    .set("X-Forwarded-For", nextIp())
    .send({ token: "not-a-real-token", password: "newpassword123" });
  expect(res.status).toBe(400);
});

test("reset-password validates the new password length", async () => {
  await signup(app, request, { email: "shortpass@example.co" });
  const token = await seedResetToken("shortpass@example.co");

  const res = await request(app)
    .post("/api/auth/reset-password")
    .set("X-Forwarded-For", nextIp())
    .send({ token, password: "short" });
  expect(res.status).toBe(422);
});

test("reset-password rate limits after repeated requests from the same IP", async () => {
  const ip = nextIp();
  let lastRes;
  for (let i = 0; i < 6; i++) {
    lastRes = await request(app)
      .post("/api/auth/reset-password")
      .set("X-Forwarded-For", ip)
      .send({ token: `bogus-${i}`, password: "newpassword123" });
  }
  expect(lastRes.status).toBe(429);
});
