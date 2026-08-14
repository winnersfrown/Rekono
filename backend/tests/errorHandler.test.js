import request from "supertest";
import { jest } from "@jest/globals";
import { app, handleUnexpectedError } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

test("unexpected errors respond with a generic message, never the raw internal error", () => {
  const err = new Error("password authentication failed for user \"rekono\" on connection postgres://rekono:supersecret@db:5432/rekono");
  const req = {};
  const jsonSpy = jest.fn();
  const statusSpy = jest.fn(() => ({ json: jsonSpy }));
  const res = { status: statusSpy };
  const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

  handleUnexpectedError(err, req, res, () => {});

  expect(statusSpy).toHaveBeenCalledWith(500);
  expect(jsonSpy).toHaveBeenCalledWith({ detail: "Internal server error" });
  // The full error -- including whatever sensitive detail it happened to
  // contain -- still reaches the server logs, just never the HTTP response.
  expect(consoleSpy).toHaveBeenCalledWith(err);

  consoleSpy.mockRestore();
});

test("unexpected errors respect an explicit err.status if one is ever set", () => {
  const err = Object.assign(new Error("nope"), { status: 418 });
  const jsonSpy = jest.fn();
  const statusSpy = jest.fn(() => ({ json: jsonSpy }));
  jest.spyOn(console, "error").mockImplementation(() => {});

  handleUnexpectedError(err, {}, { status: statusSpy }, () => {});

  expect(statusSpy).toHaveBeenCalledWith(418);
  expect(jsonSpy).toHaveBeenCalledWith({ detail: "Internal server error" });
});

test("responses don't advertise the framework via X-Powered-By", async () => {
  const res = await request(app).get("/api/health");
  expect(res.headers["x-powered-by"]).toBeUndefined();
});

test("a genuinely malformed request (broken multipart body) never leaks Multer's internal error text", async () => {
  const token = await signup(app, request);

  const res = await request(app)
    .post("/api/invoices/upload")
    .set(authHeader(token))
    .set("Content-Type", "multipart/form-data; boundary=intentionally-broken")
    .send("this is not valid multipart data at all");

  expect(res.status).toBe(500);
  expect(res.body).toEqual({ detail: "Internal server error" });
});
