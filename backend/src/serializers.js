// Converts Sequelize model instances (camelCase attributes) into the
// snake_case JSON shapes the frontend (ported as-is from the Python
// backend) expects.

import { accountClassification, subtypeLabel } from "./accountTaxonomy.js";

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

// Payments recorded against a bill, summarised for display. Cents are
// summed as integers and converted once at the end, the same rule the
// ledger follows -- summing dollars as floats is how a penny goes missing.
function paymentSummary(inv) {
  const payments = inv.billPayments || [];
  const paidCents = payments.reduce((sum, p) => sum + (p.amountCents || 0), 0);
  const totalCents = Math.round((Number(inv.total) || 0) * 100);
  return {
    amount_paid: Math.round(paidCents) / 100,
    payment_count: payments.length,
    // "partial" is its own state on purpose: a bill with one of three
    // instalments against it is neither paid nor unpaid, and collapsing it
    // into either is how somebody pays a bill twice.
    payment_status: paidCents <= 0 ? "unpaid" : paidCents + 1 >= totalCents ? "paid" : "partial",
  };
}

// A charge as a percentage of the subtotal, to one decimal place. Returns
// null when there is nothing meaningful to divide by, so a caller can leave
// the line off rather than render "0.0%" as though it were measured.
function ratePercent(amount, subtotal) {
  const a = Number(amount);
  const base = Number(subtotal);
  if (!Number.isFinite(a) || !Number.isFinite(base) || base === 0 || !a) return null;
  return Math.round((Math.abs(a) / Math.abs(base)) * 1000) / 10;
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
    shipping: inv.shipping,
    discount: inv.discount,
    other_charges: inv.otherCharges ?? [],
    tax: inv.tax,
    payment_terms: inv.paymentTerms,
    total: inv.total,

    // Derived, never stored: a rate is a fact about two figures that are
    // already on the record, and storing it would give it its own chance to
    // drift out of step with them. Null rather than 0 when there is no
    // subtotal to divide by, so the UI can omit the line instead of
    // printing a confident "0.0%".
    tax_rate_percent: ratePercent(inv.tax, inv.subtotal),
    discount_rate_percent: ratePercent(inv.discount, inv.subtotal),

    // Whether the bill has actually been paid, from the payments recorded
    // against it (accountsPayable.js) rather than from a status flag that
    // would have to be kept in step with them. Present only where the
    // caller loaded the association; a detail route that didn't is
    // reporting "no payments", which is the honest reading of an invoice
    // whose payments were never fetched only because every detail route
    // does fetch them.
    ...paymentSummary(inv),

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
    is_sample_data: inv.isSampleData,

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
    is_sample_data: inv.isSampleData,
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

export function serializeTaxDocumentDetail(t) {
  return {
    id: t.id,
    original_filename: t.originalFilename,
    content_type: t.contentType,
    status: t.status,
    error_message: t.errorMessage,

    document_type: t.documentType,
    tax_year: t.taxYear,
    payer_name: t.payerName,
    recipient_name: t.recipientName,
    // Already only four digits by the time it's stored -- see
    // TaxDocument.js's recipientTinLast4 comment. Nothing is masked on the
    // way out here because there's nothing left to mask.
    recipient_tin_last4: t.recipientTinLast4,
    amount: t.amount,
    federal_tax_withheld: t.federalTaxWithheld,
    note: t.note,

    extraction_method: t.extractionMethod,
    field_confidence: t.fieldConfidence,
    overall_confidence: t.overallConfidence,

    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

export function serializeCheckDetail(c) {
  return {
    id: c.id,
    original_filename: c.originalFilename,
    content_type: c.contentType,
    status: c.status,
    error_message: c.errorMessage,

    check_number: c.checkNumber,
    check_date: c.checkDate,
    payee_name: c.payeeName,
    amount: c.amount,
    memo: c.memo,
    bank_name: c.bankName,
    // Already only four digits by the time it's stored -- see Check.js's
    // accountLast4 comment. Nothing is masked on the way out here because
    // there's nothing left to mask, and the routing number was never
    // stored at all.
    account_last4: c.accountLast4,

    invoice_id: c.invoiceId,
    bill_payment_id: c.billPaymentId,
    note: c.note,

    extraction_method: c.extractionMethod,
    field_confidence: c.fieldConfidence,
    overall_confidence: c.overallConfidence,

    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

export function serializeCheckListItem(c) {
  return {
    id: c.id,
    original_filename: c.originalFilename,
    status: c.status,
    check_number: c.checkNumber,
    check_date: c.checkDate,
    payee_name: c.payeeName,
    amount: c.amount,
    memo: c.memo,
    invoice_id: c.invoiceId,
    overall_confidence: c.overallConfidence,
    created_at: c.createdAt,
  };
}

export function serializeTaxDocumentListItem(t) {
  return {
    id: t.id,
    original_filename: t.originalFilename,
    status: t.status,
    document_type: t.documentType,
    tax_year: t.taxYear,
    payer_name: t.payerName,
    recipient_name: t.recipientName,
    recipient_tin_last4: t.recipientTinLast4,
    amount: t.amount,
    federal_tax_withheld: t.federalTaxWithheld,
    overall_confidence: t.overallConfidence,
    created_at: t.createdAt,
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

export function serializeBankAccount(a) {
  return {
    id: a.id,
    connection_id: a.connectionId,
    name: a.name,
    official_name: a.officialName,
    mask: a.mask,
    type: a.accountType,
    subtype: a.accountSubtype,
    current_balance: a.currentBalance,
    available_balance: a.availableBalance,
    currency: a.currency,
    last_synced_at: a.lastSyncedAt,
    match_source_id: a.matchSourceId,
  };
}

export function serializeBankConnection(c) {
  return {
    id: c.id,
    institution_name: c.institutionName,
    status: c.status,
    created_at: c.createdAt,
    accounts: (c.accounts || []).map(serializeBankAccount),
  };
}

export function serializeUser(user) {
  return {
    id: user.id,
    org_id: user.orgId,
    email: user.email,
    full_name: user.fullName,
    role: user.role,
    two_factor_enabled: user.totpEnabled,
  };
}

export function serializeNetWorthAccount(a) {
  return {
    id: a.id,
    name: a.name,
    category: a.category,
    current_balance: a.currentBalance,
    notes: a.notes,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

export function serializeAccount(a) {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    subtype: a.subtype,
    subtype_label: subtypeLabel(a.type, a.subtype),
    classification: accountClassification(a.type, a.subtype),
    is_system_account: a.isSystemAccount,
    active: a.active,
  };
}

// centsToDollars is deliberately not imported here -- ledger.js owns the
// cents<->dollars boundary, and a line's amount is already handed to this
// serializer as a dollar float by the route, same as every other money
// field this app serializes.
export function serializeJournalLine(line) {
  return {
    id: line.id,
    account_id: line.accountId,
    account_name: line.account?.name,
    debit: line.debit,
    credit: line.credit,
    memo: line.memo,
  };
}

export function serializeJournalEntryDetail(entry, lines) {
  return {
    id: entry.id,
    entry_date: entry.entryDate,
    memo: entry.memo,
    source: entry.source,
    source_type: entry.sourceType,
    source_id: entry.sourceId,
    status: entry.status,
    voided_by_entry_id: entry.voidedByEntryId,
    lines,
    created_at: entry.createdAt,
  };
}

export function serializeJournalEntryListItem(entry, totalDebit) {
  return {
    id: entry.id,
    entry_date: entry.entryDate,
    memo: entry.memo,
    source: entry.source,
    status: entry.status,
    total: totalDebit,
    created_at: entry.createdAt,
  };
}
