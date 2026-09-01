import { jest } from "@jest/globals";
import {
  createLinkToken,
  exchangePublicToken,
  fetchAccountsForItem,
  fetchInstitutionName,
  fetchTransactions,
  plaidConfigured,
  removeItem,
} from "../src/plaid.js";

// PLAID_CLIENT_ID/PLAID_SECRET are never set in the test environment
// (jest.setup.js), so like quickbooks.test.js this file exercises the real
// logic directly: every network call takes an injected fake `client`
// standing in for the Plaid SDK's PlaidApi instance, same pattern as
// quickbooks.js's injectable fetchImpl and billing.js's injectable stripe
// client -- that's the whole reason every exported function here takes a
// `client` parameter.

function plaidError({ code, message = "Plaid rejected the request" } = {}) {
  return { response: { data: { error_code: code, error_message: message } }, message };
}

test("plaidConfigured is false with no PLAID_CLIENT_ID/PLAID_SECRET set", () => {
  expect(plaidConfigured()).toBe(false);
});

describe("createLinkToken", () => {
  test("returns the link token on success", async () => {
    const client = { linkTokenCreate: jest.fn().mockResolvedValue({ data: { link_token: "link-sandbox-abc" } }) };
    const result = await createLinkToken({ orgId: "org1", client });
    expect(result.linkToken).toBe("link-sandbox-abc");
    expect(client.linkTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({ user: { client_user_id: "org1" } })
    );
  });

  test("returns a plaid_error when the API call fails", async () => {
    const client = { linkTokenCreate: jest.fn().mockRejectedValue(plaidError({ code: "INVALID_FIELD" })) };
    const result = await createLinkToken({ orgId: "org1", client });
    expect(result.error).toBe("plaid_error");
  });
});

describe("exchangePublicToken", () => {
  test("returns the access token and item id on success", async () => {
    const client = {
      itemPublicTokenExchange: jest.fn().mockResolvedValue({ data: { access_token: "access-sandbox-xyz", item_id: "item-1" } }),
    };
    const result = await exchangePublicToken({ publicToken: "public-sandbox-xyz", client });
    expect(result.accessToken).toBe("access-sandbox-xyz");
    expect(result.itemId).toBe("item-1");
  });

  test("returns an error when the exchange fails", async () => {
    const client = { itemPublicTokenExchange: jest.fn().mockRejectedValue(plaidError({ code: "INVALID_PUBLIC_TOKEN" })) };
    const result = await exchangePublicToken({ publicToken: "bad-token", client });
    expect(result.error).toBe("plaid_error");
  });
});

describe("fetchInstitutionName", () => {
  test("returns empty string with no institution id, without calling the API", async () => {
    const client = { institutionsGetById: jest.fn() };
    const name = await fetchInstitutionName({ institutionId: null, client });
    expect(name).toBe("");
    expect(client.institutionsGetById).not.toHaveBeenCalled();
  });

  test("returns the institution's name on success", async () => {
    const client = { institutionsGetById: jest.fn().mockResolvedValue({ data: { institution: { name: "First National Bank" } } }) };
    const name = await fetchInstitutionName({ institutionId: "ins_1", client });
    expect(name).toBe("First National Bank");
  });

  test("returns empty string (not throw) when the lookup fails", async () => {
    const client = { institutionsGetById: jest.fn().mockRejectedValue(plaidError({ code: "INSTITUTION_NOT_FOUND" })) };
    const name = await fetchInstitutionName({ institutionId: "ins_bad", client });
    expect(name).toBe("");
  });
});

describe("fetchAccountsForItem", () => {
  test("returns the accounts and institution id on success", async () => {
    const client = {
      accountsGet: jest.fn().mockResolvedValue({
        data: { accounts: [{ account_id: "acct_1", name: "Checking" }], item: { institution_id: "ins_1" } },
      }),
    };
    const result = await fetchAccountsForItem({ accessToken: "access-1", client });
    expect(result.accounts).toHaveLength(1);
    expect(result.institutionId).toBe("ins_1");
  });

  test("maps ITEM_LOGIN_REQUIRED to a distinct error the route can act on", async () => {
    const client = { accountsGet: jest.fn().mockRejectedValue(plaidError({ code: "ITEM_LOGIN_REQUIRED" })) };
    const result = await fetchAccountsForItem({ accessToken: "access-1", client });
    expect(result.error).toBe("login_required");
  });

  test("returns a generic plaid_error for anything else", async () => {
    const client = { accountsGet: jest.fn().mockRejectedValue(plaidError({ code: "RATE_LIMIT_EXCEEDED" })) };
    const result = await fetchAccountsForItem({ accessToken: "access-1", client });
    expect(result.error).toBe("plaid_error");
  });
});

describe("fetchTransactions", () => {
  test("returns transactions from a single page", async () => {
    const client = {
      transactionsGet: jest.fn().mockResolvedValue({
        data: { transactions: [{ transaction_id: "t1" }, { transaction_id: "t2" }], total_transactions: 2 },
      }),
    };
    const result = await fetchTransactions({ accessToken: "access-1", client });
    expect(result.transactions).toHaveLength(2);
    expect(client.transactionsGet).toHaveBeenCalledTimes(1);
  });

  test("pages through results until every transaction is fetched", async () => {
    const page1 = { transactions: [{ transaction_id: "t1" }], total_transactions: 3 };
    const page2 = { transactions: [{ transaction_id: "t2" }], total_transactions: 3 };
    const page3 = { transactions: [{ transaction_id: "t3" }], total_transactions: 3 };
    const client = {
      transactionsGet: jest
        .fn()
        .mockResolvedValueOnce({ data: page1 })
        .mockResolvedValueOnce({ data: page2 })
        .mockResolvedValueOnce({ data: page3 }),
    };
    const result = await fetchTransactions({ accessToken: "access-1", client });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(["t1", "t2", "t3"]);
    expect(client.transactionsGet).toHaveBeenCalledTimes(3);
  });

  test("maps ITEM_LOGIN_REQUIRED the same way accountsGet does", async () => {
    const client = { transactionsGet: jest.fn().mockRejectedValue(plaidError({ code: "ITEM_LOGIN_REQUIRED" })) };
    const result = await fetchTransactions({ accessToken: "access-1", client });
    expect(result.error).toBe("login_required");
  });

  test("defaults to a 90-day window when no dates are given", async () => {
    const client = { transactionsGet: jest.fn().mockResolvedValue({ data: { transactions: [], total_transactions: 0 } }) };
    await fetchTransactions({ accessToken: "access-1", client });
    const call = client.transactionsGet.mock.calls[0][0];
    const days = (new Date(call.end_date) - new Date(call.start_date)) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(90, 0);
  });
});

describe("removeItem", () => {
  test("returns ok on success", async () => {
    const client = { itemRemove: jest.fn().mockResolvedValue({}) };
    const result = await removeItem({ accessToken: "access-1", client });
    expect(result.ok).toBe(true);
  });

  test("returns an error rather than throwing on failure", async () => {
    const client = { itemRemove: jest.fn().mockRejectedValue(plaidError({ code: "ITEM_NOT_FOUND" })) };
    const result = await removeItem({ accessToken: "access-1", client });
    expect(result.error).toBe("plaid_error");
  });
});
