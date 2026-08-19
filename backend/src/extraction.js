// Structured extraction on top of raw OCR text.
//
// Primary path: Claude, forced into a fixed JSON schema via tool-use, with a
// self-reported confidence per field -- the core IP layer.
//
// Fallback path: a heuristic regex extractor used when no ANTHROPIC_API_KEY
// is configured, so the ingestion -> extraction -> review -> export
// pipeline still runs end to end for local demos, tests, and CI without a
// live LLM call. Heuristic fields get a flat, low confidence score, which
// naturally routes them into the human review queue.

import Anthropic from "@anthropic-ai/sdk";
import { settings } from "./config.js";

// snake_case keys throughout this module (fields, field_confidence) --
// matches the Python backend's dict keys exactly, and these flow straight
// into the API's `field_confidence` JSON blob, which the frontend reads by
// these exact names (see public/app.js's fieldConf/lowConf lookups).
export const FIELDS = [
  "vendor_name",
  "invoice_number",
  "invoice_date",
  "due_date",
  "po_reference",
  "currency",
  "subtotal",
  "tax",
  "total",
];

const HEURISTIC_FIELD_CONFIDENCE = 0.5;

const INVOICE_TOOL = {
  name: "record_invoice",
  description:
    "Record structured data extracted from an invoice, with a self-reported confidence (0.0-1.0) for every field.",
  input_schema: {
    type: "object",
    properties: {
      vendor_name: { type: "string" },
      vendor_name_confidence: { type: "number" },
      invoice_number: { type: "string" },
      invoice_number_confidence: { type: "number" },
      invoice_date: { type: "string", description: "ISO format YYYY-MM-DD, empty string if unknown" },
      invoice_date_confidence: { type: "number" },
      due_date: { type: "string", description: "ISO format YYYY-MM-DD, empty string if unknown/absent" },
      due_date_confidence: { type: "number" },
      po_reference: { type: "string", description: "Purchase order number/reference, empty string if absent" },
      po_reference_confidence: { type: "number" },
      currency: { type: "string", description: "ISO currency code, e.g. USD" },
      subtotal: { type: "number" },
      subtotal_confidence: { type: "number" },
      tax: { type: "number" },
      tax_confidence: { type: "number" },
      total: { type: "number" },
      total_confidence: { type: "number" },
      line_items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            quantity: { type: "number" },
            unit_price: { type: "number" },
            amount: { type: "number" },
            confidence: { type: "number" },
          },
          required: ["description"],
        },
      },
      possible_multiple_invoices: {
        type: "boolean",
        description:
          "true if the OCR text looks like it contains more than one distinct invoice -- e.g. more than one invoice number, more than one 'total due', or repeated header/footer blocks for different vendors or dates. false for a single invoice, even a multi-page one.",
      },
      possible_multiple_invoices_reason: {
        type: "string",
        description: "One short sentence explaining why, if possible_multiple_invoices is true. Empty string otherwise.",
      },
    },
    required: ["vendor_name", "invoice_number", "invoice_date", "total", "line_items", "possible_multiple_invoices"],
  },
};

function extractionPrompt(ocrText) {
  return `You are an accounts-payable data entry specialist. Below is raw OCR text extracted from a scanned invoice. OCR errors (misread characters, broken lines, stray whitespace) are expected -- use context to recover the correct values.

Call the \`record_invoice\` tool with the extracted fields. For every *_confidence field, report your genuine confidence (0.0 to 1.0) that the value is correct, based on how legible/unambiguous the source text was. If a field is not present in the document, use an empty string (or 0 for numbers) and a low confidence. Extract the first/primary invoice's fields even if you set possible_multiple_invoices to true -- don't try to merge multiple invoices into one set of fields.

OCR text:
---
${ocrText}
---
`;
}

export async function extract(ocrText) {
  if (settings.anthropicApiKey) {
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

// Bounds the worst case for a single extraction call: the SDK's default
// timeout is several minutes, and its default retry behavior can multiply
// that further. A single retry within a 60s budget is enough to ride out a
// transient blip while still failing fast into the heuristic fallback (see
// `extract`, above) rather than leaving the invoice stuck "processing" for
// minutes with the user watching a spinner.
const LLM_TIMEOUT_MS = 60_000;
const LLM_MAX_RETRIES = 1;

async function extractWithLlm(ocrText) {
  const client = new Anthropic({
    apiKey: settings.anthropicApiKey,
    timeout: LLM_TIMEOUT_MS,
    maxRetries: LLM_MAX_RETRIES,
  });
  const response = await client.messages.create({
    model: settings.anthropicModel,
    max_tokens: 4096,
    tools: [INVOICE_TOOL],
    tool_choice: { type: "tool", name: "record_invoice" },
    messages: [{ role: "user", content: extractionPrompt(ocrText.slice(0, 15000)) }],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  const data = toolUse.input;

  const fields = {
    vendor_name: data.vendor_name || "",
    invoice_number: data.invoice_number || "",
    invoice_date: cleanDate(data.invoice_date),
    due_date: cleanDate(data.due_date),
    po_reference: data.po_reference || "",
    currency: data.currency || "USD",
    subtotal: cleanNumber(data.subtotal),
    tax: cleanNumber(data.tax),
    total: cleanNumber(data.total),
  };

  const fieldConfidence = {};
  for (const field of FIELDS) {
    if (field === "currency") continue;
    fieldConfidence[field] = clamp01(data[`${field}_confidence`] ?? 0);
  }
  fieldConfidence.currency = fields.currency ? 1.0 : 0.0;

  const lineItems = (data.line_items || []).map((item) => ({
    description: item.description || "",
    quantity: cleanNumber(item.quantity),
    unitPrice: cleanNumber(item.unit_price),
    amount: cleanNumber(item.amount),
    confidence: clamp01(item.confidence ?? 0),
  }));

  return {
    method: "llm",
    fields,
    fieldConfidence,
    lineItems,
    possibleMultiInvoice: Boolean(data.possible_multiple_invoices),
    possibleMultiInvoiceReason: data.possible_multiple_invoices_reason || "",
  };
}

function extractHeuristic(ocrText) {
  const fields = Object.fromEntries(FIELDS.map((f) => [f, ""]));
  fields.currency = "USD";
  const fieldConfidence = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  fieldConfidence.currency = HEURISTIC_FIELD_CONFIDENCE;

  const lines = ocrText
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean);

  if (lines.length) {
    // Skip a leading generic document-type header ("INVOICE", "STATEMENT",
    // etc., often the largest text on the page and OCR'd as its own line)
    // rather than blindly taking line 1 -- otherwise the vendor name comes
    // back as literally the word "Invoice" whenever the document has one.
    // Matches at the start of the line rather than the whole line, capped
    // to a short length: OCR frequently merges a nearby logo/graphic's
    // misread text onto the same line (e.g. a logo placeholder reads as
    // "Loco" and lands right after "INVOICE"), which a whole-line-only
    // match would miss entirely -- but a real company name that happens to
    // start with one of these words ("Invoice Ninja Inc.") is usually
    // longer than a bare title line, so the length cap keeps this from
    // swallowing those too.
    const genericHeaderLine = /^(invoice|bill|receipt|statement|estimate|quote)s?\b/i;
    const vendorLine = lines.find((ln) => !(genericHeaderLine.test(ln) && ln.length <= 20));
    if (vendorLine) {
      fields.vendor_name = vendorLine.slice(0, 512);
      fieldConfidence.vendor_name = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  // Requires an explicit marker (#, "no", "number", or a colon/dash) between
  // "invoice" and the captured value -- without this, "invoice" matching the
  // page's own title (with nothing but a line break after it) would capture
  // whatever word starts the next line instead of the real invoice number.
  const invMatch = ocrText.match(/invoice\s*(?:#|no\.?|number|[:\-])\s*[:\-]?\s*([A-Za-z0-9\-]{2,})/i);
  if (invMatch) {
    fields.invoice_number = invMatch[1];
    fieldConfidence.invoice_number = HEURISTIC_FIELD_CONFIDENCE;
  }

  // Label-scoped rather than "the first date-shaped thing anywhere in the
  // document" -- a plain document-wide date regex has no way to tell an
  // invoice date apart from a due date, a PO date, or any other date on
  // the page, and would always win with whichever happens to appear first
  // in reading order. Due date is looked up first so invoice date's
  // fallback (any line just saying "date") can exclude it.
  const dueDateLine = lines.find((ln) => /\bdue\s*date\b/i.test(ln));
  if (dueDateLine) {
    const d = firstDateInLine(dueDateLine);
    if (d) {
      fields.due_date = d;
      fieldConfidence.due_date = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  const invoiceDateLine =
    lines.find((ln) => /\binvoice\s*date\b/i.test(ln)) || lines.find((ln) => /\bdate\b/i.test(ln) && ln !== dueDateLine);
  if (invoiceDateLine) {
    const d = firstDateInLine(invoiceDateLine);
    if (d) {
      fields.invoice_date = d;
      fieldConfidence.invoice_date = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  // Character class includes "/" -- a common separator in real PO
  // references (e.g. "2312/2019", an order-number/year format), which the
  // previous class silently truncated at.
  const poMatch = ocrText.match(/\bP\.?O\.?\s*(?:#|no\.?|number)?\s*[:\-]?\s*([A-Za-z0-9\-\/]{2,})/i);
  if (poMatch) {
    fields.po_reference = poMatch[1];
    fieldConfidence.po_reference = HEURISTIC_FIELD_CONFIDENCE;
  }

  const totalMatch = ocrText.match(
    /(?<!sub)(?<!sub-)(?<!sub )total\s*(?:due|amount)?\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i
  );
  if (totalMatch) {
    fields.total = parseFloat(totalMatch[1].replace(/,/g, ""));
    fieldConfidence.total = HEURISTIC_FIELD_CONFIDENCE;
  }

  const subtotalMatch = ocrText.match(/sub\s*-?\s*total\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i);
  if (subtotalMatch) {
    fields.subtotal = parseFloat(subtotalMatch[1].replace(/,/g, ""));
    fieldConfidence.subtotal = HEURISTIC_FIELD_CONFIDENCE;
  }

  // A simple "tax ... first decimal number after it" regex grabs a tax
  // *rate* ("Sales Tax 6.25%") instead of the actual tax amount whenever a
  // percentage sits between the label and the dollar figure -- both have
  // two decimal digits, so a bare \d+\.\d{2} pattern can't tell them apart.
  // Scanning the tax line (and the line after, in case OCR breaks the
  // label and amount onto separate lines) for every non-percentage decimal
  // number and taking the *last* one sidesteps that: amounts are reliably
  // the right-most/last figure on the line, while a rate immediately
  // precedes a literal "%".
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

  const lineItemPattern =
    /^(.{3,80}?)\s+(\d+(?:\.\d+)?)\s*[x@]?\s*\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})$/;
  const lineItems = [];
  for (const ln of lines) {
    const m = ln.match(lineItemPattern);
    if (m) {
      lineItems.push({
        description: m[1].trim(),
        quantity: parseFloat(m[2]),
        unitPrice: parseFloat(m[3].replace(/,/g, "")),
        amount: parseFloat(m[4].replace(/,/g, "")),
        confidence: HEURISTIC_FIELD_CONFIDENCE,
      });
    }
  }

  const multiInvoice = detectMultipleInvoicesHeuristic(ocrText);

  return {
    method: "heuristic",
    fields,
    fieldConfidence,
    lineItems,
    possibleMultiInvoice: multiInvoice.detected,
    possibleMultiInvoiceReason: multiInvoice.reason,
  };
}

// No LLM available to reason about this, so the heuristic fallback settles
// for the cheapest reliable signal: more than one *distinct* invoice number
// (the OCR text repeating the same one for a running total/footer doesn't
// count) is a strong sign of more than one invoice on the page. Deliberately
// conservative -- false negatives here just mean no flag, not a wrong
// extraction, so there's no reason to also fire on things like "Total"
// appearing twice (subtotal + total on a normal single invoice already does
// that).
function detectMultipleInvoicesHeuristic(ocrText) {
  const matches = ocrText.matchAll(/invoice\s*(?:#|no\.?|number)?\s*[:\-]?\s*([A-Za-z0-9\-]{2,})/gi);
  const distinctInvoiceNumbers = new Set();
  for (const m of matches) distinctInvoiceNumbers.add(m[1].toUpperCase());

  if (distinctInvoiceNumbers.size > 1) {
    return { detected: true, reason: `Found ${distinctInvoiceNumbers.size} different invoice numbers in the document.` };
  }
  return { detected: false, reason: "" };
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

function firstDateInLine(line) {
  const m = line.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  return m ? normalizeLooseDate(m[1]) : "";
}

function normalizeLooseDate(value) {
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return value;

  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let [, m, d, y] = slash;
    if (y.length === 2) y = `20${y}`;
    // Try %m/%d/%Y first (matches Python's format-precedence order); if the
    // first number can't be a month, fall back to %d/%m/%Y.
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
