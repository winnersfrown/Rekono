import { markFailedIfStuck } from "../src/pipeline.js";
import { Invoice } from "../src/models/index.js";
import { resetDb } from "./testUtils.js";

beforeEach(resetDb);

async function makeInvoice(overrides = {}) {
  return Invoice.create({
    orgId: "11111111-1111-1111-1111-111111111111",
    originalFilename: "test.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "processing",
    ...overrides,
  });
}

test("markFailedIfStuck fails an invoice left stuck mid-pipeline", async () => {
  const invoice = await makeInvoice();

  await markFailedIfStuck(invoice.id, new Error("boom"));

  await invoice.reload();
  expect(invoice.status).toBe("failed");
  expect(invoice.errorMessage).toContain("boom");
});

test("markFailedIfStuck leaves an already-finished invoice alone", async () => {
  const invoice = await makeInvoice({ status: "extracted" });

  await markFailedIfStuck(invoice.id, new Error("boom"));

  await invoice.reload();
  expect(invoice.status).toBe("extracted");
});

test("markFailedIfStuck is a no-op for an invoice that no longer exists", async () => {
  await expect(markFailedIfStuck("00000000-0000-0000-0000-000000000000", new Error("boom"))).resolves.not.toThrow();
});
