import { effectiveConfidenceThreshold, markFailedIfStuck } from "../src/vendorDocPipeline.js";
import { VendorDocument } from "../src/models/index.js";
import { settings } from "../src/config.js";
import { resetDb } from "./testUtils.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(resetDb);

async function makeDocument(overrides = {}) {
  return VendorDocument.create({
    orgId: ORG_ID,
    originalFilename: "coi.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "processing",
    ...overrides,
  });
}

test("markFailedIfStuck fails a document left stuck mid-pipeline", async () => {
  const doc = await makeDocument();

  await markFailedIfStuck(doc.id, new Error("boom"));

  await doc.reload();
  expect(doc.status).toBe("failed");
  expect(doc.errorMessage).toContain("boom");
});

test("markFailedIfStuck leaves an already-finished document alone", async () => {
  const doc = await makeDocument({ status: "extracted" });

  await markFailedIfStuck(doc.id, new Error("boom"));

  await doc.reload();
  expect(doc.status).toBe("extracted");
});

test("markFailedIfStuck is a no-op for a document that no longer exists", async () => {
  await expect(markFailedIfStuck("00000000-0000-0000-0000-000000000000", new Error("boom"))).resolves.not.toThrow();
});

// Vendor documents reuse the same org-wide confidence threshold as
// invoices/receipts -- there's no vendor-document-specific override.
test("effectiveConfidenceThreshold returns the server default", async () => {
  expect(await effectiveConfidenceThreshold()).toBe(settings.reviewConfidenceThreshold);
});
