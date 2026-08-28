// The share register (shareRegister.js, routes/shareRegister.js): a second
// ledger denominated in shares rather than dollars.
//
// The part worth testing hardest is backdating. Positions are replayed in
// date order rather than summed, so a transfer dated before its holder
// owned the shares has to be caught even when it looks perfectly fine
// against today's balances -- and so does one that was fine on its own
// date but leaves a later transfer short.
//
// Its tie-out to the financial ledger lives in shareRegisterTieOut.test.js.
import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function makeClass(token, body = {}) {
  const res = await request(app)
    .post("/api/share-classes")
    .set(authHeader(token))
    .send({ name: "Common", par_value: 0.001, ...body });
  if (res.status !== 201) throw new Error(`share class failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function makeHolder(token, name) {
  const res = await request(app).post("/api/shareholders").set(authHeader(token)).send({ name });
  if (res.status !== 201) throw new Error(`shareholder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

function shareTxn(token, body) {
  return request(app).post("/api/share-transactions").set(authHeader(token)).send(body);
}

async function capTable(token, asOf) {
  const q = asOf ? `?as_of=${asOf}` : "";
  return (await request(app).get(`/api/cap-table${q}`).set(authHeader(token))).body;
}

async function counts(token, asOf) {
  const q = asOf ? `?as_of=${asOf}` : "";
  return (await request(app).get(`/api/share-classes/counts${q}`).set(authHeader(token))).body.items;
}

describe("share classes and shareholders", () => {
  test("a $0.0001 par value survives the round trip", async () => {
    const token = await signup(app, request);
    // Delaware's default par. Carried in cents it would round to zero,
    // which is the bug v1.29 shipped and this column exists to prevent.
    const created = await makeClass(token, { name: "Common", par_value: 0.0001 });
    expect(created.par_value).toBe(0.0001);

    const listed = (await request(app).get("/api/share-classes").set(authHeader(token))).body.items;
    expect(listed).toHaveLength(1);
    expect(listed[0].par_value).toBe(0.0001);
  });

  test("two classes can't share a name", async () => {
    const token = await signup(app, request);
    await makeClass(token, { name: "Common" });
    const res = await request(app).post("/api/share-classes").set(authHeader(token)).send({ name: "Common", par_value: 0.01 });
    expect(res.status).toBe(409);
  });

  test("par value can't be edited after the fact", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token, { par_value: 0.01 });
    const res = await request(app)
      .patch(`/api/share-classes/${cls.id}`)
      .set(authHeader(token))
      .send({ par_value: 0.5, name: "Common A" });
    // The field is simply not in the update schema, so the rename lands
    // and the par value doesn't. Rewriting it would silently invalidate
    // the par split on every issuance already posted.
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Common A");
    expect(res.body.par_value).toBe(0.01);
  });

  test("authorization can't be lowered below what's already issued", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token, { authorized_shares: 10000000 });
    const holder = await makeHolder(token, "Ada");
    await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-15",
      shares: 5000,
      to_shareholder_id: holder.id,
    });

    const res = await request(app).patch(`/api/share-classes/${cls.id}`).set(authHeader(token)).send({ authorized_shares: 1000 });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/5000 shares/);

    // Raising it is fine -- that's what a charter amendment does.
    const up = await request(app).patch(`/api/share-classes/${cls.id}`).set(authHeader(token)).send({ authorized_shares: 20000000 });
    expect(up.status).toBe(200);
    expect(up.body.authorized_shares).toBe(20000000);
  });
});

describe("positions and the cap table", () => {
  test("an issuance puts the whole company in one holder's hands", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");

    const res = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-01",
      shares: 8000000,
      to_shareholder_id: ada.id,
    });
    expect(res.status).toBe(201);

    const table = await capTable(token);
    expect(table.total_outstanding).toBe(8000000);
    expect(table.holders).toHaveLength(1);
    expect(table.holders[0].shareholder_name).toBe("Ada");
    expect(table.holders[0].total_shares).toBe(8000000);
    expect(table.holders[0].percent).toBe(100);
    expect(table.holders[0].positions[0].percent).toBe(100);
  });

  test("percentages split across holders and are ordered by size", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");

    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 7500, to_shareholder_id: ada.id });
    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-02-01", shares: 2500, to_shareholder_id: grace.id });

    const table = await capTable(token);
    expect(table.holders.map((h) => h.shareholder_name)).toEqual(["Ada", "Grace"]);
    expect(table.holders[0].percent).toBe(75);
    expect(table.holders[1].percent).toBe(25);
  });

  test("a transfer moves the position and leaves the counts alone", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");

    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 1000, to_shareholder_id: ada.id });
    const res = await shareTxn(token, {
      type: "transfer",
      share_class_id: cls.id,
      transaction_date: "2026-03-01",
      shares: 400,
      from_shareholder_id: ada.id,
      to_shareholder_id: grace.id,
    });
    expect(res.status).toBe(201);

    const [row] = await counts(token);
    expect(row).toMatchObject({ issued: 1000, treasury: 0, outstanding: 1000 });

    const table = await capTable(token);
    expect(table.holders.find((h) => h.shareholder_name === "Ada").total_shares).toBe(600);
    expect(table.holders.find((h) => h.shareholder_name === "Grace").total_shares).toBe(400);
  });

  test("a buyback lowers outstanding but not issued, and a reissue puts it back", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");

    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 1000, to_shareholder_id: ada.id });
    await shareTxn(token, {
      type: "repurchase",
      share_class_id: cls.id,
      transaction_date: "2026-04-01",
      shares: 300,
      from_shareholder_id: ada.id,
    });

    let [row] = await counts(token);
    // Treasury shares are still issued -- that's why they keep consuming
    // authorized capital.
    expect(row).toMatchObject({ issued: 1000, treasury: 300, outstanding: 700 });

    // Ada's 700 is now the whole company, not 70% of it.
    const midway = await capTable(token);
    expect(midway.holders[0].percent).toBe(100);

    await shareTxn(token, {
      type: "reissue",
      share_class_id: cls.id,
      transaction_date: "2026-06-01",
      shares: 300,
      to_shareholder_id: grace.id,
    });

    [row] = await counts(token);
    expect(row).toMatchObject({ issued: 1000, treasury: 0, outstanding: 1000 });
  });

  test("a holder who sold out entirely drops off the cap table", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");

    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 500, to_shareholder_id: ada.id });
    await shareTxn(token, {
      type: "transfer",
      share_class_id: cls.id,
      transaction_date: "2026-05-01",
      shares: 500,
      from_shareholder_id: ada.id,
      to_shareholder_id: grace.id,
    });

    const table = await capTable(token);
    expect(table.holders.map((h) => h.shareholder_name)).toEqual(["Grace"]);
    // Still on file, and still in the history -- just not holding.
    const holders = (await request(app).get("/api/shareholders").set(authHeader(token))).body.items;
    expect(holders.map((h) => h.name).sort()).toEqual(["Ada", "Grace"]);
  });

  test("as_of reads the register at a past date", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");

    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 1000, to_shareholder_id: ada.id });
    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-07-01", shares: 1000, to_shareholder_id: grace.id });

    const before = await capTable(token, "2026-06-30");
    expect(before.total_outstanding).toBe(1000);
    expect(before.holders).toHaveLength(1);

    const after = await capTable(token, "2026-12-31");
    expect(after.total_outstanding).toBe(2000);
    expect(after.holders).toHaveLength(2);
  });

  test("positions are per class, not pooled", async () => {
    const token = await signup(app, request);
    const common = await makeClass(token, { name: "Common" });
    const preferred = await makeClass(token, { name: "Preferred Series A" });
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");

    await shareTxn(token, { type: "issue", share_class_id: common.id, transaction_date: "2026-01-01", shares: 900, to_shareholder_id: ada.id });
    await shareTxn(token, { type: "issue", share_class_id: preferred.id, transaction_date: "2026-01-01", shares: 100, to_shareholder_id: grace.id });

    const table = await capTable(token);
    const ada_ = table.holders.find((h) => h.shareholder_name === "Ada");
    // 100% of Common, 90% of the company counting every share as one.
    expect(ada_.positions).toHaveLength(1);
    expect(ada_.positions[0].percent).toBe(100);
    expect(ada_.percent).toBe(90);
  });
});

describe("what the register refuses", () => {
  test("transferring more shares than the holder has", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");

    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 100, to_shareholder_id: ada.id });
    const res = await shareTxn(token, {
      type: "transfer",
      share_class_id: cls.id,
      transaction_date: "2026-02-01",
      shares: 150,
      from_shareholder_id: ada.id,
      to_shareholder_id: grace.id,
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/Ada doesn't hold enough shares/);
    expect(res.body.detail).toMatch(/short by 50/);
  });

  // The reason positions are replayed in date order instead of summed.
  test("a backdated transfer of shares the holder didn't own yet", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");

    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-06-01", shares: 100, to_shareholder_id: ada.id });

    // Against today's balances this is fine: Ada holds 100. In March she
    // held nothing, and only a replay sees that.
    const res = await shareTxn(token, {
      type: "transfer",
      share_class_id: cls.id,
      transaction_date: "2026-03-01",
      shares: 100,
      from_shareholder_id: ada.id,
      to_shareholder_id: grace.id,
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/2026-03-01/);
  });

  // The mirror case: valid on the date it happened, impossible afterwards.
  test("a backdated transfer that leaves a later transfer short", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");
    const kay = await makeHolder(token, "Kay");

    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 100, to_shareholder_id: ada.id });
    await shareTxn(token, {
      type: "transfer",
      share_class_id: cls.id,
      transaction_date: "2026-09-01",
      shares: 100,
      from_shareholder_id: ada.id,
      to_shareholder_id: grace.id,
    });

    // On 2026-05-01 Ada really did hold 100. She also already sold all 100
    // in September, so inserting this makes September impossible.
    const res = await shareTxn(token, {
      type: "transfer",
      share_class_id: cls.id,
      transaction_date: "2026-05-01",
      shares: 60,
      from_shareholder_id: ada.id,
      to_shareholder_id: kay.id,
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/2026-09-01/);
  });

  test("reissuing more than the company holds in treasury", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");

    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 100, to_shareholder_id: ada.id });
    const res = await shareTxn(token, {
      type: "reissue",
      share_class_id: cls.id,
      transaction_date: "2026-02-01",
      shares: 10,
      to_shareholder_id: ada.id,
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/treasury shares/);
  });

  test("issuing past the authorized ceiling, with treasury shares still counting", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token, { authorized_shares: 1000 });
    const ada = await makeHolder(token, "Ada");

    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 1000, to_shareholder_id: ada.id });
    await shareTxn(token, {
      type: "repurchase",
      share_class_id: cls.id,
      transaction_date: "2026-02-01",
      shares: 400,
      from_shareholder_id: ada.id,
    });

    // Only 600 are outstanding, but all 1,000 are still issued -- buying
    // shares back doesn't hand the authorization back to the company.
    const res = await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-03-01", shares: 1, to_shareholder_id: ada.id });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/authorized for 1,000 shares/);

    // Reissuing out of treasury is the way to put those 400 back to work.
    const reissue = await shareTxn(token, {
      type: "reissue",
      share_class_id: cls.id,
      transaction_date: "2026-03-01",
      shares: 400,
      to_shareholder_id: ada.id,
    });
    expect(reissue.status).toBe(201);
  });

  test("a class with no stated ceiling reports null, not zero remaining", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token, { authorized_shares: null });
    const ada = await makeHolder(token, "Ada");
    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 5000, to_shareholder_id: ada.id });

    const [row] = await counts(token);
    expect(row.authorized).toBeNull();
    expect(row.available).toBeNull();
  });

  test("the wrong ends filled in for the type", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");

    const noRecipient = await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 10 });
    expect(noRecipient.status).toBe(422);

    const issueFromHolder = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-01",
      shares: 10,
      from_shareholder_id: ada.id,
      to_shareholder_id: ada.id,
    });
    expect(issueFromHolder.status).toBe(422);

    const selfTransfer = await shareTxn(token, {
      type: "transfer",
      share_class_id: cls.id,
      transaction_date: "2026-01-01",
      shares: 10,
      from_shareholder_id: ada.id,
      to_shareholder_id: ada.id,
    });
    expect(selfTransfer.status).toBe(422);
  });

  test("handing shares to a deactivated holder, while letting them still sell out", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");
    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 1000, to_shareholder_id: ada.id });
    await request(app).patch(`/api/shareholders/${ada.id}`).set(authHeader(token)).send({ active: false });

    const toAda = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-02-01",
      shares: 10,
      to_shareholder_id: ada.id,
    });
    expect(toAda.status).toBe(422);
    expect(toAda.body.detail).toMatch(/can't receive shares/);

    // Refusing this would strand her position on the cap table forever.
    const fromAda = await shareTxn(token, {
      type: "transfer",
      share_class_id: cls.id,
      transaction_date: "2026-03-01",
      shares: 1000,
      from_shareholder_id: ada.id,
      to_shareholder_id: grace.id,
    });
    expect(fromAda.status).toBe(201);
  });

  test("moving shares of a deactivated class", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    await request(app).patch(`/api/share-classes/${cls.id}`).set(authHeader(token)).send({ active: false });

    const res = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-01",
      shares: 10,
      to_shareholder_id: ada.id,
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/no longer active/);
  });

  test("a shareholder or class from another org", async () => {
    const token = await signup(app, request);
    const otherToken = await signup(app, request, { email: "other@example.co", orgName: "Other Org" });
    const cls = await makeClass(token);
    const theirHolder = await makeHolder(otherToken, "Theirs");

    const res = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-01",
      shares: 10,
      to_shareholder_id: theirHolder.id,
    });
    expect(res.status).toBe(404);

    const theirClass = await makeClass(otherToken, { name: "Their Common" });
    const wrongClass = await shareTxn(token, {
      type: "issue",
      share_class_id: theirClass.id,
      transaction_date: "2026-01-01",
      shares: 10,
      to_shareholder_id: (await makeHolder(token, "Ada")).id,
    });
    expect(wrongClass.status).toBe(404);
  });
});

describe("deleting a share transaction", () => {
  test("removes it and the position with it", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const issued = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-01",
      shares: 100,
      to_shareholder_id: ada.id,
    });

    const res = await request(app).delete(`/api/share-transactions/${issued.body.id}`).set(authHeader(token));
    expect(res.status).toBe(200);
    expect((await capTable(token)).holders).toHaveLength(0);
  });

  test("is refused when a later transaction depends on it", async () => {
    const token = await signup(app, request);
    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    const grace = await makeHolder(token, "Grace");

    const issued = await shareTxn(token, {
      type: "issue",
      share_class_id: cls.id,
      transaction_date: "2026-01-01",
      shares: 100,
      to_shareholder_id: ada.id,
    });
    await shareTxn(token, {
      type: "transfer",
      share_class_id: cls.id,
      transaction_date: "2026-05-01",
      shares: 100,
      from_shareholder_id: ada.id,
      to_shareholder_id: grace.id,
    });

    const res = await request(app).delete(`/api/share-transactions/${issued.body.id}`).set(authHeader(token));
    expect(res.status).toBe(422);
    expect((await capTable(token)).total_outstanding).toBe(100);
  });
});

describe("org isolation", () => {
  test("one org's register is invisible to another", async () => {
    const token = await signup(app, request);
    const otherToken = await signup(app, request, { email: "other@example.co", orgName: "Other Org" });

    const cls = await makeClass(token);
    const ada = await makeHolder(token, "Ada");
    await shareTxn(token, { type: "issue", share_class_id: cls.id, transaction_date: "2026-01-01", shares: 100, to_shareholder_id: ada.id });

    expect((await request(app).get("/api/share-classes").set(authHeader(otherToken))).body.items).toHaveLength(0);
    expect((await request(app).get("/api/shareholders").set(authHeader(otherToken))).body.items).toHaveLength(0);
    expect((await request(app).get("/api/share-transactions").set(authHeader(otherToken))).body.items).toHaveLength(0);
    expect((await capTable(otherToken)).holders).toHaveLength(0);
  });

  test("the endpoints require authentication", async () => {
    for (const path of ["/api/share-classes", "/api/shareholders", "/api/share-transactions", "/api/cap-table", "/api/share-register/reconciliation"]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });
});
