import io

import pandas as pd
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import auth
from ..database import get_db
from ..models import Invoice, MatchResult, User

router = APIRouter(prefix="/api/export", tags=["export"])


def _build_dataframe(db: Session, org_id: str) -> pd.DataFrame:
    invoices = db.scalars(
        select(Invoice).where(Invoice.org_id == org_id).order_by(Invoice.created_at.desc())
    ).all()

    latest_match_by_invoice: dict[str, MatchResult] = {}
    match_stmt = (
        select(MatchResult)
        .join(Invoice, MatchResult.invoice_id == Invoice.id)
        .where(Invoice.org_id == org_id)
        .order_by(MatchResult.created_at)
    )
    for mr in db.scalars(match_stmt).all():
        latest_match_by_invoice[mr.invoice_id] = mr  # last write wins -> most recent run

    rows = []
    for inv in invoices:
        match = latest_match_by_invoice.get(inv.id)
        rows.append(
            {
                "invoice_id": inv.id,
                "status": inv.status.value if hasattr(inv.status, "value") else inv.status,
                "vendor_name": inv.vendor_name,
                "invoice_number": inv.invoice_number,
                "invoice_date": inv.invoice_date,
                "due_date": inv.due_date,
                "po_reference": inv.po_reference,
                "currency": inv.currency,
                "subtotal": inv.subtotal,
                "tax": inv.tax,
                "total": inv.total,
                "line_item_count": len(inv.line_items),
                "extraction_method": inv.extraction_method,
                "overall_confidence": inv.overall_confidence,
                "cross_check_passed": inv.cross_check_passed,
                "match_status": match.status.value if match and hasattr(match.status, "value") else (match.status if match else ""),
                "match_score": match.score if match else None,
                "original_filename": inv.original_filename,
                "created_at": inv.created_at,
            }
        )
    return pd.DataFrame(rows)


@router.get("/csv")
def export_csv(db: Session = Depends(get_db), current_user: User = Depends(auth.get_current_user)):
    df = _build_dataframe(db, current_user.org_id)
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=rekono_invoices.csv"},
    )


@router.get("/xlsx")
def export_xlsx(db: Session = Depends(get_db), current_user: User = Depends(auth.get_current_user)):
    df = _build_dataframe(db, current_user.org_id)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Invoices")
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=rekono_invoices.xlsx"},
    )
