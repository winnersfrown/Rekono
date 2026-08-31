// The correction route's *rejection* contract.
//
// Its own file rather than another test in api.test.js: that file already
// runs close to the signup rate limit's 30-per-15-minutes ceiling (the
// limiter is per module registry, so each test file gets its own budget),
// and one more signup in there pushes the whole suite into 429s.
//
// Worth pinning separately anyway, because the review UI renders whatever
// this route returns straight into the form. The *shape* of a rejection is
// part of the contract, not just its status code: `detail` arriving as an
// array of zod issues rather than a string is what made the old
// `body.detail || "..."` render "[object Object]", and handing that body to
// renderDetail is what redrew the form blank -- which is what "the fields
// refuse to accept the invoice number and PO reference" actually was.
import request from "supertest";
import { app } from "../src/app.js";
import { Invoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

test("a rejected correction answers 422 with per-field detail and saves nothing", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1",
    poReference: "PO-1",
    total: 1000.0,
    overallConfidence: 0.95,
  });

  const res = await request(app)
    .patch(`/api/invoices/${invoice.id}`)
    .set(authHeader(token))
    .send({
      invoice_number: "INV-2026-0007",
      po_reference: "PO-4421",
      payment_terms: "x".repeat(65), // paymentTerms is STRING(64)
    });

  expect(res.status).toBe(422);
  expect(Array.isArray(res.body.detail)).toBe(true);
  expect(res.body.detail[0].path).toContain("payment_terms");

  // Nothing partially applied: the two fields the user did fill in
  // correctly are not saved either. That is why losing them off the screen
  // with no message reads as the form refusing the input -- the typing was
  // not just erased, it was never stored.
  await invoice.reload();
  expect(invoice.invoiceNumber).toBe("INV-1");
  expect(invoice.poReference).toBe("PO-1");
});
