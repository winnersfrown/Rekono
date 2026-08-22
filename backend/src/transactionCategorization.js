// Assigns an expense category to bank/card transactions.
//
// The central design decision here is that this categorizes *distinct
// merchants*, not transactions. A month of card activity is typically a few
// hundred rows across a few dozen merchants -- twenty Starbucks charges are
// one question, not twenty -- so resolving merchants instead of rows cuts
// the work by an order of magnitude and makes a batched LLM call viable
// where per-row calls would be slow and expensive.
//
// Three tiers, cheapest first:
//   1. learned  -- a human already decided this merchant for this org
//                  (MerchantCategory). No API call, full confidence.
//   2. ai       -- one batched Gemini call for whatever's left over.
//   3. heuristic-- keyword match, used when there's no API key or the call
//                  fails. Low confidence on purpose, so it routes to review.
//
// Nothing is ever silently left wrong: anything none of the three can place
// stays uncategorized rather than being guessed into "Other".

import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import { Op } from "sequelize";
import { settings } from "./config.js";
import { EXPENSE_CATEGORIES } from "./models/ExpenseReceipt.js";
import { MerchantCategory } from "./models/index.js";

// Confidence assigned to a category a human already chose for this merchant.
// Not 1.0: the mapping is certain, but that this particular charge belongs
// to the same merchant is still an inference from a normalized descriptor.
const LEARNED_CONFIDENCE = 0.98;
// Deliberately below the review bar -- a keyword match is a routing hint,
// not an answer, and should always land in front of a human.
const HEURISTIC_CONFIDENCE = 0.35;

const LLM_TIMEOUT_MS = 60_000;
const LLM_MAX_ATTEMPTS = 2;
// Keeps a single request's prompt and response bounded. Statements with
// more distinct merchants than this are split across calls.
const MERCHANTS_PER_LLM_CALL = 60;

// Card-network and processor noise that appears in front of, or around, the
// actual merchant name in a statement descriptor. Stripping it is what lets
// "SQ *BLUE BOTTLE #123 SAN FRANCISCOCA" and "BLUE BOTTLE COFFEE" collapse
// to the same learned mapping instead of being treated as two merchants.
const DESCRIPTOR_PREFIXES = /^(sq|tst|sp|py|pp|paypal|pos|ach|dbt|crd|pmt|purchase|payment)\s*[*#-]?\s*/i;
const TRAILING_LOCATION = /\s+[a-z .'-]+?\s+(a[klrz]|c[aot]|d[ce]|fl|ga|hi|i[adln]|k[sy]|la|m[adeinost]|n[cdehjmvy]|o[hkr]|pa|ri|s[cd]|t[nx]|ut|v[at]|w[aivy])$/i;

export function normalizeMerchant(description) {
  let s = String(description || "")
    .toLowerCase()
    .replace(/[*#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  s = s.replace(DESCRIPTOR_PREFIXES, "");
  // Drop a trailing "CITY ST" so the same chain in two cities is one merchant.
  s = s.replace(TRAILING_LOCATION, "");
  // Drop store/reference numbers and dates, which differ per charge.
  s = s.replace(/\b\d{2}\/\d{2}\b/g, " ");
  s = s.replace(/\b[a-z]*\d{3,}[a-z0-9]*\b/g, " ");
  s = s.replace(/\b(store|str|location|loc)\b\s*\d*/g, " ");
  s = s.replace(/[^a-z0-9&' ]/g, " ");

  return s.replace(/\s+/g, " ").trim();
}

const CATEGORY_KEYWORDS = {
  Travel: /\b(airlines?|airways|hotel|motel|inn\b|uber|lyft|taxi|rental car|hertz|avis|parking|flight|amtrak|airbnb|expedia)\b/i,
  "Meals & Entertainment": /\b(restaurant|cafe|caffe|coffee|bar\b|grill|kitchen|diner|bistro|pizza|starbucks|doordash|ubereats|grubhub|catering)\b/i,
  "Office Supplies": /\b(office depot|officemax|staples|supplies|paper|printer|ink\b|stationery)\b/i,
  "Software & Subscriptions": /\b(subscription|software|saas|license|adobe|github|slack|zoom|atlassian|figma|notion|dropbox|aws|google cloud|azure)\b/i,
  Utilities: /\b(electric|energy|gas company|water utility|internet|comcast|verizon|at&t|t-mobile|phone bill|telecom)\b/i,
  "Professional Services": /\b(consulting|attorney|law firm|legal|accounting|bookkeep|audit|advisory|notary)\b/i,
};

export function guessCategoryHeuristic(merchant) {
  for (const [category, pattern] of Object.entries(CATEGORY_KEYWORDS)) {
    if (pattern.test(merchant)) return category;
  }
  return "";
}

const CATEGORIZE_TOOL = {
  name: "categorize_merchants",
  description: "Assign an expense category to each merchant.",
  parameters: {
    type: "object",
    properties: {
      categorizations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            merchant: { type: "string", description: "The merchant string exactly as given." },
            category: { type: "string", description: `One of: ${EXPENSE_CATEGORIES.join(", ")}` },
            confidence: { type: "number", description: "0.0-1.0 confidence this category is right." },
          },
          required: ["merchant", "category", "confidence"],
        },
      },
    },
    required: ["categorizations"],
  },
};

function categorizePrompt(merchants) {
  return `You are categorizing bank and credit-card transactions for a company's bookkeeping.

Assign each merchant below exactly one category from this list: ${EXPENSE_CATEGORIES.join(", ")}.

The merchant strings come from card statement descriptors, so they may be abbreviated or truncated. Use "Other" only when the merchant genuinely doesn't fit any other category -- not merely because the name is unfamiliar. Report your honest confidence per merchant: low when the descriptor is too vague to tell what the business actually is.

Merchants:
${merchants.map((m) => `- ${m}`).join("\n")}`;
}

async function categorizeWithLlm(merchants) {
  const client = new GoogleGenAI({
    apiKey: settings.geminiApiKey,
    httpOptions: { timeout: LLM_TIMEOUT_MS, retryOptions: { attempts: LLM_MAX_ATTEMPTS } },
  });
  const response = await client.models.generateContent({
    model: settings.geminiModel,
    contents: [{ role: "user", parts: [{ text: categorizePrompt(merchants) }] }],
    config: {
      maxOutputTokens: 4096,
      tools: [{ functionDeclarations: [CATEGORIZE_TOOL] }],
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ["categorize_merchants"] },
      },
    },
  });

  const out = new Map();
  for (const row of response.functionCalls[0].args.categorizations || []) {
    // Only accept a category from the fixed list -- a model that invents
    // "Groceries" would otherwise poison the taxonomy that every filter,
    // report, and export downstream assumes.
    if (!EXPENSE_CATEGORIES.includes(row.category)) continue;
    const confidence = Number(row.confidence);
    out.set(String(row.merchant), {
      category: row.category,
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.5,
      source: "ai",
    });
  }
  return out;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Resolves every merchant to { category, confidence, source }. Merchants
// nothing can place are simply absent from the returned map, which callers
// record as uncategorized rather than inventing a value for.
export async function categorizeMerchants(orgId, merchantKeys) {
  const unique = [...new Set(merchantKeys.filter(Boolean))];
  const resolved = new Map();
  if (!unique.length) return resolved;

  const learned = await MerchantCategory.findAll({ where: { orgId, merchantKey: { [Op.in]: unique } } });
  for (const row of learned) {
    resolved.set(row.merchantKey, { category: row.category, confidence: LEARNED_CONFIDENCE, source: "learned" });
  }

  const unknown = unique.filter((m) => !resolved.has(m));
  if (!unknown.length) return resolved;

  if (settings.geminiApiKey) {
    try {
      for (const batch of chunk(unknown, MERCHANTS_PER_LLM_CALL)) {
        for (const [merchant, result] of await categorizeWithLlm(batch)) {
          // The model echoes the merchant back; only trust it for one we
          // actually asked about, so a hallucinated row can't introduce a
          // category for a merchant that isn't in this statement.
          if (unknown.includes(merchant)) resolved.set(merchant, result);
        }
      }
    } catch (err) {
      // Fall through to the heuristic rather than failing the whole batch
      // on a transient API error -- the low confidence routes it to review.
      console.error("Transaction categorization LLM call failed, falling back to heuristic:", err.message);
    }
  }

  for (const merchant of unknown) {
    if (resolved.has(merchant)) continue;
    const guess = guessCategoryHeuristic(merchant);
    if (guess) resolved.set(merchant, { category: guess, confidence: HEURISTIC_CONFIDENCE, source: "heuristic" });
  }

  return resolved;
}
