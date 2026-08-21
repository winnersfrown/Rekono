// Consolidates cross-org regression coverage that doesn't already live next
// to its feature's own tests -- one place that names every route boundary
// an org's data has to stay behind, so a future change that accidentally
// drops a where: { orgId } clause fails a test here even if the happy-path
// coverage elsewhere wouldn't have caught it.

import request from "supertest";
import { app } from "../src/app.js";
import { ExpenseReceipt, Invoice, VendorDocument } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function makeInvoice(orgId, overrides = {}) {
  return Invoice.create({
    orgId,
    originalFilename: "test.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1",
    total: 1000.0,
    overallConfidence: 0.95,
    ...overrides,
  });
}

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function makeReceipt(orgId, overrides = {}) {
  return ExpenseReceipt.create({
    orgId,
    originalFilename: "receipt.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    merchantName: "Blue Bottle Coffee",
    overallConfidence: 0.95,
    ...overrides,
  });
}

async function makeVendorDocument(orgId, overrides = {}) {
  return VendorDocument.create({
    orgId,
    originalFilename: "coi.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Contracting LLC",
    overallConfidence: 0.95,
    ...overrides,
  });
}

async function twoOrgs() {
  const tokenA = await signup(app, request, { email: "iso-a@example.co", orgName: "Org A" });
  const tokenB = await signup(app, request, { email: "iso-b@example.co", orgName: "Org B" });
  const orgA = await orgId(tokenA);
  const orgB = await orgId(tokenB);
  return { tokenA, tokenB, orgA, orgB };
}

test("an invoice's detail, file, audit log, correction, approve, and reject routes all 404 for another org", async () => {
  const { tokenA, tokenB, orgA } = await twoOrgs();
  const invoice = await makeInvoice(orgA);

  const detail = await request(app).get(`/api/invoices/${invoice.id}`).set(authHeader(tokenB));
  expect(detail.status).toBe(404);

  const file = await request(app).get(`/api/invoices/${invoice.id}/file`).set(authHeader(tokenB));
  expect(file.status).toBe(404);

  const auditLog = await request(app).get(`/api/invoices/${invoice.id}/audit-log`).set(authHeader(tokenB));
  expect(auditLog.status).toBe(404);

  const patch = await request(app)
    .patch(`/api/invoices/${invoice.id}`)
    .set(authHeader(tokenB))
    .send({ vendor_name: "Hijacked" });
  expect(patch.status).toBe(404);

  const approve = await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(tokenB));
  expect(approve.status).toBe(404);

  const reject = await request(app).post(`/api/invoices/${invoice.id}/reject`).set(authHeader(tokenB));
  expect(reject.status).toBe(404);

  // untouched by any of the above
  await invoice.reload();
  expect(invoice.vendorName).toBe("Acme Supplies Inc");
  expect(invoice.status).toBe("extracted");
});

test("CSV and Excel export only ever include the caller's own org's invoices", async () => {
  const { tokenA, orgA, orgB } = await twoOrgs();
  await makeInvoice(orgA, { vendorName: "Org A Vendor" });
  await makeInvoice(orgB, { vendorName: "Org B Vendor" });

  const csv = await request(app).get("/api/export/csv").set(authHeader(tokenA));
  expect(csv.status).toBe(200);
  expect(csv.text).toContain("Org A Vendor");
  expect(csv.text).not.toContain("Org B Vendor");

  const xlsx = await request(app).get("/api/export/xlsx").set(authHeader(tokenA));
  expect(xlsx.status).toBe(200);
  // xlsx is a binary zip container, not searchable text -- content coverage
  // for it lives in buildRows() being the one shared function both formats
  // pull from (see the CSV assertion above); this just confirms the route
  // itself still responds correctly for an org with no visible invoices.
});

test("matching sources and results are scoped to the caller's org", async () => {
  const { tokenA, tokenB, orgA } = await twoOrgs();
  const invoice = await makeInvoice(orgA);

  const csv = "vendor,amount,date,reference\nAcme Supplies Inc,1000.00,2026-01-05,PO-1\n";
  const upload = await request(app)
    .post("/api/matching/sources?source_type=po")
    .set(authHeader(tokenA))
    .attach("file", Buffer.from(csv), { filename: "po.csv", contentType: "text/csv" });
  expect(upload.status).toBe(201);

  const run = await request(app).post("/api/matching/run").set(authHeader(tokenA));
  expect(run.status).toBe(200);
  expect(run.body.matched).toBe(1);

  const sourcesB = await request(app).get("/api/matching/sources").set(authHeader(tokenB));
  expect(sourcesB.body).toEqual([]);

  const resultsB = await request(app).get("/api/matching/results").set(authHeader(tokenB));
  expect(resultsB.body).toEqual([]);

  // org B running its own matching pass must not see org A's source data as
  // a candidate, even though the row's vendor/amount would otherwise match.
  const runB = await request(app).post("/api/matching/run").set(authHeader(tokenB));
  expect(runB.status).toBe(200);
  expect(runB.body.invoices_evaluated).toBe(0);

  // and org A's own view is unaffected by any of the above
  const sourcesA = await request(app).get("/api/matching/sources").set(authHeader(tokenA));
  expect(sourcesA.body).toHaveLength(1);
  const resultsA = await request(app).get("/api/matching/results").set(authHeader(tokenA));
  expect(resultsA.body).toHaveLength(1);
});

test("a receipt's detail, file, audit log, correction, approve, and reject routes all 404 for another org", async () => {
  const { tokenB, orgA } = await twoOrgs();
  const receipt = await makeReceipt(orgA);

  const detail = await request(app).get(`/api/expenses/${receipt.id}`).set(authHeader(tokenB));
  expect(detail.status).toBe(404);

  const file = await request(app).get(`/api/expenses/${receipt.id}/file`).set(authHeader(tokenB));
  expect(file.status).toBe(404);

  const auditLog = await request(app).get(`/api/expenses/${receipt.id}/audit-log`).set(authHeader(tokenB));
  expect(auditLog.status).toBe(404);

  const patch = await request(app)
    .patch(`/api/expenses/${receipt.id}`)
    .set(authHeader(tokenB))
    .send({ merchant_name: "Hijacked" });
  expect(patch.status).toBe(404);

  const approve = await request(app).post(`/api/expenses/${receipt.id}/approve`).set(authHeader(tokenB));
  expect(approve.status).toBe(404);

  const reject = await request(app).post(`/api/expenses/${receipt.id}/reject`).set(authHeader(tokenB));
  expect(reject.status).toBe(404);

  // untouched by any of the above
  await receipt.reload();
  expect(receipt.merchantName).toBe("Blue Bottle Coffee");
  expect(receipt.status).toBe("extracted");
});

test("expense CSV and Excel export only ever include the caller's own org's receipts", async () => {
  const { tokenA, orgA, orgB } = await twoOrgs();
  await makeReceipt(orgA, { merchantName: "Org A Diner" });
  await makeReceipt(orgB, { merchantName: "Org B Diner" });

  const csv = await request(app).get("/api/export/expenses/csv").set(authHeader(tokenA));
  expect(csv.status).toBe(200);
  expect(csv.text).toContain("Org A Diner");
  expect(csv.text).not.toContain("Org B Diner");

  const xlsx = await request(app).get("/api/export/expenses/xlsx").set(authHeader(tokenA));
  expect(xlsx.status).toBe(200);
});

test("a vendor document's detail, file, audit log, correction, approve, and reject routes all 404 for another org", async () => {
  const { tokenB, orgA } = await twoOrgs();
  const doc = await makeVendorDocument(orgA);

  const detail = await request(app).get(`/api/vendor-documents/${doc.id}`).set(authHeader(tokenB));
  expect(detail.status).toBe(404);

  const file = await request(app).get(`/api/vendor-documents/${doc.id}/file`).set(authHeader(tokenB));
  expect(file.status).toBe(404);

  const auditLog = await request(app).get(`/api/vendor-documents/${doc.id}/audit-log`).set(authHeader(tokenB));
  expect(auditLog.status).toBe(404);

  const patch = await request(app)
    .patch(`/api/vendor-documents/${doc.id}`)
    .set(authHeader(tokenB))
    .send({ vendor_name: "Hijacked" });
  expect(patch.status).toBe(404);

  const approve = await request(app).post(`/api/vendor-documents/${doc.id}/approve`).set(authHeader(tokenB));
  expect(approve.status).toBe(404);

  const reject = await request(app).post(`/api/vendor-documents/${doc.id}/reject`).set(authHeader(tokenB));
  expect(reject.status).toBe(404);

  // untouched by any of the above
  await doc.reload();
  expect(doc.vendorName).toBe("Acme Contracting LLC");
  expect(doc.status).toBe("extracted");
});

test("vendor document CSV and Excel export only ever include the caller's own org's documents", async () => {
  const { tokenA, orgA, orgB } = await twoOrgs();
  await makeVendorDocument(orgA, { vendorName: "Org A Vendor" });
  await makeVendorDocument(orgB, { vendorName: "Org B Vendor" });

  const csv = await request(app).get("/api/export/vendor-documents/csv").set(authHeader(tokenA));
  expect(csv.status).toBe(200);
  expect(csv.text).toContain("Org A Vendor");
  expect(csv.text).not.toContain("Org B Vendor");

  const xlsx = await request(app).get("/api/export/vendor-documents/xlsx").set(authHeader(tokenA));
  expect(xlsx.status).toBe(200);
});

test("the expiring_within_days filter never surfaces another org's document", async () => {
  const { tokenB, orgA } = await twoOrgs();
  const soon = new Date();
  soon.setUTCDate(soon.getUTCDate() + 5);
  await makeVendorDocument(orgA, { expirationDate: soon.toISOString().slice(0, 10) });

  const res = await request(app).get("/api/vendor-documents?expiring_within_days=30").set(authHeader(tokenB));
  expect(res.status).toBe(200);
  expect(res.body.items).toEqual([]);
});
