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
    // Invoice is paranoid (soft-delete, see models/Invoice.js) -- every
    // other query on it should exclude a deleted invoice, but this one
    // deliberately doesn't. The cap exists to bound how many documents get
    // OCR'd/sent to the LLM in a month, a cost already incurred at upload
    // time; a document a user deletes afterward still consumed that budget,
    // so it must keep counting or "delete and re-upload" would be a free
    // way around the plan's monthly cap.
    paranoid: false,
  });
}
