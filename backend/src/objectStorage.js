// Optional Supabase Storage backend for uploaded invoice files -- same
// graceful-degradation shape as every other optional integration in this
// codebase (Stripe/Resend/Google/QuickBooks/Gemini): without
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY configured, every function here
// returns { error: "not_configured" } and callers keep using local disk
// exactly as this app always worked. Configured, uploads move to Supabase's
// persistent object storage instead -- surviving restarts/redeploys on
// ephemeral hosting (Render's free tier), which local disk never did.
//
// Every function takes an injectable `client` (defaults to the real
// Supabase client) so tests can supply a fake without hitting a live
// Supabase project, same pattern as quickbooks.js's injectable fetchImpl.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { settings } from "./config.js";

let cachedClient = null;

export function isConfigured() {
  return Boolean(settings.supabaseUrl && settings.supabaseServiceRoleKey);
}

// Lazily created and cached: every caller that doesn't inject its own
// client shares one, same reasoning as not reconnecting per-call for any
// other SDK client in this app.
function defaultClient() {
  if (!isConfigured()) return null;
  if (!cachedClient) cachedClient = createClient(settings.supabaseUrl, settings.supabaseServiceRoleKey);
  return cachedClient;
}

function bucket(client) {
  return client.storage.from(settings.supabaseStorageBucket);
}

export async function uploadLocalFile(localPath, key, contentType, { client = defaultClient() } = {}) {
  if (!client) return { error: "not_configured" };
  const data = await fs.readFile(localPath);
  const { error } = await bucket(client).upload(key, data, { contentType, upsert: false });
  if (error) return { error: "upload_failed", detail: error.message };
  return { ok: true, key };
}

export async function downloadToBuffer(key, { client = defaultClient() } = {}) {
  if (!client) return { error: "not_configured" };
  const { data, error } = await bucket(client).download(key);
  if (error) return { error: "download_failed", detail: error.message };
  return { ok: true, buffer: Buffer.from(await data.arrayBuffer()) };
}

export async function remove(key, { client = defaultClient() } = {}) {
  if (!client) return { error: "not_configured" };
  const { error } = await bucket(client).remove([key]);
  if (error) return { error: "delete_failed", detail: error.message };
  return { ok: true };
}

// Runs fn with a real local filesystem path for invoice's source file,
// regardless of which backend actually stores it -- OCR (real tesseract/
// pdftoppm binaries) and file-serving both need one. A locally-stored
// invoice's own storagePath already is one, so fn just runs directly
// against it. A Supabase-backed invoice (storageBackend === "supabase")
// gets downloaded to a throwaway temp file first; that copy is always
// cleaned up afterward, success or failure, same as ocr.js's own temp
// directory for rasterized PDF pages.
export async function withLocalFile(invoice, fn, opts = {}) {
  if (invoice.storageBackend !== "supabase") {
    return fn(invoice.storagePath);
  }

  const result = await downloadToBuffer(invoice.storagePath, opts);
  if (result.error) {
    throw new Error(`Could not download "${invoice.storagePath}" from Supabase Storage: ${result.detail || result.error}`);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rekono-supabase-"));
  const tmpPath = path.join(tmpDir, `file${path.extname(invoice.storagePath) || ""}`);
  try {
    await fs.writeFile(tmpPath, result.buffer);
    return await fn(tmpPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
