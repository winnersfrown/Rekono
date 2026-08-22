import request from "supertest";
import { findThreeWayMatch } from "../src/matching.js";
import { app } from "../src/app.js";
import { Invoice, MatchEntry, MatchResult, MatchSource } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

function entry(id, vendor, amount, entryDate, reference = "") {
  return { id, vendor, amount, entryDate, reference };
}

const PO = entry("po-1", "Acme Supplies Inc", 1000.0, "2026-01-05", "PO-100");
const RECEIPT = entry("rec-1", "Acme Supplies Inc", 1000.0, "2026-01-06", "PO-100");

// ---- engine ----

describe("findThreeWayMatch", () => {
  test("ordered, received, and billed consistently is a full match", () => {
    const outcome = findThreeWayMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "PO-100", [PO], [RECEIPT]);
    expect(outcome.threeWayOutcome).toBe("matched");
    expect(outcome.status).toBe("matched");
    expect(outcome.entryId).toBe("po-1");
    expect(outcome.receivingEntryId).toBe("rec-1");
  });

  // The case the whole feature exists for: the invoice reconciles perfectly
  // against its PO, so two-way matching would clear it for payment, but
  // nothing was ever recorded as delivered.
  test("billed and ordered but never received is flagged no_receipt, not matched", () => {
    const otherReceipt = entry("rec-2", "Unrelated Vendor LLC", 25.0, "2020-01-01");
    const outcome = findThreeWayMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "PO-100", [PO], [otherReceipt]);
    expect(outcome.threeWayOutcome).toBe("no_receipt");
    expect(outcome.status).toBe("partial");
    expect(outcome.receivingEntryId).toBeNull();
    expect(outcome.reasoning).toMatch(/do not pay/i);
  });

  test("received and billed with no purchase order is flagged no_po", () => {
    const otherPo = entry("po-2", "Unrelated Vendor LLC", 25.0, "2020-01-01");
    const outcome = findThreeWayMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "", [otherPo], [RECEIPT]);
    expect(outcome.threeWayOutcome).toBe("no_po");
    expect(outcome.status).toBe("partial");
    expect(outcome.receivingEntryId).toBe("rec-1");
    // The PO leg failed, so nothing should be recorded as the matched PO.
    expect(outcome.entryId).toBeNull();
    expect(outcome.reasoning).toMatch(/never authorized/i);
  });

  test("neither leg matching is unmatched", () => {
    const other = entry("x", "Totally Different Co", 5.0, "2019-01-01");
    const outcome = findThreeWayMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "", [other], [other]);
    expect(outcome.threeWayOutcome).toBe("unmatched");
    expect(outcome.status).toBe("unmatched");
  });

  test("an empty PO list is reported as no_po rather than crashing", () => {
    const outcome = findThreeWayMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "", [], [RECEIPT]);
    expect(outcome.threeWayOutcome).toBe("no_po");
    expect(outcome.reasoning).toMatch(/no purchase orders uploaded/i);
  });

  // A leg that only "partially" matches is not evidence the same
  // transaction is involved, so it must not satisfy that leg.
  test("a partial leg does not count as satisfied", () => {
    const wrongAmountReceipt = entry("rec-3", "Acme Supplies Inc", 12.0, "2026-01-06");
    const outcome = findThreeWayMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "PO-100", [PO], [wrongAmountReceipt]);
    expect(outcome.threeWayOutcome).toBe("no_receipt");
  });

  test("a missing leg drags the score below a clean full match", () => {
    const full = findThreeWayMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "PO-100", [PO], [RECEIPT]);
    const missing = findThreeWayMatch("Acme Supplies Inc", 1000.0, "2026-01-05", "PO-100", [PO], [
      entry("rec-x", "Nobody", 1.0, "2019-01-01"),
    ]);
    expect(missing.score).toBeLessThan(full.score);
  });
});

// ---- API ----

describe("POST /api/matching/run", () => {
  beforeEach(resetDb);

  async function orgId(token) {
    const res = await request(app).get("/api/auth/me").set(authHeader(token));
    return res.body.org_id;
  }

  async function makeInvoice(org) {
    return Invoice.create({
      orgId: org,
      originalFilename: "invoice.pdf",
      storagePath: "/tmp/x.pdf",
      contentType: "application/pdf",
      status: "extracted",
      vendorName: "Acme Supplies Inc",
      invoiceNumber: "INV-1",
      invoiceDate: "2026-01-05",
      poReference: "PO-100",
      total: 1000.0,
    });
  }

  async function addSource(org, sourceType, rows) {
    const source = await MatchSource.create({ orgId: org, name: `${sourceType}.csv`, sourceType });
    await MatchEntry.bulkCreate(rows.map((r) => ({ sourceId: source.id, ...r })));
    return source;
  }

  const ACME_ROW = { vendor: "Acme Supplies Inc", amount: 1000.0, entryDate: "2026-01-05", reference: "PO-100" };

  test("stays in two-way mode when no goods receipts are uploaded", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org);
    await addSource(org, "po", [ACME_ROW]);

    const res = await request(app).post("/api/matching/run").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("two_way");
    expect(res.body.three_way).toBeNull();
    expect(res.body.matched).toBe(1);

    const result = await MatchResult.findOne();
    expect(result.threeWayOutcome).toBeNull();
    expect(result.receivingEntryId).toBeNull();
  });

  test("switches to three-way as soon as goods receipts exist", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org);
    await addSource(org, "po", [ACME_ROW]);
    await addSource(org, "receiving", [{ ...ACME_ROW, entryDate: "2026-01-06" }]);

    const res = await request(app).post("/api/matching/run").set(authHeader(token));
    expect(res.body.mode).toBe("three_way");
    expect(res.body.three_way).toEqual({ matched: 1, no_receipt: 0, no_po: 0, unmatched: 0 });

    const result = await MatchResult.findOne();
    expect(result.threeWayOutcome).toBe("matched");
    expect(result.receivingEntryId).toBeTruthy();
  });

  test("an invoice matching its PO but with no receipt is not reported as matched", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org);
    await addSource(org, "po", [ACME_ROW]);
    await addSource(org, "receiving", [{ vendor: "Someone Else Ltd", amount: 9.99, entryDate: "2020-01-01", reference: "" }]);

    const res = await request(app).post("/api/matching/run").set(authHeader(token));
    expect(res.body.three_way.no_receipt).toBe(1);
    expect(res.body.three_way.matched).toBe(0);
    expect(res.body.matched).toBe(0);
  });

  // Bank entries evidence payment, not delivery -- they must not be able to
  // stand in for a goods receipt and silently clear the third leg.
  test("bank entries do not satisfy the goods-receipt leg", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org);
    await addSource(org, "po", [ACME_ROW]);
    await addSource(org, "bank", [ACME_ROW]);
    await addSource(org, "receiving", [{ vendor: "Nobody Inc", amount: 1.0, entryDate: "2019-01-01", reference: "" }]);

    const res = await request(app).post("/api/matching/run").set(authHeader(token));
    expect(res.body.three_way.no_receipt).toBe(1);
  });

  test("accepts a receiving CSV upload", async () => {
    const token = await signup(app, request);
    const csv = "vendor,amount,date,reference\nAcme Supplies Inc,1000.00,2026-01-06,PO-100\n";
    const res = await request(app)
      .post("/api/matching/sources?source_type=receiving")
      .set(authHeader(token))
      .attach("file", Buffer.from(csv), { filename: "receipts.csv", contentType: "text/csv" });

    expect(res.status).toBe(201);
    expect(res.body.source_type).toBe("receiving");
    expect(res.body.entry_count).toBe(1);
  });

  test("rejects an unknown source type", async () => {
    const token = await signup(app, request);
    const res = await request(app)
      .post("/api/matching/sources?source_type=nonsense")
      .set(authHeader(token))
      .attach("file", Buffer.from("vendor,amount\nA,1\n"), { filename: "x.csv", contentType: "text/csv" });
    expect(res.status).toBe(422);
  });
});
