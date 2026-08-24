// Re-authentication gate on destructive actions (auth.js's requireReauth).
// A bearer token is valid for 14 days, so "is signed in" alone is a weak
// basis for irreversibly removing someone's access or tearing out a live
// accounting integration -- these routes ask for the password again.
import request from "supertest";
import { app } from "../src/app.js";
import { Organization, User } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const PASSWORD = "correcthorse123";

async function ownerWithMember() {
  const ownerToken = await signup(app, request);
  const org = await Organization.findOne();
  org.plan = "growth";
  org.billingPeriod = "monthly";
  org.subscriptionStatus = "active";
  await org.save();

  const inviteRes = await request(app)
    .post("/api/team/invite")
    .set(authHeader(ownerToken))
    .send({ email: "teammate@example.co" });
  const inviteToken = new URL(inviteRes.body.invite_url).searchParams.get("invite_token");
  await request(app)
    .post(`/api/team/invite/${inviteToken}/accept`)
    .send({ full_name: "Teammate", password: PASSWORD });

  const member = await User.findOne({ where: { email: "teammate@example.co" } });
  return { ownerToken, member };
}

describe("removing a team member", () => {
  test("is refused without a password, and says so in a way the UI can act on", async () => {
    const { ownerToken, member } = await ownerWithMember();

    const res = await request(app).delete(`/api/team/members/${member.id}`).set(authHeader(ownerToken));

    expect(res.status).toBe(403);
    expect(res.body.reauth_required).toBe(true);
    expect(await User.findByPk(member.id)).not.toBeNull();
  });

  test("is refused with the wrong password", async () => {
    const { ownerToken, member } = await ownerWithMember();

    const res = await request(app)
      .delete(`/api/team/members/${member.id}`)
      .set(authHeader(ownerToken))
      .send({ current_password: "not-the-right-password" });

    expect(res.status).toBe(403);
    expect(res.body.reauth_required).toBe(true);
    expect(await User.findByPk(member.id)).not.toBeNull();
  });

  test("goes through with the correct password", async () => {
    const { ownerToken, member } = await ownerWithMember();

    const res = await request(app)
      .delete(`/api/team/members/${member.id}`)
      .set(authHeader(ownerToken))
      .send({ current_password: PASSWORD });

    expect(res.status).toBe(204);
    expect(await User.findByPk(member.id)).toBeNull();
  });

  test("rate-limits repeated wrong-password attempts", async () => {
    const { ownerToken, member } = await ownerWithMember();

    let sawRateLimit = false;
    for (let i = 0; i < 15; i += 1) {
      const res = await request(app)
        .delete(`/api/team/members/${member.id}`)
        .set(authHeader(ownerToken))
        .send({ current_password: "wrong" });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }

    expect(sawRateLimit).toBe(true);
    expect(await User.findByPk(member.id)).not.toBeNull();
  });
});

describe("disconnecting QuickBooks", () => {
  async function connectedOrg() {
    const token = await signup(app, request);
    const org = await Organization.findOne();
    org.quickbooksRealmId = "realm-1";
    org.quickbooksAccessToken = "access-token";
    org.quickbooksRefreshToken = "refresh-token";
    await org.save();
    return token;
  }

  test("is refused without a password, and leaves the connection intact", async () => {
    const token = await connectedOrg();

    const res = await request(app).post("/api/integrations/quickbooks/disconnect").set(authHeader(token));

    expect(res.status).toBe(403);
    expect(res.body.reauth_required).toBe(true);
    expect((await Organization.findOne()).quickbooksRealmId).toBe("realm-1");
  });

  test("goes through with the correct password", async () => {
    const token = await connectedOrg();

    const res = await request(app)
      .post("/api/integrations/quickbooks/disconnect")
      .set(authHeader(token))
      .send({ current_password: PASSWORD });

    expect(res.status).toBe(200);
    expect((await Organization.findOne()).quickbooksRealmId).toBeNull();
  });
});

test("an unauthenticated caller still gets 401, not a password prompt", async () => {
  const res = await request(app).post("/api/integrations/quickbooks/disconnect");
  expect(res.status).toBe(401);
});
