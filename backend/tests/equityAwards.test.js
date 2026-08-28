// The option pool and fully-diluted ownership (equityAwards.js,
// routes/equityAwards.js).
//
// Two things carry the weight here. Vesting is computed rather than
// stored, so the arithmetic is tested directly as a function -- cliffs,
// month boundaries, and the rounding remainder landing on the final month.
// And the fully-diluted denominator has to include the unallocated pool,
// which is the term people leave out and the one a term sheet argues over.
import request from "supertest";
import { app } from "../src/app.js";
import { monthsElapsed, summarizeAward, vestedShares } from "../src/equityAwards.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

// Pure-function tests need no account at all, which also keeps this file
// under the signup rate limiter's per-file ceiling (see routes/auth.js).
describe("vesting arithmetic", () => {
  const grant = { shares: 48000, vestingStartDate: "2026-01-01", vestingMonths: 48, cliffMonths: 12 };

  test("counts whole months by anniversary, not by day arithmetic", () => {
    expect(monthsElapsed("2026-01-15", "2026-02-14")).toBe(0);
    expect(monthsElapsed("2026-01-15", "2026-02-15")).toBe(1);
    expect(monthsElapsed("2026-01-15", "2027-01-14")).toBe(11);
    expect(monthsElapsed("2026-01-15", "2027-01-15")).toBe(12);
    // Before the start date at all.
    expect(monthsElapsed("2026-06-01", "2026-01-01")).toBe(0);
  });

  test("clamps a start date with no matching day in a short month", () => {
    // A vesting start on the 31st has its February anniversary on the
    // 28th. Getting this wrong shifts a whole month of someone's equity.
    expect(monthsElapsed("2026-01-31", "2026-02-28")).toBe(1);
    expect(monthsElapsed("2026-01-31", "2026-02-27")).toBe(0);
  });

  test("nothing vests before the cliff, then a year lands at once", () => {
    expect(vestedShares(grant, "2026-12-31")).toBe(0);
    expect(vestedShares(grant, "2027-01-01")).toBe(12000);
    expect(vestedShares(grant, "2027-02-01")).toBe(13000);
  });

  test("finishes at exactly the granted amount and stops there", () => {
    expect(vestedShares(grant, "2030-01-01")).toBe(48000);
    expect(vestedShares(grant, "2035-01-01")).toBe(48000);
  });

  test("the rounding remainder lands on the final month", () => {
    // 1,000 shares over 48 months is 20.83 a month. Every intermediate
    // month floors, and the last one collects what's left rather than
    // leaving a fraction of a share nobody can hold.
    const odd = { shares: 1000, vestingStartDate: "2026-01-01", vestingMonths: 48, cliffMonths: 0 };
    expect(vestedShares(odd, "2026-02-01")).toBe(20);
    expect(vestedShares(odd, "2029-12-01")).toBe(979);
    expect(vestedShares(odd, "2030-01-01")).toBe(1000);
  });

  test("no cliff and no vesting period at all", () => {
    expect(vestedShares({ ...grant, cliffMonths: 0 }, "2026-02-01")).toBe(1000);
    // A fully-vested grant -- an advisor's, or a warrant.
    expect(vestedShares({ shares: 500, vestingStartDate: "2026-01-01", vestingMonths: 0, cliffMonths: 0 }, "2026-01-01")).toBe(500);
  });

  test("cancelling the unvested half leaves the vested half exercisable", () => {
    const events = [{ type: "cancel", eventDate: "2027-01-01", shares: 36000 }];
    const summary = summarizeAward(grant, events, "2027-01-01");
    expect(summary.outstanding).toBe(12000);
    expect(summary.vested).toBe(12000);
    expect(summary.exercisable).toBe(12000);
    expect(summary.unvested).toBe(0);
  });

  test("events dated after the as-of date don't count yet", () => {
    const events = [{ type: "exercise", eventDate: "2028-01-01", shares: 1000 }];
    expect(summarizeAward(grant, events, "2027-06-01").exercised).toBe(0);
    expect(summarizeAward(grant, events, "2028-06-01").exercised).toBe(1000);
  });
});

/* ------------------------------ API tests ------------------------------ */

async function setup(token, { par = 0.001, authorized = 10000000 } = {}) {
  const cls = (
    await request(app).post("/api/share-classes").set(authHeader(token)).send({ name: "Common", par_value: par, authorized_shares: authorized })
  ).body;
  const founder = (await request(app).post("/api/shareholders").set(authHeader(token)).send({ name: "Ada" })).body;
  const employee = (await request(app).post("/api/shareholders").set(authHeader(token)).send({ name: "Grace" })).body;
  return { cls, founder, employee };
}

function makePlan(token, cls, body = {}) {
  return request(app)
    .post("/api/equity-plans")
    .set(authHeader(token))
    .send({ name: "2026 Stock Plan", share_class_id: cls.id, reserved_shares: 1000000, adopted_date: "2026-01-01", ...body });
}

function grant(token, plan, holder, body = {}) {
  return request(app)
    .post("/api/equity-awards")
    .set(authHeader(token))
    .send({
      equity_plan_id: plan.id,
      shareholder_id: holder.id,
      grant_date: "2026-01-01",
      shares: 100000,
      strike_price: 0.05,
      ...body,
    });
}

async function plans(token, asOf) {
  const q = asOf ? `?as_of=${asOf}` : "";
  return (await request(app).get(`/api/equity-plans${q}`).set(authHeader(token))).body.items;
}

async function diluted(token, asOf) {
  const q = asOf ? `?as_of=${asOf}` : "";
  return (await request(app).get(`/api/cap-table/fully-diluted${q}`).set(authHeader(token))).body;
}

function issue(token, cls, holder, shares, date = "2026-01-01") {
  return request(app)
    .post("/api/share-transactions")
    .set(authHeader(token))
    .send({ type: "issue", share_class_id: cls.id, transaction_date: date, shares, to_shareholder_id: holder.id });
}

describe("the pool", () => {
  test("a grant reduces what's left without issuing anything", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;
    expect((await grant(token, plan, employee)).status).toBe(201);

    const [status] = await plans(token);
    expect(status).toMatchObject({ reserved: 1000000, granted: 100000, exercised: 0, outstanding: 100000, available: 900000 });

    // Nothing has been issued -- the register still shows an empty company.
    const cap = (await request(app).get("/api/cap-table").set(authHeader(token))).body;
    expect(cap.total_outstanding).toBe(0);
  });

  test("granting more than the plan has left is refused", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls, { reserved_shares: 50000 })).body;

    const res = await grant(token, plan, employee, { shares: 60000 });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/50,000 shares left to grant/);
  });

  test("cancelled shares go back to the pool, exercised ones don't", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;
    const award = (await grant(token, plan, employee, { grant_date: "2024-01-01", shares: 100000, cliff_months: 0 })).body;

    // A year in, 25,000 of 100,000 have vested. Exercise them.
    const ex = await request(app)
      .post(`/api/equity-awards/${award.id}/exercise`)
      .set(authHeader(token))
      .send({ shares: 25000, event_date: "2025-01-01" });
    expect(ex.status).toBe(201);

    // Those left the pool permanently the moment they became real stock.
    let [status] = await plans(token);
    expect(status).toMatchObject({ granted: 100000, exercised: 25000, cancelled: 0, available: 900000 });

    // The rest is forfeited on departure and comes back.
    const cancel = await request(app)
      .post(`/api/equity-awards/${award.id}/cancel`)
      .set(authHeader(token))
      .send({ event_date: "2025-02-01" });
    expect(cancel.status).toBe(201);
    expect(cancel.body.shares).toBe(75000);

    [status] = await plans(token);
    expect(status).toMatchObject({ granted: 100000, exercised: 25000, cancelled: 75000, outstanding: 0, available: 975000 });
  });

  test("the reserve can be raised but not dropped below what's granted", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;
    await grant(token, plan, employee, { shares: 400000 });

    const down = await request(app).patch(`/api/equity-plans/${plan.id}`).set(authHeader(token)).send({ reserved_shares: 100000 });
    expect(down.status).toBe(422);
    expect(down.body.detail).toMatch(/400,000 shares are already granted/);

    const up = await request(app).patch(`/api/equity-plans/${plan.id}`).set(authHeader(token)).send({ reserved_shares: 2000000 });
    expect(up.status).toBe(200);
    expect((await plans(token))[0].available).toBe(1600000);
  });

  test("a closed plan takes no new grants", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;
    await request(app).patch(`/api/equity-plans/${plan.id}`).set(authHeader(token)).send({ active: false });

    const res = await grant(token, plan, employee);
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/closed/);
  });

  test("two plans can't share a name, and a class from another org is invisible", async () => {
    const token = await signup(app, request);
    const otherToken = await signup(app, request, { email: "other@example.co", orgName: "Other Org" });
    const { cls } = await setup(token);
    await makePlan(token, cls);

    expect((await makePlan(token, cls)).status).toBe(409);
    expect((await makePlan(otherToken, cls)).status).toBe(404);
  });
});

describe("exercising", () => {
  test("issues real shares onto the register and consumes authorized capital", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;
    const award = (await grant(token, plan, employee, { grant_date: "2024-01-01", shares: 48000, cliff_months: 12 })).body;

    const res = await request(app)
      .post(`/api/equity-awards/${award.id}/exercise`)
      .set(authHeader(token))
      .send({ shares: 12000, event_date: "2025-01-01" });
    expect(res.status).toBe(201);
    expect(res.body.share_transaction_id).toBeTruthy();

    const cap = (await request(app).get("/api/cap-table").set(authHeader(token))).body;
    expect(cap.total_outstanding).toBe(12000);
    expect(cap.holders[0].shareholder_name).toBe("Grace");

    // It went through recordShareTransaction, so it shows up as an
    // ordinary issuance and counts against the charter's ceiling.
    const counts = (await request(app).get("/api/share-classes/counts").set(authHeader(token))).body.items;
    expect(counts[0]).toMatchObject({ issued: 12000, outstanding: 12000 });
  });

  test("unvested shares can't be exercised", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;
    const award = (await grant(token, plan, employee, { grant_date: "2024-01-01", shares: 48000, cliff_months: 12 })).body;

    // Eleven months in, the cliff hasn't landed and nothing is exercisable.
    const early = await request(app)
      .post(`/api/equity-awards/${award.id}/exercise`)
      .set(authHeader(token))
      .send({ shares: 1, event_date: "2024-12-01" });
    expect(early.status).toBe(422);
    expect(early.body.detail).toMatch(/0 shares are exercisable/);

    // Past the cliff, but asking for more than has vested.
    const greedy = await request(app)
      .post(`/api/equity-awards/${award.id}/exercise`)
      .set(authHeader(token))
      .send({ shares: 20000, event_date: "2025-01-01" });
    expect(greedy.status).toBe(422);
    expect(greedy.body.detail).toMatch(/12,000 shares are exercisable/);
  });

  test("exercising past the charter's authorized ceiling is refused by the register", async () => {
    const token = await signup(app, request);
    const { cls, founder, employee } = await setup(token, { authorized: 100000 });
    await issue(token, cls, founder, 95000);

    const plan = (await makePlan(token, cls, { reserved_shares: 50000 })).body;
    const award = (await grant(token, plan, employee, { shares: 50000, cliff_months: 0, vesting_months: 0 })).body;

    const res = await request(app)
      .post(`/api/equity-awards/${award.id}/exercise`)
      .set(authHeader(token))
      .send({ shares: 50000, event_date: "2026-06-01" });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/authorized for 100,000 shares/);

    // And nothing was recorded against the award either -- the event is
    // written only once the issuance is on the register.
    const awards = (await request(app).get("/api/equity-awards").set(authHeader(token))).body.items;
    expect(awards[0].exercised).toBe(0);
  });

  test("an exercise dated before the grant is refused", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;
    const award = (await grant(token, plan, employee, { grant_date: "2026-06-01", vesting_months: 0, cliff_months: 0 })).body;

    const res = await request(app)
      .post(`/api/equity-awards/${award.id}/exercise`)
      .set(authHeader(token))
      .send({ shares: 10, event_date: "2026-01-01" });
    expect(res.status).toBe(422);
  });

  // The gap the browser found: without posting the strike money, Common
  // Stock stays put while the register's issued count climbs, and v1.30's
  // tie-out starts reporting a difference nothing can close.
  test("posting the strike money keeps the register tied to the ledger", async () => {
    const token = await signup(app, request);
    const { cls, founder, employee } = await setup(token, { par: 0.0001 });
    const cash = (await request(app).get("/api/accounts").set(authHeader(token))).body.items.find((a) => a.name === "Cash").id;

    // A founder issuance through the equity module, so the tie-out starts clean.
    const contribution = (
      await request(app)
        .post("/api/equity/transactions")
        .set(authHeader(token))
        .send({ type: "contribution", transaction_date: "2024-01-05", amount: 800, cash_account_id: cash, shares: 8000000, par_value: 0.0001 })
    ).body;
    await request(app)
      .post("/api/share-transactions")
      .set(authHeader(token))
      .send({
        type: "issue",
        share_class_id: cls.id,
        transaction_date: "2024-01-05",
        shares: 8000000,
        to_shareholder_id: founder.id,
        equity_transaction_id: contribution.id,
      });
    expect((await request(app).get("/api/share-register/reconciliation").set(authHeader(token))).body.reconciles).toBe(true);

    const plan = (await makePlan(token, cls)).body;
    const award = (await grant(token, plan, employee, { grant_date: "2024-01-10", shares: 100000, cliff_months: 0, vesting_months: 0, strike_price: 0.05 })).body;

    const res = await request(app)
      .post(`/api/equity-awards/${award.id}/exercise`)
      .set(authHeader(token))
      .send({ shares: 100000, event_date: "2026-01-10", cash_account_id: cash });
    expect(res.status).toBe(201);

    // 100,000 at $0.05 is $5,000 raised, of which 100,000 x $0.0001 = $10
    // is par and the rest is paid-in capital.
    const rec = (await request(app).get("/api/share-register/reconciliation").set(authHeader(token))).body;
    expect(rec.reconciles).toBe(true);
    expect(rec.ledger_common_stock).toBe(810);
    expect(rec.unlinked_equity_transactions).toHaveLength(0);

    const bs = (await request(app).get("/api/statements/balance-sheet?as_of=2026-12-31").set(authHeader(token))).body;
    const apic = bs.equity.accounts.find((a) => a.name === "Additional Paid-In Capital");
    expect(apic.amount).toBe(4990);
  });

  test("skipping the cash account issues shares and leaves the tie-out to say so", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token, { par: 0.0001 });
    const plan = (await makePlan(token, cls)).body;
    const award = (await grant(token, plan, employee, { grant_date: "2024-01-10", shares: 100000, cliff_months: 0, vesting_months: 0, strike_price: 0.05 })).body;

    await request(app)
      .post(`/api/equity-awards/${award.id}/exercise`)
      .set(authHeader(token))
      .send({ shares: 100000, event_date: "2026-01-10" });

    // Shares are real; no dollars were posted, and the reconciliation is
    // the thing that says so rather than the difference going unnoticed.
    expect((await request(app).get("/api/cap-table").set(authHeader(token))).body.total_outstanding).toBe(100000);
    const rec = (await request(app).get("/api/share-register/reconciliation").set(authHeader(token))).body;
    expect(rec.applicable).toBe(false);
    expect(rec.reason).toMatch(/nothing in Common Stock/);
  });

  test("an RSU has no cash to post", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const cash = (await request(app).get("/api/accounts").set(authHeader(token))).body.items.find((a) => a.name === "Cash").id;
    const plan = (await makePlan(token, cls)).body;
    const award = (await grant(token, plan, employee, { type: "rsu", strike_price: null, cliff_months: 0, vesting_months: 0 })).body;

    const res = await request(app)
      .post(`/api/equity-awards/${award.id}/exercise`)
      .set(authHeader(token))
      .send({ shares: 1000, event_date: "2026-06-01", cash_account_id: cash });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/no strike price/);
  });

  // Without this, a refused issuance would leave cash on the books raised
  // against shares that will never exist.
  test("a contribution posted for an issuance the register refuses is backed out", async () => {
    const token = await signup(app, request);
    const { cls, founder, employee } = await setup(token, { authorized: 100000 });
    const cash = (await request(app).get("/api/accounts").set(authHeader(token))).body.items.find((a) => a.name === "Cash").id;
    await issue(token, cls, founder, 95000);

    const plan = (await makePlan(token, cls, { reserved_shares: 50000 })).body;
    const award = (await grant(token, plan, employee, { shares: 50000, cliff_months: 0, vesting_months: 0, strike_price: 1 })).body;

    const res = await request(app)
      .post(`/api/equity-awards/${award.id}/exercise`)
      .set(authHeader(token))
      .send({ shares: 50000, event_date: "2026-06-01", cash_account_id: cash });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/authorized for 100,000 shares/);

    // The $50,000 contribution was voided, so cash is back where it was.
    // The $50,000 contribution was voided, so total assets are back to
    // zero -- an account with no balance doesn't appear on the sheet at
    // all, so the total is the thing to assert on.
    const bs = (await request(app).get("/api/statements/balance-sheet?as_of=2026-12-31").set(authHeader(token))).body;
    expect(bs.assets.total).toBe(0);
  });

  // Without this rule, vesting could be bypassed by typing a date: every
  // gate here is evaluated at the event's own date, so an exercise dated
  // four years out would find the grant fully vested today.
  test("an exercise can't be dated in the future", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;
    const award = (await grant(token, plan, employee, { grant_date: "2026-01-01", shares: 48000, cliff_months: 12 })).body;

    const nextYear = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await request(app)
      .post(`/api/equity-awards/${award.id}/exercise`)
      .set(authHeader(token))
      .send({ shares: 12000, event_date: nextYear });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/can't be dated in the future/);

    const cancel = await request(app)
      .post(`/api/equity-awards/${award.id}/cancel`)
      .set(authHeader(token))
      .send({ event_date: nextYear });
    expect(cancel.status).toBe(422);
  });

  test("cancelling more than is outstanding is refused", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;
    const award = (await grant(token, plan, employee, { shares: 1000 })).body;

    const res = await request(app)
      .post(`/api/equity-awards/${award.id}/cancel`)
      .set(authHeader(token))
      .send({ shares: 2000, event_date: "2026-06-01" });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/1,000 shares are still outstanding/);
  });
});

describe("grant validation", () => {
  test("an RSU has no strike price", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;

    const res = await grant(token, plan, employee, { type: "rsu", strike_price: 0.05 });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/no strike price/);

    expect((await grant(token, plan, employee, { type: "rsu", strike_price: null })).status).toBe(201);
  });

  test("a cliff longer than the vesting period never vests, so it's refused", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;

    const res = await grant(token, plan, employee, { vesting_months: 12, cliff_months: 24 });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/cliff can't be longer/);
  });

  test("a deactivated grantee can't be granted to", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;
    await request(app).patch(`/api/shareholders/${employee.id}`).set(authHeader(token)).send({ active: false });

    const res = await grant(token, plan, employee);
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/no longer active/);
  });

  test("vesting starts on the grant date unless told otherwise", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;

    const onGrant = (await grant(token, plan, employee, { grant_date: "2026-04-01" })).body;
    expect(onGrant.vesting_start_date).toBe("2026-04-01");

    // Backdated to a start date, which is what happens when the board
    // approves a grant a couple of months after someone joined.
    const backdated = (await grant(token, plan, employee, { grant_date: "2026-04-01", vesting_start_date: "2026-01-15" })).body;
    expect(backdated.vesting_start_date).toBe("2026-01-15");
  });
});

describe("fully-diluted ownership", () => {
  test("the unallocated pool dilutes everybody and belongs to nobody", async () => {
    const token = await signup(app, request);
    const { cls, founder, employee } = await setup(token);
    await issue(token, cls, founder, 8000000);
    const plan = (await makePlan(token, cls, { reserved_shares: 2000000 })).body;
    await grant(token, plan, employee, { shares: 500000 });

    const fd = await diluted(token);
    // 8,000,000 outstanding + 500,000 granted + 1,500,000 still unallocated.
    expect(fd).toMatchObject({
      outstanding_shares: 8000000,
      award_shares: 500000,
      unallocated_pool_shares: 1500000,
      fully_diluted_shares: 10000000,
    });
    expect(fd.unallocated_pool_percent).toBe(15);

    const ada = fd.holders.find((h) => h.shareholder_name === "Ada");
    expect(ada.percent).toBe(80);
    // What the register alone would have said: Ada owns all of it.
    expect(ada.outstanding_percent).toBe(100);

    const grace = fd.holders.find((h) => h.shareholder_name === "Grace");
    expect(grace).toMatchObject({ shares: 0, award_shares: 500000, percent: 5, outstanding_percent: 0 });
  });

  test("a grantee who has never exercised is still on the table", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls, { reserved_shares: 100000 })).body;
    await grant(token, plan, employee, { shares: 100000 });

    // Nobody holds a single issued share, so the register's cap table is
    // empty -- and the fully-diluted one is not. That difference is the
    // entire point of this report.
    expect((await request(app).get("/api/cap-table").set(authHeader(token))).body.holders).toHaveLength(0);

    const fd = await diluted(token);
    expect(fd.holders).toHaveLength(1);
    expect(fd.holders[0]).toMatchObject({ shareholder_name: "Grace", shares: 0, award_shares: 100000, percent: 100 });
  });

  test("exercising moves shares between the two columns without changing the total", async () => {
    const token = await signup(app, request);
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls, { reserved_shares: 100000 })).body;
    const award = (await grant(token, plan, employee, { shares: 100000, cliff_months: 0, vesting_months: 0 })).body;

    const before = await diluted(token);
    expect(before.fully_diluted_shares).toBe(100000);

    await request(app).post(`/api/equity-awards/${award.id}/exercise`).set(authHeader(token)).send({ shares: 40000, event_date: "2026-06-01" });

    const after = await diluted(token);
    // Still 100,000 in total: 40,000 have simply become real stock.
    expect(after).toMatchObject({ outstanding_shares: 40000, award_shares: 60000, unallocated_pool_shares: 0, fully_diluted_shares: 100000 });
    expect(after.holders[0].percent).toBe(100);
  });

  test("as_of reads the pool and the awards at a past date", async () => {
    const token = await signup(app, request);
    const { cls, founder, employee } = await setup(token);
    await issue(token, cls, founder, 1000000, "2026-01-01");
    const plan = (await makePlan(token, cls, { reserved_shares: 200000 })).body;
    await grant(token, plan, employee, { grant_date: "2026-09-01", shares: 200000 });

    // Before the grant: the pool is reserved but nothing is promised.
    const before = await diluted(token, "2026-06-30");
    expect(before).toMatchObject({ award_shares: 0, unallocated_pool_shares: 200000, fully_diluted_shares: 1200000 });

    const after = await diluted(token, "2026-12-31");
    expect(after).toMatchObject({ award_shares: 200000, unallocated_pool_shares: 0, fully_diluted_shares: 1200000 });
  });
});

describe("org isolation", () => {
  test("one org's pool is invisible to another", async () => {
    const token = await signup(app, request);
    const otherToken = await signup(app, request, { email: "other@example.co", orgName: "Other Org" });
    const { cls, employee } = await setup(token);
    const plan = (await makePlan(token, cls)).body;
    await grant(token, plan, employee);

    expect(await plans(otherToken)).toHaveLength(0);
    expect((await request(app).get("/api/equity-awards").set(authHeader(otherToken))).body.items).toHaveLength(0);
    expect((await diluted(otherToken)).holders).toHaveLength(0);

    // And another org's award can't be exercised or cancelled.
    const awardId = (await request(app).get("/api/equity-awards").set(authHeader(token))).body.items[0].id;
    const res = await request(app)
      .post(`/api/equity-awards/${awardId}/exercise`)
      .set(authHeader(otherToken))
      .send({ shares: 1, event_date: "2026-06-01" });
    expect(res.status).toBe(404);
  });

  test("the endpoints require authentication", async () => {
    for (const path of ["/api/equity-plans", "/api/equity-awards", "/api/cap-table/fully-diluted"]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });
});
