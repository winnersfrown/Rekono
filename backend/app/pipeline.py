"""The end-to-end extraction pipeline run for each queued invoice:
OCR -> LLM/heuristic structured extraction -> confidence scoring -> persist.

Runs inside a background worker thread (see jobs.py), so it opens its own
DB session rather than sharing a request-scoped one.
"""

import logging

from . import confidence as confidence_module
from . import extraction as extraction_module
from . import ocr as ocr_module
from .config import get_settings
from .database import SessionLocal
from .models import AuditLog, Invoice, InvoiceStatus, LineItem

logger = logging.getLogger("rekono.pipeline")


def process_invoice(invoice_id: str) -> None:
    db = SessionLocal()
    try:
        invoice = db.get(Invoice, invoice_id)
        if invoice is None:
            logger.warning("process_invoice: invoice %s not found", invoice_id)
            return

        invoice.status = InvoiceStatus.PROCESSING
        db.commit()

        try:
            ocr_text = ocr_module.extract_text(invoice.storage_path, invoice.content_type)
        except ocr_module.OcrError as exc:
            _fail(db, invoice, f"OCR failed: {exc}")
            return

        invoice.raw_ocr_text = ocr_text
        if not ocr_text.strip():
            _fail(db, invoice, "OCR produced no text (image may be blank, unreadable, or unsupported).")
            return

        result = extraction_module.extract(ocr_text)
        report = confidence_module.score(result)

        invoice.vendor_name = result.fields.get("vendor_name", "")
        invoice.invoice_number = result.fields.get("invoice_number", "")
        invoice.invoice_date = _parse_date(result.fields.get("invoice_date"))
        invoice.due_date = _parse_date(result.fields.get("due_date"))
        invoice.currency = result.fields.get("currency") or "USD"
        invoice.po_reference = result.fields.get("po_reference", "")
        invoice.subtotal = result.fields.get("subtotal")
        invoice.tax = result.fields.get("tax")
        invoice.total = result.fields.get("total")

        invoice.extraction_method = result.method
        invoice.field_confidence = result.field_confidence
        invoice.overall_confidence = report.overall_confidence
        invoice.cross_check_passed = report.cross_check_passed
        invoice.cross_check_detail = report.cross_check_detail

        invoice.line_items.clear()
        for i, li in enumerate(result.line_items):
            invoice.line_items.append(
                LineItem(
                    invoice_id=invoice.id,
                    position=i,
                    description=li.description,
                    quantity=li.quantity,
                    unit_price=li.unit_price,
                    amount=li.amount,
                    confidence=li.confidence,
                )
            )

        settings = get_settings()
        flagged = report.overall_confidence < settings.review_confidence_threshold or not report.cross_check_passed
        invoice.status = InvoiceStatus.NEEDS_REVIEW if flagged else InvoiceStatus.EXTRACTED

        db.add(
            AuditLog(
                org_id=invoice.org_id,
                invoice_id=invoice.id,
                action="extraction_completed",
                actor="system",
                details={
                    "method": result.method,
                    "overall_confidence": report.overall_confidence,
                    "cross_check_passed": report.cross_check_passed,
                    "cross_check_detail": report.cross_check_detail,
                },
            )
        )
        db.commit()
    except Exception as exc:  # noqa: BLE001 - last-resort guard so the worker thread never dies
        logger.exception("process_invoice failed for %s", invoice_id)
        db.rollback()
        invoice = db.get(Invoice, invoice_id)
        if invoice is not None:
            _fail(db, invoice, f"Unexpected error: {exc}")
    finally:
        db.close()


def _fail(db, invoice: Invoice, message: str) -> None:
    invoice.status = InvoiceStatus.FAILED
    invoice.error_message = message
    db.add(
        AuditLog(
            org_id=invoice.org_id,
            invoice_id=invoice.id,
            action="extraction_failed",
            actor="system",
            details={"error": message},
        )
    )
    db.commit()


def _parse_date(value):
    if not value:
        return None
    from datetime import date as date_cls

    try:
        return date_cls.fromisoformat(value)
    except ValueError:
        return None
