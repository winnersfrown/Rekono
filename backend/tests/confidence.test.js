import { score } from "../src/confidence.js";

function makeResult(total, lineAmounts, fieldConfOverride = {}, subtotal = null, tax = null) {
  const fields = {
    total,
    subtotal,
    tax,
    vendor_name: "Acme",
    invoice_number: "1",
    invoice_date: "2026-01-01",
    due_date: "",
    po_reference: "",
    currency: "USD",
  };
  const fieldConfidence = {};
  for (const key of Object.keys(fields)) {
    if (key === "currency") continue;
    fieldConfidence[key] = 0.95;
  }
  fieldConfidence.currency = 0.95;
  Object.assign(fieldConfidence, fieldConfOverride);

  const lineItems = lineAmounts.map((amount) => ({ description: "item", amount, confidence: 0.9 }));
  return { method: "llm", fields, fieldConfidence, lineItems };
}

test("cross-check passes when line items sum to total", () => {
  const report = score(makeResult(100.0, [60.0, 40.0]));
  expect(report.crossCheckPassed).toBe(true);
  expect(report.overallConfidence).toBeGreaterThan(0.8);
});

test("cross-check fails when line items don't sum to total", () => {
  const report = score(makeResult(100.0, [60.0, 30.0]));
  expect(report.crossCheckPassed).toBe(false);
  expect(report.overallConfidence).toBeLessThanOrEqual(0.5);
});

test("cross-check uses subtotal plus tax when available", () => {
  const report = score(makeResult(110.0, [100.0], {}, 100.0, 10.0));
  expect(report.crossCheckPassed).toBe(true);
});

test("low field confidence still reduces overall even if cross-check passes", () => {
  const report = score(makeResult(100.0, [100.0], { vendor_name: 0.1 }));
  expect(report.overallConfidence).toBeLessThan(0.95);
});
