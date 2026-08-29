// Everything between the subtotal and the total: shipping, discount, other
// charges, payment terms (extraction.js, confidence.js, routes/invoices.js).
//
// The bug this closes is worth stating precisely, because the failure mode
// was the checker's, not the document's. crossCheckTotal computed
// `subtotal + tax` and compared it to the total. Any invoice carrying a
// shipping line therefore failed its own cross-check, got its confidence
// dragged down for it, and landed in the review queue with "the numbers
// don't add up" against a document that added up perfectly.
import request from "supertest";
import { app } from "../src/app.js";
import { score, adjustmentsTotal } from "../src/confidence.js";
import { extract, normalizeOtherCharges } from "../src/extraction.js";
import { Invoice, LineItem } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

function result(fields, lineItems = [{ amount: 100, confidence: 0.9 }]) {
  return {
    fields: { vendor_name: "Acme", invoice_number: "1", currency: "USD", ...fields },
    fieldConfidence: {},
    lineItems,
  };
}

describe("the cross-check", () => {
  // The regression itself.
  test("passes on an invoice whose total includes shipping", () => {
    const report = score(result({ subtotal: 100, shipping: 15, tax: 8, total: 123 }));
    expect(report.crossCheckPassed).toBe(true);
    expect(report.crossCheckDetail).toMatch(/matches total/);
  });

  test("passes on an invoice with a discount", () => {
    const report = score(result({ subtotal: 100, discount: 10, tax: 7.2, total: 97.2 }));
    expect(report.crossCheckPassed).toBe(true);
  });

  test("passes with shipping, a discount and other charges together", () => {
    const report = score(
      result({
        subtotal: 100,
        shipping: 15,
        discount: 10,
        other_charges: [
          { label: "Handling", amount: 5 },
          { label: "Deposit applied", amount: -20 },
        ],
        tax: 8,
        total: 98,
      })
    );
    expect(report.crossCheckPassed).toBe(true);
  });

  // The check still has to fail when it genuinely should -- a fix that
  // makes everything pass has removed the feature, not repaired it.
  test("still fails when the total genuinely doesn't reconcile", () => {
    const report = score(result({ subtotal: 100, shipping: 15, tax: 8, total: 999 }));
    expect(report.crossCheckPassed).toBe(false);
    expect(report.crossCheckDetail).toMatch(/adjustments/);
    expect(report.crossCheckDetail).toMatch(/999/);
  });

  test("an invoice with no adjustments behaves exactly as it did before", () => {
    const report = score(result({ subtotal: 100, tax: 8, total: 108 }));
    expect(report.crossCheckPassed).toBe(true);
    // The old wording, kept for the case it still describes.
    expect(report.crossCheckDetail).toMatch(/subtotal \+ tax matches total/);
  });

  test("a discount counts the same whichever sign it arrives with", () => {
    expect(adjustmentsTotal({ discount: 10 })).toBe(-10);
    expect(adjustmentsTotal({ discount: -10 })).toBe(-10);
  });
});

describe("other charges", () => {
  test("a row with no usable amount is dropped, not kept as zero", () => {
    // A zero would pass the cross-check while hiding that a line on the
    // page was never read.
    expect(normalizeOtherCharges([{ label: "Handling", amount: "nonsense" }])).toEqual([]);
    expect(normalizeOtherCharges([{ label: "Handling", amount: 5 }])).toEqual([{ label: "Handling", amount: 5 }]);
  });

  test("an unlabelled charge still counts, under a fallback label", () => {
    expect(normalizeOtherCharges([{ amount: 5 }])).toEqual([{ label: "Other charge", amount: 5 }]);
  });

  test("junk in place of a list is an empty list, not a crash", () => {
    expect(normalizeOtherCharges(null)).toEqual([]);
    expect(normalizeOtherCharges("nope")).toEqual([]);
  });
});

describe("the heuristic extractor (the no-LLM path)", () => {
  // There is no point fixing the cross-check only for the LLM path: an org
  // running without an API key would still see its own extractions fail.
  test("reads shipping, discount and terms off the page", async () => {
    const text = [
      "ACME SUPPLY CO",
      "Invoice #: INV-8891",
      "Date: 2026-03-04",
      "Widget          2   50.00   100.00",
      "Sub-Total: $100.00",
      "Shipping: $15.00",
      "Discount 10%: $10.00",
      "Sales Tax 6.00%: $6.30",
      "Terms: 2/10 n/30",
      "Total: $111.30",
    ].join("\n");

    const res = await extract(text);
    expect(res.method).toBe("heuristic");
    expect(res.fields.shipping).toBe(15);
    expect(res.fields.discount).toBe(10);
    expect(res.fields.payment_terms).toBe("2/10 n/30");
    // The percentage on the discount line must not be mistaken for the
    // amount, same trap the tax line already had.
    expect(res.fields.tax).toBe(6.3);
  });

  test("an amount it never found reaches the model as null, not an empty string", async () => {
    const res = await extract("VENDOR ONLY\nNothing else here.");
    for (const key of ["subtotal", "shipping", "discount", "tax", "total"]) {
      expect(res.fields[key]).toBeNull();
    }
    expect(res.fields.other_charges).toEqual([]);
  });
});

describe("the API", () => {
  // Rows are created directly rather than uploaded. An upload queues a real
  // OCR job that outlives the test file, and jest fails the whole run for
  // logging after teardown ("Cannot log after tests are done") even when
  // every assertion passed. Nothing here needs the pipeline: these tests
  // are about the fields and the arithmetic over them.

  test("accepts and returns the new fields, and derives the rates", async () => {
    const token = await signup(app, request);
    const { id } = await flaggedInvoice(token);

    const patched = await request(app)
      .patch(`/api/invoices/${id}`)
      .set(authHeader(token))
      .send({ subtotal: 200, shipping: 20, discount: 25, tax: 12, payment_terms: "2/10 n/30", total: 207 });
    expect(patched.status).toBe(200);
    expect(patched.body.shipping).toBe(20);
    expect(patched.body.discount).toBe(25);
    expect(patched.body.payment_terms).toBe("2/10 n/30");
    // Derived from the figures on the record, not stored alongside them.
    expect(patched.body.tax_rate_percent).toBe(6);
    expect(patched.body.discount_rate_percent).toBe(12.5);
  });

  test("a discount typed as a negative is stored as a magnitude", async () => {
    const token = await signup(app, request);
    const { id } = await flaggedInvoice(token);

    const patched = await request(app)
      .patch(`/api/invoices/${id}`)
      .set(authHeader(token))
      .send({ subtotal: 100, discount: -25, total: 75 });
    expect(patched.body.discount).toBe(25);
  });

  test("a rate is null rather than zero when there is no subtotal to divide by", async () => {
    const token = await signup(app, request);
    const { id } = await flaggedInvoice(token, { subtotal: null, tax: null, total: null });

    const patched = await request(app).patch(`/api/invoices/${id}`).set(authHeader(token)).send({ tax: 5, total: 5 });
    expect(patched.body.tax_rate_percent).toBeNull();
  });

  // Caught by tests/quickReview.test.js when the new fields were first added
  // to FIELD_TO_ATTR: the queue reads a missing confidence entry as zero, so
  // every invoice suddenly grew three extra review rows for charges that
  // were never on the document. Asking somebody to confirm a shipping
  // amount on an invoice with no shipping line is worse than not asking.
  async function flaggedInvoice(token, over = {}) {
    const me = await request(app).get("/api/auth/me").set(authHeader(token));
    const invoice = await Invoice.create({
      orgId: me.body.org_id,
      originalFilename: "test.pdf",
      storagePath: "/tmp/does-not-matter.pdf",
      contentType: "application/pdf",
      status: "needs_review",
      vendorName: "Acme Corp",
      invoiceNumber: "INV-1",
      invoiceDate: "2026-01-01",
      subtotal: 100,
      tax: 0,
      total: 100,
      overallConfidence: 0.5,
      crossCheckPassed: true,
      // Everything confident except what a test deliberately lowers, so the
      // queue's contents are exactly what the test set up.
      ...over,
      fieldConfidence: {
        vendor_name: 1, invoice_number: 1, invoice_date: 1, due_date: 1,
        po_reference: 1, currency: 1, subtotal: 1, tax: 1, total: 1,
        ...(over.fieldConfidence || {}),
      },
    });
    await LineItem.create({ invoiceId: invoice.id, position: 0, description: "Widget", amount: 100, confidence: 1 });
    return invoice;
  }

  test("quick review doesn't ask about charges the invoice doesn't have", async () => {
    const token = await signup(app, request);
    const inv = await flaggedInvoice(token);

    const queue = await request(app).get("/api/invoices/quick-review-queue").set(authHeader(token));
    expect(queue.status).toBe(200);
    // The invoice is genuinely in the queue -- otherwise this would pass by
    // asserting nothing.
    expect(queue.body.some((i) => i.invoice_id === inv.id)).toBe(false);

    const withLowVendor = await flaggedInvoice(token, { fieldConfidence: { vendor_name: 0.2 } });
    const q2 = await request(app).get("/api/invoices/quick-review-queue").set(authHeader(token));
    const fields = q2.body.filter((i) => i.invoice_id === withLowVendor.id).map((i) => i.field);
    expect(fields).toContain("vendor_name");
    expect(fields).not.toContain("shipping");
    expect(fields).not.toContain("discount");
    expect(fields).not.toContain("payment_terms");
  });

  test("but does ask about a charge it found and isn't sure of", async () => {
    const token = await signup(app, request);
    const inv = await flaggedInvoice(token, { shipping: 15, total: 115, fieldConfidence: { shipping: 0.2 } });

    const queue = await request(app).get("/api/invoices/quick-review-queue").set(authHeader(token));
    const row = queue.body.find((i) => i.invoice_id === inv.id && i.field === "shipping");
    expect(row).toBeTruthy();
    expect(row.value).toBe(15);
  });

  test("reports payment status, so nobody pays a bill twice", async () => {
    const token = await signup(app, request);
    const { id } = await flaggedInvoice(token);
    const detail = await request(app).get(`/api/invoices/${id}`).set(authHeader(token));
    expect(detail.status).toBe(200);
    expect(detail.body.payment_status).toBe("unpaid");
    expect(detail.body.amount_paid).toBe(0);
    expect(detail.body.payment_count).toBe(0);
  });
});
