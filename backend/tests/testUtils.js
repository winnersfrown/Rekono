import { sequelize } from "../src/db.js";

export async function resetDb() {
  await sequelize.sync({ force: true });
}

// Completes onboarding onto the free plan by default (skipOnboarding: true
// opts out) -- almost every existing test just wants a normal working
// account and predates onboarding/plan gating entirely, so defaulting to
// "already onboarded" keeps them all passing without touching each one.
// Tests that specifically exercise the onboarding-required or plan-gating
// behavior itself pass skipOnboarding: true and drive /api/onboarding (or
// deliberately don't) themselves.
export async function signup(
  app,
  request,
  { email = "owner@example.co", orgName = "Test Org", password = "correcthorse123", skipOnboarding = false } = {}
) {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ org_name: orgName, full_name: "Test Owner", email, password });
  if (res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const token = res.body.access_token;

  if (!skipOnboarding) {
    const onboardingRes = await request(app)
      .post("/api/onboarding")
      .set(authHeader(token))
      .send({
        role: "finance_accounting",
        company_size: "just_me",
        primary_use_case: "data_entry",
        monthly_invoice_volume: "under_25",
        plan: "free",
      });
    if (onboardingRes.status !== 200) {
      throw new Error(`onboarding failed: ${onboardingRes.status} ${JSON.stringify(onboardingRes.body)}`);
    }
  }

  return token;
}

export function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}
