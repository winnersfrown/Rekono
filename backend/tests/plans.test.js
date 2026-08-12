import { PLANS, billingCycleAmountUsd, priceUsd } from "../src/plans.js";

// billingCycleAmountUsd is what actually gets sent to Stripe as unit_amount
// -- getting it wrong for the annual case (charging the bare monthly-
// equivalent rate once a year instead of 12x it) would silently undercharge
// every annual subscriber by 12x. priceUsd is the display-only figure this
// is derived from ("$X/mo, billed annually"), matching the marketing site.

test("priceUsd returns the monthly-equivalent rate for both periods", () => {
  expect(priceUsd("starter", "monthly")).toBe(PLANS.starter.monthlyPriceUsd);
  expect(priceUsd("starter", "annual")).toBe(PLANS.starter.annualPriceUsd);
});

test("billingCycleAmountUsd charges the plain monthly rate every month", () => {
  expect(billingCycleAmountUsd("growth", "monthly")).toBe(PLANS.growth.monthlyPriceUsd);
});

test("billingCycleAmountUsd charges 12x the monthly-equivalent rate once a year", () => {
  for (const planId of ["starter", "growth", "business"]) {
    expect(billingCycleAmountUsd(planId, "annual")).toBe(PLANS[planId].annualPriceUsd * 12);
  }
});

test("matches the marketing site's advertised annual totals", () => {
  expect(billingCycleAmountUsd("starter", "annual")).toBe(948);
  expect(billingCycleAmountUsd("growth", "annual")).toBe(2388);
  expect(billingCycleAmountUsd("business", "annual")).toBe(4788);
});
