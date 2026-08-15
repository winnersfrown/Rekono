import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

test("a file's declared multipart content-type is never trusted for storage -- it's derived from the extension instead", async () => {
  const token = await signup(app, request);

  // Named and extension-valid as a PDF, but declares text/html -- if this
  // were trusted and served back as-is, the review UI's document preview
  // <iframe> would render it as live HTML instead of a PDF.
  const res = await request(app)
    .post("/api/invoices/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("<script>alert(document.cookie)</script>"), {
      filename: "invoice.pdf",
      contentType: "text/html",
    });

  expect(res.status).toBe(201);
  expect(res.body.content_type).toBe("application/pdf");
});

test("an oversized upload is rejected with a clean 413, not a raw Multer error", async () => {
  const token = await signup(app, request);
  const tooBig = Buffer.alloc(21 * 1024 * 1024); // over the 20MB limit

  const res = await request(app)
    .post("/api/invoices/upload")
    .set(authHeader(token))
    .attach("file", tooBig, { filename: "huge.pdf", contentType: "application/pdf" });

  expect(res.status).toBe(413);
  expect(res.body.detail).toMatch(/too large/i);
});

test("a legitimate PDF with a matching declared content-type still uploads normally", async () => {
  const token = await signup(app, request);

  const res = await request(app)
    .post("/api/invoices/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "invoice.pdf", contentType: "application/pdf" });

  expect(res.status).toBe(201);
  expect(res.body.content_type).toBe("application/pdf");
});

test("a disguised file with no recognizable extension is still rejected even with a spoofed content-type", async () => {
  const token = await signup(app, request);

  const res = await request(app)
    .post("/api/invoices/upload")
    .set(authHeader(token))
    .attach("file", Buffer.from("MZ\x90\x00"), { filename: "payload.exe", contentType: "application/pdf" });

  expect(res.status).toBe(422);
});
