import request from "supertest";
import { app } from "../src/app.js";
import { AuditLog, ExpenseReceipt, Invoice, Lease, MatchEntry, MatchResult, MatchSource, VendorDocument } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

function isoDateDaysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function makeInvoice(org, overrides = {}) {
  return Invoice.create({
    orgId: org,
    originalFilename: "invoice.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Co",
    overallConfidence: 0.9,
    ...overrides,
  });
}

test("requires authentication", async () => {
  const res = await request(app).get("/api/dashboard");
  expect(res.status).toBe(401);
});

test("a brand-new org gets honest zeroes, not nulls", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/dashboard").set(authHeader(token));

  expect(res.status).toBe(200);
  expect(res.body.kpis.outstanding_ap).toBe(0);
  expect(res.body.kpis.approved_this_month_value).toBe(0);
  expect(res.body.kpis.review_queue).toBe(0);
  expect(res.body.kpis.documents_used_this_month).toBe(0);
  // Genuinely unmeasurable (no data) stays null so the UI can say "—"
  // rather than claiming a real 0%.
  expect(res.body.kpis.avg_confidence).toBeNull();
  expect(res.body.kpis.touchless.rate).toBeNull();
});

test("outstanding AP sums approved unpaid invoices and flags overdue ones", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  await makeInvoice(org, { status: "approved", total: 100, dueDate: isoDateDaysFromNow(10) });
  await makeInvoice(org, { status: "approved", total: 250, dueDate: isoDateDaysFromNow(-5) }); // overdue
  // Already paid -- must not count toward what's still owed.
  await makeInvoice(org, { status: "approved", total: 999, quickbooksPaidAt: new Date() });
  // Not approved yet -- not an obligation.
  await makeInvoice(org, { status: "needs_review", total: 500 });

  const res = await request(app).get("/api/dashboard").set(authHeader(token));
  expect(res.body.kpis.outstanding_ap).toBe(350);
  expect(res.body.kpis.outstanding_ap_count).toBe(2);
  expect(res.body.kpis.overdue_count).toBe(1);
});

test("review queue counts needs_review across all four document types", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const base = { orgId: org, storagePath: "/tmp/x.pdf", contentType: "application/pdf", status: "needs_review" };

  await makeInvoice(org, { status: "needs_review" });
  await ExpenseReceipt.create({ ...base, originalFilename: "r.pdf", merchantName: "Cafe" });
  await VendorDocument.create({ ...base, originalFilename: "w9.pdf", vendorName: "Acme" });
  await Lease.create({ ...base, originalFilename: "lease.pdf", landlordName: "Meridian" });

  const res = await request(app).get("/api/dashboard").set(authHeader(token));
  expect(res.body.kpis.review_queue).toBe(4);

  const byKey = Object.fromEntries(res.body.workflow.map((w) => [w.key, w.count]));
  expect(byKey.invoices).toBe(1);
  expect(byKey.expenses).toBe(1);
  expect(byKey.vendordocs).toBe(1);
  expect(byKey.leases).toBe(1);
});

test("touchless rate is the auto-approved share of this month's approvals", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  await AuditLog.create({ orgId: org, action: "auto_approved", actor: "system", details: {} });
  await AuditLog.create({ orgId: org, action: "auto_approved", actor: "system", details: {} });
  await AuditLog.create({ orgId: org, action: "approved", actor: "a@b.co", details: {} });
  await AuditLog.create({ orgId: org, action: "approved", actor: "a@b.co", details: {} });
  // Unrelated actions must not dilute the denominator.
  await AuditLog.create({ orgId: org, action: "uploaded", actor: "a@b.co", details: {} });

  const res = await request(app).get("/api/dashboard").set(authHeader(token));
  expect(res.body.kpis.touchless.auto_approved).toBe(2);
  expect(res.body.kpis.touchless.total_approvals).toBe(4);
  expect(res.body.kpis.touchless.rate).toBe(0.5);
});

test("unmatched counts approved invoices with no matched result", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  const matched = await makeInvoice(org, { status: "approved", total: 100 });
  await makeInvoice(org, { status: "approved", total: 200 }); // no match result
  const source = await MatchSource.create({ orgId: org, name: "po.csv", sourceType: "po" });
  const entry = await MatchEntry.create({ sourceId: source.id, vendor: "Acme Co", amount: 100 });
  await MatchResult.create({ invoiceId: matched.id, matchEntryId: entry.id, status: "matched", score: 99 });

  const res = await request(app).get("/api/dashboard").set(authHeader(token));
  const unmatched = res.body.workflow.find((w) => w.key === "unmatched");
  expect(unmatched.count).toBe(1);
});

test("attention surfaces expiring vendor docs and lease deadlines", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const base = { orgId: org, storagePath: "/tmp/x.pdf", contentType: "application/pdf", status: "approved" };

  await VendorDocument.create({ ...base, originalFilename: "coi.pdf", vendorName: "A", expirationDate: isoDateDaysFromNow(10) });
  await VendorDocument.create({ ...base, originalFilename: "far.pdf", vendorName: "B", expirationDate: isoDateDaysFromNow(200) });
  // Renewal deadline soon even though expiration is far out -- the case the
  // lease module exists for.
  await Lease.create({
    ...base,
    originalFilename: "lease.pdf",
    landlordName: "Meridian",
    expirationDate: isoDateDaysFromNow(400),
    renewalNoticeDeadline: isoDateDaysFromNow(20),
  });

  const res = await request(app).get("/api/dashboard").set(authHeader(token));
  const byKey = Object.fromEntries(res.body.attention.map((a) => [a.key, a.count]));
  expect(byKey.vendor_docs_expiring).toBe(1);
  expect(byKey.lease_deadlines).toBe(1);
});

test("volume trend returns 14 dated buckets ending today", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeInvoice(org);

  const res = await request(app).get("/api/dashboard").set(authHeader(token));
  const trend = res.body.volume_trend;

  expect(trend).toHaveLength(14);
  expect(trend[13].date).toBe(new Date().toISOString().slice(0, 10));
  expect(trend[13].count).toBe(1);
  expect(trend.reduce((sum, d) => sum + d.count, 0)).toBe(1);
});

test("never leaks another org's data", async () => {
  const mine = await signup(app, request, { email: "mine@example.co" });
  const theirs = await signup(app, request, { email: "theirs@example.co", orgName: "Other Co" });
  const theirOrg = await orgId(theirs);

  await makeInvoice(theirOrg, { status: "approved", total: 5000 });
  await makeInvoice(theirOrg, { status: "needs_review" });

  const res = await request(app).get("/api/dashboard").set(authHeader(mine));
  expect(res.body.kpis.outstanding_ap).toBe(0);
  expect(res.body.kpis.review_queue).toBe(0);
  expect(res.body.volume_trend.reduce((sum, d) => sum + d.count, 0)).toBe(0);
});

test("the demo org's seeded data produces a fully populated dashboard", async () => {
  const login = await request(app).post("/api/demo/login").send({});
  const res = await request(app).get("/api/dashboard").set(authHeader(login.body.access_token));

  expect(res.status).toBe(200);
  expect(res.body.kpis.review_queue).toBeGreaterThan(0);
  expect(res.body.kpis.outstanding_ap).toBeGreaterThan(0);
  expect(res.body.kpis.avg_confidence).toBeGreaterThan(0);
  expect(res.body.volume_trend.reduce((sum, d) => sum + d.count, 0)).toBeGreaterThan(0);
  expect(res.body.attention.some((a) => a.count > 0)).toBe(true);
});
