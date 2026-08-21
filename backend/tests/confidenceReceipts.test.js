import { score } from "../src/confidenceReceipts.js";

function makeResult(fieldConfidence) {
  return { method: "llm", fields: {}, fieldConfidence };
}

test("overall confidence is the weighted average across all fields", () => {
  const report = score(
    makeResult({ merchant_name: 1, receipt_date: 1, category: 1, amount: 1, tax: 1 })
  );
  expect(report.overallConfidence).toBe(1);
});

test("amount is weighted more heavily than category or tax", () => {
  const lowAmount = score(
    makeResult({ merchant_name: 1, receipt_date: 1, category: 1, amount: 0, tax: 1 })
  );
  const lowCategory = score(
    makeResult({ merchant_name: 1, receipt_date: 1, category: 0, amount: 1, tax: 1 })
  );
  expect(lowAmount.overallConfidence).toBeLessThan(lowCategory.overallConfidence);
});

test("a missing field confidence counts as zero, not skipped", () => {
  const report = score(makeResult({ merchant_name: 1, receipt_date: 1, amount: 1 }));
  expect(report.overallConfidence).toBeLessThan(1);
});

test("all-zero confidence scores zero", () => {
  const report = score(
    makeResult({ merchant_name: 0, receipt_date: 0, category: 0, amount: 0, tax: 0 })
  );
  expect(report.overallConfidence).toBe(0);
});
