// OCR extraction: turns a stored PDF/image into raw text.
//
// Shells out to the same system binaries the Python backend used
// (tesseract, poppler's pdftoppm) rather than a WASM OCR library, so
// behavior/accuracy stays identical and the Docker image doesn't need to
// change. Swapping in a cloud OCR API for higher accuracy on messy scans
// is a drop-in replacement behind `extractText`.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { downloadToLocalFile, isS3Path } from "./storage.js";

const execFileAsync = promisify(execFile);

// Neither `tesseract` nor `pdftoppm` is expected to take more than a few
// seconds per page on a normal invoice -- these bounds exist purely so a
// wedged/hung subprocess (a malformed PDF, an exotic codec) fails loudly
// within a bounded time instead of leaving the invoice stuck in
// "processing" forever with nothing watching it.
const TESSERACT_TIMEOUT_MS = 60_000;
const PDFTOPPM_TIMEOUT_MS = 60_000;

export class OcrError extends Error {}

export async function extractText(storagePath, contentType) {
  // pdftoppm/tesseract both shell out against a real path on disk -- there's
  // no way to point either at an S3 object directly, so an S3-backed
  // document is downloaded to a throwaway temp file first (removed after,
  // success or failure) and this function recurses onto that local copy.
  if (isS3Path(storagePath)) return extractTextFromS3(storagePath, contentType);

  try {
    await fs.access(storagePath);
  } catch {
    throw new OcrError(`File not found: ${storagePath}`);
  }

  const isPdf = contentType === "application/pdf" || path.extname(storagePath).toLowerCase() === ".pdf";
  return isPdf ? extractFromPdf(storagePath) : extractFromImage(storagePath);
}

async function extractTextFromS3(storagePath, contentType) {
  const tempPath = path.join(os.tmpdir(), `rekono-ocr-src-${crypto.randomUUID()}${path.extname(storagePath)}`);
  try {
    await downloadToLocalFile(storagePath, tempPath);
  } catch (err) {
    if (err.code === "ENOENT") throw new OcrError(`File not found: ${storagePath}`);
    throw err;
  }
  try {
    return await extractText(tempPath, contentType);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function extractFromImage(imagePath) {
  try {
    const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout"], {
      maxBuffer: 1024 * 1024 * 32,
      timeout: TESSERACT_TIMEOUT_MS,
    });
    return stdout;
  } catch (exc) {
    throw new OcrError(`OCR failed: ${exc.message}`);
  }
}

async function extractFromPdf(pdfPath) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rekono-ocr-"));
  const prefix = path.join(tmpDir, "page");
  try {
    try {
      await execFileAsync("pdftoppm", ["-png", "-r", "200", pdfPath, prefix], { timeout: PDFTOPPM_TIMEOUT_MS });
    } catch (exc) {
      throw new OcrError(`Failed to rasterize PDF for OCR: ${exc.message}`);
    }

    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".png")).sort();
    if (files.length === 0) {
      throw new OcrError("PDF rasterization produced no pages.");
    }

    const pageTexts = [];
    for (const file of files) {
      pageTexts.push(await extractFromImage(path.join(tmpDir, file)));
    }
    return pageTexts.join("\n");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
