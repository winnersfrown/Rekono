import { Router } from "express";
import { z } from "zod";
import * as auth from "../auth.js";
import { Organization, User, AuditLog } from "../models/index.js";
import { serializeUser } from "../serializers.js";

const router = Router();

const signupSchema = z.object({
  org_name: z.string().min(1).max(256),
  full_name: z.string().min(1).max(256),
  email: z.string().email(),
  password: z.string().min(8).max(256),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

router.post("/api/auth/signup", async (req, res, next) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ detail: parsed.error.issues });
    }
    const { org_name, full_name, email, password } = parsed.data;
    const normalizedEmail = email.toLowerCase();

    const existing = await User.findOne({ where: { email: normalizedEmail } });
    if (existing) {
      return res.status(409).json({ detail: "An account with that email already exists" });
    }

    const org = await Organization.create({ name: org_name });
    const user = await User.create({
      orgId: org.id,
      email: normalizedEmail,
      hashedPassword: await auth.hashPassword(password),
      fullName: full_name,
    });

    await AuditLog.create({
      orgId: org.id,
      userId: user.id,
      action: "account_created",
      actor: user.email,
      details: { org_name: org.name },
    });

    res.status(201).json({ access_token: auth.createAccessToken(user.id), token_type: "bearer" });
  } catch (err) {
    next(err);
  }
});

router.post("/api/auth/login", async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ detail: parsed.error.issues });
    }
    const { email, password } = parsed.data;

    const user = await User.findOne({ where: { email: email.toLowerCase() } });
    if (!user || !(await auth.verifyPassword(password, user.hashedPassword))) {
      return res.status(401).json({ detail: "Incorrect email or password" });
    }

    res.json({ access_token: auth.createAccessToken(user.id), token_type: "bearer" });
  } catch (err) {
    next(err);
  }
});

router.get("/api/auth/me", auth.requireAuth, (req, res) => {
  res.json(serializeUser(req.currentUser));
});

export default router;
