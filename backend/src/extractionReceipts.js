// Structured extraction for expense receipts, on top of raw OCR text.
// Mirrors extraction.js's shape (Gemini forced function calling + a
// heuristic regex fallback when no GEMINI_API_KEY is configured) applied
// to a different schema -- a receipt has a merchant, a date, an amount,
// and a category, not a vendor/invoice-number/PO-reference/line-items.

import { callTool, llmConfigured } from "./llm.js";
import { EXPENSE_CATEGORIES } from "./models/ExpenseReceipt.js";

// snake_case keys throughout, same convention as extraction.js -- flows
// straight into the API's field_confidence JSON blob.
export const FIELDS = ["merchant_name", "receipt_date", "category", "tax", "amount"];

const HEURISTIC_FIELD_CONFIDENCE = 0.5;

const RECEIPT_TOOL = {
  name: "record_receipt",
  description:
    "Record structured data extracted from an expense receipt, with a self-reported confidence (0.0-1.0) for every field.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      merchant_name: { type: "string" },
      merchant_name_confidence: { type: "number" },
      receipt_date: { type: "string", description: "ISO format YYYY-MM-DD, empty string if unknown" },
      receipt_date_confidence: { type: "number" },
      category: {
        type: "string",
        enum: EXPENSE_CATEGORIES,
        description: "Best-fit expense category from the given list, based on the merchant and what was purchased.",
      },
      category_confidence: { type: "number" },
      currency: { type: "string", description: "ISO currency code, e.g. USD" },
      tax: { type: "number" },
      tax_confidence: { type: "number" },
      amount: { type: "number", description: "The total amount paid, including tax and tip if present." },
      amount_confidence: { type: "number" },
    },
    required: ["merchant_name", "receipt_date", "category", "amount"],
  },
};

function extractionPrompt(ocrText) {
  return `You are an expense-report data entry specialist. Below is raw OCR text extracted from a scanned or photographed receipt. OCR errors (misread characters, broken lines, stray whitespace) are expected -- use context to recover the correct values.

Call the \`record_receipt\` tool with the extracted fields. For every *_confidence field, report your genuine confidence (0.0 to 1.0) that the value is correct, based on how legible/unambiguous the source text was. If a field is not present in the document, use an empty string (or 0 for numbers) and a low confidence. category must be exactly one of: ${EXPENSE_CATEGORIES.join(", ")}.

OCR text:
---
${ocrText}
---
`;
}

export async function extract(ocrText) {
  if (llmConfigured()) {
    try {
      return await extractWithLlm(ocrText);
    } catch {
      // Fall back rather than fail the whole pipeline on a transient API
      // error; the low heuristic confidence will route it to review.
      return extractHeuristic(ocrText);
    }
  }
  return extractHeuristic(ocrText);
}

async function extractWithLlm(ocrText) {
  const data = await callTool({
    prompt: extractionPrompt(ocrText.slice(0, 15000)),
    tool: RECEIPT_TOOL,
    maxOutputTokens: 2048,
  });

  const fields = {
    merchant_name: data.merchant_name || "",
    receipt_date: cleanDate(data.receipt_date),
    category: EXPENSE_CATEGORIES.includes(data.category) ? data.category : "",
    currency: data.currency || "USD",
    tax: cleanNumber(data.tax),
    amount: cleanNumber(data.amount),
  };

  const fieldConfidence = {};
  for (const field of FIELDS) {
    fieldConfidence[field] = clamp01(data[`${field}_confidence`] ?? 0);
  }

  return { method: "llm", fields, fieldConfidence };
}

function extractHeuristic(ocrText) {
  const fields = Object.fromEntries(FIELDS.map((f) => [f, ""]));
  fields.currency = "USD";
  fields.tax = null;
  fields.amount = null;
  const fieldConfidence = Object.fromEntries(FIELDS.map((f) => [f, 0]));

  const lines = ocrText
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean);

  // Same "skip a generic document-type header line" reasoning as
  // extraction.js's vendor-name heuristic -- the first non-generic line is
  // usually the merchant's own name/letterhead.
  if (lines.length) {
    const genericHeaderLine = /^(receipt|invoice|bill|order|transaction)s?\b/i;
    const merchantLine = lines.find((ln) => !(genericHeaderLine.test(ln) && ln.length <= 20));
    if (merchantLine) {
      fields.merchant_name = merchantLine.slice(0, 512);
      fieldConfidence.merchant_name = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  const dateMatch = ocrText.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  if (dateMatch) {
    const d = normalizeLooseDate(dateMatch[1]);
    if (d) {
      fields.receipt_date = d;
      fieldConfidence.receipt_date = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  // Same "last decimal amount on/after the label line, excluding a
  // percentage" reasoning as extraction.js's tax heuristic.
  const taxLineIndex = lines.findIndex((ln) => /\btax\b/i.test(ln));
  if (taxLineIndex !== -1) {
    for (const ln of [lines[taxLineIndex], lines[taxLineIndex + 1]]) {
      if (!ln) continue;
      const amounts = [...ln.matchAll(/\$?\s*([\d,]+\.\d{2})(?!\s*%)(?!\d)/g)];
      if (amounts.length) {
        fields.tax = parseFloat(amounts[amounts.length - 1][1].replace(/,/g, ""));
        fieldConfidence.tax = HEURISTIC_FIELD_CONFIDENCE;
        break;
      }
    }
  }

  const totalMatch = ocrText.match(/(?<!sub)(?<!sub-)(?<!sub )total\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i);
  if (totalMatch) {
    fields.amount = parseFloat(totalMatch[1].replace(/,/g, ""));
    fieldConfidence.amount = HEURISTIC_FIELD_CONFIDENCE;
  }

  const category = guessCategoryHeuristic(ocrText);
  if (category) {
    fields.category = category;
    fieldConfidence.category = HEURISTIC_FIELD_CONFIDENCE;
  }

  return { method: "heuristic", fields, fieldConfidence };
}

// A crude keyword match -- good enough to route a receipt somewhere
// sensible without an LLM available; a human corrects it in review the
// same way any other low-confidence heuristic field gets corrected.
const CATEGORY_KEYWORDS = {
  Travel: /\b(airlines?|airways|hotel|motel|uber|lyft|taxi|rental car|parking|flight)\b/i,
  "Meals & Entertainment": /\b(restaurant|cafe|coffee|bar\b|grill|kitchen|diner|bistro)\b/i,
  "Office Supplies": /\b(office depot|staples|supplies|paper|printer|ink\b)\b/i,
  "Software & Subscriptions": /\b(subscription|software|saas|license|monthly plan)\b/i,
  Utilities: /\b(electric|gas company|water utility|internet service|phone bill)\b/i,
};

function guessCategoryHeuristic(ocrText) {
  for (const [category, pattern] of Object.entries(CATEGORY_KEYWORDS)) {
    if (pattern.test(ocrText)) return category;
  }
  return "";
}

function cleanNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function cleanDate(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return value;
  return normalizeLooseDate(String(value));
}

function normalizeLooseDate(value) {
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return value;

  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let [, m, d, y] = slash;
    if (y.length === 2) y = `20${y}`;
    if (Number(m) > 12 && Number(d) <= 12) [m, d] = [d, m];
    const mm = m.padStart(2, "0");
    const dd = d.padStart(2, "0");
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) {
      return `${y}-${mm}-${dd}`;
    }
  }
  return "";
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
