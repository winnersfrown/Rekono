// Structured extraction for vendor compliance documents (W-9, certificate
// of insurance, contract), on top of raw OCR text. Mirrors extraction.js's
// shape (Gemini forced function calling + a heuristic regex fallback when
// no GEMINI_API_KEY is configured) applied to a third schema -- these
// documents share one thing invoices/receipts don't need: an expiration
// date, which is the whole point of this module (flag what's expiring or
// missing before it lapses).

import { callTool, llmConfigured } from "./llm.js";
import { VENDOR_DOCUMENT_TYPES } from "./models/VendorDocument.js";

// snake_case keys throughout, same convention as extraction.js -- flows
// straight into the API's field_confidence JSON blob.
export const FIELDS = ["vendor_name", "document_type", "effective_date", "expiration_date", "reference_number", "amount"];

const HEURISTIC_FIELD_CONFIDENCE = 0.5;

const VENDOR_DOC_TOOL = {
  name: "record_vendor_document",
  description:
    "Record structured data extracted from a vendor compliance document (W-9, certificate of insurance, or contract), with a self-reported confidence (0.0-1.0) for every field.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      vendor_name: { type: "string", description: "The vendor/business named on the document." },
      vendor_name_confidence: { type: "number" },
      document_type: {
        type: "string",
        enum: VENDOR_DOCUMENT_TYPES,
        description: "Best-fit document type from the given list.",
      },
      document_type_confidence: { type: "number" },
      effective_date: { type: "string", description: "ISO format YYYY-MM-DD, empty string if unknown or not applicable" },
      effective_date_confidence: { type: "number" },
      expiration_date: {
        type: "string",
        description:
          "ISO format YYYY-MM-DD. The date this document lapses/needs renewal (a policy's expiration, a contract's term end/renewal date). Empty string if the document doesn't expire (e.g. a W-9) or the date isn't stated.",
      },
      expiration_date_confidence: { type: "number" },
      reference_number: {
        type: "string",
        description: "The document's own identifying number: a TIN/EIN on a W-9, a policy number on a certificate of insurance, a contract number on a contract.",
      },
      reference_number_confidence: { type: "number" },
      amount: { type: "number", description: "Coverage/liability limit on a certificate of insurance, or total contract value. 0 if not applicable (e.g. a W-9)." },
      amount_confidence: { type: "number" },
    },
    required: ["vendor_name", "document_type"],
  },
};

function extractionPrompt(ocrText) {
  return `You are a vendor-compliance data entry specialist. Below is raw OCR text extracted from a scanned or photographed vendor document (a W-9, a certificate of insurance, or a contract). OCR errors (misread characters, broken lines, stray whitespace) are expected -- use context to recover the correct values.

Call the \`record_vendor_document\` tool with the extracted fields. For every *_confidence field, report your genuine confidence (0.0 to 1.0) that the value is correct, based on how legible/unambiguous the source text was. If a field is not present or doesn't apply to this document type, use an empty string (or 0 for numbers) and a low confidence. document_type must be exactly one of: ${VENDOR_DOCUMENT_TYPES.join(", ")}.

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
    tool: VENDOR_DOC_TOOL,
    maxOutputTokens: 2048,
  });

  const fields = {
    vendor_name: data.vendor_name || "",
    document_type: VENDOR_DOCUMENT_TYPES.includes(data.document_type) ? data.document_type : "",
    effective_date: cleanDate(data.effective_date),
    expiration_date: cleanDate(data.expiration_date),
    reference_number: (data.reference_number || "").slice(0, 128),
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
  fields.amount = null;
  const fieldConfidence = Object.fromEntries(FIELDS.map((f) => [f, 0]));

  const lines = ocrText
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean);

  // Same "skip a generic document-type header line" reasoning as
  // extraction.js's vendor-name heuristic -- the first non-generic line is
  // usually the vendor's own name/letterhead.
  if (lines.length) {
    // A longer threshold than the other two extraction modules' own
    // version of this check (they cap at 20) -- these documents' generic
    // header lines are real government-form/insurance-industry titles
    // ("Request for Taxpayer Identification Number...", "Certificate of
    // Liability Insurance"), routinely 40-60+ characters on their own.
    const genericHeaderLine = /^(form\s*w-?9|request for taxpayer|certificate of (liability )?insurance|acord|agreement|contract|lease)s?\b/i;
    const vendorLine = lines.find((ln) => !(genericHeaderLine.test(ln) && ln.length <= 70));
    if (vendorLine) {
      fields.vendor_name = vendorLine.slice(0, 512);
      fieldConfidence.vendor_name = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  const documentType = guessDocumentTypeHeuristic(ocrText);
  if (documentType) {
    fields.document_type = documentType;
    fieldConfidence.document_type = HEURISTIC_FIELD_CONFIDENCE;
  }

  // Prefer a date sitting on/right after a line naming what it is --
  // otherwise a document with several dates on it (issued, effective,
  // expiration) has no reliable way to tell them apart from position alone.
  const expirationDate = findLabeledDate(lines, /\b(expir|valid (until|through)|renewal date)/i);
  if (expirationDate) {
    fields.expiration_date = expirationDate;
    fieldConfidence.expiration_date = HEURISTIC_FIELD_CONFIDENCE;
  }

  const effectiveDate = findLabeledDate(lines, /\b(effective|issue date|issued|start date|date of)/i);
  if (effectiveDate) {
    fields.effective_date = effectiveDate;
    fieldConfidence.effective_date = HEURISTIC_FIELD_CONFIDENCE;
  } else if (!expirationDate) {
    // Nothing labeled at all -- fall back to the first date in the
    // document as a low-confidence guess at the effective date, same
    // "better than nothing, a human checks it in review" reasoning as the
    // other two extraction modules.
    const anyDateMatch = ocrText.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
    if (anyDateMatch) {
      const d = normalizeLooseDate(anyDateMatch[1]);
      if (d) {
        fields.effective_date = d;
        fieldConfidence.effective_date = HEURISTIC_FIELD_CONFIDENCE;
      }
    }
  }

  const referenceMatch = ocrText.match(
    /\b(?:policy|contract)\s*(?:#|no\.?|number)\s*[:\-]?\s*([A-Za-z0-9\-\/]{3,32})|(?:EIN|TIN|Tax ID)\s*[:\-]?\s*([\d\-]{7,12})/i
  );
  if (referenceMatch) {
    fields.reference_number = (referenceMatch[1] || referenceMatch[2] || "").slice(0, 128);
    fieldConfidence.reference_number = HEURISTIC_FIELD_CONFIDENCE;
  }

  const amountMatch = ocrText.match(
    /\b(?:coverage|liability limit|each occurrence|contract value|total value)\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i
  );
  if (amountMatch) {
    fields.amount = parseFloat(amountMatch[1].replace(/,/g, ""));
    fieldConfidence.amount = HEURISTIC_FIELD_CONFIDENCE;
  }

  return { method: "heuristic", fields, fieldConfidence };
}

// Looks for a date on the same line as (or the line right after) the first
// line matching `labelPattern`; returns the normalized ISO date, or "" if
// no labeled date is found.
function findLabeledDate(lines, labelPattern) {
  const labelIndex = lines.findIndex((ln) => labelPattern.test(ln));
  if (labelIndex === -1) return "";
  for (const ln of [lines[labelIndex], lines[labelIndex + 1]]) {
    if (!ln) continue;
    const dateMatch = ln.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
    if (dateMatch) {
      const d = normalizeLooseDate(dateMatch[1]);
      if (d) return d;
    }
  }
  return "";
}

const DOCUMENT_TYPE_KEYWORDS = {
  "W-9": /\b(form\s*w-?9|request for taxpayer identification)\b/i,
  "Certificate of Insurance": /\b(certificate of (liability )?insurance|acord\s*25|coi\b)\b/i,
  Contract: /\b(agreement|contract|lease|terms and conditions|statement of work|\bsow\b)\b/i,
};

function guessDocumentTypeHeuristic(ocrText) {
  for (const [type, pattern] of Object.entries(DOCUMENT_TYPE_KEYWORDS)) {
    if (pattern.test(ocrText)) return type;
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
