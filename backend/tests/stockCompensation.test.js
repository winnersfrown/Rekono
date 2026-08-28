// Stock compensation expense (stockCompensation.js,
// routes/stockCompensation.js).
//
// Two things here are counterintuitive enough that most of this file is
// about them:
//
//   1. Expense recognition is NOT the vesting curve. Under a 12-month
//      cliff nothing vests for a year, but the employee renders service
//      the whole time, so a year of expense is recognized. Reusing
//      `vestedShares` here would defer a year of real cost and then dump
//      it in one month.
//   2. Forfeiture reverses expense already taken -- but only on the
//      unvested part. Service actually rendered stays expensed.
import request from "supertest";
import { app } from "../src/app.js";
import { cumulativeExpenseCents, grantCostCents, servedFraction } from "../src/stockCompensation.js";
import { vestedShares } from "../src/equityAwards.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

// 48,000 shares, $1.00 grant-date fair value, 4-year vest, 1-year cliff.
const AWARD = {
  shares: 48000,
  grantDateFairValueMicros: 1000000,
  vestingStartDate: "2024-01-01",
  vestingMonths: 48,
  cliffMonths: 12,
};

describe("recognition arithmetic", () => {
  test("total cost is fair value times shares, fixed at grant", () => {
    expect(grantCostCents(AWARD)).toBe(4800000); // $48,000
    // An award with no fair value on file costs nothing -- that's how
    // every grant made before this feature existed stays out of the P&L.
    expect(grantCostCents({ ...AWARD, grantDateFairValueMicros: null })).toBe(0);
  });

  // The heart of it.
  test("service accrues through the cliff even though nothing vests", () => {
    // Eleven months in: zero shares vested, but eleven months of service
    // rendered, so 11/48 of the cost is expensed.
    expect(vestedShares(AWARD, "2024-12-01")).toBe(0);
    expect(servedFraction(AWARD, "2024-12-01")).toBeCloseTo(11 / 48, 10);
    expect(cumulativeExpenseCents(AWARD, [], "2024-12-01")).toBe(Math.round(4800000 * (11 / 48)));
  });

  test("expense is straight-line and finishes at the full cost", () => {
    expect(cumulativeExpenseCents(AWARD, [], "2025-01-01")).toBe(1200000); // 12/48
    expect(cumulativeExpenseCents(AWARD, [], "2026-01-01")).toBe(2400000); // 24/48
    expect(cumulativeExpenseCents(AWARD, [], "2028-01-01")).toBe(4800000); // done
    // And stops there -- no expense past the service period.
    expect(cumulativeExpenseCents(AWARD, [], "2030-01-01")).toBe(4800000);
  });

  test("an award with no vesting period is expensed immediately", () => {
    const vested = { ...AWARD, vestingMonths: 0, cliffMonths: 0 };
    expect(servedFraction(vested, "2024-01-01")).toBe(1);
    expect(cumulativeExpenseCents(vested, [], "2024-01-01")).toBe(4800000);
  });

  test("forfeiting unvested shares reverses their expense", () => {
    // Leaves at 24 months: 24,000 vested, 24,000 unvested and cancelled.
    const events = [{ type: "cancel", eventDate: "2026-01-01", shares: 24000 }];

    // Just before, the full 48,000 had 24/48 of its cost recognized.
    expect(cumulativeExpenseCents(AWARD, [], "2025-12-31")).toBe(Math.round(4800000 * (23 / 48)));

    // After: the cost base drops to the 24,000 that survived, and
    // cumulative expense drops with it -- that fall is the reversal.
    const after = cumulativeExpenseCents(AWARD, events, "2026-01-01");
    expect(after).toBe(1200000); // 24,000 shares x $1 x 24/48
    expect(after).toBeLessThan(2400000);
  });

  test("cancelling already-vested shares reverses nothing", () => {
    // An option that expired unexercised four years in. All of it had
    // vested, so all of its cost was real.
    const events = [{ type: "cancel", eventDate: "2028-06-01", shares: 48000 }];
    expect(cumulativeExpenseCents(AWARD, events, "2028-06-01")).toBe(4800000);
  });

  test("events dated after the as-of date don't count yet", () => {
    const events = [{ type: "cancel", eventDate: "2027-01-01", shares: 24000 }];
    // A year before the cancellation it is invisible.
    expect(cumulativeExpenseCents(AWARD, events, "2026-01-01")).toBe(2400000);
    // On the day, it bites -- compared against the same date with no
    // cancellation, not against an earlier month's smaller figure. By
    // month 36 only 12,000 shares were still unvested, so only those
    // forfeit; the other 12,000 cancelled had already been earned.
    expect(cumulativeExpenseCents(AWARD, [], "2027-01-01")).toBe(3600000);
    expect(cumulativeExpenseCents(AWARD, events, "2027-01-01")).toBe(2700000);
  });
});

/* ------------------------------ API tests ------------------------------ */

async function setup(token) {
  const cls = (
    await request(app)
      .post("/api/share-classes")
      .set(authHeader(token))
      .send({ name: "Common", par_value: 0.0001, authorized_shares: 10000000 })
  ).body;
  const holder = (await request(app).post("/api/shareholders").set(authHeader(token)).send({ name: "Grace" })).body;
  const plan = (
    await request(app)
      .post("/api/equity-plans")
      .set(authHeader(token))
      .send({ name: "2024 Stock Plan", share_class_id: cls.id, reserved_shares: 1000000, adopted_date: "2024-01-01" })
  ).body;
  return { cls, holder, plan };
}

function grant(token, plan, holder, body = {}) {
  return request(app)
    .post("/api/equity-awards")
    .set(authHeader(token))
    .send({
      equity_plan_id: plan.id,
      shareholder_id: holder.id,
      grant_date: "2024-01-01",
      shares: 48000,
      strike_price: 0.05,
      grant_date_fair_value: 1,
      vesting_months: 48,
      cliff_months: 12,
      ...body,
    });
}

async function schedule(token, through) {
  return (await request(app).get(`/api/stock-compensation${through ? `?through=${through}` : ""}`).set(authHeader(token))).body;
}

function run(token, through) {
  return request(app).post("/api/stock-compensation/run").set(authHeader(token)).send({ through });
}

async function pl(token, from, to) {
  return (await request(app).get(`/api/statements/profit-and-loss?from=${from}&to=${to}`).set(authHeader(token))).body;
}

describe("the recognition run", () => {
  test("posts a month at a time and lands on the P&L", async () => {
    const token = await signup(app, request);
    const { plan, holder } = await setup(token);
    expect((await grant(token, plan, holder)).status).toBe(201);

    const res = await run(token, "2024-03");
    expect(res.status).toBe(200);
    // Vesting starts 2024-01-01, so Feb and Mar each carry a month of
    // service; January's period ends the day service began, so it is zero
    // and is skipped rather than posted as an empty entry.
    expect(res.body.entries.map((e) => e.period_month)).toEqual(["2024-02", "2024-03"]);

    // $48,000 over 48 months is $1,000 a month.
    const statement = await pl(token, "2024-01-01", "2024-03-31");
    const row = statement.expenses.accounts.find((a) => a.name === "Stock Compensation Expense");
    expect(row.amount).toBe(2000);
  });

  test("credits paid-in capital, moves no cash, and balances", async () => {
    const token = await signup(app, request);
    const { plan, holder } = await setup(token);
    await grant(token, plan, holder);
    await run(token, "2024-12");

    const bs = (await request(app).get("/api/statements/balance-sheet?as_of=2024-12-31").set(authHeader(token))).body;
    expect(bs.balanced).toBe(true);
    // Eleven months of service by 2024-12-31, at $1,000 a month.
    const apic = bs.equity.accounts.find((a) => a.name === "Additional Paid-In Capital");
    expect(apic.amount).toBe(11000);
    // Non-cash: nothing on the asset side moved.
    expect(bs.assets.total).toBe(0);
  });

  test("is idempotent -- a re-run posts nothing twice", async () => {
    const token = await signup(app, request);
    const { plan, holder } = await setup(token);
    await grant(token, plan, holder);

    const first = await run(token, "2024-06");
    expect(first.body.entries.length).toBe(5);

    const second = await run(token, "2024-06");
    expect(second.body.entries).toHaveLength(0);

    // And the schedule says which months are already done.
    const sched = await schedule(token, "2024-06");
    expect(sched.months.every((m) => m.posted)).toBe(true);
    expect(sched.total).toBe(0);
  });

  test("picks up where it left off on a later run", async () => {
    const token = await signup(app, request);
    const { plan, holder } = await setup(token);
    await grant(token, plan, holder);
    await run(token, "2024-06");

    const later = await run(token, "2024-09");
    expect(later.body.entries.map((e) => e.period_month)).toEqual(["2024-07", "2024-08", "2024-09"]);
  });

  test("a grant with no fair value on file is never expensed", async () => {
    const token = await signup(app, request);
    const { plan, holder } = await setup(token);
    // Every award granted before this release looks exactly like this.
    await grant(token, plan, holder, { grant_date_fair_value: null });

    expect((await schedule(token, "2025-12")).months).toHaveLength(0);
    expect((await run(token, "2025-12")).body.entries).toHaveLength(0);
  });

  // The reversal has to be a real credit to expense, not a negative debit:
  // the ledger refuses a line that is neither a debit nor a credit.
  test("a forfeiture posts a credit to expense that reduces the P&L", async () => {
    const token = await signup(app, request);
    const { plan, holder } = await setup(token);
    const award = (await grant(token, plan, holder)).body;
    await run(token, "2025-12");

    const before = await pl(token, "2024-01-01", "2025-12-31");
    const beforeRow = before.expenses.accounts.find((a) => a.name === "Stock Compensation Expense");
    expect(beforeRow.amount).toBe(23000); // 23 months x $1,000

    // Leaves in January 2026 with half the grant unvested.
    const cancel = await request(app)
      .post(`/api/equity-awards/${award.id}/cancel`)
      .set(authHeader(token))
      .send({ event_date: "2026-01-15" });
    expect(cancel.status).toBe(201);

    const res = await run(token, "2026-01");
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    // Negative: the month's charge is outweighed by the reversal.
    expect(res.body.entries[0].amount).toBeLessThan(0);

    const after = await pl(token, "2024-01-01", "2026-01-31");
    const afterRow = after.expenses.accounts.find((a) => a.name === "Stock Compensation Expense");
    expect(afterRow.amount).toBeLessThan(beforeRow.amount);

    const bs = (await request(app).get("/api/statements/balance-sheet?as_of=2026-01-31").set(authHeader(token))).body;
    expect(bs.balanced).toBe(true);
  });
});

describe("the unrecognized-cost disclosure", () => {
  test("splits each award into recognized and still to come", async () => {
    const token = await signup(app, request);
    const { plan, holder } = await setup(token);
    await grant(token, plan, holder);

    const items = (await request(app).get("/api/stock-compensation/awards?as_of=2026-01-01").set(authHeader(token))).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      shares: 48000,
      grant_date_fair_value: 1,
      total_cost: 48000,
      recognized_cost: 24000,
      unrecognized_cost: 24000,
      served_percent: 50,
    });
  });

  test("unrecognized cost never goes negative on a fully forfeited award", async () => {
    const token = await signup(app, request);
    const { plan, holder } = await setup(token);
    const award = (await grant(token, plan, holder)).body;
    await request(app)
      .post(`/api/equity-awards/${award.id}/cancel`)
      .set(authHeader(token))
      .send({ event_date: "2024-06-01" });

    const items = (await request(app).get("/api/stock-compensation/awards?as_of=2026-01-01").set(authHeader(token))).body.items;
    // Cancelled entirely before the cliff, so nothing was ever earned.
    expect(items[0].recognized_cost).toBe(0);
    expect(items[0].unrecognized_cost).toBeGreaterThanOrEqual(0);
  });
});

describe("org isolation", () => {
  test("one org's schedule is invisible to another", async () => {
    const token = await signup(app, request);
    const otherToken = await signup(app, request, { email: "other@example.co", orgName: "Other Org" });
    const { plan, holder } = await setup(token);
    await grant(token, plan, holder);

    expect((await schedule(otherToken, "2025-12")).months).toHaveLength(0);
    expect((await request(app).get("/api/stock-compensation/awards").set(authHeader(otherToken))).body.items).toHaveLength(0);
  });

  test("the endpoints require authentication", async () => {
    for (const path of ["/api/stock-compensation", "/api/stock-compensation/awards"]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
    expect((await request(app).post("/api/stock-compensation/run").send({ through: "2026-01" })).status).toBe(401);
  });
});
