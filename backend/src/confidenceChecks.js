// Confidence scoring for scanned checks -- a weighted average of per-field
// LLM confidence. Same shape as confidenceTaxDocs.js and confidenceLeases.js:
// no cross-check.
//
// It's worth saying why not, because a check looks like it should have one.
// It prints its amount twice (numerals and words), which is exactly the
// redundancy a cross-check feeds on -- but extraction returns a single
// reconciled `amount`, so by the time scoring runs there is only one figure
// and nothing left to compare it against. The real arithmetic check on a
// check happens later and elsewhere: routes/checks.js refuses to apply one
// that would overpay the bill it's being linked to, which is the same
// question ("do these two numbers agree?") asked where a wrong answer would
// actually move money.

// payee_name and amount decide who gets paid and how much -- the two facts
// that make a posting right or wrong -- so they carry the most weight.
// check_date is next: it dates the journal entry, so an error puts real
// money in the wrong period. check_number is a reference a human can
// confirm at a glance against the preview pane, and bank_name/account_last4
// only confirm which account it was drawn on. memo is free text nothing
// depends on, and is weighted accordingly -- a blank or misread memo should
// not by itself push a legible check into the review queue.
const FIELD_WEIGHT = {
  payee_name: 1.5,
  amount: 1.5,
  check_date: 1.0,
  check_number: 0.6,
  bank_name: 0.4,
  account_last4: 0.4,
  memo: 0.2,
};

export function score(result) {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [field, weight] of Object.entries(FIELD_WEIGHT)) {
    const conf = result.fieldConfidence[field] ?? 0;
    weightedSum += conf * weight;
    weightTotal += weight;
  }

  const overall = weightTotal ? weightedSum / weightTotal : 0;
  return { overallConfidence: Math.round(overall * 10000) / 10000 };
}
