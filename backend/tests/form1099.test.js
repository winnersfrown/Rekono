// 1099-NEC prep (form1099.js, routes/vendors.js's /api/reports/1099-nec and
// the tax_id/form_1099_exempt fields on PATCH /api/vendors/:id).
//
// The two rules that matter come straight from the form's own
// instructions, not anything invented here: only payments that cross the
// $600/year threshold show up, and payments made by credit card are
// excluded (the card network reports those on a 1099-K instead) -- so
// these assert against real posted bill payments on different account
// types, not just the report's own math.
import request from "supertest";
import { app } from "../src/app.js";
import { Invoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  return (await request(app).get("/api/auth/me").set(authHeader(token))).body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function makeApprovedInvoice(token, org, overrides = {}) {
  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Contractor Co",
    invoiceNumber: `BILL-${Math.random()}`,
    total: 1000.0,
    overallConfidence: 0.95,
    ...overrides,
  });
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  return invoice.reload();
}

async function payInvoice(token, invoiceId, { amount, paymentAccountId, paymentDate }) {
  const res = await request(app)
    .post(`/api/invoices/${invoiceId}/payments`)
    .set(authHeader(token))
    .send({ amount, payment_date: paymentDate, payment_account_id: paymentAccountId });
  expect(res.status).toBe(201);
}

async function vendorByName(token, name) {
  const res = await request(app).get("/api/vendors").set(authHeader(token));
  return res.body.items.find((v) => v.name === name);
}

test("a vendor paid at least $600 in a year by bank shows up on the report", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  const invoice = await makeApprovedInvoice(token, org, { total: 800 });
  await payInvoice(token, invoice.id, { amount: 800, paymentAccountId: cash, paymentDate: "2026-03-01" });

  const res = await request(app).get("/api/reports/1099-nec?year=2026").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.threshold).toBe(600);
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].vendor_name).toBe("Contractor Co");
  expect(res.body.items[0].total).toBe(800);
  expect(res.body.items[0].missing_tin).toBe(true);
});

test("a vendor paid under $600 doesn't show up at all", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  const invoice = await makeApprovedInvoice(token, org, { total: 500 });
  await payInvoice(token, invoice.id, { amount: 500, paymentAccountId: cash, paymentDate: "2026-03-01" });

  const res = await request(app).get("/api/reports/1099-nec?year=2026").set(authHeader(token));
  expect(res.body.items).toHaveLength(0);
});

test("payments made by credit card are excluded, even over the threshold", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const card = await accountId(token, "Credit Card");

  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });
  await payInvoice(token, invoice.id, { amount: 1000, paymentAccountId: card, paymentDate: "2026-03-01" });

  const res = await request(app).get("/api/reports/1099-nec?year=2026").set(authHeader(token));
  expect(res.body.items).toHaveLength(0);
});

test("bank and card payments to the same vendor: only the bank portion counts", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const card = await accountId(token, "Credit Card");

  const bankBill = await makeApprovedInvoice(token, org, { total: 700 });
  await payInvoice(token, bankBill.id, { amount: 700, paymentAccountId: cash, paymentDate: "2026-04-01" });
  const cardBill = await makeApprovedInvoice(token, org, { total: 900 });
  await payInvoice(token, cardBill.id, { amount: 900, paymentAccountId: card, paymentDate: "2026-04-02" });

  const res = await request(app).get("/api/reports/1099-nec?year=2026").set(authHeader(token));
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].total).toBe(700);
});

test("a payment in a different calendar year doesn't count toward this one", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });
  await payInvoice(token, invoice.id, { amount: 1000, paymentAccountId: cash, paymentDate: "2025-12-15" });

  const res2026 = await request(app).get("/api/reports/1099-nec?year=2026").set(authHeader(token));
  expect(res2026.body.items).toHaveLength(0);

  const res2025 = await request(app).get("/api/reports/1099-nec?year=2025").set(authHeader(token));
  expect(res2025.body.items).toHaveLength(1);
});

test("setting a tax ID keeps only the last four digits, and clears missing_tin", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });
  await payInvoice(token, invoice.id, { amount: 1000, paymentAccountId: cash, paymentDate: "2026-05-01" });

  const vendor = await vendorByName(token, "Contractor Co");
  const patched = await request(app)
    .patch(`/api/vendors/${vendor.id}`)
    .set(authHeader(token))
    .send({ tax_id: "12-3456789" });
  expect(patched.status).toBe(200);
  expect(patched.body.tax_id_last4).toBe("6789");

  const res = await request(app).get("/api/reports/1099-nec?year=2026").set(authHeader(token));
  expect(res.body.items[0].tax_id_last4).toBe("6789");
  expect(res.body.items[0].missing_tin).toBe(false);
});

test("a vendor marked exempt is never flagged missing a TIN", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });
  await payInvoice(token, invoice.id, { amount: 1000, paymentAccountId: cash, paymentDate: "2026-06-01" });

  const vendor = await vendorByName(token, "Contractor Co");
  await request(app).patch(`/api/vendors/${vendor.id}`).set(authHeader(token)).send({ form_1099_exempt: true });

  const res = await request(app).get("/api/reports/1099-nec?year=2026").set(authHeader(token));
  expect(res.body.items).toHaveLength(1);
  expect(res.body.items[0].exempt).toBe(true);
  expect(res.body.items[0].missing_tin).toBe(false);
});

test("1099-NEC totals are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const orgA = await orgId(tokenA);
  const cashA = await accountId(tokenA, "Cash");

  const invoice = await makeApprovedInvoice(tokenA, orgA, { total: 1000 });
  await payInvoice(tokenA, invoice.id, { amount: 1000, paymentAccountId: cashA, paymentDate: "2026-07-01" });

  const fromB = await request(app).get("/api/reports/1099-nec?year=2026").set(authHeader(tokenB));
  expect(fromB.body.items).toHaveLength(0);
});
