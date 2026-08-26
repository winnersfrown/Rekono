import request from "supertest";
import { app } from "../src/app.js";
import { Invoice } from "../src/models/index.js";
import { seedSampleInvoiceForNewOrg } from "../src/sampleSeed.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

// signup() (testUtils.js) strips the sample invoice back out after
// onboarding so the ~30 other test files that use it for "a normal working
// account" aren't tripped up by an extra row -- these tests drive
// /api/onboarding directly instead, the same way onboarding.test.js does,
// so the sample survives to be asserted on.

beforeEach(resetDb);

const personalization = {
  role: "finance_accounting",
  company_size: "just_me",
  primary_use_case: "data_entry",
  monthly_invoice_volume: "under_25",
};

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function signupNoCleanup(email) {
  const signupRes = await request(app)
    .post("/api/auth/signup")
    .send({ org_name: "Sample Test Co", full_name: "Test Owner", email, password: "correcthorse123" });
  const token = signupRes.body.access_token;
  await request(app).post("/api/onboarding").set(authHeader(token)).send({ ...personalization, plan: "free" });
  return token;
}

test("completing onboarding seeds exactly one sample invoice, flagged as such", async () => {
  const token = await signupNoCleanup("sample1@sampleco.co");
  const res = await request(app).get("/api/invoices").set(authHeader(token));
  expect(res.body.total).toBe(1);
  expect(res.body.items[0].is_sample_data).toBe(true);
  expect(res.body.items[0].vendor_name).toBe("Sample Vendor Co.");

  const detail = await request(app).get(`/api/invoices/${res.body.items[0].id}`).set(authHeader(token));
  expect(detail.body.is_sample_data).toBe(true);
});

test("seeding is idempotent -- calling it again doesn't add a second sample", async () => {
  const token = await signupNoCleanup("sample2@sampleco.co");
  const id = await orgId(token);
  const { Organization } = await import("../src/models/index.js");
  const org = await Organization.findByPk(id);

  await seedSampleInvoiceForNewOrg(org);
  await seedSampleInvoiceForNewOrg(org);

  const count = await Invoice.scope("withSamples").count({ where: { orgId: id } });
  expect(count).toBe(1);
});

test("a sample invoice never counts toward the document usage quota", async () => {
  const token = await signupNoCleanup("sample3@sampleco.co");
  const me = await request(app).get("/api/auth/me").set(authHeader(token));
  expect(me.body.documents_used_this_month).toBe(0);
});

test("a sample invoice is excluded from dashboard KPIs, real invoices still count", async () => {
  const token = await signupNoCleanup("sample4@sampleco.co");
  const id = await orgId(token);

  // The seeded sample is needs_review; add a real approved invoice and a
  // real needs_review invoice so every KPI below has something genuine to
  // report, and would visibly be wrong if the sample leaked in.
  await Invoice.create({
    orgId: id,
    originalFilename: "real-approved.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "approved",
    vendorName: "Real Vendor Inc",
    total: 100,
    overallConfidence: 0.95,
  });
  await Invoice.create({
    orgId: id,
    originalFilename: "real-needs-review.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "needs_review",
    vendorName: "Another Real Vendor",
    total: 50,
    overallConfidence: 0.4,
  });

  const res = await request(app).get("/api/dashboard").set(authHeader(token));
  expect(res.body.kpis.outstanding_ap).toBe(100);
  expect(res.body.kpis.outstanding_ap_count).toBe(1);
  expect(res.body.kpis.review_queue).toBe(1); // just the real needs_review invoice, not the sample
  expect(res.body.kpis.documents_used_this_month).toBe(2); // just the two real invoices
});

test("a sample invoice is excluded from the CSV export", async () => {
  const token = await signupNoCleanup("sample5@sampleco.co");
  const id = await orgId(token);
  await Invoice.create({
    orgId: id,
    originalFilename: "real.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "approved",
    vendorName: "Exportable Vendor",
    total: 250,
    overallConfidence: 0.9,
  });

  const res = await request(app).get("/api/export/csv").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.text).toContain("Exportable Vendor");
  expect(res.text).not.toContain("Sample Vendor Co.");
});
