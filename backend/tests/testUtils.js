import { sequelize } from "../src/db.js";
import { whenIdle } from "../src/jobs.js";
import { RLS_TABLES, applyRlsPolicies, installCls } from "../src/rls.js";

// Note for the Postgres run (REKONO_TEST_PG_URL): tests seed fixtures by
// calling the models directly, outside any request, which under row-level
// security is exactly the unscoped access the policies exist to refuse.
// The test databases are therefore provisioned with `rekono.system = 'on'`
// as a database-level default so the harness can write freely -- see
// scripts/setup-test-postgres.sh.
//
// That doesn't weaken what the Postgres run proves. The default belongs to
// those throwaway databases (a real one never has it, and so stays
// fail-closed), and inside a request the app issues SET LOCAL, which
// overrides the default for that transaction and pins it to a single org.
// Every request path under test still runs genuinely org-scoped, so a route
// that leaks across tenants still fails here.
let postgresSchemaReady = false;

export async function resetDb() {
  installCls();

  // On Postgres, rebuilding the schema per test is the wrong tool: sync's
  // force:true drops every table (taking its policies with it), so the 60+
  // DDL statements that put row-level security back would run before every
  // single test -- slow enough on its own to start pushing tests past their
  // timeouts. Truncating instead clears the data just as completely, leaves
  // the policies in place, and is a single statement.
  if (sequelize.getDialect() === "postgres" && postgresSchemaReady) {
    // A previous test's upload may still be draining through the job queue
    // (enqueue returns immediately, by design). Its transaction holds row
    // locks that TRUNCATE's ACCESS EXCLUSIVE lock deadlocks against, so let
    // the queue settle first -- and retry, because a job can be queued in
    // the gap between the queue going idle and the TRUNCATE acquiring its
    // locks. 40P01 is Postgres picking this process as the deadlock victim,
    // which is transient by definition.
    for (let attempt = 0; ; attempt += 1) {
      await whenIdle();
      try {
        await sequelize.query(`TRUNCATE TABLE ${RLS_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
        return;
      } catch (err) {
        const code = err?.parent?.code || err?.original?.code;
        if (code !== "40P01" || attempt >= 4) throw err;
      }
    }
  }

  await sequelize.sync({ force: true });
  await applyRlsPolicies();
  postgresSchemaReady = sequelize.getDialect() === "postgres";
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
