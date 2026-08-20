import {
  effectiveConfidenceThreshold,
  findDuplicateInvoice,
  markFailedIfStuck,
  shouldAutoApprove,
  shouldSampleForQa,
} from "../src/pipeline.js";
import { Invoice, Organization } from "../src/models/index.js";
import { settings } from "../src/config.js";
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

test("findDuplicateInvoice ignores a soft-deleted invoice, same as a rejected one", async () => {
  const original = await makeInvoice({
    status: "extracted",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1001",
  });
  await original.destroy(); // Invoice is paranoid -- this is a soft delete

  const incoming = await makeInvoice({
    status: "processing",
    vendorName: "Acme Supplies Inc",
    invoiceNumber: "INV-1001",
  });

  expect(await findDuplicateInvoice(incoming)).toBeNull();
});

test("effectiveConfidenceThreshold uses the server default when no org override is set", async () => {
  const org = await Organization.create({ id: ORG_ID, name: "Org", plan: "business" });
  expect(await effectiveConfidenceThreshold(org.id)).toBe(settings.reviewConfidenceThreshold);
});

test("effectiveConfidenceThreshold uses the org override on a plan with the feature", async () => {
  const org = await Organization.create({ id: ORG_ID, name: "Org", plan: "business", confidenceThreshold: 0.6 });
  expect(await effectiveConfidenceThreshold(org.id)).toBe(0.6);
});

test("effectiveConfidenceThreshold ignores a stale override after downgrading off Business/Scale", async () => {
  const org = await Organization.create({ id: ORG_ID, name: "Org", plan: "starter", confidenceThreshold: 0.6 });
  expect(await effectiveConfidenceThreshold(org.id)).toBe(settings.reviewConfidenceThreshold);
});

test("effectiveConfidenceThreshold falls back to the default for a nonexistent org", async () => {
  expect(await effectiveConfidenceThreshold("does-not-exist")).toBe(settings.reviewConfidenceThreshold);
});

async function makeAutoApprovalOrg(overrides = {}) {
  return Organization.create({
    id: ORG_ID,
    name: "Org",
    plan: "business",
    autoApprovalEnabled: true,
    autoApprovalMaxAmount: 500,
    ...overrides,
  });
}

test("shouldAutoApprove returns false for an unknown vendor, regardless of everything else", async () => {
  await makeAutoApprovalOrg();
  const invoice = await makeInvoice({ total: 100 });
  expect(await shouldAutoApprove(invoice, false)).toBe(false);
});

test("shouldAutoApprove returns false when the invoice has no total", async () => {
  await makeAutoApprovalOrg();
  const invoice = await makeInvoice({ total: null });
  expect(await shouldAutoApprove(invoice, true)).toBe(false);
});

test("shouldAutoApprove returns false when the org hasn't opted in", async () => {
  await makeAutoApprovalOrg({ autoApprovalEnabled: false });
  const invoice = await makeInvoice({ total: 100 });
  expect(await shouldAutoApprove(invoice, true)).toBe(false);
});

test("shouldAutoApprove returns false when no ceiling is configured, even if enabled", async () => {
  await makeAutoApprovalOrg({ autoApprovalMaxAmount: null });
  const invoice = await makeInvoice({ total: 100 });
  expect(await shouldAutoApprove(invoice, true)).toBe(false);
});

test("shouldAutoApprove returns false on a plan without the feature", async () => {
  await makeAutoApprovalOrg({ plan: "free" });
  const invoice = await makeInvoice({ total: 100 });
  expect(await shouldAutoApprove(invoice, true)).toBe(false);
});

test("shouldAutoApprove returns false when the total exceeds the configured ceiling", async () => {
  await makeAutoApprovalOrg({ autoApprovalMaxAmount: 500 });
  const invoice = await makeInvoice({ total: 500.01 });
  expect(await shouldAutoApprove(invoice, true)).toBe(false);
});

test("shouldAutoApprove returns true at exactly the ceiling, with every other condition met", async () => {
  await makeAutoApprovalOrg({ autoApprovalMaxAmount: 500 });
  const invoice = await makeInvoice({ total: 500 });
  expect(await shouldAutoApprove(invoice, true)).toBe(true);
});

test("shouldAutoApprove returns true well under the ceiling, with every other condition met", async () => {
  await makeAutoApprovalOrg({ plan: "scale", autoApprovalMaxAmount: 1000 });
  const invoice = await makeInvoice({ total: 12.5 });
  expect(await shouldAutoApprove(invoice, true)).toBe(true);
});

test("shouldAutoApprove returns false for an invoice belonging to a nonexistent org", async () => {
  const invoice = await makeInvoice({ total: 100, orgId: "does-not-exist" });
  expect(await shouldAutoApprove(invoice, true)).toBe(false);
});

test("shouldSampleForQa returns false when the org hasn't opted in", () => {
  const org = { sampleReviewEnabled: false, sampleReviewRate: 0.5 };
  expect(shouldSampleForQa(org, { random: () => 0 })).toBe(false);
});

test("shouldSampleForQa returns false when no rate is configured, even if enabled", () => {
  const org = { sampleReviewEnabled: true, sampleReviewRate: null };
  expect(shouldSampleForQa(org, { random: () => 0 })).toBe(false);
});

test("shouldSampleForQa returns false for a nonexistent org", () => {
  expect(shouldSampleForQa(null, { random: () => 0 })).toBe(false);
});

test("shouldSampleForQa returns true when the roll lands under the configured rate", () => {
  const org = { sampleReviewEnabled: true, sampleReviewRate: 0.1 };
  expect(shouldSampleForQa(org, { random: () => 0.05 })).toBe(true);
});

test("shouldSampleForQa returns false when the roll lands at or above the configured rate", () => {
  const org = { sampleReviewEnabled: true, sampleReviewRate: 0.1 };
  expect(shouldSampleForQa(org, { random: () => 0.1 })).toBe(false);
  expect(shouldSampleForQa(org, { random: () => 0.5 })).toBe(false);
});

test("shouldSampleForQa uses real randomness by default", () => {
  const org = { sampleReviewEnabled: true, sampleReviewRate: 1 }; // 100% -- always true regardless of the real roll
  expect(shouldSampleForQa(org)).toBe(true);
});
