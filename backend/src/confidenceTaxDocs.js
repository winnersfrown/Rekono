// Confidence scoring for inbound tax forms -- a weighted average of
// per-field LLM confidence. Same shape as confidenceLeases.js: no
// cross-check, since a tax form has no total to check its parts against
// (the withholding box isn't derivable from the amount box -- that's the
// whole point of it being reported separately).

// document_type and tax_year decide which pile the form belongs in, and
// getting either wrong misfiles it somewhere nobody will look again, so
// they carry the most weight. amount is what actually gets reported and is
// weighted just under them. recipient_tin_last4 is weighted lightest of
// the real fields -- it's four digits a reviewer can confirm at a glance
// against the preview pane, so low confidence there is cheap to resolve.
const FIELD_WEIGHT = {
  document_type: 1.5,
  tax_year: 1.3,
  payer_name: 1.0,
  recipient_name: 0.8,
  recipient_tin_last4: 0.4,
  amount: 1.2,
  federal_tax_withheld: 0.5,
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
