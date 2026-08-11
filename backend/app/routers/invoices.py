from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import auth
from ..database import get_db
from ..models import AuditLog, Invoice, InvoiceStatus, LineItem, User
from ..schemas import AuditLogOut, InvoiceCorrection, InvoiceListItem, InvoiceOut

router = APIRouter(prefix="/api/invoices", tags=["invoices"])


def _get_or_404(db: Session, invoice_id: str, org_id: str) -> Invoice:
    invoice = db.get(Invoice, invoice_id)
    if invoice is None or invoice.org_id != org_id:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return invoice


@router.get("", response_model=list[InvoiceListItem])
def list_invoices(
    status: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth.get_current_user),
):
    stmt = select(Invoice).where(Invoice.org_id == current_user.org_id).order_by(Invoice.created_at.desc())
    if status:
        stmt = stmt.where(Invoice.status == status)
    return db.scalars(stmt).all()


@router.get("/{invoice_id}", response_model=InvoiceOut)
def get_invoice(
    invoice_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth.get_current_user),
):
    return _get_or_404(db, invoice_id, current_user.org_id)


@router.get("/{invoice_id}/file")
def get_invoice_file(
    invoice_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth.get_current_user),
):
    invoice = _get_or_404(db, invoice_id, current_user.org_id)
    return FileResponse(invoice.storage_path, media_type=invoice.content_type or None)


@router.get("/{invoice_id}/audit-log", response_model=list[AuditLogOut])
def get_audit_log(
    invoice_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth.get_current_user),
):
    _get_or_404(db, invoice_id, current_user.org_id)
    stmt = select(AuditLog).where(AuditLog.invoice_id == invoice_id).order_by(AuditLog.created_at)
    return db.scalars(stmt).all()


@router.patch("/{invoice_id}", response_model=InvoiceOut)
def correct_invoice(
    invoice_id: str,
    correction: InvoiceCorrection,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth.get_current_user),
):
    invoice = _get_or_404(db, invoice_id, current_user.org_id)

    changed: dict = {}
    simple_fields = [
        "vendor_name",
        "invoice_number",
        "invoice_date",
        "due_date",
        "currency",
        "po_reference",
        "subtotal",
        "tax",
        "total",
    ]
    payload = correction.model_dump(exclude_unset=True, exclude={"line_items"})
    for field_name in simple_fields:
        if field_name in payload:
            old_value = getattr(invoice, field_name)
            new_value = payload[field_name]
            new_value_str = new_value.isoformat() if hasattr(new_value, "isoformat") else new_value
            old_value_str = old_value.isoformat() if hasattr(old_value, "isoformat") else old_value
            if old_value_str != new_value_str:
                changed[field_name] = {"old": old_value_str, "new": new_value_str}
                setattr(invoice, field_name, new_value)

    if correction.line_items is not None:
        changed["line_items"] = {"count": len(correction.line_items)}
        invoice.line_items.clear()
        for i, li in enumerate(correction.line_items):
            invoice.line_items.append(
                LineItem(
                    invoice_id=invoice.id,
                    position=i,
                    description=li.description,
                    quantity=li.quantity,
                    unit_price=li.unit_price,
                    amount=li.amount,
                    confidence=1.0,  # human-entered
                )
            )

    if changed:
        db.add(
            AuditLog(
                org_id=current_user.org_id,
                user_id=current_user.id,
                invoice_id=invoice.id,
                action="human_correction",
                actor=current_user.email,
                details=changed,
            )
        )
        db.commit()
        db.refresh(invoice)

    return invoice


@router.post("/{invoice_id}/approve", response_model=InvoiceOut)
def approve_invoice(
    invoice_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth.get_current_user),
):
    invoice = _get_or_404(db, invoice_id, current_user.org_id)
    if invoice.status not in (InvoiceStatus.EXTRACTED, InvoiceStatus.NEEDS_REVIEW):
        raise HTTPException(status_code=409, detail=f"Cannot approve invoice in status {invoice.status}")
    invoice.status = InvoiceStatus.APPROVED
    db.add(
        AuditLog(
            org_id=current_user.org_id,
            user_id=current_user.id,
            invoice_id=invoice.id,
            action="approved",
            actor=current_user.email,
            details={},
        )
    )
    db.commit()
    db.refresh(invoice)
    return invoice


@router.post("/{invoice_id}/reject", response_model=InvoiceOut)
def reject_invoice(
    invoice_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth.get_current_user),
):
    invoice = _get_or_404(db, invoice_id, current_user.org_id)
    invoice.status = InvoiceStatus.REJECTED
    db.add(
        AuditLog(
            org_id=current_user.org_id,
            user_id=current_user.id,
            invoice_id=invoice.id,
            action="rejected",
            actor=current_user.email,
            details={},
        )
    )
    db.commit()
    db.refresh(invoice)
    return invoice
