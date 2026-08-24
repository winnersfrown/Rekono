import { effectiveConfidenceThreshold, markFailedIfStuck, processTaxDocument } from "../src/taxDocPipeline.js";
import { AuditLog, TaxDocument } from "../src/models/index.js";
import { settings } from "../src/config.js";
import { buildPdf } from "../src/demoSeed.js";
import { resetDb } from "./testUtils.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ORG_ID = "11111111111111111111111111111111";

beforeEach(resetDb);

async function makeTaxDoc(overrides = {}) {
  return TaxDocument.create({
    orgId: ORG_ID,
    originalFilename: "1099.pdf",
    storagePath: "/tmp/does-not-matter.pdf",
    contentType: "application/pdf",
    status: "processing",
    ...overrides,
  });
}

test("markFailedIfStuck fails a tax document left stuck mid-pipeline", async () => {
  const doc = await makeTaxDoc();

  await markFailedIfStuck(doc.id, new Error("boom"));

  await doc.reload();
  expect(doc.status).toBe("failed");
  expect(doc.errorMessage).toContain("boom");
});

test("markFailedIfStuck leaves an already-finished tax document alone", async () => {
  const doc = await makeTaxDoc({ status: "extracted" });

  await markFailedIfStuck(doc.id, new Error("boom"));

  await doc.reload();
  expect(doc.status).toBe("extracted");
});

test("markFailedIfStuck is a no-op for a tax document that no longer exists", async () => {
  await expect(markFailedIfStuck("00000000000000000000000000000000", new Error("boom"))).resolves.not.toThrow();
});

// Tax documents reuse the same org-wide confidence threshold as the other
// four pipelines -- there's no tax-specific override.
test("effectiveConfidenceThreshold returns the server default", async () => {
  expect(await effectiveConfidenceThreshold()).toBe(settings.reviewConfidenceThreshold);
});

test("a missing source file fails cleanly with a re-upload prompt", async () => {
  const doc = await makeTaxDoc({ status: "queued", storagePath: "/tmp/definitely-not-here-12345.pdf" });

  await processTaxDocument(doc.id);

  await doc.reload();
  expect(doc.status).toBe("failed");
  expect(doc.errorMessage).toContain("re-upload");
});

test("processTaxDocument is a no-op for an id that doesn't exist", async () => {
  await expect(processTaxDocument("00000000000000000000000000000000")).resolves.not.toThrow();
});

// The one thing this pipeline does that the other four don't, and the
// reason it's worth paying for a real OCR pass in a test rather than
// stopping at the unit level: the raw OCR of a W-2 is a second, unmasked
// copy of the SSN, and it must not survive into the stored row.
test("a real W-2 runs end to end and the persisted OCR text has taxpayer IDs masked", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rekono-taxdoc-"));
  const filePath = path.join(dir, "w2.pdf");
  await fs.writeFile(
    filePath,
    buildPdf([
      "Form W-2 Wage and Tax Statement",
      "For calendar year 2024",
      "EMPLOYER'S name",
      "Brightline Systems Inc.",
      "EMPLOYEE'S SSN",
      "123-45-6789",
      "1 Wages, tips, other compensation",
      "$61,000.00",
    ])
  );

  try {
    const doc = await makeTaxDoc({ status: "queued", storagePath: filePath });
    await processTaxDocument(doc.id);
    await doc.reload();

    expect(doc.status).toBe("needs_review"); // heuristic confidence never clears the bar
    expect(doc.documentType).toBe("W-2");
    expect(doc.taxYear).toBe(2024);
    expect(doc.payerName).toBe("Brightline Systems Inc.");
    expect(doc.amount).toBe(61000);
    expect(doc.recipientTinLast4).toBe("6789");

    expect(doc.rawOcrText).toContain("Wages"); // OCR really did read the page
    expect(doc.rawOcrText).not.toContain("123-45-6789");
    expect(doc.rawOcrText).toContain("***-**-6789");

    const entries = await AuditLog.findAll({ where: { taxDocumentId: doc.id } });
    expect(entries.map((e) => e.action)).toContain("extraction_completed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 60_000);
