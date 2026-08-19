import { jest } from "@jest/globals";
import {
  applyTokens,
  ensureFreshToken,
  exchangeCodeForTokens,
  fetchExpenseAccounts,
  findOrCreateVendor,
  pushInvoiceAsBill,
  quickbooksApiBaseUrl,
  refreshAccessToken,
  suggestExpenseAccount,
} from "../src/quickbooks.js";

// QUICKBOOKS_CLIENT_ID/QUICKBOOKS_CLIENT_SECRET are never set in the test
// environment (jest.setup.js), so unlike a route test this file exercises
// the real logic directly: every network call here takes an injected fake
// fetchImpl standing in for Intuit's API, same pattern as billing.js's
// injectable stripe client (see billing.test.js's createCheckoutSession
// tests) -- that's the whole reason quickbooks.js was built with an
// fetchImpl parameter on every exported function in the first place.

function fakeOrg(overrides = {}) {
  const org = {
    quickbooksRealmId: "9999",
    quickbooksAccessToken: "fake-access-token",
    quickbooksRefreshToken: "fake-refresh-token",
    quickbooksAccessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    quickbooksRefreshTokenExpiresAt: new Date(Date.now() + 100 * 24 * 60 * 60 * 1000),
    quickbooksDefaultExpenseAccountId: "42",
    quickbooksDefaultExpenseAccountName: "Office Supplies",
    ...overrides,
  };
  org.save = jest.fn().mockResolvedValue(org);
  return org;
}

function fakeInvoice(overrides = {}) {
  return {
    vendorName: "Acme Corp",
    total: 199.99,
    invoiceDate: "2026-01-15",
    dueDate: null,
    invoiceNumber: "INV-1",
    quickbooksBillId: null,
    ...overrides,
  };
}

function jsonResponse(body, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("quickbooksApiBaseUrl", () => {
  test("defaults to the sandbox host", () => {
    expect(quickbooksApiBaseUrl()).toBe("https://sandbox-quickbooks.api.intuit.com");
  });
});

describe("exchangeCodeForTokens / refreshAccessToken", () => {
  test("exchangeCodeForTokens returns tokens on success", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600, x_refresh_token_expires_in: 8640000 }));
    const result = await exchangeCodeForTokens({ code: "abc", redirectUri: "https://x/cb", fetchImpl });
    expect(result.tokens.access_token).toBe("at");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("exchangeCodeForTokens returns an error instead of throwing on failure", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, false));
    const result = await exchangeCodeForTokens({ code: "bad", redirectUri: "https://x/cb", fetchImpl });
    expect(result.error).toBe("oauth_failed");
  });

  test("refreshAccessToken returns tokens on success", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: "at2", refresh_token: "rt2", expires_in: 3600, x_refresh_token_expires_in: 8640000 }));
    const result = await refreshAccessToken({ refreshToken: "rt", fetchImpl });
    expect(result.tokens.access_token).toBe("at2");
  });
});

describe("applyTokens", () => {
  test("stores tokens and computes expiry timestamps from Intuit's *_in seconds", async () => {
    const org = fakeOrg();
    const before = Date.now();
    await applyTokens(org, { access_token: "at", refresh_token: "rt", expires_in: 3600, x_refresh_token_expires_in: 8640000 });
    expect(org.quickbooksAccessToken).toBe("at");
    expect(org.quickbooksRefreshToken).toBe("rt");
    expect(org.quickbooksAccessTokenExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(org.save).toHaveBeenCalledTimes(1);
  });
});

describe("ensureFreshToken", () => {
  test("returns null when the org isn't connected", async () => {
    const org = fakeOrg({ quickbooksRealmId: null });
    expect(await ensureFreshToken(org)).toBeNull();
  });

  test("returns the existing token without refreshing when it isn't near expiry", async () => {
    const org = fakeOrg();
    const fetchImpl = jest.fn();
    const token = await ensureFreshToken(org, { fetchImpl });
    expect(token).toBe("fake-access-token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("refreshes when the access token is expired", async () => {
    const org = fakeOrg({ quickbooksAccessTokenExpiresAt: new Date(Date.now() - 1000) });
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: "refreshed", refresh_token: "rt2", expires_in: 3600, x_refresh_token_expires_in: 8640000 }));
    const token = await ensureFreshToken(org, { fetchImpl });
    expect(token).toBe("refreshed");
    expect(org.quickbooksAccessToken).toBe("refreshed");
  });

  test("returns null when the refresh token itself has expired", async () => {
    const org = fakeOrg({ quickbooksAccessTokenExpiresAt: new Date(Date.now() - 1000) });
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, false));
    expect(await ensureFreshToken(org, { fetchImpl })).toBeNull();
  });
});

describe("fetchExpenseAccounts", () => {
  test("returns a flat id/name list", async () => {
    const org = fakeOrg();
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        QueryResponse: {
          Account: [
            { Id: "1", Name: "Office Supplies" },
            { Id: "2", Name: "Travel" },
          ],
        },
      })
    );
    const result = await fetchExpenseAccounts(org, { fetchImpl });
    expect(result.data).toEqual([
      { id: "1", name: "Office Supplies" },
      { id: "2", name: "Travel" },
    ]);
  });

  test("returns not_connected without calling fetch when the org isn't connected", async () => {
    const org = fakeOrg({ quickbooksRealmId: null });
    const fetchImpl = jest.fn();
    const result = await fetchExpenseAccounts(org, { fetchImpl });
    expect(result.error).toBe("not_connected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("findOrCreateVendor", () => {
  test("returns an existing vendor without creating one", async () => {
    const org = fakeOrg();
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ QueryResponse: { Vendor: [{ Id: "55", DisplayName: "Acme Corp" }] } }));
    const result = await findOrCreateVendor(org, "Acme Corp", { fetchImpl });
    expect(result.data).toEqual({ id: "55", name: "Acme Corp" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("creates a vendor when none is found", async () => {
    const org = fakeOrg();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: {} }))
      .mockResolvedValueOnce(jsonResponse({ Vendor: { Id: "77", DisplayName: "New Vendor LLC" } }));
    const result = await findOrCreateVendor(org, "New Vendor LLC", { fetchImpl });
    expect(result.data).toEqual({ id: "77", name: "New Vendor LLC" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("pushInvoiceAsBill", () => {
  test("refuses to push when the org isn't connected", async () => {
    const org = fakeOrg({ quickbooksRealmId: null });
    const result = await pushInvoiceAsBill(org, fakeInvoice());
    expect(result.error).toBe("not_connected");
  });

  test("refuses to push without a default expense account", async () => {
    const org = fakeOrg({ quickbooksDefaultExpenseAccountId: null });
    const result = await pushInvoiceAsBill(org, fakeInvoice());
    expect(result.error).toBe("no_default_account");
  });

  test("refuses to push an invoice that's already been pushed", async () => {
    const org = fakeOrg();
    const result = await pushInvoiceAsBill(org, fakeInvoice({ quickbooksBillId: "bill_1" }));
    expect(result.error).toBe("already_pushed");
  });

  test("creates the vendor and bill, returning the new bill id", async () => {
    const org = fakeOrg();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: {} })) // vendor lookup: not found
      .mockResolvedValueOnce(jsonResponse({ Vendor: { Id: "77", DisplayName: "Acme Corp" } })) // vendor created
      .mockResolvedValueOnce(jsonResponse({ Bill: { Id: "b1" } })); // bill created

    const result = await pushInvoiceAsBill(org, fakeInvoice(), { fetchImpl });
    expect(result.data).toEqual({ id: "b1" });

    const billCall = fetchImpl.mock.calls[2];
    const billBody = JSON.parse(billCall[1].body);
    expect(billBody.VendorRef).toEqual({ value: "77" });
    expect(billBody.Line[0].Amount).toBe(199.99);
    expect(billBody.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: "42" });
  });

  test("surfaces an API error from Intuit instead of throwing", async () => {
    const org = fakeOrg();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Vendor: [{ Id: "55", DisplayName: "Acme Corp" }] } }))
      .mockResolvedValueOnce(jsonResponse({ Fault: { Error: [{ Message: "boom" }] } }, false));

    const result = await pushInvoiceAsBill(org, fakeInvoice(), { fetchImpl });
    expect(result.error).toBe("api_error");
  });

  test("uses the invoice's own categorized account over the org default when set", async () => {
    const org = fakeOrg(); // default account "42"
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Vendor: [{ Id: "55", DisplayName: "Acme Corp" }] } }))
      .mockResolvedValueOnce(jsonResponse({ Bill: { Id: "b1" } }));

    const result = await pushInvoiceAsBill(org, fakeInvoice({ quickbooksExpenseAccountId: "77" }), { fetchImpl });
    expect(result.data).toEqual({ id: "b1" });

    const billBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(billBody.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: "77" });
  });

  test("falls back to the org default when the invoice has no categorized account", async () => {
    const org = fakeOrg(); // default account "42"
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Vendor: [{ Id: "55", DisplayName: "Acme Corp" }] } }))
      .mockResolvedValueOnce(jsonResponse({ Bill: { Id: "b1" } }));

    const result = await pushInvoiceAsBill(org, fakeInvoice({ quickbooksExpenseAccountId: null }), { fetchImpl });
    expect(result.data).toEqual({ id: "b1" });

    const billBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(billBody.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: "42" });
  });
});

describe("suggestExpenseAccount", () => {
  // ANTHROPIC_API_KEY is never set in the test environment (jest.setup.js),
  // so -- same limitation as extraction.js's LLM path -- this can only be
  // exercised down to its "not configured" no-op here. What matters is that
  // it degrades to "no suggestion" instead of guessing or throwing.
  test("returns no suggestion without ANTHROPIC_API_KEY configured", async () => {
    const invoice = fakeInvoice({ lineItems: [{ description: "Compute", amount: 50 }] });
    const accounts = [{ id: "42", name: "Office Supplies" }, { id: "77", name: "Software & Subscriptions" }];
    const result = await suggestExpenseAccount(invoice, accounts);
    expect(result).toEqual({ suggested: false });
  });

  test("returns no suggestion when there are no accounts to choose from", async () => {
    const result = await suggestExpenseAccount(fakeInvoice(), []);
    expect(result).toEqual({ suggested: false });
  });
});
