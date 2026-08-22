import { Router } from "express";
import * as auth from "../auth.js";
import { seedDemoOrg } from "../demoSeed.js";
import { createRateLimiter } from "../rateLimit.js";

const router = Router();

// A public, unauthenticated endpoint that spins up a brand-new org --
// generous relative to signup's rate limit (30/15min, routes/auth.js) since
// this is meant to be hit by anyone who lands on the marketing site's "View
// live demo" link, including the same investor reloading it a few times.
// Still capped: without a limit, a scripted loop could spin up unbounded
// demo orgs/rows for free with zero accounts behind them.
const isDemoLoginRateLimited = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

router.post("/api/demo/login", async (req, res, next) => {
  try {
    if (isDemoLoginRateLimited(req.ip)) {
      return res.status(429).json({ detail: "Too many demo requests. Please try again in a few minutes." });
    }

    const { user } = await seedDemoOrg();

    res.status(201).json({ access_token: auth.createAccessToken(user.id), token_type: "bearer" });
  } catch (err) {
    next(err);
  }
});

export default router;
