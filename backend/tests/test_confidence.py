from app.confidence import score
from app.extraction import ExtractedLineItem, ExtractionResult


def _result(total, line_amounts, field_conf_override=None, subtotal=None, tax=None):
    fields = {"total": total, "subtotal": subtotal, "tax": tax, "vendor_name": "Acme", "invoice_number": "1",
              "invoice_date": "2026-01-01", "due_date": "", "po_reference": "", "currency": "USD"}
    field_confidence = {k: 0.95 for k in fields if k != "currency"}
    field_confidence["currency"] = 0.95
    if field_conf_override:
        field_confidence.update(field_conf_override)
    line_items = [ExtractedLineItem(description="item", amount=a, confidence=0.9) for a in line_amounts]
    return ExtractionResult(method="llm", fields=fields, field_confidence=field_confidence, line_items=line_items)


def test_cross_check_passes_when_line_items_sum_to_total():
    result = _result(total=100.0, line_amounts=[60.0, 40.0])
    report = score(result)
    assert report.cross_check_passed is True
    assert report.overall_confidence > 0.8


def test_cross_check_fails_when_line_items_dont_sum_to_total():
    result = _result(total=100.0, line_amounts=[60.0, 30.0])
    report = score(result)
    assert report.cross_check_passed is False
    assert report.overall_confidence <= 0.5


def test_cross_check_uses_subtotal_plus_tax_when_available():
    result = _result(total=110.0, line_amounts=[100.0], subtotal=100.0, tax=10.0)
    report = score(result)
    assert report.cross_check_passed is True


def test_low_field_confidence_still_reduces_overall_even_if_cross_check_passes():
    result = _result(total=100.0, line_amounts=[100.0], field_conf_override={"vendor_name": 0.1})
    report = score(result)
    assert report.overall_confidence < 0.95
