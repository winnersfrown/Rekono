// "Ask Rekono" -- a grounded Q&A assistant over the org's own invoice
// data. Deliberately read-only: it answers questions, it doesn't take
// actions (approve/reject/export/etc.), so there's no risk of an LLM
// mistake mutating anyone's books. The client resends the visible thread
// (capped below) with each question so follow-ups like "what about just
// the unpaid ones" work, but nothing is persisted server-side -- there's
// no stored conversation to clean up, and a page reload starts fresh.

import { GoogleGenAI } from "@google/genai";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { settings } from "../config.js";
import { Invoice, MatchResult } from "../models/index.js";
import { createRateLimiter } from "../rateLimit.js";

const router = Router();

const historyEntrySchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(5000),
});
const askSchema = z.object({
  question: z.string().min(1).max(1000),
  history: z.array(historyEntrySchema).max(30).optional(),
});

const MAX_INVOICES_IN_CONTEXT = 300;

// Only the last few exchanges -- enough for "what about just the unpaid
// ones" to resolve against the previous answer, without letting the
// context (and per-question token cost) grow unbounded over a long thread.
const MAX_HISTORY_MESSAGES = 12; // 6 question/answer exchanges

// The Gemini API requires strict user/model alternation starting with
// "user". The client always sends well-formed history, but this is a
// public endpoint behind only auth -- a hand-crafted request with malformed
// history should degrade to "answer without memory" rather than fail the
// whole question.
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  for (let i = 0; i < trimmed.length; i++) {
    const expectedRole = i % 2 === 0 ? "user" : "assistant";
    if (trimmed[i].role !== expectedRole) return [];
  }
  return trimmed;
}

// Every question is a real Gemini API call -- real money, not just server
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
const LLM_MAX_ATTEMPTS = 2; // original call + one retry

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

    if (!settings.geminiApiKey) {
      return res.status(503).json({
        detail:
          "The AI assistant needs a Gemini API key configured on the server. In the meantime, use the Review Queue, Matching, and Export tabs directly.",
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
    const client = new GoogleGenAI({
      apiKey: settings.geminiApiKey,
      httpOptions: { timeout: LLM_TIMEOUT_MS, retryOptions: { attempts: LLM_MAX_ATTEMPTS } },
    });
    // Gemini's roles are "user"/"model", not Anthropic's "user"/"assistant" --
    // sanitizeHistory already guarantees strict user/assistant alternation
    // starting with "user", so a direct role rename is all that's needed.
    const history = sanitizeHistory(parsed.data.history).map((entry) => ({
      role: entry.role === "assistant" ? "model" : "user",
      parts: [{ text: entry.content }],
    }));

    // Own try/catch around just the Gemini call (unlike extraction.js/
    // quickbooks.js's LLM calls, there's no heuristic fallback for open-
    // ended Q&A -- a failure here IS the failure) so a real API error (rate
    // limit, an unavailable model, a safety block, ...) surfaces as a clear,
    // logged 502 instead of an opaque 500 with nothing in the server logs to
    // diagnose from.
    let response;
    try {
      response = await client.models.generateContent({
        model: settings.geminiModel,
        config: { systemInstruction: SYSTEM_PROMPT, maxOutputTokens: 1024 },
        contents: [
          ...history,
          {
            role: "user",
            parts: [
              {
                text:
                  `This organization has ${dataset.length} invoice(s)${truncated ? " (showing the most recent " + MAX_INVOICES_IN_CONTEXT + " only -- older ones aren't included below)" : ""} as JSON:\n\n` +
                  `${JSON.stringify(dataset)}\n\nQuestion: ${parsed.data.question}`,
              },
            ],
          },
        ],
      });
    } catch (err) {
      console.error("Ask Rekono: Gemini call failed:", err.message);
      return res.status(502).json({ detail: "Couldn't get an answer just now. Please try again in a moment." });
    }

    // response.text is a getter that can throw (not just return undefined)
    // when the response has no candidates at all -- e.g. the prompt itself
    // got blocked by a safety filter -- so this stays inside the same
    // try/catch as the call above rather than being read afterward.
    let answer;
    try {
      answer = response.text || "";
    } catch (err) {
      console.error("Ask Rekono: Gemini returned no usable response:", err.message);
      return res.status(502).json({ detail: "Couldn't get an answer to that question. Try rephrasing it." });
    }

    res.json({ answer, invoice_count: invoices.length });
  } catch (err) {
    next(err);
  }
});

export default router;
