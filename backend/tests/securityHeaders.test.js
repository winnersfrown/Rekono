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

describe("CORS allowlist", () => {
  test("echoes back an allowed origin (the marketing site)", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://winnersfrown.github.io");
    expect(res.headers["access-control-allow-origin"]).toBe("https://winnersfrown.github.io");
  });

  test("echoes back the app's own deployed origin", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://rekono-crv7.onrender.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://rekono-crv7.onrender.com");
  });

  test("does not grant CORS access to an arbitrary third-party origin", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("a request with no Origin header (server-to-server, curl) is unaffected", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
  });
});
