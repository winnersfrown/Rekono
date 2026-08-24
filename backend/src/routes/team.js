// Team management: invite teammates by email, accept an invite, revoke a
// pending invite, remove a member. Seats (plans.js) were a pricing-page
// promise with nothing behind them until this file existed -- every org
// could only ever have the one user who signed up.

import crypto from "node:crypto";
import { Router } from "express";
import { Resend } from "resend";
import { z } from "zod";
import * as auth from "../auth.js";
import { requireAuth, requireReauth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { settings } from "../config.js";
import { PLANS } from "../plans.js";
import { hasSeatAvailable, seatsUsed } from "../seats.js";
import { AuditLog, Invite, Organization, User } from "../models/index.js";
import { serializeUser } from "../serializers.js";

const router = Router();

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function requireOwner(req, res, next) {
  if (req.currentUser.role !== "owner") {
    return res.status(403).json({ detail: "Only the account owner can manage team members." });
  }
  next();
}

router.get("/api/team", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const plan = PLANS[req.currentUser.organization.plan];
    const [members, invites] = await Promise.all([
      User.findAll({ where: { orgId }, order: [["createdAt", "ASC"]] }),
      Invite.findAll({ where: { orgId, status: "pending" }, order: [["createdAt", "ASC"]] }),
    ]);

    res.json({
      seat_limit: plan?.seats ?? null,
      seats_used: members.length + invites.length,
      members: members.map((u) => ({ ...serializeUser(u), is_you: u.id === req.currentUser.id })),
      pending_invites: invites.map((i) => ({ id: i.id, email: i.email, invited_at: i.createdAt })),
    });
  } catch (err) {
    next(err);
  }
});

const inviteSchema = z.object({ email: z.string().email() });

router.post("/api/team/invite", requireAuth, requireActivePlan, requireOwner, async (req, res, next) => {
  try {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const email = parsed.data.email.toLowerCase();

    const org = req.currentUser.organization;
    const plan = PLANS[org.plan];
    const used = await seatsUsed(org.id);
    if (!hasSeatAvailable(plan?.seats ?? null, used)) {
      return res.status(402).json({
        detail: `You've used all ${plan?.seats} seats on the ${plan?.name || org.plan} plan. Upgrade to invite more teammates.`,
        plan_cap_reached: true,
      });
    }

    if (await User.findOne({ where: { email } })) {
      return res.status(409).json({ detail: "That email already has a Rekono account." });
    }

    // Re-inviting the same address (e.g. the first email never arrived)
    // refreshes the existing invite instead of creating a second row that
    // would double-count against the seat cap.
    let invite = await Invite.findOne({ where: { orgId: org.id, email, status: "pending" } });
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS);
    if (invite) {
      invite.tokenHash = tokenHash;
      invite.expiresAt = expiresAt;
      await invite.save();
    } else {
      invite = await Invite.create({
        orgId: org.id,
        email,
        invitedByUserId: req.currentUser.id,
        tokenHash,
        expiresAt,
      });
    }

    await AuditLog.create({
      orgId: org.id,
      userId: req.currentUser.id,
      action: "team_invite_sent",
      actor: req.currentUser.email,
      details: { email },
    });

    const inviteUrl = `${req.protocol}://${req.get("host")}/?invite_token=${token}`;
    let emailSent = false;
    if (settings.resendApiKey) {
      const resend = new Resend(settings.resendApiKey);
      const { error } = await resend.emails.send({
        from: `Rekono <${settings.contactFromEmail}>`,
        to: email,
        subject: `You've been invited to join ${org.name} on Rekono`,
        text:
          `${req.currentUser.fullName || req.currentUser.email} invited you to join ${org.name} on Rekono.\n\n` +
          `Accept the invite here (this link expires in 7 days):\n${inviteUrl}\n\n` +
          `If you weren't expecting this, you can safely ignore this email.`,
      });
      if (error) console.error("Resend send failed (team invite):", error);
      else emailSent = true;
    } else {
      console.warn("Team invite created but RESEND_API_KEY isn't configured -- no email sent.");
    }

    // Without a configured mail sender there's no other way for the owner
    // to get the link to their teammate, so hand it back directly rather
    // than leaving the invite unreachable -- same reasoning as every other
    // Resend-gated flow in this app degrading instead of failing outright.
    res.status(201).json({ email, email_sent: emailSent, invite_url: emailSent ? undefined : inviteUrl });
  } catch (err) {
    next(err);
  }
});

router.delete("/api/team/invites/:id", requireAuth, requireActivePlan, requireOwner, async (req, res, next) => {
  try {
    const invite = await Invite.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId, status: "pending" } });
    if (!invite) return res.status(404).json({ detail: "Invite not found" });

    invite.status = "revoked";
    await invite.save();

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "team_invite_revoked",
      actor: req.currentUser.email,
      details: { email: invite.email },
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.delete(
  "/api/team/members/:userId",
  requireAuth,
  requireActivePlan,
  requireOwner,
  requireReauth,
  async (req, res, next) => {
    try {
      if (req.params.userId === req.currentUser.id) {
        return res.status(400).json({ detail: "You can't remove yourself. Transfer ownership isn't supported yet." });
      }
      const member = await User.findOne({ where: { id: req.params.userId, orgId: req.currentUser.orgId } });
      if (!member) return res.status(404).json({ detail: "Team member not found" });

      await AuditLog.create({
        orgId: req.currentUser.orgId,
        userId: req.currentUser.id,
        action: "team_member_removed",
        actor: req.currentUser.email,
        details: { removed_email: member.email },
      });

      await member.destroy();
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// ---- Public accept-invite endpoints (no auth -- the invitee doesn't have
// an account yet) ----

router.get("/api/team/invite/:token", async (req, res, next) => {
  try {
    const tokenHash = crypto.createHash("sha256").update(req.params.token).digest("hex");
    const invite = await Invite.findOne({ where: { tokenHash, status: "pending" } });
    if (!invite || invite.expiresAt < new Date()) {
      return res.status(400).json({ detail: "This invite link is invalid or has expired." });
    }
    const org = await Organization.findByPk(invite.orgId);
    res.json({ email: invite.email, org_name: org.name });
  } catch (err) {
    next(err);
  }
});

const acceptInviteSchema = z.object({
  full_name: z.string().min(1).max(256),
  password: z.string().min(8).max(256),
});

router.post("/api/team/invite/:token/accept", async (req, res, next) => {
  try {
    const parsed = acceptInviteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const tokenHash = crypto.createHash("sha256").update(req.params.token).digest("hex");
    const invite = await Invite.findOne({ where: { tokenHash, status: "pending" } });
    if (!invite || invite.expiresAt < new Date()) {
      return res.status(400).json({ detail: "This invite link is invalid or has expired." });
    }

    if (await User.findOne({ where: { email: invite.email } })) {
      invite.status = "revoked";
      await invite.save();
      return res.status(409).json({ detail: "That email already has a Rekono account. Sign in instead." });
    }

    const org = await Organization.findByPk(invite.orgId);
    const plan = PLANS[org.plan];
    const used = await seatsUsed(org.id);
    if (!hasSeatAvailable(plan?.seats ?? null, used)) {
      return res.status(402).json({ detail: "This team is now at its plan's seat limit. Ask the account owner to upgrade." });
    }

    const user = await User.create({
      orgId: invite.orgId,
      email: invite.email,
      hashedPassword: await auth.hashPassword(parsed.data.password),
      fullName: parsed.data.full_name,
      role: "member",
    });

    invite.status = "accepted";
    await invite.save();

    await AuditLog.create({
      orgId: invite.orgId,
      userId: user.id,
      action: "team_member_joined",
      actor: user.email,
      details: {},
    });

    res.status(201).json({ access_token: auth.createAccessToken(user.id), token_type: "bearer" });
  } catch (err) {
    next(err);
  }
});

export default router;
