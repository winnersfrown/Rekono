// File ingestion helpers -- mirrors the Python backend's storage.py.
//
// MVP scope: accepts direct file uploads (PDF or image). Email-inbox and
// watched-folder/Drive ingestion are roadmap items that would front the
// same multer + job-queue pipeline used here, not a redesign.

import crypto from "node:crypto";
import path from "node:path";
import multer from "multer";
import { settings } from "./config.js";

const ACCEPTED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/tiff",
  "image/bmp",
  "image/webp",
]);

const ACCEPTED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"]);

export function isSupported(filename, contentType) {
  const ext = path.extname(filename || "").toLowerCase();
  if (ACCEPTED_EXTENSIONS.has(ext)) return true;
  return Boolean(contentType && ACCEPTED_CONTENT_TYPES.has(contentType.toLowerCase()));
}

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, settings.storageDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "upload") || ".bin";
    cb(null, `${crypto.randomUUID().replace(/-/g, "")}${ext}`);
  },
});

export const upload = multer({ storage: diskStorage });
