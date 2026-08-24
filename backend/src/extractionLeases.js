// Structured extraction for commercial lease abstraction, on top of raw
// OCR text. Mirrors extractionVendorDocs.js's shape (Gemini forced
// function calling + a heuristic regex fallback when no GEMINI_API_KEY is
// configured) applied to a lease's own schema -- rent, escalations, and
// two distinct critical dates: when the lease itself ends, and the
// (often much earlier) deadline to exercise a renewal option.

import { callTool, llmConfigured } from "./llm.js";

// snake_case keys throughout, same convention as extraction.js -- flows
// straight into the API's field_confidence JSON blob.
export const FIELDS = [
  "landlord_name",
  "property_address",
  "commencement_date",
  "expiration_date",
  "renewal_notice_deadline",
  "monthly_rent",
  "annual_escalation_pct",
];

const HEURISTIC_FIELD_CONFIDENCE = 0.5;

const LEASE_TOOL = {
  name: "record_lease",
  description: "Record structured data extracted from a commercial lease, with a self-reported confidence (0.0-1.0) for every field.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      landlord_name: { type: "string", description: "The landlord/lessor named on the lease." },
      landlord_name_confidence: { type: "number" },
      property_address: { type: "string", description: "The address of the leased premises." },
      property_address_confidence: { type: "number" },
      commencement_date: { type: "string", description: "ISO format YYYY-MM-DD -- when the lease term begins. Empty string if unknown." },
      commencement_date_confidence: { type: "number" },
      expiration_date: { type: "string", description: "ISO format YYYY-MM-DD -- when the lease term ends. Empty string if unknown." },
      expiration_date_confidence: { type: "number" },
      renewal_notice_deadline: {
        type: "string",
        description:
          "ISO format YYYY-MM-DD -- the deadline to notify the landlord in order to exercise a renewal/extension option, if the lease has one. This is often well before the expiration date. Empty string if there's no renewal option or the deadline isn't stated.",
      },
      renewal_notice_deadline_confidence: { type: "number" },
      monthly_rent: { type: "number", description: "The current base monthly rent." },
      monthly_rent_confidence: { type: "number" },
      annual_escalation_pct: { type: "number", description: "The annual rent escalation/increase, as a percentage (e.g. 3 for 3%). 0 if the lease has no escalation clause." },
      annual_escalation_pct_confidence: { type: "number" },
    },
    required: ["landlord_name", "property_address"],
  },
};

function extractionPrompt(ocrText) {
  return `You are a commercial lease abstraction specialist. Below is raw OCR text extracted from a scanned or photographed lease agreement. OCR errors (misread characters, broken lines, stray whitespace) are expected -- use context to recover the correct values.

Call the \`record_lease\` tool with the extracted fields. For every *_confidence field, report your genuine confidence (0.0 to 1.0) that the value is correct, based on how legible/unambiguous the source text was. If a field is not present or doesn't apply, use an empty string (or 0 for numbers) and a low confidence.

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
    tool: LEASE_TOOL,
    maxOutputTokens: 2048,
  });

  const fields = {
    landlord_name: data.landlord_name || "",
    property_address: (data.property_address || "").slice(0, 512),
    commencement_date: cleanDate(data.commencement_date),
    expiration_date: cleanDate(data.expiration_date),
    renewal_notice_deadline: cleanDate(data.renewal_notice_deadline),
    monthly_rent: cleanNumber(data.monthly_rent),
    annual_escalation_pct: cleanNumber(data.annual_escalation_pct),
  };

  const fieldConfidence = {};
  for (const field of FIELDS) {
    fieldConfidence[field] = clamp01(data[`${field}_confidence`] ?? 0);
  }

  return { method: "llm", fields, fieldConfidence };
}

function extractHeuristic(ocrText) {
  const fields = Object.fromEntries(FIELDS.map((f) => [f, ""]));
  fields.monthly_rent = null;
  fields.annual_escalation_pct = null;
  const fieldConfidence = Object.fromEntries(FIELDS.map((f) => [f, 0]));

  const lines = ocrText
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean);

  // Same "skip a generic document-title header line" reasoning as the
  // other extraction modules -- the first non-generic line is usually the
  // landlord's own name/letterhead.
  if (lines.length) {
    const genericHeaderLine = /^(commercial )?lease( agreement)?s?\b/i;
    const landlordLine = lines.find((ln) => !(genericHeaderLine.test(ln) && ln.length <= 40));
    if (landlordLine) {
      fields.landlord_name = landlordLine.slice(0, 512);
      fieldConfidence.landlord_name = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  const propertyAddress = findLabeledValue(lines, /\b(premises|property address|located at)\b/i);
  if (propertyAddress) {
    fields.property_address = propertyAddress.slice(0, 512);
    fieldConfidence.property_address = HEURISTIC_FIELD_CONFIDENCE;
  }

  // Prefer a date sitting on/right after a line naming what it is --
  // otherwise a lease with several dates on it (execution, commencement,
  // expiration, renewal notice) has no reliable way to tell them apart
  // from position alone.
  const expirationDate = findLabeledDate(lines, /\b(expir|termination date|lease end|term ends)/i);
  if (expirationDate) {
    fields.expiration_date = expirationDate;
    fieldConfidence.expiration_date = HEURISTIC_FIELD_CONFIDENCE;
  }

  const renewalNoticeDeadline = findLabeledDate(lines, /\b(renewal notice|notice of renewal|option (notice|deadline))/i);
  if (renewalNoticeDeadline) {
    fields.renewal_notice_deadline = renewalNoticeDeadline;
    fieldConfidence.renewal_notice_deadline = HEURISTIC_FIELD_CONFIDENCE;
  }

  const commencementDate = findLabeledDate(lines, /\b(commencement|lease start|start date|term begins)/i);
  if (commencementDate) {
    fields.commencement_date = commencementDate;
    fieldConfidence.commencement_date = HEURISTIC_FIELD_CONFIDENCE;
  } else if (!expirationDate && !renewalNoticeDeadline) {
    // Nothing labeled at all -- fall back to the first date in the
    // document as a low-confidence guess at the commencement date, same
    // "better than nothing, a human checks it in review" reasoning as the
    // other extraction modules.
    const anyDateMatch = ocrText.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
    if (anyDateMatch) {
      const d = normalizeLooseDate(anyDateMatch[1]);
      if (d) {
        fields.commencement_date = d;
        fieldConfidence.commencement_date = HEURISTIC_FIELD_CONFIDENCE;
      }
    }
  }

  const rentMatch = ocrText.match(/\b(?:monthly rent|base rent|rent per month)\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i);
  if (rentMatch) {
    fields.monthly_rent = parseFloat(rentMatch[1].replace(/,/g, ""));
    fieldConfidence.monthly_rent = HEURISTIC_FIELD_CONFIDENCE;
  }

  const escalationMatch = ocrText.match(/\b(?:escalation|annual increase|rent increase)\D{0,20}?(\d{1,2}(?:\.\d+)?)\s*%/i);
  if (escalationMatch) {
    fields.annual_escalation_pct = parseFloat(escalationMatch[1]);
    fieldConfidence.annual_escalation_pct = HEURISTIC_FIELD_CONFIDENCE;
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

// Looks for text after a "Label:" on the line matching `labelPattern`
// (e.g. "Premises: 123 Main St, Suite 4"), falling back to the next line
// if the label line has nothing after the colon.
function findLabeledValue(lines, labelPattern) {
  const labelIndex = lines.findIndex((ln) => labelPattern.test(ln));
  if (labelIndex === -1) return "";
  const labelLine = lines[labelIndex];
  const afterColon = labelLine.split(":").slice(1).join(":").trim();
  if (afterColon) return afterColon;
  return (lines[labelIndex + 1] || "").trim();
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
