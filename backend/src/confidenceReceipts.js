// Confidence scoring for expense receipts -- a weighted average of
// per-field LLM confidence. Unlike invoices (confidence.js), there's no
// line-items-sum-vs-total cross-check here: a receipt in this app has no
// line items to check the total against, so overall confidence is purely
// the model's (or heuristic's) own self-reported certainty.

const FIELD_WEIGHT = {
  merchant_name: 1.0,
  receipt_date: 1.0,
  category: 0.5,
  amount: 1.5,
  tax: 0.3,
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
