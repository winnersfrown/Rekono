// 14-day trial tracking/enforcement.
//
// No dedicated "trial start" column -- the trial simply runs from
// Organization.createdAt (the signup moment), which we already store. That
// avoids a migration and any risk of it drifting from the actual signup
// date.

export const TRIAL_DAYS = 14;
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

export function trialEndsAt(org) {
  return new Date(new Date(org.createdAt).getTime() + TRIAL_MS);
}

export function trialInfo(org) {
  const endsAt = trialEndsAt(org);
  const now = new Date();
  const msRemaining = endsAt.getTime() - now.getTime();

  // Fail closed: if createdAt is ever missing/unparseable, msRemaining is
  // NaN, and `NaN <= 0` is false in JS -- silently granting unlimited
  // access. Treat "can't tell" as expired instead, never as trusted.
  if (Number.isNaN(msRemaining)) {
    return { trialEndsAt: null, trialExpired: true, trialDaysRemaining: 0 };
  }

  return {
    trialEndsAt: endsAt,
    trialExpired: msRemaining <= 0,
    trialDaysRemaining: Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000))),
  };
}

// Express middleware -- mount after requireAuth on every data-touching
// route. Auth routes themselves (signup/login/me) stay exempt: a new
// signup must never be blocked by its own trial clock, and /me needs to
// keep working past expiry so the frontend can show *why* access stopped.
export function requireActiveTrial(req, res, next) {
  const { trialExpired } = trialInfo(req.currentUser.organization);
  if (trialExpired) {
    return res.status(402).json({
      detail: "Your 14-day trial has ended. Get in touch to keep using Rekono.",
      trial_expired: true,
    });
  }
  next();
}
