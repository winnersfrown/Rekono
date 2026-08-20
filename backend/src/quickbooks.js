// QuickBooks Online client (Phase 1: sandbox OAuth2 connect + manual
// one-way Bill push -- see routes/integrations.js). Every exported function
// that hits the network takes an injectable fetchImpl (defaults to the real
// fetch) so tests can supply a fake without hitting Intuit's API, same
// pattern as billing.js's injectable stripe client and auth.js's Google
// OAuth calls.
//
// "Expected" failures (not connected, no default account, Intuit rejected
// the request) are returned as { error, detail? } rather than thrown -- same
// convention as auth.js's completeGoogleLogin -- so routes can translate
// them into a specific status code. Only genuinely unexpected failures
// (thrown by fetchImpl itself, e.g. a network error) propagate up to the
// route's try/catch and the app-wide 500 handler.
import { GoogleGenAI, FunctionCallingConfigMode } from "@google/genai";
import { settings } from "./config.js";

export const QUICKBOOKS_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const QUICKBOOKS_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QUICKBOOKS_SCOPE = "com.intuit.quickbooks.accounting";

// Sandbox and production hit different API hosts but are otherwise
// identical -- see settings.quickbooksEnvironment (config.js).
export function quickbooksApiBaseUrl() {
  return settings.quickbooksEnvironment === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

function basicAuthHeader() {
  return "Basic " + Buffer.from(`${settings.quickbooksClientId}:${settings.quickbooksClientSecret}`).toString("base64");
}

async function requestTokens(body, fetchImpl) {
  const res = await fetchImpl(QUICKBOOKS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    console.error("QuickBooks token request failed:", await res.text());
    return { error: "oauth_failed" };
  }
  return { tokens: await res.json() };
}

export async function exchangeCodeForTokens({ code, redirectUri, fetchImpl = fetch }) {
  return requestTokens({ grant_type: "authorization_code", code, redirect_uri: redirectUri }, fetchImpl);
}

export async function refreshAccessToken({ refreshToken, fetchImpl = fetch }) {
  return requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

// Applies a token response (from exchangeCodeForTokens/refreshAccessToken)
// onto an org and saves it -- shared by both callers so the expiry math
// (Intuit returns *_in as seconds-from-now) only lives in one place.
// expires_in is the access token's lifetime (~1 hour); x_refresh_token_expires_in
// is the refresh token's (~100 days, itself renewed on every use).
export async function applyTokens(org, tokens) {
  const now = Date.now();
  org.quickbooksAccessToken = tokens.access_token;
  org.quickbooksRefreshToken = tokens.refresh_token;
  org.quickbooksAccessTokenExpiresAt = new Date(now + tokens.expires_in * 1000);
  org.quickbooksRefreshTokenExpiresAt = new Date(now + tokens.x_refresh_token_expires_in * 1000);
  await org.save();
}

// Returns a valid access token for org, refreshing first if it's expired (or
// within 60s of expiring, to absorb request latency). Null if the org isn't
// connected, or if the refresh itself failed -- e.g. the refresh token expired
// after 100 days of no use, which requires reconnecting from scratch.
export async function ensureFreshToken(org, { fetchImpl = fetch } = {}) {
  if (!org.quickbooksRealmId || !org.quickbooksAccessToken) return null;

  const expiresAt = org.quickbooksAccessTokenExpiresAt ? new Date(org.quickbooksAccessTokenExpiresAt).getTime() : 0;
  if (expiresAt - Date.now() > 60 * 1000) return org.quickbooksAccessToken;

  const result = await refreshAccessToken({ refreshToken: org.quickbooksRefreshToken, fetchImpl });
  if (result.error) return null;
  await applyTokens(org, result.tokens);
  return org.quickbooksAccessToken;
}

// Thin wrapper around a Bearer-authenticated call to org's QuickBooks
// company (realm) -- every accounting-API call below goes through this, so
// token refresh and error shaping only live in one place.
async function qbFetch(org, path, { method = "GET", body, fetchImpl = fetch } = {}) {
  const accessToken = await ensureFreshToken(org, { fetchImpl });
  if (!accessToken) return { error: "not_connected" };

  const res = await fetchImpl(`${quickbooksApiBaseUrl()}/v3/company/${org.quickbooksRealmId}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("QuickBooks API request failed:", method, path, res.status, data);
    return { error: "api_error", detail: data };
  }
  return { data };
}

// Escapes a single-quoted string for QuickBooks' SQL-like query language
// (https://developer.intuit.com/.../query) -- only used to build the vendor
// lookup below, on a name that's already ours (extracted from an uploaded
// invoice), not raw user SQL.
function escapeQbQueryString(value) {
  return String(value).replace(/'/g, "\\'");
}

export async function fetchExpenseAccounts(org, { fetchImpl = fetch } = {}) {
  const query = "select Id, Name from Account where AccountType = 'Expense' and Active = true";
  const result = await qbFetch(org, `/query?query=${encodeURIComponent(query)}`, { fetchImpl });
  if (result.error) return result;
  const accounts = result.data?.QueryResponse?.Account || [];
  return { data: accounts.map((a) => ({ id: a.Id, name: a.Name })) };
}

// Looks up a Vendor by exact display-name match, creating one if none
// exists -- QuickBooks Bills always reference a Vendor, and this app has no
// separate "connect this Rekono vendor to that QuickBooks vendor" UI in
// Phase 1, so an exact-name match is the whole strategy.
export async function findOrCreateVendor(org, vendorName, { fetchImpl = fetch } = {}) {
  const query = `select Id, DisplayName from Vendor where DisplayName = '${escapeQbQueryString(vendorName)}'`;
  const found = await qbFetch(org, `/query?query=${encodeURIComponent(query)}`, { fetchImpl });
  if (found.error) return found;

  const existing = found.data?.QueryResponse?.Vendor?.[0];
  if (existing) return { data: { id: existing.Id, name: existing.DisplayName } };

  const created = await qbFetch(org, "/vendor", { method: "POST", body: { DisplayName: vendorName }, fetchImpl });
  if (created.error) return created;
  return { data: { id: created.data.Vendor.Id, name: created.data.Vendor.DisplayName } };
}

// Pushes one Rekono invoice to QuickBooks as a single-line Bill. Uses this
// invoice's own categorized expense account (see suggestExpenseAccount,
// below) if it has one, falling back to org's static default otherwise --
// so a categorized invoice files under its actual spend category, while an
// org that never touches categorization keeps working exactly as Phase 1
// shipped. One-way and manual (per-invoice, triggered by the user) -- no
// sync-back, no bulk push, no automatic push-on-approve.
export async function pushInvoiceAsBill(org, invoice, { fetchImpl = fetch } = {}) {
  if (!org.quickbooksRealmId) return { error: "not_connected" };
  const accountId = invoice.quickbooksExpenseAccountId || org.quickbooksDefaultExpenseAccountId;
  if (!accountId) return { error: "no_default_account" };
  if (invoice.quickbooksBillId) return { error: "already_pushed" };

  const vendor = await findOrCreateVendor(org, invoice.vendorName || "Unknown vendor", { fetchImpl });
  if (vendor.error) return vendor;

  const billPayload = {
    VendorRef: { value: vendor.data.id },
    Line: [
      {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: invoice.total ?? 0,
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId } },
      },
    ],
    ...(invoice.invoiceDate ? { TxnDate: invoice.invoiceDate } : {}),
    ...(invoice.dueDate ? { DueDate: invoice.dueDate } : {}),
    // QuickBooks caps DocNumber at 21 characters.
    ...(invoice.invoiceNumber ? { DocNumber: invoice.invoiceNumber.slice(0, 21) } : {}),
  };

  const result = await qbFetch(org, "/bill", { method: "POST", body: billPayload, fetchImpl });
  if (result.error) return result;
  return { data: { id: result.data.Bill.Id } };
}

const CATEGORIZE_TOOL = {
  name: "categorize_expense",
  description:
    "Pick the QuickBooks expense account this invoice's spend belongs under, from the given list, with a confidence (0.0-1.0) and one short reason.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      account_id: {
        type: "string",
        description: "The id of the chosen account, exactly as given in the account list. Empty string if none of the given accounts are a reasonable fit.",
      },
      confidence: { type: "number" },
      reasoning: { type: "string", description: "One short sentence explaining the pick." },
    },
    required: ["account_id", "confidence", "reasoning"],
  },
};

const CATEGORIZE_TIMEOUT_MS = 30_000;

// Suggests which of org's QuickBooks expense accounts this invoice's spend
// belongs under -- e.g. an AWS invoice's line items ("Compute", "Storage")
// point at "Software & Subscriptions" or "Cloud Hosting", not whatever the
// org's static default account happens to be. There's no reasonable
// regex/heuristic version of this: matching free-text vendor/line-item
// wording against an arbitrary, org-specific chart of accounts is exactly
// the kind of judgment call a fixed pattern can't make. Unlike
// extraction.js's fields, this has no fallback path -- without
// GEMINI_API_KEY it simply returns no suggestion, and callers fall back
// to the org's default account, i.e. exactly the behavior this app had
// before this feature existed.
export async function suggestExpenseAccount(invoice, accounts) {
  if (!settings.geminiApiKey || !accounts?.length) return { suggested: false };

  const lineItemsText =
    (invoice.lineItems || [])
      .map((li) => `- ${li.description || "(no description)"}${li.amount != null ? ` — $${li.amount}` : ""}`)
      .join("\n") || "(no line items on file)";
  const accountsText = accounts.map((a) => `${a.id}: ${a.name}`).join("\n");

  const prompt = `You are categorizing a vendor invoice for accounts-payable bookkeeping. Given the invoice below and the company's available QuickBooks expense accounts, pick the single best-fitting account for this spend.

Vendor: ${invoice.vendorName || "(unknown)"}
Line items:
${lineItemsText}

Available expense accounts (id: name):
${accountsText}

Call the categorize_expense tool with your pick. If truly nothing fits, return an empty account_id and a low confidence rather than forcing a bad match.`;

  try {
    const client = new GoogleGenAI({
      apiKey: settings.geminiApiKey,
      httpOptions: { timeout: CATEGORIZE_TIMEOUT_MS, retryOptions: { attempts: 2 } },
    });
    const response = await client.models.generateContent({
      model: settings.geminiModel,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 1024,
        tools: [{ functionDeclarations: [CATEGORIZE_TOOL] }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ["categorize_expense"] } },
      },
    });

    const data = response.functionCalls?.[0]?.args;
    const account = accounts.find((a) => a.id === data?.account_id);
    if (!account) return { suggested: false };

    return {
      suggested: true,
      accountId: account.id,
      accountName: account.name,
      confidence: clamp01(data.confidence),
      reasoning: data.reasoning || "",
    };
  } catch (err) {
    // Same reasoning as extraction.js's LLM path: fall back rather than
    // fail the whole request on a transient API error -- the caller already
    // treats "no suggestion" as a normal, expected outcome.
    console.error("QuickBooks expense-account categorization failed:", err.message);
    return { suggested: false };
  }
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Reads org's QuickBooks bank/card feed activity (Purchase transactions --
// direct one-step expenses, as opposed to a Bill paid later) from the last
// sinceDays. This is the half of reconciliation QuickBooks' public API
// actually supports: the "for review"/unmatched bank feed itself has no
// public API, but once a transaction has been added as a Purchase (the
// common outcome when a bookkeeper doesn't recognize it as paying an
// existing Bill), it's a normal, queryable transaction. That's the real
// problem this feature targets -- a Purchase that duplicates a Bill Rekono
// already pushed and is still sitting unpaid.
export async function fetchBankTransactions(org, { sinceDays = 90, fetchImpl = fetch } = {}) {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = `select Id, TxnDate, TotalAmt, EntityRef, PrivateNote, Line from Purchase where TxnDate > '${since}' orderby TxnDate desc maxresults 200`;
  const result = await qbFetch(org, `/query?query=${encodeURIComponent(query)}`, { fetchImpl });
  if (result.error) return result;

  const purchases = result.data?.QueryResponse?.Purchase || [];
  return {
    data: purchases.map((p) => ({
      id: p.Id,
      date: p.TxnDate,
      amount: p.TotalAmt,
      payeeName: p.EntityRef?.name || "",
      description: p.PrivateNote || p.Line?.find((l) => l.Description)?.Description || "",
    })),
  };
}

// Pure heuristic pre-filter: which of org's already-pushed, still-unpaid
// invoices could this bank transaction plausibly be paying? QuickBooks bill
// payments are for the exact bill total, so amount matches exactly (to the
// cent); the date window absorbs the normal lag between an invoice's due
// date and when it actually clears the bank. No network, no AI -- this
// alone is often enough to resolve to a single confident candidate, so
// reconciliation still works without GEMINI_API_KEY configured. AI
// (suggestBankTransactionMatch, below) only gets involved when this leaves
// more than one plausible candidate to choose between.
export function findExactAmountCandidates(transaction, invoices, { dateWindowDays = 14 } = {}) {
  const txnDate = new Date(transaction.date);
  return invoices.filter((inv) => {
    if (inv.total == null || Math.abs(inv.total - transaction.amount) > 0.01) return false;
    const refDateStr = inv.dueDate || inv.invoiceDate;
    if (!refDateStr) return true;
    const diffDays = Math.abs((txnDate - new Date(refDateStr)) / (24 * 60 * 60 * 1000));
    return diffDays <= dateWindowDays;
  });
}

const MATCH_TOOL = {
  name: "match_bank_transaction",
  description:
    "Pick which (if any) of the given unpaid bills this bank/card transaction is most likely paying, with a confidence (0.0-1.0) and one short reason.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      invoice_id: {
        type: "string",
        description: "The id of the matching bill, exactly as given in the candidate list. Empty string if none is a plausible match.",
      },
      confidence: { type: "number" },
      reasoning: { type: "string", description: "One short sentence explaining the pick." },
    },
    required: ["invoice_id", "confidence", "reasoning"],
  },
};

const MATCH_TIMEOUT_MS = 30_000;

// Disambiguates between multiple same-amount candidates (findExactAmountCandidates
// already guarantees the amount and rough timing line up) using the
// transaction's payee/memo text -- which is frequently an abbreviated or
// garbled bank/processor string ("SQ *STARBUCKS 4421") rather than a clean
// vendor name, exactly the kind of free-text judgment call a fixed pattern
// can't make. Same no-fallback shape as suggestExpenseAccount: without
// GEMINI_API_KEY this returns no suggestion, and the caller leaves the
// transaction for a human to pick between the candidates manually.
export async function suggestBankTransactionMatch(transaction, candidateInvoices) {
  if (!settings.geminiApiKey || !candidateInvoices?.length) return { suggested: false };

  const candidatesText = candidateInvoices
    .map((inv) => `${inv.id}: vendor "${inv.vendorName || "(unknown)"}", amount $${inv.total}, invoice date ${inv.invoiceDate || "?"}, due ${inv.dueDate || "?"}`)
    .join("\n");

  const prompt = `A QuickBooks bank/card transaction needs to be matched to the unpaid bill it's most likely paying, if any. All candidates already match on dollar amount and rough timing -- use the payee/memo text to pick between them.

Transaction: ${transaction.payeeName || "(no payee on file)"} — $${transaction.amount} on ${transaction.date}${transaction.description ? `, memo: "${transaction.description}"` : ""}

Candidate unpaid bills (id: details):
${candidatesText}

Call match_bank_transaction with your pick. Bank/card transaction descriptions are often abbreviated or garbled (e.g. "SQ *STARBUCKS 4421" for "Starbucks Corp") -- weigh that against a clean vendor name mismatch. If truly nothing plausibly matches, return an empty invoice_id and a low confidence rather than forcing a bad match.`;

  try {
    const client = new GoogleGenAI({
      apiKey: settings.geminiApiKey,
      httpOptions: { timeout: MATCH_TIMEOUT_MS, retryOptions: { attempts: 2 } },
    });
    const response = await client.models.generateContent({
      model: settings.geminiModel,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 1024,
        tools: [{ functionDeclarations: [MATCH_TOOL] }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ["match_bank_transaction"] } },
      },
    });

    const data = response.functionCalls?.[0]?.args;
    const invoice = candidateInvoices.find((inv) => inv.id === data?.invoice_id);
    if (!invoice) return { suggested: false };

    return { suggested: true, invoiceId: invoice.id, confidence: clamp01(data.confidence), reasoning: data.reasoning || "" };
  } catch (err) {
    console.error("QuickBooks bank-transaction matching failed:", err.message);
    return { suggested: false };
  }
}
