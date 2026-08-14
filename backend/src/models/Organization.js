import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";

export const Organization = sequelize.define(
  "Organization",
  {
    id: { type: DataTypes.STRING(32), primaryKey: true, defaultValue: newId },
    name: { type: DataTypes.STRING(256), allowNull: false },

    // null until onboarding (personalization + plan choice) is completed --
    // requireActivePlan (plan.js) treats a null plan as "onboarding not
    // finished yet" and blocks every data route until it is. All nullable
    // with no default, same reasoning as every column added after this
    // session's schema-drift incidents: additive-only sync can only backfill
    // safely when there's nothing to invent a value for on existing rows.
    plan: { type: DataTypes.STRING(32), allowNull: true },
    billingPeriod: { type: DataTypes.STRING(16), allowNull: true }, // "monthly" | "annual", paid plans only
    onboardingCompletedAt: { type: DataTypes.DATE, allowNull: true },

    // Stripe. subscriptionStatus mirrors Stripe's own subscription.status
    // values (active, past_due, canceled, ...) rather than a boolean, so a
    // lapsed/canceled subscription can be distinguished from one that was
    // never started, and the plan choice itself is preserved either way.
    stripeCustomerId: { type: DataTypes.STRING(128), allowNull: true },
    stripeSubscriptionId: { type: DataTypes.STRING(128), allowNull: true },
    subscriptionStatus: { type: DataTypes.STRING(32), allowNull: true },
    // Set from Stripe's subscription.trial_end when a paid plan is chosen
    // during onboarding (see onboarding.js) -- null for plans with no trial
    // (the Free plan, or a plan bought later via the Upgrade modal, which
    // bills immediately). Purely informational for the UI; requireActivePlan
    // gates on subscriptionStatus, not this.
    trialEndsAt: { type: DataTypes.DATE, allowNull: true },

    // Personalization, collected once during onboarding. Free-text categories
    // rather than an enum for the same reason plan/subscriptionStatus are
    // plain strings -- adding a new option later is just a new string value,
    // not a schema migration.
    role: { type: DataTypes.STRING(128), allowNull: true },
    companySize: { type: DataTypes.STRING(64), allowNull: true },
    primaryUseCase: { type: DataTypes.STRING(256), allowNull: true },
    monthlyInvoiceVolume: { type: DataTypes.STRING(64), allowNull: true },

    // Business/Scale-only override for the review-queue confidence bar
    // (see plans.js's customConfidenceThreshold) -- null means "use the
    // server-wide REVIEW_CONFIDENCE_THRESHOLD default" (see pipeline.js's
    // effectiveConfidenceThreshold). Nullable with no default so plans
    // without the feature, and orgs that never touch it, are unaffected.
    confidenceThreshold: { type: DataTypes.FLOAT, allowNull: true },
  },
  { tableName: "organizations", updatedAt: false, createdAt: "createdAt" }
);
