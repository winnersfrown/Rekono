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
});
