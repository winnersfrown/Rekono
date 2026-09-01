// Vendor identity for AP (vendors.js, routes/vendors.js).
//
// Before this, AP aging grouped by normalizing the extracted vendor name.
// That handles "Acme Inc." vs "  ACME Inc. " and nothing else -- the
// moment the same vendor's name arrived genuinely differently, the report
// showed one vendor as two. These tests are mostly about that failure and
// the merge that fixes it, so most of them assert against the aging report
// rather than the vendor endpoints alone.
import request from "supertest";
import { app } from "../src/app.js";
import { Invoice, Vendor, VendorAlias, VendorExpenseAccount } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const TODAY = new Date().toISOString().slice(0, 10);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
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
    vendorName: "Acme Inc",
    invoiceNumber: "BILL-1",
    total: 100,
    overallConfidence: 0.95,
    ...overrides,
  });
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));
  return invoice.reload();
}

async function aging(token) {
  return (await request(app).get("/api/reports/ap-aging").set(authHeader(token))).body;
}

test("approving a bill creates the vendor it names and links the bill to it", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeApprovedBill(token, org, { vendorName: "Acme Inc" });

  expect(invoice.vendorId).toBeTruthy();

  const vendors = await request(app).get("/api/vendors").set(authHeader(token));
  expect(vendors.body.items).toHaveLength(1);
  expect(vendors.body.items[0]).toMatchObject({
    name: "Acme Inc",
    auto_created: true,
    bill_count: 1,
    amount_outstanding: 100,
  });
});

test("a second bill from the same vendor reuses the vendor rather than making another", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const first = await makeApprovedBill(token, org, { vendorName: "Acme Inc", invoiceNumber: "B-1" });
  // Differs only by case and padding -- the part normalization can settle.
  const second = await makeApprovedBill(token, org, { vendorName: "  ACME inc ", invoiceNumber: "B-2" });

  expect(second.vendorId).toBe(first.vendorId);
  expect((await request(app).get("/api/vendors").set(authHeader(token))).body.items).toHaveLength(1);
});

test("approving a bill with no due date inherits the vendor's payment terms", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await Vendor.create({ orgId: org, name: "Acme Inc", paymentTermsDays: 45 });
  const invoice = await makeApprovedBill(token, org, { vendorName: "Acme Inc", invoiceDate: TODAY });

  // 45-day terms from the invoice date, not a hardcoded 30.
  const expectedDue = new Date(`${TODAY}T00:00:00Z`);
  expectedDue.setUTCDate(expectedDue.getUTCDate() + 45);
  expect(invoice.dueDate).toBe(expectedDue.toISOString().slice(0, 10));
});

test("a bill's own extracted due date is never overwritten by vendor terms", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await Vendor.create({ orgId: org, name: "Acme Inc", paymentTermsDays: 45 });
  const invoice = await makeApprovedBill(token, org, {
    vendorName: "Acme Inc",
    invoiceDate: TODAY,
    dueDate: "2099-01-01",
  });

  expect(invoice.dueDate).toBe("2099-01-01");
});

test("a bill with no invoice date extracted gets no due-date fallback either", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeApprovedBill(token, org, { vendorName: "Acme Inc" });

  expect(invoice.dueDate).toBeNull();
});

test("a bill still in review has no vendor -- resolution happens at approval", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "needs_review",
    vendorName: "Never Approved Ltd",
    total: 50,
    overallConfidence: 0.4,
  });

  // OCR noise on a document nobody approves shouldn't litter the vendor
  // list, so nothing is created until the bill becomes a payable.
  await invoice.reload();
  expect(invoice.vendorId).toBeNull();
  expect((await request(app).get("/api/vendors").set(authHeader(token))).body.items).toHaveLength(0);
});

test("differently-spelled names start as two vendors, which is the bug merge exists to fix", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedBill(token, org, { vendorName: "Acme Inc", total: 100, invoiceNumber: "B-1" });
  await makeApprovedBill(token, org, { vendorName: "Acme Incorporated", total: 250, invoiceNumber: "B-2" });

  // Nothing can know these two strings are one company, so the report
  // honestly shows two rows rather than guessing.
  const before = await aging(token);
  expect(before.vendors).toHaveLength(2);
  expect(before.totals.total).toBe(350);
});

test("merging two vendors regroups the aging report, including bills already approved", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedBill(token, org, { vendorName: "Acme Inc", total: 100, invoiceNumber: "B-1" });
  await makeApprovedBill(token, org, { vendorName: "Acme Incorporated", total: 250, invoiceNumber: "B-2" });

  const vendors = (await request(app).get("/api/vendors").set(authHeader(token))).body.items;
  const loser = vendors.find((v) => v.name === "Acme Inc");
  const winner = vendors.find((v) => v.name === "Acme Incorporated");

  const merged = await request(app)
    .post(`/api/vendors/${loser.id}/merge`)
    .set(authHeader(token))
    .send({ into_vendor_id: winner.id });
  expect(merged.status).toBe(200);
  expect(merged.body.bills_moved).toBe(1);

  // Retroactive: the historical bill regroups without being rewritten by
  // hand, and the total is unchanged because nothing about the money moved.
  const after = await aging(token);
  expect(after.vendors).toHaveLength(1);
  expect(after.vendors[0].vendor_name).toBe("Acme Incorporated");
  expect(after.vendors[0].total).toBe(350);
  expect(after.totals.total).toBe(350);
});

test("a merge teaches the losing spelling, so the next bill under it resolves correctly", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedBill(token, org, { vendorName: "Acme Inc", total: 100, invoiceNumber: "B-1" });
  await makeApprovedBill(token, org, { vendorName: "Acme Incorporated", total: 250, invoiceNumber: "B-2" });

  const vendors = (await request(app).get("/api/vendors").set(authHeader(token))).body.items;
  const loser = vendors.find((v) => v.name === "Acme Inc");
  const winner = vendors.find((v) => v.name === "Acme Incorporated");
  await request(app)
    .post(`/api/vendors/${loser.id}/merge`)
    .set(authHeader(token))
    .send({ into_vendor_id: winner.id });

  // A new bill arrives spelled the old way. Without the alias this would
  // recreate the duplicate the merge just removed, and the user would have
  // to merge the same pair again every month.
  const third = await makeApprovedBill(token, org, { vendorName: "Acme Inc", total: 50, invoiceNumber: "B-3" });
  expect(third.vendorId).toBe(winner.id);

  const after = await aging(token);
  expect(after.vendors).toHaveLength(1);
  expect(after.totals.total).toBe(400);
});

test("the merged-away spelling is visible on the surviving vendor", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedBill(token, org, { vendorName: "Acme Inc", invoiceNumber: "B-1" });
  await makeApprovedBill(token, org, { vendorName: "Acme Incorporated", invoiceNumber: "B-2" });

  const vendors = (await request(app).get("/api/vendors").set(authHeader(token))).body.items;
  const loser = vendors.find((v) => v.name === "Acme Inc");
  const winner = vendors.find((v) => v.name === "Acme Incorporated");
  await request(app)
    .post(`/api/vendors/${loser.id}/merge`)
    .set(authHeader(token))
    .send({ into_vendor_id: winner.id });

  const after = (await request(app).get("/api/vendors").set(authHeader(token))).body.items;
  expect(after).toHaveLength(1);
  // The only visible record that the merge happened, and what stops the
  // duplicate coming back.
  expect(after[0].aliases).toContain("acme inc");
});

test("a merge carries the remembered expense account across", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const expenseAccount = await accountId(token, "Uncategorized Expense");

  await makeApprovedBill(token, org, { vendorName: "Acme Inc", invoiceNumber: "B-1" });
  await makeApprovedBill(token, org, { vendorName: "Acme Incorporated", invoiceNumber: "B-2" });
  // A human already confirmed which account this vendor's spend belongs
  // under, under the spelling that's about to be merged away.
  await VendorExpenseAccount.create({
    orgId: org,
    vendorName: "acme inc",
    expenseAccountId: expenseAccount,
    expenseAccountName: "Uncategorized Expense",
  });

  const vendors = (await request(app).get("/api/vendors").set(authHeader(token))).body.items;
  const loser = vendors.find((v) => v.name === "Acme Inc");
  const winner = vendors.find((v) => v.name === "Acme Incorporated");
  await request(app)
    .post(`/api/vendors/${loser.id}/merge`)
    .set(authHeader(token))
    .send({ into_vendor_id: winner.id });

  // Losing it would mean re-categorizing a vendor the user already taught
  // this app about once.
  const carried = await VendorExpenseAccount.findOne({ where: { orgId: org, vendorName: "acme incorporated" } });
  expect(carried).not.toBeNull();
  expect(carried.expenseAccountId).toBe(expenseAccount);
});

test("a vendor can't be merged into itself, and unknown vendors 404", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedBill(token, org, { vendorName: "Acme Inc" });
  const vendor = (await request(app).get("/api/vendors").set(authHeader(token))).body.items[0];

  const self = await request(app)
    .post(`/api/vendors/${vendor.id}/merge`)
    .set(authHeader(token))
    .send({ into_vendor_id: vendor.id });
  expect(self.status).toBe(422);

  const missing = await request(app)
    .post(`/api/vendors/${vendor.id}/merge`)
    .set(authHeader(token))
    .send({ into_vendor_id: "does-not-exist" });
  expect(missing.status).toBe(404);
});

test("vendors can be created, renamed, and deactivated by hand", async () => {
  const token = await signup(app, request);
  const created = await request(app)
    .post("/api/vendors")
    .set(authHeader(token))
    .send({ name: "Globex Ltd", email: "ap@globex.test", payment_terms_days: 45 });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ payment_terms_days: 45, auto_created: false });

  // Normalization catches the duplicate this app *can* be sure about.
  const dupe = await request(app).post("/api/vendors").set(authHeader(token)).send({ name: "  globex ltd " });
  expect(dupe.status).toBe(409);

  const renamed = await request(app)
    .patch(`/api/vendors/${created.body.id}`)
    .set(authHeader(token))
    .send({ name: "Globex Limited", active: false });
  expect(renamed.body.name).toBe("Globex Limited");
  expect(renamed.body.active).toBe(false);
});

test("a bill approved before vendors existed still appears on the aging report", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const invoice = await makeApprovedBill(token, org, { vendorName: "Legacy Supply Co", total: 300 });

  // Simulate the pre-v1.25 shape: approved and posted, but with no vendor
  // link and no vendor row. Resolution falls back to the name so the bill
  // is still reported rather than silently dropped.
  await Vendor.destroy({ where: { orgId: org } });
  await Invoice.unscoped().update({ vendorId: null }, { where: { id: invoice.id } });

  const report = await aging(token);
  expect(report.totals.total).toBe(300);
  expect(report.vendors).toHaveLength(1);
  expect(report.vendors[0].vendor_name).toBe("Legacy Supply Co");
  expect(report.vendors[0].vendor_id).toBeNull();
});

test("AP aging still reconciles to the balance sheet after a merge", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedBill(token, org, { vendorName: "Acme Inc", total: 100, invoiceNumber: "B-1" });
  await makeApprovedBill(token, org, { vendorName: "Acme Incorporated", total: 250, invoiceNumber: "B-2" });

  const vendors = (await request(app).get("/api/vendors").set(authHeader(token))).body.items;
  await request(app)
    .post(`/api/vendors/${vendors.find((v) => v.name === "Acme Inc").id}/merge`)
    .set(authHeader(token))
    .send({ into_vendor_id: vendors.find((v) => v.name === "Acme Incorporated").id });

  // Regrouping must not move a cent. If a merge can change the total, it's
  // touching accounting rather than presentation, which it must never do.
  const report = await aging(token);
  const sheet = await request(app).get("/api/statements/balance-sheet").set(authHeader(token));
  const apLine = sheet.body.liabilities.accounts.find((l) => l.name === "Accounts Payable");
  expect(report.totals.total).toBe(350);
  expect(apLine.amount).toBe(350);
  expect(sheet.body.balanced).toBe(true);
});

test("a merge moves paid bills too, so vendor history stays whole", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");
  const paidBill = await makeApprovedBill(token, org, { vendorName: "Acme Inc", total: 100, invoiceNumber: "B-1" });
  await makeApprovedBill(token, org, { vendorName: "Acme Incorporated", total: 250, invoiceNumber: "B-2" });
  await request(app)
    .post(`/api/invoices/${paidBill.id}/payments`)
    .set(authHeader(token))
    .send({ amount: 100, payment_date: TODAY, payment_account_id: cash });

  const vendors = (await request(app).get("/api/vendors").set(authHeader(token))).body.items;
  const winner = vendors.find((v) => v.name === "Acme Incorporated");
  await request(app)
    .post(`/api/vendors/${vendors.find((v) => v.name === "Acme Inc").id}/merge`)
    .set(authHeader(token))
    .send({ into_vendor_id: winner.id });

  // The paid bill has nothing outstanding, so it doesn't age -- but it
  // still belongs to the surviving vendor.
  const after = (await request(app).get("/api/vendors").set(authHeader(token))).body.items;
  expect(after).toHaveLength(1);
  expect(after[0].bill_count).toBe(2);
  expect(after[0].amount_outstanding).toBe(250);
});

test("vendors are scoped to the caller's org", async () => {
  const tokenA = await signup(app, request, { email: "a@example.co" });
  const tokenB = await signup(app, request, { email: "b@example.co", orgName: "Org B" });
  const orgA = await orgId(tokenA);
  await makeApprovedBill(tokenA, orgA, { vendorName: "Acme Inc" });

  expect((await request(app).get("/api/vendors").set(authHeader(tokenB))).body.items).toHaveLength(0);

  const vendorA = (await request(app).get("/api/vendors").set(authHeader(tokenA))).body.items[0];
  expect((await request(app).patch(`/api/vendors/${vendorA.id}`).set(authHeader(tokenB)).send({ name: "X" })).status).toBe(404);

  const bVendor = await request(app).post("/api/vendors").set(authHeader(tokenB)).send({ name: "B Vendor" });
  const crossMerge = await request(app)
    .post(`/api/vendors/${vendorA.id}/merge`)
    .set(authHeader(tokenB))
    .send({ into_vendor_id: bVendor.body.id });
  expect(crossMerge.status).toBe(404);
});

test("an invoice keeps the vendor name the document actually carried", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedBill(token, org, { vendorName: "Acme Inc", invoiceNumber: "B-1" });
  const second = await makeApprovedBill(token, org, { vendorName: "Acme Incorporated", invoiceNumber: "B-2" });

  const vendors = (await request(app).get("/api/vendors").set(authHeader(token))).body.items;
  await request(app)
    .post(`/api/vendors/${vendors.find((v) => v.name === "Acme Incorporated").id}/merge`)
    .set(authHeader(token))
    .send({ into_vendor_id: vendors.find((v) => v.name === "Acme Inc").id });

  // Merging changes which vendor the bill belongs to, never what the
  // document said -- overwriting that would destroy the one thing an audit
  // needs to be able to check.
  await second.reload();
  expect(second.vendorName).toBe("Acme Incorporated");
  expect(await VendorAlias.count({ where: { orgId: org, rawVendorName: "acme incorporated" } })).toBe(1);
});

test("normalization folds formatting noise but never guesses at different names", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  // Case, repeated/surrounding whitespace, and trailing punctuation carry
  // no information, so these are one vendor without anyone merging them.
  await makeApprovedBill(token, org, { vendorName: "Acme Inc", invoiceNumber: "B-1" });
  await makeApprovedBill(token, org, { vendorName: "ACME INC.", invoiceNumber: "B-2" });
  await makeApprovedBill(token, org, { vendorName: "  acme   inc  ", invoiceNumber: "B-3" });
  expect((await request(app).get("/api/vendors").set(authHeader(token))).body.items).toHaveLength(1);

  // These might be a different company, so they stay separate until a
  // human says otherwise. A wrong automatic merge is invisible; a missing
  // one is one click.
  await makeApprovedBill(token, org, { vendorName: "Acme Incorporated", invoiceNumber: "B-4" });
  await makeApprovedBill(token, org, { vendorName: "Acme, Inc.", invoiceNumber: "B-5" });
  expect((await request(app).get("/api/vendors").set(authHeader(token))).body.items).toHaveLength(3);
});

test("the shared normalizer keeps aliases and expense-account memory in step", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const expenseAccount = await accountId(token, "Uncategorized Expense");

  // vendorExpenseAccount.js writes its key through the same normalizer
  // vendors.js resolves with, so a trailing period on one side and not the
  // other can't cause a miss.
  const { rememberVendorExpenseAccount, lookupVendorExpenseAccount } = await import("../src/vendorExpenseAccount.js");
  await rememberVendorExpenseAccount(org, "Acme Inc.", expenseAccount, "Uncategorized Expense");
  const found = await lookupVendorExpenseAccount(org, "  ACME INC  ");
  expect(found).not.toBeNull();
  expect(found.expenseAccountId).toBe(expenseAccount);
});

test("vendors can be created with early-payment discount terms, and they can be cleared", async () => {
  const token = await signup(app, request);
  const created = await request(app)
    .post("/api/vendors")
    .set(authHeader(token))
    .send({ name: "Discount Co", early_pay_discount_pct: 2, early_pay_discount_days: 10 });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ early_pay_discount_pct: 2, early_pay_discount_days: 10 });

  // Explicit null, not just omission, is what clears terms that no longer
  // apply -- omitting the key on a PATCH means "leave it alone".
  const cleared = await request(app)
    .patch(`/api/vendors/${created.body.id}`)
    .set(authHeader(token))
    .send({ early_pay_discount_pct: null, early_pay_discount_days: null });
  expect(cleared.body.early_pay_discount_pct).toBeNull();
  expect(cleared.body.early_pay_discount_days).toBeNull();
});

test("AP aging surfaces an early-payment discount still inside its window", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await request(app)
    .post("/api/vendors")
    .set(authHeader(token))
    .send({ name: "Acme Inc", early_pay_discount_pct: 2, early_pay_discount_days: 10 });
  await makeApprovedBill(token, org, { vendorName: "Acme Inc", total: 1000, invoiceDate: "2026-06-01", dueDate: "2026-07-01" });

  // Day 5 of a 10-day window, counted from the invoice date -- still open.
  const res = await request(app).get("/api/reports/ap-aging?as_of=2026-06-06").set(authHeader(token));
  expect(res.body.vendors[0].discount_available).toBe(20); // 2% of $1000
  expect(res.body.vendors[0].discount_deadline).toBe("2026-06-11");
  expect(res.body.totals.discount_available).toBe(20);
});

test("an early-payment discount disappears once its window has closed, even though the bill isn't due yet", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await request(app)
    .post("/api/vendors")
    .set(authHeader(token))
    .send({ name: "Acme Inc", early_pay_discount_pct: 2, early_pay_discount_days: 10 });
  await makeApprovedBill(token, org, { vendorName: "Acme Inc", total: 1000, invoiceDate: "2026-06-01", dueDate: "2026-07-01" });

  // Day 15 -- past the 10-day discount window, but the due date is still
  // two weeks out, so this bill is "current" in the aging bucket the whole
  // time its discount is available and after it's gone. The two are
  // deliberately independent.
  const res = await request(app).get("/api/reports/ap-aging?as_of=2026-06-16").set(authHeader(token));
  expect(res.body.vendors[0].discount_available).toBe(0);
  expect(res.body.vendors[0].discount_deadline).toBeNull();
  expect(res.body.totals.discount_available).toBe(0);
  expect(res.body.vendors[0].current).toBe(1000);
});

test("a vendor with no discount terms configured reports no discount available", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeApprovedBill(token, org, { vendorName: "No Discount LLC", total: 500, invoiceDate: "2026-06-01" });

  const res = await request(app).get("/api/reports/ap-aging?as_of=2026-06-02").set(authHeader(token));
  expect(res.body.vendors[0].discount_available).toBe(0);
  expect(res.body.vendors[0].discount_deadline).toBeNull();
  expect(res.body.totals.discount_available).toBe(0);
});
