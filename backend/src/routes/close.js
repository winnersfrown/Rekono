// Month-end close: the recurring checklist a finance team works through to
// sign off on a month's books.
//
// Deliberately not a generic to-do list. A close checklist is only worth
// having inside Rekono if it can answer the questions Rekono already knows
// the answer to -- "is everything actually reviewed?", "is anything still
// stuck mid-extraction?", "is any approved spend still unreconciled?" --
// so a period has two halves:
//
//   * readiness checks (below): recomputed from live data on every read,
//     never stored. A stored "done" flag for "all invoices reviewed" would
//     be wrong the moment someone uploads another invoice, so these are
//     derived, not ticked.
//   * manual tasks (CloseTask): the judgment work a human does and then
//     attests to. Seeded from a template, fully editable.
//
// A third thing happens at the moment of closing, not on every read: a
// ClosePeriodSnapshot freezes the trial balance as of period end. See
// ClosePeriodSnapshot.js for why that has to be a new row per close rather
// than a field on ClosePeriod itself.

import { Router } from "express";
import { suggestionsFor } from "../closeAutomation.js";
import { computeTrialBalance, centsToDollars, dollarsToCents } from "../ledger.js";
import { Op } from "sequelize";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import {
  AuditLog,
  ClosePeriod,
  ClosePeriodSnapshot,
  CloseTask,
  ExpenseReceipt,
  Invoice,
  MatchResult,
  VendorDocument,
} from "../models/index.js";

const router = Router();

const PERIOD_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Seeded into a newly opened period. Scoped to what an AP-centric close
// actually involves, and deliberately excludes anything the readiness
// checks already verify automatically -- a manual "review all invoices"
// checkbox next to an automatic one that measures the same thing is just
// an invitation to tick the box while the real number says otherwise.
// Exported for demoSeed.js, which opens a close period for the sandbox --
// a second copy of this list would drift from the real one silently.
export const DEFAULT_CLOSE_TASKS = [
  "Reconcile bank statements to the general ledger",
  "Post accruals for goods received but not yet invoiced",
  "Review aged payables and follow up on anything overdue",
  "Reconcile vendor statements to recorded balances",
  "Review prepaid expenses and amortization schedules",
  "Final review and sign-off with the controller",
];

const createPeriodSchema = z.object({
  period_month: z.string().regex(PERIOD_MONTH_RE, "period_month must be YYYY-MM"),
});
const createTaskSchema = z.object({ title: z.string().min(1).max(512) });
const updateTaskSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  done: z.boolean().optional(),
});

function currentPeriodMonth() {
  return new Date().toISOString().slice(0, 7);
}

// Exclusive upper bound for a period: the first instant of the following
// month, in UTC. Everything created strictly before this belongs to the
// period being closed.
function endOfPeriod(periodMonth) {
  const [year, month] = periodMonth.split("-").map(Number);
  return new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));
}

// The last calendar day of the period, as a "YYYY-MM-DD" string -- what the
// trial balance snapshot is taken as-of, independent of which day the close
// button actually got clicked.
function lastDayOfPeriod(periodMonth) {
  return new Date(endOfPeriod(periodMonth).getTime() - 86400000).toISOString().slice(0, 10);
}

// Freezes the trial balance as of period end and stores it as a new
// snapshot row. Called once per close (including every re-close), never
// updated afterwards -- see ClosePeriodSnapshot.js for why history, not a
// single overwritten field, is the point.
//
// computeTrialBalance returns dollars (it's meant for direct API display);
// converted back to cents here for storage, per this repo's ledger
// convention. The round trip is lossless -- the dollars it returns were
// themselves centsToDollars(cents) on an integer, so dollarsToCents undoes
// exactly that division.
async function snapshotTrialBalance(period, closedBy) {
  const asOfDate = lastDayOfPeriod(period.periodMonth);
  const tb = await computeTrialBalance(period.orgId, asOfDate);
  return ClosePeriodSnapshot.create({
    orgId: period.orgId,
    closePeriodId: period.id,
    asOfDate,
    closedAt: period.closedAt,
    closedBy,
    accounts: tb.accounts.map((a) => ({
      account_id: a.account_id,
      code: a.code,
      name: a.name,
      type: a.type,
      debit_cents: dollarsToCents(a.debit),
      credit_cents: dollarsToCents(a.credit),
    })),
    totalDebitCents: dollarsToCents(tb.total_debit),
    totalCreditCents: dollarsToCents(tb.total_credit),
    balanced: tb.balanced,
  });
}

// Net cents for one snapshot account row -- debit-normal accounts show
// positive here, credit-normal show negative, which is exactly the
// direction that makes a delta of 0 mean "genuinely unchanged" regardless
// of which side of the ledger the account lives on.
function netCents(row) {
  return row.debit_cents - row.credit_cents;
}

// The automatic half of the checklist. Every check counts things that must
// be at zero before a month can honestly be signed off.
//
// Scoped to everything created before the period ends, NOT just within the
// period's own month: a straggler from July that's still sitting in the
// review queue blocks an honest August close just as much as an August one
// does, and silently ignoring it would make the checklist lie.
async function readinessChecks(orgId, periodMonth) {
  const before = { [Op.lt]: endOfPeriod(periodMonth) };
  const scope = { orgId, createdAt: before };

  const [needsReview, receiptsNeedReview, inFlight, failed, qaPending, approvedInvoices, expiredVendorDocs] =
    await Promise.all([
      Invoice.count({ where: { ...scope, status: "needs_review" } }),
      ExpenseReceipt.count({ where: { ...scope, status: "needs_review" } }),
      Invoice.count({ where: { ...scope, status: { [Op.in]: ["queued", "processing"] } } }),
      Invoice.count({ where: { ...scope, status: "failed" } }),
      Invoice.count({ where: { ...scope, sampledForQa: true, qaReviewedAt: null } }),
      Invoice.findAll({ where: { ...scope, status: "approved" }, attributes: ["id"], raw: true }),
      VendorDocument.count({
        where: {
          orgId,
          status: { [Op.ne]: "rejected" },
          expirationDate: { [Op.ne]: null, [Op.lt]: endOfPeriod(periodMonth).toISOString().slice(0, 10) },
        },
      }),
    ]);

  // Approved spend with no matched reconciliation result. Same id-set
  // approach (rather than a NOT EXISTS subquery) as routes/dashboard.js,
  // for the same cross-dialect reason.
  let unmatched = 0;
  if (approvedInvoices.length) {
    const matched = await MatchResult.findAll({
      where: { invoiceId: approvedInvoices.map((i) => i.id), status: "matched" },
      attributes: ["invoiceId"],
      raw: true,
    });
    const matchedIds = new Set(matched.map((m) => m.invoiceId));
    unmatched = approvedInvoices.filter((i) => !matchedIds.has(i.id)).length;
  }

  const check = (key, label, count, tab) => ({ key, label, count, ok: count === 0, tab });

  return [
    check("invoices_reviewed", "Invoices still awaiting review", needsReview, "review"),
    check("expenses_reviewed", "Expense receipts still awaiting review", receiptsNeedReview, "expenses"),
    check("nothing_in_flight", "Documents still extracting", inFlight, "review"),
    check("no_failures", "Extractions that failed and need a retry", failed, "review"),
    check("all_matched", "Approved invoices not yet reconciled", unmatched, "matching"),
    check("qa_cleared", "Auto-approval spot-checks still pending", qaPending, "settings"),
    check("vendor_docs_current", "Vendor documents expired as of period end", expiredVendorDocs, "vendordocs"),
  ];
}

function serializeTask(t) {
  return {
    id: t.id,
    title: t.title,
    done: t.done,
    completed_at: t.completedAt,
    completed_by: t.completedBy,
    position: t.position,
  };
}

async function buildPeriodResponse(period) {
  const [tasks, checks, snapshotCount] = await Promise.all([
    CloseTask.findAll({ where: { closePeriodId: period.id }, order: [["position", "ASC"]] }),
    readinessChecks(period.orgId, period.periodMonth),
    ClosePeriodSnapshot.count({ where: { closePeriodId: period.id } }),
  ]);
  return {
    id: period.id,
    period_month: period.periodMonth,
    status: period.status,
    closed_at: period.closedAt,
    closed_by: period.closedBy,
    tasks: tasks.map(serializeTask),
    readiness: checks,
    // Precomputed so the frontend and any future consumer agree on what
    // "ready" means rather than each re-deriving it.
    tasks_remaining: tasks.filter((t) => !t.done).length,
    blocking_count: checks.filter((c) => !c.ok).length,
    // How many times this period has been closed (1, or more after a
    // reopen/re-close cycle) -- the frontend uses this to decide whether a
    // "what changed since last close" diff is even possible to show.
    snapshot_count: snapshotCount,
  };
}

async function findOwnedPeriod(id, orgId) {
  return ClosePeriod.findOne({ where: { id, orgId } });
}

// Lists every period the org has ever opened, newest first -- the history
// of closed months is itself the record auditors ask for.
router.get("/api/close/periods", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const periods = await ClosePeriod.findAll({
      where: { orgId: req.currentUser.orgId },
      order: [["periodMonth", "DESC"]],
    });
    res.json(
      periods.map((p) => ({
        id: p.id,
        period_month: p.periodMonth,
        status: p.status,
        closed_at: p.closedAt,
        closed_by: p.closedBy,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// The period the UI opens on: an explicit ?period_month=, else the current
// calendar month if it's been opened, else the most recent period. Returns
// null (not a 404) when the org has never opened one -- "no periods yet" is
// an empty state to render, not an error.
// Ledger-derived suggestions for one period. Separate from
// /api/close because they scan journal lines across a five-month window,
// which is a heavier read than the checklist and isn't wanted on every
// dashboard poll.
router.get("/api/close/suggestions", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.period_month || "") ? req.query.period_month : null;
    if (!month) return res.status(422).json({ detail: "period_month must be YYYY-MM." });
    res.json({ items: await suggestionsFor(req.currentUser.orgId, month) });
  } catch (err) {
    next(err);
  }
});

router.get("/api/close", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const requested = req.query.period_month;
    if (requested !== undefined && !PERIOD_MONTH_RE.test(requested)) {
      return res.status(422).json({ detail: "period_month must be YYYY-MM" });
    }

    const orgId = req.currentUser.orgId;
    const period =
      (requested
        ? await ClosePeriod.findOne({ where: { orgId, periodMonth: requested } })
        : await ClosePeriod.findOne({ where: { orgId, periodMonth: currentPeriodMonth() } })) ||
      (requested ? null : await ClosePeriod.findOne({ where: { orgId }, order: [["periodMonth", "DESC"]] }));

    if (!period) {
      return res.json({ period: null, suggested_period_month: currentPeriodMonth() });
    }
    res.json({ period: await buildPeriodResponse(period) });
  } catch (err) {
    next(err);
  }
});

router.post("/api/close/periods", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = createPeriodSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const orgId = req.currentUser.orgId;
    const periodMonth = parsed.data.period_month;

    const existing = await ClosePeriod.findOne({ where: { orgId, periodMonth } });
    if (existing) {
      return res.status(409).json({ detail: `A close period for ${periodMonth} already exists.` });
    }

    const period = await ClosePeriod.create({ orgId, periodMonth });
    await CloseTask.bulkCreate(
      DEFAULT_CLOSE_TASKS.map((title, i) => ({ closePeriodId: period.id, orgId, title, position: i }))
    );
    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "close_period_opened",
      actor: req.currentUser.email,
      details: { period_month: periodMonth },
    });

    res.status(201).json({ period: await buildPeriodResponse(period) });
  } catch (err) {
    next(err);
  }
});

router.post("/api/close/periods/:id/close", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const period = await findOwnedPeriod(req.params.id, req.currentUser.orgId);
    if (!period) return res.status(404).json({ detail: "Close period not found" });
    if (period.status === "closed") {
      return res.status(409).json({ detail: "This period is already closed." });
    }

    // Deliberately not blocked on outstanding items. A close is a human
    // attestation, and there are legitimate reasons to sign off with a
    // known exception; what matters is that the exception is on the record
    // rather than silently invisible -- so whatever was still outstanding
    // is captured in the audit entry at the moment of closing.
    const [tasksRemaining, checks] = await Promise.all([
      CloseTask.count({ where: { closePeriodId: period.id, done: false } }),
      readinessChecks(period.orgId, period.periodMonth),
    ]);
    const blocking = checks.filter((c) => !c.ok);

    period.status = "closed";
    period.closedAt = new Date();
    period.closedBy = req.currentUser.email;
    await period.save();

    const snapshot = await snapshotTrialBalance(period, req.currentUser.email);

    await AuditLog.create({
      orgId: period.orgId,
      userId: req.currentUser.id,
      action: "close_period_closed",
      actor: req.currentUser.email,
      details: {
        period_month: period.periodMonth,
        tasks_remaining: tasksRemaining,
        outstanding: blocking.map((c) => ({ check: c.key, count: c.count })),
        snapshot_id: snapshot.id,
      },
    });

    res.json({ period: await buildPeriodResponse(period) });
  } catch (err) {
    next(err);
  }
});

router.post("/api/close/periods/:id/reopen", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const period = await findOwnedPeriod(req.params.id, req.currentUser.orgId);
    if (!period) return res.status(404).json({ detail: "Close period not found" });
    if (period.status !== "closed") {
      return res.status(409).json({ detail: "This period isn't closed." });
    }

    period.status = "open";
    period.closedAt = null;
    period.closedBy = null;
    await period.save();

    await AuditLog.create({
      orgId: period.orgId,
      userId: req.currentUser.id,
      action: "close_period_reopened",
      actor: req.currentUser.email,
      details: { period_month: period.periodMonth },
    });

    res.json({ period: await buildPeriodResponse(period) });
  } catch (err) {
    next(err);
  }
});

// The diff between the two most recent snapshots -- what a re-close
// actually changed. Registered before the /:snapshotId route below so
// "diff" is never swallowed as a snapshot id.
router.get("/api/close/periods/:id/snapshots/diff", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const period = await findOwnedPeriod(req.params.id, req.currentUser.orgId);
    if (!period) return res.status(404).json({ detail: "Close period not found" });

    const snapshots = await ClosePeriodSnapshot.findAll({
      where: { closePeriodId: period.id },
      order: [["createdAt", "ASC"]],
    });
    if (snapshots.length < 2) {
      return res.json({ available: false, snapshot_count: snapshots.length });
    }

    const previous = snapshots[snapshots.length - 2];
    const current = snapshots[snapshots.length - 1];

    // Keyed by account_id rather than assuming both snapshots list the same
    // accounts in the same order -- an account created (or its first
    // activity posted) between the two closes only appears in the later one.
    const byAccount = new Map();
    for (const row of previous.accounts) {
      byAccount.set(row.account_id, { account: row, previousCents: netCents(row), currentCents: 0 });
    }
    for (const row of current.accounts) {
      const existing = byAccount.get(row.account_id);
      if (existing) {
        existing.account = row;
        existing.currentCents = netCents(row);
      } else {
        byAccount.set(row.account_id, { account: row, previousCents: 0, currentCents: netCents(row) });
      }
    }

    const changes = [...byAccount.values()]
      .map(({ account, previousCents, currentCents }) => ({
        account_id: account.account_id,
        code: account.code,
        name: account.name,
        type: account.type,
        previous_balance: centsToDollars(previousCents),
        current_balance: centsToDollars(currentCents),
        delta: centsToDollars(currentCents - previousCents),
      }))
      .filter((r) => r.delta !== 0)
      .sort((a, b) => a.code.localeCompare(b.code));

    res.json({
      available: true,
      previous: { closed_at: previous.closedAt, closed_by: previous.closedBy },
      current: { closed_at: current.closedAt, closed_by: current.closedBy },
      changes,
      unchanged_count: byAccount.size - changes.length,
    });
  } catch (err) {
    next(err);
  }
});

// Every snapshot taken for this period, oldest first -- the close history a
// re-closed period otherwise has no record of at all.
router.get("/api/close/periods/:id/snapshots", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const period = await findOwnedPeriod(req.params.id, req.currentUser.orgId);
    if (!period) return res.status(404).json({ detail: "Close period not found" });

    const snapshots = await ClosePeriodSnapshot.findAll({
      where: { closePeriodId: period.id },
      order: [["createdAt", "ASC"]],
    });
    res.json({
      items: snapshots.map((s) => ({
        id: s.id,
        as_of: s.asOfDate,
        closed_at: s.closedAt,
        closed_by: s.closedBy,
        total_debit: centsToDollars(s.totalDebitCents),
        total_credit: centsToDollars(s.totalCreditCents),
        balanced: s.balanced,
        account_count: s.accounts.length,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// The full frozen trial balance for one specific close.
router.get("/api/close/periods/:id/snapshots/:snapshotId", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const period = await findOwnedPeriod(req.params.id, req.currentUser.orgId);
    if (!period) return res.status(404).json({ detail: "Close period not found" });

    const snapshot = await ClosePeriodSnapshot.findOne({
      where: { id: req.params.snapshotId, closePeriodId: period.id },
    });
    if (!snapshot) return res.status(404).json({ detail: "Snapshot not found" });

    res.json({
      id: snapshot.id,
      as_of: snapshot.asOfDate,
      closed_at: snapshot.closedAt,
      closed_by: snapshot.closedBy,
      total_debit: centsToDollars(snapshot.totalDebitCents),
      total_credit: centsToDollars(snapshot.totalCreditCents),
      balanced: snapshot.balanced,
      accounts: snapshot.accounts.map((a) => ({
        account_id: a.account_id,
        code: a.code,
        name: a.name,
        type: a.type,
        debit: centsToDollars(a.debit_cents),
        credit: centsToDollars(a.credit_cents),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// A closed period is a signed attestation -- editing its checklist after
// the fact would rewrite what was attested to. Reopen it first, which
// leaves its own audit entry.
async function loadEditableTask(taskId, orgId) {
  const task = await CloseTask.findOne({ where: { id: taskId, orgId } });
  if (!task) return { error: { status: 404, detail: "Task not found" } };
  const period = await ClosePeriod.findByPk(task.closePeriodId);
  if (period.status === "closed") {
    return { error: { status: 409, detail: "This period is closed. Reopen it to change its checklist." } };
  }
  return { task, period };
}

router.post("/api/close/periods/:id/tasks", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const period = await findOwnedPeriod(req.params.id, req.currentUser.orgId);
    if (!period) return res.status(404).json({ detail: "Close period not found" });
    if (period.status === "closed") {
      return res.status(409).json({ detail: "This period is closed. Reopen it to change its checklist." });
    }

    const maxPosition = await CloseTask.max("position", { where: { closePeriodId: period.id } });
    const task = await CloseTask.create({
      closePeriodId: period.id,
      orgId: period.orgId,
      title: parsed.data.title,
      position: (Number.isFinite(maxPosition) ? maxPosition : -1) + 1,
    });

    res.status(201).json(serializeTask(task));
  } catch (err) {
    next(err);
  }
});

router.patch("/api/close/tasks/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = updateTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const { task, error } = await loadEditableTask(req.params.id, req.currentUser.orgId);
    if (error) return res.status(error.status).json({ detail: error.detail });

    if (parsed.data.title !== undefined) task.title = parsed.data.title;
    if (parsed.data.done !== undefined && parsed.data.done !== task.done) {
      task.done = parsed.data.done;
      // Who ticked it and when is the point of a close checklist -- cleared
      // on un-ticking so a re-completed task never carries a stale
      // attestation from the first time around.
      task.completedAt = parsed.data.done ? new Date() : null;
      task.completedBy = parsed.data.done ? req.currentUser.email : null;
    }
    await task.save();

    res.json(serializeTask(task));
  } catch (err) {
    next(err);
  }
});

router.delete("/api/close/tasks/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const { task, error } = await loadEditableTask(req.params.id, req.currentUser.orgId);
    if (error) return res.status(error.status).json({ detail: error.detail });
    await task.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
