// The account category taxonomy (accountTaxonomy.js): a defined vocabulary
// of subtypes per account type, served to the picker via
// GET /api/accounts/subtypes and surfaced on every account as
// subtype_label/classification -- see CLAUDE.md's Account.js comment about
// this being the "later phase" that was deliberately left undone.
import request from "supertest";
import { app } from "../src/app.js";
import { accountClassification, subtypeLabel } from "../src/accountTaxonomy.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

describe("subtypeLabel / accountClassification", () => {
  test("a blank subtype reads as Uncategorized, classified as other", () => {
    expect(subtypeLabel("asset", "")).toBe("Uncategorized");
    expect(accountClassification("asset", "")).toBe("other");
  });

  test("a recognized subtype gets its label and classification", () => {
    expect(subtypeLabel("asset", "fixed_asset")).toBe("Fixed asset");
    expect(accountClassification("asset", "fixed_asset")).toBe("fixed");
    expect(subtypeLabel("liability", "accounts_payable")).toBe("Accounts payable");
    expect(accountClassification("liability", "accounts_payable")).toBe("current");
  });

  test("an unrecognized subtype falls back to the raw string rather than being rejected", () => {
    // equity.js and yearEndClose.js create subtypes on demand; an org that
    // typed something custom in before this taxonomy existed still needs a
    // label, not an error.
    expect(subtypeLabel("asset", "something_custom")).toBe("something_custom");
    expect(accountClassification("asset", "something_custom")).toBe("other");
  });

  test("equity/revenue/expense accounts never classify as current or fixed", () => {
    expect(accountClassification("equity", "common_stock")).toBe("other");
    expect(accountClassification("expense", "cost_of_revenue")).toBe("other");
  });
});

describe("GET /api/accounts/subtypes", () => {
  test("serves the taxonomy grouped by account type", async () => {
    const token = await signup(app, request);
    const res = await request(app).get("/api/accounts/subtypes").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.subtypes.asset).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "fixed_asset", classification: "fixed" })])
    );
    expect(res.body.subtypes.liability).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "accounts_payable", classification: "current" })])
    );
  });
});

describe("accounts carry their taxonomy label and classification", () => {
  test("the seeded Cash account reports its label and current classification", async () => {
    const token = await signup(app, request);
    const res = await request(app).get("/api/accounts").set(authHeader(token));
    const cash = res.body.items.find((a) => a.name === "Cash");
    expect(cash.subtype).toBe("bank");
    expect(cash.subtype_label).toBe("Cash & bank");
    expect(cash.classification).toBe("current");
  });

  test("creating an account with a fixed_asset subtype classifies it as fixed", async () => {
    const token = await signup(app, request);
    const created = await request(app)
      .post("/api/accounts")
      .set(authHeader(token))
      .send({ name: "Office Equipment", type: "asset", subtype: "fixed_asset" });
    expect(created.status).toBe(201);
    expect(created.body.subtype_label).toBe("Fixed asset");
    expect(created.body.classification).toBe("fixed");
  });

  test("PATCHing subtype re-classifies the account", async () => {
    const token = await signup(app, request);
    const created = await request(app)
      .post("/api/accounts")
      .set(authHeader(token))
      .send({ name: "Loan Receivable", type: "asset" });
    expect(created.body.classification).toBe("other");

    const patched = await request(app)
      .patch(`/api/accounts/${created.body.id}`)
      .set(authHeader(token))
      .send({ subtype: "current_asset" });
    expect(patched.status).toBe(200);
    expect(patched.body.subtype_label).toBe("Other current asset");
    expect(patched.body.classification).toBe("current");
  });
});
