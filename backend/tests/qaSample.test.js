import request from "supertest";
import { app } from "../src/app.js";
import { Invoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function makeSampledInvoice(orgId, overrides = {}) {
  return Invoice.create({
    orgId,
    originalFilename: "test.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "approved",
    vendorName: "Acme Corp",
    total: 42,
    overallConfidence: 0.9,
    sampledForQa: true,
    ...overrides,
  });
}

describe("GET /api/invoices/qa-sample-queue", () => {
  test("requires authentication", async () => {
    const res = await request(app).get("/api/invoices/qa-sample-queue");
    expect(res.status).toBe(401);
  });

  test("lists sampled invoices awaiting a spot-check", async () => {
    const token = await signup(app, request);
    const inv = await makeSampledInvoice(await orgId(token));
    const res = await request(app).get("/api/invoices/qa-sample-queue").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ invoice_id: inv.id, vendor_name: "Acme Corp", total: 42 });
  });

  test("excludes invoices not sampled for QA", async () => {
    const token = await signup(app, request);
    await makeSampledInvoice(await orgId(token), { sampledForQa: false });
    const res = await request(app).get("/api/invoices/qa-sample-queue").set(authHeader(token));
    expect(res.body).toEqual([]);
  });

  test("excludes sampled invoices already reviewed", async () => {
    const token = await signup(app, request);
    await makeSampledInvoice(await orgId(token), { qaReviewedAt: new Date(), qaOutcome: "confirmed" });
    const res = await request(app).get("/api/invoices/qa-sample-queue").set(authHeader(token));
    expect(res.body).toEqual([]);
  });

  test("never crosses organizations", async () => {
    const tokenA = await signup(app, request, { email: "a@qa.co", orgName: "Org A" });
    await makeSampledInvoice(await orgId(tokenA));
    const tokenB = await signup(app, request, { email: "b@qa.co", orgName: "Org B" });
    const res = await request(app).get("/api/invoices/qa-sample-queue").set(authHeader(tokenB));
    expect(res.body).toEqual([]);
  });
});

describe("POST /api/invoices/:id/qa-review", () => {
  test("requires authentication", async () => {
    const res = await request(app).post("/api/invoices/fake-id/qa-review").send({ outcome: "confirmed" });
    expect(res.status).toBe(401);
  });

  test("validates the outcome", async () => {
    const token = await signup(app, request);
    const inv = await makeSampledInvoice(await orgId(token));
    const res = await request(app)
      .post(`/api/invoices/${inv.id}/qa-review`)
      .set(authHeader(token))
      .send({ outcome: "not_a_real_outcome" });
    expect(res.status).toBe(422);
  });

  test("404s for an invoice that wasn't sampled", async () => {
    const token = await signup(app, request);
    const inv = await makeSampledInvoice(await orgId(token), { sampledForQa: false });
    const res = await request(app)
      .post(`/api/invoices/${inv.id}/qa-review`)
      .set(authHeader(token))
      .send({ outcome: "confirmed" });
    expect(res.status).toBe(404);
  });

  test("records the outcome and removes the invoice from the pending queue", async () => {
    const token = await signup(app, request);
    const inv = await makeSampledInvoice(await orgId(token));

    const res = await request(app)
      .post(`/api/invoices/${inv.id}/qa-review`)
      .set(authHeader(token))
      .send({ outcome: "issue_flagged", note: "vendor name looked truncated" });
    expect(res.status).toBe(200);
    expect(res.body.qa_outcome).toBe("issue_flagged");

    await inv.reload();
    expect(inv.qaOutcome).toBe("issue_flagged");
    expect(inv.qaReviewedAt).not.toBeNull();
    expect(inv.status).toBe("approved"); // never touched -- this is a QA record, not an approval action

    const queueRes = await request(app).get("/api/invoices/qa-sample-queue").set(authHeader(token));
    expect(queueRes.body).toEqual([]);
  });

  test("rejects reviewing the same invoice twice", async () => {
    const token = await signup(app, request);
    const inv = await makeSampledInvoice(await orgId(token));
    await request(app).post(`/api/invoices/${inv.id}/qa-review`).set(authHeader(token)).send({ outcome: "confirmed" });

    const res = await request(app)
      .post(`/api/invoices/${inv.id}/qa-review`)
      .set(authHeader(token))
      .send({ outcome: "confirmed" });
    expect(res.status).toBe(409);
  });

  test("an invoice belonging to another org can't be reviewed", async () => {
    const tokenA = await signup(app, request, { email: "a2@qa.co", orgName: "Org A2" });
    const inv = await makeSampledInvoice(await orgId(tokenA));

    const tokenB = await signup(app, request, { email: "b2@qa.co", orgName: "Org B2" });
    const res = await request(app)
      .post(`/api/invoices/${inv.id}/qa-review`)
      .set(authHeader(tokenB))
      .send({ outcome: "confirmed" });
    expect(res.status).toBe(404);
  });
});
