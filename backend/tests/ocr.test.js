import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractText, OcrError } from "../src/ocr.js";

test("extractText throws OcrError for a missing file", async () => {
  await expect(extractText("/tmp/does-not-exist-at-all.png", "image/png")).rejects.toThrow(OcrError);
});

test("extractText wraps a tesseract failure on a bad image as OcrError, not a raw exec error", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rekono-ocr-test-"));
  const badImage = path.join(tmpDir, "bad.png");
  await fs.writeFile(badImage, "not actually a png");
  try {
    await expect(extractText(badImage, "image/png")).rejects.toThrow(OcrError);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
