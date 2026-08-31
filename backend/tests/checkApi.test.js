// Scanned checks: intake, correction, and the half this module exists for
// -- applying one to a bill (routes/checks.js).
//
// Linking is not a status change, it is money moving: it records a real
// BillPayment and posts a real journal entry. So these assert against the
// trial balance rather than just the endpoint's response, per CLAUDE.md --
// a link that looks right in its own API but leaves Accounts Payable
// untouched is exactly the bug worth catching.
import request from "supertest";
import { app } from "../src/app.js";
import { BillPayment, Check, Invoice, JournalEntry } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function accountId(token, name) {
  const res = await request(app).get("/api/accounts").set(authHeader(token));
  return res.body.items.find((a) => a.name === name)?.id;
}

async function trialBalance(token) {
  const res = await request(app).get("/api/ledger/trial-balance").set(authHeader(token));
  return res.body;
}

function accountRow(tb, name) {
  return (tb.accounts || tb.rows).find((a) => a.name === name) || { debit: 0, credit: 0 };
}

async function makeCheck(org, overrides = {}) {
  return Check.create({
    orgId: org,
    originalFilename: "check.jpg",
    storagePath: "/tmp/does-not-matter.jpg",
    contentType: "image/jpeg",
    status: "extracted",
    checkNumber: "1042",
    checkDate: "2026-03-14",
    payeeName: "Acme Supplies Inc",
    amount: 1000.0,
    memo: "BILL-1",
    bankName: "First Harbor Bank",
    accountLast4: "4567",
    overallConfidence: 0.95,
    ...overrides,
  });
}

// An approved bill: the only state that has posted to Accounts Payable and
// so the only state a payment can relieve.
async function makeApprovedInvoice(token, org, overrides = {}) {
  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "BILL-1",
    invoiceDate: "2026-03-10",
    total: 1000.0,
    overallConfidence: 0.95,
    ...overrides,
  });
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  return invoice.reload();
}

test("upload rejects unsupported file type", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/checks/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });
  expect(res.status).toBe(422);
});

test("upload requires a file", async () => {
  const token = await signup(app, request);
  const res = await request(app).post("/api/checks/upload").set(authHeader(token));
  expect(res.status).toBe(422);
});

test("listing checks reports what is still unapplied", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeCheck(org, { amount: 1000 });
  await makeCheck(org, { amount: 250, payeeName: "Globex Corporation" });

  const res = await request(app).get("/api/checks").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(2);
  expect(res.body.totals.unlinked_count).toBe(2);
  expect(res.body.totals.unlinked_amount).toBe(1250);
});

// ---- linking ----

test("linking a check to a bill relieves Accounts Payable and moves cash", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });
  const check = await makeCheck(org, { amount: 1000 });

  // Approval alone: AP is up, nothing has moved cash.
  const afterApproval = await trialBalance(token);
  expect(accountRow(afterApproval, "Accounts Payable").credit).toBe(1000);
  expect(accountRow(afterApproval, "Cash").credit).toBe(0);

  const res = await request(app)
    .post(`/api/checks/${check.id}/link`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, payment_account_id: cash });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("approved");
  expect(res.body.invoice_id).toBe(invoice.id);
  expect(res.body.bill_payment_id).toBeTruthy();

  // Debit AP / Credit Cash -- the payable is relieved and the cash is gone.
  // The trial balance reports gross debits and credits per account, so the
  // relief shows as the two netting out rather than as a zero credit.
  const afterLink = await trialBalance(token);
  const ap = accountRow(afterLink, "Accounts Payable");
  expect(ap.credit - ap.debit).toBe(0);
  const cash_ = accountRow(afterLink, "Cash");
  expect(cash_.credit - cash_.debit).toBe(1000);
  expect(afterLink.balanced).toBe(true);
});

// The check's own date, not the day it happened to be scanned -- a check
// written on the 28th and scanned on the 3rd belongs in the month it was
// written, and using the scan date silently moves real money across a
// period boundary.
test("the payment is dated from the check, not from today", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });
  const check = await makeCheck(org, { amount: 1000, checkDate: "2026-03-14" });

  await request(app)
    .post(`/api/checks/${check.id}/link`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, payment_account_id: cash });

  const payment = await BillPayment.findOne({ where: { invoiceId: invoice.id } });
  expect(payment.paymentDate).toBe("2026-03-14");
});

test("a check cannot overpay the bill it is linked to", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 500 });
  const check = await makeCheck(org, { amount: 1000 });

  const res = await request(app)
    .post(`/api/checks/${check.id}/link`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, payment_account_id: cash });
  expect(res.status).toBe(422);
  expect(res.body.detail).toMatch(/overpay/i);

  // Nothing partially applied.
  expect(await BillPayment.count({ where: { invoiceId: invoice.id } })).toBe(0);
  await check.reload();
  expect(check.invoiceId).toBeNull();
});

test("a bill that is not approved cannot be paid by check", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "needs_review",
    vendorName: "Acme Supplies Inc",
    total: 1000,
  });
  const check = await makeCheck(org, { amount: 1000 });

  const res = await request(app)
    .post(`/api/checks/${check.id}/link`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, payment_account_id: cash });
  expect(res.status).toBe(409);
});

// Accounts Payable is refused as a source for the same reason the manual
// payments route refuses it: Debit AP / Credit AP balances, passes every
// check the ledger makes, and moves nothing.
test("Accounts Payable is not a valid account to pay a check from", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const ap = await accountId(token, "Accounts Payable");
  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });
  const check = await makeCheck(org, { amount: 1000 });

  const res = await request(app)
    .post(`/api/checks/${check.id}/link`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, payment_account_id: ap });
  expect(res.status).toBe(422);
});

test("a check with no readable amount cannot be linked", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });
  const check = await makeCheck(org, { amount: null, status: "needs_review" });

  const res = await request(app)
    .post(`/api/checks/${check.id}/link`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, payment_account_id: cash });
  expect(res.status).toBe(422);
});

// ---- unlinking ----

test("unlinking reverses the payment and leaves both entries on the books", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });
  const check = await makeCheck(org, { amount: 1000 });

  await request(app)
    .post(`/api/checks/${check.id}/link`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, payment_account_id: cash });

  const res = await request(app).post(`/api/checks/${check.id}/unlink`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.invoice_id).toBeNull();
  // Back to review rather than to "extracted": a link that had to be
  // undone is evidence something about this check was misread.
  expect(res.body.status).toBe("needs_review");

  // The payable is back and the cash is back -- the reversal nets the
  // original out rather than deleting it.
  const afterUnlink = await trialBalance(token);
  const ap = accountRow(afterUnlink, "Accounts Payable");
  expect(ap.credit - ap.debit).toBe(1000);
  const cash_ = accountRow(afterUnlink, "Cash");
  expect(cash_.credit - cash_.debit).toBe(0);
  expect(afterUnlink.balanced).toBe(true);

  // The payment row is gone, but the entry and its reversal both remain --
  // same treatment the manual "remove payment" route gives.
  expect(await BillPayment.count({ where: { invoiceId: invoice.id } })).toBe(0);
  const entries = await JournalEntry.findAll({ where: { orgId: org, sourceType: "bill_payment" } });
  expect(entries.length).toBeGreaterThan(0);
});

test("unlinking a check that was never linked is refused", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const check = await makeCheck(org);

  const res = await request(app).post(`/api/checks/${check.id}/unlink`).set(authHeader(token));
  expect(res.status).toBe(409);
});

// A linked check's fields are what the posted payment was based on, so
// they can't be edited out from under it -- unlink, correct, link again.
test("a linked check cannot be corrected, deleted, or re-extracted", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });
  const check = await makeCheck(org, { amount: 1000 });

  await request(app)
    .post(`/api/checks/${check.id}/link`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, payment_account_id: cash });

  const patched = await request(app).patch(`/api/checks/${check.id}`).set(authHeader(token)).send({ amount: 5 });
  expect(patched.status).toBe(409);

  const retried = await request(app).post(`/api/checks/${check.id}/retry`).set(authHeader(token));
  expect(retried.status).toBe(409);

  const deleted = await request(app).delete(`/api/checks/${check.id}`).set(authHeader(token));
  expect(deleted.status).toBe(409);
});

// ---- corrections ----

// A reviewer types what's printed on the check, which is the whole account
// number. Narrowing has to happen server-side: a 4-character input cap
// would keep the FIRST four digits, which is the wrong end.
test("correcting the account number stores only its last four digits", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const check = await makeCheck(org, { accountLast4: "" });

  const res = await request(app)
    .patch(`/api/checks/${check.id}`)
    .set(authHeader(token))
    .send({ account_last4: "0001234567" });
  expect(res.status).toBe(200);
  expect(res.body.account_last4).toBe("4567");

  await check.reload();
  expect(check.accountLast4).toBe("4567");
});

// Silently storing "" would be indistinguishable from "this check shows no
// account number", which is a different fact.
test("an account number too short to narrow is rejected rather than blanked", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const check = await makeCheck(org);

  const res = await request(app).patch(`/api/checks/${check.id}`).set(authHeader(token)).send({ account_last4: "12" });
  expect(res.status).toBe(422);
});

// ---- match suggestions ----

test("match suggestions rank the org's open bills and skip unrelated ones", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedInvoice(token, org, { total: 1000, vendorName: "Acme Supplies Inc", invoiceNumber: "BILL-1" });
  await makeApprovedInvoice(token, org, {
    total: 4200,
    vendorName: "Zenith Industrial Fasteners",
    invoiceNumber: "ZIF-99",
    invoiceDate: "2020-01-01",
  });
  const check = await makeCheck(org, { amount: 1000, payeeName: "Acme Supplies Inc" });

  const res = await request(app).get(`/api/checks/${check.id}/match-suggestions`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.open_bill_count).toBe(2);
  expect(res.body.suggestions[0].vendor_name).toBe("Acme Supplies Inc");
  expect(res.body.suggestions[0].outstanding).toBe(1000);
  expect(res.body.suggestions[0].reasoning).toBeTruthy();
});

// A bill already paid in full isn't an open payable, so it must stop being
// offered -- otherwise the top suggestion is a bill the link route would
// then refuse as an overpayment.
test("a fully paid bill drops out of match suggestions", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const invoice = await makeApprovedInvoice(token, org, { total: 1000 });
  const firstCheck = await makeCheck(org, { amount: 1000 });

  await request(app)
    .post(`/api/checks/${firstCheck.id}/link`)
    .set(authHeader(token))
    .send({ invoice_id: invoice.id, payment_account_id: cash });

  const secondCheck = await makeCheck(org, { amount: 1000 });
  const res = await request(app).get(`/api/checks/${secondCheck.id}/match-suggestions`).set(authHeader(token));
  expect(res.body.open_bill_count).toBe(0);
  expect(res.body.suggestions).toHaveLength(0);
});

// ---- org isolation ----

test("one org cannot see or link another org's checks", async () => {
  const tokenA = await signup(app, request);
  const orgA = await orgId(tokenA);
  const check = await makeCheck(orgA);

  const tokenB = await signup(app, request, { email: "other@example.com" });

  expect((await request(app).get(`/api/checks/${check.id}`).set(authHeader(tokenB))).status).toBe(404);
  expect((await request(app).post(`/api/checks/${check.id}/unlink`).set(authHeader(tokenB))).status).toBe(404);
  expect((await request(app).delete(`/api/checks/${check.id}`).set(authHeader(tokenB))).status).toBe(404);
  expect((await request(app).get("/api/checks").set(authHeader(tokenB))).body.total).toBe(0);
});
