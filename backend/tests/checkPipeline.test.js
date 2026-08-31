import { effectiveConfidenceThreshold, markFailedIfStuck, processCheck } from "../src/checkPipeline.js";
import { AuditLog, Check } from "../src/models/index.js";
import { settings } from "../src/config.js";
import { resetDb } from "./testUtils.js";

const ORG_ID = "11111111111111111111111111111111";

beforeEach(resetDb);

async function makeCheck(overrides = {}) {
  return Check.create({
    orgId: ORG_ID,
    originalFilename: "check.jpg",
    storagePath: "/tmp/does-not-matter.jpg",
    contentType: "image/jpeg",
    status: "processing",
    ...overrides,
  });
}

test("markFailedIfStuck fails a check left stuck mid-pipeline", async () => {
  const check = await makeCheck();

  await markFailedIfStuck(check.id, new Error("boom"));

  await check.reload();
  expect(check.status).toBe("failed");
  expect(check.errorMessage).toContain("boom");
});

test("markFailedIfStuck leaves an already-finished check alone", async () => {
  const check = await makeCheck({ status: "extracted" });

  await markFailedIfStuck(check.id, new Error("boom"));

  await check.reload();
  expect(check.status).toBe("extracted");
});

// Approved means the check has been applied to a bill and its payment has
// posted. A stuck-job sweep must never walk that back to "failed".
test("markFailedIfStuck leaves a linked check alone", async () => {
  const check = await makeCheck({ status: "approved" });

  await markFailedIfStuck(check.id, new Error("boom"));

  await check.reload();
  expect(check.status).toBe("approved");
});

test("markFailedIfStuck is a no-op for a check that no longer exists", async () => {
  await expect(markFailedIfStuck("00000000000000000000000000000000", new Error("boom"))).resolves.not.toThrow();
});

// Checks reuse the same org-wide confidence threshold as the other five
// pipelines -- there's no check-specific override.
test("effectiveConfidenceThreshold returns the server default", async () => {
  expect(await effectiveConfidenceThreshold()).toBe(settings.reviewConfidenceThreshold);
});

test("processCheck is a no-op for a check that no longer exists", async () => {
  await expect(processCheck("00000000000000000000000000000000")).resolves.not.toThrow();
});

// A source file lost to an ephemeral filesystem restart is the one OCR
// failure the user can actually act on, so it gets its own message telling
// them to re-upload rather than implying the file was bad.
test("a missing source file fails with a re-upload prompt and an audit entry", async () => {
  const check = await makeCheck({ status: "queued", storagePath: "/tmp/definitely-not-here-98765.jpg" });

  await processCheck(check.id);

  await check.reload();
  expect(check.status).toBe("failed");
  expect(check.errorMessage).toMatch(/no longer available/i);

  const entries = await AuditLog.findAll({ where: { checkId: check.id } });
  expect(entries.map((e) => e.action)).toContain("extraction_failed");
});
