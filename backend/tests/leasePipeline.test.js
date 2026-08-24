import { effectiveConfidenceThreshold, markFailedIfStuck } from "../src/leasePipeline.js";
import { Lease } from "../src/models/index.js";
import { settings } from "../src/config.js";
import { resetDb } from "./testUtils.js";

const ORG_ID = "11111111111111111111111111111111";

beforeEach(resetDb);

async function makeLease(overrides = {}) {
  return Lease.create({
    orgId: ORG_ID,
    originalFilename: "lease.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "processing",
    ...overrides,
  });
}

test("markFailedIfStuck fails a lease left stuck mid-pipeline", async () => {
  const lease = await makeLease();

  await markFailedIfStuck(lease.id, new Error("boom"));

  await lease.reload();
  expect(lease.status).toBe("failed");
  expect(lease.errorMessage).toContain("boom");
});

test("markFailedIfStuck leaves an already-finished lease alone", async () => {
  const lease = await makeLease({ status: "extracted" });

  await markFailedIfStuck(lease.id, new Error("boom"));

  await lease.reload();
  expect(lease.status).toBe("extracted");
});

test("markFailedIfStuck is a no-op for a lease that no longer exists", async () => {
  await expect(markFailedIfStuck("00000000000000000000000000000000", new Error("boom"))).resolves.not.toThrow();
});

// Leases reuse the same org-wide confidence threshold as invoices/receipts/
// vendor documents -- there's no lease-specific override.
test("effectiveConfidenceThreshold returns the server default", async () => {
  expect(await effectiveConfidenceThreshold()).toBe(settings.reviewConfidenceThreshold);
});
