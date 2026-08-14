import { lookupVendorAlias, rememberVendorCorrection } from "../src/vendorAlias.js";
import { applyVendorAlias } from "../src/pipeline.js";
import { resetDb } from "./testUtils.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(resetDb);

test("rememberVendorCorrection stores a lookup-able alias", async () => {
  await rememberVendorCorrection(ORG_ID, "ACME SUPPLYS INC", "Acme Supplies Inc.");

  const alias = await lookupVendorAlias(ORG_ID, "  acme supplys inc  ");
  expect(alias.canonicalVendorName).toBe("Acme Supplies Inc.");
});

test("rememberVendorCorrection ignores a blank original value", async () => {
  await rememberVendorCorrection(ORG_ID, "", "Acme Supplies Inc.");
  expect(await lookupVendorAlias(ORG_ID, "")).toBeNull();
});

test("rememberVendorCorrection updates an existing alias on a later, different correction", async () => {
  await rememberVendorCorrection(ORG_ID, "ACME SUPPLYS INC", "Acme Supplies Inc.");
  await rememberVendorCorrection(ORG_ID, "ACME SUPPLYS INC", "Acme Supplies LLC");

  const alias = await lookupVendorAlias(ORG_ID, "acme supplys inc");
  expect(alias.canonicalVendorName).toBe("Acme Supplies LLC");
});

test("lookupVendorAlias never crosses organizations", async () => {
  await rememberVendorCorrection(ORG_ID, "ACME SUPPLYS INC", "Acme Supplies Inc.");
  expect(await lookupVendorAlias("22222222-2222-2222-2222-222222222222", "ACME SUPPLYS INC")).toBeNull();
});

test("applyVendorAlias rewrites the field and boosts confidence on a known alias", async () => {
  await rememberVendorCorrection(ORG_ID, "ACME SUPPLYS INC", "Acme Supplies Inc.");

  const result = {
    fields: { vendor_name: "ACME SUPPLYS INC" },
    fieldConfidence: { vendor_name: 0.4 },
  };
  await applyVendorAlias(ORG_ID, result);

  expect(result.fields.vendor_name).toBe("Acme Supplies Inc.");
  expect(result.fieldConfidence.vendor_name).toBe(0.95);
});

test("applyVendorAlias leaves an unrecognized vendor name untouched", async () => {
  const result = {
    fields: { vendor_name: "Some Other Vendor" },
    fieldConfidence: { vendor_name: 0.4 },
  };
  await applyVendorAlias(ORG_ID, result);

  expect(result.fields.vendor_name).toBe("Some Other Vendor");
  expect(result.fieldConfidence.vendor_name).toBe(0.4);
});
