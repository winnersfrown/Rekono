// Single source of truth for self-serve plan definitions -- used by
// onboarding (doc caps, Stripe checkout amounts) and by requirePlanCap
// (upload-time enforcement). Prices match the marketing site's pricing
// section exactly (annual = ~20% off, the same rounded price points).
// Scale is the ceiling: fully self-serve, no "talk to us" custom tier above it.

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
  scale: {
    name: "Scale",
    docCapPerMonth: 10000,
    seats: null, // unlimited
    monthlyPriceUsd: 1499,
    annualPriceUsd: 1199,
  },
};

export const PAID_PLAN_IDS = ["starter", "growth", "business", "scale"];

// Length of the Stripe trial given to a brand new org's first paid plan
// choice (onboarding.js only -- see createCheckoutSession in billing.js for
// why a later plan change/upgrade doesn't get one). Also the number quoted
// in onboarding's UI copy and the marketing site -- keep those in sync by
// hand if this ever changes, since only the backend can import it.
export const TRIAL_DAYS = 14;

export function isValidPlanId(planId) {
  return Object.prototype.hasOwnProperty.call(PLANS, planId);
}

// The monthly-equivalent rate shown on pricing UI ("$X/mo, billed
// annually" for the annual option) -- NOT what a single Stripe invoice
// charges. For that, see billingCycleAmountUsd below.
export function priceUsd(planId, billingPeriod) {
  const plan = PLANS[planId];
  return billingPeriod === "annual" ? plan.annualPriceUsd : plan.monthlyPriceUsd;
}

// What Stripe actually charges per billing cycle: the monthly rate every
// month, or 12x the monthly-equivalent annual rate once a year --
// annualPriceUsd is a per-month figure (matching the marketing site's "$X/mo,
// billed annually" copy), and an annual subscription bills the full year
// up front, not that bare per-month number.
export function billingCycleAmountUsd(planId, billingPeriod) {
  const monthlyEquivalent = priceUsd(planId, billingPeriod);
  return billingPeriod === "annual" ? monthlyEquivalent * 12 : monthlyEquivalent;
}
