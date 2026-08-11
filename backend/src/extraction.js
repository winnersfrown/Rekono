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
    },
    required: ["vendor_name", "invoice_number", "invoice_date", "total", "line_items"],
  },
};

function extractionPrompt(ocrText) {
  return `You are an accounts-payable data entry specialist. Below is raw OCR text extracted from a scanned invoice. OCR errors (misread characters, broken lines, stray whitespace) are expected -- use context to recover the correct values.

Call the \`record_invoice\` tool with the extracted fields. For every *_confidence field, report your genuine confidence (0.0 to 1.0) that the value is correct, based on how legible/unambiguous the source text was. If a field is not present in the document, use an empty string (or 0 for numbers) and a low confidence.

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

async function extractWithLlm(ocrText) {
  const client = new Anthropic({ apiKey: settings.anthropicApiKey });
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

  return { method: "llm", fields, fieldConfidence, lineItems };
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
    fields.vendor_name = lines[0].slice(0, 512);
    fieldConfidence.vendor_name = HEURISTIC_FIELD_CONFIDENCE;
  }

  const invMatch = ocrText.match(/invoice\s*(?:#|no\.?|number)?\s*[:\-]?\s*([A-Za-z0-9\-]{2,})/i);
  if (invMatch) {
    fields.invoice_number = invMatch[1];
    fieldConfidence.invoice_number = HEURISTIC_FIELD_CONFIDENCE;
  }

  const dateMatch = ocrText.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  if (dateMatch) {
    fields.invoice_date = normalizeLooseDate(dateMatch[1]);
    fieldConfidence.invoice_date = HEURISTIC_FIELD_CONFIDENCE;
  }

  const poMatch = ocrText.match(/\bP\.?O\.?\s*(?:#|no\.?|number)?\s*[:\-]?\s*([A-Za-z0-9\-]{2,})/i);
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

  const taxMatch = ocrText.match(/tax\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i);
  if (taxMatch) {
    fields.tax = parseFloat(taxMatch[1].replace(/,/g, ""));
    fieldConfidence.tax = HEURISTIC_FIELD_CONFIDENCE;
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

  return { method: "heuristic", fields, fieldConfidence, lineItems };
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
