// Confidence scoring: combines per-field LLM confidence with an automatic
// cross-check (do line items sum to the total?) to catch extraction errors
// the model didn't flag itself.

const CROSS_CHECK_TOLERANCE_ABS = 0.05; // dollars, absorbs rounding noise

const CORE_FIELDS_WEIGHT = {
  vendor_name: 1.0,
  invoice_number: 1.0,
  invoice_date: 1.0,
  total: 1.5,
  subtotal: 0.5,
  tax: 0.5,
  due_date: 0.3,
  po_reference: 0.3,
  currency: 0.3,
};

export function score(result) {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [field, weight] of Object.entries(CORE_FIELDS_WEIGHT)) {
    const conf = result.fieldConfidence[field] ?? 0;
    weightedSum += conf * weight;
    weightTotal += weight;
  }

  if (result.lineItems.length) {
    const avgLineConf = result.lineItems.reduce((sum, li) => sum + li.confidence, 0) / result.lineItems.length;
    weightedSum += avgLineConf * 1.0;
    weightTotal += 1.0;
  }

  const fieldConfidenceAvg = weightTotal ? weightedSum / weightTotal : 0;
  const { crossCheckPassed, crossCheckDetail } = crossCheckTotal(result);

  let overall = fieldConfidenceAvg;
  if (!crossCheckPassed && result.lineItems.length) {
    // A failed arithmetic cross-check is a strong, independent signal of an
    // extraction error, so it pulls confidence down regardless of how
    // confident the model claimed to be per-field.
    overall = Math.min(overall, 0.5);
  }

  return {
    overallConfidence: Math.round(overall * 10000) / 10000,
    crossCheckPassed,
    crossCheckDetail,
  };
}

function crossCheckTotal(result) {
  const total = result.fields.total;
  if (total === null || total === undefined) {
    return { crossCheckPassed: false, crossCheckDetail: "No total extracted to cross-check." };
  }

  const lineItems = result.lineItems;
  if (lineItems.length && lineItems.every((li) => li.amount !== null && li.amount !== undefined)) {
    const lineSum = round2(lineItems.reduce((sum, li) => sum + li.amount, 0));
    const subtotal = result.fields.subtotal;
    const tax = result.fields.tax || 0;

    if (subtotal !== null && subtotal !== undefined) {
      const expected = round2(subtotal + tax);
      if (Math.abs(expected - total) <= CROSS_CHECK_TOLERANCE_ABS) {
        if (Math.abs(lineSum - subtotal) <= CROSS_CHECK_TOLERANCE_ABS) {
          return {
            crossCheckPassed: true,
            crossCheckDetail: `Line items (${lineSum}) match subtotal (${subtotal}); subtotal + tax matches total.`,
          };
        }
        return {
          crossCheckPassed: false,
          crossCheckDetail: `Line items sum to ${lineSum} but subtotal is ${subtotal}.`,
        };
      }
      return {
        crossCheckPassed: false,
        crossCheckDetail: `Subtotal (${subtotal}) + tax (${tax}) = ${expected}, but total is ${total}.`,
      };
    }

    if (Math.abs(lineSum - total) <= CROSS_CHECK_TOLERANCE_ABS) {
      return { crossCheckPassed: true, crossCheckDetail: `Line items sum (${lineSum}) matches total (${total}).` };
    }
    return {
      crossCheckPassed: false,
      crossCheckDetail: `Line items sum to ${lineSum}, which does not match total (${total}).`,
    };
  }

  return { crossCheckPassed: false, crossCheckDetail: "Line item amounts incomplete; could not cross-check against total." };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
