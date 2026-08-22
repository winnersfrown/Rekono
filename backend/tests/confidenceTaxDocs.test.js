import { score } from "../src/confidenceTaxDocs.js";

const ALL_FIELDS = [
  "document_type",
  "tax_year",
  "payer_name",
  "recipient_name",
  "recipient_tin_last4",
  "amount",
  "federal_tax_withheld",
];

function makeResult(fieldConfidence) {
  return { method: "llm", fields: {}, fieldConfidence };
}

function allAt(value, overrides = {}) {
  return makeResult({ ...Object.fromEntries(ALL_FIELDS.map((f) => [f, value])), ...overrides });
}

test("overall confidence is the weighted average across all fields", () => {
  expect(score(allAt(1)).overallConfidence).toBe(1);
});

test("all-zero confidence scores zero", () => {
  expect(score(allAt(0)).overallConfidence).toBe(0);
});

// document_type and tax_year decide which pile the form lands in, so
// missing one should hurt more than missing four digits a reviewer can
// confirm at a glance against the preview pane.
test("document_type is weighted more heavily than recipient_tin_last4", () => {
  const missingType = score(allAt(1, { document_type: 0 }));
  const missingTin = score(allAt(1, { recipient_tin_last4: 0 }));
  expect(missingType.overallConfidence).toBeLessThan(missingTin.overallConfidence);
});

test("tax_year is weighted more heavily than federal_tax_withheld", () => {
  const missingYear = score(allAt(1, { tax_year: 0 }));
  const missingWithheld = score(allAt(1, { federal_tax_withheld: 0 }));
  expect(missingYear.overallConfidence).toBeLessThan(missingWithheld.overallConfidence);
});

test("a missing field confidence counts as zero, not skipped", () => {
  const report = score(makeResult({ document_type: 1, tax_year: 1 }));
  expect(report.overallConfidence).toBeLessThan(1);
});
