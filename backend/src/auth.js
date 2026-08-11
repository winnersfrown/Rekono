import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { settings } from "./config.js";
import { Organization, User } from "./models/index.js";

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

  req.currentUser = user;
  next();
}
