// Converts Sequelize model instances (camelCase attributes) into the
// snake_case JSON shapes the frontend (ported as-is from the Python
// backend) expects.

export function serializeLineItem(li) {
  return {
    id: li.id,
    position: li.position,
    description: li.description,
    quantity: li.quantity,
    unit_price: li.unitPrice,
    amount: li.amount,
    confidence: li.confidence,
  };
}

export function serializeMatchResult(mr) {
  return {
    id: mr.id,
    invoice_id: mr.invoiceId,
    match_entry_id: mr.matchEntryId,
    receiving_entry_id: mr.receivingEntryId,
    status: mr.status,
    // null on a result from a two-way run -- see MatchResult.js.
    three_way_outcome: mr.threeWayOutcome,
    score: mr.score,
    reasoning: mr.reasoning,
  };
}

export function serializeInvoiceDetail(inv) {
  return {
    id: inv.id,
    original_filename: inv.originalFilename,
    content_type: inv.contentType,
    status: inv.status,
    error_message: inv.errorMessage,

    vendor_name: inv.vendorName,
    invoice_number: inv.invoiceNumber,
    invoice_date: inv.invoiceDate,
    due_date: inv.dueDate,
    currency: inv.currency,
    po_reference: inv.poReference,

    subtotal: inv.subtotal,
    tax: inv.tax,
    total: inv.total,

    extraction_method: inv.extractionMethod,
    field_confidence: inv.fieldConfidence,
    overall_confidence: inv.overallConfidence,
    cross_check_passed: inv.crossCheckPassed,
    cross_check_detail: inv.crossCheckDetail,

    duplicate_of_invoice_id: inv.duplicateOfInvoiceId,
    duplicate_of_filename: inv.duplicateOfFilename,

    possible_multi_invoice: inv.possibleMultiInvoice,
    possible_multi_invoice_reason: inv.possibleMultiInvoiceReason,

    quickbooks_bill_id: inv.quickbooksBillId,
    quickbooks_expense_account_id: inv.quickbooksExpenseAccountId,
    quickbooks_expense_account_name: inv.quickbooksExpenseAccountName,
    quickbooks_expense_account_confidence: inv.quickbooksExpenseAccountConfidence,
    quickbooks_paid_at: inv.quickbooksPaidAt,
    quickbooks_payment_transaction_id: inv.quickbooksPaymentTransactionId,

    created_at: inv.createdAt,
    updated_at: inv.updatedAt,

    line_items: (inv.lineItems || []).map(serializeLineItem),
    match_results: (inv.matchResults || []).map(serializeMatchResult),
  };
}

export function serializeInvoiceListItem(inv) {
  return {
    id: inv.id,
    original_filename: inv.originalFilename,
    status: inv.status,
    vendor_name: inv.vendorName,
    invoice_number: inv.invoiceNumber,
    invoice_date: inv.invoiceDate,
    total: inv.total,
    overall_confidence: inv.overallConfidence,
    created_at: inv.createdAt,
  };
}

export function serializeExpenseReceiptDetail(r) {
  return {
    id: r.id,
    original_filename: r.originalFilename,
    content_type: r.contentType,
    status: r.status,
    error_message: r.errorMessage,

    merchant_name: r.merchantName,
    receipt_date: r.receiptDate,
    category: r.category,
    currency: r.currency,
    tax: r.tax,
    amount: r.amount,
    note: r.note,

    extraction_method: r.extractionMethod,
    field_confidence: r.fieldConfidence,
    overall_confidence: r.overallConfidence,

    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

export function serializeExpenseReceiptListItem(r) {
  return {
    id: r.id,
    original_filename: r.originalFilename,
    status: r.status,
    merchant_name: r.merchantName,
    category: r.category,
    receipt_date: r.receiptDate,
    amount: r.amount,
    overall_confidence: r.overallConfidence,
    created_at: r.createdAt,
  };
}

export function serializeVendorDocumentDetail(d) {
  return {
    id: d.id,
    original_filename: d.originalFilename,
    content_type: d.contentType,
    status: d.status,
    error_message: d.errorMessage,

    vendor_name: d.vendorName,
    document_type: d.documentType,
    effective_date: d.effectiveDate,
    expiration_date: d.expirationDate,
    reference_number: d.referenceNumber,
    amount: d.amount,
    note: d.note,

    extraction_method: d.extractionMethod,
    field_confidence: d.fieldConfidence,
    overall_confidence: d.overallConfidence,

    created_at: d.createdAt,
    updated_at: d.updatedAt,
  };
}

export function serializeVendorDocumentListItem(d) {
  return {
    id: d.id,
    original_filename: d.originalFilename,
    status: d.status,
    vendor_name: d.vendorName,
    document_type: d.documentType,
    expiration_date: d.expirationDate,
    overall_confidence: d.overallConfidence,
    created_at: d.createdAt,
  };
}

export function serializeLeaseDetail(l) {
  return {
    id: l.id,
    original_filename: l.originalFilename,
    content_type: l.contentType,
    status: l.status,
    error_message: l.errorMessage,

    landlord_name: l.landlordName,
    property_address: l.propertyAddress,
    commencement_date: l.commencementDate,
    expiration_date: l.expirationDate,
    renewal_notice_deadline: l.renewalNoticeDeadline,
    monthly_rent: l.monthlyRent,
    annual_escalation_pct: l.annualEscalationPct,
    note: l.note,

    extraction_method: l.extractionMethod,
    field_confidence: l.fieldConfidence,
    overall_confidence: l.overallConfidence,

    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
}

export function serializeLeaseListItem(l) {
  return {
    id: l.id,
    original_filename: l.originalFilename,
    status: l.status,
    landlord_name: l.landlordName,
    property_address: l.propertyAddress,
    expiration_date: l.expirationDate,
    renewal_notice_deadline: l.renewalNoticeDeadline,
    monthly_rent: l.monthlyRent,
    overall_confidence: l.overallConfidence,
    created_at: l.createdAt,
  };
}

export function serializeAuditLog(entry) {
  return {
    id: entry.id,
    action: entry.action,
    actor: entry.actor,
    details: entry.details,
    created_at: entry.createdAt,
  };
}

export function serializeMatchSource(source, entryCount) {
  return {
    id: source.id,
    name: source.name,
    source_type: source.sourceType,
    uploaded_at: source.uploadedAt,
    entry_count: entryCount,
  };
}

export function serializeUser(user) {
  return {
    id: user.id,
    org_id: user.orgId,
    email: user.email,
    full_name: user.fullName,
    role: user.role,
  };
}
