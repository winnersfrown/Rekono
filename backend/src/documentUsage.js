// Shared by ingestion.js (upload-time cap enforcement) and routes/auth.js
// (surfacing "X of Y documents used" in the dashboard sidebar) -- pulled out
// on its own so both always agree on exactly what counts and which window,
// rather than risking two copies of this logic drifting apart.
import { Op } from "sequelize";
import { Invoice } from "./models/index.js";

export function startOfCurrentMonthUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function documentsUsedThisMonth(orgId) {
  return Invoice.count({
    where: { orgId, createdAt: { [Op.gte]: startOfCurrentMonthUtc() } },
  });
}
