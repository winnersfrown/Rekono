import { findDuplicateInvoice, markFailedIfStuck } from "../src/pipeline.js";
import { Invoice } from "../src/models/index.js";
import { resetDb } from "./testUtils.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(resetDb);

async function makeInvoice(overrides = {}) {
  return Invoice.create({
    orgId: ORG_ID,
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

test("findDuplicateInvoice matches same vendor + invoice number, ignoring case and whitespace", async () => {
  const original = await makeInvoice({
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1001",
  });
  const incoming = await makeInvoice({
    status: "processing",
    vendorName: "  acme supplies inc  ",
    invoiceNumber: "inv-1001",
  });

  const duplicate = await findDuplicateInvoice(incoming);

  expect(duplicate?.id).toBe(original.id);
});

test("findDuplicateInvoice returns null when vendor or invoice number is blank", async () => {
  await makeInvoice({ status: "extracted", vendorName: "", invoiceNumber: "INV-1001" });
  const incoming = await makeInvoice({ status: "processing", vendorName: "", invoiceNumber: "INV-1001" });

  expect(await findDuplicateInvoice(incoming)).toBeNull();
});

test("findDuplicateInvoice ignores a rejected invoice", async () => {
  await makeInvoice({
    status: "rejected",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1001",
  });
  const incoming = await makeInvoice({
    status: "processing",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1001",
  });

  expect(await findDuplicateInvoice(incoming)).toBeNull();
});

test("findDuplicateInvoice never matches across organizations", async () => {
  await makeInvoice({
    orgId: "22222222-2222-2222-2222-222222222222",
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1001",
  });
  const incoming = await makeInvoice({
    status: "processing",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1001",
  });

  expect(await findDuplicateInvoice(incoming)).toBeNull();
});
