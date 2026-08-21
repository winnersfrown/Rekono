import request from "supertest";
import { app } from "../src/app.js";
import { completeGoogleLogin, createGoogleHandoffCode } from "../src/routes/auth.js";
import { User, Organization } from "../src/models/index.js";
import { authHeader, resetDb } from "./testUtils.js";

// GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are never set in the test
// environment (jest.setup.js), so the routes that talk to Google can only be
// exercised down to their "not configured" redirect here -- same limitation
// as the Stripe/Resend-backed routes elsewhere in this suite. What's fully
// covered instead: completeGoogleLogin and createGoogleHandoffCode, the two
// pieces of real logic pulled out of the route handler specifically so they
// don't need a mocked Google to test (see the comment above them in
// routes/auth.js), plus the handoff-code exchange endpoint end to end.

beforeEach(resetDb);

test("GET /api/auth/google redirects to an error instead of crashing when unconfigured", async () => {
  const res = await request(app).get("/api/auth/google");
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe("/app/?google_auth=error&reason=not_configured");
});

test("GET /api/auth/google/callback redirects to an error instead of crashing when unconfigured", async () => {
  const res = await request(app).get("/api/auth/google/callback?code=fake&state=fake");
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe("/app/?google_auth=error&reason=not_configured");
});

describe("completeGoogleLogin", () => {
  test("creates a new org + user for a verified email that doesn't exist yet", async () => {
    const result = await completeGoogleLogin({ email: "new.googler@example.co", email_verified: true, name: "Nina Googler" });
    expect(result.error).toBeUndefined();
    expect(result.user.email).toBe("new.googler@example.co");
    expect(result.user.fullName).toBe("Nina Googler");

    const org = await Organization.findByPk(result.user.orgId);
    expect(org.name).toBe("Nina Googler's Organization");
  });

  test("falls back to the email's local part when Google doesn't send a name", async () => {
    const result = await completeGoogleLogin({ email: "noname@example.co", email_verified: true });
    expect(result.user.fullName).toBe("noname");
  });

  test("logs in the existing user instead of creating a duplicate", async () => {
    const first = await completeGoogleLogin({ email: "repeat@example.co", email_verified: true, name: "Repeat User" });
    const second = await completeGoogleLogin({ email: "REPEAT@example.co", email_verified: true, name: "Repeat User" });
    expect(second.user.id).toBe(first.user.id);
    expect(await User.count()).toBe(1);
  });

  test("rejects an unverified email", async () => {
    const result = await completeGoogleLogin({ email: "unverified@example.co", email_verified: false });
    expect(result.error).toBe("email_unverified");
    expect(await User.count()).toBe(0);
  });

  test("rejects a profile with no email at all", async () => {
    const result = await completeGoogleLogin({ email_verified: true });
    expect(result.error).toBe("email_unverified");
  });
});

describe("handoff code exchange", () => {
  test("a valid code exchanges for a working access token", async () => {
    const { user } = await completeGoogleLogin({ email: "handoff@example.co", email_verified: true, name: "Handoff User" });
    const code = createGoogleHandoffCode(user.id);

    const exchangeRes = await request(app).get(`/api/auth/google/exchange?code=${code}`);
    expect(exchangeRes.status).toBe(200);
    expect(exchangeRes.body.access_token).toBeTruthy();

    const meRes = await request(app).get("/api/auth/me").set(authHeader(exchangeRes.body.access_token));
    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe("handoff@example.co");
  });

  test("a code can only be redeemed once", async () => {
    const { user } = await completeGoogleLogin({ email: "onceonly@example.co", email_verified: true });
    const code = createGoogleHandoffCode(user.id);

    const first = await request(app).get(`/api/auth/google/exchange?code=${code}`);
    expect(first.status).toBe(200);

    const second = await request(app).get(`/api/auth/google/exchange?code=${code}`);
    expect(second.status).toBe(400);
  });

  test("an unknown code is rejected", async () => {
    const res = await request(app).get("/api/auth/google/exchange?code=not-a-real-code");
    expect(res.status).toBe(400);
  });

  test("a missing code is rejected", async () => {
    const res = await request(app).get("/api/auth/google/exchange");
    expect(res.status).toBe(400);
  });
});
