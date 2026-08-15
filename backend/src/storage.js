// File ingestion helpers -- mirrors the Python backend's storage.py.
//
// MVP scope: accepts direct file uploads (PDF or image). Email-inbox and
// watched-folder/Drive ingestion are roadmap items that would front the
// same multer + job-queue pipeline used here, not a redesign.

import crypto from "node:crypto";
import path from "node:path";
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

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, settings.storageDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "upload") || ".bin";
    cb(null, `${crypto.randomUUID().replace(/-/g, "")}${ext}`);
  },
});

export const upload = multer({ storage: diskStorage, limits: { fileSize: MAX_UPLOAD_BYTES } });
