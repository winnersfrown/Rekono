from datetime import date, datetime

from pydantic import BaseModel, ConfigDict


class LineItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    position: int
    description: str
    quantity: float | None
    unit_price: float | None
    amount: float | None
    confidence: float


class LineItemIn(BaseModel):
    description: str
    quantity: float | None = None
    unit_price: float | None = None
    amount: float | None = None


class MatchResultOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    invoice_id: str
    match_entry_id: str | None
    status: str
    score: float
    reasoning: str


class InvoiceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    original_filename: str
    content_type: str
    status: str
    error_message: str

    vendor_name: str
    invoice_number: str
    invoice_date: date | None
    due_date: date | None
    currency: str
    po_reference: str

    subtotal: float | None
    tax: float | None
    total: float | None

    extraction_method: str
    field_confidence: dict
    overall_confidence: float
    cross_check_passed: bool
    cross_check_detail: str

    created_at: datetime
    updated_at: datetime

    line_items: list[LineItemOut] = []
    match_results: list[MatchResultOut] = []


class InvoiceListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    original_filename: str
    status: str
    vendor_name: str
    invoice_number: str
    invoice_date: date | None
    total: float | None
    overall_confidence: float
    created_at: datetime


class InvoiceCorrection(BaseModel):
    vendor_name: str | None = None
    invoice_number: str | None = None
    invoice_date: date | None = None
    due_date: date | None = None
    currency: str | None = None
    po_reference: str | None = None
    subtotal: float | None = None
    tax: float | None = None
    total: float | None = None
    line_items: list[LineItemIn] | None = None


class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    action: str
    actor: str
    details: dict
    created_at: datetime


class MatchSourceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    source_type: str
    uploaded_at: datetime
    entry_count: int = 0


class MatchRunSummary(BaseModel):
    invoices_evaluated: int
    matched: int
    partial: int
    unmatched: int
