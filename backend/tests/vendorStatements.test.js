// Vendor statements (accountsPayable.js's computeVendorStatement,
// routes/vendors.js's GET /api/vendors/:id/statement) -- the AP mirror of
// customerStatements.test.js. Unlike a customer invoice, a bill's approval
// never takes an entryDate (postInvoiceApproval always posts dated to
// whenever the approval actually ran, see accountsPayable.js), so these
// tests use today's date for a bill's own statement line rather than a
// picked issue date, and use future dates for payments/credits to keep
// ordering deterministic without touching the clock.
import request from "supertest";
import { app } from "../src/app.js";
import { ClosePeriod, Invoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_MONTH = TODAY.slice(0, 7);

async function orgId(token) {
  return (await request(app).get("/api/auth/me").set(authHeader(token))).body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function makeApprovedBill(token, org, overrides = {}) {
  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "BILL-1",
    total: 1000,
    overallConfidence: 0.95,
    ...overrides,
  });
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  return invoice.reload();
}

async function getVendorId(token, name) {
  const res = await request(app).get("/api/vendors").set(authHeader(token));
  return res.body.items.find((v) => v.name === name)?.id;
}

async function pay(token, invoiceId, amount, paymentDate) {
  const cash = await accountId(token, "Cash");
  const res = await request(app)
    .post(`/api/invoices/${invoiceId}/payments`)
    .set(authHeader(token))
    .send({ amount, payment_date: paymentDate, payment_account_id: cash });
  if (res.status !== 201) throw new Error(`pay failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function makeCreditMemo(token, vendorName, amount, issueDate) {
  const expense = await accountId(token, "Uncategorized Expense");
  const res = await request(app)
    .post("/api/vendor-credit-memos")
    .set(authHeader(token))
    .send({ vendor_name: vendorName, expense_account_id: expense, issue_date: issueDate, amount });
  if (res.status !== 201) throw new Error(`makeCreditMemo failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

function futureDate(days) {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("a statement lists a bill, a payment, and a credit memo in date order with a running balance", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  const bill = await makeApprovedBill(token, org, { total: 1000 });
  await pay(token, bill.id, 400, futureDate(5));
  await makeCreditMemo(token, "Acme Supplies Inc", 100, futureDate(10));

  const vendorId = await getVendorId(token, "Acme Supplies Inc");
  const res = await request(app)
    .get(`/api/vendors/${vendorId}/statement?from=${TODAY}&to=${futureDate(30)}`)
    .set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.opening_balance).toBe(0);
  expect(res.body.activity).toHaveLength(3);

  expect(res.body.activity[0]).toMatchObject({ date: TODAY, type: "bill", amount: 1000, balance: 1000 });
  expect(res.body.activity[1]).toMatchObject({ date: futureDate(5), type: "payment", amount: -400, balance: 600 });
  expect(res.body.activity[2]).toMatchObject({ date: futureDate(10), type: "credit_memo", amount: -100, balance: 500 });
  expect(res.body.closing_balance).toBe(500);
});

test("activity from before the period sets the opening balance instead of appearing as a line", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  const bill = await makeApprovedBill(token, org, { total: 1000 });
  await pay(token, bill.id, 300, futureDate(2));

  const res = await request(app)
    .get(`/api/vendors/${await getVendorId(token, "Acme Supplies Inc")}/statement?from=${futureDate(3)}&to=${futureDate(30)}`)
    .set(authHeader(token));
  expect(res.body.opening_balance).toBe(700); // 1000 - 300, carried in
  expect(res.body.activity).toHaveLength(0);
  expect(res.body.closing_balance).toBe(700);
});

test("a bill approved into a closed period never posts, and never appears on the statement", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await ClosePeriod.create({ orgId: org, periodMonth: TODAY_MONTH, status: "closed", closedAt: new Date() });

  const bill = await makeApprovedBill(token, org, { total: 500 });
  expect(bill.status).toBe("approved"); // status still flips even though posting degraded

  const res = await request(app)
    .get(`/api/vendors/${await getVendorId(token, "Acme Supplies Inc")}/statement`)
    .set(authHeader(token));
  expect(res.body.activity).toHaveLength(0);
  expect(res.body.closing_balance).toBe(0);
});

test("bills approved under slightly different vendor names still land on one statement once merged", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  const billA = await makeApprovedBill(token, org, { vendorName: "Acme Supplies Inc", total: 500, invoiceNumber: "BILL-A" });
  const billB = await makeApprovedBill(token, org, { vendorName: "Acme Supplies Incorporated", total: 700, invoiceNumber: "BILL-B" });

  const vendorA = await getVendorId(token, "Acme Supplies Inc");
  const vendorB = await getVendorId(token, "Acme Supplies Incorporated");

  // Before merging, each only sees its own bill.
  const before = await request(app).get(`/api/vendors/${vendorA}/statement`).set(authHeader(token));
  expect(before.body.closing_balance).toBe(500);

  await request(app).post(`/api/vendors/${vendorB}/merge`).set(authHeader(token)).send({ into_vendor_id: vendorA });

  const after = await request(app).get(`/api/vendors/${vendorA}/statement`).set(authHeader(token));
  expect(after.body.activity).toHaveLength(2);
  expect(after.body.closing_balance).toBe(1200);
  void billA;
  void billB;
});

test("a statement with no activity is a flat zero balance, and an unknown vendor 404s", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedBill(token, org, { vendorName: "Someone Else Inc" });
  const emptyVendor = await getVendorId(token, "Someone Else Inc");

  const res = await request(app).get(`/api/vendors/${emptyVendor}/statement?from=${futureDate(1)}`).set(authHeader(token));
  expect(res.body.activity).toHaveLength(0);

  const missing = await request(app).get("/api/vendors/does-not-exist/statement").set(authHeader(token));
  expect(missing.status).toBe(404);
});

test("vendor statements are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const orgA = await orgId(tokenA);
  await makeApprovedBill(tokenA, orgA);
  const vendorA = await getVendorId(tokenA, "Acme Supplies Inc");

  const res = await request(app).get(`/api/vendors/${vendorA}/statement`).set(authHeader(tokenB));
  expect(res.status).toBe(404);
});
