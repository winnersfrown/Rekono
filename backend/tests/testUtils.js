import { sequelize } from "../src/db.js";

export async function resetDb() {
  await sequelize.sync({ force: true });
}

export async function signup(app, request, { email = "owner@example.co", orgName = "Test Org", password = "correcthorse123" } = {}) {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ org_name: orgName, full_name: "Test Owner", email, password });
  if (res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.access_token;
}

export function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}
