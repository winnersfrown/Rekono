import { score } from "../src/confidenceLeases.js";

function makeResult(fieldConfidence) {
  return { method: "llm", fields: {}, fieldConfidence };
}

test("overall confidence is the weighted average across all fields", () => {
  const report = score(
    makeResult({
      landlord_name: 1,
      property_address: 1,
      commencement_date: 1,
      expiration_date: 1,
      renewal_notice_deadline: 1,
      monthly_rent: 1,
      annual_escalation_pct: 1,
    })
  );
  expect(report.overallConfidence).toBe(1);
});

// landlord_name/property_address identify which lease this even is, so
// missing one of them should hurt the score more than missing a numeric
// rent detail a human reviews closely anyway.
test("landlord_name is weighted more heavily than annual_escalation_pct", () => {
  const missingLandlord = score(
    makeResult({
      landlord_name: 0,
      property_address: 1,
      commencement_date: 1,
      expiration_date: 1,
      renewal_notice_deadline: 1,
      monthly_rent: 1,
      annual_escalation_pct: 1,
    })
  );
  const missingEscalation = score(
    makeResult({
      landlord_name: 1,
      property_address: 1,
      commencement_date: 1,
      expiration_date: 1,
      renewal_notice_deadline: 1,
      monthly_rent: 1,
      annual_escalation_pct: 0,
    })
  );
  expect(missingLandlord.overallConfidence).toBeLessThan(missingEscalation.overallConfidence);
});

test("a missing field confidence counts as zero, not skipped", () => {
  const report = score(makeResult({ landlord_name: 1, property_address: 1 }));
  expect(report.overallConfidence).toBeLessThan(1);
});

test("all-zero confidence scores zero", () => {
  const report = score(
    makeResult({
      landlord_name: 0,
      property_address: 0,
      commencement_date: 0,
      expiration_date: 0,
      renewal_notice_deadline: 0,
      monthly_rent: 0,
      annual_escalation_pct: 0,
    })
  );
  expect(report.overallConfidence).toBe(0);
});
