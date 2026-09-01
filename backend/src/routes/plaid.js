// Live bank-account connections for reconciliation, via Plaid Link. The
// frontend widget (public/app.js's connectPlaidAccount) handles the actual
// bank-login UI itself; this module only ever sees a link_token (handed to
// the widget) and, on success, a public_token (exchanged here for a
// long-lived access_token). See plaid.js for the Plaid API calls
// themselves and models/BankConnection.js + models/BankAccount.js for what
// gets stored.
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { settings } from "../config.js";
import * as plaid from "../plaid.js";
import { AuditLog, BankAccount, BankConnection, MatchEntry, MatchSource } from "../models/index.js";
import { serializeBankConnection } from "../serializers.js";

const router = Router();

function requirePlaidConfigured(req, res, next) {
  if (!plaid.plaidConfigured()) {
    return res.status(503).json({ detail: "Bank connections aren't configured yet. Please contact us to enable it." });
  }
  next();
}

router.get("/api/integrations/plaid/status", requireAuth, requireActivePlan, (req, res) => {
  res.json({ configured: plaid.plaidConfigured() });
});

router.post(
  "/api/integrations/plaid/link-token",
  requireAuth,
  requireActivePlan,
  requirePlaidConfigured,
  async (req, res, next) => {
    try {
      const result = await plaid.createLinkToken({ orgId: req.currentUser.orgId });
      if (result.error) return res.status(502).json({ detail: "Could not start a bank connection. Please try again." });
      res.json({ link_token: result.linkToken });
    } catch (err) {
      next(err);
    }
  }
);

async function getOwnedConnection(connectionId, orgId) {
  return BankConnection.findOne({ where: { id: connectionId, orgId }, include: [{ model: BankAccount, as: "accounts" }] });
}

router.get("/api/integrations/plaid/connections", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const connections = await BankConnection.findAll({
      where: { orgId: req.currentUser.orgId },
      include: [{ model: BankAccount, as: "accounts" }],
      order: [["createdAt", "ASC"]],
    });
    res.json(connections.map(serializeBankConnection));
  } catch (err) {
    next(err);
  }
});

const exchangeSchema = z.object({ public_token: z.string().min(1) });

// The one-time handoff from Link's client-side widget: exchanges its
// public_token for a real access_token, then immediately fetches every
// account behind it so the connection shows up ready to sync, not as an
// empty shell the user has to refresh to see populated.
router.post(
  "/api/integrations/plaid/exchange",
  requireAuth,
  requireActivePlan,
  requirePlaidConfigured,
  async (req, res, next) => {
    try {
      const parsed = exchangeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

      const exchanged = await plaid.exchangePublicToken({ publicToken: parsed.data.public_token });
      if (exchanged.error) return res.status(502).json({ detail: "Could not connect that bank. Please try again." });

      const { accounts, institutionId, error } = await plaid.fetchAccountsForItem({ accessToken: exchanged.accessToken });
      if (error) return res.status(502).json({ detail: "Connected, but could not read the account list. Please try again." });

      const institutionName = await plaid.fetchInstitutionName({ institutionId });

      const connection = await BankConnection.create({
        orgId: req.currentUser.orgId,
        institutionName,
        plaidItemId: exchanged.itemId,
        accessToken: exchanged.accessToken,
      });

      await BankAccount.bulkCreate(
        accounts.map((a) => ({
          orgId: req.currentUser.orgId,
          connectionId: connection.id,
          plaidAccountId: a.account_id,
          name: a.name || "",
          officialName: a.official_name || "",
          mask: a.mask || "",
          accountType: a.type || "",
          accountSubtype: a.subtype || "",
          currentBalance: a.balances?.current ?? null,
          availableBalance: a.balances?.available ?? null,
          currency: a.balances?.iso_currency_code || "USD",
        }))
      );

      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        action: "bank_connected",
        actor: req.currentUser.email,
        details: { institution: institutionName, accounts: accounts.length },
      });

      const fresh = await getOwnedConnection(connection.id, req.currentUser.orgId);
      res.status(201).json(serializeBankConnection(fresh));
    } catch (err) {
      next(err);
    }
  }
);

// Pulls this account's recent transactions and appends any not already
// pulled into the matching engine as MatchEntry rows on a MatchSource
// (sourceType "bank") created for it on first sync -- see
// models/BankAccount.js's own comment on why this rides the existing
// upload-based matching engine instead of a second reconciliation path.
router.post("/api/integrations/plaid/accounts/:id/sync", requireAuth, requireActivePlan, requirePlaidConfigured, async (req, res, next) => {
  try {
    const account = await BankAccount.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!account) return res.status(404).json({ detail: "Bank account not found" });

    const connection = await BankConnection.findOne({ where: { id: account.connectionId, orgId: req.currentUser.orgId } });
    if (!connection) return res.status(404).json({ detail: "Bank connection not found" });

    const { transactions, error } = await plaid.fetchTransactions({ accessToken: connection.accessToken });
    if (error === "login_required") {
      connection.status = "login_required";
      await connection.save();
      return res.status(409).json({ detail: "This bank connection needs to be reconnected before it can sync." });
    }
    if (error) return res.status(502).json({ detail: "Could not fetch transactions from the bank. Please try again." });

    const ownTransactions = transactions.filter((t) => t.account_id === account.plaidAccountId);

    let source;
    if (account.matchSourceId) {
      source = await MatchSource.findOne({ where: { id: account.matchSourceId, orgId: req.currentUser.orgId } });
    }
    if (!source) {
      source = await MatchSource.create({
        orgId: req.currentUser.orgId,
        name: `${account.name}${account.mask ? ` ••${account.mask}` : ""}`,
        sourceType: "bank",
      });
      account.matchSourceId = source.id;
    }

    const existing = await MatchEntry.findAll({ where: { sourceId: source.id }, attributes: ["reference"] });
    const alreadySynced = new Set(existing.map((e) => e.reference));
    const newTransactions = ownTransactions.filter((t) => !alreadySynced.has(t.transaction_id));

    if (newTransactions.length) {
      await MatchEntry.bulkCreate(
        newTransactions.map((t) => ({
          sourceId: source.id,
          // Plaid's sign convention: positive = money out of the account,
          // negative = money in -- matching's own model has no notion of
          // sign, so this normalizes to the same "always positive" amount
          // a CSV upload provides.
          vendor: t.merchant_name || t.name || "",
          amount: Math.abs(t.amount),
          entryDate: t.date,
          reference: t.transaction_id,
          rawRow: t,
        }))
      );
    }

    account.lastSyncedAt = new Date();
    await account.save();
    if (connection.status !== "active") {
      connection.status = "active";
      await connection.save();
    }

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "bank_account_synced",
      actor: req.currentUser.email,
      details: { account_id: account.id, new_transactions: newTransactions.length },
    });

    res.json({ synced: newTransactions.length, match_source_id: source.id });
  } catch (err) {
    next(err);
  }
});

router.delete("/api/integrations/plaid/connections/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const connection = await BankConnection.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!connection) return res.status(404).json({ detail: "Bank connection not found" });

    // Best-effort on Plaid's side -- an already-revoked or errored Item
    // should not block removing our own record of it. Skipped entirely
    // when Plaid isn't configured (nothing real to revoke against).
    if (plaid.plaidConfigured()) {
      await plaid.removeItem({ accessToken: connection.accessToken }).catch(() => {});
    }

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "bank_disconnected",
      actor: req.currentUser.email,
      details: { institution: connection.institutionName },
    });

    await connection.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
