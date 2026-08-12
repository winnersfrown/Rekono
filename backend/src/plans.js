// Single source of truth for self-serve plan definitions -- used by
// onboarding (doc caps, Stripe checkout amounts) and by requirePlanCap
// (upload-time enforcement). Prices match the marketing site's pricing
// section exactly (annual = ~20% off, the same rounded price points).
// Enterprise is intentionally not here: it's "talk to us," not self-serve,
// and has no fixed price or cap to encode.

export const PLANS = {
  free: {
    name: "Free",
    docCapPerMonth: 25,
    seats: 1,
    monthlyPriceUsd: 0,
    annualPriceUsd: 0,
  },
  starter: {
    name: "Starter",
    docCapPerMonth: 150,
    seats: 1,
    monthlyPriceUsd: 99,
    annualPriceUsd: 79,
  },
  growth: {
    name: "Growth",
    docCapPerMonth: 750,
    seats: 5,
    monthlyPriceUsd: 249,
    annualPriceUsd: 199,
  },
  business: {
    name: "Business",
    docCapPerMonth: 2500,
    seats: null, // unlimited
    monthlyPriceUsd: 499,
    annualPriceUsd: 399,
  },
};

export const PAID_PLAN_IDS = ["starter", "growth", "business"];

export function isValidPlanId(planId) {
  return Object.prototype.hasOwnProperty.call(PLANS, planId);
}

export function priceUsd(planId, billingPeriod) {
  const plan = PLANS[planId];
  return billingPeriod === "annual" ? plan.annualPriceUsd : plan.monthlyPriceUsd;
}
