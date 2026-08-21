// Confidence scoring for lease abstracts -- a weighted average of
// per-field LLM confidence. Same shape as confidenceVendorDocs.js: no
// cross-check, since there's nothing on a lease to check a total against.

// landlord_name/property_address identify which lease this even is, so
// they carry the most weight; expiration_date and renewal_notice_deadline
// are the two dates the whole module exists to flag, weighted above the
// numeric rent details a human reviews closely anyway.
const FIELD_WEIGHT = {
  landlord_name: 1.5,
  property_address: 1.2,
  commencement_date: 0.5,
  expiration_date: 1.0,
  renewal_notice_deadline: 0.8,
  monthly_rent: 0.4,
  annual_escalation_pct: 0.3,
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
