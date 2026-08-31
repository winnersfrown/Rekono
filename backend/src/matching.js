// Reconciliation engine: fuzzy-matches an invoice against a list of
// candidate PO, goods-receipt, or bank-transaction entries.
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

// Exported so routes/checks.js can rank a scanned check against the org's
// open bills without a second copy of the tolerance/threshold rules -- the
// amount tolerance and date window are configuration (see config.js), and
// two matchers disagreeing about them is exactly the kind of drift that
// makes a reconciliation result impossible to explain.
//
// The parameter names are from this function's original caller (an invoice
// against uploaded PO/bank entries) and are left alone rather than
// generalised: renaming them would touch every line of the scoring maths
// for no behavioural gain. Read them as "the document being matched" and
// "the candidate it's being matched against".
export function scorePair(invoiceVendor, invoiceAmount, invoiceDate, invoicePoReference, entry) {
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

// ---- Three-way matching ----
// Two-way matching (above) answers "does this invoice line up with
// something we have on file?". Three-way answers the question AP actually
// cares about before releasing money: was this ordered, did it arrive, and
// is the bill consistent with both? An invoice that reconciles perfectly
// against its PO is still not safe to pay if nothing was ever received --
// that gap is the single most common way an AP department pays for goods
// it never got, and catching it is the whole point of this function.
//
// Bank entries are deliberately not a leg here: they evidence that money
// left the account, which is the payment-reconciliation job (see
// routes/integrations.js), not the pre-payment authorization check.
const THREE_WAY_VERDICTS = {
  matched: {
    status: "matched",
    summary: "Ordered, received, and billed consistently.",
  },
  no_receipt: {
    status: "partial",
    summary: "Billed and ordered, but nothing matches on the goods receipts — do not pay until delivery is confirmed.",
  },
  no_po: {
    status: "partial",
    summary: "Received and billed, but no matching purchase order — this spend was never authorized.",
  },
  unmatched: {
    status: "unmatched",
    summary: "No purchase order or goods receipt matches this invoice.",
  },
};

export function findThreeWayMatch(
  invoiceVendor,
  invoiceAmount,
  invoiceDate,
  invoicePoReference,
  poCandidates,
  receivingCandidates
) {
  const leg = (candidates, emptyReason) =>
    candidates.length
      ? findBestMatch(invoiceVendor, invoiceAmount, invoiceDate, invoicePoReference, candidates)
      : { status: "unmatched", score: 0, reasoning: emptyReason, entryId: null };

  const po = leg(poCandidates, "no purchase orders uploaded to match against");
  const receipt = leg(receivingCandidates, "no goods receipts uploaded to match against");

  // Only a full "matched" on a leg counts as that leg being satisfied --
  // a "partial" is precisely the case where we can't actually be confident
  // this is the same transaction, which is not a basis for releasing money.
  const poOk = po.status === "matched";
  const receiptOk = receipt.status === "matched";

  let outcome;
  if (poOk && receiptOk) outcome = "matched";
  else if (poOk) outcome = "no_receipt";
  else if (receiptOk) outcome = "no_po";
  else outcome = "unmatched";

  const verdict = THREE_WAY_VERDICTS[outcome];

  return {
    status: verdict.status,
    threeWayOutcome: outcome,
    // Averaged rather than taking the best leg: a three-way match is only
    // as trustworthy as its weakest leg, so a missing one should visibly
    // drag the score down instead of being hidden by a strong other half.
    score: Math.round(((po.score + receipt.score) / 2) * 100) / 100,
    reasoning: `${verdict.summary} PO: ${po.reasoning} Receipt: ${receipt.reasoning}`,
    // Only ever the entry that actually satisfied its leg. findBestMatch
    // returns its best-scoring candidate even when that candidate doesn't
    // match, which is useful for explaining a near-miss in `reasoning` but
    // wrong to persist as a foreign key -- a stored receivingEntryId reads
    // as "this is the receipt this invoice matched", so pointing it at an
    // unrelated receipt that failed the check would be actively
    // misleading to anything that later joins on it.
    entryId: poOk ? po.entryId : null,
    receivingEntryId: receiptOk ? receipt.entryId : null,
  };
}
