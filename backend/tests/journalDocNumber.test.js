// "Doc #" and "Post ref." on journal entries -- the paper-trail columns a
// manual ledger carries (routes/journalEntries.js, serializers.js). A doc
// number is optional free text (a check, invoice, or receipt number); a
// post ref is the destination account's code, since a real-time ledger
// posts instantly instead of by hand.
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

test("a manual entry carries the doc number it was posted with", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const expense = await accountId(token, "Uncategorized Expense");

  const res = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({
      entry_date: "2026-01-05",
      memo: "Office supplies",
      doc_number: "MEMO-42",
      lines: [
        { account_id: expense, debit: 10 },
        { account_id: cash, credit: 10 },
      ],
    });
  expect(res.status).toBe(201);
  expect(res.body.doc_number).toBe("MEMO-42");

  const list = await request(app).get("/api/journal-entries").set(authHeader(token));
  const item = list.body.items.find((e) => e.id === res.body.id);
  expect(item.doc_number).toBe("MEMO-42");
});

test("a manual entry with no doc number reports one as an empty string, not missing", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const expense = await accountId(token, "Uncategorized Expense");

  const res = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: "2026-01-05", lines: [{ account_id: expense, debit: 10 }, { account_id: cash, credit: 10 }] });
  expect(res.status).toBe(201);
  expect(res.body.doc_number).toBe("");
});

test("each line reports the destination account's code as its post ref", async () => {
  const token = await signup(app, request);
  const cash = await accountId(token, "Cash");
  const expense = await accountId(token, "Uncategorized Expense");

  const created = await request(app)
    .post("/api/journal-entries")
    .set(authHeader(token))
    .send({ entry_date: "2026-01-05", lines: [{ account_id: expense, debit: 10 }, { account_id: cash, credit: 10 }] });

  const detail = await request(app).get(`/api/journal-entries/${created.body.id}`).set(authHeader(token));
  expect(detail.status).toBe(200);
  const cashLine = detail.body.lines.find((l) => l.account_id === cash);
  const expenseLine = detail.body.lines.find((l) => l.account_id === expense);
  expect(cashLine.post_ref).toBe("1000");
  expect(expenseLine.post_ref).toBe("5900");
});

test("an approved bill's journal entry carries the vendor invoice number as its doc number", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);

  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-9001",
    total: 250,
    overallConfidence: 0.95,
  });
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));

  const list = await request(app).get("/api/journal-entries?journal=purchases").set(authHeader(token));
  expect(list.body.items.some((e) => e.doc_number === "INV-9001")).toBe(true);
});

test("a written check's journal entry carries the check number as its doc number", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const cash = await accountId(token, "Cash");

  const invoice = await Invoice.create({
    orgId: org,
    originalFilename: "bill.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-9002",
    total: 300,
    overallConfidence: 0.95,
  });
  await request(app).post(`/api/invoices/${invoice.id}/approve`).set(authHeader(token));

  const check = await request(app)
    .post("/api/written-checks")
    .set(authHeader(token))
    .send({
      invoice_id: invoice.id,
      check_number: "1042",
      payee_name: "Acme Supplies Inc",
      check_date: "2026-01-20",
      amount: 300,
      payment_account_id: cash,
    });
  expect(check.status).toBe(201);

  const list = await request(app).get("/api/journal-entries?journal=cash_payments").set(authHeader(token));
  expect(list.body.items.some((e) => e.doc_number === "1042")).toBe(true);
});
