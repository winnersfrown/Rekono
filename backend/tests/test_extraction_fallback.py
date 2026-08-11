from app.extraction import extract

SAMPLE_OCR_TEXT = """Acme Supplies Inc
123 Main St, Springfield

Invoice #: INV-2026-0007
Date: 01/15/2026
PO Number: PO-4421

Widget A  2  10.00  20.00
Widget B  1  30.00  30.00

Subtotal: $50.00
Tax: $4.00
Total Due: $54.00
"""


def test_heuristic_extraction_used_without_api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    from app.config import get_settings

    get_settings.cache_clear()
    result = extract(SAMPLE_OCR_TEXT)
    get_settings.cache_clear()

    assert result.method == "heuristic"
    assert result.fields["invoice_number"] == "INV-2026-0007"
    assert result.fields["po_reference"] == "PO-4421"
    assert result.fields["total"] == 54.00
    assert result.fields["subtotal"] == 50.00
    assert result.fields["tax"] == 4.00
    assert result.fields["invoice_date"] == "2026-01-15"
    assert len(result.line_items) == 2
    assert result.line_items[0].amount == 20.00
