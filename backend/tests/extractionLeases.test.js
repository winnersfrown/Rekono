import { extract } from "../src/extractionLeases.js";

const SAMPLE_LEASE_TEXT = `Commercial Lease Agreement

Landlord: Meridian Properties LLC
Premises: 500 Harbor Way, Suite 12, Oakland, CA
Commencement Date: 01/01/2020
Expiration Date: 10/15/2026
Renewal Notice Deadline: 09/15/2026
Monthly Rent: 5000.00
Annual Escalation: 3%
`;

test("heuristic extraction used without api key", async () => {
  const result = await extract(SAMPLE_LEASE_TEXT);

  expect(result.method).toBe("heuristic");
  expect(result.fields.property_address).toBe("500 Harbor Way, Suite 12, Oakland, CA");
  expect(result.fields.commencement_date).toBe("2020-01-01");
  expect(result.fields.expiration_date).toBe("2026-10-15");
  expect(result.fields.renewal_notice_deadline).toBe("2026-09-15");
  expect(result.fields.monthly_rent).toBe(5000);
  expect(result.fields.annual_escalation_pct).toBe(3);
});

test("heuristic extraction skips a generic document-title header line for the landlord name", async () => {
  const text = `Lease Agreement\nAcme Holdings LLC\nPremises: 1 Main St\n`;
  const result = await extract(text);
  expect(result.fields.landlord_name).toBe("Acme Holdings LLC");
});

test("heuristic extraction reads the property address from the line after the label if there's nothing after the colon", async () => {
  const text = `Lease\nAcme Holdings LLC\nPremises:\n742 Evergreen Terrace\n`;
  const result = await extract(text);
  expect(result.fields.property_address).toBe("742 Evergreen Terrace");
});

// Three dates with no label at all -- the heuristic can't tell which is
// which, so it should not guess an expiration or renewal-notice date out
// of thin air (a wrong guess here is worse than none -- it would silently
// flag a lease as expiring/expired that isn't). It falls back to the first
// date as a low-confidence commencement date only.
test("heuristic extraction doesn't guess expiration or renewal-notice dates from unlabeled dates", async () => {
  const text = `Some Landlord LLC\n01/01/2026\n`;
  const result = await extract(text);
  expect(result.fields.expiration_date).toBe("");
  expect(result.fields.renewal_notice_deadline).toBe("");
  expect(result.fields.commencement_date).toBe("2026-01-01");
});

test("heuristic extraction leaves fields blank/null and low-confidence when nothing is found", async () => {
  const result = await extract("");
  expect(result.fields.landlord_name).toBe("");
  expect(result.fields.property_address).toBe("");
  expect(result.fields.expiration_date).toBe("");
  expect(result.fields.monthly_rent).toBeNull();
  expect(result.fields.annual_escalation_pct).toBeNull();
  expect(result.fieldConfidence.landlord_name).toBe(0);
});
