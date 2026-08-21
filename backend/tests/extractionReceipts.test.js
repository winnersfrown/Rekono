import { extract } from "../src/extractionReceipts.js";

const SAMPLE_RECEIPT_TEXT = `Blue Bottle Coffee
123 Market St

Date: 08/15/2026

Latte           4.50
Tax             0.45
Total           4.95
`;

test("heuristic extraction used without api key", async () => {
  const result = await extract(SAMPLE_RECEIPT_TEXT);

  expect(result.method).toBe("heuristic");
  expect(result.fields.merchant_name).toBe("Blue Bottle Coffee");
  expect(result.fields.receipt_date).toBe("2026-08-15");
  expect(result.fields.tax).toBe(0.45);
  expect(result.fields.amount).toBe(4.95);
  expect(result.fields.category).toBe("Meals & Entertainment");
  expect(result.fields.currency).toBe("USD");
});

test("heuristic extraction skips a generic receipt/invoice header line for the merchant name", async () => {
  const text = `Receipt\nAcme Hardware\nDate: 2026-01-05\nTotal: $19.99\n`;
  const result = await extract(text);
  expect(result.fields.merchant_name).toBe("Acme Hardware");
});

test("heuristic extraction finds the total, not the subtotal", async () => {
  const text = `Staples\nDate: 2026-02-01\nSubtotal: 18.00\nTotal: 19.44\n`;
  const result = await extract(text);
  expect(result.fields.amount).toBe(19.44);
});

test("heuristic extraction guesses category from merchant keywords", async () => {
  const travel = await extract("United Airlines\nDate: 2026-03-01\nTotal: 412.00\n");
  expect(travel.fields.category).toBe("Travel");

  const office = await extract("Staples\nDate: 2026-03-01\nTotal: 22.50\n");
  expect(office.fields.category).toBe("Office Supplies");
});

test("heuristic extraction leaves category blank when nothing matches", async () => {
  const result = await extract("Some Obscure Shop\nDate: 2026-03-01\nTotal: 5.00\n");
  expect(result.fields.category).toBe("");
});

test("heuristic extraction leaves fields blank/null and low-confidence when nothing is found", async () => {
  const result = await extract("");
  expect(result.fields.merchant_name).toBe("");
  expect(result.fields.receipt_date).toBe("");
  expect(result.fields.amount).toBeNull();
  expect(result.fields.tax).toBeNull();
  expect(result.fieldConfidence.merchant_name).toBe(0);
});
