// Plaid client: live bank-account connections for reconciliation (see
// routes/plaid.js). Every exported function that hits the network takes an
// injectable `client` (defaults to a real PlaidApi instance) so tests can
// supply a fake without hitting Plaid's API -- same pattern as
// billing.js's injectable Stripe client and quickbooks.js's injectable
// fetchImpl.
//
// "Expected" failures (not configured, Plaid rejected the request) are
// returned as { error, detail? } rather than thrown -- same convention as
// quickbooks.js -- so routes can translate them into a specific status
// code. Only genuinely unexpected failures propagate to the route's
// try/catch and the app-wide 500 handler.
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { settings } from "./config.js";

export function plaidConfigured() {
  return Boolean(settings.plaidClientId && settings.plaidSecret);
}

function realClient() {
  const configuration = new Configuration({
    basePath: PlaidEnvironments[settings.plaidEnv] || PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": settings.plaidClientId,
        "PLAID-SECRET": settings.plaidSecret,
      },
    },
  });
  return new PlaidApi(configuration);
}

function plaidErrorDetail(err) {
  return err?.response?.data?.error_message || err?.response?.data?.error_code || err.message;
}

// A Link token is what the frontend's Plaid Link widget needs to open --
// short-lived (Plaid: 30 minutes), one per connect attempt, never stored.
export async function createLinkToken({ orgId, client = realClient() }) {
  try {
    const res = await client.linkTokenCreate({
      user: { client_user_id: orgId },
      client_name: "Rekono",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    return { linkToken: res.data.link_token };
  } catch (err) {
    console.error("Plaid link token creation failed:", plaidErrorDetail(err));
    return { error: "plaid_error", detail: plaidErrorDetail(err) };
  }
}

// Link hands the frontend a short-lived public_token on success; this is
// the one-time exchange for the long-lived access_token that every other
// call in this module authenticates with. The access_token is the
// credential worth encrypting at rest -- see models/BankConnection.js.
export async function exchangePublicToken({ publicToken, client = realClient() }) {
  try {
    const res = await client.itemPublicTokenExchange({ public_token: publicToken });
    return { accessToken: res.data.access_token, itemId: res.data.item_id };
  } catch (err) {
    console.error("Plaid public token exchange failed:", plaidErrorDetail(err));
    return { error: "plaid_error", detail: plaidErrorDetail(err) };
  }
}

// Institution name isn't on accountsGet's response -- only its stable id
// is (item.institution_id) -- so a friendly name for display needs this
// second call. Fetched once at connect time and stored on BankConnection
// rather than looked up again on every read.
export async function fetchInstitutionName({ institutionId, client = realClient() }) {
  if (!institutionId) return "";
  try {
    const res = await client.institutionsGetById({ institution_id: institutionId, country_codes: [CountryCode.Us] });
    return res.data.institution?.name || "";
  } catch (err) {
    console.error("Plaid institution lookup failed:", plaidErrorDetail(err));
    return "";
  }
}

// The accounts and the institution id behind one access token -- called
// once right after exchange to populate BankAccount rows, so it hands back
// everything routes/plaid.js needs in one round trip.
export async function fetchAccountsForItem({ accessToken, client = realClient() }) {
  try {
    const res = await client.accountsGet({ access_token: accessToken });
    return { accounts: res.data.accounts, institutionId: res.data.item.institution_id };
  } catch (err) {
    const code = err?.response?.data?.error_code;
    if (code === "ITEM_LOGIN_REQUIRED") return { error: "login_required" };
    console.error("Plaid accounts fetch failed:", plaidErrorDetail(err));
    return { error: "plaid_error", detail: plaidErrorDetail(err) };
  }
}

// Manual "Sync now" pull rather than a webhook-driven cursor sync
// (transactions/sync) -- this app's other reconciliation sources (CSV
// upload, QuickBooks bank-transactions) are both "load when the user asks"
// too, so this matches instead of introducing a second, webhook-based
// freshness model just for Plaid. Defaults to the last 90 days, wide
// enough to cover a typical AP reconciliation cadence without pulling a
// account's entire history on every click.
export async function fetchTransactions({ accessToken, startDate, endDate, client = realClient() }) {
  const end = endDate || new Date().toISOString().slice(0, 10);
  const start = startDate || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const transactions = [];
    let totalTransactions = null;
    while (totalTransactions === null || transactions.length < totalTransactions) {
      const res = await client.transactionsGet({
        access_token: accessToken,
        start_date: start,
        end_date: end,
        options: { offset: transactions.length, count: 500 },
      });
      transactions.push(...res.data.transactions);
      totalTransactions = res.data.total_transactions;
    }
    return { transactions };
  } catch (err) {
    const code = err?.response?.data?.error_code;
    if (code === "ITEM_LOGIN_REQUIRED") return { error: "login_required" };
    console.error("Plaid transactions fetch failed:", plaidErrorDetail(err));
    return { error: "plaid_error", detail: plaidErrorDetail(err) };
  }
}

// Revokes the access_token on Plaid's side (not just deleting our own
// row) -- otherwise a removed connection's credential would keep working
// against Plaid's API forever if the same token ever leaked.
export async function removeItem({ accessToken, client = realClient() }) {
  try {
    await client.itemRemove({ access_token: accessToken });
    return { ok: true };
  } catch (err) {
    console.error("Plaid item removal failed:", plaidErrorDetail(err));
    return { error: "plaid_error", detail: plaidErrorDetail(err) };
  }
}
