// Check intake + CRUD + the link to a bill -- mirrors routes/taxDocuments.js
// (itself mirroring routes/leases.js and routes/vendorDocuments.js), applied
// to Check. Same v1 scope for the document half: no bulk actions, no
// duplicate detection, no QuickBooks push.
//
// What this module has that the other four "extra" pipelines don't is the
// second half of its own name: linking. A lease or a tax form is filed; a
// check is *applied*. Three routes carry that:
//
//   * GET  /api/checks/:id/match-suggestions -- rank the org's open bills
//     against this check and say why each scored what it did.
//   * POST /api/checks/:id/link   -- apply it, which records a real
//     BillPayment and posts a real journal entry.
//   * POST /api/checks/:id/unlink -- reverse that.
//
// Linking deliberately goes through accountsPayable.js's recordBillPayment
// rather than writing a payment of its own. That function already refuses
// to relieve a payable that never posted, already unwinds its own row when
// the ledger rejects the entry, and is the same path the manual payments
// screen and the QuickBooks bank-match confirmation use. A check arriving
// by camera instead of by keyboard is not a reason for the money to reach
// the books down a different road.
import fs from "node:fs/promises";
import multer from "multer";
import { Router } from "express";
import { Op, fn, col, where as sequelizeWhere } from "sequelize";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { PLANS } from "../plans.js";
import * as jobs from "../jobs.js";
import { MAX_UPLOAD_BYTES, canonicalContentType, upload } from "../storage.js";
import { LedgerError, centsToDollars, dollarsToCents } from "../ledger.js";
import {
  PAYABLE_INVOICE_STATUS,
  amountPaidCents,
  invoiceTotalCents,
  isValidPaymentAccount,
  recordBillPayment,
  voidBillPaymentEntry,
} from "../accountsPayable.js";
import { scorePair } from "../matching.js";
import { Account, AuditLog, BillPayment, Check, Invoice } from "../models/index.js";
import { accountLast4 } from "../extractionChecks.js";
import { serializeAuditLog, serializeCheckDetail, serializeCheckListItem } from "../serializers.js";
import { documentsUsedThisMonth } from "../documentUsage.js";

const router = Router();

async function getOwnedCheck(id, orgId) {
  return Check.findOne({ where: { id, orgId } });
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const SORTABLE_FIELDS = {
  created_at: "createdAt",
  check_date: "checkDate",
  payee_name: "payeeName",
  amount: "amount",
  overall_confidence: "overallConfidence",
};

const FIELD_TO_ATTR = {
  check_number: "checkNumber",
  check_date: "checkDate",
  payee_name: "payeeName",
  amount: "amount",
  memo: "memo",
  bank_name: "bankName",
  account_last4: "accountLast4",
  note: "note",
};

router.get("/api/checks", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const where = { orgId: req.currentUser.orgId };
    if (req.query.status) where.status = req.query.status;

    // The filter this module exists for. A pile of scanned checks splits
    // into exactly two piles that need different work: the ones already
    // applied to a bill, and the ones still sitting there representing
    // money that left the account against nothing on the books. `false` is
    // the one people actually open.
    if (req.query.linked === "true") where.invoiceId = { [Op.ne]: null };
    if (req.query.linked === "false") where.invoiceId = null;

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      where[Op.and] = [sequelizeWhere(fn("LOWER", col("payeeName")), { [Op.like]: `%${q.toLowerCase()}%` })];
    }

    const sortField = SORTABLE_FIELDS[req.query.sort] || "createdAt";
    const sortOrder = req.query.order === "asc" ? "ASC" : "DESC";

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.page_size, 10) || DEFAULT_PAGE_SIZE));

    const { rows, count } = await Check.findAndCountAll({
      where,
      order: [[sortField, sortOrder]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    // Totals over the whole filtered set rather than the page, same
    // reasoning as the tax-document module's: "how much is sitting here
    // unapplied" is the question the linked=false filter exists to answer,
    // and a per-page sum would answer a different one.
    const all = await Check.findAll({ where, attributes: ["amount", "invoiceId"], raw: true });
    let amountTotal = 0;
    let unlinkedAmountTotal = 0;
    let unlinkedCount = 0;
    for (const c of all) {
      amountTotal += c.amount || 0;
      if (!c.invoiceId) {
        unlinkedAmountTotal += c.amount || 0;
        unlinkedCount += 1;
      }
    }

    res.json({
      items: rows.map(serializeCheckListItem),
      total: count,
      page,
      page_size: pageSize,
      totals: {
        amount: Math.round(amountTotal * 100) / 100,
        unlinked_amount: Math.round(unlinkedAmountTotal * 100) / 100,
        unlinked_count: unlinkedCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Multer's own file-size rejection arrives as an error rather than a
// request -- same handling as ingestion.js's handleUpload.
function handleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      const maxMb = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
      return res.status(413).json({ detail: `File too large. Maximum size is ${maxMb}MB.` });
    }
    if (err) return next(err);
    next();
  });
}

router.post("/api/checks/upload", requireAuth, requireActivePlan, handleUpload, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(422).json({ detail: "A file upload is required." });
    }

    // Same shared monthly document cap as the other five pipelines'
    // uploads -- see documentUsage.js.
    const plan = PLANS[req.currentUser.organization.plan];
    if (plan) {
      const uploadedThisMonth = await documentsUsedThisMonth(req.currentUser.orgId);
      if (uploadedThisMonth >= plan.docCapPerMonth) {
        await fs.rm(req.file.path, { force: true });
        return res.status(402).json({
          detail: `You've reached your ${plan.name} plan's limit of ${plan.docCapPerMonth} documents this month. Upgrade your plan to upload more.`,
          plan_cap_reached: true,
        });
      }
    }

    const contentType = canonicalContentType(req.file.originalname);
    if (!contentType) {
      await fs.rm(req.file.path, { force: true });
      return res.status(422).json({
        detail: `Unsupported file type: ${req.file.originalname} (${req.file.mimetype}). Rekono accepts PDF or image files (png/jpg/tiff/bmp/webp).`,
      });
    }

    const check = await Check.create({
      orgId: req.currentUser.orgId,
      originalFilename: req.file.originalname || "upload",
      storagePath: req.file.path,
      contentType,
      status: "queued",
    });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      checkId: check.id,
      action: "uploaded",
      actor: req.currentUser.email,
      details: { filename: check.originalFilename },
    });

    jobs.enqueue(check.id, "check");

    res.status(201).json(serializeCheckDetail(check));
  } catch (err) {
    next(err);
  }
});

router.get("/api/checks/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const check = await getOwnedCheck(req.params.id, req.currentUser.orgId);
    if (!check) return res.status(404).json({ detail: "Check not found" });
    res.json(serializeCheckDetail(check));
  } catch (err) {
    next(err);
  }
});

router.get("/api/checks/:id/file", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const check = await getOwnedCheck(req.params.id, req.currentUser.orgId);
    if (!check) return res.status(404).json({ detail: "Check not found" });
    res.sendFile(
      check.storagePath,
      { headers: { "Content-Type": check.contentType || "application/octet-stream" } },
      (err) => {
        if (!err) return;
        if (err.code === "ENOENT") {
          return res.status(404).json({ detail: "This check's source file is no longer available on the server." });
        }
        next(err);
      }
    );
  } catch (err) {
    next(err);
  }
});

router.get("/api/checks/:id/audit-log", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const check = await getOwnedCheck(req.params.id, req.currentUser.orgId);
    if (!check) return res.status(404).json({ detail: "Check not found" });
    const entries = await AuditLog.findAll({ where: { checkId: check.id }, order: [["createdAt", "ASC"]] });
    res.json(entries.map(serializeAuditLog));
  } catch (err) {
    next(err);
  }
});

const correctionSchema = z.object({
  check_number: z.string().nullable().optional(),
  check_date: z.string().nullable().optional(),
  payee_name: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  memo: z.string().max(512).nullable().optional(),
  bank_name: z.string().max(256).nullable().optional(),
  // Deliberately no max length: a reviewer looking at the preview pane
  // types what's printed on the check, which is the whole account number.
  // A 4-character cap would keep the *first* four digits -- the wrong end
  // -- so this is narrowed server-side below instead. Same reasoning, and
  // the same trap, as the tax module's TIN field.
  account_last4: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

router.patch("/api/checks/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = correctionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const payload = parsed.data;

    const check = await getOwnedCheck(req.params.id, req.currentUser.orgId);
    if (!check) return res.status(404).json({ detail: "Check not found" });

    // A linked check's fields are what the posted payment was based on.
    // Editing the amount out from under a journal entry would leave the
    // two disagreeing with nothing to reconcile them, so corrections stop
    // at the point money moved -- unlink first, which reverses the entry,
    // then correct, then link again.
    if (check.status === "approved") {
      return res.status(409).json({
        detail: "This check is linked to a bill and its payment has posted. Unlink it before correcting the extracted fields.",
      });
    }

    const changed = {};
    for (const [field, attr] of Object.entries(FIELD_TO_ATTR)) {
      if (!(field in payload) || payload[field] === undefined) continue;
      // Narrowed here rather than trusted from the client, for the same
      // reason extraction narrows the model's output: this is the one
      // field where storing what was typed would store the whole account
      // number.
      const newValue = field === "account_last4" && payload[field] !== null ? accountLast4(payload[field]) : payload[field];
      // A value too short to narrow is rejected rather than silently
      // stored as blank, which would be indistinguishable from "this
      // check shows no account number".
      if (field === "account_last4" && payload[field] && !newValue) {
        return res.status(422).json({ detail: "Account number must have at least four digits." });
      }
      const oldValue = check[attr];
      if (JSON.stringify(oldValue ?? null) !== JSON.stringify(newValue ?? null)) {
        changed[field] = { old: oldValue, new: newValue };
        check[attr] = newValue;
      }
    }

    if (Object.keys(changed).length) {
      await check.save();
      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        checkId: check.id,
        action: "human_correction",
        actor: req.currentUser.email,
        details: changed,
      });
    }

    res.json(serializeCheckDetail(await getOwnedCheck(req.params.id, req.currentUser.orgId)));
  } catch (err) {
    next(err);
  }
});

// What's still owed on a bill, in cents. A check can only be applied
// against an outstanding balance, so this is what candidates are scored and
// validated on -- not the bill's face value, which would keep suggesting a
// bill that's already been paid in full.
async function outstandingCents(invoice) {
  return invoiceTotalCents(invoice) - (await amountPaidCents(invoice.id));
}

// The org's open payables: approved (so their approval posted to Accounts
// Payable, the only thing a payment can relieve) and not yet paid off.
// `withSamples` deliberately included -- an approved sample invoice posts
// to AP for real (see CLAUDE.md), so excluding it here would offer a list
// that doesn't match what the aging report shows.
async function openBills(orgId) {
  const invoices = await Invoice.scope("withSamples").findAll({
    where: { orgId, status: PAYABLE_INVOICE_STATUS },
  });
  const open = [];
  for (const invoice of invoices) {
    const remaining = await outstandingCents(invoice);
    if (remaining > 0) open.push({ invoice, remainingCents: remaining });
  }
  return open;
}

const SUGGESTION_LIMIT = 5;

router.get("/api/checks/:id/match-suggestions", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const check = await getOwnedCheck(req.params.id, req.currentUser.orgId);
    if (!check) return res.status(404).json({ detail: "Check not found" });

    const bills = await openBills(req.currentUser.orgId);

    const scored = bills.map(({ invoice, remainingCents }) => {
      // Scored against the *outstanding* balance rather than the bill's
      // total: a $500 check against a $2,000 bill with $1,500 already paid
      // is an exact match, and scoring it against the face value would
      // rank it below a coincidence.
      //
      // The check's memo line stands in for a reference number. It's where
      // people write the invoice number they're paying, which makes it the
      // strongest single signal available here -- and scorePair already
      // knows what to do with an exact reference hit.
      const outcome = scorePair(
        check.payeeName,
        check.amount,
        check.checkDate,
        (check.memo || "").trim(),
        {
          id: invoice.id,
          vendor: invoice.vendorName,
          amount: centsToDollars(remainingCents),
          entryDate: invoice.invoiceDate,
          reference: invoice.invoiceNumber,
        }
      );
      return {
        invoice_id: invoice.id,
        vendor_name: invoice.vendorName,
        invoice_number: invoice.invoiceNumber,
        invoice_date: invoice.invoiceDate,
        total: invoice.total,
        outstanding: centsToDollars(remainingCents),
        status: outcome.status,
        score: outcome.score,
        reasoning: outcome.reasoning,
      };
    });

    // Unmatched candidates are dropped rather than ranked last: a list
    // that ends in five bills the engine actively believes are unrelated
    // invites someone to click one anyway.
    const suggestions = scored
      .filter((s) => s.status !== "unmatched")
      .sort((a, b) => b.score - a.score)
      .slice(0, SUGGESTION_LIMIT);

    res.json({ suggestions, open_bill_count: bills.length });
  } catch (err) {
    next(err);
  }
});

const linkSchema = z.object({
  invoice_id: z.string().min(1),
  payment_account_id: z.string().min(1),
});

router.post("/api/checks/:id/link", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = linkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;

    const check = await getOwnedCheck(req.params.id, orgId);
    if (!check) return res.status(404).json({ detail: "Check not found" });
    if (check.invoiceId) {
      return res.status(409).json({ detail: "This check is already linked to a bill. Unlink it first." });
    }
    if (!["extracted", "needs_review"].includes(check.status)) {
      return res.status(409).json({ detail: `Cannot link a check in status ${check.status}.` });
    }
    // Extraction leaves these blank when it couldn't read them, and the
    // pipeline already routes such a check to review. Paying a bill from
    // one anyway would post a payment whose amount nobody has confirmed.
    if (check.amount == null || check.amount <= 0) {
      return res.status(422).json({ detail: "This check has no amount. Correct it before linking it to a bill." });
    }

    const invoice = await Invoice.scope("withSamples").findOne({ where: { id: parsed.data.invoice_id, orgId } });
    if (!invoice) return res.status(404).json({ detail: "Invoice not found" });
    if (invoice.status !== PAYABLE_INVOICE_STATUS) {
      return res.status(409).json({ detail: `Can't pay a ${invoice.status} invoice -- approve it first.` });
    }

    const paymentAccount = await Account.findOne({ where: { id: parsed.data.payment_account_id, orgId } });
    if (!isValidPaymentAccount(paymentAccount)) {
      return res.status(422).json({
        detail: "Payment account must be an asset or liability account you own, and not Accounts Payable itself.",
      });
    }

    const amountCents = dollarsToCents(check.amount);
    const totalCents = invoiceTotalCents(invoice);
    const alreadyPaid = await amountPaidCents(invoice.id);
    if (alreadyPaid + amountCents > totalCents) {
      return res.status(422).json({
        detail: `That would overpay this bill. Outstanding balance is ${centsToDollars(totalCents - alreadyPaid)}.`,
      });
    }

    const payment = await recordBillPayment(invoice, {
      amountCents,
      // The check's own date, not today's. A check written on the 28th and
      // scanned on the 3rd belongs in the month it was written, and using
      // the scan date would silently move real money across a period
      // boundary. Falls back to today only when the date couldn't be read
      // at all -- and a check with no date is already flagged for review.
      paymentDate: check.checkDate || new Date().toISOString().slice(0, 10),
      paymentAccountId: paymentAccount.id,
      memo: check.checkNumber ? `Check #${check.checkNumber}` : "Scanned check",
      postedByUserId: req.currentUser.id,
    });

    check.invoiceId = invoice.id;
    check.billPaymentId = payment.id;
    check.status = "approved";
    await check.save();

    // Two entries, deliberately. The check's own trail should say where it
    // went, and the bill's should say what paid it -- someone auditing the
    // payable shouldn't have to already know a check existed to find it.
    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      checkId: check.id,
      action: "check_linked",
      actor: req.currentUser.email,
      details: { invoice_id: invoice.id, amount: check.amount, payment_account: paymentAccount.name },
    });
    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      invoiceId: invoice.id,
      action: "bill_payment_recorded",
      actor: req.currentUser.email,
      details: { amount: check.amount, payment_account: paymentAccount.name, source: "scanned_check", check_id: check.id },
    });

    res.json(serializeCheckDetail(check));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.post("/api/checks/:id/unlink", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const check = await getOwnedCheck(req.params.id, orgId);
    if (!check) return res.status(404).json({ detail: "Check not found" });
    if (!check.invoiceId) return res.status(409).json({ detail: "This check isn't linked to a bill." });

    // Reverses the journal entry rather than deleting it, then removes the
    // payment row -- exactly what the manual "remove payment" route does,
    // for the same reason: the original entry and its reversal both stay
    // on the books and cancel.
    if (check.billPaymentId) {
      await voidBillPaymentEntry(orgId, check.billPaymentId, { postedByUserId: req.currentUser.id });
      const payment = await BillPayment.findOne({ where: { id: check.billPaymentId, orgId } });
      if (payment) await payment.destroy();
    }

    const previousInvoiceId = check.invoiceId;
    check.invoiceId = null;
    check.billPaymentId = null;
    // Back to review rather than to "extracted": a link that had to be
    // undone is evidence something about this check was misread, so it
    // goes back in front of a human rather than sitting in the
    // fast-tracked pile looking settled.
    check.status = "needs_review";
    await check.save();

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      checkId: check.id,
      action: "check_unlinked",
      actor: req.currentUser.email,
      details: { invoice_id: previousInvoiceId },
    });
    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      invoiceId: previousInvoiceId,
      action: "bill_payment_removed",
      actor: req.currentUser.email,
      details: { amount: check.amount, source: "scanned_check", check_id: check.id },
    });

    res.json(serializeCheckDetail(check));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.post("/api/checks/:id/reject", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const check = await getOwnedCheck(req.params.id, req.currentUser.orgId);
    if (!check) return res.status(404).json({ detail: "Check not found" });
    if (check.invoiceId) {
      return res.status(409).json({ detail: "This check is linked to a bill. Unlink it before rejecting it." });
    }
    check.status = "rejected";
    await check.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      checkId: check.id,
      action: "rejected",
      actor: req.currentUser.email,
      details: {},
    });
    res.json(serializeCheckDetail(check));
  } catch (err) {
    next(err);
  }
});

router.post("/api/checks/:id/retry", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const check = await getOwnedCheck(req.params.id, req.currentUser.orgId);
    if (!check) return res.status(404).json({ detail: "Check not found" });
    // Re-extracting would overwrite the fields the posted payment was
    // based on, so this stops where the correction route does.
    if (check.invoiceId) {
      return res.status(409).json({ detail: "This check is linked to a bill. Unlink it before re-running extraction." });
    }
    check.status = "queued";
    check.errorMessage = "";
    await check.save();
    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      checkId: check.id,
      action: "retry_requested",
      actor: req.currentUser.email,
      details: {},
    });
    jobs.enqueue(check.id, "check");
    res.json(serializeCheckDetail(check));
  } catch (err) {
    next(err);
  }
});

router.delete("/api/checks/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const check = await getOwnedCheck(req.params.id, req.currentUser.orgId);
    if (!check) return res.status(404).json({ detail: "Check not found" });
    // Deleting a linked check would leave a posted payment behind with
    // nothing explaining where it came from. Unlinking is the reversal;
    // deletion is only for the image.
    if (check.invoiceId) {
      return res.status(409).json({ detail: "This check is linked to a bill. Unlink it before deleting it." });
    }

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      checkId: check.id,
      action: "deleted",
      actor: req.currentUser.email,
      details: { original_filename: check.originalFilename, status: check.status },
    });

    if (check.storagePath) {
      await fs.unlink(check.storagePath).catch((err) => {
        if (err.code !== "ENOENT") console.error(`Failed to remove file for deleted check ${check.id}:`, err.message);
      });
    }

    await check.destroy();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
