import { extract, redactTins, tinLast4 } from "../src/extractionTaxDocs.js";

// No GEMINI_API_KEY in the test env, so extract() takes the heuristic path
// -- same arrangement as extractionLeases.test.js.

const lastYear = new Date().getUTCFullYear() - 1;

const NEC_TEXT = `
Form 1099-NEC
Nonemployee Compensation
For calendar year ${lastYear}

PAYER'S name, street address, city or town, state, ZIP
Brightline Systems Inc.
100 Innovation Way, Austin, TX 78701

RECIPIENT'S name
Northwind Consulting LLC

RECIPIENT'S TIN
123-45-6789

1 Nonemployee compensation
$84,250.00

4 Federal income tax withheld
$0.00
`;

test("classifies the form, year, parties and amounts from a 1099-NEC", async () => {
  const result = await extract(NEC_TEXT);
  expect(result.method).toBe("heuristic");
  expect(result.fields.document_type).toBe("1099-NEC");
  expect(result.fields.tax_year).toBe(lastYear);
  expect(result.fields.payer_name).toBe("Brightline Systems Inc.");
  expect(result.fields.recipient_name).toBe("Northwind Consulting LLC");
  expect(result.fields.amount).toBe(84250);
  expect(result.fields.federal_tax_withheld).toBe(0);
});

test("keeps only the last four digits of the recipient TIN", async () => {
  const result = await extract(NEC_TEXT);
  expect(result.fields.recipient_tin_last4).toBe("6789");
  // The whole point: nothing anywhere in the extracted fields carries the
  // full number.
  expect(JSON.stringify(result.fields)).not.toContain("123-45-6789");
});

test("picks the recipient's TIN rather than the payer's when both are present", async () => {
  const twoTins = `
Form 1099-MISC
PAYER'S TIN
82-1234567
RECIPIENT'S TIN
123-45-6789
`;
  const result = await extract(twoTins);
  expect(result.fields.recipient_tin_last4).toBe("6789");
});

test("leaves the TIN blank rather than guessing when two are present and neither is labeled", async () => {
  const ambiguous = `
Form 1099-MISC
82-1234567
123-45-6789
`;
  const result = await extract(ambiguous);
  expect(result.fields.recipient_tin_last4).toBe("");
});

test("falls back to a single unlabeled TIN when the page shows exactly one", async () => {
  const result = await extract("Form W-2\nSome Employer Co\n123-45-6789\n");
  expect(result.fields.recipient_tin_last4).toBe("6789");
});

// Tesseract renders the apostrophe the IRS prints as a curly ’, so a
// pattern that only accepts a straight ' loses the payer/recipient labels
// on every real scan -- verified against actual OCR output, not guessed.
test("reads possessive labels whichever apostrophe OCR produced", async () => {
  for (const apostrophe of ["'", "’", "ʼ", ""]) {
    const text = [
      "Form 1099-NEC",
      `PAYER${apostrophe}S name`,
      "Brightline Systems Inc.",
      `RECIPIENT${apostrophe}S name`,
      "Northwind Consulting LLC",
      `RECIPIENT${apostrophe}S TIN`,
      "123-45-6789",
    ].join("\n");
    const result = await extract(text);
    expect(result.fields.payer_name).toBe("Brightline Systems Inc.");
    expect(result.fields.recipient_name).toBe("Northwind Consulting LLC");
    expect(result.fields.recipient_tin_last4).toBe("6789");
  }
});

test("recognizes the other supported form types", async () => {
  const cases = [
    ["Form W-2 Wage and Tax Statement", "W-2"],
    ["Form 1099-K Payment Card Transactions", "1099-K"],
    ["Form 1099-INT Interest Income", "1099-INT"],
    ["Form 1098 Mortgage Interest Statement", "1098"],
    ["Schedule K-1 (Form 1065)", "K-1"],
  ];
  for (const [text, expected] of cases) {
    const result = await extract(text);
    expect(result.fields.document_type).toBe(expected);
  }
});

test("an unrecognized form is 'Other' at zero confidence rather than a confident guess", async () => {
  const result = await extract("SOME UNRELATED DOCUMENT\nno form number here\n");
  expect(result.fields.document_type).toBe("Other");
  expect(result.fieldConfidence.document_type).toBe(0);
});

test("rejects an implausible tax year rather than storing an OCR misread", async () => {
  const result = await extract("Form 1099-NEC\nFor calendar year 9142\n");
  expect(result.fields.tax_year).toBeNull();
});

test("prefers a labeled tax year over other four-digit numbers on the page", async () => {
  const result = await extract(`Form 1099-NEC\nOMB No. 1545-0116\nSuite 2200\nFor calendar year ${lastYear}\n`);
  expect(result.fields.tax_year).toBe(lastYear);
});

test("does not invent an amount when no recognized box label is present", async () => {
  const result = await extract("Form 1099-NEC\nSome Payer Co\n$4,000.00 written with no label\n");
  expect(result.fields.amount).toBeNull();
});

describe("tinLast4", () => {
  test("narrows every identifier shape to four digits", () => {
    expect(tinLast4("123-45-6789")).toBe("6789");
    expect(tinLast4("82-1234567")).toBe("4567");
    expect(tinLast4("123456789")).toBe("6789");
    expect(tinLast4("***-**-6789")).toBe("6789");
    expect(tinLast4("6789")).toBe("6789");
  });

  test("returns empty rather than a partial for anything shorter than four digits", () => {
    expect(tinLast4("789")).toBe("");
    expect(tinLast4("")).toBe("");
    expect(tinLast4(null)).toBe("");
    expect(tinLast4(undefined)).toBe("");
  });
});

describe("redactTins", () => {
  test("masks every full identifier in a block of OCR text", () => {
    const redacted = redactTins("PAYER'S TIN 82-1234567 RECIPIENT'S TIN 123-45-6789");
    expect(redacted).not.toContain("123-45-6789");
    expect(redacted).not.toContain("82-1234567");
    expect(redacted).toContain("***-**-6789");
    expect(redacted).toContain("***-**-4567");
  });

  test("masks a bare nine-digit run too", () => {
    expect(redactTins("SSN 123456789 on file")).toBe("SSN ***-**-6789 on file");
  });

  test("leaves dollar amounts and ordinary text alone", () => {
    const text = "1 Nonemployee compensation $84,250.00";
    expect(redactTins(text)).toBe(text);
  });

  test("handles empty input", () => {
    expect(redactTins("")).toBe("");
    expect(redactTins(null)).toBe("");
  });
});
