// The sub-category taxonomy layered on top of Account.type. models/Account.js
// deliberately leaves `subtype` a free string rather than a DB-enforced enum
// ("statement classification is a later phase's concern, not enforced yet")
// -- this is that phase. It does not change the column: an org can still
// carry a subtype that isn't listed here (equity.js and yearEndClose.js both
// create accounts on demand, e.g. "common_stock", and a user can still type
// anything into an account they set up before this existed). What this adds
// is a defined vocabulary the UI can offer as a picker instead of a blank
// text box, plus a `classification` per subtype so a chart of accounts can
// group "current" from "fixed"/"long-term" without the grouping rule being
// re-invented ad hoc wherever it's needed.
//
// Deliberately NOT wired into ledger.js's LIQUIDITY_RANK/accountSortRank --
// that ranking already decides *sort order* for the accounts it knows
// about, and changing it is a separate, riskier decision (it reorders an
// existing balance sheet) from *labeling* a subtype for display, which is
// all this file does. An unranked subtype still sorts after ranked ones, by
// code, exactly as it did before.

import { COST_OF_REVENUE_SUBTYPE } from "./ledger.js";
import { DEFERRED_REVENUE_SUBTYPE } from "./revenueRecognition.js";
import { INCOME_TAX_EXPENSE_SUBTYPE, INCOME_TAXES_PAYABLE_SUBTYPE } from "./incomeTax.js";
import { SALES_TAX_PAYABLE_SUBTYPE } from "./salesTax.js";
import { EQUITY_SUBTYPES, DIVIDENDS_PAYABLE_SUBTYPE } from "./equity.js";
import { STOCK_COMP_EXPENSE_SUBTYPE } from "./stockCompensation.js";
import { PURCHASES_DISCOUNT_SUBTYPE } from "./accountsPayable.js";

// Balance-sheet classifications, in the order a balance sheet reads them.
// "other" exists for the case a subtype doesn't map to either -- equity has
// no current/fixed split, so its entries carry no classification at all.
export const CLASSIFICATIONS = { CURRENT: "current", FIXED: "fixed", LONG_TERM: "long_term", OTHER: "other" };

export const ACCOUNT_SUBTYPES = {
  asset: [
    { value: "bank", label: "Cash & bank", classification: CLASSIFICATIONS.CURRENT },
    { value: "accounts_receivable", label: "Accounts receivable", classification: CLASSIFICATIONS.CURRENT },
    { value: "current_asset", label: "Other current asset", classification: CLASSIFICATIONS.CURRENT },
    { value: "fixed_asset", label: "Fixed asset", classification: CLASSIFICATIONS.FIXED },
    { value: "other_asset", label: "Other asset", classification: CLASSIFICATIONS.OTHER },
  ],
  liability: [
    { value: "accounts_payable", label: "Accounts payable", classification: CLASSIFICATIONS.CURRENT },
    { value: "credit_card", label: "Credit card", classification: CLASSIFICATIONS.CURRENT },
    { value: DEFERRED_REVENUE_SUBTYPE, label: "Deferred revenue", classification: CLASSIFICATIONS.CURRENT },
    { value: SALES_TAX_PAYABLE_SUBTYPE, label: "Sales tax payable", classification: CLASSIFICATIONS.CURRENT },
    { value: INCOME_TAXES_PAYABLE_SUBTYPE, label: "Income taxes payable", classification: CLASSIFICATIONS.CURRENT },
    { value: DIVIDENDS_PAYABLE_SUBTYPE, label: "Dividends payable", classification: CLASSIFICATIONS.CURRENT },
    { value: "current_liability", label: "Other current liability", classification: CLASSIFICATIONS.CURRENT },
    { value: "long_term_liability", label: "Long-term liability", classification: CLASSIFICATIONS.LONG_TERM },
  ],
  equity: [
    { value: EQUITY_SUBTYPES.COMMON_STOCK, label: "Common stock" },
    { value: EQUITY_SUBTYPES.APIC, label: "Additional paid-in capital" },
    { value: EQUITY_SUBTYPES.RETAINED_EARNINGS, label: "Retained earnings" },
    { value: EQUITY_SUBTYPES.TREASURY_STOCK, label: "Treasury stock" },
    { value: EQUITY_SUBTYPES.DISTRIBUTIONS, label: "Distributions" },
    { value: "owners_equity", label: "Owner's equity" },
  ],
  revenue: [
    { value: "operating_revenue", label: "Operating revenue" },
    { value: "other_revenue", label: "Other revenue" },
  ],
  expense: [
    { value: COST_OF_REVENUE_SUBTYPE, label: "Cost of revenue" },
    { value: "operating_expense", label: "Operating expense" },
    { value: STOCK_COMP_EXPENSE_SUBTYPE, label: "Stock compensation expense" },
    { value: INCOME_TAX_EXPENSE_SUBTYPE, label: "Income tax expense" },
    { value: PURCHASES_DISCOUNT_SUBTYPE, label: "Purchases discounts taken" },
    { value: "other_expense", label: "Other expense" },
  ],
};

const LABEL_BY_TYPE_AND_VALUE = new Map(
  Object.entries(ACCOUNT_SUBTYPES).flatMap(([type, subtypes]) =>
    subtypes.map((s) => [`${type}:${s.value}`, s.label])
  )
);

const CLASSIFICATION_BY_TYPE_AND_VALUE = new Map(
  Object.entries(ACCOUNT_SUBTYPES).flatMap(([type, subtypes]) =>
    subtypes.map((s) => [`${type}:${s.value}`, s.classification || CLASSIFICATIONS.OTHER])
  )
);

// Falls back to the raw subtype for one this org typed in or that a
// different part of the app created on demand (e.g. "common_stock" from
// equity.js before this list existed) -- never rejects a value it doesn't
// recognize, only fails to have a nicer label for it.
export function subtypeLabel(type, subtype) {
  if (!subtype) return "Uncategorized";
  return LABEL_BY_TYPE_AND_VALUE.get(`${type}:${subtype}`) || subtype;
}

// Balance-sheet types only get a real classification; revenue/expense/equity
// accounts don't split into current/fixed, so every subtype on those types
// -- recognized or not -- reports "other".
export function accountClassification(type, subtype) {
  if (type !== "asset" && type !== "liability") return CLASSIFICATIONS.OTHER;
  if (!subtype) return CLASSIFICATIONS.OTHER;
  return CLASSIFICATION_BY_TYPE_AND_VALUE.get(`${type}:${subtype}`) || CLASSIFICATIONS.OTHER;
}
