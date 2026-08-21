import request from "supertest";
import { app } from "../src/app.js";

// backend/public/ (the marketing site) and backend/public/app/ (the actual
// product) are both served from this one Express app -- see app.js's static
// mounts. This locks in the split: marketing at the root, the app under
// /app, with each other's own asset paths (styles.css/app.js/auth.js under
// /app, privacy.html/terms.html/robots.txt/sitemap.xml at the shared root).

test("GET / serves the marketing site", async () => {
  const res = await request(app).get("/");
  expect(res.status).toBe(200);
  expect(res.type).toBe("text/html");
  expect(res.text).toContain("Every invoice, read, checked");
});

test("GET /app/ serves the product (login/dashboard shell)", async () => {
  const res = await request(app).get("/app/");
  expect(res.status).toBe(200);
  expect(res.type).toBe("text/html");
  expect(res.text).toContain("login-form");
});

test("the app's own script/style assets are served under /app", async () => {
  const appJs = await request(app).get("/app/app.js");
  expect(appJs.status).toBe(200);
  const authJs = await request(app).get("/app/auth.js");
  expect(authJs.status).toBe(200);
  const styles = await request(app).get("/app/styles.css");
  expect(styles.status).toBe(200);
});

test("privacy/terms/robots/sitemap are served at the shared root, not under /app", async () => {
  const privacy = await request(app).get("/privacy.html");
  expect(privacy.status).toBe(200);
  const terms = await request(app).get("/terms.html");
  expect(terms.status).toBe(200);
  const robots = await request(app).get("/robots.txt");
  expect(robots.status).toBe(200);
  expect(robots.text).toContain("Disallow: /app");
  const sitemap = await request(app).get("/sitemap.xml");
  expect(sitemap.status).toBe(200);
});
