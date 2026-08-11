import request from "supertest";
import { app } from "../src/app.js";
import { Organization } from "../src/models/index.js";
import { trialInfo } from "../src/trial.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

describe("trialInfo (unit)", () => {
  test("fresh org has 14 days remaining and is not expired", () => {
    const org = { createdAt: new Date() };
    const info = trialInfo(org);
    expect(info.trialExpired).toBe(false);
    expect(info.trialDaysRemaining).toBe(14);
  });

  test("org created 20 days ago is expired", () => {
    const org = { createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) };
    const info = trialInfo(org);
    expect(info.trialExpired).toBe(true);
    expect(info.trialDaysRemaining).toBe(0);
  });

  test("org created 13.5 days ago is not yet expired", () => {
    const org = { createdAt: new Date(Date.now() - 13.5 * 24 * 60 * 60 * 1000) };
    const info = trialInfo(org);
    expect(info.trialExpired).toBe(false);
  });

  test("fails closed (expired) on missing/unparseable createdAt rather than granting access", () => {
    expect(trialInfo({ createdAt: null }).trialExpired).toBe(true);
    expect(trialInfo({ createdAt: undefined }).trialExpired).toBe(true);
    expect(trialInfo({ createdAt: "not-a-date" }).trialExpired).toBe(true);
  });
});

describe("trial enforcement (integration)", () => {
  test("fresh org can access protected endpoints normally", async () => {
    const token = await signup(app, request, { email: "fresh@trialco.co" });
    const res = await request(app).get("/api/invoices").set(authHeader(token));
    expect(res.status).toBe(200);
  });

  test("expired org gets 402 on protected endpoints but auth routes stay open", async () => {
    const token = await signup(app, request, { email: "expired@trialco.co" });

    const org = await Organization.findOne();
    // Sequelize's timestamp-managed columns silently ignore plain
    // .update()/.save() writes -- go through raw SQL, and match the
    // dialect's own stored datetime format so it round-trips as a valid
    // Date (see trial.js's fail-closed test above for why getting this
    // wrong must never fail open).
    const { sequelize } = await import("../src/db.js");
    await sequelize.query(
      "UPDATE organizations SET createdAt = :past WHERE id = :id",
      { replacements: { id: org.id, past: fakeSqliteTimestamp(20) } }
    );

    const invoicesRes = await request(app).get("/api/invoices").set(authHeader(token));
    expect(invoicesRes.status).toBe(402);
    expect(invoicesRes.body.trial_expired).toBe(true);

    const meRes = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(meRes.status).toBe(200);
    expect(meRes.body.trial_expired).toBe(true);

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: "expired@trialco.co", password: "correcthorse123" });
    expect(loginRes.status).toBe(200);
  });
});

function fakeSqliteTimestamp(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)} +00:00`
  );
}
