// Minimal in-memory per-key rate limiter -- shared by every route that
// needs one (login, signup, password reset, contact form, the AI
// assistant). In-memory means it resets on redeploy and doesn't coordinate
// across multiple server instances; fine for this app's scale and much
// simpler than standing up shared state (Redis) just for this. Each caller
// gets its own independent limiter/window/threshold via createRateLimiter,
// so exhausting one endpoint's limit never affects another's.
export function createRateLimiter({ windowMs, max }) {
  const timestampsByKey = new Map();
  let lastSweep = Date.now();

  // Without this the map is an unbounded cache keyed by client IP: every
  // distinct address that ever hits the endpoint keeps an entry forever,
  // which a spread-out flood turns into a slow memory leak. Sweeping on
  // access (rather than on a timer) keeps this module free of anything that
  // would hold the event loop open and break test teardown.
  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    for (const [key, timestamps] of timestampsByKey) {
      if (timestamps.every((t) => now - t >= windowMs)) timestampsByKey.delete(key);
    }
    lastSweep = now;
  }

  function isRateLimited(key) {
    const now = Date.now();
    sweep(now);
    const timestamps = (timestampsByKey.get(key) || []).filter((t) => now - t < windowMs);
    timestamps.push(now);
    timestampsByKey.set(key, timestamps);
    return timestamps.length > max;
  }

  // How many keys are currently being tracked. Exists so the sweep above is
  // observable -- otherwise "it stops growing" is untestable from outside.
  isRateLimited.trackedKeys = () => timestampsByKey.size;

  return isRateLimited;
}

// Express-middleware form of the same thing, for limits that apply to a
// whole path prefix rather than one handler. Mounted in app.js.
//
// Keyed by client IP. The per-account limiters in the route files (login,
// change-password, the assistant) stay keyed by account id where that's
// available and more precise; these are the volumetric backstop underneath
// them, and they have to work for unauthenticated traffic too, where an IP
// is the only key there is.
export function rateLimitMiddleware({ windowMs, max, message }) {
  const isRateLimited = createRateLimiter({ windowMs, max });
  return function rateLimitHandler(req, res, next) {
    if (isRateLimited(req.ip)) {
      return res.status(429).json({ detail: message });
    }
    next();
  };
}
