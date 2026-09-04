import request from "supertest";
import { app } from "../src/app.js";
import {
  Account,
  AuditLog,
  ClosePeriod,
  ClosePeriodSnapshot,
  CloseTask,
  ExpenseReceipt,
  Invoice,
  MatchEntry,
  MatchResult,
  MatchSource,
} from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

const MONTH = "2026-06";
// Comfortably inside MONTH, and before its end boundary.
const IN_PERIOD = new Date(Date.UTC(2026, 5, 15));
// The month AFTER the period -- must not count toward it.
const AFTER_PERIOD = new Date(Date.UTC(2026, 6, 15));
// A straggler from before the period that's still outstanding.
const BEFORE_PERIOD = new Date(Date.UTC(2026, 4, 15));

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function openPeriod(token, periodMonth = MONTH) {
  const res = await request(app)
    .post("/api/close/periods")
    .set(authHeader(token))
    .send({ period_month: periodMonth });
  return res;
}

async function makeInvoice(org, overrides = {}) {
  return Invoice.create({
    orgId: org,
    originalFilename: "invoice.pdf",
    storagePath: "/tmp/x.pdf",
    contentType: "application/pdf",
    status: "extracted",
    vendorName: "Acme Co",
    createdAt: IN_PERIOD,
    ...overrides,
  });
}

function checkFor(body, key) {
  return body.period.readiness.find((c) => c.key === key);
}

describe("periods", () => {
  test("requires authentication", async () => {
    expect((await request(app).get("/api/close")).status).toBe(401);
  });

  test("an org with no periods gets a null period and a suggested month, not a 404", async () => {
    const token = await signup(app, request);
    const res = await request(app).get("/api/close").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.period).toBeNull();
    expect(res.body.suggested_period_month).toMatch(/^\d{4}-\d{2}$/);
  });

  test("opening a period seeds the default checklist", async () => {
    const token = await signup(app, request);
    const res = await openPeriod(token);
    expect(res.status).toBe(201);
    expect(res.body.period.period_month).toBe(MONTH);
    expect(res.body.period.status).toBe("open");
    expect(res.body.period.tasks.length).toBeGreaterThan(0);
    expect(res.body.period.tasks.every((t) => t.done === false)).toBe(true);
    // Seeded in a deliberate working order.
    expect(res.body.period.tasks.map((t) => t.position)).toEqual(
      res.body.period.tasks.map((_, i) => i)
    );
    expect(res.body.period.tasks_remaining).toBe(res.body.period.tasks.length);
  });

  test("rejects a malformed period month", async () => {
    const token = await signup(app, request);
    expect((await openPeriod(token, "June 2026")).status).toBe(422);
    expect((await openPeriod(token, "2026-13")).status).toBe(422);
  });

  test("will not open the same month twice", async () => {
    const token = await signup(app, request);
    expect((await openPeriod(token)).status).toBe(201);
    const dup = await openPeriod(token);
    expect(dup.status).toBe(409);
  });

  test("closing records who closed it and what was still outstanding", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org, { status: "needs_review" });
    const opened = await openPeriod(token);

    const res = await request(app)
      .post(`/api/close/periods/${opened.body.period.id}/close`)
      .set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.period.status).toBe("closed");
    expect(res.body.period.closed_by).toBeTruthy();
    expect(res.body.period.closed_at).toBeTruthy();

    // Closing with a known exception is allowed, but the exception has to
    // be on the record rather than silently invisible.
    const entry = await AuditLog.findOne({ where: { action: "close_period_closed" } });
    expect(entry.details.period_month).toBe(MONTH);
    expect(entry.details.tasks_remaining).toBeGreaterThan(0);
    expect(entry.details.outstanding).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "invoices_reviewed", count: 1 })])
    );
  });

  test("cannot close twice, and can reopen", async () => {
    const token = await signup(app, request);
    const opened = await openPeriod(token);
    const id = opened.body.period.id;

    await request(app).post(`/api/close/periods/${id}/close`).set(authHeader(token));
    expect((await request(app).post(`/api/close/periods/${id}/close`).set(authHeader(token))).status).toBe(409);

    const reopened = await request(app).post(`/api/close/periods/${id}/reopen`).set(authHeader(token));
    expect(reopened.status).toBe(200);
    expect(reopened.body.period.status).toBe("open");
    expect(reopened.body.period.closed_by).toBeNull();
    expect(await AuditLog.count({ where: { action: "close_period_reopened" } })).toBe(1);
  });

  test("reopening something that was never closed is rejected", async () => {
    const token = await signup(app, request);
    const opened = await openPeriod(token);
    const res = await request(app)
      .post(`/api/close/periods/${opened.body.period.id}/reopen`)
      .set(authHeader(token));
    expect(res.status).toBe(409);
  });
});

describe("tasks", () => {
  test("ticking a task records who completed it and when; un-ticking clears it", async () => {
    const token = await signup(app, request);
    const opened = await openPeriod(token);
    const taskId = opened.body.period.tasks[0].id;

    const done = await request(app).patch(`/api/close/tasks/${taskId}`).set(authHeader(token)).send({ done: true });
    expect(done.status).toBe(200);
    expect(done.body.done).toBe(true);
    expect(done.body.completed_by).toBeTruthy();
    expect(done.body.completed_at).toBeTruthy();

    // A re-completed task must not carry a stale attestation from the
    // first time it was ticked.
    const undone = await request(app).patch(`/api/close/tasks/${taskId}`).set(authHeader(token)).send({ done: false });
    expect(undone.body.done).toBe(false);
    expect(undone.body.completed_by).toBeNull();
    expect(undone.body.completed_at).toBeNull();
  });

  test("tasks can be added, renamed, and deleted", async () => {
    const token = await signup(app, request);
    const opened = await openPeriod(token);
    const periodId = opened.body.period.id;
    const seeded = opened.body.period.tasks.length;

    const added = await request(app)
      .post(`/api/close/periods/${periodId}/tasks`)
      .set(authHeader(token))
      .send({ title: "Chase the missing utility bill" });
    expect(added.status).toBe(201);
    expect(added.body.position).toBe(seeded); // appended, not inserted

    const renamed = await request(app)
      .patch(`/api/close/tasks/${added.body.id}`)
      .set(authHeader(token))
      .send({ title: "Chase the missing utility bill (Q3)" });
    expect(renamed.body.title).toBe("Chase the missing utility bill (Q3)");

    expect((await request(app).delete(`/api/close/tasks/${added.body.id}`).set(authHeader(token))).status).toBe(200);
    const after = await request(app).get(`/api/close?period_month=${MONTH}`).set(authHeader(token));
    expect(after.body.period.tasks).toHaveLength(seeded);
  });

  test("a closed period's checklist is frozen until it is reopened", async () => {
    const token = await signup(app, request);
    const opened = await openPeriod(token);
    const periodId = opened.body.period.id;
    const taskId = opened.body.period.tasks[0].id;
    await request(app).post(`/api/close/periods/${periodId}/close`).set(authHeader(token));

    expect((await request(app).patch(`/api/close/tasks/${taskId}`).set(authHeader(token)).send({ done: true })).status).toBe(409);
    expect((await request(app).delete(`/api/close/tasks/${taskId}`).set(authHeader(token))).status).toBe(409);
    expect(
      (await request(app).post(`/api/close/periods/${periodId}/tasks`).set(authHeader(token)).send({ title: "late addition" })).status
    ).toBe(409);

    await request(app).post(`/api/close/periods/${periodId}/reopen`).set(authHeader(token));
    expect((await request(app).patch(`/api/close/tasks/${taskId}`).set(authHeader(token)).send({ done: true })).status).toBe(200);
  });

  test("rejects an empty title", async () => {
    const token = await signup(app, request);
    const opened = await openPeriod(token);
    const res = await request(app)
      .post(`/api/close/periods/${opened.body.period.id}/tasks`)
      .set(authHeader(token))
      .send({ title: "" });
    expect(res.status).toBe(422);
  });
});

describe("readiness checks", () => {
  test("a clean org passes every check", async () => {
    const token = await signup(app, request);
    const res = await openPeriod(token);
    expect(res.body.period.readiness.every((c) => c.ok)).toBe(true);
    expect(res.body.period.blocking_count).toBe(0);
  });

  test("outstanding work across document types blocks the close", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org, { status: "needs_review" });
    await makeInvoice(org, { status: "failed" });
    await makeInvoice(org, { status: "processing" });
    await ExpenseReceipt.create({
      orgId: org,
      originalFilename: "r.pdf",
      storagePath: "/tmp/x.pdf",
      contentType: "application/pdf",
      status: "needs_review",
      merchantName: "Cafe",
      createdAt: IN_PERIOD,
    });

    const res = await openPeriod(token);
    expect(checkFor(res.body, "invoices_reviewed")).toMatchObject({ count: 1, ok: false });
    expect(checkFor(res.body, "no_failures")).toMatchObject({ count: 1, ok: false });
    expect(checkFor(res.body, "nothing_in_flight")).toMatchObject({ count: 1, ok: false });
    expect(checkFor(res.body, "expenses_reviewed")).toMatchObject({ count: 1, ok: false });
    expect(res.body.period.blocking_count).toBe(4);
  });

  // The window is "everything up to period end", not "only this month" --
  // an unreviewed straggler from May blocks an honest June close too.
  test("an unresolved item from an earlier month still blocks", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org, { status: "needs_review", createdAt: BEFORE_PERIOD });

    const res = await openPeriod(token);
    expect(checkFor(res.body, "invoices_reviewed")).toMatchObject({ count: 1, ok: false });
  });

  test("work created after the period ends does not block it", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org, { status: "needs_review", createdAt: AFTER_PERIOD });

    const res = await openPeriod(token);
    expect(checkFor(res.body, "invoices_reviewed")).toMatchObject({ count: 0, ok: true });
  });

  test("approved invoices with no matched result are flagged as unreconciled", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const matched = await makeInvoice(org, { status: "approved" });
    await makeInvoice(org, { status: "approved" }); // no match result
    const source = await MatchSource.create({ orgId: org, name: "po.csv", sourceType: "po" });
    const entry = await MatchEntry.create({ sourceId: source.id, vendor: "Acme Co", amount: 10 });
    await MatchResult.create({ invoiceId: matched.id, matchEntryId: entry.id, status: "matched", score: 99 });

    const res = await openPeriod(token);
    expect(checkFor(res.body, "all_matched")).toMatchObject({ count: 1, ok: false });
  });

  test("pending auto-approval spot-checks block the close", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeInvoice(org, { status: "approved", sampledForQa: true, qaReviewedAt: null });

    const res = await openPeriod(token);
    expect(checkFor(res.body, "qa_cleared")).toMatchObject({ count: 1, ok: false });
  });

  test("readiness is recomputed on read, not frozen at open time", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const opened = await openPeriod(token);
    expect(checkFor(opened.body, "invoices_reviewed").ok).toBe(true);

    // A stored flag would still say "all reviewed" here; a derived one
    // must not.
    await makeInvoice(org, { status: "needs_review" });
    const reread = await request(app).get(`/api/close?period_month=${MONTH}`).set(authHeader(token));
    expect(checkFor(reread.body, "invoices_reviewed")).toMatchObject({ count: 1, ok: false });
  });
});

describe("org isolation", () => {
  test("never sees, or is blocked by, another org's data", async () => {
    const mine = await signup(app, request, { email: "mine@example.co" });
    const theirs = await signup(app, request, { email: "theirs@example.co", orgName: "Other Co" });
    const theirOrg = await orgId(theirs);
    await makeInvoice(theirOrg, { status: "needs_review" });

    const res = await openPeriod(mine);
    expect(checkFor(res.body, "invoices_reviewed")).toMatchObject({ count: 0, ok: true });

    const theirPeriod = await openPeriod(theirs);
    // Same month, different orgs -- the unique constraint is per-org.
    expect(theirPeriod.status).toBe(201);

    // And neither can touch the other's period or tasks.
    expect(
      (await request(app).post(`/api/close/periods/${theirPeriod.body.period.id}/close`).set(authHeader(mine))).status
    ).toBe(404);
    expect(
      (await request(app)
        .patch(`/api/close/tasks/${theirPeriod.body.period.tasks[0].id}`)
        .set(authHeader(mine))
        .send({ done: true })).status
    ).toBe(404);
  });

  test("the period list only shows the caller's own periods", async () => {
    const mine = await signup(app, request, { email: "mine2@example.co" });
    const theirs = await signup(app, request, { email: "theirs2@example.co", orgName: "Other Co" });
    await openPeriod(mine, "2026-01");
    await openPeriod(theirs, "2026-02");

    const res = await request(app).get("/api/close/periods").set(authHeader(mine));
    expect(res.body.map((p) => p.period_month)).toEqual(["2026-01"]);
  });
});

describe("deleting a period", () => {
  test("takes its tasks and snapshots with it", async () => {
    const token = await signup(app, request);
    const opened = await openPeriod(token);
    await request(app).post(`/api/close/periods/${opened.body.period.id}/close`).set(authHeader(token));
    expect(await CloseTask.count()).toBeGreaterThan(0);
    expect(await ClosePeriodSnapshot.count()).toBeGreaterThan(0);
    await ClosePeriod.destroy({ where: { id: opened.body.period.id }, individualHooks: true });
    expect(await CloseTask.count()).toBe(0);
    expect(await ClosePeriodSnapshot.count()).toBe(0);
  });
});

describe("trial-balance snapshots", () => {
  async function twoAccounts(org) {
    const cash = await Account.create({ orgId: org, code: "1000", name: "Cash", type: "asset" });
    const revenue = await Account.create({ orgId: org, code: "4000", name: "Consulting Revenue", type: "revenue" });
    return { cash, revenue };
  }

  function postEntry(token, entryDate, cashId, revenueId, dollars) {
    return request(app)
      .post("/api/journal-entries")
      .set(authHeader(token))
      .send({
        entry_date: entryDate,
        memo: "test entry",
        lines: [
          { account_id: cashId, debit: dollars },
          { account_id: revenueId, credit: dollars },
        ],
      });
  }

  test("closing a period freezes a trial balance snapshot", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const { cash, revenue } = await twoAccounts(org);
    await postEntry(token, "2026-06-10", cash.id, revenue.id, 500);

    const opened = await openPeriod(token);
    const closed = await request(app)
      .post(`/api/close/periods/${opened.body.period.id}/close`)
      .set(authHeader(token));
    expect(closed.body.period.snapshot_count).toBe(1);

    const list = await request(app)
      .get(`/api/close/periods/${opened.body.period.id}/snapshots`)
      .set(authHeader(token));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ balanced: true, total_debit: 500, total_credit: 500 });

    const detail = await request(app)
      .get(`/api/close/periods/${opened.body.period.id}/snapshots/${list.body.items[0].id}`)
      .set(authHeader(token));
    expect(detail.body.accounts.find((a) => a.account_id === cash.id)).toMatchObject({ debit: 500, credit: 0 });
    expect(detail.body.accounts.find((a) => a.account_id === revenue.id)).toMatchObject({ debit: 0, credit: 500 });
  });

  test("a single close has nothing to diff against", async () => {
    const token = await signup(app, request);
    const opened = await openPeriod(token);
    await request(app).post(`/api/close/periods/${opened.body.period.id}/close`).set(authHeader(token));

    const diff = await request(app)
      .get(`/api/close/periods/${opened.body.period.id}/snapshots/diff`)
      .set(authHeader(token));
    expect(diff.body).toEqual({ available: false, snapshot_count: 1 });
  });

  // The scenario the roadmap gap was actually about: a late adjusting entry
  // lands after a period closed, the controller reopens and re-closes to
  // pick it up, and now there are two attestations to compare.
  test("re-closing after a late entry shows exactly what changed", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const { cash, revenue } = await twoAccounts(org);
    await postEntry(token, "2026-06-10", cash.id, revenue.id, 500);

    const opened = await openPeriod(token);
    const periodId = opened.body.period.id;
    await request(app).post(`/api/close/periods/${periodId}/close`).set(authHeader(token));

    await request(app).post(`/api/close/periods/${periodId}/reopen`).set(authHeader(token));
    await postEntry(token, "2026-06-20", cash.id, revenue.id, 200);
    const reclosed = await request(app).post(`/api/close/periods/${periodId}/close`).set(authHeader(token));
    expect(reclosed.body.period.snapshot_count).toBe(2);

    const diff = await request(app)
      .get(`/api/close/periods/${periodId}/snapshots/diff`)
      .set(authHeader(token));
    expect(diff.body.available).toBe(true);
    expect(diff.body.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_id: cash.id, previous_balance: 500, current_balance: 700, delta: 200 }),
        expect.objectContaining({ account_id: revenue.id, previous_balance: -500, current_balance: -700, delta: -200 }),
      ])
    );
    // Only the two accounts that actually moved show up as changes -- the
    // rest of the org's default chart of accounts (present, but untouched)
    // is exactly what unchanged_count is counting.
    expect(diff.body.changes).toHaveLength(2);
  });

  test("snapshots and their diff are org-isolated", async () => {
    const mine = await signup(app, request, { email: "snap-mine@example.co" });
    const theirs = await signup(app, request, { email: "snap-theirs@example.co", orgName: "Other Co" });
    const theirPeriod = await openPeriod(theirs, "2026-07");
    await request(app).post(`/api/close/periods/${theirPeriod.body.period.id}/close`).set(authHeader(theirs));

    expect(
      (await request(app).get(`/api/close/periods/${theirPeriod.body.period.id}/snapshots`).set(authHeader(mine)))
        .status
    ).toBe(404);
    expect(
      (
        await request(app)
          .get(`/api/close/periods/${theirPeriod.body.period.id}/snapshots/diff`)
          .set(authHeader(mine))
      ).status
    ).toBe(404);
  });
});
