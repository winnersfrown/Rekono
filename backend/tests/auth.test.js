import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";

beforeEach(resetDb);

test("signup creates org and returns token", async () => {
  const token = await signup(app, request, { email: "owner@example.co" });
  expect(token).toBeTruthy();

  const res = await request(app).get("/api/auth/me").set(authHeader(token));
  expect(res.status).toBe(200);
  expect(res.body.email).toBe("owner@example.co");
  expect(res.body.role).toBe("owner");
  expect(res.body.org_id).toBeTruthy();
});

test("signup duplicate email rejected", async () => {
  await signup(app, request, { email: "dupe@example.co" });
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ org_name: "Another Org", full_name: "Someone Else", email: "dupe@example.co", password: "anotherpassword123" });
  expect(res.status).toBe(409);
});

test("login wrong password rejected", async () => {
  await signup(app, request, { email: "loginuser@example.co", password: "correctpassword123" });
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: "loginuser@example.co", password: "wrongpassword" });
  expect(res.status).toBe(401);
});

test("login success returns token", async () => {
  await signup(app, request, { email: "loginuser2@example.co", password: "correctpassword123" });
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: "loginuser2@example.co", password: "correctpassword123" });
  expect(res.status).toBe(200);
  expect(res.body.access_token).toBeTruthy();
});

test("endpoints reject missing or invalid token", async () => {
  let res = await request(app).get("/api/invoices");
  expect(res.status).toBe(401);

  res = await request(app).get("/api/invoices").set(authHeader("not-a-real-token"));
  expect(res.status).toBe(401);
});

test("orgs cannot see each others invoices", async () => {
  const tokenA = await signup(app, request, { email: "alice@orga.co", orgName: "Org A" });
  const tokenB = await signup(app, request, { email: "bob@orgb.co", orgName: "Org B" });

  const upload = await request(app)
    .post("/api/invoices/upload")
    .set(authHeader(tokenA))
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "invoice.pdf", contentType: "application/pdf" });
  expect(upload.status).toBe(201);
  const invoiceId = upload.body.id;

  let res = await request(app).get("/api/invoices").set(authHeader(tokenB));
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);

  res = await request(app).get(`/api/invoices/${invoiceId}`).set(authHeader(tokenB));
  expect(res.status).toBe(404);

  res = await request(app).post(`/api/invoices/${invoiceId}/approve`).set(authHeader(tokenB));
  expect(res.status).toBe(404);

  res = await request(app).get("/api/invoices").set(authHeader(tokenA));
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
});

test("login rate limits after repeated attempts from the same IP", async () => {
  let lastRes;
  for (let i = 0; i < 21; i++) {
    lastRes = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@ratelimitco.co", password: "wrong-password" });
  }
  expect(lastRes.status).toBe(429);
});

test("signup rate limits after repeated attempts from the same IP", async () => {
  let lastRes;
  for (let i = 0; i < 31; i++) {
    lastRes = await request(app)
      .post("/api/auth/signup")
      .send({ org_name: "Spam Co", full_name: "Spammer", email: "spam@ratelimitco.co", password: "correcthorse123" });
  }
  expect(lastRes.status).toBe(429);
});
