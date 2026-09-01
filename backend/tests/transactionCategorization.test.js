import { normalizeMerchant } from "../src/transactionCategorization.js";

// Regression coverage for the Plaid bank-sync vendor field (routes/plaid.js):
// Plaid's own merchant_name enrichment simplified "Staples Advantage
// 800-3333330 MA" down to just "Staples", which scored far too low in
// fuzzy matching against an invoice's "Staples Advantage" vendor name
// (58/100, below the match threshold) despite the amount and date being
// exact. Routing the raw descriptor through this function instead keeps
// enough of the name intact to match well, while still stripping the
// reference-number/location noise that would otherwise sink the score.
test("normalizeMerchant keeps a multi-word brand name intact while stripping reference numbers", () => {
  const result = normalizeMerchant("Staples Advantage 800-3333330 MA");
  expect(result).toContain("staples advantage");
});

test("normalizeMerchant strips a processor prefix", () => {
  expect(normalizeMerchant("SQ *BLUE BOTTLE COFFEE")).toBe("blue bottle coffee");
});

test("normalizeMerchant collapses the same merchant across two different charges to one string", () => {
  const a = normalizeMerchant("SQ *BLUE BOTTLE COFFEE 1123 SAN FRANCISCO CA");
  const b = normalizeMerchant("BLUE BOTTLE COFFEE");
  expect(a).toBe(b);
});

test("normalizeMerchant returns an empty string for empty input rather than throwing", () => {
  expect(normalizeMerchant("")).toBe("");
  expect(normalizeMerchant(null)).toBe("");
  expect(normalizeMerchant(undefined)).toBe("");
});
