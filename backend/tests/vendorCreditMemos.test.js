// Vendor credit memos (accountsPayable.js, routes/payables.js's
// /api/vendor-credit-memos endpoints) -- the AP mirror of the customer
// credit memos in receivables.test.js. A vendor credit reduces what we owe
// them and reverses the expense already booked when the bill was approved.
import request from "supertest";
import { app } from "../src/app.js";
import { AuditLog, Invoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  return (await request(app).get("/api/auth/me").set(authHeader(token))).body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function trialBalance(token) {
  return (await request(app).get("/api/ledger/trial-balance").set(authHeader(token))).body;
}

function accountRow(tb, name) {
  return (tb.accounts || tb.rows).find((a) => a.name === name) || { debit: 0, credit: 0 };
}

async function makeInvoice(org, overrides = {}) {
  return Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "BILL-1",
    total: 1000.0,
    overallConfidence: 0.95,
    ...overrides,
  });
}

async function makeApprovedInvoice(token, org, overrides = {}) {
  const invoice = await makeInvoice(org, overrides);
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  return invoice.reload();
}

async function makeCreditMemo(token, overrides = {}) {
  const expenseAccountId = overrides.expense_account_id || (await accountId(token, "Uncategorized Expense"));
  const res = await request(app)
    .post("/api/vendor-credit-memos")
    .set(authHeader(token))
    .send({
      vendor_name: "Acme Supplies Inc",
      issue_date: "2026-02-01",
      amount: 100,
      ...overrides,
      expense_account_id: expenseAccountId,
    });
  if (res.status !== 201) throw new Error(`makeCreditMemo failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

test("a vendor credit memo posts immediately, numbers sequentially, and debits Accounts Payable / credits the expense account", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedInvoice(token, org);

  const memo = await makeCreditMemo(token, { amount: 150 });
  expect(memo.credit_number).toBe("VCM-0001");
  expect(memo.status).toBe("issued");
  expect(memo.unapplied).toBe(150);

  const second = await makeCreditMemo(token, { amount: 50 });
  expect(second.credit_number).toBe("VCM-0002");

  const tb = await trialBalance(token);
  expect(accountRow(tb, "Accounts Payable").debit).toBe(200); // 150 + 50 credited back
  expect(accountRow(tb, "Uncategorized Expense").credit).toBe(200);
  expect(tb.balanced).toBe(true);
});

test("applying a credit memo reduces a bill's outstanding balance, can fully settle it, and AP aging agrees", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });

  const memo = await makeCreditMemo(token, { amount: 1000 });
  const applied = await request(app)
    .post(`/api/vendor-credit-memos/${memo.id}/apply`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, amount: 400 });
  expect(applied.status).toBe(200);
  expect(applied.body.bill.amount_credited).toBe(400);
  expect(applied.body.bill.amount_outstanding).toBe(600);
  expect(applied.body.credit_memo.unapplied).toBe(600);

  await request(app)
    .post(`/api/vendor-credit-memos/${memo.id}/apply`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, amount: 600 });

  const bills = await request(app).get("/api/bills").set(authHeader(token));
  expect(bills.body.items.find((i) => i.invoice_id === invoice.id)).toBeUndefined(); // fully settled, drops off

  const memoReloaded = await request(app).get(`/api/vendor-credit-memos/${memo.id}`).set(authHeader(token));
  expect(memoReloaded.body.unapplied).toBe(0);

  const aging = await request(app).get("/api/reports/ap-aging").set(authHeader(token));
  expect(aging.body.totals.total).toBe(0);
});

test("a credit memo can't over-apply to a bill, or apply more than it has left, or apply to a different vendor's bill", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoiceA = await makeApprovedInvoice(token, org, { total: 150, vendorName: "Acme Supplies Inc" });
  const invoiceC = await makeApprovedInvoice(token, org, { total: 1000, vendorName: "Acme Supplies Inc" });
  const invoiceB = await makeApprovedInvoice(token, org, { total: 500, vendorName: "Different Vendor LLC" });

  const memo = await makeCreditMemo(token, { amount: 200 });

  const overApply = await request(app)
    .post(`/api/vendor-credit-memos/${memo.id}/apply`)
    .set(authHeader(token))
    .send({ invoice_id: invoiceA.id, amount: 200 });
  expect(overApply.status).toBe(422);
  expect(overApply.body.detail).toMatch(/over-apply/);

  await request(app)
    .post(`/api/vendor-credit-memos/${memo.id}/apply`)
    .set(authHeader(token))
    .send({ invoice_id: invoiceA.id, amount: 150 });

  // Only 50 left unapplied on the memo -- applying 60 (well within
  // invoiceC's own 1000 balance) has to fail on the memo's own remaining
  // balance, not the bill's.
  const overUse = await request(app)
    .post(`/api/vendor-credit-memos/${memo.id}/apply`)
    .set(authHeader(token))
    .send({ invoice_id: invoiceC.id, amount: 60 });
  expect(overUse.status).toBe(422);
  expect(overUse.body.detail).toMatch(/left unapplied/);

  const secondMemo = await makeCreditMemo(token, { vendor_name: "Different Vendor LLC", amount: 50 });
  const wrongVendor = await request(app)
    .post(`/api/vendor-credit-memos/${secondMemo.id}/apply`)
    .set(authHeader(token))
    .send({ invoice_id: invoiceA.id, amount: 50 });
  expect(wrongVendor.status).toBe(422);
  expect(wrongVendor.body.detail).toMatch(/same vendor/);
});

test("voiding an unapplied credit memo reverses it; an applied one refuses", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeApprovedInvoice(token, org);

  const unapplied = await makeCreditMemo(token, { amount: 100 });
  const voided = await request(app).post(`/api/vendor-credit-memos/${unapplied.id}/void`).set(authHeader(token));
  expect(voided.status).toBe(200);
  expect(voided.body.status).toBe("void");

  const bsAfterVoid = await request(app).get("/api/statements/balance-sheet").set(authHeader(token));
  expect(bsAfterVoid.body.balanced).toBe(true);

  const applied = await makeCreditMemo(token, { amount: 100 });
  await request(app)
    .post(`/api/vendor-credit-memos/${applied.id}/apply`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, amount: 100 });

  const refused = await request(app).post(`/api/vendor-credit-memos/${applied.id}/void`).set(authHeader(token));
  expect(refused.status).toBe(409);
  expect(refused.body.detail).toMatch(/applied to a bill/);
});

test("a credit memo must reverse an expense account the org owns, and can't apply to a bill still in review", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const needsReview = await makeInvoice(org);

  const badAccount = await request(app)
    .post("/api/vendor-credit-memos")
    .set(authHeader(token))
    .send({ vendor_name: "Acme Supplies Inc", issue_date: "2026-02-01", amount: 50, expense_account_id: cash });
  expect(badAccount.status).toBe(422);
  expect(badAccount.body.detail).toMatch(/expense account/i);

  const memo = await makeCreditMemo(token, { amount: 50 });
  const applyToUnapproved = await request(app)
    .post(`/api/vendor-credit-memos/${memo.id}/apply`)
    .set(authHeader(token))
    .send({ invoice_id: needsReview.id, amount: 50 });
  expect(applyToUnapproved.status).toBe(409);
  expect(applyToUnapproved.body.detail).toMatch(/extracted/);
});

test("issuing and voiding a vendor credit memo is audit-logged", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedInvoice(token, org);

  const memo = await makeCreditMemo(token, { amount: 75 });
  const issued = await AuditLog.findOne({ where: { orgId: org, action: "vendor_credit_memo_issued" } });
  expect(issued.details.credit_number).toBe(memo.credit_number);

  await request(app).post(`/api/vendor-credit-memos/${memo.id}/void`).set(authHeader(token));
  const voided = await AuditLog.findOne({ where: { orgId: org, action: "vendor_credit_memo_voided" } });
  expect(voided.details.credit_number).toBe(memo.credit_number);
});

test("vendor credit memos are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const orgA = await orgId(tokenA);
  await makeApprovedInvoice(tokenA, orgA);
  const memoA = await makeCreditMemo(tokenA, { amount: 50 });

  expect((await request(app).get("/api/vendor-credit-memos").set(authHeader(tokenB))).body.items).toHaveLength(0);
  expect((await request(app).get(`/api/vendor-credit-memos/${memoA.id}`).set(authHeader(tokenB))).status).toBe(404);
  expect((await request(app).post(`/api/vendor-credit-memos/${memoA.id}/void`).set(authHeader(tokenB))).status).toBe(404);
});
