// Minimal in-memory per-key rate limiter -- shared by every route that
// needs one (login, signup, password reset, contact form, the AI
// assistant). In-memory means it resets on redeploy and doesn't coordinate
// across multiple server instances; fine for this app's scale and much
// simpler than standing up shared state (Redis) just for this. Each caller
// gets its own independent limiter/window/threshold via createRateLimiter,
// so exhausting one endpoint's limit never affects another's.
export function createRateLimiter({ windowMs, max }) {
  const timestampsByKey = new Map();
  return function isRateLimited(key) {
    const now = Date.now();
    const timestamps = (timestampsByKey.get(key) || []).filter((t) => now - t < windowMs);
    timestamps.push(now);
    timestampsByKey.set(key, timestamps);
    return timestamps.length > max;
  };
}
