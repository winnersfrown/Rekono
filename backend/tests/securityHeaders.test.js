import request from "supertest";
import { app } from "../src/app.js";

test("responses carry standard browser-security headers", async () => {
  const res = await request(app).get("/api/health");
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["x-frame-options"]).toBe("DENY");
  expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(res.headers["x-powered-by"]).toBeUndefined();
});

test("does not set Strict-Transport-Security over plain HTTP (supertest's default)", async () => {
  const res = await request(app).get("/api/health");
  expect(res.headers["strict-transport-security"]).toBeUndefined();
});

describe("Content-Security-Policy", () => {
  // The review UI (backend/public/) was audited before writing this policy:
  // no inline <script> blocks or inline event-handler attributes anywhere
  // (only <script src="/*.js">), so script-src can be a bare 'self' with no
  // 'unsafe-inline'/nonce. Verified against a real headless browser too --
  // signup, the authenticated dashboard, and opening an invoice's document
  // preview (which uses a blob: URL, see app.js's loadDocPreview comment)
  // all produced zero CSP violations.
  test("is set on every response with the expected directives", async () => {
    const res = await request(app).get("/api/health");
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("frame-src 'self' blob:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});

describe("CORS allowlist", () => {
  test("echoes back an allowed origin (the marketing site)", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://winnersfrown.github.io");
    expect(res.headers["access-control-allow-origin"]).toBe("https://winnersfrown.github.io");
  });

  test("echoes back the app's own deployed origin", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://rekono-couj.onrender.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://rekono-couj.onrender.com");
  });

  test("does not grant CORS access to an arbitrary third-party origin", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    // Withholding the header is what enforces this -- the browser blocks
    // the response. The request itself is still answered truthfully rather
    // than being turned into a 500, which is what rejecting with an Error
    // used to do: a policy refusal reported as a server fault, and a
    // misconfigured ALLOWED_ORIGINS that looks like a bug in the app.
    expect(res.status).toBe(200);
  });

  test("a preflight from a disallowed origin is refused with 403, not a 200 HTML page", async () => {
    const res = await request(app)
      .options("/api/invoices")
      .set("Origin", "https://evil.example.com")
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("a preflight from an allowed origin succeeds", async () => {
    const res = await request(app)
      .options("/api/invoices")
      .set("Origin", "https://winnersfrown.github.io")
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("https://winnersfrown.github.io");
  });

  test("a request with no Origin header (server-to-server, curl) is unaffected", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
  });
});
