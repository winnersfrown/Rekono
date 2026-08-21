import { ExpenseReceipt, Invoice } from "../src/models/index.js";
import { recoverOrphanedJobs, queueDepth } from "../src/jobs.js";
import { resetDb } from "./testUtils.js";

beforeEach(resetDb);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQueueToDrain() {
  for (let i = 0; i < 100 && queueDepth() > 0; i++) {
    await sleep(20);
  }
  // The last item's processInvoice() may still be a tick away from saving.
  await sleep(50);
}

test("recoverOrphanedJobs re-enqueues invoices left mid-pipeline and fails them cleanly when the source file is gone", async () => {
  const invoice = await Invoice.create({
    orgId: "11111111-1111-1111-1111-111111111111",
    originalFilename: "test.pdf",
    storagePath: "/tmp/rekono-test-file-that-does-not-exist.pdf",
    contentType: "application/pdf",
    status: "processing",
  });

  const recoveredCount = await recoverOrphanedJobs();
  expect(recoveredCount).toBe(1);

  await waitForQueueToDrain();
  await invoice.reload();
  expect(invoice.status).toBe("failed");
  expect(invoice.errorMessage).toMatch(/no longer available/i);
});

test("recoverOrphanedJobs picks up queued invoices too", async () => {
  await Invoice.create({
    orgId: "11111111-1111-1111-1111-111111111111",
    originalFilename: "test.pdf",
    storagePath: "/tmp/rekono-test-file-that-does-not-exist-2.pdf",
    contentType: "application/pdf",
    status: "queued",
  });

  const recoveredCount = await recoverOrphanedJobs();
  expect(recoveredCount).toBe(1);
  await waitForQueueToDrain();
});

test("recoverOrphanedJobs leaves already-finished invoices alone", async () => {
  await Invoice.create({
    orgId: "11111111-1111-1111-1111-111111111111",
    originalFilename: "test.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "extracted",
  });

  const recoveredCount = await recoverOrphanedJobs();
  expect(recoveredCount).toBe(0);
});

test("recoverOrphanedJobs also re-enqueues expense receipts left mid-pipeline", async () => {
  const receipt = await ExpenseReceipt.create({
    orgId: "11111111-1111-1111-1111-111111111111",
    originalFilename: "receipt.pdf",
    storagePath: "/tmp/rekono-test-receipt-that-does-not-exist.pdf",
    contentType: "application/pdf",
    status: "processing",
  });

  const recoveredCount = await recoverOrphanedJobs();
  expect(recoveredCount).toBe(1);

  await waitForQueueToDrain();
  await receipt.reload();
  expect(receipt.status).toBe("failed");
  expect(receipt.errorMessage).toMatch(/no longer available/i);
});

test("recoverOrphanedJobs counts invoices and receipts together in one recovered total", async () => {
  await Invoice.create({
    orgId: "11111111-1111-1111-1111-111111111111",
    originalFilename: "test.pdf",
    storagePath: "/tmp/rekono-test-file-that-does-not-exist-3.pdf",
    contentType: "application/pdf",
    status: "queued",
  });
  await ExpenseReceipt.create({
    orgId: "11111111-1111-1111-1111-111111111111",
    originalFilename: "receipt.pdf",
    storagePath: "/tmp/rekono-test-receipt-that-does-not-exist-2.pdf",
    contentType: "application/pdf",
    status: "queued",
  });

  const recoveredCount = await recoverOrphanedJobs();
  expect(recoveredCount).toBe(2);
  await waitForQueueToDrain();
});
