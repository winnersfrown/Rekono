// The S3-backed storage path (storage.js) that switches on when
// AWS_S3_BUCKET is configured -- see config.js's comment on why this
// exists (going to more than one app instance for capacity breaks local
// disk storage entirely). AWS_S3_BUCKET is never set in the test
// environment (jest.setup.js) or in the rest of the suite, so those tests
// exercise the disk path unchanged; this file is the only place the S3
// path itself gets real coverage, via a mocked S3Client (aws-sdk-client-mock)
// rather than a live AWS account -- same "structurally tested down to the
// unconfigured/configured branch, never a live external call" pattern as
// Stripe/Google/QuickBooks elsewhere in this suite.
//
// settings.awsS3Bucket is mutated directly (rather than setting
// process.env.AWS_S3_BUCKET) for the same reason staff.test.js mutates
// settings.staffEmails directly: ES module imports are hoisted above the
// rest of a file's code, so by the time a plain `process.env.X = ...`
// statement ran, config.js would already have read whatever was in the
// environment beforehand. storage.js's exported functions all call
// s3Configured() fresh on every invocation (never cached at module load),
// so mutating the shared settings object works cleanly here.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { jest } from "@jest/globals";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { settings } from "../src/config.js";
import {
  deleteStoredFile,
  discardRejectedUpload,
  downloadToLocalFile,
  isS3Path,
  saveDocumentUpload,
  sendStoredFile,
} from "../src/storage.js";

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
  settings.awsS3Bucket = "test-bucket";
  settings.awsRegion = "us-east-1";
});

afterEach(() => {
  settings.awsS3Bucket = "";
});

// A fake Express response: a real Writable (so pipeline() can stream an S3
// body through it, the same as a real http.ServerResponse) plus the
// handful of methods storage.js actually calls on it.
function fakeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  res.statusCode = 200;
  res.jsonBody = null;
  res.headers = {};
  res.set = (key, value) => {
    res.headers[key] = value;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.jsonBody = body;
  };
  res.text = () => Buffer.concat(chunks).toString("utf8");
  return res;
}

test("isS3Path only matches the s3:// prefix", () => {
  expect(isS3Path("s3://bucket/key")).toBe(true);
  expect(isS3Path("/tmp/local/file.pdf")).toBe(false);
  expect(isS3Path(null)).toBe(false);
  expect(isS3Path(undefined)).toBe(false);
});

test("saveDocumentUpload uploads the buffer to S3 and returns an s3:// storagePath", async () => {
  s3Mock.on(PutObjectCommand).resolves({});

  const storagePath = await saveDocumentUpload(
    { originalname: "invoice.pdf", buffer: Buffer.from("%PDF-1.4 fake") },
    "application/pdf"
  );

  expect(storagePath).toMatch(/^s3:\/\/test-bucket\/[0-9a-f]{32}\.pdf$/);
  const calls = s3Mock.commandCalls(PutObjectCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input).toMatchObject({ Bucket: "test-bucket", ContentType: "application/pdf" });
});

test("saveDocumentUpload never touches S3 when unconfigured -- just hands back multer's own disk path", async () => {
  settings.awsS3Bucket = "";
  const storagePath = await saveDocumentUpload({ path: "/tmp/rekono-test/abc123.pdf" }, "application/pdf");
  expect(storagePath).toBe("/tmp/rekono-test/abc123.pdf");
  expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
});

test("discardRejectedUpload removes a disk-backed temp file", async () => {
  const tmp = path.join(os.tmpdir(), `rekono-storage-test-${Date.now()}.pdf`);
  await fs.writeFile(tmp, "temp");
  await discardRejectedUpload({ path: tmp });
  await expect(fs.access(tmp)).rejects.toThrow();
});

test("discardRejectedUpload no-ops for a memory-buffered file (no .path to remove)", async () => {
  await expect(discardRejectedUpload({ buffer: Buffer.from("x") })).resolves.toBeUndefined();
});

test("deleteStoredFile with no storagePath is a no-op", async () => {
  await expect(deleteStoredFile(null, "invoice x")).resolves.toBeUndefined();
  expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
});

test("deleteStoredFile removes the S3 object for an s3:// path", async () => {
  s3Mock.on(DeleteObjectCommand).resolves({});
  await deleteStoredFile("s3://test-bucket/abc123.pdf", "invoice x");
  const calls = s3Mock.commandCalls(DeleteObjectCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input).toMatchObject({ Bucket: "test-bucket", Key: "abc123.pdf" });
});

test("deleteStoredFile still unlinks a plain local path even while S3 is configured -- demoSeed.js's files stay servable/deletable", async () => {
  const tmp = path.join(os.tmpdir(), `rekono-storage-test-local-${Date.now()}.pdf`);
  await fs.writeFile(tmp, "temp");
  await deleteStoredFile(tmp, "demo doc x");
  await expect(fs.access(tmp)).rejects.toThrow();
  expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
});

test("sendStoredFile streams an S3 object through the response", async () => {
  s3Mock.on(GetObjectCommand).resolves({ Body: Readable.from([Buffer.from("hello from s3")]) });
  const res = fakeRes();
  const next = jest.fn();

  await sendStoredFile("s3://test-bucket/abc123.pdf", "application/pdf", res, next);

  expect(res.headers["Content-Type"]).toBe("application/pdf");
  expect(res.text()).toBe("hello from s3");
  expect(next).not.toHaveBeenCalled();
  expect(res.jsonBody).toBeNull();
});

test("sendStoredFile reports a missing S3 object as a clean 404, not a raw AWS error", async () => {
  const notFound = new Error("The specified key does not exist.");
  notFound.name = "NoSuchKey";
  s3Mock.on(GetObjectCommand).rejects(notFound);
  const res = fakeRes();
  const next = jest.fn();

  await sendStoredFile("s3://test-bucket/missing.pdf", "application/pdf", res, next);

  expect(res.statusCode).toBe(404);
  expect(res.jsonBody.detail).toMatch(/no longer available/i);
  expect(next).not.toHaveBeenCalled();
});

test("downloadToLocalFile writes the S3 object's bytes to the given path", async () => {
  s3Mock.on(GetObjectCommand).resolves({ Body: Readable.from([Buffer.from("ocr me")]) });
  const dest = path.join(os.tmpdir(), `rekono-storage-test-download-${Date.now()}.pdf`);

  await downloadToLocalFile("s3://test-bucket/abc123.pdf", dest);

  expect(await fs.readFile(dest, "utf8")).toBe("ocr me");
  await fs.rm(dest, { force: true });
});

test("downloadToLocalFile throws an ENOENT-coded error for a missing S3 object, matching fs.access's own shape", async () => {
  const notFound = new Error("The specified key does not exist.");
  notFound.name = "NoSuchKey";
  s3Mock.on(GetObjectCommand).rejects(notFound);

  await expect(downloadToLocalFile("s3://test-bucket/missing.pdf", "/tmp/wont-be-written.pdf")).rejects.toMatchObject({
    code: "ENOENT",
  });
});
