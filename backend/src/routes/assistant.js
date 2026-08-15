// "Ask Rekono" -- a grounded Q&A assistant over the org's own invoice
// data. Deliberately read-only: it answers questions, it doesn't take
// actions (approve/reject/export/etc.), so there's no risk of an LLM
// mistake mutating anyone's books. Each question is answered independently
// -- no conversation memory across requests, which keeps the grounding
// simple to reason about.

import Anthropic from "@anthropic-ai/sdk";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { settings } from "../config.js";
import { Invoice, MatchResult } from "../models/index.js";
import { createRateLimiter } from "../rateLimit.js";

const router = Router();

const askSchema = z.object({ question: z.string().min(1).max(1000) });

const MAX_INVOICES_IN_CONTEXT = 300;

// Every question is a real Anthropic API call -- real money, not just server
// load -- so this is bounded more like a cost control than a plain abuse
// guard. Keyed by org rather than IP: the thing actually worth limiting is
// how fast one account can run up API spend, and an org sharing an office
// IP shouldn't have its budget divided among however many people are in the
// building that day.
const isAssistantRateLimited = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

// Same reasoning as extraction.js's LLM call: bound the worst case instead
// of inheriting the SDK's multi-minute default (potentially compounded by
// retries), since this one blocks a live HTTP request/response instead of a
// background job.
const LLM_TIMEOUT_MS = 60_000;
const LLM_MAX_RETRIES = 1;

const SYSTEM_PROMPT = `You are Rekono's in-app assistant, helping an accounts-payable user understand their invoice data. Answer only using the JSON data provided in the user message -- never invent vendors, amounts, dates, or statuses that aren't in it. If the data doesn't contain what's needed to answer, say so plainly rather than guessing. Be concise: a few sentences, or a short list. You can summarize, count, filter, and total the data, but you cannot take any action (approve, reject, export, upload, run matching, etc.) -- if asked to do something rather than answer a question, say which tab/button does that instead of attempting it.`;

router.post("/api/assistant/ask", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    if (isAssistantRateLimited(req.currentUser.orgId)) {
      return res.status(429).json({ detail: "Too many questions in a short time. Please wait a bit and try again." });
    }

    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ detail: parsed.error.issues });
    }

    if (!settings.anthropicApiKey) {
      return res.status(503).json({
        detail:
          "The AI assistant needs an Anthropic API key configured on the server. In the meantime, use the Review Queue, Matching, and Export tabs directly.",
      });
    }

    const invoices = await Invoice.findAll({
      where: { orgId: req.currentUser.orgId },
      order: [["createdAt", "DESC"]],
      limit: MAX_INVOICES_IN_CONTEXT,
    });

    const matchResults = await MatchResult.findAll({
      include: [{ model: Invoice, attributes: [], where: { orgId: req.currentUser.orgId }, required: true }],
      order: [["createdAt", "DESC"]],
    });
    const latestMatchByInvoice = new Map();
    for (const mr of matchResults) {
      if (!latestMatchByInvoice.has(mr.invoiceId)) latestMatchByInvoice.set(mr.invoiceId, mr.status);
    }

    const dataset = invoices.map((inv) => ({
      vendor: inv.vendorName || null,
      invoice_number: inv.invoiceNumber || null,
      status: inv.status,
      invoice_date: inv.invoiceDate,
      due_date: inv.dueDate,
      total: inv.total,
      currency: inv.currency,
      po_reference: inv.poReference || null,
      overall_confidence: inv.overallConfidence,
      cross_check_passed: inv.crossCheckPassed,
      match_status: latestMatchByInvoice.get(inv.id) || null,
    }));

    const truncated = invoices.length === MAX_INVOICES_IN_CONTEXT;
    const client = new Anthropic({
      apiKey: settings.anthropicApiKey,
      timeout: LLM_TIMEOUT_MS,
      maxRetries: LLM_MAX_RETRIES,
    });
    const response = await client.messages.create({
      model: settings.anthropicModel,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `This organization has ${dataset.length} invoice(s)${truncated ? " (showing the most recent " + MAX_INVOICES_IN_CONTEXT + " only -- older ones aren't included below)" : ""} as JSON:\n\n` +
            `${JSON.stringify(dataset)}\n\nQuestion: ${parsed.data.question}`,
        },
      ],
    });

    const answerBlock = response.content.find((block) => block.type === "text");
    res.json({ answer: answerBlock ? answerBlock.text : "", invoice_count: invoices.length });
  } catch (err) {
    next(err);
  }
});

export default router;
