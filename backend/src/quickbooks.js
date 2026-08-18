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

// Pushes one Rekono invoice to QuickBooks as a single-line Bill against
// org's chosen default expense account. One-way and manual (per-invoice,
// triggered by the user) in Phase 1 -- no sync-back, no bulk push, no
// automatic push-on-approve.
export async function pushInvoiceAsBill(org, invoice, { fetchImpl = fetch } = {}) {
  if (!org.quickbooksRealmId) return { error: "not_connected" };
  if (!org.quickbooksDefaultExpenseAccountId) return { error: "no_default_account" };
  if (invoice.quickbooksBillId) return { error: "already_pushed" };

  const vendor = await findOrCreateVendor(org, invoice.vendorName || "Unknown vendor", { fetchImpl });
  if (vendor.error) return vendor;

  const billPayload = {
    VendorRef: { value: vendor.data.id },
    Line: [
      {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: invoice.total ?? 0,
        AccountBasedExpenseLineDetail: { AccountRef: { value: org.quickbooksDefaultExpenseAccountId } },
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
