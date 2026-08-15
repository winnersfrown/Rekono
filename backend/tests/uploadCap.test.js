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

// GET /api/auth/me's documents_used_this_month/document_cap fields are what
// the dashboard sidebar's usage bar reads -- backed by the same
// documentUsage.js helper ingestion.js enforces against, so these can never
// disagree with what actually blocks an upload.
describe("GET /api/auth/me document usage", () => {
  test("is null before onboarding -- no plan means no cap to measure against", async () => {
    const token = await signup(app, request, { email: "noplan@uploadco.co", skipOnboarding: true });
    const res = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(res.body.documents_used_this_month).toBeNull();
    expect(res.body.document_cap).toBeNull();
  });

  test("reflects the free plan's cap and a zero count for a fresh org", async () => {
    const token = await signup(app, request, { email: "freshfree@uploadco.co" }); // defaults to free
    const res = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(res.body.documents_used_this_month).toBe(0);
    expect(res.body.document_cap).toBe(25);
  });

  test("counts existing invoices from this calendar month", async () => {
    const token = await signup(app, request, { email: "someused@uploadco.co" });
    const org = await orgId(token);
    await seedInvoices(org, 10);

    const res = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(res.body.documents_used_this_month).toBe(10);
    expect(res.body.document_cap).toBe(25);
  });

  test("increments after a real upload", async () => {
    const token = await signup(app, request, { email: "liveupload@uploadco.co" });
    await attachFakePdf(request(app).post("/api/invoices/upload").set(authHeader(token)));

    const res = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(res.body.documents_used_this_month).toBe(1);
  });

  // Deleting a document doesn't refund the OCR/LLM cost that was already
  // spent processing it -- if it did, "upload, delete, re-upload" would be a
  // free way around the plan's monthly cap. See documentUsage.js.
  test("deleting an invoice does not free up cap headroom", async () => {
    const token = await signup(app, request, { email: "deletecap@uploadco.co" });
    const org = await orgId(token);
    await seedInvoices(org, 25); // fills the free plan's cap exactly

    const listRes = await request(app).get("/api/invoices").set(authHeader(token));
    const deleteRes = await request(app).delete(`/api/invoices/${listRes.body[0].id}`).set(authHeader(token));
    expect(deleteRes.status).toBe(200);

    const meRes = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(meRes.body.documents_used_this_month).toBe(25); // unchanged, still at the cap

    const uploadRes = await attachFakePdf(request(app).post("/api/invoices/upload").set(authHeader(token)));
    expect(uploadRes.status).toBe(402);
    expect(uploadRes.body.plan_cap_reached).toBe(true);
  });
});
