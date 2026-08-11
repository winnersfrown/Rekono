"""Structured extraction on top of raw OCR text.

Primary path: Claude, forced into a fixed JSON schema via tool-use, with a
self-reported confidence per field. This is the core IP layer described in
the architecture doc.

Fallback path: a heuristic regex extractor used when no ANTHROPIC_API_KEY is
configured, so the ingestion -> extraction -> review -> export pipeline still
runs end to end for local demos, tests, and CI without needing a live LLM
call. Heuristic fields get a flat, low confidence score, which naturally
routes them into the human review queue.
"""

import json
import re
from dataclasses import dataclass, field

from .config import get_settings

FIELDS = [
    "vendor_name",
    "invoice_number",
    "invoice_date",
    "due_date",
    "po_reference",
    "currency",
    "subtotal",
    "tax",
    "total",
]

HEURISTIC_FIELD_CONFIDENCE = 0.5


@dataclass
class ExtractedLineItem:
    description: str
    quantity: float | None = None
    unit_price: float | None = None
    amount: float | None = None
    confidence: float = 0.0


@dataclass
class ExtractionResult:
    method: str  # "llm" | "heuristic"
    fields: dict = field(default_factory=dict)  # field name -> value
    field_confidence: dict = field(default_factory=dict)  # field name -> 0..1
    line_items: list[ExtractedLineItem] = field(default_factory=list)


INVOICE_TOOL = {
    "name": "record_invoice",
    "description": "Record structured data extracted from an invoice, with a self-reported confidence (0.0-1.0) for every field.",
    "input_schema": {
        "type": "object",
        "properties": {
            "vendor_name": {"type": "string"},
            "vendor_name_confidence": {"type": "number"},
            "invoice_number": {"type": "string"},
            "invoice_number_confidence": {"type": "number"},
            "invoice_date": {"type": "string", "description": "ISO format YYYY-MM-DD, empty string if unknown"},
            "invoice_date_confidence": {"type": "number"},
            "due_date": {"type": "string", "description": "ISO format YYYY-MM-DD, empty string if unknown/absent"},
            "due_date_confidence": {"type": "number"},
            "po_reference": {"type": "string", "description": "Purchase order number/reference, empty string if absent"},
            "po_reference_confidence": {"type": "number"},
            "currency": {"type": "string", "description": "ISO currency code, e.g. USD"},
            "subtotal": {"type": "number"},
            "subtotal_confidence": {"type": "number"},
            "tax": {"type": "number"},
            "tax_confidence": {"type": "number"},
            "total": {"type": "number"},
            "total_confidence": {"type": "number"},
            "line_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "description": {"type": "string"},
                        "quantity": {"type": "number"},
                        "unit_price": {"type": "number"},
                        "amount": {"type": "number"},
                        "confidence": {"type": "number"},
                    },
                    "required": ["description"],
                },
            },
        },
        "required": [
            "vendor_name",
            "invoice_number",
            "invoice_date",
            "total",
            "line_items",
        ],
    },
}

EXTRACTION_PROMPT = """You are an accounts-payable data entry specialist. Below is raw OCR text \
extracted from a scanned invoice. OCR errors (misread characters, broken lines, stray \
whitespace) are expected -- use context to recover the correct values.

Call the `record_invoice` tool with the extracted fields. For every *_confidence field, \
report your genuine confidence (0.0 to 1.0) that the value is correct, based on how \
legible/unambiguous the source text was. If a field is not present in the document, use \
an empty string (or 0 for numbers) and a low confidence.

OCR text:
---
{ocr_text}
---
"""


def extract(ocr_text: str) -> ExtractionResult:
    settings = get_settings()
    if settings.anthropic_api_key:
        try:
            return _extract_with_llm(ocr_text, settings)
        except Exception:
            # Fall back rather than fail the whole pipeline on a transient
            # API error; the low heuristic confidence will route it to review.
            return _extract_heuristic(ocr_text)
    return _extract_heuristic(ocr_text)


def _extract_with_llm(ocr_text: str, settings) -> ExtractionResult:
    import anthropic

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    response = client.messages.create(
        model=settings.anthropic_model,
        max_tokens=4096,
        tools=[INVOICE_TOOL],
        tool_choice={"type": "tool", "name": "record_invoice"},
        messages=[{"role": "user", "content": EXTRACTION_PROMPT.format(ocr_text=ocr_text[:15000])}],
    )

    tool_use = next(block for block in response.content if block.type == "tool_use")
    data = tool_use.input

    fields = {
        "vendor_name": data.get("vendor_name", "") or "",
        "invoice_number": data.get("invoice_number", "") or "",
        "invoice_date": _clean_date(data.get("invoice_date")),
        "due_date": _clean_date(data.get("due_date")),
        "po_reference": data.get("po_reference", "") or "",
        "currency": data.get("currency", "") or "USD",
        "subtotal": _clean_number(data.get("subtotal")),
        "tax": _clean_number(data.get("tax")),
        "total": _clean_number(data.get("total")),
    }
    field_confidence = {
        f: _clamp01(data.get(f"{f}_confidence", 0.0)) for f in FIELDS if f != "currency"
    }
    field_confidence["currency"] = 1.0 if fields["currency"] else 0.0

    line_items = [
        ExtractedLineItem(
            description=item.get("description", ""),
            quantity=_clean_number(item.get("quantity")),
            unit_price=_clean_number(item.get("unit_price")),
            amount=_clean_number(item.get("amount")),
            confidence=_clamp01(item.get("confidence", 0.0)),
        )
        for item in data.get("line_items", [])
    ]

    return ExtractionResult(
        method="llm", fields=fields, field_confidence=field_confidence, line_items=line_items
    )


def _extract_heuristic(ocr_text: str) -> ExtractionResult:
    fields = {name: "" for name in FIELDS}
    fields["currency"] = "USD"
    field_confidence = {name: 0.0 for name in FIELDS}
    field_confidence["currency"] = HEURISTIC_FIELD_CONFIDENCE

    lines = [ln.strip() for ln in ocr_text.splitlines() if ln.strip()]
    if lines:
        fields["vendor_name"] = lines[0][:512]
        field_confidence["vendor_name"] = HEURISTIC_FIELD_CONFIDENCE

    inv_match = re.search(r"invoice\s*(?:#|no\.?|number)?\s*[:\-]?\s*([A-Za-z0-9\-]{2,})", ocr_text, re.I)
    if inv_match:
        fields["invoice_number"] = inv_match.group(1)
        field_confidence["invoice_number"] = HEURISTIC_FIELD_CONFIDENCE

    date_match = re.search(r"\b(\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4})\b", ocr_text)
    if date_match:
        fields["invoice_date"] = _normalize_loose_date(date_match.group(1))
        field_confidence["invoice_date"] = HEURISTIC_FIELD_CONFIDENCE

    po_match = re.search(r"\bP\.?O\.?\s*(?:#|no\.?|number)?\s*[:\-]?\s*([A-Za-z0-9\-]{2,})", ocr_text, re.I)
    if po_match:
        fields["po_reference"] = po_match.group(1)
        field_confidence["po_reference"] = HEURISTIC_FIELD_CONFIDENCE

    total_match = re.search(
        r"(?<!sub)(?<!sub-)(?<!sub )total\s*(?:due|amount)?\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})", ocr_text, re.I
    )
    if total_match:
        fields["total"] = float(total_match.group(1).replace(",", ""))
        field_confidence["total"] = HEURISTIC_FIELD_CONFIDENCE

    subtotal_match = re.search(r"sub\s*-?\s*total\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})", ocr_text, re.I)
    if subtotal_match:
        fields["subtotal"] = float(subtotal_match.group(1).replace(",", ""))
        field_confidence["subtotal"] = HEURISTIC_FIELD_CONFIDENCE

    tax_match = re.search(r"tax\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})", ocr_text, re.I)
    if tax_match:
        fields["tax"] = float(tax_match.group(1).replace(",", ""))
        field_confidence["tax"] = HEURISTIC_FIELD_CONFIDENCE

    line_items = []
    for ln in lines:
        m = re.match(
            r"^(?P<desc>.{3,80}?)\s+(?P<qty>\d+(?:\.\d+)?)\s*[x@]?\s*\$?(?P<price>[\d,]+\.\d{2})\s+\$?(?P<amount>[\d,]+\.\d{2})$",
            ln,
        )
        if m:
            line_items.append(
                ExtractedLineItem(
                    description=m.group("desc").strip(),
                    quantity=float(m.group("qty")),
                    unit_price=float(m.group("price").replace(",", "")),
                    amount=float(m.group("amount").replace(",", "")),
                    confidence=HEURISTIC_FIELD_CONFIDENCE,
                )
            )

    return ExtractionResult(
        method="heuristic", fields=fields, field_confidence=field_confidence, line_items=line_items
    )


def _clean_number(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _clean_date(value) -> str:
    if not value:
        return ""
    if re.match(r"^\d{4}-\d{2}-\d{2}$", str(value)):
        return value
    return _normalize_loose_date(str(value))


def _normalize_loose_date(value: str) -> str:
    from datetime import datetime as dt

    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return dt.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def _clamp01(value) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0
