import request from "supertest";
import { app } from "../src/app.js";
import { authHeader, resetDb, signup } from "./testUtils.js";
import { orgNameSchema } from "../src/orgName.js";

beforeEach(resetDb);

// Self-serve signup means anyone can set an organization's name to
// anything, and that name later renders on the invite-accept page --
// reachable without an account, by design, since an invitee needs to see
// the invite before creating one. Rejecting a name that's itself a URL
// closes the most mechanical version of using that page as bait (see
// orgName.js and index.html's #auth-invite-panel for the rest of the
// mitigation, which isn't testable at the unit level: the org name is
// quoted and visually framed as third-party text there, not filtered).
describe("orgNameSchema", () => {
  test.each(["http://evil.example/verify", "https://evil.example", "www.evil.example", "evil-example.com", "Sign in at paypal.com now"])(
    "rejects %s",
    (name) => {
      expect(orgNameSchema.safeParse(name).success).toBe(false);
    }
  );

  test.each(["Aperture Retail Group", "Cobalt & Pine Holdings", "Acme, Inc."])("accepts %s", (name) => {
    expect(orgNameSchema.safeParse(name).success).toBe(true);
  });
});

test("signup rejects a URL as the organization name", async () => {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ org_name: "https://evil.example/verify-now", full_name: "Attacker", email: "attacker@example.co", password: "password12345" });
  expect(res.status).toBe(422);
});

test("renaming the org to a URL is rejected", async () => {
  const token = await signup(app, request, { email: "renamer@example.co" });
  const res = await request(app).patch("/api/org/settings").set(authHeader(token)).send({ org_name: "www.evil.example" });
  expect(res.status).toBe(422);
});
