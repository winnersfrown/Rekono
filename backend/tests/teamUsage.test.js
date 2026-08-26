// Per-org "how is my team actually using Rekono" breakdown (routes/team.js's
// GET /api/team/usage) -- distinct from routes/dashboard.js's /trends, which
// is about the org's own business metrics, not who on the team is doing what.
import request from "supertest";
import { app } from "../src/app.js";
import { AuditLog, Organization, User } from "../src/models/index.js";
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
  const acceptRes = await request(app)
    .post(`/api/team/invite/${inviteToken}/accept`)
    .send({ full_name: "Teammate", password: PASSWORD });

  const member = await User.findOne({ where: { email: "teammate@example.co" } });
  return { ownerToken, memberToken: acceptRes.body.access_token, member, org };
}

test("requires authentication", async () => {
  const res = await request(app).get("/api/team/usage");
  expect(res.status).toBe(401);
});

test("a non-owner is refused", async () => {
  const { memberToken } = await ownerWithMember();
  const res = await request(app).get("/api/team/usage").set(authHeader(memberToken));
  expect(res.status).toBe(403);
});

test("every current member appears, even with no activity at all", async () => {
  const { ownerToken } = await ownerWithMember();
  const res = await request(app).get("/api/team/usage").set(authHeader(ownerToken));
  expect(res.status).toBe(200);
  expect(res.body.window_days).toBe(30);
  expect(res.body.members).toHaveLength(2); // owner + teammate
  for (const m of res.body.members) {
    expect(m).toMatchObject({ uploaded: 0, approved: 0, rejected: 0, corrections: 0, total_actions: 0 });
  }
});

test("counts activity per member, split by action", async () => {
  const { ownerToken, member, org } = await ownerWithMember();
  const owner = await User.findOne({ where: { email: "owner@example.co" } });

  await AuditLog.bulkCreate([
    { orgId: org.id, userId: owner.id, action: "uploaded", actor: owner.email },
    { orgId: org.id, userId: owner.id, action: "uploaded", actor: owner.email },
    { orgId: org.id, userId: owner.id, action: "approved", actor: owner.email },
    { orgId: org.id, userId: member.id, action: "rejected", actor: member.email },
    { orgId: org.id, userId: member.id, action: "human_correction", actor: member.email },
    { orgId: org.id, userId: member.id, action: "quick_review_field", actor: member.email },
  ]);

  const res = await request(app).get("/api/team/usage").set(authHeader(ownerToken));
  const byId = Object.fromEntries(res.body.members.map((m) => [m.user_id, m]));

  expect(byId[owner.id]).toMatchObject({ uploaded: 2, approved: 1, rejected: 0, corrections: 0, total_actions: 3 });
  // human_correction and quick_review_field both roll up into "corrections".
  expect(byId[member.id]).toMatchObject({ uploaded: 0, approved: 0, rejected: 1, corrections: 2, total_actions: 3 });
});

test("activity outside the 30-day window doesn't count", async () => {
  const { ownerToken, org } = await ownerWithMember();
  const owner = await User.findOne({ where: { email: "owner@example.co" } });

  const old = new Date();
  old.setDate(old.getDate() - 45);
  await AuditLog.create({ orgId: org.id, userId: owner.id, action: "uploaded", actor: owner.email, createdAt: old });

  const res = await request(app).get("/api/team/usage").set(authHeader(ownerToken));
  const ownerStats = res.body.members.find((m) => m.user_id === owner.id);
  expect(ownerStats.uploaded).toBe(0);
});

test("activity with no user attached (e.g. auto-approval) isn't counted toward anyone", async () => {
  const { ownerToken, org } = await ownerWithMember();
  await AuditLog.create({ orgId: org.id, userId: null, action: "auto_approved", actor: "system" });

  const res = await request(app).get("/api/team/usage").set(authHeader(ownerToken));
  const total = res.body.members.reduce((sum, m) => sum + m.total_actions, 0);
  expect(total).toBe(0);
});

test("account-management actions (e.g. password changes) aren't counted as usage", async () => {
  const { ownerToken, org } = await ownerWithMember();
  const owner = await User.findOne({ where: { email: "owner@example.co" } });
  await AuditLog.create({ orgId: org.id, userId: owner.id, action: "password_changed", actor: owner.email });

  const res = await request(app).get("/api/team/usage").set(authHeader(ownerToken));
  const ownerStats = res.body.members.find((m) => m.user_id === owner.id);
  expect(ownerStats.total_actions).toBe(0);
});

test("a removed member's old activity doesn't get attributed to anyone still listed", async () => {
  const { ownerToken, member, org } = await ownerWithMember();
  await AuditLog.create({ orgId: org.id, userId: member.id, action: "uploaded", actor: member.email });
  await request(app).delete(`/api/team/members/${member.id}`).set(authHeader(ownerToken)).send({ current_password: PASSWORD });

  const res = await request(app).get("/api/team/usage").set(authHeader(ownerToken));
  expect(res.body.members).toHaveLength(1); // only the owner remains
  expect(res.body.members[0].total_actions).toBe(0);
});
