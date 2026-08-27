// File ingestion helpers -- mirrors the Python backend's storage.py.
//
// MVP scope: accepts direct file uploads (PDF or image). Email-inbox and
// watched-folder/Drive ingestion are roadmap items that would front the
// same multer + job-queue pipeline used here, not a redesign.
//
// Storage backend: local disk by default, S3 when AWS_S3_BUCKET is set
// (config.js) -- see README.md's "Scaling past one instance" section for
// why. Every function below dispatches on the *shape* of a given
// storagePath (an "s3://" prefix vs. a plain filesystem path) rather than
// on whether S3 is currently configured, so a record written under one
// mode still resolves correctly even if the deployment's mode changes
// later, and demoSeed.js's always-local sample files keep working
// unmodified in an S3-configured deployment.

import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import multer from "multer";
import { settings } from "./config.js";

// Extension -> the one content-type this app will ever store/serve for it.
// Deliberately the single source of truth for that value -- see
// canonicalContentType below for why.
const EXTENSION_CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
};

// The content-type an upload gets stored and served back with -- always
// derived from the filename extension against this module's own fixed map,
// NEVER the client-declared multipart content-type. Multer trusts whatever
// Content-Type the uploading request happens to set per part, so without
// this a file named "invoice.pdf" could be uploaded with an actual declared
// type of "text/html"; the review UI's document preview loads the file into
// an <iframe> by content-type, so serving that back verbatim would render
// an attacker's HTML/JS same-origin -- with access to whichever teammate's
// session happened to open that invoice next. There's deliberately no
// fallback to the declared type for an unrecognized extension either: that
// would let a spoofed Content-Type (e.g. declaring "application/pdf" on a
// file named payload.exe) talk its way past the extension check, which
// defeats the point.
export function canonicalContentType(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return EXTENSION_CONTENT_TYPES[ext] || null;
}

// Typical invoice scans/photos are a few KB to a few MB; 20MB comfortably
// covers a high-res multi-page scan while bounding the worst case for disk
// usage and OCR/LLM processing time on any single upload.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function s3Configured() {
  return Boolean(settings.awsS3Bucket);
}

let s3Client = null;
function s3() {
  if (!s3Client) s3Client = new S3Client({ region: settings.awsRegion });
  return s3Client;
}

const S3_PREFIX = "s3://";

// A stored document's DB column holds either a plain local path (unchanged
// from before S3 support existed) or "s3://<bucket>/<key>" -- the bucket is
// redundant with settings.awsS3Bucket but kept in the value itself so a
// bucket rename/migration is visible in the data, not just in config.
export function isS3Path(storagePath) {
  return typeof storagePath === "string" && storagePath.startsWith(S3_PREFIX);
}

function s3KeyFromPath(storagePath) {
  return storagePath.slice(S3_PREFIX.length + settings.awsS3Bucket.length + 1);
}

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, settings.storageDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "upload") || ".bin";
    cb(null, `${crypto.randomUUID().replace(/-/g, "")}${ext}`);
  },
});

// Matching-source and bank-statement CSV uploads (routes/matching.js,
// routes/transactions.js) always use this one: they're read once inside
// the same request and discarded, never queued for background processing
// or served back later, so there's nothing for them to gain from S3.
export const upload = multer({ storage: diskStorage, limits: { fileSize: MAX_UPLOAD_BYTES } });

// The 5 OCR/LLM document pipelines (invoices, expense receipts, vendor
// documents, leases, tax documents) use this one instead. Buffers in
// memory when S3 is configured -- there's no local destination to stream
// to, so the route hands the buffer to saveDocumentUpload below once
// content-type validation passes; otherwise behaves exactly like `upload`.
export const documentUpload = multer({
  storage: s3Configured() ? multer.memoryStorage() : diskStorage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Persists a just-received documentUpload file and returns the opaque
// string a route stores in its `storagePath` column. Disk mode: multer
// already wrote the file, so this just hands back the path it chose. S3
// mode: multer only buffered the file in memory, so this uploads it here.
export async function saveDocumentUpload(file, contentType) {
  if (!s3Configured()) return file.path;

  const ext = path.extname(file.originalname || "upload") || ".bin";
  const key = `${crypto.randomUUID().replace(/-/g, "")}${ext}`;
  await s3().send(
    new PutObjectCommand({
      Bucket: settings.awsS3Bucket,
      Key: key,
      Body: file.buffer,
      ContentType: contentType || "application/octet-stream",
    })
  );
  return `${S3_PREFIX}${settings.awsS3Bucket}/${key}`;
}

// Cleans up a documentUpload file that a route is rejecting (unsupported
// content type, plan cap reached) before it's ever saved to the DB or
// uploaded to S3. Disk mode has a real temp file multer already wrote;
// memory mode never wrote anything anywhere, so there's nothing to do --
// the buffer is simply garbage collected once `file` goes out of scope.
export async function discardRejectedUpload(file) {
  if (file.path) await fs.rm(file.path, { force: true });
}

// Serves a stored document back through an HTTP response -- the shared
// body of every document type's GET .../:id/file route. Disk mode is
// exactly the res.sendFile call this replaced; S3 mode streams the object
// through this server rather than redirecting to a presigned URL, so the
// bearer token that already authorized this request is the only thing
// that ever proves access -- a redirect would hand the client a bucket URL
// it could pass around on its own, bypassing that check entirely.
export async function sendStoredFile(storagePath, contentType, res, next) {
  // Content-Type is only ever set once a successful send is confirmed --
  // res.json()'s own error responses below leave an already-set header
  // alone rather than overriding it, so setting this eagerly up front
  // would serve a JSON error body mislabeled as e.g. application/pdf.
  if (!isS3Path(storagePath)) {
    res.sendFile(storagePath, { headers: { "Content-Type": contentType || "application/octet-stream" } }, (err) => {
      if (!err) return;
      // A missing source file is routine on ephemeral hosting (Render's
      // free tier wipes uploads on every restart/redeploy) -- report it as
      // a clean 404 instead of letting the raw ENOENT (which includes the
      // full server-side storage path) fall through to the generic 500
      // handler.
      if (err.code === "ENOENT") {
        return res.status(404).json({ detail: "This document's source file is no longer available on the server." });
      }
      next(err);
    });
    return;
  }

  try {
    const object = await s3().send(new GetObjectCommand({ Bucket: settings.awsS3Bucket, Key: s3KeyFromPath(storagePath) }));
    res.set("Content-Type", contentType || "application/octet-stream");
    await pipeline(object.Body, res);
  } catch (err) {
    if (err.name === "NoSuchKey") {
      return res.status(404).json({ detail: "This document's source file is no longer available on the server." });
    }
    next(err);
  }
}

// Removes a stored document's underlying file once its record is deleted.
// `label` matches the existing per-route log wording (e.g. "invoice
// <id>", "lease <id>") so this reads the same in server logs as before.
export async function deleteStoredFile(storagePath, label) {
  if (!storagePath) return;

  if (isS3Path(storagePath)) {
    await s3()
      .send(new DeleteObjectCommand({ Bucket: settings.awsS3Bucket, Key: s3KeyFromPath(storagePath) }))
      .catch((err) => console.error(`Failed to remove S3 file for deleted ${label}:`, err.message));
    return;
  }

  await fs.unlink(storagePath).catch((err) => {
    if (err.code !== "ENOENT") console.error(`Failed to remove file for deleted ${label}:`, err.message);
  });
}

// Downloads an S3-backed document to a real local file -- used by ocr.js,
// which shells out to pdftoppm/tesseract and so needs an actual path on
// disk regardless of where the file is durably stored. Throws an error
// shaped like fs.access's own ENOENT (same `.code`) when the object is
// missing, so ocr.js's existing "File not found" handling (already written
// for the plain-disk case) covers this one too without needing its own
// S3-specific branch.
export async function downloadToLocalFile(storagePath, destPath) {
  let object;
  try {
    object = await s3().send(new GetObjectCommand({ Bucket: settings.awsS3Bucket, Key: s3KeyFromPath(storagePath) }));
  } catch (err) {
    if (err.name === "NoSuchKey") {
      const enoent = new Error(`S3 object not found: ${storagePath}`);
      enoent.code = "ENOENT";
      throw enoent;
    }
    throw err;
  }
  await pipeline(object.Body, fsSync.createWriteStream(destPath));
}
