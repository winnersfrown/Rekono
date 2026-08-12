import request from "supertest";
import { app } from "../src/app.js";
import { Invoice } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

async function seedInvoices(org_id, count) {
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      Invoice.create({
        orgId: org_id,
        originalFilename: `seed-${i}.pdf`,
        storagePath: "/tmp/does-not-matter.pdf",
        contentType: "application/pdf",
        status: "extracted",
      })
    )
  );
}

function attachFakePdf(req) {
  return req.attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "invoice.pdf", contentType: "application/pdf" });
}

test("free plan blocks uploads once the monthly document cap is reached", async () => {
  const token = await signup(app, request, { email: "capped@uploadco.co" }); // defaults to free (25 docs/mo)
  const org = await orgId(token);
  await seedInvoices(org, 25);

  const res = await attachFakePdf(request(app).post("/api/invoices/upload").set(authHeader(token)));
  expect(res.status).toBe(402);
  expect(res.body.plan_cap_reached).toBe(true);
});

test("upload succeeds when under the cap", async () => {
  const token = await signup(app, request, { email: "undercap@uploadco.co" });
  const org = await orgId(token);
  await seedInvoices(org, 24); // one below the free plan's 25/mo cap

  const res = await attachFakePdf(request(app).post("/api/invoices/upload").set(authHeader(token)));
  expect(res.status).toBe(201);
});

test("the cap only counts uploads from the current calendar month", async () => {
  const token = await signup(app, request, { email: "lastmonth@uploadco.co" });
  const org = await orgId(token);
  await seedInvoices(org, 25);

  // Backdate this org's invoices well outside the current month -- same
  // raw-SQL approach used elsewhere in this suite (trial/orgId backdating),
  // since Sequelize silently ignores direct writes to timestamp-managed
  // columns.
  const { sequelize } = await import("../src/db.js");
  await sequelize.query("UPDATE invoices SET createdAt = datetime('now', '-2 months') WHERE orgId = :orgId", {
    replacements: { orgId: org },
  });

  const res = await attachFakePdf(request(app).post("/api/invoices/upload").set(authHeader(token)));
  expect(res.status).toBe(201);
});

test("a paid plan's higher cap is enforced instead of free's", async () => {
  const token = await signup(app, request, { email: "growthcap@uploadco.co", skipOnboarding: true });
  const { Organization } = await import("../src/models/index.js");
  const org = await Organization.findOne();
  org.plan = "growth"; // 750/mo, not free's 25/mo
  org.billingPeriod = "monthly";
  org.subscriptionStatus = "active";
  await org.save();

  await seedInvoices(org.id, 25); // would already be at the free cap, but this org isn't on free

  const res = await attachFakePdf(request(app).post("/api/invoices/upload").set(authHeader(token)));
  expect(res.status).toBe(201);
});
