// QuickBooks Online (Phase 1: sandbox OAuth2 connect + manual one-way Bill
// push). Standard server-side OAuth2 authorization-code flow, same shape as
// auth.js's "Sign in with Google": /connect returns an authorize_url built
// from an org-scoped CSRF state, Intuit redirects back to /callback with a
// code (plus a realmId identifying which QuickBooks company was connected),
// which is exchanged server-side for tokens and stored on the org.
//
// Unlike Google sign-in, /connect is called by an already-authenticated
// user (it's a settings action, not a login), so there's no bearer token to
// attach the callback to -- Intuit's redirect back to /callback carries none
// of this app's auth. The random state doubles as both CSRF protection and
// the only place the initiating org's id survives the round trip, via the
// in-memory pendingConnections map below (same "handoff via unguessable
// single-use token" shape as auth.js's pendingGoogleLogins).
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { Op } from "sequelize";
import { requireAuth, requireReauth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { settings } from "../config.js";
import * as quickbooks from "../quickbooks.js";
import { Account, AuditLog, DismissedBankTransaction, Invoice, LineItem, Organization } from "../models/index.js";
import { lookupVendorExpenseAccount, rememberVendorExpenseAccount } from "../vendorExpenseAccount.js";
import { LedgerError, centsToDollars } from "../ledger.js";
import { amountPaidCents, invoiceTotalCents, isValidPaymentAccount, recordBillPayment } from "../accountsPayable.js";

const router = Router();

const QUICKBOOKS_STATE_TTL_MS = 10 * 60 * 1000;
const pendingConnections = new Map(); // state -> { orgId, expiresAt }

function quickbooksRedirectUri(req) {
  return `${req.protocol}://${req.get("host")}/api/integrations/quickbooks/callback`;
}

function requireQuickbooksConfigured(req, res, next) {
  if (!settings.quickbooksClientId) {
    return res.status(503).json({ detail: "QuickBooks isn't configured yet. Please contact us to enable it." });
  }
  next();
}

function statusResponse(org) {
  return {
    configured: Boolean(settings.quickbooksClientId),
    connected: Boolean(org.quickbooksRealmId),
    default_expense_account_id: org.quickbooksDefaultExpenseAccountId,
    default_expense_account_name: org.quickbooksDefaultExpenseAccountName,
  };
}

router.get("/api/integrations/quickbooks/status", requireAuth, requireActivePlan, (req, res) => {
  res.json(statusResponse(req.currentUser.organization));
});

router.get(
  "/api/integrations/quickbooks/connect",
  requireAuth,
  requireActivePlan,
  requireQuickbooksConfigured,
  (req, res) => {
    // Sweeps expired entries opportunistically, same reasoning as
    // auth.js's createGoogleHandoffCode -- this map only ever holds a
    // handful of unredeemed states at once.
    const now = Date.now();
    for (const [state, entry] of pendingConnections) {
      if (entry.expiresAt < now) pendingConnections.delete(state);
    }

    const state = crypto.randomBytes(16).toString("hex");
    pendingConnections.set(state, { orgId: req.currentUser.orgId, expiresAt: now + QUICKBOOKS_STATE_TTL_MS });

    const params = new URLSearchParams({
      client_id: settings.quickbooksClientId,
      redirect_uri: quickbooksRedirectUri(req),
      response_type: "code",
      scope: quickbooks.QUICKBOOKS_SCOPE,
      state,
    });
    res.json({ authorize_url: `${quickbooks.QUICKBOOKS_AUTH_URL}?${params.toString()}` });
  }
);

router.get("/api/integrations/quickbooks/callback", async (req, res, next) => {
  try {
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const entry = state ? pendingConnections.get(state) : null;
    if (state) pendingConnections.delete(state); // single-use regardless of outcome

    if (!entry || entry.expiresAt < Date.now()) {
      return res.redirect("/?quickbooks=error&reason=state_mismatch");
    }
    if (req.query.error) {
      // e.g. the user clicked "Cancel" on Intuit's consent screen.
      return res.redirect("/?quickbooks=error&reason=denied");
    }
    if (typeof req.query.code !== "string" || typeof req.query.realmId !== "string") {
      return res.redirect("/?quickbooks=error&reason=oauth_failed");
    }

    const org = await Organization.findByPk(entry.orgId);
    if (!org) return res.redirect("/?quickbooks=error&reason=oauth_failed");

    const result = await quickbooks.exchangeCodeForTokens({
      code: req.query.code,
      redirectUri: quickbooksRedirectUri(req),
    });
    if (result.error) return res.redirect("/?quickbooks=error&reason=oauth_failed");

    org.quickbooksRealmId = req.query.realmId;
    await quickbooks.applyTokens(org, result.tokens);

    await AuditLog.create({
      orgId: org.id,
      userId: null,
      action: "quickbooks_connected",
      actor: "quickbooks",
      details: { realm_id: org.quickbooksRealmId },
    });

    res.redirect("/?quickbooks=connected");
  } catch (err) {
    next(err);
  }
});

router.get("/api/integrations/quickbooks/accounts", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const org = req.currentUser.organization;
    if (!org.quickbooksRealmId) {
      return res.status(400).json({ detail: "Connect QuickBooks before choosing a default account." });
    }

    const result = await quickbooks.fetchExpenseAccounts(org);
    if (result.error) {
      return res.status(502).json({ detail: "Could not load QuickBooks accounts. Try reconnecting QuickBooks." });
    }
    res.json(result.data);
  } catch (err) {
    next(err);
  }
});

const defaultAccountSchema = z.object({
  account_id: z.string().min(1),
  account_name: z.string().min(1),
});

router.patch(
  "/api/integrations/quickbooks/default-account",
  requireAuth,
  requireActivePlan,
  async (req, res, next) => {
    try {
      const parsed = defaultAccountSchema.safeParse(req.body);
      if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

      const org = req.currentUser.organization;
      if (!org.quickbooksRealmId) {
        return res.status(400).json({ detail: "Connect QuickBooks before choosing a default account." });
      }

      org.quickbooksDefaultExpenseAccountId = parsed.data.account_id;
      org.quickbooksDefaultExpenseAccountName = parsed.data.account_name;
      await org.save();

      res.json(statusResponse(org));
    } catch (err) {
      next(err);
    }
  }
);

router.post("/api/integrations/quickbooks/disconnect", requireAuth, requireActivePlan, requireReauth, async (req, res, next) => {
  try {
    const org = req.currentUser.organization;
    // Clears this org's local connection state only -- the access/refresh
    // tokens themselves are left to expire on Intuit's side (100 days of
    // inactivity) rather than explicitly revoked, keeping Phase 1's surface
    // area to what's actually needed. Reconnecting later gets fresh tokens
    // regardless.
    org.quickbooksRealmId = null;
    org.quickbooksAccessToken = null;
    org.quickbooksRefreshToken = null;
    org.quickbooksAccessTokenExpiresAt = null;
    org.quickbooksRefreshTokenExpiresAt = null;
    org.quickbooksDefaultExpenseAccountId = null;
    org.quickbooksDefaultExpenseAccountName = null;
    await org.save();

    await AuditLog.create({
      orgId: org.id,
      userId: req.currentUser.id,
      action: "quickbooks_disconnected",
      actor: req.currentUser.email,
      details: {},
    });

    res.json(statusResponse(org));
  } catch (err) {
    next(err);
  }
});

function expenseAccountResponse(invoice) {
  return {
    quickbooks_expense_account_id: invoice.quickbooksExpenseAccountId,
    quickbooks_expense_account_name: invoice.quickbooksExpenseAccountName,
    quickbooks_expense_account_confidence: invoice.quickbooksExpenseAccountConfidence,
  };
}

// Categorizes one invoice against org's real chart of accounts (vendor
// memory first, then an LLM call -- see quickbooks.js's suggestExpenseAccount).
// Idempotent once a choice exists: an invoice that already has an account
// (suggested earlier, or a human's own pick) just echoes it back rather
// than silently re-guessing and overwriting a correction.
router.post(
  "/api/integrations/quickbooks/invoices/:id/suggest-account",
  requireAuth,
  requireActivePlan,
  async (req, res, next) => {
    try {
      const invoice = await Invoice.findOne({
        where: { id: req.params.id, orgId: req.currentUser.orgId },
        include: [{ model: LineItem, as: "lineItems" }],
      });
      if (!invoice) return res.status(404).json({ detail: "Invoice not found" });

      const org = req.currentUser.organization;
      if (!org.quickbooksRealmId) {
        return res.status(400).json({ detail: "Connect QuickBooks before categorizing invoices." });
      }

      if (invoice.quickbooksExpenseAccountId) {
        return res.json(expenseAccountResponse(invoice));
      }

      const remembered = await lookupVendorExpenseAccount(org.id, invoice.vendorName);
      if (remembered) {
        invoice.quickbooksExpenseAccountId = remembered.expenseAccountId;
        invoice.quickbooksExpenseAccountName = remembered.expenseAccountName;
        invoice.quickbooksExpenseAccountConfidence = 1;
        await invoice.save();
        return res.json(expenseAccountResponse(invoice));
      }

      const accountsResult = await quickbooks.fetchExpenseAccounts(org);
      if (!accountsResult.error) {
        const suggestion = await quickbooks.suggestExpenseAccount(invoice, accountsResult.data);
        if (suggestion.suggested) {
          invoice.quickbooksExpenseAccountId = suggestion.accountId;
          invoice.quickbooksExpenseAccountName = suggestion.accountName;
          invoice.quickbooksExpenseAccountConfidence = suggestion.confidence;
          await invoice.save();
        }
      }
      // accountsResult.error (transient QuickBooks API issue) or no
      // suggestion (no GEMINI_API_KEY, or nothing fit) both leave the
      // invoice uncategorized rather than erroring -- pushing still works
      // via the org's default account either way.

      res.json(expenseAccountResponse(invoice));
    } catch (err) {
      next(err);
    }
  }
);

const expenseAccountSchema = z.object({
  account_id: z.string().min(1),
  account_name: z.string().min(1),
});

// A human's own pick, whether correcting a suggestion or setting one from
// scratch -- always remembered per-vendor (see rememberVendorExpenseAccount)
// since a person choosing this account is the strongest signal available,
// stronger than the LLM's own suggestion.
router.patch(
  "/api/integrations/quickbooks/invoices/:id/expense-account",
  requireAuth,
  requireActivePlan,
  async (req, res, next) => {
    try {
      const parsed = expenseAccountSchema.safeParse(req.body);
      if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

      const invoice = await Invoice.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
      if (!invoice) return res.status(404).json({ detail: "Invoice not found" });

      invoice.quickbooksExpenseAccountId = parsed.data.account_id;
      invoice.quickbooksExpenseAccountName = parsed.data.account_name;
      invoice.quickbooksExpenseAccountConfidence = 1;
      await invoice.save();

      await rememberVendorExpenseAccount(
        req.currentUser.orgId,
        invoice.vendorName,
        parsed.data.account_id,
        parsed.data.account_name
      );

      res.json(expenseAccountResponse(invoice));
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/api/integrations/quickbooks/invoices/:id/push",
  requireAuth,
  requireActivePlan,
  async (req, res, next) => {
    try {
      const invoice = await Invoice.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
      if (!invoice) return res.status(404).json({ detail: "Invoice not found" });

      const org = req.currentUser.organization;
      const result = await quickbooks.pushInvoiceAsBill(org, invoice);

      if (result.error === "not_connected") {
        return res.status(400).json({ detail: "Connect QuickBooks before pushing invoices." });
      }
      if (result.error === "no_default_account") {
        return res.status(400).json({ detail: "Choose a default expense account in Settings before pushing invoices." });
      }
      if (result.error === "already_pushed") {
        return res.status(409).json({ detail: "This invoice has already been pushed to QuickBooks." });
      }
      if (result.error) {
        return res.status(502).json({ detail: "QuickBooks rejected this push. Please try again." });
      }

      invoice.quickbooksBillId = result.data.id;
      await invoice.save();

      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        invoiceId: invoice.id,
        action: "quickbooks_bill_pushed",
        actor: req.currentUser.email,
        details: { quickbooks_bill_id: invoice.quickbooksBillId },
      });

      res.json({ ok: true, quickbooks_bill_id: invoice.quickbooksBillId });
    } catch (err) {
      next(err);
    }
  }
);

// Bank reconciliation: surfaces QuickBooks bank/card transactions that look
// like payment for a bill Rekono already pushed but hasn't been marked
// paid yet -- see quickbooks.js's fetchBankTransactions/
// findExactAmountCandidates/suggestBankTransactionMatch for how transactions
// get matched to candidates. Deliberately read-only against QuickBooks: a
// duplicate Purchase transaction (the actual root cause of the mismatch,
// see quickbooks.js's comment) is left for the human to clean up in
// QuickBooks itself once they've confirmed the match here -- an automatic
// delete/void of someone else's QuickBooks transaction is a different, much
// higher-risk kind of write than anything this app has done before, and not
// one this Phase 1 route takes on.
router.get(
  "/api/integrations/quickbooks/bank-transactions",
  requireAuth,
  requireActivePlan,
  async (req, res, next) => {
    try {
      const org = req.currentUser.organization;
      if (!org.quickbooksRealmId) {
        return res.status(400).json({ detail: "Connect QuickBooks before reviewing bank transactions." });
      }

      const [transactionsResult, candidateInvoices, dismissed] = await Promise.all([
        quickbooks.fetchBankTransactions(org),
        Invoice.findAll({
          where: { orgId: req.currentUser.orgId, quickbooksBillId: { [Op.ne]: null }, quickbooksPaidAt: null },
        }),
        DismissedBankTransaction.findAll({ where: { orgId: req.currentUser.orgId } }),
      ]);
      if (transactionsResult.error) {
        return res.status(502).json({ detail: "Could not load QuickBooks bank transactions. Try reconnecting QuickBooks." });
      }

      const dismissedIds = new Set(dismissed.map((d) => d.quickbooksTransactionId));
      const transactions = transactionsResult.data.filter((t) => !dismissedIds.has(t.id));

      const results = [];
      for (const txn of transactions) {
        const candidates = quickbooks.findExactAmountCandidates(txn, candidateInvoices);
        let suggestion = { suggested: false };
        if (candidates.length === 1) {
          suggestion = { suggested: true, invoiceId: candidates[0].id, confidence: 1, reasoning: "Exact amount and date match." };
        } else if (candidates.length > 1) {
          suggestion = await quickbooks.suggestBankTransactionMatch(txn, candidates);
        }
        results.push({
          transaction_id: txn.id,
          date: txn.date,
          amount: txn.amount,
          payee_name: txn.payeeName,
          description: txn.description,
          candidates: candidates.map((c) => ({ id: c.id, vendor_name: c.vendorName, total: c.total, invoice_date: c.invoiceDate, due_date: c.dueDate })),
          suggested_invoice_id: suggestion.suggested ? suggestion.invoiceId : null,
          confidence: suggestion.suggested ? suggestion.confidence : null,
          reasoning: suggestion.suggested ? suggestion.reasoning : "",
        });
      }

      res.json(results);
    } catch (err) {
      next(err);
    }
  }
);

const confirmBankMatchSchema = z.object({
  invoice_id: z.string().min(1),
  transaction_date: z.string().min(1),
  // Which Rekono account the money left from, so confirming the match can
  // post the payment to the ledger as well as record it against the
  // QuickBooks bill. Optional: Rekono has no mapping from QuickBooks' bank
  // accounts to its own chart, so when it isn't given we fall back to the
  // org's primary bank account (see primaryBankAccount below) rather than
  // refusing a confirmation that used to work without it.
  payment_account_id: z.string().min(1).optional(),
});

// The account a bill payment defaults to: the lowest-coded bank or cash
// account, which in the seeded chart is 1000 Cash. Only used when the
// caller didn't name one.
async function primaryBankAccount(orgId) {
  return Account.findOne({
    where: { orgId, type: "asset", subtype: { [Op.in]: ["bank", "cash"] }, active: true },
    order: [["code", "ASC"]],
  });
}

router.post(
  "/api/integrations/quickbooks/bank-transactions/:txnId/confirm",
  requireAuth,
  requireActivePlan,
  async (req, res, next) => {
    try {
      const parsed = confirmBankMatchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

      const invoice = await Invoice.findOne({ where: { id: parsed.data.invoice_id, orgId: req.currentUser.orgId } });
      if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
      if (!invoice.quickbooksBillId) {
        return res.status(400).json({ detail: "This invoice hasn't been pushed to QuickBooks yet." });
      }

      invoice.quickbooksPaidAt = new Date(parsed.data.transaction_date);
      invoice.quickbooksPaymentTransactionId = req.params.txnId;
      invoice.quickbooksPaymentTransactionType = "Purchase";
      await invoice.save();

      // Confirming the match is the moment Rekono learns the bill was
      // actually paid, so it's the moment the payable should be relieved.
      // Before this, the loop closed only in QuickBooks' direction and
      // Accounts Payable kept the bill forever.
      //
      // Deliberately best-effort: a refused posting (a closed period, or
      // no bank account in the chart of accounts) must not fail the match
      // itself, since the QuickBooks fact is true regardless. The skip is
      // recorded so it's findable at close time rather than surfacing
      // later as an unexplained AP balance -- same treatment
      // postInvoiceApproval gives the approval path.
      let ledgerPosted = false;
      let ledgerSkippedReason = null;
      const outstandingCents = invoiceTotalCents(invoice) - (await amountPaidCents(invoice.id));
      if (outstandingCents > 0) {
        const paymentAccount = parsed.data.payment_account_id
          ? await Account.findOne({ where: { id: parsed.data.payment_account_id, orgId: req.currentUser.orgId } })
          : await primaryBankAccount(req.currentUser.orgId);

        if (!isValidPaymentAccount(paymentAccount)) {
          ledgerSkippedReason = "No usable payment account found in the chart of accounts.";
        } else {
          try {
            await recordBillPayment(invoice, {
              amountCents: outstandingCents,
              paymentDate: parsed.data.transaction_date.slice(0, 10),
              paymentAccountId: paymentAccount.id,
              memo: `QuickBooks bank match ${req.params.txnId}`,
              postedByUserId: req.currentUser.id,
            });
            ledgerPosted = true;
          } catch (err) {
            if (!(err instanceof LedgerError)) throw err;
            ledgerSkippedReason = err.message;
          }
        }
      }

      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        invoiceId: invoice.id,
        action: "quickbooks_payment_matched",
        actor: req.currentUser.email,
        details: { quickbooks_transaction_id: req.params.txnId, ledger_posted: ledgerPosted },
      });

      if (ledgerSkippedReason) {
        await AuditLog.create({
          orgId: req.currentUser.orgId,
          invoiceId: invoice.id,
          action: "journal_posting_skipped",
          actor: "system",
          details: { reason: ledgerSkippedReason, amount: centsToDollars(outstandingCents) },
        });
      }

      res.json({
        ok: true,
        quickbooks_paid_at: invoice.quickbooksPaidAt,
        quickbooks_payment_transaction_id: invoice.quickbooksPaymentTransactionId,
        ledger_posted: ledgerPosted,
      });
    } catch (err) {
      next(err);
    }
  }
);

// A user's "this isn't a match" -- remembered per-org so the same
// transaction doesn't keep resurfacing every time this list loads.
// findOrCreate rather than create: dismissing twice (e.g. a double click,
// or the list reloading before the row's removed from the DOM) is a no-op,
// not a duplicate-key error.
router.post(
  "/api/integrations/quickbooks/bank-transactions/:txnId/dismiss",
  requireAuth,
  requireActivePlan,
  async (req, res, next) => {
    try {
      await DismissedBankTransaction.findOrCreate({
        where: { orgId: req.currentUser.orgId, quickbooksTransactionId: req.params.txnId },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
