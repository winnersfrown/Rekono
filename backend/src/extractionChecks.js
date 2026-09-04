// Structured extraction for scanned checks, on top of raw OCR text.
// Mirrors extractionTaxDocs.js's shape (LLM forced function calling + a
// heuristic regex fallback when no LLM is configured) applied to a check's
// own schema.
//
// The thing here that isn't copied from the other five extractors is
// `accountLast4`/`redactMicr`, which narrow the MICR line along the bottom
// of every check down to the last four digits of the account number and
// drop the routing number entirely. See Check.js's accountLast4 comment for
// why -- in short, routing plus account number is everything needed to
// draft an ACH debit against the account, and the app has no use for
// either beyond a human confirming which account a check was drawn on.

import { callTool, llmConfigured } from "./llm.js";

// snake_case keys throughout, same convention as the other extractors --
// flows straight into the API's field_confidence JSON blob.
export const FIELDS = [
  "check_number",
  "check_date",
  "payee_name",
  "amount",
  "memo",
  "bank_name",
  "account_last4",
];

const HEURISTIC_FIELD_CONFIDENCE = 0.5;

const CHECK_TOOL = {
  name: "record_check",
  description: "Record structured data extracted from a scanned check, with a self-reported confidence (0.0-1.0) for every field.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      check_number: {
        type: "string",
        description:
          "The check's own sequence number, usually printed top-right and repeated in the MICR line at the bottom. Digits only, no '#'. Empty string if absent.",
      },
      check_number_confidence: { type: "number" },
      check_date: { type: "string", description: "The date written on the check, ISO format YYYY-MM-DD. Empty string if unknown." },
      check_date_confidence: { type: "number" },
      payee_name: {
        type: "string",
        description:
          "Who the check is made out to -- the name on the 'Pay to the order of' line. NOT the account holder whose name and address are printed at the top left, which is who is paying.",
      },
      payee_name_confidence: { type: "number" },
      // The courtesy amount (the numeric box) and the legal amount (the
      // written line) are the same figure printed twice, and the model is
      // told to prefer the written one because that is what a bank honours
      // when they disagree -- and because a handwritten numeral is exactly
      // the thing OCR is worst at.
      amount: {
        type: "number",
        description:
          "The amount of the check. It appears twice: as numerals in the box on the right, and spelled out in words on the line beneath the payee. Prefer the written-out words where the two disagree, since that is the legally controlling amount. 0 if unknown.",
      },
      amount_confidence: { type: "number" },
      memo: { type: "string", description: "The memo/for line, if written. Empty string if blank." },
      memo_confidence: { type: "number" },
      bank_name: { type: "string", description: "The name of the bank the check is drawn on, printed on the check face. Empty string if unclear." },
      bank_name_confidence: { type: "number" },
      account_last4: {
        type: "string",
        description:
          "ONLY the last four digits of the account number from the MICR line at the bottom of the check. Never return the full account number and never return the routing number.",
      },
      account_last4_confidence: { type: "number" },
    },
    required: ["check_number", "check_date", "payee_name", "amount"],
  },
};

function extractionPrompt(ocrText) {
  return `You are an accounts-payable clerk reading a scanned check. Below is raw OCR text extracted from a scanned or photographed US check. OCR errors (misread characters, broken lines, stray whitespace) are expected -- use context to recover the correct values.

Call the \`record_check\` tool with the extracted fields. For every *_confidence field, report your genuine confidence (0.0 to 1.0) that the value is correct, based on how legible/unambiguous the source text was. If a field is not present or doesn't apply, use an empty string (or 0 for numbers) and a low confidence.

Two distinctions matter and are easy to get backwards. The PAYEE is who the check pays -- the "Pay to the order of" line. The name and address printed at the top left is the ACCOUNT HOLDER, who is paying; that is not the payee. And the amount appears twice, as numerals and written out in words: prefer the words where they disagree.

For the account number, return ONLY its last four digits. Never return the full account number or the routing number.

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
      console.error("Check extraction LLM call failed, falling back to heuristic:", err.message);
      return extractHeuristic(ocrText);
    }
  }
  return extractHeuristic(ocrText);
}

async function extractWithLlm(ocrText) {
  const data = await callTool({
    prompt: extractionPrompt(ocrText.slice(0, 15000)),
    tool: CHECK_TOOL,
    maxOutputTokens: 2048,
  });

  const fields = {
    check_number: String(data.check_number || "").replace(/\D/g, "").slice(0, 32),
    check_date: cleanDate(data.check_date),
    payee_name: (data.payee_name || "").slice(0, 512),
    amount: cleanNumber(data.amount),
    memo: (data.memo || "").slice(0, 512),
    bank_name: (data.bank_name || "").slice(0, 256),
    // Belt and braces: the prompt and the tool schema both ask for four
    // digits, but a model that returns the whole account number anyway
    // must not have it land in the database, so this is narrowed here
    // regardless. Same treatment extractionTaxDocs.js gives a TIN.
    account_last4: accountLast4(data.account_last4),
  };

  const fieldConfidence = {};
  for (const field of FIELDS) {
    fieldConfidence[field] = clamp01(data[`${field}_confidence`] ?? 0);
  }

  return { method: "llm", fields, fieldConfidence };
}

// A run of 8 or more consecutive digits. Routing numbers are exactly 9 and
// account numbers run 8-17, while everything else legitimately printed on
// a check is shorter: a check number is 3-5 digits, and an amount always
// carries its decimal point so it never reads as one long run. Deliberately
// broad rather than trying to parse MICR structure -- OCR renders the MICR
// symbols (⑈ ⑆ ⑉) inconsistently or drops them entirely, so a pattern that
// depended on them would fail exactly on the documents that matter.
const LONG_DIGIT_RUN = /\d{8,}/g;

// Reduces an account number to its last four digits. Returns "" for
// anything too short to narrow, rather than a partial number -- same
// contract as extractionTaxDocs.js's tinLast4.
export function accountLast4(value) {
  if (value === null || value === undefined) return "";
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 4) return "";
  return digits.slice(-4);
}

// Masks every long digit run in a block of text, keeping only the last
// four. Called by checkPipeline.js on the OCR text before it's persisted,
// so a stored check's raw text can't become a second, unmasked copy of the
// routing/account pair that accountLast4 exists to avoid keeping.
export function redactMicr(text) {
  if (!text) return "";
  return String(text).replace(LONG_DIGIT_RUN, (match) => `****${match.slice(-4)}`);
}

function extractHeuristic(ocrText) {
  const fields = Object.fromEntries(FIELDS.map((f) => [f, ""]));
  fields.amount = null;
  const fieldConfidence = Object.fromEntries(FIELDS.map((f) => [f, 0]));

  const lines = ocrText
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean);

  // "Pay to the order of" is the one label on a check that is always
  // printed and always says the same thing, so it's the only reliable
  // anchor the heuristic path has. The name may sit on the same line after
  // the label or wrap onto the next.
  const payeeLabel = /pay\s*(?:to\s*the\s*order\s*of|to\s*the\s*order|to)\s*:?/i;
  for (let i = 0; i < lines.length; i += 1) {
    if (!payeeLabel.test(lines[i])) continue;
    const sameLine = stripPayeeLine(lines[i].replace(payeeLabel, ""));
    const candidate = sameLine || stripPayeeLine(lines[i + 1] || "");
    if (candidate) {
      fields.payee_name = candidate.slice(0, 512);
      fieldConfidence.payee_name = HEURISTIC_FIELD_CONFIDENCE;
    }
    break;
  }

  // Requires an explicit marker, same reasoning as extraction.js's invoice
  // number: "check" appears in the word "check" printed all over the
  // document, and without a marker this would capture whatever followed
  // the first one.
  const numMatch = ocrText.match(/\bch(?:ec)?k\s*(?:#|no\.?|number)\s*[:#-]?\s*(\d{1,32})/i);
  if (numMatch) {
    fields.check_number = numMatch[1];
    fieldConfidence.check_number = HEURISTIC_FIELD_CONFIDENCE;
  }

  const dateLine = lines.find((ln) => /\bdate\b/i.test(ln)) || "";
  const dateValue = cleanDate(firstDateToken(dateLine) || firstDateToken(ocrText));
  if (dateValue) {
    fields.check_date = dateValue;
    fieldConfidence.check_date = HEURISTIC_FIELD_CONFIDENCE;
  }

  // The courtesy amount: a currency figure with cents. Takes the largest
  // rather than the first, because a check face carries stray numbers (a
  // check number, a date, a fractional routing code) and the amount is
  // reliably the biggest money-shaped thing printed on it.
  const amounts = [...ocrText.matchAll(/\$\s*([\d,]+\.\d{2})/g)]
    .map((m) => parseFloat(m[1].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
  if (amounts.length) {
    fields.amount = Math.max(...amounts);
    fieldConfidence.amount = HEURISTIC_FIELD_CONFIDENCE;
  }

  const memoMatch = ocrText.match(/\b(?:memo|for)\s*:?\s*(.+)/i);
  if (memoMatch) {
    const memo = memoMatch[1].replace(/[\s_*.-]+$/, "").trim();
    if (memo) {
      fields.memo = memo.slice(0, 512);
      fieldConfidence.memo = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  // The MICR line's account number: the last long digit run on the page.
  // Routing comes first and account second in MICR order, so scanning to
  // the end lands on the account rather than the routing number -- and
  // either way only four digits survive accountLast4.
  const runs = ocrText.match(LONG_DIGIT_RUN);
  if (runs && runs.length) {
    const last4 = accountLast4(runs[runs.length - 1]);
    if (last4) {
      fields.account_last4 = last4;
      fieldConfidence.account_last4 = HEURISTIC_FIELD_CONFIDENCE;
    }
  }

  return { method: "heuristic", fields, fieldConfidence };
}

// The courtesy amount box sits on the same printed line as the payee on
// every standard check, so OCR hands both back as one string ("Acme
// Supplies Inc            $ 1,250.00"). Taking the line as-is makes the
// payee name unmatchable against any vendor. Also drops the run of filler
// characters used to stop the line being extended by hand, and the word
// DOLLARS that terminates the written-amount line beneath it.
function stripPayeeLine(text) {
  return String(text)
    .replace(/\$\s*[\d,]+(?:\.\d{2})?\s*$/, "")
    .replace(/\bDOLLARS\b/i, "")
    .replace(/[\s$*_.·-]+$/, "")
    .trim();
}

function firstDateToken(text) {
  if (!text) return "";
  const match = String(text).match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  return match ? match[1] : "";
}

function cleanDate(value) {
  if (!value) return "";
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let [, m, d, y] = slash;
    if (y.length === 2) y = `20${y}`;
    // US convention is month first, so a leading value above 12 can only
    // be the day -- swap rather than emit an impossible month.
    if (Number(m) > 12 && Number(d) <= 12) [m, d] = [d, m];
    if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return "";
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return "";
}

function cleanNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  // A check for zero (or a negative amount) isn't a check -- it's the
  // model reporting "I couldn't read it" through the schema's `0 if
  // unknown`. Treating it as null routes it to review instead of
  // proposing a $0.00 payment against a bill.
  return rounded > 0 ? rounded : null;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
