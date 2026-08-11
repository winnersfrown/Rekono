from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from .. import jobs, storage
from ..database import get_db
from ..models import AuditLog, Invoice, InvoiceStatus
from ..schemas import InvoiceOut

router = APIRouter(prefix="/api/invoices", tags=["ingestion"])


@router.post("/upload", response_model=InvoiceOut, status_code=201)
def upload_invoice(file: UploadFile, db: Session = Depends(get_db)):
    try:
        storage_path, content_type = storage.save_upload(file)
    except storage.UnsupportedFileType as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    invoice = Invoice(
        original_filename=file.filename or "upload",
        storage_path=storage_path,
        content_type=content_type,
        status=InvoiceStatus.QUEUED,
    )
    db.add(invoice)
    db.flush()
    db.add(AuditLog(invoice_id=invoice.id, action="uploaded", actor="user", details={"filename": invoice.original_filename}))
    db.commit()
    db.refresh(invoice)

    jobs.enqueue(invoice.id)

    return invoice
