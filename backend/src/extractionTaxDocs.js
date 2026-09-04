// Structured extraction for inbound tax forms (1099s, W-2s, 1098s, K-1s),
// on top of raw OCR text. Mirrors extractionLeases.js's shape (Gemini
// forced function calling + a heuristic regex fallback when no
// GEMINI_API_KEY is configured) applied to a tax form's own schema.
//
// Two things here are specific to this document type rather than copied
// from the other four extractors: `tinLast4`, which reduces every taxpayer
// ID down to its last four digits on the way in, and `redactTins`, which
// scrubs the same numbers out of the OCR text before the pipeline persists
// it. See TaxDocument.js's recipientTinLast4 comment for why -- in short,
// these forms carry SSNs, and last-four is all the app actually needs.

import { callTool, llmConfigured } from "./llm.js";
import { TAX_DOCUMENT_TYPES } from "./models/TaxDocument.js";

// snake_case keys throughout, same convention as extraction.js -- flows
// straight into the API's field_confidence JSON blob.
export const FIELDS = [
  "document_type",
  "tax_year",
  "payer_name",
  "recipient_name",
  "recipient_tin_last4",
  "amount",
  "federal_tax_withheld",
];

const HEURISTIC_FIELD_CONFIDENCE = 0.5;

// A form issued for a year the software didn't exist in, or several years
// into the future, is an OCR misread of some other four-digit number on
// the page (a ZIP+4 fragment, a box number, a phone extension) rather than
// a real tax year.
const MIN_TAX_YEAR = 1990;
function maxTaxYear() {
  // Forms for year N arrive in January of N+1, and an org can legitimately
  // be filing an extension or an amendment for the current year, so the
  // ceiling has to be at least the current calendar year.
  return new Date().getUTCFullYear();
}

const TAX_DOC_TOOL = {
  name: "record_tax_document",
  description: "Record structured data extracted from an inbound tax form, with a self-reported confidence (0.0-1.0) for every field.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      document_type: {
        type: "string",
        enum: TAX_DOCUMENT_TYPES,
        description: "Which form this is. Use 'Other' for any form not in the list.",
      },
      document_type_confidence: { type: "number" },
      tax_year: { type: "number", description: "The tax year the form reports on (e.g. 2025), NOT the year it was printed or mailed. 0 if unknown." },
      tax_year_confidence: { type: "number" },
      payer_name: { type: "string", description: "The payer/employer/filer who issued the form -- the PAYER'S or EMPLOYER'S name box." },
      payer_name_confidence: { type: "number" },
      recipient_name: { type: "string", description: "The recipient/employee the form was issued to -- the RECIPIENT'S or EMPLOYEE'S name box." },
      recipient_name_confidence: { type: "number" },
      recipient_tin_last4: {
        type: "string",
        description:
          "ONLY the last four digits of the recipient's TIN/SSN/EIN (e.g. '6789'). Never return the full number. Empty string if the form doesn't show one.",
      },
      recipient_tin_last4_confidence: { type: "number" },
      amount: {
        type: "number",
        description:
          "The headline dollar figure for this form's type: box 1 nonemployee compensation on a 1099-NEC, box 1 wages on a W-2, gross payment card receipts on a 1099-K, interest on a 1099-INT, mortgage interest received on a 1098. 0 if unknown.",
      },
      amount_confidence: { type: "number" },
      federal_tax_withheld: { type: "number", description: "Federal income tax withheld. 0 if the box is blank or absent." },
      federal_tax_withheld_confidence: { type: "number" },
    },
    required: ["document_type", "payer_name"],
  },
};

function extractionPrompt(ocrText) {
  return `You are a tax document intake specialist. Below is raw OCR text extracted from a scanned or photographed US tax form. OCR errors (misread characters, broken lines, stray whitespace) are expected -- use context to recover the correct values.

Call the \`record_tax_document\` tool with the extracted fields. For every *_confidence field, report your genuine confidence (0.0 to 1.0) that the value is correct, based on how legible/unambiguous the source text was. If a field is not present or doesn't apply, use an empty string (or 0 for numbers) and a low confidence.

Be careful to distinguish the PAYER (who issued the form) from the RECIPIENT (who received it) -- they appear in separate boxes and are easy to swap. For the recipient's TIN, return only the last four digits.

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
    } catch (err) {
      // Fall back rather than fail the whole pipeline on a transient API
      // error; the low heuristic confidence will route it to review.
      console.error("Tax document extraction LLM call failed, falling back to heuristic:", err.message);
      return extractHeuristic(ocrText);
    }
  }
  return extractHeuristic(ocrText);
}

async function extractWithLlm(ocrText) {
  const data = await callTool({
    prompt: extractionPrompt(ocrText.slice(0, 15000)),
    tool: TAX_DOC_TOOL,
    maxOutputTokens: 2048,
  });

  const fields = {
    document_type: TAX_DOCUMENT_TYPES.includes(data.document_type) ? data.document_type : "Other",
    tax_year: cleanTaxYear(data.tax_year),
    payer_name: (data.payer_name || "").slice(0, 512),
    recipient_name: (data.recipient_name || "").slice(0, 512),
    // Belt and braces: the prompt and the tool schema both ask for four
    // digits, but a model that returns the whole SSN anyway must not have
    // it land in the database, so this is narrowed here regardless.
    recipient_tin_last4: tinLast4(data.recipient_tin_last4),
    amount: cleanNumber(data.amount),
    federal_tax_withheld: cleanNumber(data.federal_tax_withheld),
  };

  const fieldConfidence = {};
  for (const field of FIELDS) {
    fieldConfidence[field] = clamp01(data[`${field}_confidence`] ?? 0);
  }

  return { method: "llm", fields, fieldConfidence };
}

// Ordered longest-first so "1099-NEC" wins over a bare "1099" appearing
// elsewhere on the same page, and so the specific 1099 variants are tried
// before the generic fallback below them.
const TYPE_PATTERNS = [
  [/\b1099[-\s]?NEC\b/i, "1099-NEC"],
  [/\b1099[-\s]?MISC\b/i, "1099-MISC"],
  [/\b1099[-\s]?K\b/i, "1099-K"],
  [/\b1099[-\s]?INT\b/i, "1099-INT"],
  [/\b1099[-\s]?DIV\b/i, "1099-DIV"],
  [/\bW[-\s]?2\b/i, "W-2"],
  [/\b1098\b/i, "1098"],
  [/\b(schedule\s+)?K[-\s]?1\b/i, "K-1"],
];

// Which box holds "the" number differs per form, so these are tried in
// order and the first labeled hit wins. Deliberately no "largest dollar
// amount on the page" fallback -- on a W-2 that's as likely to be Social
// Security wages as box 1, and a confidently wrong figure in a tax total
// is worse than a blank one a reviewer fills in.
// Tesseract renders the typographic apostrophe the IRS actually prints
// ("RECIPIENT'S TIN") as a curly ’ rather than a straight ', and some
// scans lose it entirely -- so every possessive label here accepts any of
// them. Matching only the straight quote silently loses the label on real
// scanned forms, which is how the payer/recipient distinction gets lost.
const APOS = "(?:'|’|ʼ|`)?";
const PAYER_LABEL_NAME = new RegExp(`\\b(payer|employer|filer|lender)${APOS}s?\\s+(name|information)\\b`, "i");
const RECIPIENT_LABEL_NAME =new RegExp(`\\b(recipient|employee|borrower|partner)${APOS}s?\\s+(name|information)\\b`, "i");
const RECIPIENT_LABEL_TIN = new RegExp(
  `\\b(recipient|employee|borrower|partner)${APOS}s?\\s+(tin|ssn|social security|identification)`,
  "i"
);

const AMOUNT_LABELS = [
  /nonemployee compensation/i,
  /wages,?\s*tips,?\s*other compensation/i,
  /gross amount of payment card/i,
  /mortgage interest received/i,
  /ordinary dividends/i,
  /interest income/i,
  /\brents\b/i,
  /other income/i,
];

function extractHeuristic(ocrText) {
  const fields = Object.fromEntries(FIELDS.map((f) => [f, ""]));
  fields.tax_year = null;
  fields.amount = null;
  fields.federal_tax_withheld = null;
  const fieldConfidence = Object.fromEntries(FIELDS.map((f) => [f, 0]));

  const lines = ocrText
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean);

  for (const [pattern, type] of TYPE_PATTERNS) {
    if (pattern.test(ocrText)) {
      fields.document_type = type;
      fieldConfidence.document_type = HEURISTIC_FIELD_CONFIDENCE;
      break;
    }
  }
  if (!fields.document_type) {
    fields.document_type = "Other";
    // Genuinely zero confidence: "Other" here isn't a classification, it's
    // the absence of one, and it should not pull the overall score up.
  }

  const year = findTaxYear(ocrText);
  if (year) {
    fields.tax_year = year;
    fieldConfidence.tax_year = HEURISTIC_FIELD_CONFIDENCE;
  }

  // These forms label both parties explicitly, and the labels are the only
  // reliable way to tell them apart -- position alone would swap payer and
  // recipient on roughly half of real layouts.
  const payerName = findLabeledValue(lines, PAYER_LABEL_NAME);
  if (payerName) {
    fields.payer_name = payerName.slice(0, 512);
    fieldConfidence.payer_name = HEURISTIC_FIELD_CONFIDENCE;
  } else if (lines.length) {
    // Nothing labeled -- the first line that isn't the form's own title is
    // usually the issuer's letterhead. Same "skip a generic header line"
    // reasoning as the other extraction modules.
    const genericHeaderLine = /^(form\s+)?(1099|1098|w[-\s]?2|schedule\s+k)/i;
    const fallback = lines.find((ln) => !(genericHeaderLine.test(ln) && ln.length <= 40));
    if (fallback) {
      fields.payer_name = fallback.slice(0, 512);
      fieldConfidence.payer_name = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  const recipientName = findLabeledValue(lines, RECIPIENT_LABEL_NAME);
  if (recipientName) {
    fields.recipient_name = recipientName.slice(0, 512);
    fieldConfidence.recipient_name = HEURISTIC_FIELD_CONFIDENCE;
  }

  const tin = findRecipientTin(lines, ocrText);
  if (tin) {
    fields.recipient_tin_last4 = tin;
    fieldConfidence.recipient_tin_last4 = HEURISTIC_FIELD_CONFIDENCE;
  }

  for (const label of AMOUNT_LABELS) {
    const amount = findLabeledAmount(lines, label);
    if (amount !== null) {
      fields.amount = amount;
      fieldConfidence.amount = HEURISTIC_FIELD_CONFIDENCE;
      break;
    }
  }

  const withheld = findLabeledAmount(lines, /federal income tax withheld/i);
  if (withheld !== null) {
    fields.federal_tax_withheld = withheld;
    fieldConfidence.federal_tax_withheld = HEURISTIC_FIELD_CONFIDENCE;
  }

  return { method: "heuristic", fields, fieldConfidence };
}

// Prefers a year sitting next to wording that names it as the tax year
// ("For calendar year 2025", "Tax Year 2025"), because a tax form is
// covered in other four-digit numbers -- the form's own OMB number, a ZIP
// code, a revision date. Falls back to the most recent plausible year on
// the page, since forms are overwhelmingly for the year just ended.
function findTaxYear(ocrText) {
  const labeled = ocrText.match(/\b(?:for )?(?:calendar |tax )?year\b\D{0,12}(\d{4})/i);
  if (labeled) {
    const year = cleanTaxYear(labeled[1]);
    if (year) return year;
  }

  const candidates = [...ocrText.matchAll(/\b(19|20)\d{2}\b/g)]
    .map((m) => cleanTaxYear(m[0]))
    .filter(Boolean);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

// Looks for the recipient's TIN specifically. A 1099 shows two of them --
// the payer's EIN and the recipient's TIN -- so an unlabeled "first
// TIN-shaped thing on the page" search would return the payer's about as
// often as not.
function findRecipientTin(lines, ocrText) {
  for (const labelIndex of labeledIndices(lines, RECIPIENT_LABEL_TIN)) {
    for (const ln of [lines[labelIndex], lines[labelIndex + 1]]) {
      const found = firstTinLike(ln || "");
      if (found) return found;
    }
  }
  // Only fall back to an unlabeled scan when the page shows exactly one
  // TIN-shaped number -- with two there's no way to tell which is which,
  // and guessing wrong attaches someone else's identifier to this record.
  const all = [...String(ocrText).matchAll(TIN_LIKE)].map((m) => m[0]);
  const distinct = [...new Set(all)];
  return distinct.length === 1 ? tinLast4(distinct[0]) : "";
}

// SSN (123-45-6789), EIN (12-3456789), an already-masked form
// (***-**-6789, XXX-XX-6789), or nine bare digits.
const TIN_LIKE = /\b(?:[\dX*]{3}-[\dX*]{2}-\d{4}|[\dX*]{2}-[\dX*]{3}\d{4}|\d{9})\b/gi;

function firstTinLike(text) {
  const match = String(text).match(new RegExp(TIN_LIKE.source, "i"));
  return match ? tinLast4(match[0]) : "";
}

// Narrows any taxpayer identifier down to its last four digits. Anything
// that doesn't end in at least four digits returns "" rather than a
// partial -- a two-digit "last four" is noise, not data.
export function tinLast4(value) {
  if (value === null || value === undefined) return "";
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 4) return "";
  return digits.slice(-4);
}

// Replaces every full taxpayer identifier in a block of text with a masked
// form that keeps only the last four digits. Called by taxDocPipeline.js
// on the OCR text before it's persisted, so a stored W-2's raw text can't
// become a second, unmasked copy of the SSN that recipientTinLast4 exists
// to avoid keeping.
export function redactTins(text) {
  if (!text) return "";
  return String(text).replace(new RegExp(TIN_LIKE.source, "gi"), (match) => {
    const last4 = tinLast4(match);
    return last4 ? `***-**-${last4}` : match;
  });
}

// Every line matching `labelPattern`, not just the first. These forms
// repeat their own box captions -- "Nonemployee Compensation" is both the
// title printed across the top of a 1099-NEC and the caption on box 1, and
// only the second one has a number under it. Stopping at the first match
// would find the title, come up empty, and give up.
function labeledIndices(lines, labelPattern) {
  const found = [];
  lines.forEach((ln, i) => {
    if (labelPattern.test(ln)) found.push(i);
  });
  return found;
}

// Looks for a dollar amount on the same line as (or the line right after)
// a line matching `labelPattern`; returns null if no match yields one.
function findLabeledAmount(lines, labelPattern) {
  for (const labelIndex of labeledIndices(lines, labelPattern)) {
    for (const ln of [lines[labelIndex], lines[labelIndex + 1]]) {
      if (!ln) continue;
      const match = ln.match(/\$?\s*([\d,]+\.\d{2})\b/);
      if (match) {
        const n = parseFloat(match[1].replace(/,/g, ""));
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}

// Looks for text after a "Label:" on a line matching `labelPattern`,
// falling back to the next line if the label line has nothing after it.
// Same helper as extractionLeases.js's, over every matching line rather
// than only the first -- the next-line fallback is what does the work
// here, since the IRS box captions ("PAYER'S name, street address, city or
// town...") carry no colon and the value sits below them.
function findLabeledValue(lines, labelPattern) {
  for (const labelIndex of labeledIndices(lines, labelPattern)) {
    const afterColon = lines[labelIndex].split(":").slice(1).join(":").trim();
    if (afterColon) return afterColon;
    const nextLine = (lines[labelIndex + 1] || "").trim();
    // Two captions in a row (the layout puts "RECIPIENT'S name" directly
    // above "RECIPIENT'S TIN" on some forms) -- skip to the next candidate
    // rather than recording a caption as if it were a value.
    if (nextLine && !labelPattern.test(nextLine)) return nextLine;
  }
  return "";
}

function cleanTaxYear(value) {
  const n = parseInt(String(value ?? "").replace(/\D/g, ""), 10);
  if (!Number.isFinite(n)) return null;
  return n >= MIN_TAX_YEAR && n <= maxTaxYear() ? n : null;
}

function cleanNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
