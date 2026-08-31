import { extract } from "../src/extraction.js";

const SAMPLE_OCR_TEXT = `Acme Supplies Inc
123 Main St, Springfield

Invoice #: INV-2026-0007
Date: 01/15/2026
PO Number: PO-4421

Widget A  2  10.00  20.00
Widget B  1  30.00  30.00

Subtotal: $50.00
Tax: $4.00
Total Due: $54.00
`;

test("heuristic extraction used without api key", async () => {
  const result = await extract(SAMPLE_OCR_TEXT);

  expect(result.method).toBe("heuristic");
  expect(result.fields.invoice_number).toBe("INV-2026-0007");
  expect(result.fields.po_reference).toBe("PO-4421");
  expect(result.fields.total).toBe(54.0);
  expect(result.fields.subtotal).toBe(50.0);
  expect(result.fields.tax).toBe(4.0);
  expect(result.fields.invoice_date).toBe("2026-01-15");
  expect(result.lineItems).toHaveLength(2);
  expect(result.lineItems[0].amount).toBe(20.0);
  expect(result.possibleMultiInvoice).toBe(false);
});

test("heuristic extraction flags more than one distinct invoice number as a possible multi-invoice document", async () => {
  const twoInvoiceText = `${SAMPLE_OCR_TEXT}

  ----

  Beta Corp
  Invoice #: INV-2026-9999
  Date: 02/01/2026
  Total Due: $12.00
  `;

  const result = await extract(twoInvoiceText);

  expect(result.possibleMultiInvoice).toBe(true);
  expect(result.possibleMultiInvoiceReason).toMatch(/2 different invoice numbers/);
});

test("heuristic extraction does not flag a single invoice number repeated (e.g. header + footer)", async () => {
  const repeatedText = `${SAMPLE_OCR_TEXT}\nInvoice #: INV-2026-0007 (copy)`;
  const result = await extract(repeatedText);
  expect(result.possibleMultiInvoice).toBe(false);
});

// Regression coverage for a real invoice layout (verified against actual
// Tesseract output on a reproduction of it, not hand-written) that tripped
// up every one of these fields at once: a logo placeholder OCR'd as
// garbage text merged onto the title line ("INVOICE Loco"), no marker
// after the bare title before the real invoice number, a tax line where
// the rate percentage sits between the label and the actual dollar
// amount, a due date with no dedicated extraction at all, and a PO
// reference containing a "/" that got truncated.
const TITLED_INVOICE_TEXT = `INVOICE Loco
East Repair Inc.
1912 Harvest Lane
New York, NY 12210

INVOICE #    US-001
INVOICE DATE 11/02/2019
PO.#         2312/2019
DUE DATE     26/02/2019

1  Front and rear brake cables  10  100.00
2  New set of pedal arms         1   30.00

Subtotal      145.00
Sales Tax 6.25%  9.06
TOTAL         $154.06
`;

test("heuristic extraction skips a bare document-title line for vendor name", async () => {
  const result = await extract(TITLED_INVOICE_TEXT);
  expect(result.fields.vendor_name).toBe("East Repair Inc.");
});

test("heuristic extraction doesn't capture the page title as the invoice number", async () => {
  const result = await extract(TITLED_INVOICE_TEXT);
  expect(result.fields.invoice_number).toBe("US-001");
});

test("heuristic extraction finds the tax amount, not the tax rate percentage", async () => {
  const result = await extract(TITLED_INVOICE_TEXT);
  expect(result.fields.tax).toBe(9.06);
});

test("heuristic extraction skips a title line even when OCR merges garbage onto it", async () => {
  const result = await extract(TITLED_INVOICE_TEXT);
  expect(result.fields.vendor_name).toBe("East Repair Inc.");
});

test("heuristic extraction finds the due date, not just the invoice date", async () => {
  const result = await extract(TITLED_INVOICE_TEXT);
  expect(result.fields.due_date).toBe("2019-02-26");
});

test("heuristic extraction doesn't truncate a PO reference containing a slash", async () => {
  const result = await extract(TITLED_INVOICE_TEXT);
  expect(result.fields.po_reference).toBe("2312/2019");
});

// The label variants below all name a purchase order on real invoices. The
// pattern used to accept only a literal "PO"/"P.O.", so every one of these
// came back blank on a document that stated its PO plainly.
test.each([
  ["Purchase Order, spelled out", "Purchase Order: 4421", "4421"],
  ["Purchase Order with no punctuation", "Purchase Order 4421", "4421"],
  ["Order No.", "Order No. 4421", "4421"],
  ["Your Order #", "Your Order #: 5567", "5567"],
  ["Customer PO", "Customer PO: 88231", "88231"],
  ["Order Reference", "Order Reference: A-9910", "A-9910"],
])("heuristic extraction reads a PO reference labelled as %s", async (_label, line, expected) => {
  const result = await extract(`Acme Supplies Inc\n\nInvoice #: INV-1\n${line}\n\nTotal Due: $10.00\n`);
  expect(result.fields.po_reference).toBe(expected);
});

// The regression this pattern was rewritten for: every part after "PO" was
// optional, so the label matched the first two letters of any word starting
// "Po" and captured the rest of it. "Postage" on an invoice with no PO at
// all produced a po_reference of "stage".
test("heuristic extraction doesn't read a word beginning with 'po' as a PO reference", async () => {
  const result = await extract("Acme Supplies Inc\n\nInvoice #: INV-1\n\nPostage 12.00\nTotal Due: $62.00\n");
  expect(result.fields.po_reference).toBe("");
});

test("heuristic extraction doesn't take the word after a PO heading as the reference", async () => {
  const result = await extract("Acme Supplies Inc\n\nInvoice #: INV-1\n\nPurchase Order Terms\nTotal Due: $10.00\n");
  expect(result.fields.po_reference).toBe("");
});

// Same truncation the PO reference was already fixed for, on the other
// identifying number: "2026/0007" is a sequence/year format, and stopping
// at the slash leaves every invoice that vendor sent in 2026 sharing one
// number -- which duplicate detection then reads as a repeat submission.
test("heuristic extraction doesn't truncate an invoice number containing a slash", async () => {
  const result = await extract("Acme Supplies Inc\n\nInvoice No: 2026/0007\n\nTotal Due: $10.00\n");
  expect(result.fields.invoice_number).toBe("2026/0007");
});

test("heuristic extraction reads an invoice number labelled 'Invoice ID'", async () => {
  const result = await extract("Acme Supplies Inc\n\nInvoice ID: INV-2026-0042\n\nTotal Due: $10.00\n");
  expect(result.fields.invoice_number).toBe("INV-2026-0042");
});
