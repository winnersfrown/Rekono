// The order a chart of accounts is read in (ledger.js's sortAccounts,
// GET /api/accounts).
//
// Two different rules, and the test that matters most is the one proving
// they are different: balance sheet accounts sort by liquidity, income
// statement accounts by the order they were created. A single rule applied
// to both would look right on a conventionally-numbered chart and be wrong
// the moment somebody numbered theirs differently.
import request from "supertest";
import { app } from "../src/app.js";
import { sortAccounts } from "../src/ledger.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const acct = (over) => ({ type: "asset", subtype: "", code: "", name: "", createdAt: null, ...over });
const names = (accounts) => sortAccounts(accounts).map((a) => a.name);

describe("balance sheet accounts sort by liquidity", () => {
  test("cash, then receivables, then everything else", () => {
    const accounts = [
      acct({ name: "Equipment", code: "1500" }),
      acct({ name: "Receivables", code: "1100", subtype: "accounts_receivable" }),
      acct({ name: "Cash", code: "1000", subtype: "bank" }),
    ];
    expect(names(accounts)).toEqual(["Cash", "Receivables", "Equipment"]);
  });

  // The point of ranking by subtype rather than by code: an org that
  // numbered its chart differently still gets a readable balance sheet.
  test("liquidity beats the code when an org numbers its chart its own way", () => {
    const accounts = [
      acct({ name: "Cash", code: "9000", subtype: "bank" }),
      acct({ name: "Equipment", code: "1000" }),
    ];
    expect(names(accounts)).toEqual(["Cash", "Equipment"]);
  });

  test("payables come before credit cards, which come before deferred revenue", () => {
    const accounts = [
      acct({ type: "liability", name: "Deferred Revenue", subtype: "deferred_revenue" }),
      acct({ type: "liability", name: "Credit Card", subtype: "credit_card" }),
      acct({ type: "liability", name: "Payables", subtype: "accounts_payable" }),
    ];
    expect(names(accounts)).toEqual(["Payables", "Credit Card", "Deferred Revenue"]);
  });

  test("codes compare numerically, so 900 sorts before 1100", () => {
    // A string compare puts "1100" before "900", which is how a chart of
    // accounts ends up looking shuffled.
    const accounts = [acct({ name: "Later", code: "1100" }), acct({ name: "Earlier", code: "900" })];
    expect(names(accounts)).toEqual(["Earlier", "Later"]);
  });

  test("an account with no code sorts after the ones that have codes", () => {
    const accounts = [acct({ name: "Ad hoc" }), acct({ name: "Structured", code: "1500" })];
    expect(names(accounts)).toEqual(["Structured", "Ad hoc"]);
  });
});

describe("income statement accounts sort by insertion order", () => {
  test("the order they were added, not the order they were numbered", () => {
    const accounts = [
      acct({ type: "expense", name: "Added second", code: "9999", createdAt: "2026-02-01T00:00:00Z" }),
      acct({ type: "expense", name: "Added first", code: "1111", createdAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(names(accounts)).toEqual(["Added first", "Added second"]);
  });

  test("cost of revenue leads, because the statement subtotals in that order", () => {
    const accounts = [
      acct({ type: "expense", name: "Rent", createdAt: "2026-01-01T00:00:00Z" }),
      acct({ type: "expense", name: "Cost of Revenue", subtype: "cost_of_revenue", createdAt: "2026-05-01T00:00:00Z" }),
    ];
    expect(names(accounts)).toEqual(["Cost of Revenue", "Rent"]);
  });

  test("income tax expense trails, for the same reason", () => {
    const accounts = [
      acct({ type: "expense", name: "Income Tax", subtype: "income_tax_expense", createdAt: "2026-01-01T00:00:00Z" }),
      acct({ type: "expense", name: "Rent", createdAt: "2026-05-01T00:00:00Z" }),
    ];
    expect(names(accounts)).toEqual(["Rent", "Income Tax"]);
  });

  // Same input, opposite expectation to the balance sheet case above. This
  // is the pair that proves the two rules are genuinely different.
  test("insertion order wins over the code, which is the opposite of an asset", () => {
    const asAssets = [
      acct({ type: "asset", name: "High code", code: "9999", createdAt: "2026-01-01T00:00:00Z" }),
      acct({ type: "asset", name: "Low code", code: "1111", createdAt: "2026-02-01T00:00:00Z" }),
    ];
    const asExpenses = asAssets.map((a) => ({ ...a, type: "expense" }));
    expect(names(asAssets)).toEqual(["Low code", "High code"]);
    expect(names(asExpenses)).toEqual(["High code", "Low code"]);
  });
});

describe("the whole chart", () => {
  test("groups by category in statement order", () => {
    const accounts = [
      acct({ type: "expense", name: "E" }),
      acct({ type: "revenue", name: "R" }),
      acct({ type: "equity", name: "Q" }),
      acct({ type: "liability", name: "L" }),
      acct({ type: "asset", name: "A" }),
    ];
    expect(names(accounts)).toEqual(["A", "L", "Q", "R", "E"]);
  });

  test("the API returns the seeded chart already in that order", async () => {
    const token = await signup(app, request);
    const res = await request(app).get("/api/accounts").set(authHeader(token));
    expect(res.status).toBe(200);

    const types = res.body.items.map((a) => a.type);
    // Each category appears as one contiguous run, so the UI can group by
    // walking the list rather than re-sorting it.
    const firstIndex = [...new Set(types)].map((t) => types.indexOf(t));
    expect(firstIndex).toEqual([...firstIndex].sort((x, y) => x - y));
    for (const t of new Set(types)) {
      expect(types.lastIndexOf(t) - types.indexOf(t) + 1).toBe(types.filter((x) => x === t).length);
    }

    // Cash is the first asset on any balance sheet.
    expect(res.body.items.find((a) => a.type === "asset").name).toBe("Cash");
    // Cost of Revenue leads the expenses, matching the income statement.
    expect(res.body.items.find((a) => a.type === "expense").name).toBe("Cost of Revenue");
  });
});
