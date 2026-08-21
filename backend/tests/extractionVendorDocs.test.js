import { extract } from "../src/extractionVendorDocs.js";

const SAMPLE_COI_TEXT = `Certificate of Liability Insurance

Insured: Acme Contracting LLC
Policy Number: POL-88231
Effective Date: 08/01/2026
Expiration Date: 09/10/2026
Each Occurrence 1000000.00
`;

test("heuristic extraction used without api key", async () => {
  const result = await extract(SAMPLE_COI_TEXT);

  expect(result.method).toBe("heuristic");
  expect(result.fields.document_type).toBe("Certificate of Insurance");
  expect(result.fields.effective_date).toBe("2026-08-01");
  expect(result.fields.expiration_date).toBe("2026-09-10");
  expect(result.fields.reference_number).toBe("POL-88231");
  expect(result.fields.amount).toBe(1000000);
});

test("heuristic extraction skips a generic document-type header line for the vendor name", async () => {
  const text = `Form W-9\nAcme Hardware LLC\nEIN: 12-3456789\n`;
  const result = await extract(text);
  expect(result.fields.vendor_name).toBe("Acme Hardware LLC");
});

test("heuristic extraction identifies a W-9 and finds its EIN, with no expiration date", async () => {
  const text = `Form W-9\nRequest for Taxpayer Identification Number\nAcme Hardware LLC\nEIN: 12-3456789\n`;
  const result = await extract(text);
  expect(result.fields.document_type).toBe("W-9");
  expect(result.fields.reference_number).toBe("12-3456789");
  expect(result.fields.expiration_date).toBe("");
});

test("heuristic extraction identifies a contract by keyword", async () => {
  const text = `Service Agreement\nBetween Acme Corp and Vendor Co\nEffective Date: 01/15/2026\nExpiration Date: 01/15/2027\n`;
  const result = await extract(text);
  expect(result.fields.document_type).toBe("Contract");
  expect(result.fields.effective_date).toBe("2026-01-15");
  expect(result.fields.expiration_date).toBe("2027-01-15");
});

// Two dates with no "expir"/"effective" label at all -- the heuristic can't
// tell which is which, so it should not guess an expiration date out of
// thin air (a wrong guess here is worse than no guess -- it would silently
// mark something as expiring/expired that isn't). It falls back to the
// first date as a low-confidence effective date only.
test("heuristic extraction doesn't guess an expiration date from an unlabeled date", async () => {
  const text = `Some Vendor Inc\n01/01/2026\n`;
  const result = await extract(text);
  expect(result.fields.expiration_date).toBe("");
  expect(result.fields.effective_date).toBe("2026-01-01");
});

test("heuristic extraction leaves fields blank/null and low-confidence when nothing is found", async () => {
  const result = await extract("");
  expect(result.fields.vendor_name).toBe("");
  expect(result.fields.document_type).toBe("");
  expect(result.fields.expiration_date).toBe("");
  expect(result.fields.amount).toBeNull();
  expect(result.fieldConfidence.vendor_name).toBe(0);
});
