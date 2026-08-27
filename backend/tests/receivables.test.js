// Accounts receivable: customers, customer invoices, payments, and AR
// aging (accountsReceivable.js, routes/receivables.js).
//
// The AR side is only correct if it ties out to the same ledger the AP
// side posts to, so most of these assert against the trial balance and
// the financial statements rather than just the AR endpoints' own
// responses -- a customer invoice that looks right in its own API but
// doesn't move Accounts Receivable is exactly the bug worth catching.
import request from "supertest";
import { app } from "../src/app.js";
import { ClosePeriod, CustomerInvoice, CustomerPayment, JournalEntry } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const TODAY = new Date().toISOString().slice(0, 10);
const YEAR_START = `${new Date().getUTCFullYear()}-01-01`;

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function makeCustomer(token, overrides = {}) {
  const res = await request(app)
    .post("/api/customers")
    .set(authHeader(token))
    .send({ name: "Globex Corp", email: "ap@globex.test", ...overrides });
  if (res.status !== 201) throw new Error(`makeCustomer failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function makeInvoice(token, customerId, lines, overrides = {}) {
  const revenue = await accountId(token, "Uncategorized Revenue");
  const res = await request(app)
    .post("/api/customer-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customerId,
      issue_date: TODAY,
      lines: lines || [{ revenue_account_id: revenue, description: "Consulting", quantity: 1, unit_price: 2500 }],
      ...overrides,
    });
  if (res.status !== 201) throw new Error(`makeInvoice failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

test("a customer can be created, listed, updated, and deactivated", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  expect(customer.payment_terms_days).toBe(30);

  const dupe = await request(app).post("/api/customers").set(authHeader(token)).send({ name: "Globex Corp" });
  expect(dupe.status).toBe(409);

  const patched = await request(app)
    .patch(`/api/customers/${customer.id}`)
    .set(authHeader(token))
    .send({ payment_terms_days: 45, active: false });
  expect(patched.body.payment_terms_days).toBe(45);
  expect(patched.body.active).toBe(false);

  const activeOnly = await request(app).get("/api/customers?active=true").set(authHeader(token));
  expect(activeOnly.body.items).toHaveLength(0);
});

test("a new invoice is numbered sequentially and defaults its due date from the customer's terms", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token, { payment_terms_days: 14 });

  const first = await makeInvoice(token, customer.id);
  expect(first.invoice_number).toBe("INV-0001");
  // 14-day terms from the issue date, not a hardcoded 30.
  const expectedDue = new Date(`${TODAY}T00:00:00Z`);
  expectedDue.setUTCDate(expectedDue.getUTCDate() + 14);
  expect(first.due_date).toBe(expectedDue.toISOString().slice(0, 10));

  const second = await makeInvoice(token, customer.id);
  expect(second.invoice_number).toBe("INV-0002");
});

test("a draft invoice posts nothing to the ledger until it's sent", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id);

  expect(invoice.status).toBe("draft");
  expect(await JournalEntry.count({ where: { orgId: org } })).toBe(0);

  // A draft is not a receivable and not revenue.
  const bs = await request(app).get(`/api/statements/balance-sheet?as_of=${TODAY}`).set(authHeader(token));
  expect(bs.body.assets.total).toBe(0);

  const sent = await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));
  expect(sent.status).toBe(200);
  expect(sent.body.status).toBe("sent");

  // Now it's Debit Accounts Receivable / Credit revenue.
  const entry = await JournalEntry.findOne({ where: { orgId: org, sourceType: "customer_invoice", sourceId: invoice.id } });
  expect(entry).toBeTruthy();
  expect(entry.source).toBe("customer_invoice");

  const after = await request(app).get(`/api/statements/balance-sheet?as_of=${TODAY}`).set(authHeader(token));
  const ar = after.body.assets.accounts.find((a) => a.name === "Accounts Receivable");
  expect(ar.amount).toBeCloseTo(2500, 2);
  expect(after.body.balanced).toBe(true);
});

test("sending an invoice puts its revenue on the P&L, split by each line's revenue account", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const uncategorized = await accountId(token, "Uncategorized Revenue");

  const consulting = await request(app)
    .post("/api/accounts")
    .set(authHeader(token))
    .send({ name: "Consulting Revenue", type: "revenue", code: "4100" });
  expect(consulting.status).toBe(201);

  const invoice = await makeInvoice(token, customer.id, [
    { revenue_account_id: consulting.body.id, description: "Advisory", quantity: 10, unit_price: 150 },
    { revenue_account_id: uncategorized, description: "Misc", quantity: 1, unit_price: 300 },
  ]);
  expect(invoice.total).toBeCloseTo(1800, 2);

  await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));

  const pnl = await request(app).get(`/api/statements/profit-and-loss?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(pnl.body.revenue.total).toBeCloseTo(1800, 2);
  const byName = Object.fromEntries(pnl.body.revenue.accounts.map((a) => [a.name, a.amount]));
  expect(byName["Consulting Revenue"]).toBeCloseTo(1500, 2);
  expect(byName["Uncategorized Revenue"]).toBeCloseTo(300, 2);
});

test("a payment moves cash up and receivables down, and flips the invoice to paid when fully settled", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));

  // Partial payment first -- still "sent", partially outstanding.
  const partial = await request(app)
    .post(`/api/customer-invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 1000, payment_date: TODAY, deposit_account_id: cash });
  expect(partial.status).toBe(201);
  expect(partial.body.status).toBe("sent");
  expect(partial.body.amount_paid).toBeCloseTo(1000, 2);
  expect(partial.body.amount_outstanding).toBeCloseTo(1500, 2);

  // Settle the rest.
  const rest = await request(app)
    .post(`/api/customer-invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 1500, payment_date: TODAY, deposit_account_id: cash });
  expect(rest.body.status).toBe("paid");
  expect(rest.body.amount_outstanding).toBeCloseTo(0, 2);

  const bs = await request(app).get(`/api/statements/balance-sheet?as_of=${TODAY}`).set(authHeader(token));
  const accounts = Object.fromEntries(bs.body.assets.accounts.map((a) => [a.name, a.amount]));
  expect(accounts["Cash"]).toBeCloseTo(2500, 2);
  // AR is back to zero, so it drops off the statement entirely.
  expect(accounts["Accounts Receivable"]).toBeUndefined();
  expect(bs.body.balanced).toBe(true);
});

test("a customer payment shows up as operating cash, but issuing the invoice does not", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));

  // Issued but unpaid: revenue on the P&L, nothing on cash flow. This is
  // the accrual-vs-cash distinction from the AR side.
  const beforePayment = await request(app)
    .get(`/api/statements/cash-flow?from=${YEAR_START}&to=${TODAY}`)
    .set(authHeader(token));
  expect(beforePayment.body.net_change_in_cash).toBe(0);

  await request(app)
    .post(`/api/customer-invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 2500, payment_date: TODAY, deposit_account_id: cash });

  const afterPayment = await request(app)
    .get(`/api/statements/cash-flow?from=${YEAR_START}&to=${TODAY}`)
    .set(authHeader(token));
  expect(afterPayment.body.net_change_in_cash).toBeCloseTo(2500, 2);
  // Operating, NOT investing. The counter-account here is Accounts
  // Receivable, which is an asset -- so the plain type-based rule would
  // have called this investing, which is wrong: collecting what a
  // customer owes you is core operations, not buying or selling a
  // long-term asset. financialStatements.js special-cases AR/AP subtypes
  // for exactly this.
  expect(afterPayment.body.operating).toBeCloseTo(2500, 2);
  expect(afterPayment.body.investing).toBe(0);
  expect(afterPayment.body.financing).toBe(0);
  expect(afterPayment.body.reconciled).toBe(true);
});

test("paying down Accounts Payable is operating cash too, not financing", async () => {
  // The AP mirror of the test above -- Accounts Payable is a liability, so
  // the type-based rule alone would call settling a vendor bill
  // "financing". Exercised through a manual journal entry because the AP
  // side doesn't post cash payments to the ledger yet (see the roadmap).
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const ap = await accountId(token, "Accounts Payable");
  const expense = await accountId(token, "Office Supplies");

  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({
      entry_date: TODAY,
      memo: "Bill received",
      lines: [
        { account_id: expense, debit: 400 },
        { account_id: ap, credit: 400 },
      ],
    });
  await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({
      entry_date: TODAY,
      memo: "Bill paid",
      lines: [
        { account_id: ap, debit: 400 },
        { account_id: cash, credit: 400 },
      ],
    });

  const cf = await request(app).get(`/api/statements/cash-flow?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(cf.body.operating).toBeCloseTo(-400, 2);
  expect(cf.body.financing).toBe(0);
  expect(cf.body.net_change_in_cash).toBeCloseTo(-400, 2);
  expect(cf.body.reconciled).toBe(true);
});

test("overpaying an invoice is refused", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));

  const res = await request(app)
    .post(`/api/customer-invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 9999, payment_date: TODAY, deposit_account_id: cash });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/overpay/i);
});

test("a payment can't be recorded against a draft invoice", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeInvoice(token, customer.id);

  const res = await request(app)
    .post(`/api/customer-invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 100, payment_date: TODAY, deposit_account_id: cash });
  expect(res.status).toBe(409);
});

test("voiding a sent invoice reverses it off the books", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const invoice = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));

  const voided = await request(app).post(`/api/customer-invoices/${invoice.id}/void`).set(authHeader(token));
  expect(voided.status).toBe(200);
  expect(voided.body.status).toBe("void");

  // Receivable and revenue both back to zero.
  const bs = await request(app).get(`/api/statements/balance-sheet?as_of=${TODAY}`).set(authHeader(token));
  expect(bs.body.assets.total).toBe(0);
  expect(bs.body.balanced).toBe(true);

  const pnl = await request(app).get(`/api/statements/profit-and-loss?from=${YEAR_START}&to=${TODAY}`).set(authHeader(token));
  expect(pnl.body.revenue.total).toBe(0);
});

test("an invoice with payments against it can't be voided", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));
  await request(app)
    .post(`/api/customer-invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 500, payment_date: TODAY, deposit_account_id: cash });

  const res = await request(app).post(`/api/customer-invoices/${invoice.id}/void`).set(authHeader(token));
  expect(res.status).toBe(409);
  expect(res.body.detail).toMatch(/payments recorded/i);
});

test("every line must bill to a revenue account", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const cash = await accountId(token, "Cash"); // an asset, not revenue

  const res = await request(app)
    .post("/api/customer-invoices")
    .set(authHeader(token))
    .send({
      customer_id: customer.id,
      issue_date: TODAY,
      lines: [{ revenue_account_id: cash, quantity: 1, unit_price: 100 }],
    });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/revenue account/i);
});

test("sending an invoice dated into a closed period is refused", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const customer = await makeCustomer(token);

  const invoice = await makeInvoice(token, customer.id, null, { issue_date: "2026-04-10" });
  await ClosePeriod.create({ orgId: org, periodMonth: "2026-04", status: "closed", closedAt: new Date() });

  const res = await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));
  expect(res.status).toBe(409);
  expect(res.body.detail).toMatch(/2026-04 has been closed/);

  // It stayed a draft rather than half-transitioning.
  const reloaded = await CustomerInvoice.findByPk(invoice.id);
  expect(reloaded.status).toBe("draft");
});

test("AR aging buckets outstanding invoices by how far past due they are", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const revenue = await accountId(token, "Uncategorized Revenue");

  // Four invoices landing in four different buckets as of a fixed date.
  const asOf = "2026-06-30";
  const cases = [
    { due: "2026-07-15", amount: 100 }, // not yet due -> current
    { due: "2026-06-20", amount: 200 }, // 10 days -> 1-30
    { due: "2026-05-20", amount: 300 }, // 41 days -> 31-60
    { due: "2026-01-20", amount: 400 }, // 161 days -> 90+
  ];
  for (const c of cases) {
    const inv = await makeInvoice(
      token,
      customer.id,
      [{ revenue_account_id: revenue, quantity: 1, unit_price: c.amount }],
      { issue_date: "2026-01-05", due_date: c.due }
    );
    await request(app).post(`/api/customer-invoices/${inv.id}/send`).set(authHeader(token));
  }

  const res = await request(app).get(`/api/reports/ar-aging?as_of=${asOf}`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.totals.current).toBeCloseTo(100, 2);
  expect(res.body.totals.d1_30).toBeCloseTo(200, 2);
  expect(res.body.totals.d31_60).toBeCloseTo(300, 2);
  expect(res.body.totals.d90_plus).toBeCloseTo(400, 2);
  expect(res.body.totals.total).toBeCloseTo(1000, 2);

  expect(res.body.customers).toHaveLength(1);
  expect(res.body.customers[0].customer_name).toBe("Globex Corp");
  expect(res.body.customers[0].total).toBeCloseTo(1000, 2);
});

test("AR aging excludes drafts, paid invoices, and voided invoices", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const cash = await accountId(token, "Cash");

  await makeInvoice(token, customer.id); // stays draft

  const paid = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${paid.id}/send`).set(authHeader(token));
  await request(app)
    .post(`/api/customer-invoices/${paid.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 2500, payment_date: TODAY, deposit_account_id: cash });

  const voided = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${voided.id}/send`).set(authHeader(token));
  await request(app).post(`/api/customer-invoices/${voided.id}/void`).set(authHeader(token));

  const res = await request(app).get("/api/reports/ar-aging").set(authHeader(token));
  expect(res.body.totals.total).toBe(0);
  expect(res.body.customers).toHaveLength(0);
});

test("a partially paid invoice ages only its outstanding balance", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));
  await request(app)
    .post(`/api/customer-invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 1000, payment_date: TODAY, deposit_account_id: cash });

  const res = await request(app).get("/api/reports/ar-aging").set(authHeader(token));
  expect(res.body.totals.total).toBeCloseTo(1500, 2);
});

test("the trial balance stays balanced across the whole AR lifecycle", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const cash = await accountId(token, "Cash");

  const invoice = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));
  await request(app)
    .post(`/api/customer-invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 1200, payment_date: TODAY, deposit_account_id: cash });

  const voided = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${voided.id}/send`).set(authHeader(token));
  await request(app).post(`/api/customer-invoices/${voided.id}/void`).set(authHeader(token));

  const tb = await request(app).get("/api/ledger/trial-balance").set(authHeader(token));
  expect(tb.body.balanced).toBe(true);
});

test("customers, invoices, and aging are all scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const customerA = await makeCustomer(tokenA);
  const invoiceA = await makeInvoice(tokenA, customerA.id);
  await request(app).post(`/api/customer-invoices/${invoiceA.id}/send`).set(authHeader(tokenA));

  expect((await request(app).get("/api/customers").set(authHeader(tokenB))).body.items).toHaveLength(0);
  expect((await request(app).get("/api/customer-invoices").set(authHeader(tokenB))).body.total).toBe(0);
  expect((await request(app).get(`/api/customer-invoices/${invoiceA.id}`).set(authHeader(tokenB))).status).toBe(404);
  expect((await request(app).get("/api/reports/ar-aging").set(authHeader(tokenB))).body.totals.total).toBe(0);

  // ...and B can't send or pay A's invoice either.
  expect((await request(app).post(`/api/customer-invoices/${invoiceA.id}/void`).set(authHeader(tokenB))).status).toBe(404);
});

test("a payment refused by a closed period leaves no payment behind", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const customer = await makeCustomer(token);
  const cash = await accountId(token, "Cash");

  const invoice = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));

  // The payment row has to be created before the entry can point at it, so
  // a posting the ledger refuses has to unwind it -- otherwise the invoice
  // reads as paid against cash that never posted.
  await ClosePeriod.create({ orgId: org, periodMonth: "2026-03", status: "closed", closedAt: new Date() });
  const res = await request(app)
    .post(`/api/customer-invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 2500, payment_date: "2026-03-15", deposit_account_id: cash });
  expect(res.status).toBe(409);

  expect(await CustomerPayment.count({ where: { customerInvoiceId: invoice.id } })).toBe(0);

  // ...and the invoice still shows the full balance outstanding.
  const reloaded = await request(app).get(`/api/customer-invoices/${invoice.id}`).set(authHeader(token));
  expect(reloaded.body.status).toBe("sent");
  expect(reloaded.body.amount_outstanding).toBe(2500);
});

test("Accounts Receivable is refused as a deposit account", async () => {
  const token = await signup(app, request);
  const customer = await makeCustomer(token);
  const ar = await accountId(token, "Accounts Receivable");

  const invoice = await makeInvoice(token, customer.id);
  await request(app).post(`/api/customer-invoices/${invoice.id}/send`).set(authHeader(token));

  // Debit AR / Credit AR balances, so the ledger itself would accept it --
  // it just wouldn't move any money, leaving the invoice marked paid
  // against an entry that did nothing.
  const res = await request(app)
    .post(`/api/customer-invoices/${invoice.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 2500, payment_date: TODAY, deposit_account_id: ar });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/not Accounts Receivable/i);

  const reloaded = await request(app).get(`/api/customer-invoices/${invoice.id}`).set(authHeader(token));
  expect(reloaded.body.amount_outstanding).toBe(2500);
});
