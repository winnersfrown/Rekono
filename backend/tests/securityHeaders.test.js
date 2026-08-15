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
