// Personal net worth tracker -- deliberately the one resource in this app
// that isn't AP automation and isn't org-scoped. Every route below keys off
// req.currentUser.id, never req.currentUser.orgId, so a user's accounts are
// theirs alone: invisible to teammates in the same organization, and (note
// the absent requireActivePlan, which every org-data route carries) not
// gated behind the organization's Rekono subscription either -- a lapsed
// plan has nothing to do with whether someone can see their own balances.
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { NetWorthAccount, NetWorthEntry } from "../models/index.js";
import { CATEGORY_KIND, NET_WORTH_CATEGORIES } from "../models/NetWorthAccount.js";
import { serializeNetWorthAccount } from "../serializers.js";

const router = Router();

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function findOwnedAccount(id, userId) {
  return NetWorthAccount.findOne({ where: { id, userId } });
}

// Records a snapshot for the trend chart. Called when an account is created
// and whenever its balance actually changes -- never on a plain rename,
// which isn't a financial event and shouldn't put a kink in the line. A
// second edit on the same calendar day overwrites that day's entry rather
// than adding a second one, so correcting a typo doesn't leave a spike.
async function recordBalance(accountId, balance) {
  const asOfDate = todayIsoDate();
  const [entry] = await NetWorthEntry.findOrCreate({
    where: { accountId, asOfDate },
    defaults: { balance },
  });
  if (entry.balance !== balance) {
    entry.balance = balance;
    await entry.save();
  }
}

// Net worth on every date any account changed, carrying each account's most
// recent balance forward across the dates it didn't change on. Bucketed in
// JS rather than SQL for the same reason routes/dashboard.js's volume trend
// is: this app runs on both SQLite and Postgres, and date-bucketing GROUP BY
// is spelled differently on each.
async function netWorthTrend(userId) {
  const accounts = await NetWorthAccount.findAll({
    where: { userId },
    attributes: ["id", "category"],
    raw: true,
  });
  if (!accounts.length) return [];

  const sign = new Map(accounts.map((a) => [a.id, CATEGORY_KIND[a.category] === "liability" ? -1 : 1]));
  const entries = await NetWorthEntry.findAll({
    where: { accountId: accounts.map((a) => a.id) },
    attributes: ["accountId", "balance", "asOfDate"],
    order: [["asOfDate", "ASC"]],
    raw: true,
  });
  if (!entries.length) return [];

  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.asOfDate)) byDate.set(e.asOfDate, []);
    byDate.get(e.asOfDate).push(e);
  }

  const latest = new Map();
  return [...byDate.keys()].sort().map((date) => {
    for (const e of byDate.get(date)) latest.set(e.accountId, e.balance);
    let total = 0;
    for (const [accountId, balance] of latest) total += balance * (sign.get(accountId) || 1);
    return { date, net_worth: total };
  });
}

router.get("/api/net-worth", requireAuth, async (req, res, next) => {
  try {
    const userId = req.currentUser.id;
    const accounts = await NetWorthAccount.findAll({ where: { userId }, order: [["createdAt", "ASC"]] });

    let totalAssets = 0;
    let totalLiabilities = 0;
    for (const a of accounts) {
      if (CATEGORY_KIND[a.category] === "liability") totalLiabilities += a.currentBalance;
      else totalAssets += a.currentBalance;
    }

    res.json({
      accounts: accounts.map(serializeNetWorthAccount),
      total_assets: totalAssets,
      total_liabilities: totalLiabilities,
      net_worth: totalAssets - totalLiabilities,
      trend: await netWorthTrend(userId),
    });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(256),
  category: z.enum(NET_WORTH_CATEGORIES),
  current_balance: z.number().finite(),
  notes: z.string().max(4000).optional(),
});

router.post("/api/net-worth/accounts", requireAuth, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const { name, category, current_balance: currentBalance, notes } = parsed.data;

    const account = await NetWorthAccount.create({
      userId: req.currentUser.id,
      name,
      category,
      currentBalance,
      notes: notes || "",
    });
    await recordBalance(account.id, currentBalance);

    res.status(201).json(serializeNetWorthAccount(account));
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  category: z.enum(NET_WORTH_CATEGORIES).optional(),
  current_balance: z.number().finite().optional(),
  notes: z.string().max(4000).optional(),
});

router.patch("/api/net-worth/accounts/:id", requireAuth, async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const payload = parsed.data;

    const account = await findOwnedAccount(req.params.id, req.currentUser.id);
    if (!account) return res.status(404).json({ detail: "Account not found" });

    if (payload.name !== undefined) account.name = payload.name;
    if (payload.category !== undefined) account.category = payload.category;
    if (payload.notes !== undefined) account.notes = payload.notes;

    const balanceChanged =
      payload.current_balance !== undefined && payload.current_balance !== account.currentBalance;
    if (balanceChanged) account.currentBalance = payload.current_balance;

    await account.save();
    if (balanceChanged) await recordBalance(account.id, account.currentBalance);

    res.json(serializeNetWorthAccount(account));
  } catch (err) {
    next(err);
  }
});

router.delete("/api/net-worth/accounts/:id", requireAuth, async (req, res, next) => {
  try {
    const account = await findOwnedAccount(req.params.id, req.currentUser.id);
    if (!account) return res.status(404).json({ detail: "Account not found" });
    await account.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
