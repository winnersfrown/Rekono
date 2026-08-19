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

// Regression coverage for a real invoice layout that tripped up all three
// of these fields at once: a bare "INVOICE" title line (no vendor name, no
// invoice number marker after it) followed by a tax line where the rate
// percentage sits between the "Tax" label and the actual dollar amount.
const TITLED_INVOICE_TEXT = `INVOICE
East Repair Inc.
1912 Harvest Lane
New York, NY 12210

INVOICE #    US-001
INVOICE DATE 11/02/2019
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
