"""Confidence scoring: combines per-field LLM confidence with an automatic
cross-check (do line items sum to the total?) to catch extraction errors
the model didn't flag itself.
"""

from dataclasses import dataclass

from .extraction import ExtractedLineItem, ExtractionResult

CROSS_CHECK_TOLERANCE_ABS = 0.05  # dollars, absorbs rounding noise
CORE_FIELDS_WEIGHT = {
    "vendor_name": 1.0,
    "invoice_number": 1.0,
    "invoice_date": 1.0,
    "total": 1.5,
    "subtotal": 0.5,
    "tax": 0.5,
    "due_date": 0.3,
    "po_reference": 0.3,
    "currency": 0.3,
}


@dataclass
class ConfidenceReport:
    overall_confidence: float
    cross_check_passed: bool
    cross_check_detail: str


def score(result: ExtractionResult) -> ConfidenceReport:
    weighted_sum = 0.0
    weight_total = 0.0
    for field_name, weight in CORE_FIELDS_WEIGHT.items():
        conf = result.field_confidence.get(field_name, 0.0)
        weighted_sum += conf * weight
        weight_total += weight

    if result.line_items:
        avg_line_conf = sum(li.confidence for li in result.line_items) / len(result.line_items)
        weighted_sum += avg_line_conf * 1.0
        weight_total += 1.0

    field_confidence_avg = weighted_sum / weight_total if weight_total else 0.0

    cross_check_passed, cross_check_detail = _cross_check_total(result)

    overall = field_confidence_avg
    if not cross_check_passed and result.line_items:
        # A failed arithmetic cross-check is a strong, independent signal
        # of an extraction error, so it pulls confidence down regardless of
        # how confident the model claimed to be per-field.
        overall = min(overall, 0.5)

    return ConfidenceReport(
        overall_confidence=round(overall, 4),
        cross_check_passed=cross_check_passed,
        cross_check_detail=cross_check_detail,
    )


def _cross_check_total(result: ExtractionResult) -> tuple[bool, str]:
    total = result.fields.get("total")
    if total is None:
        return False, "No total extracted to cross-check."

    line_items: list[ExtractedLineItem] = result.line_items
    if line_items and all(li.amount is not None for li in line_items):
        line_sum = round(sum(li.amount for li in line_items), 2)
        subtotal = result.fields.get("subtotal")
        tax = result.fields.get("tax") or 0.0

        if subtotal is not None:
            expected = round(subtotal + tax, 2)
            if abs(expected - total) <= CROSS_CHECK_TOLERANCE_ABS:
                if abs(line_sum - subtotal) <= CROSS_CHECK_TOLERANCE_ABS:
                    return True, f"Line items ({line_sum}) match subtotal ({subtotal}); subtotal + tax matches total."
                return False, f"Line items sum to {line_sum} but subtotal is {subtotal}."
            return False, f"Subtotal ({subtotal}) + tax ({tax}) = {expected}, but total is {total}."

        if abs(line_sum - total) <= CROSS_CHECK_TOLERANCE_ABS:
            return True, f"Line items sum ({line_sum}) matches total ({total})."
        return False, f"Line items sum to {line_sum}, which does not match total ({total})."

    return False, "Line item amounts incomplete; could not cross-check against total."
