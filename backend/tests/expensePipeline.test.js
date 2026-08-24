import { effectiveConfidenceThreshold, markFailedIfStuck } from "../src/expensePipeline.js";
import { ExpenseReceipt } from "../src/models/index.js";
import { settings } from "../src/config.js";
import { resetDb } from "./testUtils.js";

const ORG_ID = "11111111111111111111111111111111";

beforeEach(resetDb);

async function makeReceipt(overrides = {}) {
  return ExpenseReceipt.create({
    orgId: ORG_ID,
    originalFilename: "receipt.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "processing",
    ...overrides,
  });
}

test("markFailedIfStuck fails a receipt left stuck mid-pipeline", async () => {
  const receipt = await makeReceipt();

  await markFailedIfStuck(receipt.id, new Error("boom"));

  await receipt.reload();
  expect(receipt.status).toBe("failed");
  expect(receipt.errorMessage).toContain("boom");
});

test("markFailedIfStuck leaves an already-finished receipt alone", async () => {
  const receipt = await makeReceipt({ status: "extracted" });

  await markFailedIfStuck(receipt.id, new Error("boom"));

  await receipt.reload();
  expect(receipt.status).toBe("extracted");
});

test("markFailedIfStuck is a no-op for a receipt that no longer exists", async () => {
  await expect(markFailedIfStuck("00000000000000000000000000000000", new Error("boom"))).resolves.not.toThrow();
});

// Receipts reuse the same org-wide confidence threshold as invoices --
// there's no receipt-specific override (see expensePipeline.js's comment).
test("effectiveConfidenceThreshold returns the server default", async () => {
  expect(await effectiveConfidenceThreshold()).toBe(settings.reviewConfidenceThreshold);
});
