import { accountLast4, extract, redactMicr } from "../src/extractionChecks.js";

// A check as OCR usually renders it: the payee on its own line after the
// label, the courtesy amount with a dollar sign, and the MICR line at the
// bottom with the routing number first and the account number second.
const SAMPLE_CHECK_TEXT = `Northwind Consulting LLC
88 Harbor Road, Seattle WA

FIRST HARBOR BANK

Date: 03/14/2026                     Check No. 1042

Pay to the order of
Acme Supplies Inc                                    $ 1,250.00

One thousand two hundred fifty and 00/100 ------------------- DOLLARS

Memo: BILL-1

123456789  0001234567  1042
`;

test("heuristic extraction reads a check", async () => {
  const result = await extract(SAMPLE_CHECK_TEXT);

  expect(result.method).toBe("heuristic");
  expect(result.fields.payee_name).toBe("Acme Supplies Inc");
  expect(result.fields.check_number).toBe("1042");
  expect(result.fields.check_date).toBe("2026-03-14");
  expect(result.fields.amount).toBe(1250.0);
  expect(result.fields.memo).toBe("BILL-1");
});

// The account holder's name and address are printed above the payee on
// every check. Taking the first name on the page would make the payer the
// payee on every single document -- and pay the wrong company.
test("heuristic extraction takes the payee, not the account holder at the top", async () => {
  const result = await extract(SAMPLE_CHECK_TEXT);
  expect(result.fields.payee_name).not.toBe("Northwind Consulting LLC");
});

test("heuristic extraction reads a payee written on the same line as the label", async () => {
  const result = await extract("Pay to the order of: Globex Corporation\n\n$ 40.00\n");
  expect(result.fields.payee_name).toBe("Globex Corporation");
});

// The MICR line's account number is the last long run, so this is the one
// it should land on -- and only its last four digits should survive.
test("heuristic extraction keeps only the last four digits of the account number", async () => {
  const result = await extract(SAMPLE_CHECK_TEXT);
  expect(result.fields.account_last4).toBe("4567");
});

test("accountLast4 narrows a full account number and refuses one too short", () => {
  expect(accountLast4("0001234567")).toBe("4567");
  expect(accountLast4("1234-5678")).toBe("5678");
  expect(accountLast4("123")).toBe("");
  expect(accountLast4("")).toBe("");
  expect(accountLast4(null)).toBe("");
});

// The reason this module masks at all: without it the stored OCR text
// would be a second, unmasked copy of the routing/account pair that
// accountLast4 exists to avoid keeping -- and that pair is everything
// needed to draft an ACH debit against the account.
test("redactMicr masks the routing and account numbers but keeps the check number", () => {
  const redacted = redactMicr(SAMPLE_CHECK_TEXT);

  expect(redacted).not.toContain("123456789");
  expect(redacted).not.toContain("0001234567");
  expect(redacted).toContain("****6789");
  expect(redacted).toContain("****4567");
  // A check number is 3-5 digits, well under the 8-digit floor, so it
  // survives -- it's printed on the face of the check anyway and is the
  // reference a human reconciles by.
  expect(redacted).toContain("1042");
});

test("redactMicr leaves an amount alone", () => {
  expect(redactMicr("Total $ 1,250.00")).toBe("Total $ 1,250.00");
});

// A model that reports "I couldn't read it" through the schema's documented
// `0 if unknown` must not produce a check that proposes a $0.00 payment
// against a real bill.
test("an unreadable amount comes back null rather than zero", async () => {
  const result = await extract("Pay to the order of\nAcme Supplies Inc\n\nMemo: no amount here\n");
  expect(result.fields.amount).toBeNull();
});
