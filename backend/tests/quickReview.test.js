import request from "supertest";
import { app } from "../src/app.js";
import { Invoice, LineItem } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

const FULL_CONFIDENCE = {
  vendor_name: 1,
  invoice_number: 1,
  invoice_date: 1,
  due_date: 1,
  po_reference: 1,
  currency: 1,
  subtotal: 1,
  tax: 1,
  total: 1,
};

// A needs_review invoice with everything confidently extracted except
// whatever fieldConfidence overrides say otherwise, and a line item that
// makes its cross-check pass cleanly -- so the only thing keeping it
// flagged (until quick-reviewed) is the specific low-confidence field(s)
// under test, not an unrelated cross-check failure.
async function makeFlaggedInvoice(orgId, overrides = {}) {
  const { fieldConfidence, ...rest } = overrides;
  const invoice = await Invoice.create({
    orgId,
    originalFilename: "test.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "needs_review",
    vendorName: "Acme Corp",
    invoiceNumber: "INV-1",
    invoiceDate: "2026-01-01",
    total: 100,
    subtotal: 100,
    tax: 0,
    overallConfidence: 0.5,
    crossCheckPassed: true,
    fieldConfidence: { ...FULL_CONFIDENCE, ...fieldConfidence },
    ...rest,
  });
  await LineItem.create({ invoiceId: invoice.id, position: 0, description: "Widget", amount: 100, confidence: 1 });
  return invoice;
}

describe("GET /api/invoices/quick-review-queue", () => {
  test("requires authentication", async () => {
    const res = await request(app).get("/api/invoices/quick-review-queue");
    expect(res.status).toBe(401);
  });

  test("lists only the low-confidence fields, not confidently-extracted ones", async () => {
    const token = await signup(app, request);
    const inv = await makeFlaggedInvoice(await orgId(token), { fieldConfidence: { vendor_name: 0.5 } });
    const res = await request(app).get("/api/invoices/quick-review-queue").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ invoice_id: inv.id, field: "vendor_name", value: "Acme Corp" });
  });

  test("lists every low-confidence field on the same invoice", async () => {
    const token = await signup(app, request);
    await makeFlaggedInvoice(await orgId(token), { fieldConfidence: { vendor_name: 0.5, total: 0.5 } });
    const res = await request(app).get("/api/invoices/quick-review-queue").set(authHeader(token));
    expect(res.body.map((i) => i.field).sort()).toEqual(["total", "vendor_name"]);
  });

  test("excludes invoices flagged for a duplicate or possible multi-invoice", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeFlaggedInvoice(org, { fieldConfidence: { vendor_name: 0.5 }, duplicateOfInvoiceId: "some-other-id" });
    await makeFlaggedInvoice(org, { fieldConfidence: { vendor_name: 0.5 }, possibleMultiInvoice: true });
    const res = await request(app).get("/api/invoices/quick-review-queue").set(authHeader(token));
    expect(res.body).toEqual([]);
  });

  test("excludes invoices that aren't needs_review", async () => {
    const token = await signup(app, request);
    await makeFlaggedInvoice(await orgId(token), { fieldConfidence: { vendor_name: 0.5 }, status: "extracted" });
    const res = await request(app).get("/api/invoices/quick-review-queue").set(authHeader(token));
    expect(res.body).toEqual([]);
  });

  test("never crosses organizations", async () => {
    const tokenA = await signup(app, request, { email: "a@qr.co", orgName: "Org A" });
    await makeFlaggedInvoice(await orgId(tokenA), { fieldConfidence: { vendor_name: 0.5 } });
    const tokenB = await signup(app, request, { email: "b@qr.co", orgName: "Org B" });
    const res = await request(app).get("/api/invoices/quick-review-queue").set(authHeader(tokenB));
    expect(res.body).toEqual([]);
  });
});

describe("POST /api/invoices/:id/quick-review-field", () => {
  test("requires authentication", async () => {
    const res = await request(app)
      .post("/api/invoices/fake-id/quick-review-field")
      .send({ field: "vendor_name", value: "x" });
    expect(res.status).toBe(401);
  });

  test("404s for an invoice that doesn't exist", async () => {
    const token = await signup(app, request);
    const res = await request(app)
      .post("/api/invoices/does-not-exist/quick-review-field")
      .set(authHeader(token))
      .send({ field: "vendor_name", value: "Acme Corp" });
    expect(res.status).toBe(404);
  });

  test("validates the field name", async () => {
    const token = await signup(app, request);
    const inv = await makeFlaggedInvoice(await orgId(token), { fieldConfidence: { vendor_name: 0.5 } });
    const res = await request(app)
      .post(`/api/invoices/${inv.id}/quick-review-field`)
      .set(authHeader(token))
      .send({ field: "not_a_real_field", value: "x" });
    expect(res.status).toBe(422);
  });

  test("rejects an invoice that isn't needs_review", async () => {
    const token = await signup(app, request);
    const inv = await makeFlaggedInvoice(await orgId(token), { fieldConfidence: { vendor_name: 0.5 }, status: "extracted" });
    const res = await request(app)
      .post(`/api/invoices/${inv.id}/quick-review-field`)
      .set(authHeader(token))
      .send({ field: "vendor_name", value: "Acme Corp" });
    expect(res.status).toBe(409);
  });

  test("rejects an invoice that needs a full review (duplicate)", async () => {
    const token = await signup(app, request);
    const inv = await makeFlaggedInvoice(await orgId(token), {
      fieldConfidence: { vendor_name: 0.5 },
      duplicateOfInvoiceId: "other",
    });
    const res = await request(app)
      .post(`/api/invoices/${inv.id}/quick-review-field`)
      .set(authHeader(token))
      .send({ field: "vendor_name", value: "Acme Corp" });
    expect(res.status).toBe(409);
  });

  test("confirming the last flagged field (unchanged) auto-approves the invoice", async () => {
    const token = await signup(app, request);
    const inv = await makeFlaggedInvoice(await orgId(token), { fieldConfidence: { vendor_name: 0.5 } });
    const res = await request(app)
      .post(`/api/invoices/${inv.id}/quick-review-field`)
      .set(authHeader(token))
      .send({ field: "vendor_name", value: "Acme Corp" }); // same value -- a confirm, not a correction
    expect(res.status).toBe(200);
    expect(res.body.invoice_status).toBe("approved");
    expect(res.body.still_flagged).toBe(false);

    await inv.reload();
    expect(inv.status).toBe("approved");
    expect(inv.fieldConfidence.vendor_name).toBe(1);
  });

  test("correcting a field updates the value and is remembered for the vendor", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const inv = await makeFlaggedInvoice(org, { fieldConfidence: { vendor_name: 0.5 } });

    const res = await request(app)
      .post(`/api/invoices/${inv.id}/quick-review-field`)
      .set(authHeader(token))
      .send({ field: "vendor_name", value: "Acme Corp LLC" });
    expect(res.status).toBe(200);
    await inv.reload();
    expect(inv.vendorName).toBe("Acme Corp LLC");

    // The correction gets remembered as a vendor alias, same as the full
    // PATCH route -- a second invoice with the original raw vendor text
    // should now suggest-account/auto-apply it. Verified indirectly here by
    // checking a fresh quick-review item for the same raw text reflects the
    // learned name once re-extracted would apply it; direct alias-table
    // coverage lives in vendorAlias.test.js.
    const { lookupVendorAlias } = await import("../src/vendorAlias.js");
    const alias = await lookupVendorAlias(org, "Acme Corp");
    expect(alias.canonicalVendorName).toBe("Acme Corp LLC");
  });

  test("does not remember a vendor correction when the value is confirmed unchanged", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const inv = await makeFlaggedInvoice(org, { fieldConfidence: { vendor_name: 0.5 } });

    await request(app)
      .post(`/api/invoices/${inv.id}/quick-review-field`)
      .set(authHeader(token))
      .send({ field: "vendor_name", value: "Acme Corp" });

    const { lookupVendorAlias } = await import("../src/vendorAlias.js");
    expect(await lookupVendorAlias(org, "Acme Corp")).toBeNull();
  });

  test("leaves an invoice needs_review when another flagged field remains", async () => {
    const token = await signup(app, request);
    // total carries the heaviest weight in the confidence formula
    // (confidence.js's CORE_FIELDS_WEIGHT) -- leaving it low after
    // confirming only vendor_name reliably keeps the weighted-average
    // overall confidence under the review threshold.
    const inv = await makeFlaggedInvoice(await orgId(token), {
      fieldConfidence: { vendor_name: 0.5, total: 0 },
    });
    const res = await request(app)
      .post(`/api/invoices/${inv.id}/quick-review-field`)
      .set(authHeader(token))
      .send({ field: "vendor_name", value: "Acme Corp" });
    expect(res.status).toBe(200);
    expect(res.body.still_flagged).toBe(true);

    await inv.reload();
    expect(inv.status).toBe("needs_review");
  });

  test("rejects a non-numeric value for a numeric field", async () => {
    const token = await signup(app, request);
    const inv = await makeFlaggedInvoice(await orgId(token), { fieldConfidence: { subtotal: 0.5 } });
    const res = await request(app)
      .post(`/api/invoices/${inv.id}/quick-review-field`)
      .set(authHeader(token))
      .send({ field: "subtotal", value: "not a number" });
    expect(res.status).toBe(422);
  });

  test("an invoice belonging to another org can't be quick-reviewed", async () => {
    const tokenA = await signup(app, request, { email: "a2@qr.co", orgName: "Org A2" });
    const inv = await makeFlaggedInvoice(await orgId(tokenA), { fieldConfidence: { vendor_name: 0.5 } });

    const tokenB = await signup(app, request, { email: "b2@qr.co", orgName: "Org B2" });
    const res = await request(app)
      .post(`/api/invoices/${inv.id}/quick-review-field`)
      .set(authHeader(tokenB))
      .send({ field: "vendor_name", value: "Acme Corp" });
    expect(res.status).toBe(404);
  });
});
