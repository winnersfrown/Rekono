import io

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import auth
from .. import matching as matching_engine
from ..database import get_db
from ..models import (
    AuditLog,
    Invoice,
    InvoiceStatus,
    MatchEntry,
    MatchResult,
    MatchSource,
    MatchSourceType,
    MatchStatus,
    User,
)
from ..schemas import MatchResultOut, MatchRunSummary, MatchSourceOut

router = APIRouter(prefix="/api/matching", tags=["matching"])

COLUMN_ALIASES = {
    "vendor": {"vendor", "vendor_name", "payee", "supplier", "name"},
    "amount": {"amount", "total", "value"},
    "date": {"date", "entry_date", "transaction_date", "po_date"},
    "reference": {"reference", "po_number", "po_reference", "ref", "check_number", "memo"},
}


def _resolve_columns(df: pd.DataFrame) -> dict[str, str]:
    lower_cols = {c.lower().strip(): c for c in df.columns}
    resolved = {}
    for canonical, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            if alias in lower_cols:
                resolved[canonical] = lower_cols[alias]
                break
    if "vendor" not in resolved or "amount" not in resolved:
        raise HTTPException(
            status_code=422,
            detail=f"CSV must include a vendor/payee column and an amount column. Found columns: {list(df.columns)}",
        )
    return resolved


@router.post("/sources", response_model=MatchSourceOut, status_code=201)
def upload_match_source(
    source_type: str,
    file: UploadFile,
    db: Session = Depends(get_db),
    current_user: User = Depends(auth.get_current_user),
):
    if source_type not in (MatchSourceType.PO.value, MatchSourceType.BANK.value):
        raise HTTPException(status_code=422, detail="source_type must be 'po' or 'bank'")

    raw = file.file.read()
    try:
        df = pd.read_csv(io.BytesIO(raw))
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not parse CSV: {exc}") from exc

    cols = _resolve_columns(df)

    source = MatchSource(
        org_id=current_user.org_id,
        name=file.filename or "upload.csv",
        source_type=MatchSourceType(source_type),
    )
    db.add(source)
    db.flush()

    for _, row in df.iterrows():
        entry_date = None
        if "date" in cols and pd.notna(row.get(cols["date"])):
            parsed = pd.to_datetime(row[cols["date"]], errors="coerce")
            entry_date = parsed.date() if pd.notna(parsed) else None

        amount = None
        if pd.notna(row.get(cols["amount"])):
            try:
                amount = float(str(row[cols["amount"]]).replace("$", "").replace(",", ""))
            except ValueError:
                amount = None

        db.add(
            MatchEntry(
                source_id=source.id,
                vendor=str(row.get(cols["vendor"], "") or ""),
                amount=amount,
                entry_date=entry_date,
                reference=str(row.get(cols.get("reference"), "") or "") if "reference" in cols else "",
                raw_row=row.astype(str).to_dict(),
            )
        )

    db.add(
        AuditLog(
            org_id=current_user.org_id,
            user_id=current_user.id,
            action="match_source_uploaded",
            actor=current_user.email,
            details={"source_type": source_type, "rows": len(df)},
        )
    )
    db.commit()
    db.refresh(source)

    result = MatchSourceOut.model_validate(source)
    result.entry_count = len(df)
    return result


@router.get("/sources", response_model=list[MatchSourceOut])
def list_match_sources(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth.get_current_user),
):
    stmt = select(MatchSource).where(MatchSource.org_id == current_user.org_id)
    sources = db.scalars(stmt).all()
    out = []
    for s in sources:
        item = MatchSourceOut.model_validate(s)
        item.entry_count = len(s.entries)
        out.append(item)
    return out


@router.post("/run", response_model=MatchRunSummary)
def run_matching(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth.get_current_user),
):
    entries = db.scalars(
        select(MatchEntry).join(MatchSource).where(MatchSource.org_id == current_user.org_id)
    ).all()
    candidates = [
        matching_engine.MatchCandidateEntry(
            id=e.id, vendor=e.vendor, amount=e.amount, entry_date=e.entry_date, reference=e.reference
        )
        for e in entries
    ]

    invoices = db.scalars(
        select(Invoice).where(
            Invoice.org_id == current_user.org_id,
            Invoice.status.in_(
                [InvoiceStatus.EXTRACTED, InvoiceStatus.NEEDS_REVIEW, InvoiceStatus.APPROVED]
            ),
        )
    ).all()

    counts = {"matched": 0, "partial": 0, "unmatched": 0}
    for invoice in invoices:
        outcome = matching_engine.find_best_match(
            invoice.vendor_name, invoice.total, invoice.invoice_date, invoice.po_reference, candidates
        )
        db.add(
            MatchResult(
                invoice_id=invoice.id,
                match_entry_id=outcome.entry_id,
                status=MatchStatus(outcome.status),
                score=outcome.score,
                reasoning=outcome.reasoning,
            )
        )
        db.add(
            AuditLog(
                org_id=current_user.org_id,
                user_id=current_user.id,
                invoice_id=invoice.id,
                action="match_evaluated",
                actor=current_user.email,
                details={"status": outcome.status, "score": outcome.score, "reasoning": outcome.reasoning},
            )
        )
        counts[outcome.status] += 1

    db.commit()

    return MatchRunSummary(
        invoices_evaluated=len(invoices),
        matched=counts["matched"],
        partial=counts["partial"],
        unmatched=counts["unmatched"],
    )


@router.get("/results", response_model=list[MatchResultOut])
def list_match_results(
    db: Session = Depends(get_db),
    current_user: User = Depends(auth.get_current_user),
):
    stmt = (
        select(MatchResult)
        .join(Invoice, MatchResult.invoice_id == Invoice.id)
        .where(Invoice.org_id == current_user.org_id)
        .order_by(MatchResult.created_at.desc())
    )
    return db.scalars(stmt).all()
