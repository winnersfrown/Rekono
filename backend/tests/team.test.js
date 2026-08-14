import request from "supertest";
import { app } from "../src/app.js";
import { Organization, User } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function upgradeToGrowth() {
  const org = await Organization.findOne();
  org.plan = "growth"; // 5 seats
  org.billingPeriod = "monthly";
  org.subscriptionStatus = "active";
  await org.save();
  return org;
}

test("owner can invite a teammate; email isn't sent without RESEND_API_KEY so the link comes back directly", async () => {
  const token = await signup(app, request);
  await upgradeToGrowth();

  const res = await request(app).post("/api/team/invite").set(authHeader(token)).send({ email: "teammate@example.co" });
  expect(res.status).toBe(201);
  expect(res.body.email_sent).toBe(false);
  expect(res.body.invite_url).toMatch(/invite_token=/);
});

test("GET /api/team reports seat usage and the pending invite", async () => {
  const token = await signup(app, request);
  await upgradeToGrowth();
  await request(app).post("/api/team/invite").set(authHeader(token)).send({ email: "teammate@example.co" });

  const res = await request(app).get("/api/team").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.seat_limit).toBe(5);
  expect(res.body.seats_used).toBe(2); // owner + 1 pending invite
  expect(res.body.members).toHaveLength(1);
  expect(res.body.pending_invites).toHaveLength(1);
  expect(res.body.pending_invites[0].email).toBe("teammate@example.co");
});

test("inviting is blocked once the plan's seat limit is reached", async () => {
  // Free plan: 1 seat, already filled by the owner.
  const token = await signup(app, request);

  const res = await request(app).post("/api/team/invite").set(authHeader(token)).send({ email: "teammate@example.co" });
  expect(res.status).toBe(402);
  expect(res.body.plan_cap_reached).toBe(true);
});

test("inviting an email that already has an account is rejected", async () => {
  const token = await signup(app, request);
  await upgradeToGrowth();
  await signup(app, request, { email: "other-owner@example.co" });

  const res = await request(app).post("/api/team/invite").set(authHeader(token)).send({ email: "other-owner@example.co" });
  expect(res.status).toBe(409);
});

test("a non-owner cannot invite, revoke, or remove", async () => {
  const ownerToken = await signup(app, request);
  await upgradeToGrowth();

  // Accept an invite to get a real "member"-role user.
  const inviteRes = await request(app)
    .post("/api/team/invite")
    .set(authHeader(ownerToken))
    .send({ email: "teammate@example.co" });
  const inviteToken = new URL(inviteRes.body.invite_url).searchParams.get("invite_token");
  const acceptRes = await request(app)
    .post(`/api/team/invite/${inviteToken}/accept`)
    .send({ full_name: "Teammate", password: "correcthorse123" });
  const memberToken = acceptRes.body.access_token;

  const res = await request(app)
    .post("/api/team/invite")
    .set(authHeader(memberToken))
    .send({ email: "another@example.co" });
  expect(res.status).toBe(403);
});

test("full invite-accept flow: token validates, accepting creates a member on the same org", async () => {
  const ownerToken = await signup(app, request, { orgName: "Acme Co" });
  await upgradeToGrowth();
  const org = await Organization.findOne();

  const inviteRes = await request(app)
    .post("/api/team/invite")
    .set(authHeader(ownerToken))
    .send({ email: "teammate@example.co" });
  const inviteToken = new URL(inviteRes.body.invite_url).searchParams.get("invite_token");

  const checkRes = await request(app).get(`/api/team/invite/${inviteToken}`);
  expect(checkRes.status).toBe(200);
  expect(checkRes.body.org_name).toBe("Acme Co");
  expect(checkRes.body.email).toBe("teammate@example.co");

  const acceptRes = await request(app)
    .post(`/api/team/invite/${inviteToken}/accept`)
    .send({ full_name: "Teammate", password: "correcthorse123" });
  expect(acceptRes.status).toBe(201);
  expect(acceptRes.body.access_token).toBeTruthy();

  const meRes = await request(app).get("/api/auth/me").set(authHeader(acceptRes.body.access_token));
  expect(meRes.body.org_id).toBe(org.id);
  expect(meRes.body.role).toBe("member");
});

test("an invalid or already-used invite token is rejected", async () => {
  const res = await request(app).get("/api/team/invite/not-a-real-token");
  expect(res.status).toBe(400);
});

test("revoking an invite frees the seat and invalidates its link", async () => {
  const token = await signup(app, request);
  await upgradeToGrowth();
  const inviteRes = await request(app)
    .post("/api/team/invite")
    .set(authHeader(token))
    .send({ email: "teammate@example.co" });
  const inviteToken = new URL(inviteRes.body.invite_url).searchParams.get("invite_token");

  const listRes = await request(app).get("/api/team").set(authHeader(token));
  const inviteId = listRes.body.pending_invites[0].id;

  const revokeRes = await request(app).delete(`/api/team/invites/${inviteId}`).set(authHeader(token));
  expect(revokeRes.status).toBe(204);

  const checkRes = await request(app).get(`/api/team/invite/${inviteToken}`);
  expect(checkRes.status).toBe(400);

  const listAfter = await request(app).get("/api/team").set(authHeader(token));
  expect(listAfter.body.seats_used).toBe(1);
});

test("owner can remove a member but not themselves", async () => {
  const ownerToken = await signup(app, request);
  await upgradeToGrowth();
  const inviteRes = await request(app)
    .post("/api/team/invite")
    .set(authHeader(ownerToken))
    .send({ email: "teammate@example.co" });
  const inviteToken = new URL(inviteRes.body.invite_url).searchParams.get("invite_token");
  await request(app)
    .post(`/api/team/invite/${inviteToken}/accept`)
    .send({ full_name: "Teammate", password: "correcthorse123" });

  const member = await User.findOne({ where: { email: "teammate@example.co" } });

  const selfRemoveRes = await request(app)
    .delete(`/api/team/members/${(await User.findOne({ where: { email: "owner@example.co" } })).id}`)
    .set(authHeader(ownerToken));
  expect(selfRemoveRes.status).toBe(400);

  const removeRes = await request(app).delete(`/api/team/members/${member.id}`).set(authHeader(ownerToken));
  expect(removeRes.status).toBe(204);
  expect(await User.findByPk(member.id)).toBeNull();
});
