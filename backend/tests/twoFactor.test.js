// TOTP-based 2FA: login-time verification (routes/auth.js's
// /api/auth/2fa/verify) and account settings (setup/enable/disable/
// regenerate). Mirrors reauth.test.js's structure for the password-gated
// routes (disable, regenerate) since they use the same requireReauth gate.
import request from "supertest";
import { generate } from "otplib";
import { app } from "../src/app.js";
import { User } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const PASSWORD = "correcthorse123";

// Runs setup + enable for an already-signed-up account, returning the token
// plus everything a test might want to assert against afterward.
async function enableTwoFactorFor(token) {
  const setupRes = await request(app).post("/api/auth/2fa/setup").set(authHeader(token));
  const secret = setupRes.body.secret;
  const code = await generate({ secret });
  const enableRes = await request(app).post("/api/auth/2fa/enable").set(authHeader(token)).send({ code });
  return { secret, backupCodes: enableRes.body.backup_codes };
}

test("a normal account without 2FA logs in with a single step, as before", async () => {
  const token = await signup(app, request, { email: "no2fa@example.co" });
  const res = await request(app).post("/api/auth/login").send({ email: "no2fa@example.co", password: PASSWORD });
  expect(res.status).toBe(200);
  expect(res.body.access_token).toBeTruthy();
  expect(res.body.two_factor_required).toBeUndefined();

  const me = await request(app).get("/api/auth/me").set(authHeader(token));
  expect(me.body.two_factor_enabled).toBe(false);
});

describe("setup and enable", () => {
  test("setup returns a secret and a scannable QR code, unconfirmed until enable", async () => {
    const token = await signup(app, request, { email: "setup@example.co" });
    const res = await request(app).post("/api/auth/2fa/setup").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.secret).toBeTruthy();
    expect(res.body.qr_code_data_url).toMatch(/^data:image\/png;base64,/);
    expect(res.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);

    const me = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(me.body.two_factor_enabled).toBe(false);
  });

  test("requires authentication", async () => {
    const res = await request(app).post("/api/auth/2fa/setup");
    expect(res.status).toBe(401);
  });

  test("enable with the correct code turns it on and returns backup codes once", async () => {
    const token = await signup(app, request, { email: "enable@example.co" });
    const { backupCodes } = await enableTwoFactorFor(token);

    expect(backupCodes).toHaveLength(8);
    expect(new Set(backupCodes).size).toBe(8); // all distinct

    const me = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(me.body.two_factor_enabled).toBe(true);
  });

  test("enable is rejected with the wrong code", async () => {
    const token = await signup(app, request, { email: "wrongcode@example.co" });
    await request(app).post("/api/auth/2fa/setup").set(authHeader(token));
    const res = await request(app).post("/api/auth/2fa/enable").set(authHeader(token)).send({ code: "000000" });
    expect(res.status).toBe(401);

    const me = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(me.body.two_factor_enabled).toBe(false);
  });

  test("enable without setup first is rejected", async () => {
    const token = await signup(app, request, { email: "nosetup@example.co" });
    const res = await request(app).post("/api/auth/2fa/enable").set(authHeader(token)).send({ code: "123456" });
    expect(res.status).toBe(400);
  });

  test("enabling twice is rejected the second time", async () => {
    const token = await signup(app, request, { email: "twiceenable@example.co" });
    await enableTwoFactorFor(token);

    const setupRes = await request(app).post("/api/auth/2fa/setup").set(authHeader(token));
    const code = await generate({ secret: setupRes.body.secret });
    const res = await request(app).post("/api/auth/2fa/enable").set(authHeader(token)).send({ code });
    expect(res.status).toBe(400);
  });
});

describe("login with 2FA enabled", () => {
  test("password alone returns a pending token, not access", async () => {
    const token = await signup(app, request, { email: "pending@example.co" });
    await enableTwoFactorFor(token);

    const res = await request(app).post("/api/auth/login").send({ email: "pending@example.co", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.two_factor_required).toBe(true);
    expect(res.body.access_token).toBeUndefined();
    expect(res.body.pending_token).toBeTruthy();
  });

  test("verify with the correct TOTP code completes login", async () => {
    const token = await signup(app, request, { email: "verify@example.co" });
    const { secret } = await enableTwoFactorFor(token);

    const loginRes = await request(app).post("/api/auth/login").send({ email: "verify@example.co", password: PASSWORD });
    const code = await generate({ secret });
    const verifyRes = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ pending_token: loginRes.body.pending_token, code });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.access_token).toBeTruthy();

    const me = await request(app).get("/api/auth/me").set(authHeader(verifyRes.body.access_token));
    expect(me.body.email).toBe("verify@example.co");
  });

  test("verify with an incorrect code is rejected", async () => {
    const token = await signup(app, request, { email: "badcode@example.co" });
    await enableTwoFactorFor(token);

    const loginRes = await request(app).post("/api/auth/login").send({ email: "badcode@example.co", password: PASSWORD });
    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ pending_token: loginRes.body.pending_token, code: "000000" });

    expect(res.status).toBe(401);
  });

  test("verify with a valid backup code completes login and consumes it", async () => {
    const token = await signup(app, request, { email: "backup@example.co" });
    const { backupCodes } = await enableTwoFactorFor(token);

    const loginRes = await request(app).post("/api/auth/login").send({ email: "backup@example.co", password: PASSWORD });
    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ pending_token: loginRes.body.pending_token, code: backupCodes[0] });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();

    // The same code can't be reused -- a fresh login attempt with it fails.
    const secondLoginRes = await request(app).post("/api/auth/login").send({ email: "backup@example.co", password: PASSWORD });
    const reuseRes = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ pending_token: secondLoginRes.body.pending_token, code: backupCodes[0] });
    expect(reuseRes.status).toBe(401);
  });

  test("a backup code works regardless of dashes or case", async () => {
    const token = await signup(app, request, { email: "backupcase@example.co" });
    const { backupCodes } = await enableTwoFactorFor(token);
    const messyCode = backupCodes[0].replace("-", "").toLowerCase();

    const loginRes = await request(app).post("/api/auth/login").send({ email: "backupcase@example.co", password: PASSWORD });
    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ pending_token: loginRes.body.pending_token, code: messyCode });
    expect(res.status).toBe(200);
  });

  test("an expired/garbage pending token is rejected", async () => {
    const res = await request(app).post("/api/auth/2fa/verify").send({ pending_token: "not-a-real-token", code: "123456" });
    expect(res.status).toBe(401);
  });

  test("a real access token cannot be used as a pending token", async () => {
    const token = await signup(app, request, { email: "wrongtokentype@example.co" });
    await enableTwoFactorFor(token);
    // `token` here is a normal signup access token, not a pending-2FA one --
    // verifyPending2faToken must reject it even though it's validly signed.
    const res = await request(app).post("/api/auth/2fa/verify").send({ pending_token: token, code: "123456" });
    expect(res.status).toBe(401);
  });

  test("rate-limits repeated wrong codes", async () => {
    const token = await signup(app, request, { email: "ratelimited@example.co" });
    await enableTwoFactorFor(token);
    const loginRes = await request(app).post("/api/auth/login").send({ email: "ratelimited@example.co", password: PASSWORD });

    let sawRateLimit = false;
    for (let i = 0; i < 15; i += 1) {
      const res = await request(app)
        .post("/api/auth/2fa/verify")
        .send({ pending_token: loginRes.body.pending_token, code: "000000" });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});

describe("disable", () => {
  test("is refused without a password, and leaves 2FA on", async () => {
    const token = await signup(app, request, { email: "disablenopass@example.co" });
    await enableTwoFactorFor(token);

    const res = await request(app).post("/api/auth/2fa/disable").set(authHeader(token));
    expect(res.status).toBe(403);
    expect(res.body.reauth_required).toBe(true);

    const me = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(me.body.two_factor_enabled).toBe(true);
  });

  test("goes through with the correct password, and login goes back to one step", async () => {
    const token = await signup(app, request, { email: "disable@example.co" });
    await enableTwoFactorFor(token);

    const res = await request(app)
      .post("/api/auth/2fa/disable")
      .set(authHeader(token))
      .send({ current_password: PASSWORD });
    expect(res.status).toBe(200);

    const me = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(me.body.two_factor_enabled).toBe(false);

    const loginRes = await request(app).post("/api/auth/login").send({ email: "disable@example.co", password: PASSWORD });
    expect(loginRes.body.access_token).toBeTruthy();
    expect(loginRes.body.two_factor_required).toBeUndefined();
  });

  test("clears the stored secret, so re-enabling needs a fresh setup", async () => {
    const token = await signup(app, request, { email: "disableclears@example.co" });
    await enableTwoFactorFor(token);
    await request(app).post("/api/auth/2fa/disable").set(authHeader(token)).send({ current_password: PASSWORD });

    const user = await User.findOne({ where: { email: "disableclears@example.co" } });
    expect(user.totpSecret).toBeFalsy();
    expect(user.totpBackupCodeHashes).toBeFalsy();
  });
});

describe("regenerate backup codes", () => {
  test("is refused without a password", async () => {
    const token = await signup(app, request, { email: "regennopass@example.co" });
    await enableTwoFactorFor(token);

    const res = await request(app).post("/api/auth/2fa/backup-codes/regenerate").set(authHeader(token));
    expect(res.status).toBe(403);
    expect(res.body.reauth_required).toBe(true);
  });

  test("invalidates old codes and returns a fresh set", async () => {
    const token = await signup(app, request, { email: "regen@example.co" });
    const { backupCodes: oldCodes } = await enableTwoFactorFor(token);

    const res = await request(app)
      .post("/api/auth/2fa/backup-codes/regenerate")
      .set(authHeader(token))
      .send({ current_password: PASSWORD });
    expect(res.status).toBe(200);
    const newCodes = res.body.backup_codes;
    expect(newCodes).toHaveLength(8);
    expect(newCodes).not.toEqual(oldCodes);

    // An old code no longer works.
    const loginRes = await request(app).post("/api/auth/login").send({ email: "regen@example.co", password: PASSWORD });
    const oldCodeRes = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ pending_token: loginRes.body.pending_token, code: oldCodes[0] });
    expect(oldCodeRes.status).toBe(401);

    // A new code does.
    const loginRes2 = await request(app).post("/api/auth/login").send({ email: "regen@example.co", password: PASSWORD });
    const newCodeRes = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ pending_token: loginRes2.body.pending_token, code: newCodes[0] });
    expect(newCodeRes.status).toBe(200);
  });

  test("is rejected when 2FA isn't enabled", async () => {
    const token = await signup(app, request, { email: "regennotenabled@example.co" });
    const res = await request(app)
      .post("/api/auth/2fa/backup-codes/regenerate")
      .set(authHeader(token))
      .send({ current_password: PASSWORD });
    expect(res.status).toBe(400);
  });
});
