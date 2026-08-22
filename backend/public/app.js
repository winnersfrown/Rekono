const state = {
  statusFilter: "",
  selectedInvoiceId: null,
  selectedRowIds: new Set(),
  searchQuery: "",
  sortField: "created_at",
  sortOrder: "desc",
  page: 1,
  askHistory: [],
  quickbooksConnected: false,
  quickReviewQueue: [],
  quickReviewTotal: 0,
  expenseStatusFilter: "",
  selectedExpenseId: null,
  expenseSearchQuery: "",
  expenseSortField: "created_at",
  expenseSortOrder: "desc",
  expensePage: 1,
  expenseCategories: [],
  vendordocStatusFilter: "",
  vendordocExpiringOnly: false,
  selectedVendorDocId: null,
  vendordocSearchQuery: "",
  vendordocSortField: "created_at",
  vendordocSortOrder: "desc",
  vendordocPage: 1,
  vendorDocumentTypes: [],
  leaseStatusFilter: "",
  leaseExpiringOnly: false,
  selectedLeaseId: null,
  leaseSearchQuery: "",
  leaseSortField: "created_at",
  leaseSortOrder: "desc",
  leasePage: 1,
};
const MAX_ASK_HISTORY_MESSAGES = 12; // last 6 question/answer exchanges
const QUEUE_PAGE_SIZE = 25;
let docPreviewObjectUrl = null;
let expenseDocPreviewObjectUrl = null;
let vendordocDocPreviewObjectUrl = null;
let leaseDocPreviewObjectUrl = null;

function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

// ---- Confirm modal ----
// Replaces the native confirm()/alert() dialogs (browser chrome, shows the
// raw hostname, can't be styled) with one that matches the rest of the app.
// confirmDialog returns a Promise<boolean> so call sites read the same as
// before: `if (!(await confirmDialog(...))) return;`. alertDialog is the
// same modal with Cancel hidden, for the notice-only case (nothing to
// confirm, just something the user needs to see and dismiss).
let confirmModalResolve = null;

function confirmDialog(title, message, { confirmLabel = "OK", danger = false, hideCancel = false } = {}) {
  return new Promise((resolve) => {
    confirmModalResolve = resolve;
    document.getElementById("confirm-modal-title").textContent = title;
    document.getElementById("confirm-modal-message").textContent = message;
    const confirmBtn = document.getElementById("confirm-modal-confirm");
    confirmBtn.textContent = confirmLabel;
    confirmBtn.classList.toggle("modal-btn-danger", danger);
    document.getElementById("confirm-modal-cancel").style.display = hideCancel ? "none" : "";
    document.getElementById("confirm-modal").style.display = "flex";
  });
}

function alertDialog(title, message) {
  return confirmDialog(title, message, { hideCancel: true });
}

function closeConfirmModal(result) {
  document.getElementById("confirm-modal").style.display = "none";
  if (confirmModalResolve) {
    confirmModalResolve(result);
    confirmModalResolve = null;
  }
}

document.getElementById("confirm-modal-confirm").addEventListener("click", () => closeConfirmModal(true));
document.getElementById("confirm-modal-cancel").addEventListener("click", () => closeConfirmModal(false));
document.getElementById("confirm-modal").addEventListener("click", (e) => {
  if (e.target.id === "confirm-modal") closeConfirmModal(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("confirm-modal").style.display !== "none") closeConfirmModal(false);
});

// ---- Tabs ----
// Sidebar nav items and the ask-hero's quick-action shortcuts both switch
// tabs via [data-tab], but only the sidebar nav (.tab-btn) gets the
// persistent "active" highlight -- a quick-action button is a one-off
// jump, not a place you "are".
function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  const navBtn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (navBtn) navBtn.classList.add("active");
  document.getElementById(`tab-${name}`).classList.add("active");
  // Coming back to the landing tab after approving/uploading elsewhere
  // should show the effect of that work, not a stale snapshot from login.
  if (name === "ask") loadDashboard();
  if (name === "review") loadInvoices();
  if (name === "expenses") loadExpenses();
  if (name === "vendordocs") loadVendorDocs();
  if (name === "leases") loadLeases();
  if (name === "quickreview") loadQuickReviewQueue();
  if (name === "matching") { loadSources(); loadMatchResults(); loadQuickbooksReconciliation(); }
  if (name === "settings") { loadOrgSettings(); loadQuickbooksStatus(); }
  if (name === "team") loadTeam();
}

document.querySelectorAll("[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function fmtMoney(v) {
  if (v === null || v === undefined) return "—";
  return `$${Number(v).toFixed(2)}`;
}

function fmtPct(v) {
  return `${Math.round((v || 0) * 100)}%`;
}

// ---- Upload ----
// Multiple files upload one at a time against the existing single-file
// endpoint (rather than a batch endpoint) so each upload still gets its own
// real-time document-cap check -- a file landing right at the cap correctly
// stops the rest of the batch instead of all-or-nothing accepting a batch
// that oversubscribes the plan.
document.getElementById("upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("file-input");
  const files = Array.from(fileInput.files);
  if (!files.length) return;

  const statusEl = document.getElementById("upload-status");
  let uploaded = 0;
  const failures = [];

  for (const [i, file] of files.entries()) {
    statusEl.textContent =
      files.length > 1 ? `Uploading ${i + 1} of ${files.length}: ${file.name}...` : `Uploading ${file.name}...`;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await apiFetch("/api/invoices/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json();
        failures.push(`${file.name} — ${err.detail || res.statusText}`);
        continue;
      }
      uploaded += 1;
    } catch (err) {
      // Thrown by apiFetch on 401 (session expired) or 402 (onboarding
      // required / plan cap reached / billing lapsed) -- apiFetch already
      // put up the right gate/modal for it, and every one of those blocks
      // every subsequent upload too, so retrying the rest of the batch
      // would just fail the same way file by file. Stop here instead.
      failures.push(`${file.name} — ${err.message || String(err)}`);
      break;
    }
  }

  if (failures.length) {
    const summary = uploaded ? `Uploaded ${uploaded} of ${files.length}. ` : "";
    statusEl.textContent = `${summary}Failed: ${failures.join("; ")}`;
  } else {
    statusEl.textContent =
      uploaded > 1 ? `Uploaded ${uploaded} documents — queued for extraction.` : "Uploaded — queued for extraction.";
  }

  fileInput.value = "";
  // bootstrapApp() already re-runs loadRecentUploads() via onAuthenticated()
  // once it re-confirms the session, alongside refreshing the sidebar's
  // "documents used this month" count -- calling loadRecentUploads() here
  // too would just fire the same GET /api/invoices twice per upload, and
  // doing it once after the whole batch (rather than per file) avoids firing
  // it N times for an N-file batch.
  if (uploaded) {
    invalidateCache("/api/invoices?");
    bootstrapApp();
  }
});

async function loadRecentUploads() {
  await cachedLoad(
    "/api/invoices?page_size=8",
    async () => {
      const res = await apiFetch("/api/invoices?page_size=8");
      const { items } = await res.json();
      return items;
    },
    renderRecentUploads
  );
}

function renderRecentUploads(invoices) {
  const el = document.getElementById("sidebar-recent-uploads");
  el.innerHTML = invoices.map((inv) => (
    `<div class="sidebar-recent-item">
      <button type="button" class="sidebar-recent-open" data-id="${inv.id}">
        <span class="sidebar-recent-name">${escapeHtml(inv.original_filename)}</span>
        <span class="badge status-${inv.status}">${inv.status}</span>
      </button>
      <button type="button" class="sidebar-recent-delete" data-id="${inv.id}" title="Delete" aria-label="Delete ${escapeHtml(inv.original_filename)}">&times;</button>
    </div>`
  )).join("") || `
    <div class="sidebar-recent-empty">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11M12 3l-3.5 3.5M12 3l3.5 3.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
      <p class="hint">Nothing uploaded yet.</p>
    </div>
  `;

  el.querySelectorAll(".sidebar-recent-open").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab("review");
      selectInvoice(btn.dataset.id);
    });
  });
  el.querySelectorAll(".sidebar-recent-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteInvoice(btn.dataset.id));
  });
}

// ---- Review Queue ----
document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.statusFilter = btn.dataset.status;
    state.page = 1;
    // A filter change swaps in a different working set -- carrying a bulk
    // selection across that would leave items selected that are no longer
    // even visible, which reads as broken rather than intentional.
    state.selectedRowIds.clear();
    loadInvoices();
  });
});

async function loadInvoices() {
  const params = new URLSearchParams();
  if (state.statusFilter) params.set("status", state.statusFilter);
  if (state.searchQuery) params.set("q", state.searchQuery);
  params.set("sort", state.sortField);
  params.set("order", state.sortOrder);
  params.set("page", state.page);
  params.set("page_size", QUEUE_PAGE_SIZE);
  const url = `/api/invoices?${params}`;

  await cachedLoad(
    url,
    async () => (await apiFetch(url)).json(),
    renderInvoices
  );
}

function renderInvoices({ items: invoices, total }) {
  // Drop any previously-selected id that isn't in this render -- e.g. it
  // was deleted, or a status-filter change hid it -- so the toolbar's count
  // and the bulk actions never operate on rows the user can't currently see.
  const visibleIds = new Set(invoices.map((inv) => inv.id));
  for (const id of state.selectedRowIds) {
    if (!visibleIds.has(id)) state.selectedRowIds.delete(id);
  }

  const tbody = document.querySelector("#invoice-table tbody");
  tbody.innerHTML = invoices.map((inv) => `
    <tr data-id="${inv.id}">
      <td><input type="checkbox" class="row-select" data-id="${inv.id}" ${state.selectedRowIds.has(inv.id) ? "checked" : ""} aria-label="Select" /></td>
      <td>${inv.vendor_name ? escapeHtml(inv.vendor_name) : "(unknown)"}</td>
      <td>${fmtMoney(inv.total)}</td>
      <td><span class="badge status-${inv.status}">${inv.status}</span></td>
      <td>${fmtPct(inv.overall_confidence)}</td>
    </tr>
  `).join("") || "<tr><td colspan='5' class='table-empty-row'>No invoices.</td></tr>";

  tbody.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", () => selectInvoice(row.dataset.id));
  });
  tbody.querySelectorAll(".row-select").forEach((checkbox) => {
    checkbox.addEventListener("click", (e) => e.stopPropagation()); // don't also open the row
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedRowIds.add(checkbox.dataset.id);
      else state.selectedRowIds.delete(checkbox.dataset.id);
      renderBulkToolbar();
    });
  });

  renderBulkToolbar();
  renderSortIndicators();
  renderQueuePagination(total);
}

function renderSortIndicators() {
  document.querySelectorAll("#invoice-table th.sortable").forEach((th) => {
    th.classList.toggle("sort-active", th.dataset.sort === state.sortField);
    th.dataset.order = th.dataset.sort === state.sortField ? state.sortOrder : "";
  });
}

function renderQueuePagination(total) {
  const start = total === 0 ? 0 : (state.page - 1) * QUEUE_PAGE_SIZE + 1;
  const end = Math.min(total, state.page * QUEUE_PAGE_SIZE);
  document.getElementById("queue-page-info").textContent = `${start}–${end} of ${total}`;
  document.getElementById("queue-prev-page").disabled = state.page <= 1;
  document.getElementById("queue-next-page").disabled = end >= total;
}

document.getElementById("invoice-search").addEventListener("input", debounce(() => {
  state.searchQuery = document.getElementById("invoice-search").value.trim();
  state.page = 1;
  state.selectedRowIds.clear();
  loadInvoices();
}, 300));

document.querySelectorAll("#invoice-table th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    if (state.sortField === th.dataset.sort) {
      state.sortOrder = state.sortOrder === "asc" ? "desc" : "asc";
    } else {
      state.sortField = th.dataset.sort;
      state.sortOrder = "asc";
    }
    state.page = 1;
    loadInvoices();
  });
});

document.getElementById("queue-prev-page").addEventListener("click", () => {
  if (state.page <= 1) return;
  state.page -= 1;
  state.selectedRowIds.clear();
  loadInvoices();
});
document.getElementById("queue-next-page").addEventListener("click", () => {
  state.page += 1;
  state.selectedRowIds.clear();
  loadInvoices();
});

function renderBulkToolbar() {
  const count = state.selectedRowIds.size;
  const toolbar = document.getElementById("bulk-toolbar");
  toolbar.style.display = count ? "flex" : "none";
  if (count) {
    document.getElementById("bulk-toolbar-count").textContent = `${count} selected`;
  }

  const selectAll = document.getElementById("select-all-invoices");
  const rowCheckboxes = document.querySelectorAll("#invoice-table .row-select");
  const checkedCount = document.querySelectorAll("#invoice-table .row-select:checked").length;
  selectAll.checked = rowCheckboxes.length > 0 && checkedCount === rowCheckboxes.length;
  selectAll.indeterminate = checkedCount > 0 && checkedCount < rowCheckboxes.length;
}

document.getElementById("select-all-invoices").addEventListener("change", (e) => {
  document.querySelectorAll("#invoice-table .row-select").forEach((checkbox) => {
    checkbox.checked = e.target.checked;
    if (e.target.checked) state.selectedRowIds.add(checkbox.dataset.id);
    else state.selectedRowIds.delete(checkbox.dataset.id);
  });
  renderBulkToolbar();
});

document.getElementById("bulk-clear-btn").addEventListener("click", () => {
  state.selectedRowIds.clear();
  loadInvoices();
});

async function runBulkAction(action) {
  const ids = Array.from(state.selectedRowIds);
  if (!ids.length) return;
  const res = await apiFetch("/api/invoices/bulk-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, action }),
  });
  const body = await res.json();
  if (!res.ok) {
    await alertDialog("Bulk action failed", body.detail || "Something went wrong.");
    return;
  }
  state.selectedRowIds.clear();
  const verb = action === "approve" ? "approved" : "rejected";
  const summary = body.skipped.length
    ? `${body.succeeded.length} ${verb}, ${body.skipped.length} skipped.`
    : `${body.succeeded.length} ${verb}.`;
  invalidateCache("/api/invoices?");
  loadInvoices();
  loadRecentUploads();
  if (state.selectedInvoiceId && ids.includes(state.selectedInvoiceId)) {
    selectInvoice(state.selectedInvoiceId); // refresh the open detail panel if it was part of the batch
  }
  await alertDialog("Bulk action complete", summary);
}

document.getElementById("bulk-approve-btn").addEventListener("click", () => runBulkAction("approve"));
document.getElementById("bulk-reject-btn").addEventListener("click", () => runBulkAction("reject"));

async function selectInvoice(id) {
  state.selectedInvoiceId = id;
  const res = await apiFetch(`/api/invoices/${id}`);
  const inv = await res.json();
  renderDetail(inv);
}

function fieldConf(inv, name) {
  return (inv.field_confidence && inv.field_confidence[name]) ?? 0;
}

function renderDetail(inv) {
  const el = document.getElementById("queue-detail");

  // Queued/processing look identical to a genuinely-empty extraction (every
  // field null either way) unless status is checked explicitly -- without
  // this, "still working on it" and "extraction ran and found nothing" were
  // indistinguishable, which is exactly what made this look broken. Auto-
  // polls and re-renders once it's actually done instead of leaving the user
  // staring at a blank form wondering if anything happened.
  if (inv.status === "queued" || inv.status === "processing") {
    const isPdf = (inv.content_type || "").includes("pdf");
    el.innerHTML = `
      <div class="cross-check processing">⏳ Still processing this document — this updates automatically. Most documents finish in well under a minute, but a slow OCR pass or AI response can occasionally take a couple of minutes.</div>
      <div class="doc-preview">
        <h3>Source document</h3>
        <div class="doc-preview-frame">
          ${isPdf ? `<iframe id="doc-preview-media"></iframe>` : `<img id="doc-preview-media" />`}
        </div>
      </div>
    `;
    loadDocPreview(inv);
    pollWhileProcessing(inv.id);
    return;
  }

  const lowConf = (name) => fieldConf(inv, name) < 0.85 ? "low-confidence" : "";

  const lineItemsRows = (inv.line_items || []).map((li, i) => `
    <tr>
      <td><input data-li="${i}" data-field="description" value="${escapeHtml(li.description)}" /></td>
      <td><input data-li="${i}" data-field="quantity" value="${li.quantity ?? ""}" style="width:4rem" /></td>
      <td><input data-li="${i}" data-field="unit_price" value="${li.unit_price ?? ""}" style="width:5rem" /></td>
      <td><input data-li="${i}" data-field="amount" value="${li.amount ?? ""}" style="width:5rem" /></td>
    </tr>
  `).join("");

  const isPdf = (inv.content_type || "").includes("pdf");
  const preview = isPdf ? `<iframe id="doc-preview-media"></iframe>` : `<img id="doc-preview-media" />`;

  const matchHtml = (inv.match_results && inv.match_results.length)
    ? inv.match_results.map((m) => `<div><span class="badge match-${m.status}">${m.status}</span> score ${m.score.toFixed(0)} — ${escapeHtml(m.reasoning)}</div>`).join("")
    : `<div class="hint">No match run yet for this invoice.</div>`;

  const statusBanner = inv.status === "failed"
    ? `<div class="cross-check fail">⚠ Extraction failed: ${escapeHtml(inv.error_message) || "Unknown error."} You can still fill in the fields below by hand.</div>`
    : `<div class="cross-check ${inv.cross_check_passed ? "pass" : "fail"}">
      ${inv.cross_check_passed ? "✓" : "✗"} Cross-check: ${inv.cross_check_detail || "n/a"}
      &nbsp;·&nbsp; extraction method: ${inv.extraction_method} &nbsp;·&nbsp; overall confidence: ${fmtPct(inv.overall_confidence)}
    </div>`;

  // Same vendor + invoice number already exists elsewhere in this org --
  // flagged as a likely double-upload/double-pay risk (see pipeline.js's
  // findDuplicateInvoice), separate from and in addition to the cross-check
  // banner above.
  const duplicateBanner = inv.duplicate_of_invoice_id
    ? `<div class="cross-check warn">⚠ Possible duplicate — same vendor and invoice number as "${escapeHtml(inv.duplicate_of_filename)}", already in your account. Double-check before approving to avoid paying it twice.</div>`
    : "";

  // Extraction only ever fills in one invoice's worth of fields -- if the
  // source document looks like it actually contains more than one (a batch
  // scan, a multi-invoice statement), the fields below may only reflect
  // part of it. See extraction.js's possible_multiple_invoices.
  const multiInvoiceReason = (inv.possible_multi_invoice_reason || "").trim().replace(/\.+$/, "");
  const multiInvoiceBanner = inv.possible_multi_invoice
    ? `<div class="cross-check warn">⚠ This document may contain more than one invoice${multiInvoiceReason ? ` — ${escapeHtml(multiInvoiceReason)}` : ""}. The fields below reflect only one; split the file and re-upload separately if so.</div>`
    : "";

  el.innerHTML = `
    ${duplicateBanner}
    ${multiInvoiceBanner}
    ${statusBanner}

    <div class="detail-grid">
      <div class="field ${lowConf("vendor_name")}"><label>Vendor</label><input id="f-vendor_name" value="${escapeHtml(inv.vendor_name)}" /></div>
      <div class="field ${lowConf("invoice_number")}"><label>Invoice #</label><input id="f-invoice_number" value="${escapeHtml(inv.invoice_number)}" /></div>
      <div class="field ${lowConf("invoice_date")}"><label>Invoice Date</label><input id="f-invoice_date" type="date" value="${inv.invoice_date || ""}" /></div>
      <div class="field ${lowConf("due_date")}"><label>Due Date</label><input id="f-due_date" type="date" value="${inv.due_date || ""}" /></div>
      <div class="field ${lowConf("po_reference")}"><label>PO Reference</label><input id="f-po_reference" value="${escapeHtml(inv.po_reference)}" /></div>
      <div class="field ${lowConf("currency")}"><label>Currency</label><input id="f-currency" value="${escapeHtml(inv.currency)}" /></div>
      <div class="field ${lowConf("subtotal")}"><label>Subtotal</label><input id="f-subtotal" value="${inv.subtotal ?? ""}" /></div>
      <div class="field ${lowConf("tax")}"><label>Tax</label><input id="f-tax" value="${inv.tax ?? ""}" /></div>
      <div class="field ${lowConf("total")}"><label>Total</label><input id="f-total" value="${inv.total ?? ""}" /></div>
    </div>

    <table class="line-items-table">
      <thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Amount</th></tr></thead>
      <tbody id="line-items-body">${lineItemsRows || "<tr><td colspan='4' class='table-empty-row'>No line items extracted.</td></tr>"}</tbody>
    </table>

    <h3>Matching</h3>
    ${matchHtml}

    ${state.quickbooksConnected ? `
    <div class="detail-grid" style="margin-top: 0.6rem;">
      <div class="field" id="qb-expense-account-field">
        <label>QuickBooks Expense Account</label>
        <select id="f-qb-expense-account" ${inv.quickbooks_bill_id ? "disabled" : ""}>
          <option value="">Choose an account…</option>
        </select>
        <div class="confidence-note" id="qb-expense-account-note">Loading a suggestion…</div>
      </div>
    </div>
    ` : ""}

    <div class="actions">
      <button class="save" id="btn-save">Save Corrections</button>
      <button class="approve" id="btn-approve">Approve</button>
      <button class="reject" id="btn-reject">Reject</button>
      ${inv.status !== "approved" ? `<button class="retry" id="btn-retry">Retry Extraction</button>` : ""}
      ${state.quickbooksConnected ? `<button class="qb-push" id="btn-qb-push" ${inv.quickbooks_bill_id ? "disabled" : ""}>${inv.quickbooks_bill_id ? "Pushed to QuickBooks" : "Push to QuickBooks"}</button>` : ""}
      ${inv.quickbooks_paid_at ? `<span class="badge badge-paid">Paid ${escapeHtml(String(inv.quickbooks_paid_at).slice(0, 10))}</span>` : ""}
      <button class="delete" id="btn-delete">Delete</button>
    </div>

    <div class="doc-preview">
      <h3>Source document</h3>
      <div class="doc-preview-frame">
        ${preview}
      </div>
    </div>
  `;

  document.getElementById("btn-save").addEventListener("click", () => saveCorrections(inv.id));
  document.getElementById("btn-approve").addEventListener("click", () => approveInvoice(inv.id));
  document.getElementById("btn-reject").addEventListener("click", () => rejectInvoice(inv.id));
  document.getElementById("btn-retry")?.addEventListener("click", () => retryInvoice(inv.id));
  document.getElementById("btn-qb-push")?.addEventListener("click", () => pushInvoiceToQuickbooks(inv.id));
  document.getElementById("btn-delete").addEventListener("click", () => deleteInvoice(inv.id));

  document.getElementById("f-qb-expense-account")?.addEventListener("change", (e) => {
    saveExpenseAccountCorrection(inv.id, e.target);
  });
  if (state.quickbooksConnected) loadExpenseAccountSuggestion(inv);

  loadDocPreview(inv);
}

// Checks back every 3s while an invoice is still queued/processing, up to
// ~6 minutes, then re-renders once it's actually done -- capped rather than
// polling forever in case a job genuinely gets stuck. The backend bounds its
// own worst case (OCR and LLM calls each time out well under a minute, and
// any unexpected error marks the invoice "failed" instead of leaving it
// stuck), so this cap is a generous multiple of that, not the thing actually
// keeping processing time in check. Bails out early if the user has since
// selected a different invoice, so a stale response can't clobber whatever
// they're looking at now.
const POLL_MAX_ATTEMPTS = 120;

function pollWhileProcessing(id, attempt = 0) {
  if (attempt >= POLL_MAX_ATTEMPTS) {
    if (state.selectedInvoiceId === id) {
      const banner = document.querySelector("#queue-detail .cross-check.processing");
      if (banner) {
        banner.textContent =
          "⏳ Still processing — this is taking much longer than usual. It will keep updating automatically; feel free to check back later.";
      }
    }
    return;
  }
  setTimeout(async () => {
    if (state.selectedInvoiceId !== id) return;
    const res = await apiFetch(`/api/invoices/${id}`);
    const inv = await res.json();
    if (state.selectedInvoiceId !== id) return;
    if (inv.status === "queued" || inv.status === "processing") {
      pollWhileProcessing(id, attempt + 1);
    } else {
      renderDetail(inv);
      invalidateCache("/api/invoices?");
      loadInvoices();
      loadRecentUploads();
    }
  }, 3000);
}

// <iframe src="..."> / <img src="..."> can't carry the bearer token, so a
// plain src pointing at the authenticated file endpoint just renders the
// API's 401 JSON body instead of the document. Fetch it through apiFetch
// (which does attach the token) and hand the element a blob: URL instead.
async function loadDocPreview(inv) {
  const media = document.getElementById("doc-preview-media");
  if (!media) return;
  if (docPreviewObjectUrl) {
    URL.revokeObjectURL(docPreviewObjectUrl);
    docPreviewObjectUrl = null;
  }
  try {
    const res = await apiFetch(`/api/invoices/${inv.id}/file`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Could not load the source document.");
    }
    const blob = await res.blob();
    docPreviewObjectUrl = URL.createObjectURL(blob);
    media.src = docPreviewObjectUrl;
  } catch (err) {
    media.replaceWith(Object.assign(document.createElement("p"), { className: "hint", textContent: String(err.message || err) }));
  }
}

// Every interpolated value from the API (vendor names, filenames, match
// reasoning, ...) is untrusted -- it's OCR output, a human correction, or a
// user-chosen filename, any of which could contain HTML. Escapes all five
// characters that matter (this used to escape only `"`, which only ever
// protected the few call sites already inside a quoted attribute -- every
// call site rendering into a text node, e.g. a <td>, got no real protection
// at all). Safe to use everywhere: attribute values and text nodes alike.
function escapeHtml(s) {
  return (s ?? "")
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function numOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

async function saveCorrections(id) {
  const lineItems = [];
  document.querySelectorAll("#line-items-body tr").forEach((row) => {
    const inputs = row.querySelectorAll("input");
    if (!inputs.length) return;
    const item = {};
    inputs.forEach((inp) => {
      const field = inp.dataset.field;
      item[field] = field === "description" ? inp.value : numOrNull(inp.value);
    });
    lineItems.push(item);
  });

  const payload = {
    vendor_name: document.getElementById("f-vendor_name").value,
    invoice_number: document.getElementById("f-invoice_number").value,
    invoice_date: document.getElementById("f-invoice_date").value || null,
    due_date: document.getElementById("f-due_date").value || null,
    po_reference: document.getElementById("f-po_reference").value,
    currency: document.getElementById("f-currency").value,
    subtotal: numOrNull(document.getElementById("f-subtotal").value),
    tax: numOrNull(document.getElementById("f-tax").value),
    total: numOrNull(document.getElementById("f-total").value),
    line_items: lineItems,
  };

  const res = await apiFetch(`/api/invoices/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const inv = await res.json();
  renderDetail(inv);
  invalidateCache("/api/invoices?");
  loadInvoices();
}

async function approveInvoice(id) {
  const res = await apiFetch(`/api/invoices/${id}/approve`, { method: "POST" });
  const inv = await res.json();
  renderDetail(inv);
  invalidateCache("/api/invoices?");
  loadInvoices();
}

async function rejectInvoice(id) {
  const res = await apiFetch(`/api/invoices/${id}/reject`, { method: "POST" });
  const inv = await res.json();
  renderDetail(inv);
  invalidateCache("/api/invoices?");
  loadInvoices();
}

// Re-queues the document for a fresh OCR + extraction pass without a
// re-upload. renderDetail already knows how to show a "queued" invoice (the
// same processing banner + auto-poll a real upload gets), so handing it the
// response is enough to pick that up.
async function retryInvoice(id) {
  const res = await apiFetch(`/api/invoices/${id}/retry`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't retry extraction", body.detail || "Could not retry this document.");
    return;
  }
  renderDetail(body);
  invalidateCache("/api/invoices?");
  loadInvoices();
  loadRecentUploads();
}

async function pushInvoiceToQuickbooks(id) {
  const btn = document.getElementById("btn-qb-push");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Pushing…";
  }
  try {
    const res = await apiFetch(`/api/integrations/quickbooks/invoices/${id}/push`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not push to QuickBooks.");
    const inv = await (await apiFetch(`/api/invoices/${id}`)).json();
    renderDetail(inv);
  } catch (err) {
    await alertDialog("Couldn't push to QuickBooks", err.message || String(err));
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Push to QuickBooks";
    }
  }
}

// Populates the expense-account dropdown and asks the backend for a
// suggestion (vendor memory first, then an LLM categorization call -- see
// quickbooks.js's suggestExpenseAccount). Idempotent on the backend side:
// an invoice that's already categorized just gets its existing choice
// echoed back instead of a fresh guess, so calling this on every render is
// safe rather than wasteful.
async function loadExpenseAccountSuggestion(inv) {
  if (!document.getElementById("f-qb-expense-account")) return;

  try {
    const suggestRes = await apiFetch(`/api/integrations/quickbooks/invoices/${inv.id}/suggest-account`, { method: "POST" });
    const suggestion = suggestRes.ok ? await suggestRes.json() : null;

    // The detail panel may have moved on to a different invoice (or away
    // from it entirely) while that request was in flight.
    if (state.selectedInvoiceId !== inv.id) return;
    const select = document.getElementById("f-qb-expense-account");
    const note = document.getElementById("qb-expense-account-note");
    if (!select || !note) return;

    const chosenId = suggestion?.quickbooks_expense_account_id;
    const chosenName = suggestion?.quickbooks_expense_account_name;

    // Seed the current choice first, before trying to load the full
    // account list -- same defensive order as the Settings tab's
    // default-account dropdown, so a transient accounts-list failure below
    // leaves the actual saved/suggested account visibly selected instead
    // of silently reverting to blank.
    select.innerHTML = `<option value="">Choose an account…</option>`;
    if (chosenId) select.innerHTML += `<option value="${chosenId}" selected>${escapeHtml(chosenName || chosenId)}</option>`;

    const accountsRes = await apiFetch("/api/integrations/quickbooks/accounts");
    if (state.selectedInvoiceId === inv.id && accountsRes.ok) {
      const accounts = await accountsRes.json();
      select.innerHTML =
        `<option value="">Choose an account…</option>` +
        accounts.map((a) => `<option value="${a.id}" ${a.id === chosenId ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("");
    }

    const confidence = suggestion?.quickbooks_expense_account_confidence;
    const field = document.getElementById("qb-expense-account-field");
    if (!chosenId) {
      note.textContent = "No suggestion available — choose one, or the org default will be used when pushed.";
    } else if (confidence != null && confidence < 0.85) {
      note.textContent = `Suggested (${fmtPct(confidence)} confidence) — double-check before pushing.`;
      field?.classList.add("low-confidence");
    } else {
      note.textContent = confidence >= 1 ? "" : `Suggested (${fmtPct(confidence)} confidence).`;
    }
  } catch {
    const note = document.getElementById("qb-expense-account-note");
    if (note) note.textContent = "Couldn't load a suggestion — choose one manually, or the org default will be used.";
  }
}

async function saveExpenseAccountCorrection(id, selectEl) {
  const note = document.getElementById("qb-expense-account-note");
  if (!selectEl.value) return;
  const accountName = selectEl.selectedOptions[0].textContent;
  try {
    const res = await apiFetch(`/api/integrations/quickbooks/invoices/${id}/expense-account`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: selectEl.value, account_name: accountName }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not save the expense account.");
    document.getElementById("qb-expense-account-field")?.classList.remove("low-confidence");
    if (note) note.textContent = "Saved — remembered for this vendor's future invoices too.";
  } catch (err) {
    if (note) note.textContent = err.message || String(err);
  }
}

// No status restriction on the backend -- a document can be deleted at any
// point in review, whenever the user decides they don't want it around
// anymore. Callable from either the sidebar's recent-uploads list or the
// review-detail panel, so both need refreshing regardless of which one this
// was clicked from.
async function deleteInvoice(id) {
  const ok = await confirmDialog("Delete this document?", "This can't be undone from the review UI.", {
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;

  const res = await apiFetch(`/api/invoices/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await alertDialog("Couldn't delete document", body.detail || "Could not delete this document.");
    return;
  }

  if (state.selectedInvoiceId === id) {
    state.selectedInvoiceId = null;
    document.getElementById("queue-detail").innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6l1.4 1.4L7.5 4.7"/><path d="M11 6h9.5"/><path d="M3.5 12l1.4 1.4 2.6-2.7"/><path d="M11 12h9.5"/><path d="M3.5 18l1.4 1.4 2.6-2.7"/><path d="M11 18h9.5"/></svg>
        <p class="hint">Select an invoice from the list to review it.</p>
      </div>
    `;
  }
  invalidateCache("/api/invoices?");
  loadInvoices();
  loadRecentUploads();
}

// ---- Expenses ----
// Same shape as the invoice Review Queue above (upload/list/detail/correct/
// approve/reject/retry/delete), applied to /api/expenses instead of
// /api/invoices. Deliberately without the invoice queue's bulk actions/
// row-select checkboxes -- not part of the expense pipeline's v1 scope (see
// expensePipeline.js's comment) -- so this is a plain click-to-select list.
document.getElementById("expense-upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("expense-file-input");
  const files = Array.from(fileInput.files);
  if (!files.length) return;

  const statusEl = document.getElementById("expense-upload-status");
  let uploaded = 0;
  const failures = [];

  for (const [i, file] of files.entries()) {
    statusEl.textContent =
      files.length > 1 ? `Uploading ${i + 1} of ${files.length}: ${file.name}...` : `Uploading ${file.name}...`;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await apiFetch("/api/expenses/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json();
        failures.push(`${file.name} — ${err.detail || res.statusText}`);
        continue;
      }
      uploaded += 1;
    } catch (err) {
      failures.push(`${file.name} — ${err.message || String(err)}`);
      break;
    }
  }

  if (failures.length) {
    const summary = uploaded ? `Uploaded ${uploaded} of ${files.length}. ` : "";
    statusEl.textContent = `${summary}Failed: ${failures.join("; ")}`;
  } else {
    statusEl.textContent =
      uploaded > 1 ? `Uploaded ${uploaded} receipts — queued for extraction.` : "Uploaded — queued for extraction.";
  }

  fileInput.value = "";
  if (uploaded) {
    invalidateCache("/api/expenses?");
    loadExpenses();
    bootstrapApp(); // refresh the sidebar's shared "documents used this month" count
  }
});

document.querySelectorAll(".expense-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".expense-filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.expenseStatusFilter = btn.dataset.status;
    state.expensePage = 1;
    loadExpenses();
  });
});

async function loadExpenses() {
  const params = new URLSearchParams();
  if (state.expenseStatusFilter) params.set("status", state.expenseStatusFilter);
  if (state.expenseSearchQuery) params.set("q", state.expenseSearchQuery);
  params.set("sort", state.expenseSortField);
  params.set("order", state.expenseSortOrder);
  params.set("page", state.expensePage);
  params.set("page_size", QUEUE_PAGE_SIZE);
  const url = `/api/expenses?${params}`;

  await cachedLoad(
    url,
    async () => (await apiFetch(url)).json(),
    renderExpenses
  );
}

function renderExpenses({ items: receipts, total, categories }) {
  if (categories) state.expenseCategories = categories;
  const tbody = document.querySelector("#expense-table tbody");
  tbody.innerHTML = receipts.map((r) => `
    <tr data-id="${r.id}">
      <td>${r.merchant_name ? escapeHtml(r.merchant_name) : "(unknown)"}</td>
      <td>${fmtMoney(r.amount)}</td>
      <td><span class="badge status-${r.status}">${r.status}</span></td>
      <td>${fmtPct(r.overall_confidence)}</td>
    </tr>
  `).join("") || "<tr><td colspan='4' class='table-empty-row'>No expense receipts.</td></tr>";

  tbody.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", () => selectExpense(row.dataset.id));
  });

  document.querySelectorAll("#expense-table th.expense-sortable").forEach((th) => {
    th.classList.toggle("sort-active", th.dataset.sort === state.expenseSortField);
    th.dataset.order = th.dataset.sort === state.expenseSortField ? state.expenseSortOrder : "";
  });

  const start = total === 0 ? 0 : (state.expensePage - 1) * QUEUE_PAGE_SIZE + 1;
  const end = Math.min(total, state.expensePage * QUEUE_PAGE_SIZE);
  document.getElementById("expense-queue-page-info").textContent = `${start}–${end} of ${total}`;
  document.getElementById("expense-queue-prev-page").disabled = state.expensePage <= 1;
  document.getElementById("expense-queue-next-page").disabled = end >= total;
}

document.getElementById("expense-search").addEventListener("input", debounce(() => {
  state.expenseSearchQuery = document.getElementById("expense-search").value.trim();
  state.expensePage = 1;
  loadExpenses();
}, 300));

document.querySelectorAll("#expense-table th.expense-sortable").forEach((th) => {
  th.addEventListener("click", () => {
    if (state.expenseSortField === th.dataset.sort) {
      state.expenseSortOrder = state.expenseSortOrder === "asc" ? "desc" : "asc";
    } else {
      state.expenseSortField = th.dataset.sort;
      state.expenseSortOrder = "asc";
    }
    state.expensePage = 1;
    loadExpenses();
  });
});

document.getElementById("expense-queue-prev-page").addEventListener("click", () => {
  if (state.expensePage <= 1) return;
  state.expensePage -= 1;
  loadExpenses();
});
document.getElementById("expense-queue-next-page").addEventListener("click", () => {
  state.expensePage += 1;
  loadExpenses();
});

async function selectExpense(id) {
  state.selectedExpenseId = id;
  const res = await apiFetch(`/api/expenses/${id}`);
  const receipt = await res.json();
  renderExpenseDetail(receipt);
}

function expenseFieldConf(r, name) {
  return (r.field_confidence && r.field_confidence[name]) ?? 0;
}

const EXPENSE_EMPTY_DETAIL = `
  <div class="empty-state">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l3 3v17a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>
    <p class="hint">Select a receipt from the list to review it.</p>
  </div>
`;

function renderExpenseDetail(r) {
  const el = document.getElementById("expense-queue-detail");

  if (r.status === "queued" || r.status === "processing") {
    const isPdf = (r.content_type || "").includes("pdf");
    el.innerHTML = `
      <div class="cross-check processing">⏳ Still processing this receipt — this updates automatically. Most documents finish in well under a minute, but a slow OCR pass or AI response can occasionally take a couple of minutes.</div>
      <div class="doc-preview">
        <h3>Source document</h3>
        <div class="doc-preview-frame">
          ${isPdf ? `<iframe id="expense-doc-preview-media"></iframe>` : `<img id="expense-doc-preview-media" />`}
        </div>
      </div>
    `;
    loadExpenseDocPreview(r);
    pollExpenseWhileProcessing(r.id);
    return;
  }

  const lowConf = (name) => expenseFieldConf(r, name) < 0.85 ? "low-confidence" : "";
  const isPdf = (r.content_type || "").includes("pdf");
  const preview = isPdf ? `<iframe id="expense-doc-preview-media"></iframe>` : `<img id="expense-doc-preview-media" />`;

  const categoryOptions = state.expenseCategories.map(
    (c) => `<option value="${escapeHtml(c)}" ${r.category === c ? "selected" : ""}>${escapeHtml(c)}</option>`
  ).join("");

  const statusBanner = r.status === "failed"
    ? `<div class="cross-check fail">⚠ Extraction failed: ${escapeHtml(r.error_message) || "Unknown error."} You can still fill in the fields below by hand.</div>`
    : `<div class="cross-check pass">✓ extraction method: ${r.extraction_method} &nbsp;·&nbsp; overall confidence: ${fmtPct(r.overall_confidence)}</div>`;

  el.innerHTML = `
    ${statusBanner}

    <div class="detail-grid">
      <div class="field ${lowConf("merchant_name")}"><label>Merchant</label><input id="ef-merchant_name" value="${escapeHtml(r.merchant_name)}" /></div>
      <div class="field ${lowConf("receipt_date")}"><label>Receipt Date</label><input id="ef-receipt_date" type="date" value="${r.receipt_date || ""}" /></div>
      <div class="field ${lowConf("category")}"><label>Category</label><select id="ef-category"><option value="">Choose…</option>${categoryOptions}</select></div>
      <div class="field"><label>Currency</label><input id="ef-currency" value="${escapeHtml(r.currency)}" /></div>
      <div class="field ${lowConf("tax")}"><label>Tax</label><input id="ef-tax" value="${r.tax ?? ""}" /></div>
      <div class="field ${lowConf("amount")}"><label>Amount</label><input id="ef-amount" value="${r.amount ?? ""}" /></div>
      <div class="field"><label>Note</label><input id="ef-note" value="${escapeHtml(r.note)}" /></div>
    </div>

    <div class="actions">
      <button class="save" id="ebtn-save">Save Corrections</button>
      <button class="approve" id="ebtn-approve">Approve</button>
      <button class="reject" id="ebtn-reject">Reject</button>
      ${r.status !== "approved" ? `<button class="retry" id="ebtn-retry">Retry Extraction</button>` : ""}
      <button class="delete" id="ebtn-delete">Delete</button>
    </div>

    <div class="doc-preview">
      <h3>Source document</h3>
      <div class="doc-preview-frame">
        ${preview}
      </div>
    </div>
  `;

  document.getElementById("ebtn-save").addEventListener("click", () => saveExpenseCorrections(r.id));
  document.getElementById("ebtn-approve").addEventListener("click", () => approveExpense(r.id));
  document.getElementById("ebtn-reject").addEventListener("click", () => rejectExpense(r.id));
  document.getElementById("ebtn-retry")?.addEventListener("click", () => retryExpense(r.id));
  document.getElementById("ebtn-delete").addEventListener("click", () => deleteExpense(r.id));

  loadExpenseDocPreview(r);
}

const EXPENSE_POLL_MAX_ATTEMPTS = 120;

function pollExpenseWhileProcessing(id, attempt = 0) {
  if (attempt >= EXPENSE_POLL_MAX_ATTEMPTS) {
    if (state.selectedExpenseId === id) {
      const banner = document.querySelector("#expense-queue-detail .cross-check.processing");
      if (banner) {
        banner.textContent =
          "⏳ Still processing — this is taking much longer than usual. It will keep updating automatically; feel free to check back later.";
      }
    }
    return;
  }
  setTimeout(async () => {
    if (state.selectedExpenseId !== id) return;
    const res = await apiFetch(`/api/expenses/${id}`);
    const r = await res.json();
    if (state.selectedExpenseId !== id) return;
    if (r.status === "queued" || r.status === "processing") {
      pollExpenseWhileProcessing(id, attempt + 1);
    } else {
      renderExpenseDetail(r);
      invalidateCache("/api/expenses?");
      loadExpenses();
    }
  }, 3000);
}

async function loadExpenseDocPreview(r) {
  const media = document.getElementById("expense-doc-preview-media");
  if (!media) return;
  if (expenseDocPreviewObjectUrl) {
    URL.revokeObjectURL(expenseDocPreviewObjectUrl);
    expenseDocPreviewObjectUrl = null;
  }
  try {
    const res = await apiFetch(`/api/expenses/${r.id}/file`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Could not load the source document.");
    }
    const blob = await res.blob();
    expenseDocPreviewObjectUrl = URL.createObjectURL(blob);
    media.src = expenseDocPreviewObjectUrl;
  } catch (err) {
    media.replaceWith(Object.assign(document.createElement("p"), { className: "hint", textContent: String(err.message || err) }));
  }
}

async function saveExpenseCorrections(id) {
  const payload = {
    merchant_name: document.getElementById("ef-merchant_name").value,
    receipt_date: document.getElementById("ef-receipt_date").value || null,
    category: document.getElementById("ef-category").value,
    currency: document.getElementById("ef-currency").value,
    tax: numOrNull(document.getElementById("ef-tax").value),
    amount: numOrNull(document.getElementById("ef-amount").value),
    note: document.getElementById("ef-note").value,
  };

  const res = await apiFetch(`/api/expenses/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const r = await res.json();
  renderExpenseDetail(r);
  invalidateCache("/api/expenses?");
  loadExpenses();
}

async function approveExpense(id) {
  const res = await apiFetch(`/api/expenses/${id}/approve`, { method: "POST" });
  const r = await res.json();
  renderExpenseDetail(r);
  invalidateCache("/api/expenses?");
  loadExpenses();
}

async function rejectExpense(id) {
  const res = await apiFetch(`/api/expenses/${id}/reject`, { method: "POST" });
  const r = await res.json();
  renderExpenseDetail(r);
  invalidateCache("/api/expenses?");
  loadExpenses();
}

async function retryExpense(id) {
  const res = await apiFetch(`/api/expenses/${id}/retry`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't retry extraction", body.detail || "Could not retry this document.");
    return;
  }
  renderExpenseDetail(body);
  invalidateCache("/api/expenses?");
  loadExpenses();
}

async function deleteExpense(id) {
  const ok = await confirmDialog("Delete this receipt?", "This can't be undone from the review UI.", {
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;

  const res = await apiFetch(`/api/expenses/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await alertDialog("Couldn't delete receipt", body.detail || "Could not delete this receipt.");
    return;
  }

  if (state.selectedExpenseId === id) {
    state.selectedExpenseId = null;
    document.getElementById("expense-queue-detail").innerHTML = EXPENSE_EMPTY_DETAIL;
  }
  invalidateCache("/api/expenses?");
  loadExpenses();
}

// ---- Vendor Docs ----
// Same shape as the Expenses queue above (upload/list/detail/correct/
// approve/reject/retry/delete), applied to /api/vendor-documents instead
// of /api/expenses. The one thing unique to this tab: an "Expiring within
// 30 days" filter (expiring_within_days on the list endpoint) and an
// expiration badge in both the table and detail view, since surfacing
// what's about to lapse is this module's whole reason to exist.
document.getElementById("vendordoc-upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("vendordoc-file-input");
  const files = Array.from(fileInput.files);
  if (!files.length) return;

  const statusEl = document.getElementById("vendordoc-upload-status");
  let uploaded = 0;
  const failures = [];

  for (const [i, file] of files.entries()) {
    statusEl.textContent =
      files.length > 1 ? `Uploading ${i + 1} of ${files.length}: ${file.name}...` : `Uploading ${file.name}...`;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await apiFetch("/api/vendor-documents/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json();
        failures.push(`${file.name} — ${err.detail || res.statusText}`);
        continue;
      }
      uploaded += 1;
    } catch (err) {
      failures.push(`${file.name} — ${err.message || String(err)}`);
      break;
    }
  }

  if (failures.length) {
    const summary = uploaded ? `Uploaded ${uploaded} of ${files.length}. ` : "";
    statusEl.textContent = `${summary}Failed: ${failures.join("; ")}`;
  } else {
    statusEl.textContent =
      uploaded > 1 ? `Uploaded ${uploaded} documents — queued for extraction.` : "Uploaded — queued for extraction.";
  }

  fileInput.value = "";
  if (uploaded) {
    invalidateCache("/api/vendor-documents?");
    loadVendorDocs();
    bootstrapApp(); // refresh the sidebar's shared "documents used this month" count
  }
});

document.querySelectorAll(".vendordoc-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".vendordoc-filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.status === "expiring_soon") {
      state.vendordocExpiringOnly = true;
      state.vendordocStatusFilter = "";
    } else {
      state.vendordocExpiringOnly = false;
      state.vendordocStatusFilter = btn.dataset.status;
    }
    state.vendordocPage = 1;
    loadVendorDocs();
  });
});

const VENDORDOC_EXPIRING_SOON_DAYS = 30;

async function loadVendorDocs() {
  const params = new URLSearchParams();
  if (state.vendordocExpiringOnly) {
    params.set("expiring_within_days", VENDORDOC_EXPIRING_SOON_DAYS);
  } else if (state.vendordocStatusFilter) {
    params.set("status", state.vendordocStatusFilter);
  }
  if (state.vendordocSearchQuery) params.set("q", state.vendordocSearchQuery);
  params.set("sort", state.vendordocSortField);
  params.set("order", state.vendordocSortOrder);
  params.set("page", state.vendordocPage);
  params.set("page_size", QUEUE_PAGE_SIZE);
  const url = `/api/vendor-documents?${params}`;

  await cachedLoad(
    url,
    async () => (await apiFetch(url)).json(),
    renderVendorDocs
  );
}

// Returns { cls, label } for the expiration badge -- shared by the table
// row and the detail view so the two never disagree about what "soon"
// means. `null` (no expiration date at all, e.g. a W-9) is its own state,
// not lumped in with "ok".
function expiryBadge(dateStr) {
  if (!dateStr) return { cls: "expiry-none", label: "—" };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const expiry = new Date(`${dateStr}T00:00:00Z`);
  const daysLeft = Math.round((expiry - today) / (1000 * 60 * 60 * 24));
  if (daysLeft < 0) return { cls: "expiry-expired", label: `Expired ${dateStr}` };
  if (daysLeft <= VENDORDOC_EXPIRING_SOON_DAYS) return { cls: "expiry-soon", label: `Expires ${dateStr}` };
  return { cls: "expiry-ok", label: dateStr };
}

function renderVendorDocs({ items: docs, total, document_types }) {
  if (document_types) state.vendorDocumentTypes = document_types;
  const tbody = document.querySelector("#vendordoc-table tbody");
  tbody.innerHTML = docs.map((d) => {
    const expiry = expiryBadge(d.expiration_date);
    return `
    <tr data-id="${d.id}">
      <td>${d.vendor_name ? escapeHtml(d.vendor_name) : "(unknown)"}</td>
      <td>${d.document_type ? escapeHtml(d.document_type) : "—"}</td>
      <td><span class="badge ${expiry.cls}">${escapeHtml(expiry.label)}</span></td>
      <td><span class="badge status-${d.status}">${d.status}</span></td>
      <td>${fmtPct(d.overall_confidence)}</td>
    </tr>
  `;
  }).join("") || "<tr><td colspan='5' class='table-empty-row'>No vendor documents.</td></tr>";

  tbody.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", () => selectVendorDoc(row.dataset.id));
  });

  document.querySelectorAll("#vendordoc-table th.vendordoc-sortable").forEach((th) => {
    th.classList.toggle("sort-active", th.dataset.sort === state.vendordocSortField);
    th.dataset.order = th.dataset.sort === state.vendordocSortField ? state.vendordocSortOrder : "";
  });

  const start = total === 0 ? 0 : (state.vendordocPage - 1) * QUEUE_PAGE_SIZE + 1;
  const end = Math.min(total, state.vendordocPage * QUEUE_PAGE_SIZE);
  document.getElementById("vendordoc-queue-page-info").textContent = `${start}–${end} of ${total}`;
  document.getElementById("vendordoc-queue-prev-page").disabled = state.vendordocPage <= 1;
  document.getElementById("vendordoc-queue-next-page").disabled = end >= total;
}

document.getElementById("vendordoc-search").addEventListener("input", debounce(() => {
  state.vendordocSearchQuery = document.getElementById("vendordoc-search").value.trim();
  state.vendordocPage = 1;
  loadVendorDocs();
}, 300));

document.querySelectorAll("#vendordoc-table th.vendordoc-sortable").forEach((th) => {
  th.addEventListener("click", () => {
    if (state.vendordocSortField === th.dataset.sort) {
      state.vendordocSortOrder = state.vendordocSortOrder === "asc" ? "desc" : "asc";
    } else {
      state.vendordocSortField = th.dataset.sort;
      state.vendordocSortOrder = "asc";
    }
    state.vendordocPage = 1;
    loadVendorDocs();
  });
});

document.getElementById("vendordoc-queue-prev-page").addEventListener("click", () => {
  if (state.vendordocPage <= 1) return;
  state.vendordocPage -= 1;
  loadVendorDocs();
});
document.getElementById("vendordoc-queue-next-page").addEventListener("click", () => {
  state.vendordocPage += 1;
  loadVendorDocs();
});

async function selectVendorDoc(id) {
  state.selectedVendorDocId = id;
  const res = await apiFetch(`/api/vendor-documents/${id}`);
  const doc = await res.json();
  renderVendorDocDetail(doc);
}

function vendordocFieldConf(d, name) {
  return (d.field_confidence && d.field_confidence[name]) ?? 0;
}

const VENDORDOC_EMPTY_DETAIL = `
  <div class="empty-state">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h6M9 16h6M9 8h1"/><circle cx="12" cy="12" r="10"/></svg>
    <p class="hint">Select a document from the list to review it.</p>
  </div>
`;

function renderVendorDocDetail(d) {
  const el = document.getElementById("vendordoc-queue-detail");

  if (d.status === "queued" || d.status === "processing") {
    const isPdf = (d.content_type || "").includes("pdf");
    el.innerHTML = `
      <div class="cross-check processing">⏳ Still processing this document — this updates automatically. Most documents finish in well under a minute, but a slow OCR pass or AI response can occasionally take a couple of minutes.</div>
      <div class="doc-preview">
        <h3>Source document</h3>
        <div class="doc-preview-frame">
          ${isPdf ? `<iframe id="vendordoc-doc-preview-media"></iframe>` : `<img id="vendordoc-doc-preview-media" />`}
        </div>
      </div>
    `;
    loadVendorDocPreview(d);
    pollVendorDocWhileProcessing(d.id);
    return;
  }

  const lowConf = (name) => vendordocFieldConf(d, name) < 0.85 ? "low-confidence" : "";
  const isPdf = (d.content_type || "").includes("pdf");
  const preview = isPdf ? `<iframe id="vendordoc-doc-preview-media"></iframe>` : `<img id="vendordoc-doc-preview-media" />`;

  const typeOptions = state.vendorDocumentTypes.map(
    (t) => `<option value="${escapeHtml(t)}" ${d.document_type === t ? "selected" : ""}>${escapeHtml(t)}</option>`
  ).join("");

  const statusBanner = d.status === "failed"
    ? `<div class="cross-check fail">⚠ Extraction failed: ${escapeHtml(d.error_message) || "Unknown error."} You can still fill in the fields below by hand.</div>`
    : `<div class="cross-check pass">✓ extraction method: ${d.extraction_method} &nbsp;·&nbsp; overall confidence: ${fmtPct(d.overall_confidence)}</div>`;

  const expiry = expiryBadge(d.expiration_date);
  const expiryBanner = expiry.cls === "expiry-expired"
    ? `<div class="cross-check fail">⚠ This document expired on ${escapeHtml(d.expiration_date)}.</div>`
    : expiry.cls === "expiry-soon"
    ? `<div class="cross-check warn">⚠ This document expires on ${escapeHtml(d.expiration_date)} — within the next ${VENDORDOC_EXPIRING_SOON_DAYS} days.</div>`
    : "";

  el.innerHTML = `
    ${expiryBanner}
    ${statusBanner}

    <div class="detail-grid">
      <div class="field ${lowConf("vendor_name")}"><label>Vendor</label><input id="vf-vendor_name" value="${escapeHtml(d.vendor_name)}" /></div>
      <div class="field ${lowConf("document_type")}"><label>Document Type</label><select id="vf-document_type"><option value="">Choose…</option>${typeOptions}</select></div>
      <div class="field ${lowConf("effective_date")}"><label>Effective Date</label><input id="vf-effective_date" type="date" value="${d.effective_date || ""}" /></div>
      <div class="field ${lowConf("expiration_date")}"><label>Expiration Date</label><input id="vf-expiration_date" type="date" value="${d.expiration_date || ""}" /></div>
      <div class="field ${lowConf("reference_number")}"><label>Reference #</label><input id="vf-reference_number" value="${escapeHtml(d.reference_number)}" /></div>
      <div class="field ${lowConf("amount")}"><label>Amount</label><input id="vf-amount" value="${d.amount ?? ""}" /></div>
      <div class="field"><label>Note</label><input id="vf-note" value="${escapeHtml(d.note)}" /></div>
    </div>

    <div class="actions">
      <button class="save" id="vbtn-save">Save Corrections</button>
      <button class="approve" id="vbtn-approve">Approve</button>
      <button class="reject" id="vbtn-reject">Reject</button>
      ${d.status !== "approved" ? `<button class="retry" id="vbtn-retry">Retry Extraction</button>` : ""}
      <button class="delete" id="vbtn-delete">Delete</button>
    </div>

    <div class="doc-preview">
      <h3>Source document</h3>
      <div class="doc-preview-frame">
        ${preview}
      </div>
    </div>
  `;

  document.getElementById("vbtn-save").addEventListener("click", () => saveVendorDocCorrections(d.id));
  document.getElementById("vbtn-approve").addEventListener("click", () => approveVendorDoc(d.id));
  document.getElementById("vbtn-reject").addEventListener("click", () => rejectVendorDoc(d.id));
  document.getElementById("vbtn-retry")?.addEventListener("click", () => retryVendorDoc(d.id));
  document.getElementById("vbtn-delete").addEventListener("click", () => deleteVendorDoc(d.id));

  loadVendorDocPreview(d);
}

const VENDORDOC_POLL_MAX_ATTEMPTS = 120;

function pollVendorDocWhileProcessing(id, attempt = 0) {
  if (attempt >= VENDORDOC_POLL_MAX_ATTEMPTS) {
    if (state.selectedVendorDocId === id) {
      const banner = document.querySelector("#vendordoc-queue-detail .cross-check.processing");
      if (banner) {
        banner.textContent =
          "⏳ Still processing — this is taking much longer than usual. It will keep updating automatically; feel free to check back later.";
      }
    }
    return;
  }
  setTimeout(async () => {
    if (state.selectedVendorDocId !== id) return;
    const res = await apiFetch(`/api/vendor-documents/${id}`);
    const d = await res.json();
    if (state.selectedVendorDocId !== id) return;
    if (d.status === "queued" || d.status === "processing") {
      pollVendorDocWhileProcessing(id, attempt + 1);
    } else {
      renderVendorDocDetail(d);
      invalidateCache("/api/vendor-documents?");
      loadVendorDocs();
    }
  }, 3000);
}

async function loadVendorDocPreview(d) {
  const media = document.getElementById("vendordoc-doc-preview-media");
  if (!media) return;
  if (vendordocDocPreviewObjectUrl) {
    URL.revokeObjectURL(vendordocDocPreviewObjectUrl);
    vendordocDocPreviewObjectUrl = null;
  }
  try {
    const res = await apiFetch(`/api/vendor-documents/${d.id}/file`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Could not load the source document.");
    }
    const blob = await res.blob();
    vendordocDocPreviewObjectUrl = URL.createObjectURL(blob);
    media.src = vendordocDocPreviewObjectUrl;
  } catch (err) {
    media.replaceWith(Object.assign(document.createElement("p"), { className: "hint", textContent: String(err.message || err) }));
  }
}

async function saveVendorDocCorrections(id) {
  const payload = {
    vendor_name: document.getElementById("vf-vendor_name").value,
    document_type: document.getElementById("vf-document_type").value,
    effective_date: document.getElementById("vf-effective_date").value || null,
    expiration_date: document.getElementById("vf-expiration_date").value || null,
    reference_number: document.getElementById("vf-reference_number").value,
    amount: numOrNull(document.getElementById("vf-amount").value),
    note: document.getElementById("vf-note").value,
  };

  const res = await apiFetch(`/api/vendor-documents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const d = await res.json();
  renderVendorDocDetail(d);
  invalidateCache("/api/vendor-documents?");
  loadVendorDocs();
}

async function approveVendorDoc(id) {
  const res = await apiFetch(`/api/vendor-documents/${id}/approve`, { method: "POST" });
  const d = await res.json();
  renderVendorDocDetail(d);
  invalidateCache("/api/vendor-documents?");
  loadVendorDocs();
}

async function rejectVendorDoc(id) {
  const res = await apiFetch(`/api/vendor-documents/${id}/reject`, { method: "POST" });
  const d = await res.json();
  renderVendorDocDetail(d);
  invalidateCache("/api/vendor-documents?");
  loadVendorDocs();
}

async function retryVendorDoc(id) {
  const res = await apiFetch(`/api/vendor-documents/${id}/retry`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't retry extraction", body.detail || "Could not retry this document.");
    return;
  }
  renderVendorDocDetail(body);
  invalidateCache("/api/vendor-documents?");
  loadVendorDocs();
}

async function deleteVendorDoc(id) {
  const ok = await confirmDialog("Delete this document?", "This can't be undone from the review UI.", {
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;

  const res = await apiFetch(`/api/vendor-documents/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await alertDialog("Couldn't delete document", body.detail || "Could not delete this document.");
    return;
  }

  if (state.selectedVendorDocId === id) {
    state.selectedVendorDocId = null;
    document.getElementById("vendordoc-queue-detail").innerHTML = VENDORDOC_EMPTY_DETAIL;
  }
  invalidateCache("/api/vendor-documents?");
  loadVendorDocs();
}

// ---- Leases ----
// Same shape as the Vendor Docs queue above (upload/list/detail/correct/
// approve/reject/retry/delete), applied to /api/leases instead of
// /api/vendor-documents. A lease has two dates worth flagging instead of
// one -- its own expiration, and the (often much earlier) deadline to
// notify the landlord in order to exercise a renewal option -- so the
// table shows whichever of the two comes first, and the detail view shows
// both with their own badges. Uses a 90-day "soon" window rather than
// vendor docs' 30 -- lease decisions have a longer lead time than an
// insurance certificate's.
document.getElementById("lease-upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("lease-file-input");
  const files = Array.from(fileInput.files);
  if (!files.length) return;

  const statusEl = document.getElementById("lease-upload-status");
  let uploaded = 0;
  const failures = [];

  for (const [i, file] of files.entries()) {
    statusEl.textContent =
      files.length > 1 ? `Uploading ${i + 1} of ${files.length}: ${file.name}...` : `Uploading ${file.name}...`;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await apiFetch("/api/leases/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json();
        failures.push(`${file.name} — ${err.detail || res.statusText}`);
        continue;
      }
      uploaded += 1;
    } catch (err) {
      failures.push(`${file.name} — ${err.message || String(err)}`);
      break;
    }
  }

  if (failures.length) {
    const summary = uploaded ? `Uploaded ${uploaded} of ${files.length}. ` : "";
    statusEl.textContent = `${summary}Failed: ${failures.join("; ")}`;
  } else {
    statusEl.textContent =
      uploaded > 1 ? `Uploaded ${uploaded} leases — queued for extraction.` : "Uploaded — queued for extraction.";
  }

  fileInput.value = "";
  if (uploaded) {
    invalidateCache("/api/leases?");
    loadLeases();
    bootstrapApp(); // refresh the sidebar's shared "documents used this month" count
  }
});

document.querySelectorAll(".lease-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".lease-filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.status === "expiring_soon") {
      state.leaseExpiringOnly = true;
      state.leaseStatusFilter = "";
    } else {
      state.leaseExpiringOnly = false;
      state.leaseStatusFilter = btn.dataset.status;
    }
    state.leasePage = 1;
    loadLeases();
  });
});

const LEASE_EXPIRING_SOON_DAYS = 90;

async function loadLeases() {
  const params = new URLSearchParams();
  if (state.leaseExpiringOnly) {
    params.set("expiring_within_days", LEASE_EXPIRING_SOON_DAYS);
  } else if (state.leaseStatusFilter) {
    params.set("status", state.leaseStatusFilter);
  }
  if (state.leaseSearchQuery) params.set("q", state.leaseSearchQuery);
  params.set("sort", state.leaseSortField);
  params.set("order", state.leaseSortOrder);
  params.set("page", state.leasePage);
  params.set("page_size", QUEUE_PAGE_SIZE);
  const url = `/api/leases?${params}`;

  await cachedLoad(
    url,
    async () => (await apiFetch(url)).json(),
    renderLeases
  );
}

// Whichever of the two flagged dates comes first is the more urgent one to
// show at a glance in the table -- the detail view shows both separately.
function leaseCriticalDate(l) {
  const dates = [l.expiration_date, l.renewal_notice_deadline].filter(Boolean);
  if (!dates.length) return null;
  return dates.sort()[0]; // ISO YYYY-MM-DD strings sort chronologically as strings
}

// Same shape as vendor docs' expiryBadge, with a 90-day window instead of
// 30 -- see the section comment above for why.
function leaseExpiryBadge(dateStr) {
  if (!dateStr) return { cls: "expiry-none", label: "—" };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(`${dateStr}T00:00:00Z`);
  const daysLeft = Math.round((target - today) / (1000 * 60 * 60 * 24));
  if (daysLeft < 0) return { cls: "expiry-expired", label: `Past due ${dateStr}` };
  if (daysLeft <= LEASE_EXPIRING_SOON_DAYS) return { cls: "expiry-soon", label: dateStr };
  return { cls: "expiry-ok", label: dateStr };
}

function renderLeases({ items: leases, total }) {
  const tbody = document.querySelector("#lease-table tbody");
  tbody.innerHTML = leases.map((l) => {
    const badge = leaseExpiryBadge(leaseCriticalDate(l));
    return `
    <tr data-id="${l.id}">
      <td>${l.landlord_name ? escapeHtml(l.landlord_name) : "(unknown)"}</td>
      <td>${l.property_address ? escapeHtml(l.property_address) : "—"}</td>
      <td><span class="badge ${badge.cls}">${escapeHtml(badge.label)}</span></td>
      <td><span class="badge status-${l.status}">${l.status}</span></td>
      <td>${fmtPct(l.overall_confidence)}</td>
    </tr>
  `;
  }).join("") || "<tr><td colspan='5' class='table-empty-row'>No leases.</td></tr>";

  tbody.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", () => selectLease(row.dataset.id));
  });

  document.querySelectorAll("#lease-table th.lease-sortable").forEach((th) => {
    th.classList.toggle("sort-active", th.dataset.sort === state.leaseSortField);
    th.dataset.order = th.dataset.sort === state.leaseSortField ? state.leaseSortOrder : "";
  });

  const start = total === 0 ? 0 : (state.leasePage - 1) * QUEUE_PAGE_SIZE + 1;
  const end = Math.min(total, state.leasePage * QUEUE_PAGE_SIZE);
  document.getElementById("lease-queue-page-info").textContent = `${start}–${end} of ${total}`;
  document.getElementById("lease-queue-prev-page").disabled = state.leasePage <= 1;
  document.getElementById("lease-queue-next-page").disabled = end >= total;
}

document.getElementById("lease-search").addEventListener("input", debounce(() => {
  state.leaseSearchQuery = document.getElementById("lease-search").value.trim();
  state.leasePage = 1;
  loadLeases();
}, 300));

document.querySelectorAll("#lease-table th.lease-sortable").forEach((th) => {
  th.addEventListener("click", () => {
    if (state.leaseSortField === th.dataset.sort) {
      state.leaseSortOrder = state.leaseSortOrder === "asc" ? "desc" : "asc";
    } else {
      state.leaseSortField = th.dataset.sort;
      state.leaseSortOrder = "asc";
    }
    state.leasePage = 1;
    loadLeases();
  });
});

document.getElementById("lease-queue-prev-page").addEventListener("click", () => {
  if (state.leasePage <= 1) return;
  state.leasePage -= 1;
  loadLeases();
});
document.getElementById("lease-queue-next-page").addEventListener("click", () => {
  state.leasePage += 1;
  loadLeases();
});

async function selectLease(id) {
  state.selectedLeaseId = id;
  const res = await apiFetch(`/api/leases/${id}`);
  const lease = await res.json();
  renderLeaseDetail(lease);
}

function leaseFieldConf(l, name) {
  return (l.field_confidence && l.field_confidence[name]) ?? 0;
}

const LEASE_EMPTY_DETAIL = `
  <div class="empty-state">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/></svg>
    <p class="hint">Select a lease from the list to review it.</p>
  </div>
`;

function renderLeaseDetail(l) {
  const el = document.getElementById("lease-queue-detail");

  if (l.status === "queued" || l.status === "processing") {
    const isPdf = (l.content_type || "").includes("pdf");
    el.innerHTML = `
      <div class="cross-check processing">⏳ Still processing this lease — this updates automatically. Most documents finish in well under a minute, but a slow OCR pass or AI response can occasionally take a couple of minutes.</div>
      <div class="doc-preview">
        <h3>Source document</h3>
        <div class="doc-preview-frame">
          ${isPdf ? `<iframe id="lease-doc-preview-media"></iframe>` : `<img id="lease-doc-preview-media" />`}
        </div>
      </div>
    `;
    loadLeasePreview(l);
    pollLeaseWhileProcessing(l.id);
    return;
  }

  const lowConf = (name) => leaseFieldConf(l, name) < 0.85 ? "low-confidence" : "";
  const isPdf = (l.content_type || "").includes("pdf");
  const preview = isPdf ? `<iframe id="lease-doc-preview-media"></iframe>` : `<img id="lease-doc-preview-media" />`;

  const statusBanner = l.status === "failed"
    ? `<div class="cross-check fail">⚠ Extraction failed: ${escapeHtml(l.error_message) || "Unknown error."} You can still fill in the fields below by hand.</div>`
    : `<div class="cross-check pass">✓ extraction method: ${l.extraction_method} &nbsp;·&nbsp; overall confidence: ${fmtPct(l.overall_confidence)}</div>`;

  const expiryB = leaseExpiryBadge(l.expiration_date);
  const noticeB = leaseExpiryBadge(l.renewal_notice_deadline);
  const expiryBanner = expiryB.cls === "expiry-expired"
    ? `<div class="cross-check fail">⚠ This lease expired on ${escapeHtml(l.expiration_date)}.</div>`
    : expiryB.cls === "expiry-soon"
    ? `<div class="cross-check warn">⚠ This lease expires on ${escapeHtml(l.expiration_date)} — within the next ${LEASE_EXPIRING_SOON_DAYS} days.</div>`
    : "";
  const noticeBanner = noticeB.cls === "expiry-expired"
    ? `<div class="cross-check fail">⚠ The renewal-option notice deadline (${escapeHtml(l.renewal_notice_deadline)}) has passed.</div>`
    : noticeB.cls === "expiry-soon"
    ? `<div class="cross-check warn">⚠ The renewal-option notice deadline is ${escapeHtml(l.renewal_notice_deadline)} — within the next ${LEASE_EXPIRING_SOON_DAYS} days. Miss it and the option lapses even though the lease hasn't ended yet.</div>`
    : "";

  el.innerHTML = `
    ${expiryBanner}
    ${noticeBanner}
    ${statusBanner}

    <div class="detail-grid">
      <div class="field ${lowConf("landlord_name")}"><label>Landlord</label><input id="lf-landlord_name" value="${escapeHtml(l.landlord_name)}" /></div>
      <div class="field ${lowConf("property_address")}"><label>Property Address</label><input id="lf-property_address" value="${escapeHtml(l.property_address)}" /></div>
      <div class="field ${lowConf("commencement_date")}"><label>Commencement Date</label><input id="lf-commencement_date" type="date" value="${l.commencement_date || ""}" /></div>
      <div class="field ${lowConf("expiration_date")}"><label>Expiration Date</label><input id="lf-expiration_date" type="date" value="${l.expiration_date || ""}" /></div>
      <div class="field ${lowConf("renewal_notice_deadline")}"><label>Renewal Notice Deadline</label><input id="lf-renewal_notice_deadline" type="date" value="${l.renewal_notice_deadline || ""}" /></div>
      <div class="field ${lowConf("monthly_rent")}"><label>Monthly Rent</label><input id="lf-monthly_rent" value="${l.monthly_rent ?? ""}" /></div>
      <div class="field ${lowConf("annual_escalation_pct")}"><label>Annual Escalation %</label><input id="lf-annual_escalation_pct" value="${l.annual_escalation_pct ?? ""}" /></div>
      <div class="field"><label>Note</label><input id="lf-note" value="${escapeHtml(l.note)}" /></div>
    </div>

    <div class="actions">
      <button class="save" id="lbtn-save">Save Corrections</button>
      <button class="approve" id="lbtn-approve">Approve</button>
      <button class="reject" id="lbtn-reject">Reject</button>
      ${l.status !== "approved" ? `<button class="retry" id="lbtn-retry">Retry Extraction</button>` : ""}
      <button class="delete" id="lbtn-delete">Delete</button>
    </div>

    <div class="doc-preview">
      <h3>Source document</h3>
      <div class="doc-preview-frame">
        ${preview}
      </div>
    </div>
  `;

  document.getElementById("lbtn-save").addEventListener("click", () => saveLeaseCorrections(l.id));
  document.getElementById("lbtn-approve").addEventListener("click", () => approveLease(l.id));
  document.getElementById("lbtn-reject").addEventListener("click", () => rejectLease(l.id));
  document.getElementById("lbtn-retry")?.addEventListener("click", () => retryLease(l.id));
  document.getElementById("lbtn-delete").addEventListener("click", () => deleteLease(l.id));

  loadLeasePreview(l);
}

const LEASE_POLL_MAX_ATTEMPTS = 120;

function pollLeaseWhileProcessing(id, attempt = 0) {
  if (attempt >= LEASE_POLL_MAX_ATTEMPTS) {
    if (state.selectedLeaseId === id) {
      const banner = document.querySelector("#lease-queue-detail .cross-check.processing");
      if (banner) {
        banner.textContent =
          "⏳ Still processing — this is taking much longer than usual. It will keep updating automatically; feel free to check back later.";
      }
    }
    return;
  }
  setTimeout(async () => {
    if (state.selectedLeaseId !== id) return;
    const res = await apiFetch(`/api/leases/${id}`);
    const l = await res.json();
    if (state.selectedLeaseId !== id) return;
    if (l.status === "queued" || l.status === "processing") {
      pollLeaseWhileProcessing(id, attempt + 1);
    } else {
      renderLeaseDetail(l);
      invalidateCache("/api/leases?");
      loadLeases();
    }
  }, 3000);
}

async function loadLeasePreview(l) {
  const media = document.getElementById("lease-doc-preview-media");
  if (!media) return;
  if (leaseDocPreviewObjectUrl) {
    URL.revokeObjectURL(leaseDocPreviewObjectUrl);
    leaseDocPreviewObjectUrl = null;
  }
  try {
    const res = await apiFetch(`/api/leases/${l.id}/file`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Could not load the source document.");
    }
    const blob = await res.blob();
    leaseDocPreviewObjectUrl = URL.createObjectURL(blob);
    media.src = leaseDocPreviewObjectUrl;
  } catch (err) {
    media.replaceWith(Object.assign(document.createElement("p"), { className: "hint", textContent: String(err.message || err) }));
  }
}

async function saveLeaseCorrections(id) {
  const payload = {
    landlord_name: document.getElementById("lf-landlord_name").value,
    property_address: document.getElementById("lf-property_address").value,
    commencement_date: document.getElementById("lf-commencement_date").value || null,
    expiration_date: document.getElementById("lf-expiration_date").value || null,
    renewal_notice_deadline: document.getElementById("lf-renewal_notice_deadline").value || null,
    monthly_rent: numOrNull(document.getElementById("lf-monthly_rent").value),
    annual_escalation_pct: numOrNull(document.getElementById("lf-annual_escalation_pct").value),
    note: document.getElementById("lf-note").value,
  };

  const res = await apiFetch(`/api/leases/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const l = await res.json();
  renderLeaseDetail(l);
  invalidateCache("/api/leases?");
  loadLeases();
}

async function approveLease(id) {
  const res = await apiFetch(`/api/leases/${id}/approve`, { method: "POST" });
  const l = await res.json();
  renderLeaseDetail(l);
  invalidateCache("/api/leases?");
  loadLeases();
}

async function rejectLease(id) {
  const res = await apiFetch(`/api/leases/${id}/reject`, { method: "POST" });
  const l = await res.json();
  renderLeaseDetail(l);
  invalidateCache("/api/leases?");
  loadLeases();
}

async function retryLease(id) {
  const res = await apiFetch(`/api/leases/${id}/retry`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't retry extraction", body.detail || "Could not retry this document.");
    return;
  }
  renderLeaseDetail(body);
  invalidateCache("/api/leases?");
  loadLeases();
}

async function deleteLease(id) {
  const ok = await confirmDialog("Delete this lease?", "This can't be undone from the review UI.", {
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;

  const res = await apiFetch(`/api/leases/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await alertDialog("Couldn't delete lease", body.detail || "Could not delete this lease.");
    return;
  }

  if (state.selectedLeaseId === id) {
    state.selectedLeaseId = null;
    document.getElementById("lease-queue-detail").innerHTML = LEASE_EMPTY_DETAIL;
  }
  invalidateCache("/api/leases?");
  loadLeases();
}

// ---- Matching ----
document.getElementById("source-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sourceType = document.getElementById("source-type").value;
  const fileInput = document.getElementById("source-file");
  if (!fileInput.files.length) return;
  const fd = new FormData();
  fd.append("file", fileInput.files[0]);

  const res = await apiFetch(`/api/matching/sources?source_type=${sourceType}`, { method: "POST", body: fd });
  if (!res.ok) {
    const err = await res.json();
    await alertDialog("Upload failed", err.detail || res.statusText);
    return;
  }
  fileInput.value = "";
  invalidateCache("/api/matching/sources");
  loadSources();
});

async function loadSources() {
  await cachedLoad(
    "/api/matching/sources",
    async () => (await apiFetch("/api/matching/sources")).json(),
    renderSources
  );
}

function renderSources(sources) {
  const list = sources.map((s) => (
    `<div class="source-row">
      <span>${escapeHtml(s.name)} (${s.source_type}) — ${s.entry_count} rows</span>
      <button type="button" class="source-delete" data-id="${s.id}" title="Delete" aria-label="Delete ${escapeHtml(s.name)}">&times;</button>
    </div>`
  )).join("") || "<div class='hint'>None yet.</div>";
  document.getElementById("sources-list").innerHTML = `<h3>Uploaded sources</h3><div class="source-list">${list}</div>`;

  document.querySelectorAll(".source-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteSource(btn.dataset.id));
  });
}

async function deleteSource(id) {
  const ok = await confirmDialog("Delete this source?", "Its uploaded rows will be removed. Past matching results stay in your history.", {
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  const res = await apiFetch(`/api/matching/sources/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await alertDialog("Couldn't delete source", body.detail || "Failed to delete source.");
    return;
  }
  invalidateCache("/api/matching/sources");
  loadSources();
}

document.getElementById("run-matching-btn").addEventListener("click", async () => {
  const res = await apiFetch("/api/matching/run", { method: "POST" });
  const summary = await res.json();
  document.getElementById("matching-summary").textContent =
    `Evaluated ${summary.invoices_evaluated} invoices — matched ${summary.matched}, partial ${summary.partial}, unmatched ${summary.unmatched}.`;
  invalidateCache("__matching_results__");
  loadMatchResults();
});

async function loadMatchResults() {
  await cachedLoad(
    "__matching_results__",
    async () => {
      const [resultsRes, invoicesRes] = await Promise.all([
        apiFetch("/api/matching/results"),
        apiFetch("/api/invoices?page_size=500"),
      ]);
      const results = await resultsRes.json();
      const { items: invoices } = await invoicesRes.json();
      return { results, invoices };
    },
    renderMatchResults
  );
}

function renderMatchResults({ results, invoices }) {
  const invoiceById = Object.fromEntries(invoices.map((i) => [i.id, i]));

  // API returns results newest-first, so keep only the first (most recent) result per invoice.
  const latestByInvoice = {};
  results.forEach((r) => { if (!(r.invoice_id in latestByInvoice)) latestByInvoice[r.invoice_id] = r; });

  const tbody = document.querySelector("#matching-table tbody");
  tbody.innerHTML = Object.values(latestByInvoice).map((r) => {
    const inv = invoiceById[r.invoice_id] || {};
    return `
      <tr>
        <td>${inv.original_filename ? escapeHtml(inv.original_filename) : r.invoice_id}</td>
        <td>${escapeHtml(inv.vendor_name || "")}</td>
        <td>${fmtMoney(inv.total)}</td>
        <td><span class="badge match-${r.status}">${r.status}</span></td>
        <td>${r.score.toFixed(0)}</td>
        <td>${escapeHtml(r.reasoning)}</td>
      </tr>
    `;
  }).join("") || "<tr><td colspan='6' class='table-empty-row'>No matching results yet.</td></tr>";
}

// ---- QuickBooks bank reconciliation ----
// Surfaces QuickBooks bank/card transactions that look like payment for a
// bill Rekono already pushed but hasn't been marked paid yet (see
// routes/integrations.js's GET .../bank-transactions). Lives inside the
// Matching tab since it's the same underlying job -- lining up an external
// record against Rekono's invoices -- just against QuickBooks' bank feed
// instead of an uploaded CSV.
async function loadQuickbooksReconciliation() {
  const section = document.getElementById("qb-reconcile-section");
  if (!state.quickbooksConnected) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";
  await cachedLoad(
    "__qb_reconcile__",
    async () => {
      const res = await apiFetch("/api/integrations/quickbooks/bank-transactions");
      return res.ok ? res.json() : [];
    },
    renderQuickbooksReconciliation
  );
}

function renderQuickbooksReconciliation(transactions) {
  const list = document.getElementById("qb-reconcile-list");
  if (!transactions.length) {
    list.innerHTML = "<div class='hint'>No unmatched bank transactions right now.</div>";
    return;
  }

  list.innerHTML = transactions.map((t) => {
    const candidateOptions = t.candidates
      .map((c) => `<option value="${c.id}" ${c.id === t.suggested_invoice_id ? "selected" : ""}>${escapeHtml(c.vendor_name || "Unknown vendor")} — ${fmtMoney(c.total)}</option>`)
      .join("");
    const note = !t.candidates.length
      ? "No unpaid pushed bills match this amount."
      : t.suggested_invoice_id
      ? `Suggested match${t.confidence != null ? ` (${fmtPct(t.confidence)} confidence)` : ""}${t.reasoning ? ` — ${escapeHtml(t.reasoning)}` : ""}`
      : "Multiple bills match this amount — pick the right one.";

    return `
      <div class="reconcile-row" data-txn-id="${t.transaction_id}">
        <div class="reconcile-txn">
          <span class="reconcile-date">${escapeHtml(t.date || "—")}</span>
          <span class="reconcile-payee">${escapeHtml(t.payee_name || t.description || "Unknown payee")}</span>
          <span class="reconcile-amount">${fmtMoney(t.amount)}</span>
        </div>
        <div class="reconcile-match">
          <select class="reconcile-select" ${!t.candidates.length ? "disabled" : ""}>
            <option value="">Choose a bill…</option>
            ${candidateOptions}
          </select>
          <button type="button" class="reconcile-confirm" ${!t.candidates.length ? "disabled" : ""}>Confirm match</button>
          <button type="button" class="reconcile-dismiss">Not a match</button>
        </div>
        <div class="reconcile-note hint">${note}</div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".reconcile-confirm").forEach((btn) => {
    btn.addEventListener("click", () => confirmBankMatch(btn.closest(".reconcile-row")));
  });
  list.querySelectorAll(".reconcile-dismiss").forEach((btn) => {
    btn.addEventListener("click", () => dismissBankTransaction(btn.closest(".reconcile-row")));
  });
}

async function confirmBankMatch(row) {
  const txnId = row.dataset.txnId;
  const invoiceId = row.querySelector(".reconcile-select").value;
  if (!invoiceId) {
    await alertDialog("Choose a bill", "Pick which bill this transaction is paying before confirming.");
    return;
  }
  const transactionDate = row.querySelector(".reconcile-date").textContent;
  try {
    const res = await apiFetch(`/api/integrations/quickbooks/bank-transactions/${txnId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: invoiceId, transaction_date: transactionDate }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not confirm this match.");
    invalidateCache("__qb_reconcile__");
    row.remove();
  } catch (err) {
    await alertDialog("Couldn't confirm match", err.message || String(err));
  }
}

async function dismissBankTransaction(row) {
  const txnId = row.dataset.txnId;
  try {
    const res = await apiFetch(`/api/integrations/quickbooks/bank-transactions/${txnId}/dismiss`, { method: "POST" });
    if (!res.ok) throw new Error("Could not dismiss this transaction.");
    invalidateCache("__qb_reconcile__");
    row.remove();
  } catch (err) {
    await alertDialog("Couldn't dismiss", err.message || String(err));
  }
}

// ---- Quick Review ----
// A flat queue of (invoice, low-confidence field) pairs -- see
// GET /api/invoices/quick-review-queue -- reviewed one field at a time
// instead of opening a whole invoice's detail view per invoice. Fetched
// once per tab visit and consumed locally: state.quickReviewQueue[0] is
// always "up next". Confirming/correcting a field posts it to the server
// and drops it from the queue; skipping doesn't save anything -- it just
// cycles that field to the back of the local queue, so it resurfaces later
// in the same pass instead of needing a full reload to see it again.
const QUICK_REVIEW_FIELD_LABELS = {
  vendor_name: "Vendor",
  invoice_number: "Invoice #",
  invoice_date: "Invoice Date",
  due_date: "Due Date",
  po_reference: "PO Reference",
  currency: "Currency",
  subtotal: "Subtotal",
  tax: "Tax",
  total: "Total",
};
const QUICK_REVIEW_NUMERIC_FIELDS = new Set(["subtotal", "tax", "total"]);

async function loadQuickReviewQueue() {
  const res = await apiFetch("/api/invoices/quick-review-queue");
  state.quickReviewQueue = res.ok ? await res.json() : [];
  state.quickReviewTotal = state.quickReviewQueue.length;
  renderQuickReviewCard();
}

function renderQuickReviewCard() {
  const empty = document.getElementById("quickreview-empty");
  const card = document.getElementById("quickreview-card");
  const item = state.quickReviewQueue[0];

  if (!item) {
    empty.style.display = "flex";
    card.style.display = "none";
    return;
  }
  empty.style.display = "none";
  card.style.display = "block";

  const doneCount = state.quickReviewTotal - state.quickReviewQueue.length;
  document.getElementById("quickreview-progress").textContent = `${doneCount + 1} of ${state.quickReviewTotal}`;
  document.getElementById("quickreview-vendor").textContent = item.vendor_name || "Unknown vendor";
  document.getElementById("quickreview-filename").textContent = item.original_filename || "";
  document.getElementById("quickreview-field-label").textContent = QUICK_REVIEW_FIELD_LABELS[item.field] || item.field;
  document.getElementById("quickreview-confidence").textContent = fmtPct(item.confidence);
  document.getElementById("quickreview-status").textContent = "";

  const input = document.getElementById("quickreview-value");
  input.type = QUICK_REVIEW_NUMERIC_FIELDS.has(item.field) ? "number" : item.field.endsWith("date") ? "date" : "text";
  input.step = QUICK_REVIEW_NUMERIC_FIELDS.has(item.field) ? "0.01" : "";
  input.value = item.value ?? "";
  input.focus();
  input.select();
}

document.getElementById("quickreview-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const item = state.quickReviewQueue[0];
  if (!item) return;
  const statusEl = document.getElementById("quickreview-status");
  const raw = document.getElementById("quickreview-value").value;
  const value = QUICK_REVIEW_NUMERIC_FIELDS.has(item.field) ? (raw === "" ? null : Number(raw)) : raw;

  try {
    const res = await apiFetch(`/api/invoices/${item.invoice_id}/quick-review-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: item.field, value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not save this field.");
    state.quickReviewQueue.shift();
    if (body.invoice_status === "approved") {
      // Every field this invoice had flagged is now confirmed/corrected --
      // drop any other queued fields for the same invoice too, since it's
      // already approved and there's nothing left for them to unblock.
      state.quickReviewQueue = state.quickReviewQueue.filter((i) => i.invoice_id !== item.invoice_id);
    }
    renderQuickReviewCard();
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("quickreview-skip").addEventListener("click", () => {
  const item = state.quickReviewQueue.shift();
  if (item) state.quickReviewQueue.push(item);
  renderQuickReviewCard();
});

document.getElementById("quickreview-open-full").addEventListener("click", () => {
  const item = state.quickReviewQueue[0];
  if (!item) return;
  switchTab("review");
  selectInvoice(item.invoice_id);
});

// ---- Ask Rekono ----
// Builds the thread via DOM methods (textContent), not innerHTML --
// unlike the rest of this file, this handles raw user input (the
// question) and an LLM response, neither of which should ever be
// interpreted as HTML.
document.getElementById("ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("ask-input");
  const question = input.value.trim();
  if (!question) return;

  const entry = document.createElement("div");
  entry.className = "ask-entry";

  const questionEl = document.createElement("div");
  questionEl.className = "ask-question";
  questionEl.textContent = question;

  const answerEl = document.createElement("div");
  answerEl.className = "ask-answer ask-answer-loading";
  answerEl.textContent = "Thinking…";

  entry.append(questionEl, answerEl);
  document.getElementById("ask-thread").prepend(entry);
  input.value = "";
  input.disabled = true;

  try {
    const res = await apiFetch("/api/assistant/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history: state.askHistory }),
    });
    const body = await res.json();
    answerEl.classList.remove("ask-answer-loading");
    if (res.ok) {
      answerEl.textContent = body.answer;
      state.askHistory.push({ role: "user", content: question }, { role: "assistant", content: body.answer });
      state.askHistory = state.askHistory.slice(-MAX_ASK_HISTORY_MESSAGES);
    } else {
      answerEl.classList.add("ask-answer-error");
      answerEl.textContent = body.detail || "Something went wrong.";
    }
  } catch (err) {
    answerEl.classList.remove("ask-answer-loading");
    answerEl.classList.add("ask-answer-error");
    answerEl.textContent = String(err);
  } finally {
    input.disabled = false;
    input.focus();
  }
});

// ---- Settings ----
// PLAN_NAMES/PLAN_ORDER/planSummaryText/openUpgradeModal come from auth.js
// -- both scripts share the page's global scope (no bundler/modules here).
async function loadOrgSettings() {
  await cachedLoad(
    "__org_settings__",
    async () => {
      const [settingsRes, me] = await Promise.all([
        apiFetch("/api/org/settings").then((r) => r.json()),
        apiFetch("/api/auth/me").then((r) => r.json()),
      ]);
      return { settingsRes, me };
    },
    renderOrgSettings
  );
}

function renderOrgSettings({ settingsRes, me }) {
  const isOwner = me.role === "owner";

  // Account
  document.getElementById("settings-account-name").value = me.full_name || "";
  document.getElementById("settings-account-email").textContent = me.email;
  document.getElementById("settings-account-status").textContent = "";
  document.getElementById("settings-password-status").textContent = "";

  // Organization
  const orgNameInput = document.getElementById("settings-org-name");
  orgNameInput.value = settingsRes.org_name || "";
  orgNameInput.disabled = !isOwner;
  document.getElementById("settings-org-save-btn").style.display = isOwner ? "" : "none";
  document.getElementById("settings-org-readonly-note").style.display = isOwner ? "none" : "block";
  document.getElementById("settings-org-status").textContent = "";

  // Billing
  document.getElementById("settings-billing-summary").textContent = planSummaryText(me);
  document.getElementById("settings-manage-billing-btn").style.display = me.plan !== "free" ? "" : "none";
  const rank = PLAN_ORDER.indexOf(me.plan);
  document.getElementById("settings-billing-upgrade-btn").style.display =
    rank >= 0 && rank < PLAN_ORDER.length - 1 ? "" : "none";
  document.getElementById("settings-billing-status").textContent = "";

  // Risk-based auto-approval -- rendered before the confidence-threshold
  // block's early return below, since the two features are gated by
  // separate plan flags (even though today's plans.js happens to turn them
  // on together).
  const autoApprovalLocked = document.getElementById("settings-autoapproval-locked");
  const autoApprovalForm = document.getElementById("settings-autoapproval-form");
  document.getElementById("settings-autoapproval-status").textContent = "";

  if (!settingsRes.risk_based_auto_approval_available) {
    autoApprovalLocked.style.display = "block";
    autoApprovalForm.style.display = "none";
    document.getElementById("settings-autoapproval-plan-name").textContent = PLAN_NAMES[me.plan] || me.plan;
  } else {
    autoApprovalLocked.style.display = "none";
    autoApprovalForm.style.display = "block";
    document.getElementById("settings-autoapproval-enabled").checked = settingsRes.auto_approval_enabled;
    document.getElementById("settings-autoapproval-max").value = settingsRes.auto_approval_max_amount ?? "";
  }

  // Statistical sampling of auto-approved invoices -- same plan-gated shape
  // as auto-approval above.
  const samplingLocked = document.getElementById("settings-sampling-locked");
  const samplingForm = document.getElementById("settings-sampling-form");
  document.getElementById("settings-sampling-status").textContent = "";

  if (!settingsRes.risk_based_auto_approval_available) {
    samplingLocked.style.display = "block";
    samplingForm.style.display = "none";
    document.getElementById("settings-sampling-plan-name").textContent = PLAN_NAMES[me.plan] || me.plan;
    document.getElementById("settings-qa-queue").innerHTML = "";
  } else {
    samplingLocked.style.display = "none";
    samplingForm.style.display = "block";
    document.getElementById("settings-sampling-enabled").checked = settingsRes.sample_review_enabled;
    document.getElementById("settings-sampling-rate").value =
      settingsRes.sample_review_rate != null ? Math.round(settingsRes.sample_review_rate * 100) : "";
    loadQaSampleQueue();
  }

  // Review queue confidence threshold
  const locked = document.getElementById("settings-confidence-locked");
  const form = document.getElementById("settings-confidence-form");
  const statusEl = document.getElementById("settings-confidence-status");
  statusEl.textContent = "";

  const defaultPct = Math.round(settingsRes.default_confidence_threshold * 100);
  document.getElementById("settings-default-threshold").textContent = `${defaultPct}%`;
  document.getElementById("settings-default-threshold-locked").textContent = `${defaultPct}%`;

  if (!settingsRes.custom_confidence_threshold_available) {
    locked.style.display = "block";
    form.style.display = "none";
    document.getElementById("settings-current-plan-name").textContent = PLAN_NAMES[me.plan] || me.plan;
    return;
  }

  locked.style.display = "none";
  form.style.display = "block";
  const effectivePct = Math.round(
    (settingsRes.confidence_threshold ?? settingsRes.default_confidence_threshold) * 100
  );
  document.getElementById("settings-confidence-input").value = effectivePct;
}

document.getElementById("settings-account-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("settings-account-status");
  const fullName = document.getElementById("settings-account-name").value.trim();
  try {
    const res = await apiFetch("/api/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: fullName }),
    });
    const body = await res.json();
    statusEl.textContent = res.ok ? "Saved." : body.detail || "Something went wrong.";
    if (res.ok) {
      invalidateCache("__org_settings__");
      showApp(body); // refreshes the sidebar name badge too
    }
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("settings-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("settings-password-status");
  const current = document.getElementById("settings-password-current").value;
  const next = document.getElementById("settings-password-new").value;
  const confirm = document.getElementById("settings-password-confirm").value;
  if (next !== confirm) {
    statusEl.textContent = "New passwords do not match.";
    return;
  }
  try {
    const res = await apiFetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    const body = await res.json();
    statusEl.textContent = res.ok ? "Password changed." : body.detail || "Something went wrong.";
    if (res.ok) document.getElementById("settings-password-form").reset();
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("settings-org-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("settings-org-status");
  const orgName = document.getElementById("settings-org-name").value.trim();
  try {
    const res = await apiFetch("/api/org/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org_name: orgName }),
    });
    const body = await res.json();
    statusEl.textContent = res.ok ? "Saved." : body.detail || "Something went wrong.";
    if (res.ok) invalidateCache("__org_settings__");
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("settings-manage-billing-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("settings-billing-status");
  statusEl.textContent = "";
  try {
    const res = await apiFetch("/api/billing/portal");
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not open billing management.");
    window.location.href = body.url;
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("settings-billing-upgrade-btn").addEventListener("click", () => openUpgradeModal());

document.getElementById("settings-upgrade-btn").addEventListener("click", () => openUpgradeModal());

document.getElementById("settings-confidence-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("settings-confidence-status");
  const pct = Number(document.getElementById("settings-confidence-input").value);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    statusEl.textContent = "Enter a number between 0 and 100.";
    return;
  }
  try {
    const res = await apiFetch("/api/org/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confidence_threshold: pct / 100 }),
    });
    const body = await res.json();
    statusEl.textContent = res.ok ? "Saved." : body.detail || "Something went wrong.";
    if (res.ok) invalidateCache("__org_settings__");
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("settings-confidence-reset").addEventListener("click", async () => {
  const statusEl = document.getElementById("settings-confidence-status");
  try {
    await apiFetch("/api/org/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confidence_threshold: null }),
    });
    statusEl.textContent = "Reset to default.";
    invalidateCache("__org_settings__");
    loadOrgSettings();
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("settings-autoapproval-upgrade-btn").addEventListener("click", () => openUpgradeModal());

document.getElementById("settings-autoapproval-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("settings-autoapproval-status");
  const enabled = document.getElementById("settings-autoapproval-enabled").checked;
  const maxRaw = document.getElementById("settings-autoapproval-max").value;
  const max = maxRaw === "" ? null : Number(maxRaw);

  if (max !== null && (!Number.isFinite(max) || max < 0)) {
    statusEl.textContent = "Enter a maximum amount of 0 or more.";
    return;
  }
  if (enabled && max === null) {
    statusEl.textContent = "Set a maximum dollar amount before enabling.";
    return;
  }

  try {
    const res = await apiFetch("/api/org/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_approval_enabled: enabled, auto_approval_max_amount: max }),
    });
    const body = await res.json();
    statusEl.textContent = res.ok ? "Saved." : body.detail || "Something went wrong.";
    if (res.ok) invalidateCache("__org_settings__");
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("settings-sampling-upgrade-btn").addEventListener("click", () => openUpgradeModal());

document.getElementById("settings-sampling-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("settings-sampling-status");
  const enabled = document.getElementById("settings-sampling-enabled").checked;
  const pctRaw = document.getElementById("settings-sampling-rate").value;
  const rate = pctRaw === "" ? null : Number(pctRaw) / 100;

  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1)) {
    statusEl.textContent = "Enter a percentage between 0 and 100.";
    return;
  }
  if (enabled && rate === null) {
    statusEl.textContent = "Set a sample rate before enabling.";
    return;
  }

  try {
    const res = await apiFetch("/api/org/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sample_review_enabled: enabled, sample_review_rate: rate }),
    });
    const body = await res.json();
    statusEl.textContent = res.ok ? "Saved." : body.detail || "Something went wrong.";
    if (res.ok) invalidateCache("__org_settings__");
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

// Pending spot-checks: auto-approved invoices randomly sampled for a
// retrospective QA look (see pipeline.js's processInvoice). Lightweight by
// design -- this isn't blocking anything (the invoice is already approved),
// so it's a compact list rather than the full Review Queue table.
async function loadQaSampleQueue() {
  const res = await apiFetch("/api/invoices/qa-sample-queue");
  renderQaSampleQueue(res.ok ? await res.json() : []);
}

function renderQaSampleQueue(items) {
  const el = document.getElementById("settings-qa-queue");
  if (!items.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML =
    `<h4 style="margin: 0 0 0.5rem;">Pending spot-checks (${items.length})</h4>` +
    items
      .map(
        (item) => `
      <div class="qa-sample-row" data-id="${item.invoice_id}">
        <span class="qa-sample-vendor">${escapeHtml(item.vendor_name || "Unknown vendor")}</span>
        <span class="hint">${fmtMoney(item.total)} · ${escapeHtml(item.invoice_date || "")} · ${fmtPct(item.overall_confidence)} confidence</span>
        <div class="qa-sample-actions">
          <button type="button" class="qa-sample-confirm">Looks good</button>
          <button type="button" class="qa-sample-flag">Flag issue</button>
        </div>
      </div>
    `
      )
      .join("");

  el.querySelectorAll(".qa-sample-confirm").forEach((btn) => {
    btn.addEventListener("click", () => submitQaReview(btn.closest(".qa-sample-row").dataset.id, "confirmed"));
  });
  el.querySelectorAll(".qa-sample-flag").forEach((btn) => {
    btn.addEventListener("click", () => submitQaReview(btn.closest(".qa-sample-row").dataset.id, "issue_flagged"));
  });
}

async function submitQaReview(invoiceId, outcome) {
  try {
    const res = await apiFetch(`/api/invoices/${invoiceId}/qa-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Could not save this spot-check.");
    }
    loadQaSampleQueue();
  } catch (err) {
    await alertDialog("Couldn't save spot-check", err.message || String(err));
  }
}

// ---- QuickBooks integration ----
async function loadQuickbooksStatus() {
  await cachedLoad("__quickbooks__", async () => (await apiFetch("/api/integrations/quickbooks/status")).json(), renderQuickbooksStatus);
}

async function renderQuickbooksStatus(status) {
  state.quickbooksConnected = status.connected;
  document.getElementById("settings-quickbooks-status").textContent = "";

  // connected always wins, even in the (only ever config-drift) case where
  // QUICKBOOKS_CLIENT_ID was unset after a connection was already made --
  // otherwise "not set up yet" and "connected" could show at once.
  document.getElementById("qb-unconfigured").style.display = !status.configured && !status.connected ? "block" : "none";
  document.getElementById("qb-disconnected").style.display = status.configured && !status.connected ? "block" : "none";
  document.getElementById("qb-connected").style.display = status.connected ? "block" : "none";
  if (!status.connected) return;

  const select = document.getElementById("qb-default-account");
  select.innerHTML = `<option value="">Choose an account…</option>`;
  if (status.default_expense_account_id) {
    select.innerHTML += `<option value="${status.default_expense_account_id}" selected>${escapeHtml(status.default_expense_account_name || status.default_expense_account_id)}</option>`;
  }

  try {
    const res = await apiFetch("/api/integrations/quickbooks/accounts");
    const accounts = await res.json();
    if (!res.ok) return; // leave the current selection showing rather than clearing it on a transient failure
    select.innerHTML =
      `<option value="">Choose an account…</option>` +
      accounts
        .map(
          (a) =>
            `<option value="${a.id}" ${a.id === status.default_expense_account_id ? "selected" : ""}>${escapeHtml(a.name)}</option>`
        )
        .join("");
  } catch {
    // Accounts list failed to load (e.g. token expired) -- the previously
    // saved default still shows via the option added above, just without
    // the rest of the list to pick a different one from until this
    // succeeds.
  }
}

document.getElementById("qb-connect-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("settings-quickbooks-status");
  statusEl.textContent = "";
  try {
    const res = await apiFetch("/api/integrations/quickbooks/connect");
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not connect to QuickBooks.");
    window.location.href = body.authorize_url;
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("qb-disconnect-btn").addEventListener("click", async () => {
  const ok = await confirmDialog("Disconnect QuickBooks?", "You can reconnect at any time.", { confirmLabel: "Disconnect" });
  if (!ok) return;
  const statusEl = document.getElementById("settings-quickbooks-status");
  try {
    const res = await apiFetch("/api/integrations/quickbooks/disconnect", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not disconnect QuickBooks.");
    invalidateCache("__quickbooks__");
    renderQuickbooksStatus(body);
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("qb-default-account").addEventListener("change", async (e) => {
  const option = e.target.selectedOptions[0];
  const statusEl = document.getElementById("settings-quickbooks-status");
  if (!option || !option.value) return;
  try {
    const res = await apiFetch("/api/integrations/quickbooks/default-account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: option.value, account_name: option.textContent }),
    });
    const body = await res.json();
    statusEl.textContent = res.ok ? "Default account saved." : body.detail || "Something went wrong.";
    if (res.ok) invalidateCache("__quickbooks__");
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

// ---- Team ----
async function loadTeam() {
  await cachedLoad(
    "__team__",
    async () => {
      const [data, me] = await Promise.all([
        apiFetch("/api/team").then((r) => r.json()),
        apiFetch("/api/auth/me").then((r) => r.json()),
      ]);
      return { data, me };
    },
    renderTeam
  );
}

function renderTeam({ data, me }) {
  const isOwner = me.role === "owner";

  const seatText = data.seat_limit === null ? `${data.seats_used} seats used (unlimited)` : `${data.seats_used} of ${data.seat_limit} seats used`;
  document.getElementById("team-seats-summary").textContent = seatText;

  const inviteBlock = document.getElementById("team-invite-block");
  const seatAvailable = data.seat_limit === null || data.seats_used < data.seat_limit;
  inviteBlock.style.display = isOwner ? "block" : "none";
  document.getElementById("team-invite-form").querySelector("button[type=submit]").disabled = !seatAvailable;
  if (isOwner && !seatAvailable) {
    document.getElementById("team-invite-status").textContent = "You're at your plan's seat limit. Upgrade to invite more teammates.";
  }

  const membersBody = document.getElementById("team-members-body");
  membersBody.innerHTML = data.members
    .map(
      (m) => `
    <tr>
      <td>${escapeHtml(m.full_name)}${m.is_you ? " (you)" : ""}</td>
      <td>${escapeHtml(m.email)}</td>
      <td>${m.role}</td>
      <td>${isOwner && !m.is_you ? `<button type="button" class="team-remove-btn" data-user-id="${m.id}">Remove</button>` : ""}</td>
    </tr>
  `
    )
    .join("");
  membersBody.querySelectorAll(".team-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog("Remove this teammate?", "They'll lose access to your account immediately.", {
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      await apiFetch(`/api/team/members/${btn.dataset.userId}`, { method: "DELETE" });
      invalidateCache("__team__");
      loadTeam();
    });
  });

  const invitesSection = document.getElementById("team-invites-section");
  invitesSection.style.display = data.pending_invites.length ? "block" : "none";
  const invitesBody = document.getElementById("team-invites-body");
  invitesBody.innerHTML = data.pending_invites
    .map(
      (i) => `
    <tr>
      <td>${escapeHtml(i.email)}</td>
      <td>${new Date(i.invited_at).toLocaleDateString()}</td>
      <td>${isOwner ? `<button type="button" class="team-revoke-btn" data-invite-id="${i.id}">Revoke</button>` : ""}</td>
    </tr>
  `
    )
    .join("");
  invitesBody.querySelectorAll(".team-revoke-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await apiFetch(`/api/team/invites/${btn.dataset.inviteId}`, { method: "DELETE" });
      invalidateCache("__team__");
      loadTeam();
    });
  });
}

document.getElementById("team-invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const emailInput = document.getElementById("team-invite-email");
  const statusEl = document.getElementById("team-invite-status");
  try {
    const res = await apiFetch("/api/team/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailInput.value }),
    });
    const body = await res.json();
    if (!res.ok) {
      statusEl.textContent = body.detail || "Something went wrong.";
      return;
    }
    emailInput.value = "";
    statusEl.textContent = body.email_sent
      ? `Invite sent to ${body.email}.`
      : `Invite created for ${body.email}. Email wasn't sent (no RESEND_API_KEY configured) — share this link with them: ${body.invite_url}`;
    invalidateCache("__team__");
    loadTeam();
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

// ---- Init ----
// ---- Dashboard (the landing tab) ----
// Everything below renders from one GET /api/dashboard payload (see
// routes/dashboard.js). No number here is computed client-side from a
// partial list -- the server does the counting so the dashboard can't
// disagree with the tab it links to.

function fmtCompactMoney(v) {
  const n = Number(v || 0);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `$${(n / 1000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function greetingForHour(hour) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// A KPI's supporting line carries the "so what" -- a bare dollar figure
// doesn't tell you whether it's fine. Where there's a genuine problem
// (overdue, failed) the sub-line is escalated to a warning tone rather than
// being tucked into the same muted grey as everything else.
function kpiCard({ label, value, sub, subTone = "", accent = "" }) {
  return `
    <div class="kpi-card${accent ? ` kpi-${accent}` : ""}">
      <span class="kpi-label">${label}</span>
      <span class="kpi-value">${value}</span>
      <span class="kpi-sub${subTone ? ` kpi-sub-${subTone}` : ""}">${sub}</span>
    </div>`;
}

function renderDashboardKpis(k) {
  const el = document.getElementById("dash-kpis");
  el.removeAttribute("aria-busy");

  // Rounded only to decide whether to escalate the tone -- never shown as
  // a bare percentage, because 15 of 10,000 rounds to "0%", which reads as
  // "nothing counted" right next to a card whose value is 15.
  const capPct =
    k.document_cap ? Math.min(100, Math.round((k.documents_used_this_month / k.document_cap) * 100)) : 0;

  const cards = [
    kpiCard({
      label: "Outstanding AP",
      value: fmtCompactMoney(k.outstanding_ap),
      sub: k.overdue_count
        ? `${k.outstanding_ap_count} open · ${k.overdue_count} past due`
        : `${k.outstanding_ap_count} invoice${k.outstanding_ap_count === 1 ? "" : "s"} open`,
      subTone: k.overdue_count ? "bad" : "",
      accent: k.overdue_count ? "bad" : "",
    }),
    kpiCard({
      label: "Approved this month",
      value: fmtCompactMoney(k.approved_this_month_value),
      sub: k.touchless.total_approvals
        ? `${k.touchless.total_approvals} approval${k.touchless.total_approvals === 1 ? "" : "s"} recorded`
        : "No approvals yet this month",
    }),
    kpiCard({
      label: "Review queue",
      value: String(k.review_queue),
      sub: k.in_flight ? `${k.in_flight} still extracting` : "Across all document types",
      accent: k.review_queue ? "warn" : "good",
    }),
    kpiCard({
      label: "Touchless rate",
      value: k.touchless.rate === null ? "—" : `${Math.round(k.touchless.rate * 100)}%`,
      sub:
        k.touchless.rate === null
          ? "Needs approvals to measure"
          : `${k.touchless.auto_approved} of ${k.touchless.total_approvals} auto-approved`,
    }),
    kpiCard({
      label: "Avg confidence",
      value: k.avg_confidence === null ? "—" : `${Math.round(k.avg_confidence * 100)}%`,
      sub: k.failed ? `${k.failed} extraction${k.failed === 1 ? "" : "s"} failed` : "Across extracted invoices",
      subTone: k.failed ? "bad" : "",
    }),
    kpiCard({
      label: "Documents this month",
      value: String(k.documents_used_this_month),
      sub: k.document_cap
        ? `of ${k.document_cap.toLocaleString()} included this month`
        : "No cap on this plan",
      subTone: capPct >= 90 ? "bad" : "",
    }),
  ];

  el.innerHTML = cards.join("");
}

// Inline SVG rather than a charting library: it's a 14-bar bar chart, and
// pulling in a dependency for it would cost more (bundle, CSP surface) than
// it saves. Bars are drawn as percentages of the container so the chart is
// fluid without needing a resize listener.
function renderVolumeChart(trend) {
  const el = document.getElementById("dash-volume");
  const max = Math.max(...trend.map((d) => d.count), 1);
  const total = trend.reduce((sum, d) => sum + d.count, 0);

  if (!total) {
    el.innerHTML = `<p class="dash-empty">Nothing processed in the last 14 days. <button type="button" class="linklike" data-tab="upload">Upload a document</button> to get started.</p>`;
    el.querySelector("[data-tab]").addEventListener("click", (e) => switchTab(e.currentTarget.dataset.tab));
    return;
  }

  const bars = trend
    .map((d) => {
      const pct = (d.count / max) * 100;
      const label = new Date(`${d.date}T00:00:00Z`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
      // A zero day gets a fixed 3px stub rather than a percentage height:
      // as a fraction of the chart it rounds to a sub-pixel hairline, which
      // reads as a rendering glitch instead of "nothing happened that day".
      const height = d.count ? `${Math.max(pct, 4)}%` : "3px";
      return `
        <div class="vol-bar-wrap" title="${label}: ${d.count} document${d.count === 1 ? "" : "s"}">
          <div class="vol-bar${d.count ? "" : " is-zero"}" style="height: ${height}"></div>
        </div>`;
    })
    .join("");

  const first = trend[0].date;
  const last = trend[trend.length - 1].date;
  const fmtAxis = (iso) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

  el.innerHTML = `
    <div class="vol-summary"><strong>${total}</strong> document${total === 1 ? "" : "s"} processed</div>
    <div class="vol-chart">${bars}</div>
    <div class="vol-axis"><span>${fmtAxis(first)}</span><span>${fmtAxis(last)}</span></div>`;
}

function renderAttention(items) {
  const el = document.getElementById("dash-attention");
  const active = items.filter((i) => i.count > 0);

  if (!active.length) {
    el.innerHTML = `<p class="dash-empty dash-empty-good">Nothing needs attention — no overdue invoices, failed extractions, or approaching deadlines.</p>`;
    return;
  }

  el.innerHTML = active
    .map(
      (i) => `
      <button type="button" class="attn-row attn-${i.severity}" data-tab="${i.tab}">
        <span class="attn-dot"></span>
        <span class="attn-label">${i.label}</span>
        <span class="attn-count">${i.count}</span>
      </button>`
    )
    .join("");

  el.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );
}

function renderWorkflow(items) {
  const el = document.getElementById("dash-workflow");
  el.innerHTML = items
    .map(
      (i) => `
      <button type="button" class="wf-tile${i.count ? "" : " is-clear"}" data-tab="${i.tab}">
        <span class="wf-count">${i.count}</span>
        <span class="wf-label">${i.label}</span>
      </button>`
    )
    .join("");

  el.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );
}

function renderIntegrations(integrations) {
  const el = document.getElementById("dash-integrations");
  const rows = [
    {
      name: "AI extraction",
      on: integrations.ai_extraction,
      onText: "Active",
      offText: "Heuristic fallback",
    },
    { name: "QuickBooks", on: integrations.quickbooks, onText: "Connected", offText: "Not connected" },
  ];
  el.innerHTML = rows
    .map(
      (r) => `
      <div class="intg-row">
        <span class="intg-dot${r.on ? " is-on" : ""}"></span>
        <span class="intg-name">${r.name}</span>
        <span class="intg-state">${r.on ? r.onText : r.offText}</span>
      </div>`
    )
    .join("");
}

async function loadDashboard() {
  const errorEl = document.getElementById("dash-error");
  errorEl.style.display = "none";

  const user = window.currentUser;
  const firstName = (user?.full_name || "").trim().split(/\s+/)[0];
  document.getElementById("dash-greeting-text").textContent = firstName
    ? `${greetingForHour(new Date().getHours())}, ${firstName}`
    : greetingForHour(new Date().getHours());

  try {
    const res = await apiFetch("/api/dashboard");
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Could not load your dashboard.");

    document.getElementById("dash-greeting-sub").textContent = `${data.org_name} · ${new Date().toLocaleDateString(
      undefined,
      { weekday: "long", month: "long", day: "numeric" }
    )}`;

    renderDashboardKpis(data.kpis);
    renderVolumeChart(data.volume_trend);
    renderAttention(data.attention);
    renderWorkflow(data.workflow);
    renderIntegrations(data.integrations);
  } catch (err) {
    errorEl.textContent = String(err.message || err);
    errorEl.style.display = "block";
    document.getElementById("dash-kpis").innerHTML = "";
  }
}

// The export endpoints are bearer-token authenticated, so a plain <a href>
// would hit them with no Authorization header and 401. Fetch through
// apiFetch (which attaches the token) and hand the browser a blob: URL
// instead -- same approach the document-preview panes already use. Shared
// by both the dashboard's Reports rail and the Export tab's cards, which
// otherwise duplicated this exact fetch-blob-download dance.
async function downloadExport(path) {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error("Export failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").slice(-2).join("-").replace("/", "-");
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.querySelectorAll(".dash-report[data-export]").forEach((link) => {
  link.addEventListener("click", async (e) => {
    e.preventDefault();
    const fmtEl = link.querySelector(".dash-report-fmt");
    const original = fmtEl.textContent;
    fmtEl.textContent = "…";
    try {
      await downloadExport(link.dataset.export);
    } catch (err) {
      const errorEl = document.getElementById("dash-error");
      errorEl.textContent = String(err.message || err);
      errorEl.style.display = "block";
    } finally {
      fmtEl.textContent = original;
    }
  });
});

document.querySelectorAll(".export-btn[data-export]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const statusEl = document.getElementById("export-status");
    statusEl.style.display = "none";
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Preparing…";
    try {
      await downloadExport(btn.dataset.export);
    } catch (err) {
      statusEl.textContent = String(err.message || err);
      statusEl.style.display = "block";
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
});


// Called by auth.js once a valid session is confirmed (not on script load,
// since there's nothing to load until we know the user is authenticated).
function onAuthenticated() {
  loadRecentUploads();
  loadDashboard();
  // Needed early (not just when the Settings tab is opened) so the invoice
  // detail panel's "Push to QuickBooks" button knows whether to show up.
  loadQuickbooksStatus();
}
