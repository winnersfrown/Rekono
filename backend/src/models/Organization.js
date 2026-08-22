import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { newId } from "./idDefault.js";
import * as secretBox from "../secretBox.js";

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

    // Business/Scale-only (see plans.js's riskBasedAutoApproval): when an
    // invoice would already have been fast-tracked as `extracted` (passes
    // the confidence bar, cross-check, not a duplicate/possible-multi), skip
    // the manual "click Approve" step too if it's also low business risk --
    // see pipeline.js's shouldAutoApprove. Off (null/false) by default on
    // every org, even ones on a qualifying plan: this changes real money
    // moving without a human looking at it, so it's opt-in, never a silent
    // default. autoApprovalMaxAmount is the dollar ceiling; enabling without
    // one set is rejected by routes/settings.js.
    autoApprovalEnabled: { type: DataTypes.BOOLEAN, allowNull: true },
    autoApprovalMaxAmount: { type: DataTypes.FLOAT, allowNull: true },

    // Statistical spot-checking of auto-approved invoices (see pipeline.js's
    // processInvoice) -- same Business/Scale gate and off-by-default,
    // opt-in-per-org shape as autoApprovalEnabled above, and only means
    // anything alongside it: an org with auto-approval off never generates
    // anything to sample. sampleReviewRate is a fraction (0.05 = 5%) of
    // auto-approved invoices randomly flagged for a human to spot-check
    // after the fact (Invoice.sampledForQa) -- never a gate on approval
    // itself, since the point is catching drift without slowing anything
    // down.
    sampleReviewEnabled: { type: DataTypes.BOOLEAN, allowNull: true },
    sampleReviewRate: { type: DataTypes.FLOAT, allowNull: true },

    // QuickBooks Online (Phase 1: sandbox OAuth connect + manual one-way
    // bill push -- see quickbooks.js and routes/integrations.js). realmId
    // is Intuit's company-file identifier, returned alongside the OAuth
    // code and required on every subsequent Accounting API call. Tokens are
    // stored server-side (never returned to the frontend, same as
    // stripeCustomerId etc.) -- refreshToken is the long-lived one (100
    // days, itself refreshed on use); accessToken is short-lived (1 hour).
    // All nullable with no default: a disconnected org simply has all of
    // these null, and "connected" is defined as realmId !== null.
    quickbooksRealmId: { type: DataTypes.STRING(64), allowNull: true },
    // Encrypted at rest (secretBox.js) -- transparent to every other read/
    // write in the app (quickbooks.js, routes/integrations.js), which all
    // go through `org.quickbooksAccessToken`/`org.quickbooksRefreshToken`
    // directly, never a raw query. A database compromise alone shouldn't
    // also hand over a live credential into a customer's real QuickBooks
    // company file.
    quickbooksAccessToken: {
      type: DataTypes.TEXT,
      allowNull: true,
      get() {
        return secretBox.decrypt(this.getDataValue("quickbooksAccessToken"));
      },
      set(value) {
        this.setDataValue("quickbooksAccessToken", secretBox.encrypt(value));
      },
    },
    quickbooksRefreshToken: {
      type: DataTypes.TEXT,
      allowNull: true,
      get() {
        return secretBox.decrypt(this.getDataValue("quickbooksRefreshToken"));
      },
      set(value) {
        this.setDataValue("quickbooksRefreshToken", secretBox.encrypt(value));
      },
    },
    quickbooksAccessTokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
    quickbooksRefreshTokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
    // Expense account an org picks (from GET /api/integrations/quickbooks/accounts)
    // as the default line-item account on every Bill pushed to QuickBooks.
    // Name is denormalized alongside the id purely for display, same
    // reasoning as Invoice's duplicateOfFilename.
    quickbooksDefaultExpenseAccountId: { type: DataTypes.STRING(64), allowNull: true },
    quickbooksDefaultExpenseAccountName: { type: DataTypes.STRING(256), allowNull: true },

    // Set on every org created by POST /api/demo/login (routes/demo.js) --
    // a public, no-signup sandbox pre-loaded with realistic sample data
    // (demoSeed.js) so an investor/prospect can click straight into a
    // working instance. Surfaced to the frontend as is_demo (buildMeResponse
    // in routes/auth.js) so the app shell can show a persistent "you're in
    // a demo" banner. Never set on a real signup; false/null-compatible
    // default like every other boolean flag on this model.
    isDemo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { tableName: "organizations", updatedAt: false, createdAt: "createdAt" }
);
