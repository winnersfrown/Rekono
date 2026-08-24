import { lookupVendorExpenseAccount, rememberVendorExpenseAccount } from "../src/vendorExpenseAccount.js";
import { resetDb } from "./testUtils.js";

const ORG_ID = "11111111111111111111111111111111";

beforeEach(resetDb);

test("rememberVendorExpenseAccount stores a lookup-able account", async () => {
  await rememberVendorExpenseAccount(ORG_ID, "AMAZON WEB SERVICES", "42", "Software & Subscriptions");

  const entry = await lookupVendorExpenseAccount(ORG_ID, "  amazon web services  ");
  expect(entry.expenseAccountId).toBe("42");
  expect(entry.expenseAccountName).toBe("Software & Subscriptions");
});

test("rememberVendorExpenseAccount ignores a blank vendor name or account id", async () => {
  await rememberVendorExpenseAccount(ORG_ID, "", "42", "Software & Subscriptions");
  await rememberVendorExpenseAccount(ORG_ID, "AWS", "", "Software & Subscriptions");
  expect(await lookupVendorExpenseAccount(ORG_ID, "AWS")).toBeNull();
});

test("rememberVendorExpenseAccount updates an existing entry on a later, different correction", async () => {
  await rememberVendorExpenseAccount(ORG_ID, "AWS", "42", "Software & Subscriptions");
  await rememberVendorExpenseAccount(ORG_ID, "AWS", "77", "Cloud Hosting");

  const entry = await lookupVendorExpenseAccount(ORG_ID, "aws");
  expect(entry.expenseAccountId).toBe("77");
  expect(entry.expenseAccountName).toBe("Cloud Hosting");
});

test("lookupVendorExpenseAccount never crosses organizations", async () => {
  await rememberVendorExpenseAccount(ORG_ID, "AWS", "42", "Software & Subscriptions");
  expect(await lookupVendorExpenseAccount("22222222222222222222222222222222", "AWS")).toBeNull();
});
