import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as objectStorage from "../src/objectStorage.js";
import { settings } from "../src/config.js";

// Fake Supabase Storage client mimicking the real @supabase/storage-js
// shape (client.storage.from(bucket).upload/download/remove) -- same
// injectable-client pattern as quickbooks.test.js's fake fetchImpl, so
// these tests never touch a live Supabase project.
function fakeClient({ uploadError, downloadError, downloadBody, removeError } = {}) {
  const calls = { upload: [], download: [], remove: [] };
  return {
    calls,
    storage: {
      from(bucket) {
        return {
          async upload(key, data, options) {
            calls.upload.push({ bucket, key, data, options });
            if (uploadError) return { data: null, error: { message: uploadError } };
            return { data: { path: key }, error: null };
          },
          async download(key) {
            calls.download.push({ bucket, key });
            if (downloadError) return { data: null, error: { message: downloadError } };
            return { data: new Blob([downloadBody ?? "file contents"]), error: null };
          },
          async remove(keys) {
            calls.remove.push({ bucket, keys });
            if (removeError) return { data: null, error: { message: removeError } };
            return { data: keys.map((key) => ({ name: key })), error: null };
          },
        };
      },
    },
  };
}

describe("isConfigured", () => {
  const original = { url: settings.supabaseUrl, key: settings.supabaseServiceRoleKey };
  afterEach(() => {
    settings.supabaseUrl = original.url;
    settings.supabaseServiceRoleKey = original.key;
  });

  test("false when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are unset (the default in this test env)", () => {
    settings.supabaseUrl = "";
    settings.supabaseServiceRoleKey = "";
    expect(objectStorage.isConfigured()).toBe(false);
  });

  test("true once both are set", () => {
    settings.supabaseUrl = "https://example.supabase.co";
    settings.supabaseServiceRoleKey = "service-role-key";
    expect(objectStorage.isConfigured()).toBe(true);
  });

  test("false when only one of the two is set", () => {
    settings.supabaseUrl = "https://example.supabase.co";
    settings.supabaseServiceRoleKey = "";
    expect(objectStorage.isConfigured()).toBe(false);
  });
});

describe("uploadLocalFile", () => {
  test("reads the local file and uploads it under the given key", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rekono-test-"));
    const localPath = path.join(tmpDir, "invoice.pdf");
    await fs.writeFile(localPath, "%PDF-1.4 fake");

    const client = fakeClient();
    const result = await objectStorage.uploadLocalFile(localPath, "org1/abc.pdf", "application/pdf", { client });

    expect(result).toEqual({ ok: true, key: "org1/abc.pdf" });
    expect(client.calls.upload).toHaveLength(1);
    expect(client.calls.upload[0].key).toBe("org1/abc.pdf");
    expect(client.calls.upload[0].data.toString()).toBe("%PDF-1.4 fake");
    expect(client.calls.upload[0].options).toEqual({ contentType: "application/pdf", upsert: false });

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns an error result (does not throw) when the upload fails", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rekono-test-"));
    const localPath = path.join(tmpDir, "invoice.pdf");
    await fs.writeFile(localPath, "data");

    const client = fakeClient({ uploadError: "bucket not found" });
    const result = await objectStorage.uploadLocalFile(localPath, "org1/abc.pdf", "application/pdf", { client });

    expect(result).toEqual({ error: "upload_failed", detail: "bucket not found" });

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns not_configured when no client is available and none is injected", async () => {
    const result = await objectStorage.uploadLocalFile("/tmp/whatever.pdf", "key", "application/pdf", { client: null });
    expect(result).toEqual({ error: "not_configured" });
  });
});

describe("downloadToBuffer", () => {
  test("returns the object's bytes as a Buffer", async () => {
    const client = fakeClient({ downloadBody: "hello from supabase" });
    const result = await objectStorage.downloadToBuffer("org1/abc.pdf", { client });

    expect(result.ok).toBe(true);
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.toString()).toBe("hello from supabase");
  });

  test("returns an error result when the download fails", async () => {
    const client = fakeClient({ downloadError: "object not found" });
    const result = await objectStorage.downloadToBuffer("org1/missing.pdf", { client });
    expect(result).toEqual({ error: "download_failed", detail: "object not found" });
  });

  test("returns not_configured when no client is available", async () => {
    const result = await objectStorage.downloadToBuffer("key", { client: null });
    expect(result).toEqual({ error: "not_configured" });
  });
});

describe("remove", () => {
  test("removes the object by key", async () => {
    const client = fakeClient();
    const result = await objectStorage.remove("org1/abc.pdf", { client });
    expect(result).toEqual({ ok: true });
    expect(client.calls.remove[0].keys).toEqual(["org1/abc.pdf"]);
  });

  test("returns an error result when the removal fails", async () => {
    const client = fakeClient({ removeError: "network error" });
    const result = await objectStorage.remove("org1/abc.pdf", { client });
    expect(result).toEqual({ error: "delete_failed", detail: "network error" });
  });

  test("returns not_configured when no client is available", async () => {
    const result = await objectStorage.remove("key", { client: null });
    expect(result).toEqual({ error: "not_configured" });
  });
});

describe("withLocalFile", () => {
  test("runs fn directly against storagePath for a locally-stored invoice", async () => {
    const invoice = { storageBackend: null, storagePath: "/tmp/local-file.pdf" };
    const seen = [];
    const result = await objectStorage.withLocalFile(invoice, async (localPath) => {
      seen.push(localPath);
      return "fn result";
    });
    expect(seen).toEqual(["/tmp/local-file.pdf"]);
    expect(result).toBe("fn result");
  });

  test("downloads a Supabase-backed invoice to a temp file, runs fn against it, then cleans up", async () => {
    const client = fakeClient({ downloadBody: "supabase file bytes" });
    const invoice = { storageBackend: "supabase", storagePath: "org1/abc.pdf" };

    let capturedPath;
    const result = await objectStorage.withLocalFile(
      invoice,
      async (localPath) => {
        capturedPath = localPath;
        expect(path.isAbsolute(localPath)).toBe(true);
        expect(localPath.endsWith(".pdf")).toBe(true);
        const bytes = await fs.readFile(localPath, "utf8");
        expect(bytes).toBe("supabase file bytes");
        return "ran against temp file";
      },
      { client }
    );

    expect(result).toBe("ran against temp file");
    // The temp file/directory is removed once fn returns.
    await expect(fs.access(capturedPath)).rejects.toThrow();
  });

  test("throws a descriptive error when the Supabase download fails", async () => {
    const client = fakeClient({ downloadError: "object not found" });
    const invoice = { storageBackend: "supabase", storagePath: "org1/missing.pdf" };

    await expect(objectStorage.withLocalFile(invoice, async () => {}, { client })).rejects.toThrow(
      /org1\/missing\.pdf.*object not found/
    );
  });

  test("cleans up the temp file even when fn throws", async () => {
    const client = fakeClient({ downloadBody: "bytes" });
    const invoice = { storageBackend: "supabase", storagePath: "org1/abc.pdf" };

    let capturedPath;
    await expect(
      objectStorage.withLocalFile(
        invoice,
        async (localPath) => {
          capturedPath = localPath;
          throw new Error("boom");
        },
        { client }
      )
    ).rejects.toThrow("boom");

    await expect(fs.access(capturedPath)).rejects.toThrow();
  });
});
