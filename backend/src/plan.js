// Plan-based access gating -- replaces the old 14-day trial system, which
// gave every signup a hard countdown regardless of whether they'd chosen
// (or paid for) anything. Now every org picks a plan during onboarding
// (routes/onboarding.js): "free" is immediately and permanently active,
// paid plans require an active Stripe subscription.

// Express middleware, mounted after requireAuth on every data-touching
// route (auth routes themselves stay exempt, same as the trial system:
// signup/login/me must keep working regardless of plan state, since /me is
// how the frontend even finds out onboarding isn't done or billing lapsed).
//
// Two distinct 402 reasons, not one generic "blocked" -- the frontend routes
// to a different screen for each: onboarding_required means the signup flow
// was never finished (no plan chosen yet), billing_required means a paid
// plan was chosen but there's no active subscription behind it (checkout
// abandoned, payment failed, or a subscription that later lapsed/canceled).
export function requireActivePlan(req, res, next) {
  const org = req.currentUser.organization;
  if (!org.plan) {
    return res.status(402).json({ detail: "Finish setting up your account to continue.", onboarding_required: true });
  }
  if (org.plan === "free") return next();
  if (org.subscriptionStatus === "active") return next();
  return res.status(402).json({ detail: "Your subscription isn't active. Update your billing to continue.", billing_required: true });
}
