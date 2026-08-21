import { score } from "../src/confidenceVendorDocs.js";

function makeResult(fieldConfidence) {
  return { method: "llm", fields: {}, fieldConfidence };
}

test("overall confidence is the weighted average across all fields", () => {
  const report = score(
    makeResult({
      vendor_name: 1,
      document_type: 1,
      effective_date: 1,
      expiration_date: 1,
      reference_number: 1,
      amount: 1,
    })
  );
  expect(report.overallConfidence).toBe(1);
});

// vendor_name/document_type apply to every document type and carry more
// weight than a field like amount, which only some document types even
// have (a W-9 has none) -- missing the vendor name should hurt the score
// more than missing the amount.
test("vendor_name is weighted more heavily than amount", () => {
  const missingVendorName = score(
    makeResult({ vendor_name: 0, document_type: 1, effective_date: 1, expiration_date: 1, reference_number: 1, amount: 1 })
  );
  const missingAmount = score(
    makeResult({ vendor_name: 1, document_type: 1, effective_date: 1, expiration_date: 1, reference_number: 1, amount: 0 })
  );
  expect(missingVendorName.overallConfidence).toBeLessThan(missingAmount.overallConfidence);
});

test("a missing field confidence counts as zero, not skipped", () => {
  const report = score(makeResult({ vendor_name: 1, document_type: 1 }));
  expect(report.overallConfidence).toBeLessThan(1);
});

test("all-zero confidence scores zero", () => {
  const report = score(
    makeResult({ vendor_name: 0, document_type: 0, effective_date: 0, expiration_date: 0, reference_number: 0, amount: 0 })
  );
  expect(report.overallConfidence).toBe(0);
});
