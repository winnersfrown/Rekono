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
    status: mr.status,
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
