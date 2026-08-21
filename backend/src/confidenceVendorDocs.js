// Confidence scoring for vendor documents -- a weighted average of
// per-field LLM confidence. Same shape as confidenceReceipts.js: no
// cross-check, since there's nothing on these documents to check a total
// against.

// vendor_name/document_type carry the most weight -- unlike expiration_date/
// reference_number/amount, they apply to every document type (a W-9 has no
// expiration date and no amount, so weighting those as heavily as the
// fields every document actually has would unfairly tank every W-9's score).
const FIELD_WEIGHT = {
  vendor_name: 1.5,
  document_type: 1.5,
  effective_date: 0.5,
  expiration_date: 1.0,
  reference_number: 0.7,
  amount: 0.3,
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
