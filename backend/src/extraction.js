// Structured extraction on top of raw OCR text.
//
// Primary path: an LLM (Gemini or OpenRouter -- see llm.js) forced into a
// fixed JSON schema via function calling, with a self-reported confidence
// per field -- the core IP layer.
//
// Fallback path: a heuristic regex extractor used when no LLM is
// configured, so the ingestion -> extraction -> review -> export pipeline
// still runs end to end for local demos, tests, and CI without a live LLM
// call. Heuristic fields get a flat, low confidence score, which naturally
// routes them into the human review queue.

import { callTool, llmConfigured } from "./llm.js";

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
  "shipping",
  "discount",
  "tax",
  "payment_terms",
  "total",
];

const HEURISTIC_FIELD_CONFIDENCE = 0.5;

const INVOICE_TOOL = {
  name: "record_invoice",
  description:
    "Record structured data extracted from an invoice, with a self-reported confidence (0.0-1.0) for every field.",
  parametersJsonSchema: {
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
      // Everything between the subtotal and the total. The model is told to
      // account for all of it: a charge it leaves out doesn't vanish, it
      // shows up as a failed cross-check on an invoice that was correct.
      shipping: {
        type: "number",
        description: "Shipping, freight or delivery charge. 0 if absent.",
      },
      shipping_confidence: { type: "number" },
      discount: {
        type: "number",
        description:
          "Discount or credit applied, as a POSITIVE number to be subtracted (a $25 discount is 25, not -25). 0 if absent.",
      },
      discount_confidence: { type: "number" },
      other_charges: {
        type: "array",
        description:
          "Any other line between the subtotal and the total that is not shipping, discount or tax -- handling, service charge, surcharge, deposit applied, and so on. Signed: a credit is negative. Empty array if there are none.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            amount: { type: "number" },
          },
          required: ["label", "amount"],
        },
      },
      tax: { type: "number" },
      tax_confidence: { type: "number" },
      payment_terms: {
        type: "string",
        description: 'Payment terms exactly as printed, e.g. "2/10 n/30", "Net 30", "Due on receipt". Empty string if absent.',
      },
      payment_terms_confidence: { type: "number" },
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
    tool: INVOICE_TOOL,
    maxOutputTokens: 4096,
  });

  const fields = {
    vendor_name: data.vendor_name || "",
    invoice_number: data.invoice_number || "",
    invoice_date: cleanDate(data.invoice_date),
    due_date: cleanDate(data.due_date),
    po_reference: data.po_reference || "",
    currency: data.currency || "USD",
    subtotal: cleanNumber(data.subtotal),
    // Normalised to a positive magnitude here so the arithmetic downstream
    // never has to guess at the sign a vendor happened to print.
    shipping: cleanNumber(data.shipping),
    discount: data.discount == null ? null : Math.abs(cleanNumber(data.discount) ?? 0),
    other_charges: normalizeOtherCharges(data.other_charges),
    tax: cleanNumber(data.tax),
    payment_terms: (data.payment_terms || "").toString().slice(0, 64),
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

  // Shipping and discount, read the same way as tax and for the same
  // reason: the amount is the last non-percentage figure on the line, so a
  // "Discount 10% $45.00" line yields 45.00 rather than 10.
  //
  // Without these the heuristic path can extract an invoice it then fails
  // its own cross-check on, which is the exact failure this release exists
  // to remove -- there is no point fixing it only for the LLM path.
  const amountOnLine = (index) => {
    for (const ln of [lines[index], lines[index + 1]]) {
      if (!ln) continue;
      const amounts = [...ln.matchAll(/\$?\s*([\d,]+\.\d{2})(?!\s*%)(?!\d)/g)];
      if (amounts.length) return parseFloat(amounts[amounts.length - 1][1].replace(/,/g, ""));
    }
    return null;
  };

  const shippingIndex = lines.findIndex((ln) => /\b(shipping|freight|delivery)\b/i.test(ln));
  if (shippingIndex !== -1) {
    const amount = amountOnLine(shippingIndex);
    if (amount !== null) {
      fields.shipping = amount;
      fieldConfidence.shipping = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  const discountIndex = lines.findIndex((ln) => /\b(discount|credit)\b/i.test(ln));
  if (discountIndex !== -1) {
    const amount = amountOnLine(discountIndex);
    // Stored as a positive magnitude regardless of how it was printed --
    // "-45.00" and "45.00" mean the same thing on a discount line.
    if (amount !== null) {
      fields.discount = Math.abs(amount);
      fieldConfidence.discount = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  // "2/10 n/30", "2/10 net 30", "Net 30", "Due on receipt".
  const termsMatch = ocrText.match(/\b(\d{1,2}\s*\/\s*\d{1,2}\s*,?\s*n(?:et)?\s*\/?\s*\d{1,3}|net\s*\d{1,3}|due\s+on\s+receipt)\b/i);
  if (termsMatch) {
    fields.payment_terms = termsMatch[1].replace(/\s+/g, " ").trim().slice(0, 64);
    fieldConfidence.payment_terms = HEURISTIC_FIELD_CONFIDENCE;
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

  // FIELDS seeds every key with "", which is right for the text fields and
  // wrong for the money ones: an unfound amount has to reach the FLOAT
  // column as null, not as an empty string. subtotal/tax/total have always
  // needed this; adding shipping and discount to FIELDS is what made it
  // worth doing once, by name, instead of per field.
  for (const key of ["subtotal", "shipping", "discount", "tax", "total"]) {
    if (fields[key] === "") fields[key] = null;
  }
  // Not in FIELDS: it is a list, so it has no single confidence score of
  // its own. The heuristic path never populates it -- reading an arbitrary
  // labelled charge line is exactly the judgement the LLM is there for --
  // but it has to exist so the cross-check and the UI can treat both paths
  // identically.
  fields.other_charges = [];

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

// The long-tail charges between subtotal and total. Kept as a labelled list
// rather than more columns because the set is genuinely open -- handling,
// surcharge, deposit applied, freight insurance, "Fuel adjustment" -- and a
// charge the schema can't name is a charge the cross-check can't reconcile.
// A row with no usable amount is dropped rather than kept as a zero: a
// zero would silently pass the cross-check while hiding that something on
// the page wasn't read.
export function normalizeOtherCharges(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      const amount = cleanNumber(row?.amount);
      if (amount === null) return null;
      const label = String(row?.label ?? "").trim().slice(0, 128);
      return { label: label || "Other charge", amount };
    })
    .filter(Boolean)
    .slice(0, 20);
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
