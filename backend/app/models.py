import enum
import uuid
from datetime import datetime, date

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class InvoiceStatus(str, enum.Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    EXTRACTED = "extracted"  # high confidence, cross-check passed - fast-track review
    NEEDS_REVIEW = "needs_review"  # low confidence or failed cross-check - flagged
    APPROVED = "approved"
    REJECTED = "rejected"
    FAILED = "failed"


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    original_filename: Mapped[str] = mapped_column(String(512))
    storage_path: Mapped[str] = mapped_column(String(1024))
    content_type: Mapped[str] = mapped_column(String(128), default="")
    status: Mapped[InvoiceStatus] = mapped_column(
        Enum(InvoiceStatus), default=InvoiceStatus.QUEUED, index=True
    )
    error_message: Mapped[str] = mapped_column(Text, default="")

    vendor_name: Mapped[str] = mapped_column(String(512), default="")
    invoice_number: Mapped[str] = mapped_column(String(256), default="")
    invoice_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    currency: Mapped[str] = mapped_column(String(16), default="USD")
    po_reference: Mapped[str] = mapped_column(String(256), default="")

    subtotal: Mapped[float | None] = mapped_column(Float, nullable=True)
    tax: Mapped[float | None] = mapped_column(Float, nullable=True)
    total: Mapped[float | None] = mapped_column(Float, nullable=True)

    raw_ocr_text: Mapped[str] = mapped_column(Text, default="")
    extraction_method: Mapped[str] = mapped_column(String(32), default="")  # "llm" | "heuristic"
    field_confidence: Mapped[dict] = mapped_column(JSON, default=dict)
    overall_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    cross_check_passed: Mapped[bool] = mapped_column(Boolean, default=False)
    cross_check_detail: Mapped[str] = mapped_column(Text, default="")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    line_items: Mapped[list["LineItem"]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan", order_by="LineItem.position"
    )
    audit_logs: Mapped[list["AuditLog"]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan"
    )
    match_results: Mapped[list["MatchResult"]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan"
    )


class LineItem(Base):
    __tablename__ = "line_items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    invoice_id: Mapped[str] = mapped_column(ForeignKey("invoices.id"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    description: Mapped[str] = mapped_column(String(1024), default="")
    quantity: Mapped[float | None] = mapped_column(Float, nullable=True)
    unit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)

    invoice: Mapped[Invoice] = relationship(back_populates="line_items")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    invoice_id: Mapped[str | None] = mapped_column(ForeignKey("invoices.id"), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(128))
    actor: Mapped[str] = mapped_column(String(256), default="system")
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    invoice: Mapped[Invoice | None] = relationship(back_populates="audit_logs")


class MatchSourceType(str, enum.Enum):
    PO = "po"
    BANK = "bank"


class MatchSource(Base):
    __tablename__ = "match_sources"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(512))
    source_type: Mapped[MatchSourceType] = mapped_column(Enum(MatchSourceType))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    entries: Mapped[list["MatchEntry"]] = relationship(
        back_populates="source", cascade="all, delete-orphan"
    )


class MatchEntry(Base):
    __tablename__ = "match_entries"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    source_id: Mapped[str] = mapped_column(ForeignKey("match_sources.id"), index=True)
    vendor: Mapped[str] = mapped_column(String(512), default="")
    amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    entry_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    reference: Mapped[str] = mapped_column(String(256), default="")
    raw_row: Mapped[dict] = mapped_column(JSON, default=dict)

    source: Mapped[MatchSource] = relationship(back_populates="entries")


class MatchStatus(str, enum.Enum):
    MATCHED = "matched"
    PARTIAL = "partial"
    UNMATCHED = "unmatched"


class MatchResult(Base):
    __tablename__ = "match_results"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    invoice_id: Mapped[str] = mapped_column(ForeignKey("invoices.id"), index=True)
    match_entry_id: Mapped[str | None] = mapped_column(ForeignKey("match_entries.id"), nullable=True)
    status: Mapped[MatchStatus] = mapped_column(Enum(MatchStatus))
    score: Mapped[float] = mapped_column(Float, default=0.0)
    reasoning: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    invoice: Mapped[Invoice] = relationship(back_populates="match_results")
    match_entry: Mapped[MatchEntry | None] = relationship()
