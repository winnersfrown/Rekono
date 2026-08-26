// Rekono's own cross-org usage dashboard (routes/staff.js), gated by
// auth.js's requireStaff -- the one route family that deliberately never
// narrows to a single org.
//
// The allowlist is exercised by mutating settings.staffEmails directly
// (rather than setting STAFF_EMAILS in process.env) because ES module
// imports are hoisted above the rest of a file's code: by the time a plain
// `process.env.STAFF_EMAILS = ...` statement ran, app.js -> config.js would
// already have been imported and settings.staffEmails already computed from
// whatever was in the environment beforehand. Mutating the exported
// `settings` object itself sidesteps that entirely, and since Jest gives
// each test file its own module registry, this never leaks into any other
// test file's config.js.
import request from "supertest";
import { app } from "../src/app.js";
import { settings } from "../src/config.js";
import { Organization } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

const STAFF_EMAIL = "staff@rekono.test";
const SECOND_STAFF_EMAIL = "second-staff@rekono.test";

beforeEach(resetDb);

// True default (empty STAFF_EMAILS) unless a test opts in below --
// confirms nobody, not even the first org's owner, can reach staff routes
// until this is explicitly configured.
afterEach(() => {
  settings.staffEmails = [];
});

test("empty STAFF_EMAILS (the real default) means nobody -- not even the first org's owner -- can reach it", async () => {
  const token = await signup(app, request, { email: "owner@example.co" });
  const res = await request(app).get("/api/staff/overview").set(authHeader(token));
  expect(res.status).toBe(403);
});

test("no token at all is rejected with 401, not 403", async () => {
  const res = await request(app).get("/api/staff/overview");
  expect(res.status).toBe(401);
});

test("a logged-in but non-staff user is rejected with 403, not 401", async () => {
  settings.staffEmails = [STAFF_EMAIL];
  const token = await signup(app, request, { email: "owner@example.co" });
  const res = await request(app).get("/api/staff/overview").set(authHeader(token));
  expect(res.status).toBe(403);
});

test("STAFF_EMAILS matching is case-insensitive and trims whitespace, the way config.js normalizes it", async () => {
  // Mirrors how config.js actually builds this array from a raw env var
  // (split on comma, trim, lowercase) rather than pre-normalized values.
  settings.staffEmails = " Staff@Rekono.test , second-staff@rekono.test "
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const token = await signup(app, request, { email: STAFF_EMAIL });
  const res = await request(app).get("/api/staff/overview").set(authHeader(token));
  expect(res.status).toBe(200);

  const token2 = await signup(app, request, { email: SECOND_STAFF_EMAIL, orgName: "Second Staff Org" });
  const res2 = await request(app).get("/api/staff/overview").set(authHeader(token2));
  expect(res2.status).toBe(200);
});

test("a staff user sees counts spanning multiple different orgs", async () => {
  settings.staffEmails = [STAFF_EMAIL];
  await signup(app, request, { email: "customer-a@example.co", orgName: "Org A" });
  await signup(app, request, { email: "customer-b@example.co", orgName: "Org B" });
  const staffToken = await signup(app, request, { email: STAFF_EMAIL, orgName: "Rekono" });

  const res = await request(app).get("/api/staff/overview").set(authHeader(staffToken));
  expect(res.status).toBe(200);
  // All 3 signups completed onboarding via the shared test helper -- staff's
  // own org counts too, since it's a real (non-demo) org like any other.
  expect(res.body.org_summary.total_orgs).toBe(3);
  expect(res.body.org_summary.completed_onboarding).toBe(3);
  expect(res.body.activation_funnel.signed_up).toBe(3);
});

test("demo orgs are excluded from every aggregate", async () => {
  settings.staffEmails = [STAFF_EMAIL];
  const staffToken = await signup(app, request, { email: STAFF_EMAIL, orgName: "Rekono" });
  await signup(app, request, { email: "customer@example.co", orgName: "Real Org" });

  const demoOrg = await Organization.create({ name: "Demo Org", isDemo: true, plan: "free" });

  const res = await request(app).get("/api/staff/overview").set(authHeader(staffToken));
  expect(res.status).toBe(200);
  // 2 real orgs (staff's own + the customer's); the demo org never counted.
  expect(res.body.org_summary.total_orgs).toBe(2);

  await demoOrg.destroy();
});

test("a normal per-org request right after a staff request still can't see cross-org data", async () => {
  settings.staffEmails = [STAFF_EMAIL];
  await signup(app, request, { email: "customer-a@example.co", orgName: "Org A" });
  const bToken = await signup(app, request, { email: "customer-b@example.co", orgName: "Org B" });
  const staffToken = await signup(app, request, { email: STAFF_EMAIL, orgName: "Rekono" });

  const staffRes = await request(app).get("/api/staff/overview").set(authHeader(staffToken));
  expect(staffRes.body.org_summary.total_orgs).toBe(3);

  // Immediately after a cross-org staff read, an ordinary request from a
  // completely different org must still only see its own single org's team.
  const teamRes = await request(app).get("/api/team").set(authHeader(bToken));
  expect(teamRes.status).toBe(200);
  expect(teamRes.body.members).toHaveLength(1);
  expect(teamRes.body.members[0].email).toBe("customer-b@example.co");
});

test("logs a staff_metrics_viewed audit entry and reports is_staff on /api/auth/me", async () => {
  settings.staffEmails = [STAFF_EMAIL];
  const staffToken = await signup(app, request, { email: STAFF_EMAIL, orgName: "Rekono" });
  await request(app).get("/api/staff/overview").set(authHeader(staffToken));

  const me = await request(app).get("/api/auth/me").set(authHeader(staffToken));
  expect(me.body.is_staff).toBe(true);

  const { AuditLog } = await import("../src/models/index.js");
  const logs = await AuditLog.findAll({ where: { action: "staff_metrics_viewed" }, raw: true });
  expect(logs).toHaveLength(1);
  expect(logs[0].orgId).toBe(me.body.org_id);
});

test("/api/auth/me reports is_staff correctly for staff and non-staff users", async () => {
  settings.staffEmails = [STAFF_EMAIL];
  const staffToken = await signup(app, request, { email: STAFF_EMAIL, orgName: "Rekono" });
  const customerToken = await signup(app, request, { email: "customer@example.co" });

  const staffMe = await request(app).get("/api/auth/me").set(authHeader(staffToken));
  const customerMe = await request(app).get("/api/auth/me").set(authHeader(customerToken));

  expect(staffMe.body.is_staff).toBe(true);
  expect(customerMe.body.is_staff).toBe(false);
});

test("activation funnel counts an org only after it uploads a real document", async () => {
  settings.staffEmails = [STAFF_EMAIL];
  const staffToken = await signup(app, request, { email: STAFF_EMAIL, orgName: "Rekono" });
  const customerToken = await signup(app, request, { email: "customer@example.co" });

  let res = await request(app).get("/api/staff/overview").set(authHeader(staffToken));
  // Neither org has uploaded a real document yet (signup() strips the
  // seeded sample invoice -- see testUtils.js).
  expect(res.body.activation_funnel.uploaded_first_real_document).toBe(0);
  expect(res.body.activation_funnel.approved_first_real_document).toBe(0);

  const upload = await request(app)
    .post("/api/invoices/upload")
    .set(authHeader(customerToken))
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "invoice.pdf", contentType: "application/pdf" });
  expect(upload.status).toBe(201);

  res = await request(app).get("/api/staff/overview").set(authHeader(staffToken));
  expect(res.body.activation_funnel.uploaded_first_real_document).toBe(1);
  expect(res.body.activation_funnel.approved_first_real_document).toBe(0);
});
