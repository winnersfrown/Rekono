import request from "supertest";
import { app } from "../src/app.js";
import { categorizeMerchants, guessCategoryHeuristic, normalizeMerchant } from "../src/transactionCategorization.js";
import { MerchantCategory, Transaction } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

// No GEMINI_API_KEY in the test env (see tests/jest.setup.js), so
// categorization exercises the learned + heuristic tiers -- which is also
// exactly what a self-hosted deployment without a key gets.

beforeEach(resetDb);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

function csv(rows, header = "date,description,amount") {
  return `${header}\n${rows.join("\n")}\n`;
}

async function upload(token, body, filename = "statement.csv") {
  return request(app)
    .post("/api/transactions/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from(body), { filename, contentType: "text/csv" });
}

describe("normalizeMerchant", () => {
  // The whole learned-category mechanism depends on these collapsing to the
  // same key -- if they don't, a human's correction never applies to the
  // next charge from the same merchant and the feature quietly does nothing.
  test("collapses card-descriptor noise to a stable merchant key", () => {
    const key = normalizeMerchant("BLUE BOTTLE COFFEE");
    expect(normalizeMerchant("SQ *BLUE BOTTLE COFFEE")).toBe(key);
    expect(normalizeMerchant("SQ *BLUE BOTTLE COFFEE 12345")).toBe(key);
    expect(normalizeMerchant("TST* BLUE BOTTLE COFFEE")).toBe(key);
  });

  test("drops a trailing city/state so one chain is one merchant", () => {
    expect(normalizeMerchant("STARBUCKS SAN FRANCISCO CA")).toBe(normalizeMerchant("STARBUCKS AUSTIN TX"));
  });

  test("drops per-charge store numbers and dates", () => {
    expect(normalizeMerchant("STARBUCKS STORE 04521")).toBe(normalizeMerchant("STARBUCKS STORE 09876"));
    expect(normalizeMerchant("SHELL OIL 03/14")).toBe(normalizeMerchant("SHELL OIL 07/22"));
  });

  test("keeps genuinely different merchants distinct", () => {
    expect(normalizeMerchant("BLUE BOTTLE COFFEE")).not.toBe(normalizeMerchant("PEETS COFFEE"));
  });

  test("survives empty and junk input", () => {
    expect(normalizeMerchant("")).toBe("");
    expect(normalizeMerchant(null)).toBe("");
    expect(normalizeMerchant("*** 12345 ***")).toBe("");
  });
});

describe("guessCategoryHeuristic", () => {
  test("routes recognizable merchants", () => {
    expect(guessCategoryHeuristic("united airlines")).toBe("Travel");
    expect(guessCategoryHeuristic("blue bottle coffee")).toBe("Meals & Entertainment");
    expect(guessCategoryHeuristic("adobe subscription")).toBe("Software & Subscriptions");
  });

  test("returns nothing rather than guessing for an unrecognizable merchant", () => {
    expect(guessCategoryHeuristic("zzzq holdings llc")).toBe("");
  });
});

describe("categorizeMerchants", () => {
  test("prefers a learned mapping over the heuristic", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    // "coffee" would otherwise heuristic to Meals & Entertainment.
    await MerchantCategory.create({ orgId: org, merchantKey: "blue bottle coffee", category: "Office Supplies" });

    const resolved = await categorizeMerchants(org, ["blue bottle coffee"]);
    expect(resolved.get("blue bottle coffee")).toMatchObject({ category: "Office Supplies", source: "learned" });
  });

  test("leaves a merchant nothing can place uncategorized rather than guessing", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const resolved = await categorizeMerchants(org, ["zzzq holdings llc"]);
    expect(resolved.has("zzzq holdings llc")).toBe(false);
  });

  test("never reads another org's learned mappings", async () => {
    const mine = await signup(app, request, { email: "mine@example.co" });
    const theirs = await signup(app, request, { email: "theirs@example.co", orgName: "Other Co" });
    await MerchantCategory.create({ orgId: await orgId(theirs), merchantKey: "zzzq holdings llc", category: "Travel" });

    const resolved = await categorizeMerchants(await orgId(mine), ["zzzq holdings llc"]);
    expect(resolved.has("zzzq holdings llc")).toBe(false);
  });
});

describe("upload", () => {
  test("imports and categorizes a statement", async () => {
    const token = await signup(app, request);
    const res = await upload(
      token,
      csv([
        "2026-03-01,SQ *BLUE BOTTLE COFFEE 123,-8.50",
        "2026-03-02,UNITED AIRLINES,-420.00",
        "2026-03-03,ZZZQ HOLDINGS LLC,-99.00",
      ])
    );

    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(3);
    expect(res.body.distinct_merchants).toBe(3);
    expect(res.body.by_source.heuristic).toBe(2);
    expect(res.body.by_source.uncategorized).toBe(1);

    const list = await request(app).get("/api/transactions").set(authHeader(token));
    const byDescription = Object.fromEntries(list.body.items.map((t) => [t.description, t]));
    expect(byDescription["UNITED AIRLINES"].category).toBe("Travel");
    expect(byDescription["ZZZQ HOLDINGS LLC"].category).toBe("");
  });

  test("twenty charges from one merchant are one categorization question", async () => {
    const token = await signup(app, request);
    const rows = Array.from({ length: 20 }, (_, i) => `2026-03-${String(i + 1).padStart(2, "0")},STARBUCKS STORE 0${i},-5.00`);
    const res = await upload(token, csv(rows));

    expect(res.body.imported).toBe(20);
    // The point of normalizing before categorizing: one merchant, not 20.
    expect(res.body.distinct_merchants).toBe(1);
  });

  test("accepts alternative bank column names and parenthesised debits", async () => {
    const token = await signup(app, request);
    const res = await upload(token, csv(["03/14/2026,UNITED AIRLINES,(420.00)"], "Post Date,Payee,Debit"));
    expect(res.status).toBe(201);

    const list = await request(app).get("/api/transactions").set(authHeader(token));
    expect(list.body.items[0].amount).toBe(-420);
    expect(list.body.items[0].posted_date).toBe("2026-03-14");
  });

  test("rejects a CSV with no usable columns", async () => {
    const token = await signup(app, request);
    const res = await upload(token, csv(["a,b"], "foo,bar"));
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/description\/merchant/i);
  });

  test("rejects a file with no upload", async () => {
    const token = await signup(app, request);
    const res = await request(app).post("/api/transactions/upload").set(authHeader(token));
    expect(res.status).toBe(422);
  });
});

describe("categorizing", () => {
  test("a correction is remembered and back-applied to the merchant's other rows", async () => {
    const token = await signup(app, request);
    await upload(
      token,
      csv([
        "2026-03-01,ZZZQ HOLDINGS LLC,-10.00",
        "2026-03-02,ZZZQ HOLDINGS LLC,-20.00",
        "2026-03-03,ZZZQ HOLDINGS LLC,-30.00",
      ])
    );

    const list = await request(app).get("/api/transactions").set(authHeader(token));
    const first = list.body.items[0];
    expect(first.category).toBe("");

    const res = await request(app)
      .post(`/api/transactions/${first.id}/categorize`)
      .set(authHeader(token))
      .send({ category: "Professional Services" });

    expect(res.status).toBe(200);
    expect(res.body.transaction.category).toBe("Professional Services");
    expect(res.body.transaction.category_source).toBe("manual");
    // The other two rows for the same merchant, without another correction.
    expect(res.body.also_applied_to).toBe(2);

    const after = await request(app).get("/api/transactions").set(authHeader(token));
    expect(after.body.items.every((t) => t.category === "Professional Services")).toBe(true);
  });

  test("a remembered correction categorizes the next import with no guessing", async () => {
    const token = await signup(app, request);
    await upload(token, csv(["2026-03-01,ZZZQ HOLDINGS LLC,-10.00"]));

    const first = (await request(app).get("/api/transactions").set(authHeader(token))).body.items[0];
    await request(app)
      .post(`/api/transactions/${first.id}/categorize`)
      .set(authHeader(token))
      .send({ category: "Professional Services" });

    // A later statement with the same merchant, differently formatted.
    const second = await upload(token, csv(["2026-04-01,SQ *ZZZQ HOLDINGS LLC 998,-15.00"]), "april.csv");
    expect(second.body.by_source.learned).toBe(1);
  });

  test("remember:false corrects only this row and teaches nothing", async () => {
    const token = await signup(app, request);
    await upload(token, csv(["2026-03-01,ZZZQ HOLDINGS LLC,-10.00", "2026-03-02,ZZZQ HOLDINGS LLC,-20.00"]));

    const first = (await request(app).get("/api/transactions").set(authHeader(token))).body.items[0];
    const res = await request(app)
      .post(`/api/transactions/${first.id}/categorize`)
      .set(authHeader(token))
      .send({ category: "Travel", remember: false });

    expect(res.body.also_applied_to).toBe(0);
    expect(await MerchantCategory.count()).toBe(0);
  });

  test("a row a human already reviewed is not overwritten by a later correction", async () => {
    const token = await signup(app, request);
    await upload(token, csv(["2026-03-01,ZZZQ HOLDINGS LLC,-10.00", "2026-03-02,ZZZQ HOLDINGS LLC,-20.00"]));
    const items = (await request(app).get("/api/transactions").set(authHeader(token))).body.items;

    // Deliberately categorize the two rows differently; the second
    // correction must not silently overwrite the first person's decision.
    await request(app).post(`/api/transactions/${items[0].id}/categorize`).set(authHeader(token)).send({ category: "Travel" });
    await request(app).post(`/api/transactions/${items[1].id}/categorize`).set(authHeader(token)).send({ category: "Utilities" });

    const after = (await request(app).get("/api/transactions").set(authHeader(token))).body.items;
    const byId = Object.fromEntries(after.map((t) => [t.id, t.category]));
    expect(byId[items[0].id]).toBe("Travel");
    expect(byId[items[1].id]).toBe("Utilities");
  });

  test("rejects a category outside the fixed list", async () => {
    const token = await signup(app, request);
    await upload(token, csv(["2026-03-01,ZZZQ HOLDINGS LLC,-10.00"]));
    const first = (await request(app).get("/api/transactions").set(authHeader(token))).body.items[0];

    const res = await request(app)
      .post(`/api/transactions/${first.id}/categorize`)
      .set(authHeader(token))
      .send({ category: "Groceries" });
    expect(res.status).toBe(422);
  });
});

describe("listing", () => {
  test("reports category totals over the whole filtered set, not just the page", async () => {
    const token = await signup(app, request);
    await upload(token, csv(["2026-03-01,UNITED AIRLINES,-100.00", "2026-03-02,DELTA AIRLINES,-50.00"]));

    const res = await request(app).get("/api/transactions?page_size=1").set(authHeader(token));
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(2);
    expect(res.body.category_totals.Travel).toBe(-150);
  });

  test("needs_review excludes rows a human already settled", async () => {
    const token = await signup(app, request);
    await upload(token, csv(["2026-03-01,UNITED AIRLINES,-100.00", "2026-03-02,ZZZQ HOLDINGS LLC,-50.00"]));

    const before = await request(app).get("/api/transactions?needs_review=true").set(authHeader(token));
    expect(before.body.total).toBe(2);

    const first = before.body.items[0];
    await request(app).post(`/api/transactions/${first.id}/categorize`).set(authHeader(token)).send({ category: "Travel" });

    const after = await request(app).get("/api/transactions?needs_review=true").set(authHeader(token));
    expect(after.body.items.map((t) => t.id)).not.toContain(first.id);
  });

  test("filters by category", async () => {
    const token = await signup(app, request);
    await upload(token, csv(["2026-03-01,UNITED AIRLINES,-100.00", "2026-03-02,ZZZQ HOLDINGS LLC,-50.00"]));
    const res = await request(app).get("/api/transactions?category=Travel").set(authHeader(token));
    expect(res.body.total).toBe(1);
  });
});

describe("org isolation", () => {
  test("never lists, categorizes, or deletes another org's transactions", async () => {
    const mine = await signup(app, request, { email: "mine2@example.co" });
    const theirs = await signup(app, request, { email: "theirs2@example.co", orgName: "Other Co" });
    await upload(theirs, csv(["2026-03-01,UNITED AIRLINES,-100.00"]));

    const list = await request(app).get("/api/transactions").set(authHeader(mine));
    expect(list.body.total).toBe(0);

    const theirTxn = (await request(app).get("/api/transactions").set(authHeader(theirs))).body.items[0];
    expect(
      (await request(app).post(`/api/transactions/${theirTxn.id}/categorize`).set(authHeader(mine)).send({ category: "Travel" }))
        .status
    ).toBe(404);
    expect((await request(app).delete(`/api/transactions/${theirTxn.id}`).set(authHeader(mine))).status).toBe(404);
  });
});

describe("deleting", () => {
  test("soft-deletes so it leaves the list but keeps the row", async () => {
    const token = await signup(app, request);
    await upload(token, csv(["2026-03-01,UNITED AIRLINES,-100.00"]));
    const first = (await request(app).get("/api/transactions").set(authHeader(token))).body.items[0];

    expect((await request(app).delete(`/api/transactions/${first.id}`).set(authHeader(token))).status).toBe(200);
    expect((await request(app).get("/api/transactions").set(authHeader(token))).body.total).toBe(0);
    expect(await Transaction.count({ paranoid: false })).toBe(1);
  });
});
