// GET /api/dashboard/trends -- weekly touchless-rate/confidence trend,
// top-vendor spend, and month-over-month comparison. Separate from
// dashboard.test.js (the main /api/dashboard landing-page endpoint) since
// this is a distinct, heavier request only the trends view actually needs.
import request from "supertest";
import { app } from "../src/app.js";
import { AuditLog, Invoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function makeInvoice(org, overrides = {}) {
  const now = new Date();
  return Invoice.create(
    {
      orgId: org,
      originalFilename: "invoice.pdf",
      storagePath: "/tmp/does-not-matter.pdf",
      contentType: "application/pdf",
      status: "approved",
      vendorName: "Acme Co",
      overallConfidence: 0.9,
      // Explicit defaults (rather than leaving Sequelize's own
      // auto-timestamping to fill these in) since `{ silent: true }`
      // below -- needed so the month-over-month tests can set updatedAt
      // to "last month" without Sequelize force-touching it back to
      // "now" -- also suppresses the *default* timestamp entirely if
      // it's left out, not just the override.
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    { silent: true }
  );
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

test("requires authentication", async () => {
  const res = await request(app).get("/api/dashboard/trends");
  expect(res.status).toBe(401);
});

test("a brand-new org gets 13 weeks of honest zeroes/nulls, not an empty array", async () => {
  const token = await signup(app, request);
  const res = await request(app).get("/api/dashboard/trends").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.weekly).toHaveLength(13);
  for (const week of res.body.weekly) {
    expect(week.approved_count).toBe(0);
    expect(week.touchless_rate).toBeNull();
    expect(week.avg_confidence).toBeNull();
  }
  expect(res.body.vendor_spend).toEqual([]);
});

test("weekly buckets invoices and approvals into a single matching week", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  // Which exact bucket 10 days ago falls into depends on where "today"
  // lands inside its own 7-day bucket, so find it rather than assume an
  // index -- what matters is that it lands in exactly one week, correctly.
  const when = daysAgo(10);
  const inv = await makeInvoice(org, { status: "extracted", overallConfidence: 0.8, createdAt: when });
  await AuditLog.create({ orgId: org, invoiceId: inv.id, action: "approved", actor: "owner@example.co", createdAt: when });

  const res = await request(app).get("/api/dashboard/trends").set(authHeader(token));
  const weeksWithData = res.body.weekly.filter((w) => w.approved_count > 0);
  expect(weeksWithData).toHaveLength(1);
  expect(weeksWithData[0].approved_count).toBe(1);
  expect(weeksWithData[0].touchless_rate).toBe(0); // approved, not auto_approved
  expect(weeksWithData[0].avg_confidence).toBeCloseTo(0.8);

  const total = res.body.weekly.reduce((sum, w) => sum + w.approved_count, 0);
  expect(total).toBe(1);
});

test("auto_approved counts toward touchless_rate, approved alone does not", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const when = daysAgo(1);
  await AuditLog.create({ orgId: org, action: "approved", actor: "owner@example.co", createdAt: when });
  await AuditLog.create({ orgId: org, action: "auto_approved", actor: "system", createdAt: when });

  const res = await request(app).get("/api/dashboard/trends").set(authHeader(token));
  const weeksWithData = res.body.weekly.filter((w) => w.approved_count > 0);
  expect(weeksWithData).toHaveLength(1);
  expect(weeksWithData[0].approved_count).toBe(2);
  expect(weeksWithData[0].touchless_rate).toBeCloseTo(0.5);
});

test("data older than 90 days doesn't appear in any week", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeInvoice(org, { status: "extracted", createdAt: daysAgo(120) });

  const res = await request(app).get("/api/dashboard/trends").set(authHeader(token));
  const total = res.body.weekly.reduce((sum, w) => sum + (w.avg_confidence !== null ? 1 : 0), 0);
  expect(total).toBe(0);
});

describe("vendor_spend", () => {
  test("sums total per vendor and sorts by spend descending", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org, { vendorName: "Acme Corp", total: 100 });
    await makeInvoice(org, { vendorName: "Acme Corp", total: 150 });
    await makeInvoice(org, { vendorName: "Big Vendor Inc", total: 500 });

    const res = await request(app).get("/api/dashboard/trends").set(authHeader(token));
    expect(res.body.vendor_spend).toEqual([
      { vendor_name: "Big Vendor Inc", total: 500, invoice_count: 1 },
      { vendor_name: "Acme Corp", total: 250, invoice_count: 2 },
    ]);
  });

  test("only approved invoices count", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org, { status: "needs_review", vendorName: "Not Yet Approved", total: 9999 });

    const res = await request(app).get("/api/dashboard/trends").set(authHeader(token));
    expect(res.body.vendor_spend).toEqual([]);
  });

  test("an empty vendor name is grouped as unknown rather than dropped", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org, { vendorName: "", total: 42 });

    const res = await request(app).get("/api/dashboard/trends").set(authHeader(token));
    expect(res.body.vendor_spend).toEqual([{ vendor_name: "(unknown vendor)", total: 42, invoice_count: 1 }]);
  });
});

describe("month_over_month", () => {
  test("compares this month's approved value/doc count/touchless rate to the same day-range last month", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);

    const now = new Date();
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12));
    const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 12));

    await makeInvoice(org, { total: 1000, updatedAt: currentMonthStart, createdAt: currentMonthStart });
    await makeInvoice(org, { total: 400, updatedAt: prevMonthStart, createdAt: prevMonthStart });

    const res = await request(app).get("/api/dashboard/trends").set(authHeader(token));
    const mom = res.body.month_over_month;
    expect(mom.approved_value.current).toBe(1000);
    expect(mom.approved_value.previous).toBe(400);
    expect(mom.approved_value.pct_change).toBeCloseTo(150); // (1000-400)/400 * 100

    expect(mom.documents_processed.current).toBeGreaterThanOrEqual(1);
    expect(mom.documents_processed.previous).toBeGreaterThanOrEqual(1);
  });

  test("pct_change is null (not Infinity/NaN) when the previous period had nothing", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const now = new Date();
    await makeInvoice(org, { total: 500, updatedAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12)) });

    const res = await request(app).get("/api/dashboard/trends").set(authHeader(token));
    expect(res.body.month_over_month.approved_value.previous).toBe(0);
    expect(res.body.month_over_month.approved_value.pct_change).toBeNull();
  });
});
