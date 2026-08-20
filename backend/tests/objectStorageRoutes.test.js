import { jest } from "@jest/globals";
import fs from "node:fs/promises";
import request from "supertest";
import { authHeader, resetDb, signup } from "./testUtils.js";

// These exercise the Supabase branches of routes/ingestion.js and
// routes/invoices.js -- the routes call objectStorage.js's exports
// directly (module-level import, not per-call dependency injection like
// quickbooks.js's fetchImpl), so unlike objectStorage.test.js itself,
// getting a fake in requires mocking the module rather than just injecting
// a fake client. jest.unstable_mockModule must run before the route
// modules (and app.js, which imports them) are ever imported, so both the
// mock and app.js are loaded here via dynamic import instead of this
// file's own static imports.
const objectStorageMock = {
  isConfigured: jest.fn(() => false),
  uploadLocalFile: jest.fn(async () => ({ ok: true, key: "mock-key" })),
  downloadToBuffer: jest.fn(async () => ({ ok: true, buffer: Buffer.from("mock") })),
  remove: jest.fn(async () => ({ ok: true })),
  withLocalFile: jest.fn(async (invoice, fn) => fn(invoice.storagePath)),
};

jest.unstable_mockModule("../src/objectStorage.js", () => objectStorageMock);

const { app } = await import("../src/app.js");
const { Invoice } = await import("../src/models/index.js");

beforeEach(async () => {
  await resetDb();
  Object.values(objectStorageMock).forEach((fn) => fn.mockClear());
  objectStorageMock.isConfigured.mockReturnValue(false);
  objectStorageMock.uploadLocalFile.mockResolvedValue({ ok: true, key: "mock-key" });
  objectStorageMock.downloadToBuffer.mockResolvedValue({ ok: true, buffer: Buffer.from("mock") });
  objectStorageMock.remove.mockResolvedValue({ ok: true });
});

async function orgId(token) {
  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  return res.body.org_id;
}

function attachFakePdf(req) {
  return req.attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "invoice.pdf", contentType: "application/pdf" });
}

describe("POST /api/invoices/upload with Supabase Storage configured", () => {
  test("uploads to Supabase, stores the object key + backend, and removes the local temp copy", async () => {
    objectStorageMock.isConfigured.mockReturnValue(true);
    objectStorageMock.uploadLocalFile.mockResolvedValue({ ok: true, key: "some-org/generated-key.pdf" });

    const token = await signup(app, request, { email: "supabase-upload@uploadco.co" });
    const res = await attachFakePdf(request(app).post("/api/invoices/upload").set(authHeader(token)));

    expect(res.status).toBe(201);
    expect(objectStorageMock.uploadLocalFile).toHaveBeenCalledTimes(1);
    const [localPath, key, contentType] = objectStorageMock.uploadLocalFile.mock.calls[0];
    expect(contentType).toBe("application/pdf");
    expect(key).toMatch(/^[a-zA-Z0-9]+\/[a-f0-9]+\.pdf$/);

    const invoice = await Invoice.findByPk(res.body.id);
    expect(invoice.storageBackend).toBe("supabase");
    expect(invoice.storagePath).toBe(key);

    // The multer temp file that was uploaded from is removed once its
    // bytes are safely in Supabase -- local disk is never authoritative
    // once storageBackend is "supabase".
    await expect(fs.access(localPath)).rejects.toThrow();
  });

  test("returns 502 and does not create an invoice when the Supabase upload fails", async () => {
    objectStorageMock.isConfigured.mockReturnValue(true);
    objectStorageMock.uploadLocalFile.mockResolvedValue({ error: "upload_failed", detail: "bucket not found" });

    const token = await signup(app, request, { email: "supabase-upload-fail@uploadco.co" });
    const res = await attachFakePdf(request(app).post("/api/invoices/upload").set(authHeader(token)));

    expect(res.status).toBe(502);
    expect(await Invoice.count()).toBe(0);
  });

  test("does not call Supabase and stores a local path when not configured", async () => {
    objectStorageMock.isConfigured.mockReturnValue(false);

    const token = await signup(app, request, { email: "local-upload@uploadco.co" });
    const res = await attachFakePdf(request(app).post("/api/invoices/upload").set(authHeader(token)));

    expect(res.status).toBe(201);
    expect(objectStorageMock.uploadLocalFile).not.toHaveBeenCalled();

    const invoice = await Invoice.findByPk(res.body.id);
    expect(invoice.storageBackend).toBeNull();
  });
});

describe("GET /api/invoices/:id/file for a Supabase-backed invoice", () => {
  test("streams the object's bytes with the invoice's content type", async () => {
    objectStorageMock.downloadToBuffer.mockResolvedValue({ ok: true, buffer: Buffer.from("pdf bytes here") });

    const token = await signup(app, request, { email: "supabase-file@uploadco.co" });
    const org = await orgId(token);
    const invoice = await Invoice.create({
      orgId: org,
      originalFilename: "vendor-invoice.pdf",
      storagePath: "org1/abc123.pdf",
      storageBackend: "supabase",
      contentType: "application/pdf",
      status: "extracted",
    });

    const res = await request(app).get(`/api/invoices/${invoice.id}/file`).set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.body.toString()).toBe("pdf bytes here");
    expect(objectStorageMock.downloadToBuffer).toHaveBeenCalledWith("org1/abc123.pdf");
  });

  test("returns a friendly 404 when the Supabase object can't be downloaded", async () => {
    objectStorageMock.downloadToBuffer.mockResolvedValue({ error: "download_failed", detail: "object not found" });

    const token = await signup(app, request, { email: "supabase-file-missing@uploadco.co" });
    const org = await orgId(token);
    const invoice = await Invoice.create({
      orgId: org,
      originalFilename: "vendor-invoice.pdf",
      storagePath: "org1/missing.pdf",
      storageBackend: "supabase",
      contentType: "application/pdf",
      status: "extracted",
    });

    const res = await request(app).get(`/api/invoices/${invoice.id}/file`).set(authHeader(token));

    expect(res.status).toBe(404);
    expect(res.body.detail).toMatch(/no longer available/);
  });
});

describe("DELETE /api/invoices/:id for a Supabase-backed invoice", () => {
  test("removes the Supabase object instead of touching local disk", async () => {
    const token = await signup(app, request, { email: "supabase-delete@uploadco.co" });
    const org = await orgId(token);
    const invoice = await Invoice.create({
      orgId: org,
      originalFilename: "vendor-invoice.pdf",
      storagePath: "org1/to-delete.pdf",
      storageBackend: "supabase",
      contentType: "application/pdf",
      status: "extracted",
    });

    const res = await request(app).delete(`/api/invoices/${invoice.id}`).set(authHeader(token));

    expect(res.status).toBe(200);
    expect(objectStorageMock.remove).toHaveBeenCalledWith("org1/to-delete.pdf");
  });
});
