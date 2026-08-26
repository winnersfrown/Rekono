import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { settings } from "./config.js";
import { Organization, User } from "./models/index.js";
import { createRateLimiter } from "./rateLimit.js";
import { setOrgContext } from "./rls.js";

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hashedPassword) {
  try {
    return await bcrypt.compare(password, hashedPassword);
  } catch {
    return false;
  }
}

export function createAccessToken(userId) {
  return jwt.sign({ sub: userId }, settings.secretKey, {
    algorithm: "HS256",
    expiresIn: settings.accessTokenExpiresIn,
  });
}

// Issued once a password (or Google) login is correct but the account has
// 2FA enabled -- proves "this request already passed the first factor"
// without granting real access. A distinct `purpose` claim (rather than a
// second secret) keeps this a one-line addition to the existing JWT
// machinery instead of a parallel token system, while still making a
// pending token unusable anywhere a real access token is expected: every
// other verify site (requireAuth) never checks `purpose`, but this token's
// 10-minute expiry and single intended use (POST /api/auth/2fa/verify) mean
// that doesn't matter -- it carries no more than "this is user X, recently
// authenticated with a password."
export function createPending2faToken(userId) {
  return jwt.sign({ sub: userId, purpose: "2fa_pending" }, settings.secretKey, {
    algorithm: "HS256",
    expiresIn: "10m",
  });
}

// Throws (via jwt.verify) on anything invalid/expired/wrong-purpose --
// callers catch it the same way requireAuth's jwt.verify call is caught.
export function verifyPending2faToken(token) {
  const payload = jwt.verify(token, settings.secretKey, { algorithms: ["HS256"] });
  if (payload.purpose !== "2fa_pending") {
    throw new Error("Not a pending-2FA token");
  }
  return payload.sub;
}

// Express middleware: verifies the bearer token and attaches req.currentUser,
// or responds 401. Every data-touching route depends on this.
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ detail: "Not authenticated" });
  }

  let payload;
  try {
    payload = jwt.verify(token, settings.secretKey, { algorithms: ["HS256"] });
  } catch {
    return res.status(401).json({ detail: "Invalid or expired token" });
  }

  const user = await User.findByPk(payload.sub, { include: [{ model: Organization, as: "organization" }] });
  if (!user) {
    return res.status(401).json({ detail: "User no longer exists" });
  }

  // The lookup above runs in the request's system context -- it has to,
  // since the org isn't known until the user row is in hand. From here on
  // the request is pinned to that one org at the database level, so any
  // query below that forgets to scope itself sees nothing rather than
  // another tenant's rows.
  await setOrgContext(user.orgId);

  req.currentUser = user;
  next();
}

// Re-authentication gate for actions that are destructive and can't be
// undone from the UI. A valid bearer token proves someone signed in at some
// point in the last two weeks (see settings.accessTokenExpiresIn) -- on a
// shared or unattended machine that's a low bar for irreversibly removing a
// colleague's access or tearing out a live accounting integration. Asking
// for the password again at the moment of the action closes that window.
//
// Takes the password from the request body under the same `current_password`
// name POST /api/auth/change-password already uses, so there's one shape for
// the frontend to handle rather than two. Rate-limited per user for the same
// reason login is: this endpoint verifies a password, so it's a guessing
// oracle if left unbounded.
const isReauthRateLimited = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

export async function requireReauth(req, res, next) {
  if (isReauthRateLimited(req.currentUser.id)) {
    return res.status(429).json({ detail: "Too many attempts. Please try again later." });
  }

  const currentPassword = req.body?.current_password;
  if (typeof currentPassword !== "string" || currentPassword === "") {
    // reauth_required lets the frontend tell this apart from an ordinary
    // permission failure and prompt for the password instead of showing a
    // dead end.
    return res.status(403).json({ detail: "Confirm your password to continue.", reauth_required: true });
  }

  if (!(await verifyPassword(currentPassword, req.currentUser.hashedPassword))) {
    return res.status(403).json({ detail: "That password is incorrect.", reauth_required: true });
  }

  next();
}
