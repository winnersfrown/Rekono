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

    // Personalization, collected once during onboarding. Free-text categories
    // rather than an enum for the same reason plan/subscriptionStatus are
    // plain strings -- adding a new option later is just a new string value,
    // not a schema migration.
    role: { type: DataTypes.STRING(128), allowNull: true },
    companySize: { type: DataTypes.STRING(64), allowNull: true },
    primaryUseCase: { type: DataTypes.STRING(256), allowNull: true },
    monthlyInvoiceVolume: { type: DataTypes.STRING(64), allowNull: true },
  },
  { tableName: "organizations", updatedAt: false, createdAt: "createdAt" }
);
