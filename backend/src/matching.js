// Reconciliation engine: fuzzy-matches an invoice against a list of
// candidate PO or bank-transaction entries.
//
// Pure functions here (no DB access) so the matching logic is
// unit-testable in isolation -- this is the "constraint matching" core of
// the product.

import * as fuzzball from "fuzzball";
import { settings } from "./config.js";

export function findBestMatch(invoiceVendor, invoiceAmount, invoiceDate, invoicePoReference, candidates) {
  if (!candidates.length) {
    return { status: "unmatched", score: 0, reasoning: "No PO/bank entries uploaded to match against.", entryId: null };
  }

  let best = null;
  for (const entry of candidates) {
    const outcome = scorePair(invoiceVendor, invoiceAmount, invoiceDate, invoicePoReference, entry);
    if (!best || outcome.score > best.score) best = outcome;
  }
  return best;
}

function scorePair(invoiceVendor, invoiceAmount, invoiceDate, invoicePoReference, entry) {
  const vendorScore = fuzzball.token_sort_ratio(invoiceVendor || "", entry.vendor || "");
  const vendorOk = vendorScore >= settings.matchVendorScoreThreshold;

  const referenceHit = Boolean(
    invoicePoReference &&
      entry.reference &&
      invoicePoReference.trim().toLowerCase() === entry.reference.trim().toLowerCase()
  );

  let amountOk = null;
  let amountDetail = "amount not comparable";
  if (invoiceAmount !== null && invoiceAmount !== undefined && entry.amount !== null && entry.amount !== undefined) {
    const diff = Math.abs(invoiceAmount - entry.amount);
    const tolerance = Math.max(settings.matchAmountToleranceAbs, invoiceAmount * settings.matchAmountTolerancePct);
    amountOk = diff <= tolerance;
    amountDetail = `amount diff $${diff.toFixed(2)} (${amountOk ? "within" : "outside"} tolerance $${tolerance.toFixed(2)})`;
  }

  let dateOk = null;
  let dateDetail = "date not comparable";
  if (invoiceDate && entry.entryDate) {
    const dayDiff = Math.round(Math.abs(new Date(invoiceDate) - new Date(entry.entryDate)) / 86400000);
    dateOk = dayDiff <= settings.matchDateWindowDays;
    dateDetail = `date diff ${dayDiff}d (${dateOk ? "within" : "outside"} ${settings.matchDateWindowDays}d window)`;
  }

  // Composite score: vendor similarity dominates, amount/date corroborate.
  let composite = 0.5 * vendorScore;
  composite += amountOk ? 30 : amountOk === false ? 0 : 15;
  composite += dateOk ? 20 : dateOk === false ? 0 : 10;
  if (referenceHit) composite = Math.min(100, composite + 15);

  let reasoning = `vendor '${invoiceVendor}' vs '${entry.vendor}' = ${vendorScore.toFixed(0)}/100; ${amountDetail}; ${dateDetail}.`;
  if (referenceHit) reasoning += " PO/reference number matches exactly.";

  let status;
  if (referenceHit || (vendorOk && amountOk && dateOk !== false)) {
    status = "matched";
  } else if (vendorOk && (amountOk || amountOk === null)) {
    status = "partial";
  } else if (vendorOk || amountOk) {
    status = "partial";
  } else {
    status = "unmatched";
  }

  return { status, score: Math.round(composite * 100) / 100, reasoning, entryId: entry.id };
}
