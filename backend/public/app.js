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
  checkStatusFilter: "",
  // "Not yet applied" is a filter on the link, not on the status, so it
  // rides alongside checkStatusFilter rather than being one of its values.
  checkUnlinkedOnly: false,
  checkSearchQuery: "",
  checkSortField: "created_at",
  checkSortOrder: "desc",
  checkPage: 1,
  selectedCheckId: null,

  taxdocStatusFilter: "",
  taxdocMissingTinOnly: false,
  taxdocYearFilter: "",
  taxdocTypeFilter: "",
  selectedTaxDocId: null,
  taxdocSearchQuery: "",
  taxdocSortField: "created_at",
  taxdocSortOrder: "desc",
  taxdocPage: 1,
  taxDocumentTypes: [],
};
const MAX_ASK_HISTORY_MESSAGES = 12; // last 6 question/answer exchanges
const QUEUE_PAGE_SIZE = 25;
let docPreviewObjectUrl = null;
let expenseDocPreviewObjectUrl = null;
let vendordocDocPreviewObjectUrl = null;
let leaseDocPreviewObjectUrl = null;
let taxdocDocPreviewObjectUrl = null;
let checkDocPreviewObjectUrl = null;

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

// Resolves to false when dismissed. With requirePassword, it resolves to the
// typed password instead of `true` -- the routes behind auth.js's
// requireReauth need it in the request body, and prompting for it inside the
// same confirmation the user is already looking at avoids a second modal.
// `error` re-opens the dialog with the server's reason after a wrong answer.
function confirmDialog(
  title,
  message,
  { confirmLabel = "OK", danger = false, hideCancel = false, requirePassword = false, error = "" } = {}
) {
  return new Promise((resolve) => {
    confirmModalResolve = resolve;
    document.getElementById("confirm-modal-title").textContent = title;
    document.getElementById("confirm-modal-message").textContent = message;
    const confirmBtn = document.getElementById("confirm-modal-confirm");
    confirmBtn.textContent = confirmLabel;
    confirmBtn.classList.toggle("modal-btn-danger", danger);
    document.getElementById("confirm-modal-cancel").style.display = hideCancel ? "none" : "";

    const passwordRow = document.getElementById("confirm-modal-password-row");
    const passwordInput = document.getElementById("confirm-modal-password");
    const passwordError = document.getElementById("confirm-modal-password-error");
    passwordRow.style.display = requirePassword ? "" : "none";
    passwordInput.value = "";
    passwordError.textContent = error;
    passwordError.style.display = error ? "" : "none";

    document.getElementById("confirm-modal").style.display = "flex";
    if (requirePassword) passwordInput.focus();
  });
}

function alertDialog(title, message) {
  return confirmDialog(title, message, { hideCancel: true });
}

// A route that validates its body with zod answers 422 with `detail` as an
// array of issues, not a string -- so the usual `body.detail || "..."`
// renders "[object Object]" and tells the user nothing. Name the field that
// actually failed instead: the only reason to surface a validation error is
// to say which box to go fix. Falls through unchanged for the string
// `detail` every hand-written error response uses.
function errorText(detail, fallback) {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((issue) => {
        const path = Array.isArray(issue?.path) ? issue.path.join(".") : "";
        const label = QUICK_REVIEW_FIELD_LABELS[path] || path;
        return label ? `${label}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return fallback;
}

function closeConfirmModal(result) {
  const passwordInput = document.getElementById("confirm-modal-password");
  const wantsPassword = document.getElementById("confirm-modal-password-row").style.display !== "none";
  // Confirming a password-gated dialog hands back the password itself; an
  // empty box is treated as a dismissal rather than a doomed request.
  const resolved = result && wantsPassword ? passwordInput.value || false : result;
  passwordInput.value = "";

  document.getElementById("confirm-modal").style.display = "none";
  if (confirmModalResolve) {
    confirmModalResolve(resolved);
    confirmModalResolve = null;
  }
}

document.getElementById("confirm-modal-confirm").addEventListener("click", () => closeConfirmModal(true));
document.getElementById("confirm-modal-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") closeConfirmModal(true);
});
document.getElementById("confirm-modal-cancel").addEventListener("click", () => closeConfirmModal(false));
document.getElementById("confirm-modal").addEventListener("click", (e) => {
  if (e.target.id === "confirm-modal") closeConfirmModal(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("confirm-modal").style.display !== "none") closeConfirmModal(false);
});

// ---- Top bar menus ----
// Click to open, not hover: a hover menu over a nav this dense fires
// constantly while the pointer crosses the bar on its way somewhere else,
// and it's unusable on touch. Only one menu is open at a time.
function closeAllMenus() {
  document.querySelectorAll(".topnav-menu").forEach((m) => {
    m.hidden = true;
  });
  document.querySelectorAll("[data-menu]").forEach((t) => t.setAttribute("aria-expanded", "false"));
}

function toggleMenu(name) {
  const menu = document.querySelector(`.topnav-menu[data-menu-for="${name}"]`);
  const trigger = document.querySelector(`[data-menu="${name}"]`);
  if (!menu || !trigger) return;
  const opening = menu.hidden;
  closeAllMenus();
  if (opening) {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  }
}

document.querySelectorAll("[data-menu]").forEach((trigger) => {
  trigger.addEventListener("click", (e) => {
    // Without this the document-level close handler below sees the very
    // click that opened the menu and shuts it again immediately.
    e.stopPropagation();
    toggleMenu(trigger.dataset.menu);
  });
});

// A click anywhere outside an open menu dismisses it -- including on the
// page content, which is the usual way people expect to back out. Clicks
// *inside* a menu are left alone so the account menu's own controls
// (Upgrade, Sign out) still work; the nav items close it via switchTab.
document.addEventListener("click", (e) => {
  if (!e.target.closest(".topnav-menu")) closeAllMenus();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = document.querySelector(".topnav-menu:not([hidden])");
  if (!open) return;
  // Focus would otherwise be left on an element that just became
  // display:none, which strands keyboard users at the top of the document.
  const trigger = document.querySelector(`[data-menu="${open.dataset.menuFor}"]`);
  closeAllMenus();
  if (trigger) trigger.focus();
});

// ---- Command palette ----
// A second, faster path to the ~30 destinations spread across the six
// top-bar menus: type a name instead of knowing which menu it lives under.
// The index is rebuilt from the nav's own [data-tab] buttons every time the
// palette opens, rather than hand-maintained as a second list -- a
// destination added to a menu shows up here for free, and the Staff tab
// (gated on is_staff, hidden via inline style) is excluded the same way it's
// excluded from the menu, with no second gate to keep in sync.
let cpItems = [];
let cpSelectedIndex = 0;

function buildCommandPaletteIndex() {
  const items = [];
  document.querySelectorAll(".topbar-nav .tab-btn[data-tab]").forEach((btn) => {
    if (btn.style.display === "none") return;
    const menu = btn.closest(".topnav-menu");
    const trigger = menu ? document.querySelector(`.topnav-trigger[data-menu="${menu.dataset.menuFor}"]`) : null;
    items.push({
      tab: btn.dataset.tab,
      label: btn.textContent.trim(),
      group: trigger ? trigger.textContent.trim() : "Home",
      iconHtml: btn.querySelector("svg")?.outerHTML || "",
    });
  });
  return items;
}

function openCommandPalette() {
  cpItems = buildCommandPaletteIndex();
  const input = document.getElementById("command-palette-input");
  input.value = "";
  renderCommandPaletteResults("");
  document.getElementById("command-palette").style.display = "flex";
  input.focus();
}

function closeCommandPalette() {
  document.getElementById("command-palette").style.display = "none";
}

function updateCommandPaletteSelection() {
  const els = document.querySelectorAll(".command-palette-item");
  els.forEach((el, i) => el.classList.toggle("is-selected", i === cpSelectedIndex));
  els[cpSelectedIndex]?.scrollIntoView({ block: "nearest" });
}

function renderCommandPaletteResults(query) {
  const q = query.trim().toLowerCase();
  const filtered = q ? cpItems.filter((it) => it.label.toLowerCase().includes(q) || it.group.toLowerCase().includes(q)) : cpItems;
  cpSelectedIndex = 0;
  const el = document.getElementById("command-palette-results");
  if (!filtered.length) {
    el.innerHTML = `<div class="command-palette-empty">No matches.</div>`;
    return;
  }
  let html = "";
  let lastGroup = null;
  filtered.forEach((it, i) => {
    if (it.group !== lastGroup) {
      html += `<div class="command-palette-group">${escapeHtml(it.group)}</div>`;
      lastGroup = it.group;
    }
    html += `<button type="button" class="command-palette-item${i === 0 ? " is-selected" : ""}" data-tab="${it.tab}" data-index="${i}">${it.iconHtml}<span>${escapeHtml(it.label)}</span></button>`;
  });
  el.innerHTML = html;
  el.querySelectorAll(".command-palette-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab);
      closeCommandPalette();
    });
    btn.addEventListener("mouseenter", () => {
      cpSelectedIndex = Number(btn.dataset.index);
      updateCommandPaletteSelection();
    });
  });
}

document.getElementById("command-palette-btn").addEventListener("click", openCommandPalette);

// Ctrl+K on Windows/Linux, Cmd+K on Mac -- guarded to the app shell so it's
// inert on the auth/onboarding screens, which have no tabs to jump to.
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
  if (document.getElementById("app-shell").style.display === "none") return;
  e.preventDefault();
  openCommandPalette();
});

document.getElementById("command-palette-input").addEventListener("input", (e) => renderCommandPaletteResults(e.target.value));

document.getElementById("command-palette-input").addEventListener("keydown", (e) => {
  const count = document.querySelectorAll(".command-palette-item").length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    cpSelectedIndex = Math.min(cpSelectedIndex + 1, count - 1);
    updateCommandPaletteSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    cpSelectedIndex = Math.max(cpSelectedIndex - 1, 0);
    updateCommandPaletteSelection();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const selected = document.querySelectorAll(".command-palette-item")[cpSelectedIndex];
    if (selected) {
      switchTab(selected.dataset.tab);
      closeCommandPalette();
    }
  }
});

document.getElementById("command-palette").addEventListener("click", (e) => {
  if (e.target.id === "command-palette") closeCommandPalette();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("command-palette").style.display !== "none") closeCommandPalette();
});

// ---- Tabs ----
// Top-bar nav items and the dashboard's quick-action shortcuts both switch
// tabs via [data-tab], but only the nav items (.tab-btn) get the persistent
// "active" highlight -- a quick-action button is a one-off jump, not a place
// you "are".
function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".topnav-trigger").forEach((t) => t.classList.remove("has-active"));

  const navBtn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (navBtn) {
    navBtn.classList.add("active");
    // Most destinations now live inside a collapsed menu, so highlighting
    // only the item itself would leave the top bar with no visible
    // indication of where you are. Mark the menu that contains it too.
    const menu = navBtn.closest(".topnav-menu");
    if (menu) {
      const trigger = document.querySelector(`.topnav-trigger[data-menu="${menu.dataset.menuFor}"]`);
      if (trigger) trigger.classList.add("has-active");
    }
  }
  closeAllMenus();
  document.getElementById(`tab-${name}`).classList.add("active");
  // Coming back to the landing tab after approving/uploading elsewhere
  // should show the effect of that work, not a stale snapshot from login.
  // Net Worth lives on this same tab (see index.html) rather than its own,
  // so it loads alongside the org dashboard rather than on its own branch.
  if (name === "ask") { loadDashboard(); loadNetWorth(); }
  if (name === "review") loadInvoices();
  if (name === "expenses") loadExpenses();
  if (name === "vendordocs") loadVendorDocs();
  if (name === "leases") loadLeases();
  if (name === "taxdocs") loadTaxDocs();
  // Payment accounts come along because linking a check needs the "pay
  // from" picker populated before the detail pane is ever opened.
  if (name === "checks") { loadPaymentAccounts(); loadChecks(); }
  if (name === "quickreview") loadQuickReviewQueue();
  if (name === "matching") { loadSources(); loadMatchResults(); loadQuickbooksReconciliation(); loadPlaidSection(); }
  if (name === "settings") { loadOrgSettings(); loadQuickbooksStatus(); }
  if (name === "team") loadTeam();
  if (name === "close") loadClose();
  if (name === "transactions") loadTransactions();
  if (name === "staff") loadStaffOverview();
  if (name === "chartofaccounts") {
    loadAccountSubtypes();
    loadAccounts();
  }
  if (name === "journalentries") { loadJournalEntryAccounts(); loadJournalEntries(); }
  if (name === "payroll") { loadPayrollAccounts(); loadEmployees(); loadPayrollRuns(); }
  if (name === "trialbalance") loadTrialBalance();
  if (name === "bankreconciliation") loadBankReconciliation();
  if (name === "profitandloss") { loadProfitAndLoss(); loadIncomeTax(); }
  if (name === "balancesheet") loadBalanceSheet();
  if (name === "cashflow") loadCashFlow();
  if (name === "budget") loadBudget();
  if (name === "equity") { loadEquityAccounts(); loadEquityStatement(); loadEquityTransactions(); }
  if (name === "captable") { loadCapTable(); }
  if (name === "customers") loadCustomers();
  if (name === "customerinvoices") { loadCustomerInvoiceFormData(); loadCustomerInvoices(); loadRecurringInvoices(); loadCreditMemos(); }
  if (name === "araging") { loadArAging(); loadSalesTax(); }
  if (name === "revenue") loadDeferredRevenue();
  if (name === "adjustments") {
    loadAdjustmentAccounts();
    loadFixedAssets();
    loadRecurringEntries();
    loadYearEnd();
  }
  if (name === "vendors") loadVendors();
  if (name === "billpayments") {
    loadPaymentAccounts();
    loadBillPayments();
    loadWrittenChecks();
    loadRecurringBillFormData();
    loadRecurringBills();
    loadVendorCreditMemos();
  }
  if (name === "apaging") { loadApAging(); loadForm1099(); }
  if (name === "prepaidexpenses") {
    loadPaymentAccounts();
    loadPrepaidExpenseFormData();
    loadPrepaidExpenses();
    loadPrepaidWaterfall();
  }
}

document.querySelectorAll("[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// "Add an account" from Home opens the real Chart of Accounts fields in a
// modal -- name, code, and the full asset/liability/equity/revenue/expense
// type set -- rather than navigating to another tab. The complaint this
// answers was that adding an account *on the home page* was missing code,
// equity, revenue and expenses; sending someone to a different page is a
// workaround for that, not a fix, and it loses the place they were.
//
// Deliberately not the Net Worth widget's own form further down the page,
// which tracks a personal asset or liability and has no notion of a code
// or an income-statement account. That form previously shared the heading
// "Add an account" with this button, which is how the two got conflated in
// the first place; it now says "Add a net worth account".
document.getElementById("dash-add-account-btn").addEventListener("click", openAccountModal);

function fmtMoney(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  // Sign outside the symbol: "-$8.50", not "$-8.50". Invoice totals are
  // always positive so this never came up before transactions (where a
  // debit is negative) started rendering money.
  //
  // Grouped thousands, same as fmtCompactMoney's sub-$10k branch: a single
  // invoice total reads fine either way, but a tax-year total like
  // "$315130.44" does not, and having the summary line and the table
  // beneath it disagree about formatting would read as a bug.
  const grouped = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${grouped}`;
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
    // No "open the review queue" link any more -- the queue is the rest of
    // this same tab now, so the link would point at the page you're already
    // looking at.
    const what = uploaded > 1 ? `Uploaded ${uploaded} documents` : "Uploaded";
    statusEl.textContent = `${what} — queued for extraction. They'll appear in the review queue below as they finish.`;
  }

  fileInput.value = "";
  // bootstrapApp() already re-runs loadRecentUploads() via onAuthenticated()
  // once it re-confirms the session, alongside refreshing the account menu's
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
  const el = document.getElementById("recent-uploads");
  el.innerHTML = invoices.map((inv) => (
    `<div class="recent-item">
      <button type="button" class="recent-open" data-id="${inv.id}">
        <span class="recent-name">${escapeHtml(inv.original_filename)}</span>
        <span class="badge status-${inv.status}">${inv.status}</span>
      </button>
      <button type="button" class="recent-delete" data-id="${inv.id}" title="Delete" aria-label="Delete ${escapeHtml(inv.original_filename)}">&times;</button>
    </div>`
  )).join("") || `
    <div class="recent-empty">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11M12 3l-3.5 3.5M12 3l3.5 3.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
      <p class="hint">Nothing uploaded yet.</p>
    </div>
  `;

  el.querySelectorAll(".recent-open").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab("review");
      selectInvoice(btn.dataset.id);
    });
  });
  el.querySelectorAll(".recent-delete").forEach((btn) => {
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

// Shared with the post-delete reset below, so both the "genuinely no
// invoices yet" and "you just deleted the one you had selected" cases
// render identically.
const INVOICE_EMPTY_DETAIL = `
  <div class="empty-state">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6l1.4 1.4L7.5 4.7"/><path d="M11 6h9.5"/><path d="M3.5 12l1.4 1.4 2.6-2.7"/><path d="M11 12h9.5"/><path d="M3.5 18l1.4 1.4 2.6-2.7"/><path d="M11 18h9.5"/></svg>
    <p class="hint">Select an invoice from the list to review it.</p>
  </div>
`;

// Distinct from INVOICE_EMPTY_DETAIL: this is for a brand-new org with zero
// invoices ever uploaded, not just nothing currently selected -- the queue
// being the flagship feature, landing here with only "no invoices" and no
// way forward read as broken rather than empty.
const INVOICE_EMPTY_QUEUE_DETAIL = `
  <div class="empty-state">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0-12 4 4m-4-4-4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>
    <p class="hint">No invoices yet. Upload one to see it extracted, confidence-scored, and ready to review.</p>
    <button type="button" data-tab="review">Upload your first invoice</button>
  </div>
`;

function renderInvoices({ items: invoices, total }) {
  // Drop any previously-selected id that isn't in this render -- e.g. it
  // was deleted, or a status-filter change hid it -- so the toolbar's count
  // and the bulk actions never operate on rows the user can't currently see.
  const visibleIds = new Set(invoices.map((inv) => inv.id));
  for (const id of state.selectedRowIds) {
    if (!visibleIds.has(id)) state.selectedRowIds.delete(id);
  }

  // A truly empty org (nothing uploaded, ever) gets the upload prompt; a
  // filter/search that happens to match nothing gets a plainer message --
  // "upload your first invoice" would be misleading when invoices exist but
  // are just filtered out.
  const isEmptyOrg = total === 0 && !state.statusFilter && !state.searchQuery;

  const tbody = document.querySelector("#invoice-table tbody");
  tbody.innerHTML = invoices.map((inv) => `
    <tr data-id="${inv.id}">
      <td><input type="checkbox" class="row-select" data-id="${inv.id}" ${state.selectedRowIds.has(inv.id) ? "checked" : ""} aria-label="Select" /></td>
      <td>${inv.vendor_name ? escapeHtml(inv.vendor_name) : "(unknown)"}${inv.is_sample_data ? ` <span class="badge badge-sample">Sample</span>` : ""}</td>
      <td>${fmtMoney(inv.total)}</td>
      <td><span class="badge status-${inv.status}">${inv.status}</span></td>
      <td>${fmtPct(inv.overall_confidence)}</td>
    </tr>
  `).join("") || (
    isEmptyOrg
      ? `<tr><td colspan='5' class='table-empty-row'>No invoices yet -- <button type="button" class="linklike" data-tab="review">upload one</button> to get started.</td></tr>`
      : "<tr><td colspan='5' class='table-empty-row'>No invoices match this filter.</td></tr>"
  );

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
  const emptyRowBtn = tbody.querySelector("[data-tab]");
  if (emptyRowBtn) emptyRowBtn.addEventListener("click", () => switchTab(emptyRowBtn.dataset.tab));

  if (isEmptyOrg && state.selectedInvoiceId === null) {
    document.getElementById("queue-detail").innerHTML = INVOICE_EMPTY_QUEUE_DETAIL;
    document.querySelector("#queue-detail [data-tab]").addEventListener("click", (e) => switchTab(e.currentTarget.dataset.tab));
  }

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
  // Same reason as saveCorrections below: handing renderDetail an error
  // body draws an empty form that looks like a successfully-loaded invoice
  // with nothing on it.
  if (!res.ok) {
    await alertDialog("Couldn't open this invoice", errorText(inv.detail, "Could not load this invoice."));
    return;
  }
  renderDetail(inv);
}

function fieldConf(inv, name) {
  return (inv.field_confidence && inv.field_confidence[name]) ?? 0;
}

// "Tax (6.3% of subtotal)". The rate comes from the server, which derives
// it rather than storing it; null means there was no subtotal to divide by,
// and the label omits the parenthetical rather than claiming 0.0%.
function rateSuffix(percent) {
  return percent === null || percent === undefined ? "" : ` <span class="field-rate">(${percent}% of subtotal)</span>`;
}

// The long-tail charges between subtotal and total -- handling, surcharge,
// deposit applied. Read-only on purpose: it is a labelled list, and a full
// editor is more UI than the case warrants until somebody needs to correct
// one. Shown because leaving these out is what made the totals look wrong.
function otherChargesHtml(charges) {
  if (!Array.isArray(charges) || !charges.length) return "";
  const rows = charges
    .map((c) => `<tr><td>${escapeHtml(c.label)}</td><td>${fmtMoney(c.amount)}</td></tr>`)
    .join("");
  return `
    <table class="line-items-table">
      <thead><tr><th>Other charges</th><th>Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
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
  // Whether the bill has been paid, from the payments actually recorded
  // against it. Shown next to the cross-check because "is this correct" and
  // "have we already paid it" are the two questions somebody opening an
  // invoice is trying to answer, and the second one is how a bill gets paid
  // twice when nobody can see the answer.
  const paymentBanner = !inv.payment_status || inv.payment_status === "unpaid"
    ? ""
    : `<div class="cross-check ${inv.payment_status === "paid" ? "pass" : "processing"}">
        ${inv.payment_status === "paid" ? "✓ Paid" : "◐ Partially paid"} — ${fmtMoney(inv.amount_paid)} of ${fmtMoney(inv.total)} across ${inv.payment_count} payment${inv.payment_count === 1 ? "" : "s"}.
      </div>`;

  const sampleBanner = inv.is_sample_data
    ? `<div class="cross-check processing">This is a sample invoice we added so you'd have something to review right away — it doesn't count toward your plan's usage or show up in your dashboard totals or exports. Delete it whenever you're ready.</div>`
    : "";

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
    ${sampleBanner}
    ${duplicateBanner}
    ${multiInvoiceBanner}
    ${statusBanner}
    ${paymentBanner}

    <div class="detail-grid">
      <div class="field ${lowConf("vendor_name")}"><label>Vendor</label><input id="f-vendor_name" value="${escapeHtml(inv.vendor_name)}" /></div>
      <div class="field ${lowConf("invoice_number")}"><label>Invoice #</label><input id="f-invoice_number" value="${escapeHtml(inv.invoice_number)}" /></div>
      <div class="field ${lowConf("invoice_date")}"><label>Invoice Date</label><input id="f-invoice_date" type="date" value="${inv.invoice_date || ""}" /></div>
      <div class="field ${lowConf("due_date")}"><label>Due Date</label><input id="f-due_date" type="date" value="${inv.due_date || ""}" /></div>
      <div class="field ${lowConf("po_reference")}"><label>PO Reference</label><input id="f-po_reference" value="${escapeHtml(inv.po_reference)}" /></div>
      <div class="field ${lowConf("currency")}"><label>Currency</label><input id="f-currency" value="${escapeHtml(inv.currency)}" /></div>
      <div class="field ${lowConf("subtotal")}"><label>Subtotal</label><input id="f-subtotal" value="${inv.subtotal ?? ""}" /></div>
      <div class="field ${lowConf("shipping")}"><label>Shipping</label><input id="f-shipping" value="${inv.shipping ?? ""}" /></div>
      <div class="field ${lowConf("discount")}"><label>Discount${rateSuffix(inv.discount_rate_percent)}</label><input id="f-discount" value="${inv.discount ?? ""}" /></div>
      <div class="field ${lowConf("tax")}"><label>Tax${rateSuffix(inv.tax_rate_percent)}</label><input id="f-tax" value="${inv.tax ?? ""}" /></div>
      <div class="field ${lowConf("payment_terms")}"><label>Terms</label><input id="f-payment_terms" value="${escapeHtml(inv.payment_terms || "")}" placeholder="2/10 n/30" /></div>
      <div class="field ${lowConf("total")}"><label>Total</label><input id="f-total" value="${inv.total ?? ""}" /></div>
    </div>

    ${otherChargesHtml(inv.other_charges)}

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
    // A failed poll is almost always transient (a dropped connection, a
    // redeploy mid-extraction), so keep waiting rather than tearing the
    // banner down -- an error body has no `status`, which would otherwise
    // fall through to the branch below and render it as a finished invoice
    // with every field empty.
    if (!res.ok) {
      pollWhileProcessing(id, attempt + 1);
      return;
    }
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
    shipping: numOrNull(document.getElementById("f-shipping").value),
    discount: numOrNull(document.getElementById("f-discount").value),
    tax: numOrNull(document.getElementById("f-tax").value),
    payment_terms: document.getElementById("f-payment_terms").value,
    total: numOrNull(document.getElementById("f-total").value),
    line_items: lineItems,
  };

  const res = await apiFetch(`/api/invoices/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const inv = await res.json();
  // Returning *before* renderDetail is the point, not just tidiness. On a
  // rejected save the response body is an error, not an invoice, and
  // renderDetail reads it as one -- every field comes back undefined, which
  // escapeHtml renders as "", so the form redraws completely blank with no
  // message. What that looks like from the outside is the fields refusing
  // to accept what you typed: you fill in the invoice number and the PO
  // reference, save, and both are empty again. Leaving the DOM untouched
  // keeps the user's typing on screen so they can fix the named field and
  // save again, rather than re-entering the whole form from the document.
  if (!res.ok) {
    await alertDialog("Couldn't save your changes", errorText(inv.detail, "Could not save this invoice."));
    return;
  }
  renderDetail(inv);
  invalidateCache("/api/invoices?");
  loadInvoices();
}

async function approveInvoice(id) {
  const res = await apiFetch(`/api/invoices/${id}/approve`, { method: "POST" });
  const inv = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't approve this invoice", errorText(inv.detail, "Could not approve this invoice."));
    return;
  }
  renderDetail(inv);
  invalidateCache("/api/invoices?");
  loadInvoices();
}

async function rejectInvoice(id) {
  const res = await apiFetch(`/api/invoices/${id}/reject`, { method: "POST" });
  const inv = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't reject this invoice", errorText(inv.detail, "Could not reject this invoice."));
    return;
  }
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
// anymore. Callable from either the dashboard's recent-uploads list or the
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
    document.getElementById("queue-detail").innerHTML = INVOICE_EMPTY_DETAIL;
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
    bootstrapApp(); // refresh the account menu's shared "documents used this month" count
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
    bootstrapApp(); // refresh the account menu's shared "documents used this month" count
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
    bootstrapApp(); // refresh the account menu's shared "documents used this month" count
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

// ---- Tax Docs ----
// Same shape as the Leases queue above (upload/list/detail/correct/
// approve/reject/retry/delete), applied to /api/tax-documents. Two things
// differ, both because a pile of tax forms is a different kind of pile:
// the filters are tax year + form type + "missing recipient TIN" rather
// than a date window, and the list carries running totals for whatever
// subset is on screen -- "what do I report for 2025" is the question the
// year filter exists to answer.
document.getElementById("taxdoc-upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("taxdoc-file-input");
  const files = Array.from(fileInput.files);
  if (!files.length) return;

  const statusEl = document.getElementById("taxdoc-upload-status");
  let uploaded = 0;
  const failures = [];

  for (const [i, file] of files.entries()) {
    statusEl.textContent =
      files.length > 1 ? `Uploading ${i + 1} of ${files.length}: ${file.name}...` : `Uploading ${file.name}...`;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await apiFetch("/api/tax-documents/upload", { method: "POST", body: fd });
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
      uploaded > 1 ? `Uploaded ${uploaded} tax documents — queued for extraction.` : "Uploaded — queued for extraction.";
  }

  fileInput.value = "";
  if (uploaded) {
    invalidateCache("/api/tax-documents?");
    loadTaxDocs();
    bootstrapApp(); // refresh the account menu's shared "documents used this month" count
  }
});

document.querySelectorAll(".taxdoc-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".taxdoc-filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.status === "missing_tin") {
      state.taxdocMissingTinOnly = true;
      state.taxdocStatusFilter = "";
    } else {
      state.taxdocMissingTinOnly = false;
      state.taxdocStatusFilter = btn.dataset.status;
    }
    state.taxdocPage = 1;
    loadTaxDocs();
  });
});

document.getElementById("taxdoc-year-filter").addEventListener("change", (e) => {
  state.taxdocYearFilter = e.target.value;
  state.taxdocPage = 1;
  loadTaxDocs();
});

document.getElementById("taxdoc-type-filter").addEventListener("change", (e) => {
  state.taxdocTypeFilter = e.target.value;
  state.taxdocPage = 1;
  loadTaxDocs();
});

async function loadTaxDocs() {
  const params = new URLSearchParams();
  if (state.taxdocMissingTinOnly) {
    params.set("missing_tin", "true");
  } else if (state.taxdocStatusFilter) {
    params.set("status", state.taxdocStatusFilter);
  }
  if (state.taxdocYearFilter) params.set("tax_year", state.taxdocYearFilter);
  if (state.taxdocTypeFilter) params.set("document_type", state.taxdocTypeFilter);
  if (state.taxdocSearchQuery) params.set("q", state.taxdocSearchQuery);
  params.set("sort", state.taxdocSortField);
  params.set("order", state.taxdocSortOrder);
  params.set("page", state.taxdocPage);
  params.set("page_size", QUEUE_PAGE_SIZE);
  const url = `/api/tax-documents?${params}`;

  await cachedLoad(
    url,
    async () => (await apiFetch(url)).json(),
    renderTaxDocs
  );
}

function renderTaxDocs({ items: docs, total, tax_years: taxYears, document_types: documentTypes, totals }) {
  state.taxDocumentTypes = documentTypes || [];
  syncTaxDocSelect("taxdoc-year-filter", taxYears || [], state.taxdocYearFilter, "All years");
  syncTaxDocSelect("taxdoc-type-filter", state.taxDocumentTypes, state.taxdocTypeFilter, "All forms");

  const totalsEl = document.getElementById("taxdoc-totals");
  if (totals && total) {
    const parts = [
      `${total} form${total === 1 ? "" : "s"}`,
      `${fmtMoney(totals.amount)} reported`,
      `${fmtMoney(totals.federal_tax_withheld)} federal tax withheld`,
    ];
    if (totals.missing_tin) {
      parts.push(`${totals.missing_tin} missing a recipient TIN`);
    }
    totalsEl.textContent = parts.join(" · ");
  } else {
    totalsEl.textContent = "";
  }

  const tbody = document.querySelector("#taxdoc-table tbody");
  tbody.innerHTML = docs.map((t) => `
    <tr data-id="${t.id}">
      <td>${t.document_type ? escapeHtml(t.document_type) : "—"}</td>
      <td>${t.tax_year ?? "—"}</td>
      <td>${t.payer_name ? escapeHtml(t.payer_name) : "(unknown)"}</td>
      <td>${fmtMoney(t.amount)}</td>
      <td><span class="badge status-${t.status}">${t.status}</span></td>
      <td>${fmtPct(t.overall_confidence)}</td>
    </tr>
  `).join("") || "<tr><td colspan='6' class='table-empty-row'>No tax documents.</td></tr>";

  tbody.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", () => selectTaxDoc(row.dataset.id));
  });

  document.querySelectorAll("#taxdoc-table th.taxdoc-sortable").forEach((th) => {
    th.classList.toggle("sort-active", th.dataset.sort === state.taxdocSortField);
    th.dataset.order = th.dataset.sort === state.taxdocSortField ? state.taxdocSortOrder : "";
  });

  const start = total === 0 ? 0 : (state.taxdocPage - 1) * QUEUE_PAGE_SIZE + 1;
  const end = Math.min(total, state.taxdocPage * QUEUE_PAGE_SIZE);
  document.getElementById("taxdoc-queue-page-info").textContent = `${start}–${end} of ${total}`;
  document.getElementById("taxdoc-queue-prev-page").disabled = state.taxdocPage <= 1;
  document.getElementById("taxdoc-queue-next-page").disabled = end >= total;
}

// The year and form dropdowns are populated from whatever the org actually
// has, so their options change as documents are uploaded. Rebuilt in place
// rather than blindly re-set, so an already-chosen value isn't dropped on
// the floor when the list it came from is re-rendered.
function syncTaxDocSelect(id, values, selected, allLabel) {
  const select = document.getElementById(id);
  const options = [`<option value="">${allLabel}</option>`].concat(
    values.map((v) => `<option value="${escapeHtml(String(v))}">${escapeHtml(String(v))}</option>`)
  );
  const markup = options.join("");
  if (select.innerHTML !== markup) select.innerHTML = markup;
  select.value = selected;
}

document.getElementById("taxdoc-search").addEventListener("input", debounce(() => {
  state.taxdocSearchQuery = document.getElementById("taxdoc-search").value.trim();
  state.taxdocPage = 1;
  loadTaxDocs();
}, 300));

document.querySelectorAll("#taxdoc-table th.taxdoc-sortable").forEach((th) => {
  th.addEventListener("click", () => {
    if (state.taxdocSortField === th.dataset.sort) {
      state.taxdocSortOrder = state.taxdocSortOrder === "asc" ? "desc" : "asc";
    } else {
      state.taxdocSortField = th.dataset.sort;
      state.taxdocSortOrder = "asc";
    }
    state.taxdocPage = 1;
    loadTaxDocs();
  });
});

document.getElementById("taxdoc-queue-prev-page").addEventListener("click", () => {
  if (state.taxdocPage <= 1) return;
  state.taxdocPage -= 1;
  loadTaxDocs();
});
document.getElementById("taxdoc-queue-next-page").addEventListener("click", () => {
  state.taxdocPage += 1;
  loadTaxDocs();
});

async function selectTaxDoc(id) {
  state.selectedTaxDocId = id;
  const res = await apiFetch(`/api/tax-documents/${id}`);
  const doc = await res.json();
  renderTaxDocDetail(doc);
}

function taxDocFieldConf(t, name) {
  return (t.field_confidence && t.field_confidence[name]) ?? 0;
}

const TAXDOC_EMPTY_DETAIL = `
  <div class="empty-state">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h3"/></svg>
    <p class="hint">Select a tax document from the list to review it.</p>
  </div>
`;

function renderTaxDocDetail(t) {
  const el = document.getElementById("taxdoc-queue-detail");

  if (t.status === "queued" || t.status === "processing") {
    const isPdf = (t.content_type || "").includes("pdf");
    el.innerHTML = `
      <div class="cross-check processing">⏳ Still processing this document — this updates automatically. Most documents finish in well under a minute, but a slow OCR pass or AI response can occasionally take a couple of minutes.</div>
      <div class="doc-preview">
        <h3>Source document</h3>
        <div class="doc-preview-frame">
          ${isPdf ? `<iframe id="taxdoc-doc-preview-media"></iframe>` : `<img id="taxdoc-doc-preview-media" />`}
        </div>
      </div>
    `;
    loadTaxDocPreview(t);
    pollTaxDocWhileProcessing(t.id);
    return;
  }

  const lowConf = (name) => taxDocFieldConf(t, name) < 0.85 ? "low-confidence" : "";
  const isPdf = (t.content_type || "").includes("pdf");
  const preview = isPdf ? `<iframe id="taxdoc-doc-preview-media"></iframe>` : `<img id="taxdoc-doc-preview-media" />`;

  const statusBanner = t.status === "failed"
    ? `<div class="cross-check fail">⚠ Extraction failed: ${escapeHtml(t.error_message) || "Unknown error."} You can still fill in the fields below by hand.</div>`
    : `<div class="cross-check pass">✓ extraction method: ${t.extraction_method} &nbsp;·&nbsp; overall confidence: ${fmtPct(t.overall_confidence)}</div>`;

  // The one defect on these forms that carries a deadline and a penalty:
  // an information return filed without the payee's TIN is what triggers
  // an IRS B-notice and backup withholding on future payments.
  const tinBanner = t.recipient_tin_last4
    ? ""
    : `<div class="cross-check warn">⚠ No recipient taxpayer ID was found on this form. Filing an information return without one can trigger an IRS notice and backup withholding — check the source document and fill in the last four digits below.</div>`;

  const typeOptions = (state.taxDocumentTypes.length ? state.taxDocumentTypes : [t.document_type].filter(Boolean))
    .map((type) => `<option value="${escapeHtml(type)}"${type === t.document_type ? " selected" : ""}>${escapeHtml(type)}</option>`)
    .join("");

  el.innerHTML = `
    ${tinBanner}
    ${statusBanner}

    <div class="detail-grid">
      <div class="field ${lowConf("document_type")}"><label>Form</label><select id="tf-document_type">${typeOptions}</select></div>
      <div class="field ${lowConf("tax_year")}"><label>Tax Year</label><input id="tf-tax_year" value="${t.tax_year ?? ""}" /></div>
      <div class="field ${lowConf("payer_name")}"><label>Payer</label><input id="tf-payer_name" value="${escapeHtml(t.payer_name)}" /></div>
      <div class="field ${lowConf("recipient_name")}"><label>Recipient</label><input id="tf-recipient_name" value="${escapeHtml(t.recipient_name)}" /></div>
      <!-- Deliberately no maxlength: a reviewer reads the form and types
           the whole number, and a 4-character cap would keep the FIRST
           four characters ("987-" out of 987-65-4321), which is both the
           wrong digits and short enough that the server then rejects it
           outright. Let the full value through and let the server narrow
           it to the correct last four (see routes/taxDocuments.js). -->
      <div class="field ${lowConf("recipient_tin_last4")}"><label>Recipient TIN</label><input id="tf-recipient_tin_last4" inputmode="numeric" placeholder="Last 4, or paste the full number" value="${escapeHtml(t.recipient_tin_last4)}" /></div>
      <div class="field ${lowConf("amount")}"><label>Amount</label><input id="tf-amount" value="${t.amount ?? ""}" /></div>
      <div class="field ${lowConf("federal_tax_withheld")}"><label>Federal Tax Withheld</label><input id="tf-federal_tax_withheld" value="${t.federal_tax_withheld ?? ""}" /></div>
      <div class="field"><label>Note</label><input id="tf-note" value="${escapeHtml(t.note)}" /></div>
    </div>
    <p class="hint">Rekono stores only the last four digits of a taxpayer ID — type or paste the whole number and it's narrowed to the last four on save. The full number stays in the source document.</p>

    <div class="actions">
      <button class="save" id="tbtn-save">Save Corrections</button>
      <button class="approve" id="tbtn-approve">Approve</button>
      <button class="reject" id="tbtn-reject">Reject</button>
      ${t.status !== "approved" ? `<button class="retry" id="tbtn-retry">Retry Extraction</button>` : ""}
      <button class="delete" id="tbtn-delete">Delete</button>
    </div>

    <div class="doc-preview">
      <h3>Source document</h3>
      <div class="doc-preview-frame">
        ${preview}
      </div>
    </div>
  `;

  document.getElementById("tbtn-save").addEventListener("click", () => saveTaxDocCorrections(t.id));
  document.getElementById("tbtn-approve").addEventListener("click", () => approveTaxDoc(t.id));
  document.getElementById("tbtn-reject").addEventListener("click", () => rejectTaxDoc(t.id));
  document.getElementById("tbtn-retry")?.addEventListener("click", () => retryTaxDoc(t.id));
  document.getElementById("tbtn-delete").addEventListener("click", () => deleteTaxDoc(t.id));

  loadTaxDocPreview(t);
}

const TAXDOC_POLL_MAX_ATTEMPTS = 120;

function pollTaxDocWhileProcessing(id, attempt = 0) {
  if (attempt >= TAXDOC_POLL_MAX_ATTEMPTS) {
    if (state.selectedTaxDocId === id) {
      const banner = document.querySelector("#taxdoc-queue-detail .cross-check.processing");
      if (banner) {
        banner.textContent =
          "⏳ Still processing — this is taking much longer than usual. It will keep updating automatically; feel free to check back later.";
      }
    }
    return;
  }
  setTimeout(async () => {
    if (state.selectedTaxDocId !== id) return;
    const res = await apiFetch(`/api/tax-documents/${id}`);
    const t = await res.json();
    if (state.selectedTaxDocId !== id) return;
    if (t.status === "queued" || t.status === "processing") {
      pollTaxDocWhileProcessing(id, attempt + 1);
    } else {
      renderTaxDocDetail(t);
      invalidateCache("/api/tax-documents?");
      loadTaxDocs();
    }
  }, 3000);
}

async function loadTaxDocPreview(t) {
  const media = document.getElementById("taxdoc-doc-preview-media");
  if (!media) return;
  if (taxdocDocPreviewObjectUrl) {
    URL.revokeObjectURL(taxdocDocPreviewObjectUrl);
    taxdocDocPreviewObjectUrl = null;
  }
  try {
    const res = await apiFetch(`/api/tax-documents/${t.id}/file`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Could not load the source document.");
    }
    const blob = await res.blob();
    taxdocDocPreviewObjectUrl = URL.createObjectURL(blob);
    media.src = taxdocDocPreviewObjectUrl;
  } catch (err) {
    media.replaceWith(Object.assign(document.createElement("p"), { className: "hint", textContent: String(err.message || err) }));
  }
}

async function saveTaxDocCorrections(id) {
  const yearRaw = document.getElementById("tf-tax_year").value.trim();
  const year = yearRaw === "" ? null : parseInt(yearRaw, 10);
  if (yearRaw !== "" && !Number.isFinite(year)) {
    await alertDialog("Couldn't save", "Tax year must be a four-digit year, e.g. 2025.");
    return;
  }

  const payload = {
    document_type: document.getElementById("tf-document_type").value,
    tax_year: year,
    payer_name: document.getElementById("tf-payer_name").value,
    recipient_name: document.getElementById("tf-recipient_name").value,
    recipient_tin_last4: document.getElementById("tf-recipient_tin_last4").value,
    amount: numOrNull(document.getElementById("tf-amount").value),
    federal_tax_withheld: numOrNull(document.getElementById("tf-federal_tax_withheld").value),
    note: document.getElementById("tf-note").value,
  };

  const res = await apiFetch(`/api/tax-documents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) {
    // `detail` is a plain sentence for the route's own validation (e.g. a
    // TIN too short to narrow) and a zod issues array for a schema
    // failure -- both reach the reviewer as something readable.
    const detail = typeof body.detail === "string" ? body.detail : body.detail?.[0]?.message;
    await alertDialog("Couldn't save", detail || "Could not save these corrections.");
    return;
  }
  renderTaxDocDetail(body);
  invalidateCache("/api/tax-documents?");
  loadTaxDocs();
}

async function approveTaxDoc(id) {
  const res = await apiFetch(`/api/tax-documents/${id}/approve`, { method: "POST" });
  const t = await res.json();
  renderTaxDocDetail(t);
  invalidateCache("/api/tax-documents?");
  loadTaxDocs();
}

async function rejectTaxDoc(id) {
  const res = await apiFetch(`/api/tax-documents/${id}/reject`, { method: "POST" });
  const t = await res.json();
  renderTaxDocDetail(t);
  invalidateCache("/api/tax-documents?");
  loadTaxDocs();
}

async function retryTaxDoc(id) {
  const res = await apiFetch(`/api/tax-documents/${id}/retry`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't retry extraction", body.detail || "Could not retry this document.");
    return;
  }
  renderTaxDocDetail(body);
  invalidateCache("/api/tax-documents?");
  loadTaxDocs();
}

async function deleteTaxDoc(id) {
  const ok = await confirmDialog("Delete this tax document?", "This can't be undone from the review UI.", {
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;

  const res = await apiFetch(`/api/tax-documents/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await alertDialog("Couldn't delete tax document", body.detail || "Could not delete this document.");
    return;
  }

  if (state.selectedTaxDocId === id) {
    state.selectedTaxDocId = null;
    document.getElementById("taxdoc-queue-detail").innerHTML = TAXDOC_EMPTY_DETAIL;
  }
  invalidateCache("/api/tax-documents?");
  loadTaxDocs();
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

const SOURCE_TYPE_LABELS = { po: "purchase orders", receiving: "goods receipts", bank: "bank statement" };

function renderSources(sources) {
  const list = sources.map((s) => (
    `<div class="source-row">
      <span>${escapeHtml(s.name)} (${escapeHtml(SOURCE_TYPE_LABELS[s.source_type] || s.source_type)}) — ${s.entry_count} rows</span>
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

// ---- Connected bank accounts (Plaid) ----
// A connected account's transactions land in the same MatchSource/
// MatchEntry rows a CSV upload would (see routes/plaid.js's sync route),
// so they show up in loadSources() above automatically -- this section
// only manages the connections themselves and the "sync now" action.
async function loadPlaidSection() {
  await cachedLoad(
    "__plaid_status__",
    async () => (await apiFetch("/api/integrations/plaid/status")).json(),
    renderPlaidStatus
  );
  await cachedLoad(
    "/api/integrations/plaid/connections",
    async () => (await apiFetch("/api/integrations/plaid/connections")).json(),
    renderPlaidConnections
  );
}

function renderPlaidStatus(status) {
  document.getElementById("plaid-unconfigured").style.display = status.configured ? "none" : "block";
  document.getElementById("plaid-connect-btn").disabled = !status.configured;
}

function renderPlaidConnections(connections) {
  const el = document.getElementById("plaid-connections-list");
  if (!connections.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = connections
    .map(
      (c) => `
    <div class="plaid-connection">
      <div class="plaid-connection-head">
        <strong>${escapeHtml(c.institution_name || "Connected bank")}</strong>
        ${c.status !== "active" ? `<span class="badge badge-warn">Needs reconnect</span>` : ""}
        <button type="button" class="plaid-disconnect" data-id="${c.id}">Disconnect</button>
      </div>
      ${c.accounts
        .map(
          (a) => `
        <div class="plaid-account">
          <span>${escapeHtml(a.name)}${a.mask ? ` ••${escapeHtml(a.mask)}` : ""}</span>
          <span>${a.current_balance != null ? `$${Number(a.current_balance).toFixed(2)}` : ""}</span>
          <span class="hint">${a.last_synced_at ? `Synced ${escapeHtml(String(a.last_synced_at).slice(0, 10))}` : "Never synced"}</span>
          <button type="button" class="plaid-sync" data-id="${a.id}">Sync now</button>
        </div>
      `
        )
        .join("")}
    </div>
  `
    )
    .join("");

  document.querySelectorAll(".plaid-sync").forEach((btn) => {
    btn.addEventListener("click", () => syncPlaidAccount(btn.dataset.id));
  });
  document.querySelectorAll(".plaid-disconnect").forEach((btn) => {
    btn.addEventListener("click", () => disconnectPlaidConnection(btn.dataset.id));
  });
}

async function syncPlaidAccount(accountId) {
  const res = await apiFetch(`/api/integrations/plaid/accounts/${accountId}/sync`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    await alertDialog("Sync failed", body.detail || "Could not sync this account.");
    return;
  }
  invalidateCache("/api/integrations/plaid/connections");
  invalidateCache("/api/matching/sources");
  await loadPlaidSection();
  loadSources();
}

async function disconnectPlaidConnection(connectionId) {
  const ok = await confirmDialog(
    "Disconnect this bank?",
    "You can reconnect at any time. Already-synced transactions stay in your matching history.",
    { confirmLabel: "Disconnect", danger: true }
  );
  if (!ok) return;
  const res = await apiFetch(`/api/integrations/plaid/connections/${connectionId}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await alertDialog("Couldn't disconnect", body.detail || "Failed to disconnect this bank.");
    return;
  }
  invalidateCache("/api/integrations/plaid/connections");
  loadPlaidSection();
}

document.getElementById("plaid-connect-btn").addEventListener("click", async () => {
  const btn = document.getElementById("plaid-connect-btn");
  btn.disabled = true;
  try {
    const res = await apiFetch("/api/integrations/plaid/link-token", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || "Could not start a bank connection.");

    const handler = Plaid.create({
      token: body.link_token,
      onSuccess: async (public_token) => {
        const exchangeRes = await apiFetch("/api/integrations/plaid/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ public_token }),
        });
        const exchangeBody = await exchangeRes.json().catch(() => ({}));
        if (!exchangeRes.ok) {
          await alertDialog("Connection failed", exchangeBody.detail || "Could not finish connecting that bank.");
          return;
        }
        invalidateCache("/api/integrations/plaid/connections");
        loadPlaidSection();
      },
    });
    handler.open();
  } catch (err) {
    await alertDialog("Could not connect a bank", err.message || String(err));
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("run-matching-btn").addEventListener("click", async () => {
  const res = await apiFetch("/api/matching/run", { method: "POST" });
  const summary = await res.json();
  // A three-way run's headline numbers are the ones that name a specific
  // problem ("billed but never received"), not the generic partial count --
  // that's the whole reason to upload receipts, so lead with it.
  document.getElementById("matching-summary").textContent = summary.three_way
    ? `Three-way match — evaluated ${summary.invoices_evaluated} invoices: ${summary.three_way.matched} fully matched, ` +
      `${summary.three_way.no_receipt} billed with no goods receipt, ${summary.three_way.no_po} with no purchase order, ` +
      `${summary.three_way.unmatched} unmatched.`
    : `Evaluated ${summary.invoices_evaluated} invoices — matched ${summary.matched}, partial ${summary.partial}, unmatched ${summary.unmatched}.`;
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

// Wording for each three-way verdict (matching.js's threeWayOutcome), in
// the terms an AP reviewer would actually use rather than the raw key.
const THREE_WAY_LABELS = {
  matched: "matched",
  no_receipt: "no receipt",
  no_po: "no PO",
  unmatched: "unmatched",
};

function renderMatchResults({ results, invoices }) {
  const invoiceById = Object.fromEntries(invoices.map((i) => [i.id, i]));

  // API returns results newest-first, so keep only the first (most recent) result per invoice.
  const latestByInvoice = {};
  results.forEach((r) => { if (!(r.invoice_id in latestByInvoice)) latestByInvoice[r.invoice_id] = r; });

  const tbody = document.querySelector("#matching-table tbody");
  tbody.innerHTML = Object.values(latestByInvoice).map((r) => {
    const inv = invoiceById[r.invoice_id] || {};
    // On a three-way result, the specific verdict ("no receipt") says far
    // more than the generic status it rolls up into ("partial"), so show
    // that instead where it exists. Falls back to the plain status for
    // results from a two-way run, which have no three-way outcome.
    const badgeText = THREE_WAY_LABELS[r.three_way_outcome] || r.status;
    return `
      <tr>
        <td>${inv.original_filename ? escapeHtml(inv.original_filename) : r.invoice_id}</td>
        <td>${escapeHtml(inv.vendor_name || "")}</td>
        <td>${fmtMoney(inv.total)}</td>
        <td><span class="badge match-${r.status}">${escapeHtml(badgeText)}</span></td>
        <td>${r.score.toFixed(0)}</td>
        <td>${escapeHtml(r.reasoning)}</td>
      </tr>
    `;
  }).join("") || "<tr><td colspan='6' class='table-empty-row'>No matching results yet.</td></tr>";
}

// ---- Transactions (AI categorization) ----
// The category cell is an inline <select> rather than a detail panel:
// reviewing a statement is a long run of one-field decisions, and making
// each one cost a click-in/click-out would defeat the point.

const TXN_PAGE_SIZE = 100;
const txnState = { page: 1, filter: "", search: "", categories: [] };

const TXN_SOURCE_LABELS = {
  learned: "learned",
  ai: "AI",
  heuristic: "keyword",
  manual: "you",
  "": "—",
};

async function loadTransactions() {
  const params = new URLSearchParams();
  if (txnState.filter === "needs_review") params.set("needs_review", "true");
  if (txnState.search) params.set("q", txnState.search);
  params.set("page", txnState.page);
  params.set("page_size", TXN_PAGE_SIZE);

  const res = await apiFetch(`/api/transactions?${params}`);
  renderTransactions(await res.json());
}

function renderTransactions(data) {
  txnState.categories = data.categories || [];

  const totalsEl = document.getElementById("txn-totals");
  const totals = Object.entries(data.category_totals || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  totalsEl.innerHTML = totals.length
    ? totals
        .map(
          ([category, amount]) => `
          <div class="txn-total${category === "Uncategorized" ? " is-uncategorized" : ""}">
            <span class="txn-total-label">${escapeHtml(category)}</span>
            <span class="txn-total-amount">${fmtMoney(amount)}</span>
          </div>`
        )
        .join("")
    : "";

  const options = (selected) =>
    [`<option value=""${selected ? "" : " selected"}>— uncategorized —</option>`]
      .concat(
        txnState.categories.map(
          (c) => `<option value="${escapeHtml(c)}"${c === selected ? " selected" : ""}>${escapeHtml(c)}</option>`
        )
      )
      .join("");

  const tbody = document.querySelector("#txn-table tbody");
  tbody.innerHTML =
    data.items
      .map(
        (t) => `
      <tr data-id="${t.id}"${t.reviewed_at ? ' class="is-reviewed"' : ""}>
        <td>${t.posted_date || "—"}</td>
        <td>${escapeHtml(t.description)}</td>
        <td>${fmtMoney(t.amount)}</td>
        <td>
          <select class="txn-category" data-id="${t.id}" aria-label="Category">${options(t.category)}</select>
        </td>
        <td>
          <span class="txn-source txn-source-${t.category_source || "none"}">${TXN_SOURCE_LABELS[t.category_source] ?? t.category_source}</span>
          ${t.category_source && t.category_source !== "manual" && t.category_source !== "learned" ? `<span class="txn-conf">${fmtPct(t.category_confidence)}</span>` : ""}
        </td>
        <td><button type="button" class="txn-delete" data-id="${t.id}" aria-label="Delete transaction">&times;</button></td>
      </tr>`
      )
      .join("") || "<tr><td colspan='6' class='table-empty-row'>No transactions yet. Upload a statement to get started.</td></tr>";

  tbody.querySelectorAll(".txn-category").forEach((select) =>
    select.addEventListener("change", () => categorizeTransaction(select.dataset.id, select.value))
  );
  tbody.querySelectorAll(".txn-delete").forEach((btn) =>
    btn.addEventListener("click", () => deleteTransaction(btn.dataset.id))
  );

  const start = data.total === 0 ? 0 : (data.page - 1) * TXN_PAGE_SIZE + 1;
  const end = Math.min(data.total, data.page * TXN_PAGE_SIZE);
  document.getElementById("txn-page-info").textContent = `${start}–${end} of ${data.total}`;
  document.getElementById("txn-prev-page").disabled = data.page <= 1;
  document.getElementById("txn-next-page").disabled = end >= data.total;
}

async function categorizeTransaction(id, category) {
  // Clearing back to uncategorized isn't a decision worth remembering, and
  // the API only accepts a real category, so there's nothing to send.
  if (!category) return loadTransactions();

  const res = await apiFetch(`/api/transactions/${id}/categorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category }),
  });
  const body = await res.json();
  if (!res.ok) {
    document.getElementById("txn-upload-status").textContent = body.detail || "Could not save that category.";
    return;
  }
  // Surfacing the ripple matters: one correction quietly fixing eleven other
  // rows is the feature working, and silently is the wrong way to do it.
  document.getElementById("txn-upload-status").textContent = body.also_applied_to
    ? `Saved — also applied to ${body.also_applied_to} other transaction${body.also_applied_to === 1 ? "" : "s"} from this merchant.`
    : "Saved.";
  loadTransactions();
}

async function deleteTransaction(id) {
  const ok = await confirmDialog("Delete this transaction?", "It disappears from your lists and totals.", {
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  await apiFetch(`/api/transactions/${id}`, { method: "DELETE" });
  loadTransactions();
}

document.getElementById("txn-upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("txn-file");
  if (!fileInput.files.length) return;

  const statusEl = document.getElementById("txn-upload-status");
  statusEl.textContent = "Uploading and categorizing…";

  const fd = new FormData();
  fd.append("file", fileInput.files[0]);
  const res = await apiFetch("/api/transactions/upload", { method: "POST", body: fd });
  const body = await res.json();

  if (!res.ok) {
    statusEl.textContent = typeof body.detail === "string" ? body.detail : "Could not import that file.";
    return;
  }

  const parts = [`Imported ${body.imported} transaction${body.imported === 1 ? "" : "s"} across ${body.distinct_merchants} merchant${body.distinct_merchants === 1 ? "" : "s"}.`];
  const s = body.by_source || {};
  if (s.learned) parts.push(`${s.learned} from merchants you've categorized before.`);
  if (s.uncategorized) parts.push(`${s.uncategorized} couldn't be placed — review them below.`);
  statusEl.textContent = parts.join(" ");

  fileInput.value = "";
  txnState.page = 1;
  loadTransactions();
});

document.querySelectorAll(".txn-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".txn-filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    txnState.filter = btn.dataset.filter;
    txnState.page = 1;
    loadTransactions();
  });
});

document.getElementById("txn-search").addEventListener("input", (e) => {
  txnState.search = e.target.value.trim();
  txnState.page = 1;
  clearTimeout(window.__txnSearchTimer);
  window.__txnSearchTimer = setTimeout(loadTransactions, 250);
});

document.getElementById("txn-prev-page").addEventListener("click", () => {
  if (txnState.page <= 1) return;
  txnState.page -= 1;
  loadTransactions();
});
document.getElementById("txn-next-page").addEventListener("click", () => {
  txnState.page += 1;
  loadTransactions();
});

// ---- Month-End Close ----
// Two halves, deliberately shown differently (see routes/close.js): the
// readiness checks are derived from live data and can't be ticked, so
// they're rendered as read-only findings that link to the tab where you'd
// actually fix them; the manual tasks are real checkboxes someone attests
// to, so they carry who completed them and when.

// Tracks which period the user is looking at, so a re-render after ticking
// a task doesn't snap them back to the default period.
let selectedClosePeriodMonth = null;

function closeStatus(message, isError = false) {
  const el = document.getElementById("close-status");
  el.textContent = message || "";
  el.style.display = message ? "block" : "none";
  el.classList.toggle("close-status-error", Boolean(isError));
}

async function loadCloseSuggestions(periodMonth) {
  const el = document.getElementById("close-suggestions");
  if (!el) return;

  const res = await apiFetch(`/api/close/suggestions?period_month=${encodeURIComponent(periodMonth)}`);
  if (!res.ok) {
    el.textContent = "Couldn't work out suggestions for this period.";
    return;
  }
  const { items } = await res.json();

  if (!items.length) {
    el.innerHTML = `<p class="hint">Nothing looks missing this month.</p>`;
    return;
  }

  // The banner renders before suggestions arrive, and its "Everything
  // checks out" state is computed from the readiness checks alone. Left
  // alone it would sit directly above a list saying rent is missing, which
  // is how somebody signs off on a month with a hole in it. Suggestions
  // are still non-blocking -- the banner keeps its ready state and the
  // button keeps working -- it just stops claiming there is nothing to
  // look at.
  const banner = document.querySelector(".close-banner.is-ready");
  if (banner) {
    const strong = banner.querySelector("strong");
    if (strong) strong.textContent = "Checks all pass, with suggestions below.";
    const note = document.createElement("span");
    note.textContent = ` ${items.length} thing${items.length === 1 ? "" : "s"} the ledger flagged worth a look before you sign off.`;
    strong.after(note);
  }

  // Each suggestion links to where it would be acted on: a missing expense
  // to the journal, an undepreciated asset to the adjusting entries that
  // would depreciate it.
  el.innerHTML = `<div class="close-checks">${items
    .map(
      (s) => `
      <button type="button" class="close-check is-blocking" data-tab="${s.type === "undepreciated_asset" ? "adjustments" : "journalentries"}">
        <span class="close-check-mark">?</span>
        <span class="close-check-label">${escapeHtml(s.detail)}</span>
      </button>`
    )
    .join("")}</div>`;

  el.querySelectorAll(".close-check[data-tab]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
}

async function loadClose() {
  closeStatus("");
  const query = selectedClosePeriodMonth ? `?period_month=${encodeURIComponent(selectedClosePeriodMonth)}` : "";
  const [closeRes, periodsRes] = await Promise.all([
    apiFetch(`/api/close${query}`),
    apiFetch("/api/close/periods"),
  ]);
  const data = await closeRes.json();
  const periods = await periodsRes.json();
  renderClose(data, periods);

  // Fetched after the checklist renders rather than alongside it: the
  // suggestions scan five months of journal lines, and the checklist
  // shouldn't wait on that to appear.
  if (data.period) {
    loadCloseSuggestions(data.period.period_month);
    loadCloseSnapshots(data.period.id);
  }
}

async function loadCloseSnapshots(periodId) {
  const el = document.getElementById("close-snapshots");
  if (!el) return;

  const res = await apiFetch(`/api/close/periods/${periodId}/snapshots`);
  if (!res.ok) {
    el.textContent = "Couldn't load this period's close history.";
    return;
  }
  const { items } = await res.json();

  if (!items.length) {
    el.innerHTML = `<p class="hint">No snapshot yet — one is taken the moment this period closes.</p>`;
    return;
  }

  const rows = items
    .map(
      (s, i) => `
      <li class="close-snapshot${i === items.length - 1 ? " is-latest" : ""}">
        <span class="close-snapshot-date">${new Date(s.closed_at).toLocaleString()}</span>
        <span class="close-snapshot-by">${escapeHtml(s.closed_by || "—")}</span>
        <span class="close-snapshot-balance ${s.balanced ? "is-ok" : "is-blocking"}">${
          s.balanced ? "Balanced" : "Out of balance"
        }</span>
      </li>`
    )
    .join("");

  el.innerHTML = `<ul class="close-snapshot-list">${rows}</ul><div id="close-snapshot-diff"></div>`;

  // Only meaningful once a period has been closed more than once -- the
  // diff endpoint itself reports { available: false } for a single close,
  // so a fresh period doesn't fire this request for nothing.
  if (items.length > 1) loadCloseSnapshotDiff(periodId);
}

async function loadCloseSnapshotDiff(periodId) {
  const el = document.getElementById("close-snapshot-diff");
  if (!el) return;

  const res = await apiFetch(`/api/close/periods/${periodId}/snapshots/diff`);
  if (!res.ok) return;
  const diff = await res.json();
  if (!diff.available) return;

  if (!diff.changes.length) {
    el.innerHTML = `<p class="hint">Nothing moved between the last two closes.</p>`;
    return;
  }

  const rows = diff.changes
    .map(
      (c) => `
      <tr>
        <td>${escapeHtml(c.code)} ${escapeHtml(c.name)}</td>
        <td>$${Number(c.previous_balance).toFixed(2)}</td>
        <td>$${Number(c.current_balance).toFixed(2)}</td>
        <td class="${c.delta >= 0 ? "close-delta-up" : "close-delta-down"}">$${Number(c.delta).toFixed(2)}</td>
      </tr>`
    )
    .join("");

  el.innerHTML = `
    <h4>What changed since the previous close</h4>
    <table class="close-snapshot-diff-table">
      <thead><tr><th>Account</th><th>Before</th><th>After</th><th>Change</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderClose(data, periods) {
  const select = document.getElementById("close-period-select");
  select.innerHTML = periods
    .map((p) => `<option value="${p.period_month}">${p.period_month}${p.status === "closed" ? " (closed)" : ""}</option>`)
    .join("");
  select.style.display = periods.length ? "inline-block" : "none";
  if (data.period) select.value = data.period.period_month;

  const monthInput = document.getElementById("close-new-period-month");
  if (!monthInput.value) monthInput.value = new Date().toISOString().slice(0, 7);

  const body = document.getElementById("close-body");

  if (!data.period) {
    body.innerHTML = `
      <div class="panel">
        <div class="empty-state">
          <p class="hint">No close period open yet. Open one for ${escapeHtml(data.suggested_period_month)} to start working through the checklist.</p>
        </div>
      </div>`;
    monthInput.value = monthInput.value || data.suggested_period_month;
    return;
  }

  const p = data.period;
  const isClosed = p.status === "closed";

  const readinessRows = p.readiness
    .map(
      (c) => `
      <button type="button" class="close-check ${c.ok ? "is-ok" : "is-blocking"}" data-tab="${c.tab}" ${c.ok ? "disabled" : ""}>
        <span class="close-check-mark">${c.ok ? "✓" : "!"}</span>
        <span class="close-check-label">${escapeHtml(c.label)}</span>
        <span class="close-check-count">${c.count}</span>
      </button>`
    )
    .join("");

  const taskRows = p.tasks
    .map(
      (t) => `
      <li class="close-task${t.done ? " is-done" : ""}">
        <label>
          <input type="checkbox" class="close-task-toggle" data-id="${t.id}" ${t.done ? "checked" : ""} ${isClosed ? "disabled" : ""} />
          <span class="close-task-title">${escapeHtml(t.title)}</span>
        </label>
        <span class="close-task-meta">${
          t.done && t.completed_by
            ? `${escapeHtml(t.completed_by)} · ${new Date(t.completed_at).toLocaleDateString()}`
            : ""
        }</span>
        ${isClosed ? "" : `<button type="button" class="close-task-delete" data-id="${t.id}" aria-label="Delete task">&times;</button>`}
      </li>`
    )
    .join("");

  body.innerHTML = `
    <div class="close-banner ${isClosed ? "is-closed" : p.blocking_count ? "is-blocking" : "is-ready"}">
      <p class="close-banner-msg">${
        isClosed
          ? `<strong>${escapeHtml(p.period_month)} is closed.</strong> Signed off by ${escapeHtml(p.closed_by || "—")} on ${
              p.closed_at ? new Date(p.closed_at).toLocaleDateString() : "—"
            }.`
          : p.blocking_count
          ? // "checks", not "items": this is the number of failing checks,
            // which is not the number of underlying documents behind them.
            `<strong>${p.blocking_count} check${p.blocking_count === 1 ? "" : "s"} still outstanding.</strong> You can still close with a known exception — whatever is left gets recorded on the audit trail.`
          : `<strong>Everything checks out.</strong> ${p.tasks_remaining ? `${p.tasks_remaining} manual task${p.tasks_remaining === 1 ? "" : "s"} left.` : "Ready to sign off."}`
      }</p>
      <button type="button" id="close-toggle-period-btn" data-id="${p.id}" data-action="${isClosed ? "reopen" : "close"}">
        ${isClosed ? "Reopen period" : "Close this period"}
      </button>
    </div>

    <div class="panel-columns">
      <div class="panel">
        <h3>Automatic checks</h3>
        <p class="hint">Derived from your data every time this page loads — these can't be ticked off by hand, only resolved.</p>
        <div class="close-checks">${readinessRows}</div>
      </div>

      <div class="panel">
        <h3>Checklist</h3>
        <ul class="close-tasks">${taskRows || `<li class="hint">No tasks left on this checklist.</li>`}</ul>
        ${
          isClosed
            ? ""
            : `<form id="close-add-task-form">
                 <input type="text" id="close-new-task" placeholder="Add a task…" maxlength="512" required autocomplete="off" />
                 <button type="submit">Add</button>
               </form>`
        }
      </div>
    </div>

    <div class="panel" id="close-suggestions-panel">
      <h3>Suggestions</h3>
      <p class="hint">Derived from the ledger, not from the document queue: an expense that posts every month and didn't, or an asset with nothing depreciating it. Suggestions only -- nothing here posts anything or blocks a close.</p>
      <div id="close-suggestions">Looking…</div>
    </div>

    <div class="panel" id="close-history-panel">
      <h3>Close history</h3>
      <p class="hint">A trial balance is frozen the moment this period closes, and again at every re-close -- so reopening it to catch a late entry leaves a record of exactly what that changed, not just a new number with nothing to compare it to.</p>
      <div id="close-snapshots">Looking…</div>
    </div>`;

  body.querySelectorAll(".close-check[data-tab]:not([disabled])").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );
  body.querySelectorAll(".close-task-toggle").forEach((cb) =>
    cb.addEventListener("change", () => updateCloseTask(cb.dataset.id, { done: cb.checked }))
  );
  body.querySelectorAll(".close-task-delete").forEach((b) =>
    b.addEventListener("click", () => deleteCloseTask(b.dataset.id))
  );

  const addForm = document.getElementById("close-add-task-form");
  if (addForm) {
    addForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("close-new-task");
      const title = input.value.trim();
      if (!title) return;
      const res = await apiFetch(`/api/close/periods/${p.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) return closeStatus((await res.json()).detail || "Could not add that task.", true);
      input.value = "";
      loadClose();
    });
  }

  const toggleBtn = document.getElementById("close-toggle-period-btn");
  toggleBtn.addEventListener("click", async () => {
    const action = toggleBtn.dataset.action;
    if (action === "close") {
      const ok = await confirmDialog(
        `Close ${p.period_month}?`,
        p.blocking_count
          ? `${p.blocking_count} automatic check${p.blocking_count === 1 ? " is" : "s are"} still failing. Closing anyway records exactly what was outstanding on the audit trail.`
          : "This signs off the month and freezes its checklist. You can reopen it later if you need to."
      );
      if (!ok) return;
    }
    const res = await apiFetch(`/api/close/periods/${toggleBtn.dataset.id}/${action}`, { method: "POST" });
    if (!res.ok) return closeStatus((await res.json()).detail || "Could not update this period.", true);
    loadClose();
  });
}

async function updateCloseTask(id, patch) {
  const res = await apiFetch(`/api/close/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return closeStatus((await res.json()).detail || "Could not update that task.", true);
  loadClose();
}

async function deleteCloseTask(id) {
  const res = await apiFetch(`/api/close/tasks/${id}`, { method: "DELETE" });
  if (!res.ok) return closeStatus((await res.json()).detail || "Could not delete that task.", true);
  loadClose();
}

document.getElementById("close-period-select").addEventListener("change", (e) => {
  selectedClosePeriodMonth = e.target.value;
  loadClose();
});

document.getElementById("close-open-period-btn").addEventListener("click", async () => {
  const input = document.getElementById("close-new-period-month");
  // Prefilled with the current month, but left editable: a close is often
  // worked well into the following month, and older months get backfilled.
  const periodMonth = input.value || new Date().toISOString().slice(0, 7);

  const res = await apiFetch("/api/close/periods", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ period_month: periodMonth }),
  });
  if (!res.ok) {
    const body = await res.json();
    return closeStatus(
      typeof body.detail === "string" ? body.detail : "That doesn't look like a valid month (use YYYY-MM).",
      true
    );
  }
  selectedClosePeriodMonth = periodMonth;
  loadClose();
});

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
// A floating widget on every tab (not a dedicated page) -- so asking a
// question about what's on screen doesn't require navigating away from
// it first. Collapsed by default; the panel and its thread history persist
// in the DOM across opens/closes, so re-opening it picks up right where
// you left off instead of losing the conversation.
document.getElementById("ask-widget-toggle").addEventListener("click", () => {
  document.getElementById("ask-widget-panel").style.display = "flex";
  document.getElementById("ask-widget-toggle").style.display = "none";
  document.getElementById("ask-input").focus();
});
document.getElementById("ask-widget-close").addEventListener("click", () => {
  document.getElementById("ask-widget-panel").style.display = "none";
  document.getElementById("ask-widget-toggle").style.display = "flex";
});

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
  const thread = document.getElementById("ask-thread");
  thread.append(entry);
  thread.scrollTop = thread.scrollHeight;
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
    // The answer replacing "Thinking…" can change the entry's height (a
    // long answer, or an error message wrapping differently), so scroll
    // again rather than trusting the pre-answer scroll to still reach it.
    thread.scrollTop = thread.scrollHeight;
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

  // Accounting -- fiscal year end (drives the balance sheet's earnings
  // split, see financialStatements.js). Not owner-gated, unlike renaming
  // the org below.
  document.getElementById("settings-fiscal-month").value = String(settingsRes.fiscal_year_end_month || 12);
  document.getElementById("settings-sales-tax-rate").value = settingsRes.sales_tax_rate_percent ?? "";
  document.getElementById("settings-fiscal-status").textContent = "";

  // Two-factor authentication -- reset back to the status view on every
  // render, same as the setup/backup-codes views resetting to hidden below,
  // so re-opening Settings never leaves a stale in-progress state showing.
  document.getElementById("twofa-status-text").textContent = me.two_factor_enabled
    ? "Enabled."
    : "Not enabled. We recommend turning this on for extra account security.";
  document.getElementById("twofa-enable-btn").style.display = me.two_factor_enabled ? "none" : "";
  document.getElementById("twofa-disable-btn").style.display = me.two_factor_enabled ? "" : "none";
  document.getElementById("twofa-regenerate-btn").style.display = me.two_factor_enabled ? "" : "none";
  document.getElementById("twofa-status-view").style.display = "";
  document.getElementById("twofa-setup-view").style.display = "none";
  document.getElementById("twofa-backup-codes-view").style.display = "none";
  document.getElementById("settings-twofa-status").textContent = "";

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
      showApp(body); // refreshes the account menu's name badge too
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

// ---- Two-factor authentication ----
function showTwoFactorBackupCodes(codes) {
  document.getElementById("twofa-status-view").style.display = "none";
  document.getElementById("twofa-setup-view").style.display = "none";
  document.getElementById("twofa-backup-codes-list").textContent = codes.join("\n");
  document.getElementById("twofa-backup-codes-view").style.display = "";
}

document.getElementById("twofa-enable-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("settings-twofa-status");
  statusEl.textContent = "";
  try {
    const res = await apiFetch("/api/auth/2fa/setup", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not start setup.");
    document.getElementById("twofa-qr").src = body.qr_code_data_url;
    document.getElementById("twofa-manual-secret").textContent = body.secret;
    document.getElementById("twofa-enable-code").value = "";
    document.getElementById("twofa-status-view").style.display = "none";
    document.getElementById("twofa-setup-view").style.display = "";
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("twofa-setup-cancel-btn").addEventListener("click", () => {
  document.getElementById("twofa-setup-view").style.display = "none";
  document.getElementById("twofa-status-view").style.display = "";
});

document.getElementById("twofa-enable-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("settings-twofa-status");
  statusEl.textContent = "";
  const code = document.getElementById("twofa-enable-code").value.trim();
  try {
    const res = await apiFetch("/api/auth/2fa/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || "Could not confirm the code.");
    invalidateCache("__org_settings__");
    showTwoFactorBackupCodes(body.backup_codes);
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

document.getElementById("twofa-backup-codes-done-btn").addEventListener("click", () => {
  document.getElementById("twofa-backup-codes-view").style.display = "none";
  loadOrgSettings();
});

document.getElementById("twofa-disable-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("settings-twofa-status");
  let error = "";
  // Loops so a mistyped password re-opens the same dialog with the reason,
  // rather than dumping the user back to the settings page to start over --
  // same pattern as disconnecting QuickBooks above.
  for (;;) {
    const password = await confirmDialog(
      "Disable two-factor authentication?",
      "Your account will only need a password to sign in.",
      { confirmLabel: "Disable", danger: true, requirePassword: true, error }
    );
    if (!password) return;
    try {
      const res = await apiFetch("/api/auth/2fa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: password }),
      });
      const body = await res.json();
      if (res.status === 403 && body.reauth_required) {
        error = body.detail || "That password is incorrect.";
        continue;
      }
      if (!res.ok) throw new Error(body.detail || "Could not disable two-factor authentication.");
      invalidateCache("__org_settings__");
      loadOrgSettings();
      return;
    } catch (err) {
      statusEl.textContent = err.message || String(err);
      return;
    }
  }
});

document.getElementById("twofa-regenerate-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("settings-twofa-status");
  let error = "";
  for (;;) {
    const password = await confirmDialog(
      "Regenerate backup codes?",
      "Your existing backup codes will stop working.",
      { confirmLabel: "Regenerate", requirePassword: true, error }
    );
    if (!password) return;
    try {
      const res = await apiFetch("/api/auth/2fa/backup-codes/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: password }),
      });
      const body = await res.json();
      if (res.status === 403 && body.reauth_required) {
        error = body.detail || "That password is incorrect.";
        continue;
      }
      if (!res.ok) throw new Error(body.detail || "Could not regenerate backup codes.");
      showTwoFactorBackupCodes(body.backup_codes);
      return;
    } catch (err) {
      statusEl.textContent = err.message || String(err);
      return;
    }
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

document.getElementById("settings-fiscal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("settings-fiscal-status");
  try {
    const rateInput = document.getElementById("settings-sales-tax-rate").value;
    const res = await apiFetch("/api/org/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fiscal_year_end_month: Number(document.getElementById("settings-fiscal-month").value),
        sales_tax_rate_percent: rateInput === "" ? null : Number(rateInput),
      }),
    });
    const body = await res.json();
    statusEl.textContent = res.ok ? "Saved." : body.detail || "Something went wrong.";
    if (res.ok) {
      invalidateCache("__org_settings__");
      // The balance sheet's earnings split is computed from this, so a
      // cached render of it is stale the moment this changes.
      invalidateCache("__trial_balance__");
    }
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
  const statusEl = document.getElementById("settings-quickbooks-status");
  let error = "";

  // Loops so a mistyped password re-opens the same dialog with the reason,
  // rather than dumping the user back to the settings page to start over.
  for (;;) {
    const password = await confirmDialog("Disconnect QuickBooks?", "You can reconnect at any time.", {
      confirmLabel: "Disconnect",
      requirePassword: true,
      error,
    });
    if (!password) return;

    try {
      const res = await apiFetch("/api/integrations/quickbooks/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: password }),
      });
      const body = await res.json();
      if (res.status === 403 && body.reauth_required) {
        error = body.detail || "That password is incorrect.";
        continue;
      }
      if (!res.ok) throw new Error(body.detail || "Could not disconnect QuickBooks.");
      invalidateCache("__quickbooks__");
      renderQuickbooksStatus(body);
      return;
    } catch (err) {
      statusEl.textContent = err.message || String(err);
      return;
    }
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
      let error = "";
      for (;;) {
        const password = await confirmDialog("Remove this teammate?", "They'll lose access to your account immediately.", {
          confirmLabel: "Remove",
          danger: true,
          requirePassword: true,
          error,
        });
        if (!password) return;

        const res = await apiFetch(`/api/team/members/${btn.dataset.userId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_password: password }),
        });
        if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          if (body.reauth_required) {
            error = body.detail || "That password is incorrect.";
            continue;
          }
        }
        invalidateCache("__team__");
        loadTeam();
        return;
      }
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

  // Owner-only on the backend too (403 for anyone else) -- fetched
  // separately from the rest of this tab, and only for an owner, rather
  // than every member's load eating a request that just comes back denied.
  const usageSection = document.getElementById("team-usage-section");
  usageSection.style.display = isOwner ? "block" : "none";
  if (isOwner) loadTeamUsage();
}

async function loadTeamUsage() {
  await cachedLoad("__team_usage__", async () => (await apiFetch("/api/team/usage")).json(), renderTeamUsage);
}

function renderTeamUsage(data) {
  const body = document.getElementById("team-usage-body");
  // Busiest member first -- the point of this table is seeing who's
  // actually using it (and who isn't) at a glance, not alphabetical order.
  const sorted = [...data.members].sort((a, b) => b.total_actions - a.total_actions);
  body.innerHTML = sorted
    .map(
      (m) => `
    <tr>
      <td>${escapeHtml(m.full_name || m.email)}</td>
      <td>${m.uploaded}</td>
      <td>${m.approved}</td>
      <td>${m.rejected}</td>
      <td>${m.corrections}</td>
      <td>${m.total_actions}</td>
    </tr>
  `
    )
    .join("");
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

// ---- Staff (Rekono's own cross-org usage dashboard) ----
// GET /api/staff/overview (routes/staff.js) is refused with a 403 server-side
// for anyone not on the STAFF_EMAILS allowlist regardless of what's rendered
// here -- the staff-nav-btn hide/show in auth.js's showApp is UX only, not
// the security boundary.
const STAFF_PLAN_NAMES = { free: "Free", starter: "Starter", growth: "Growth", business: "Business", scale: "Scale", no_plan_yet: "Not onboarded yet" };

async function loadStaffOverview() {
  await cachedLoad("__staff_overview__", async () => (await apiFetch("/api/staff/overview")).json(), renderStaffOverview);
}

function renderStaffOverview(data) {
  const s = data.org_summary;
  document.getElementById("staff-org-summary").innerHTML = [
    kpiCard({ label: "Total orgs", value: s.total_orgs, sub: "excludes demo orgs" }),
    kpiCard({ label: "Completed onboarding", value: s.completed_onboarding, sub: `of ${s.total_orgs} total` }),
    kpiCard({
      label: "Uploaded a real document",
      value: data.activation_funnel.uploaded_first_real_document,
      sub: `${data.activation_funnel.approved_first_real_document} have approved one`,
    }),
  ].join("");

  const planBody = document.getElementById("staff-plan-breakdown-body");
  planBody.innerHTML = Object.entries(s.plan_breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([plan, count]) => `<tr><td>${escapeHtml(STAFF_PLAN_NAMES[plan] || plan)}</td><td>${count}</td></tr>`)
    .join("");

  const funnel = data.activation_funnel;
  const funnelBody = document.getElementById("staff-funnel-body");
  funnelBody.innerHTML = [
    ["Signed up", funnel.signed_up],
    ["Completed onboarding", funnel.completed_onboarding],
    ["Uploaded a real document", funnel.uploaded_first_real_document],
    ["Approved a real document", funnel.approved_first_real_document],
  ]
    .map(([stage, count]) => `<tr><td>${stage}</td><td>${count}</td></tr>`)
    .join("");

  const sub = data.subscription_health;
  document.getElementById("staff-sub-active").textContent = sub.active;
  document.getElementById("staff-sub-trialing").textContent = sub.trialing;
  document.getElementById("staff-sub-canceled").textContent = sub.recently_canceled;
  document.getElementById("staff-recently-canceled-header").textContent = `Recently canceled (${sub.window_days}d)`;

  document.getElementById("staff-signup-trend-body").innerHTML = data.signup_trend
    .map((w) => `<tr><td>${w.week_start}</td><td>${w.count}</td></tr>`)
    .join("");
  document.getElementById("staff-volume-trend-body").innerHTML = data.document_volume_trend
    .map((w) => `<tr><td>${w.week_start}</td><td>${w.count}</td></tr>`)
    .join("");
}

// ---- Accounting (chart of accounts, journal entries, trial balance) ----
// See ledger.js on the backend -- every account here is what invoice
// approval and manual entries below post against.

async function loadAccounts() {
  await cachedLoad("__accounts__", async () => (await apiFetch("/api/accounts")).json(), renderAccounts);
}

// Static per org (it's a fixed taxonomy, not org data), so it's cached and
// fetched once per session rather than alongside every accounts reload.
let accountSubtypesByType = {};

async function loadAccountSubtypes() {
  await cachedLoad(
    "__account_subtypes__",
    async () => (await apiFetch("/api/accounts/subtypes")).json(),
    (data) => {
      accountSubtypesByType = data.subtypes;
      populateAccountCreateSubtypes();
    }
  );
}

function subtypeOptionsHtml(type, selected) {
  const options = accountSubtypesByType[type] || [];
  return (
    `<option value="" ${selected ? "" : "selected"}>Uncategorized</option>` +
    options
      .map((s) => `<option value="${s.value}" ${s.value === selected ? "selected" : ""}>${escapeHtml(s.label)}</option>`)
      .join("")
  );
}

function populateAccountCreateSubtypes() {
  const type = document.getElementById("account-create-type").value;
  document.getElementById("account-create-subtype").innerHTML = subtypeOptionsHtml(type, "");
}

document.getElementById("account-create-type").addEventListener("change", populateAccountCreateSubtypes);

// The classification labels ledger.js's LIQUIDITY_RANK sorting already
// implies (current before fixed before other) -- see accountTaxonomy.js.
// Equity/revenue/expense accounts have no current/fixed split, so they
// never get one of these sub-headers, only the type heading above them.
const CLASSIFICATION_LABELS = { current: "Current", fixed: "Fixed", long_term: "Long-term" };

function renderAccounts(data) {
  const body = document.getElementById("accounts-body");
  // Grouped under a heading per category, in the order the server returned
  // them -- balance sheet accounts by liquidity, income statement accounts
  // in the order they were created (ledger.js's sortAccounts). A flat
  // code-sorted list made you read forty rows to find the one liability
  // account you wanted, and gave no clue that the ordering meant anything.
  //
  // Within a balance-sheet type, a second sub-heading splits current from
  // fixed/long-term/other -- bucketed here rather than relied on from
  // server order, since the server only ranks a handful of subtypes for
  // liquidity and leaves the rest in code order, which does not by itself
  // keep every fixed asset contiguous.
  // A third level below type/classification: the subtype itself
  // (accountTaxonomy.js's ACCOUNT_SUBTYPES, e.g. "Bank & Cash",
  // "Accounts Receivable") gets its own heading too, rather than being
  // visible only in each row's own subtype dropdown -- so "what accounts
  // fit under which categories" reads straight off the page instead of
  // needing every row opened to find out.
  let lastType = null;
  let lastClassification = null;
  let lastSubtype = null;
  body.innerHTML = data.items
    .map((a) => {
      const typeChanged = a.type !== lastType;
      const classification = a.classification === "other" ? null : a.classification;
      const classificationChanged = typeChanged || classification !== lastClassification;
      const subtypeChanged = typeChanged || classificationChanged || a.subtype !== lastSubtype;
      lastType = a.type;
      lastClassification = classification;
      lastSubtype = a.subtype;

      const typeHeading = typeChanged
        ? `<tr class="account-group-row"><th colspan="5">${escapeHtml(ACCOUNT_TYPE_LABELS[a.type] || a.type)}</th></tr>`
        : "";
      const classificationHeading =
        classification && classificationChanged
          ? `<tr class="account-subgroup-row"><th colspan="5">${escapeHtml(CLASSIFICATION_LABELS[classification] || classification)}</th></tr>`
          : "";
      const subtypeHeading =
        a.subtype_label && subtypeChanged
          ? `<tr class="account-subtype-row"><th colspan="5">${escapeHtml(a.subtype_label)}</th></tr>`
          : "";

      return `${typeHeading}${classificationHeading}${subtypeHeading}
    <tr>
      <td>${escapeHtml(a.code)}</td>
      <td>${a.is_system_account ? `<strong>${escapeHtml(a.name)}</strong>` : escapeHtml(a.name)}</td>
      <td><select class="account-subtype-select" data-account-id="${a.id}">${subtypeOptionsHtml(a.type, a.subtype)}</select></td>
      <td>${a.active ? "Active" : "Inactive"}</td>
      <td>${
        a.active && !a.is_system_account
          ? `<button type="button" class="account-deactivate-btn" data-account-id="${a.id}">Deactivate</button>`
          : ""
      }</td>
    </tr>
  `;
    })
    .join("");
  body.querySelectorAll(".account-deactivate-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Deactivate this account?", "It stays on past journal entries but won't be selectable for new ones.", {
        confirmLabel: "Deactivate",
        danger: true,
      });
      if (!confirmed) return;
      await apiFetch(`/api/accounts/${btn.dataset.accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      invalidateCache("__accounts__");
      invalidateCache("__journal_entry_accounts__");
      loadAccounts();
    });
  });
  body.querySelectorAll(".account-subtype-select").forEach((select) => {
    select.addEventListener("change", async () => {
      await apiFetch(`/api/accounts/${select.dataset.accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subtype: select.value }),
      });
      invalidateCache("__accounts__");
      loadAccounts();
    });
  });
}

// The one create path, shared by the Chart of Accounts form and the Home
// modal. Both offer the same four fields, so the only thing worth having
// twice is the markup -- two copies of the POST, the cache invalidation
// and the reload is how one of them ends up quietly missing a step.
// Returns an error string, or null on success.
async function createAccount({ name, type, subtype, code }) {
  try {
    const res = await apiFetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type, subtype, code }),
    });
    const body = await res.json();
    if (!res.ok) return errorText(body.detail, "Something went wrong.");
    invalidateCache("__accounts__");
    invalidateCache("__journal_entry_accounts__");
    loadAccounts();
    return null;
  } catch (err) {
    return err.message || String(err);
  }
}

document.getElementById("account-create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("account-create-status");
  const error = await createAccount({
    name: document.getElementById("account-create-name").value,
    type: document.getElementById("account-create-type").value,
    subtype: document.getElementById("account-create-subtype").value,
    code: document.getElementById("account-create-code").value,
  });
  statusEl.textContent = error || "";
  if (!error) e.target.reset();
});

// ---- "Add an account" modal (Home) ----

async function openAccountModal() {
  const form = document.getElementById("account-modal-form");
  form.reset();
  hideAccountModalError();
  document.getElementById("account-modal").style.display = "flex";
  document.getElementById("account-modal-name").focus();

  // The taxonomy is only fetched when the Chart of Accounts tab opens, and
  // reaching this modal from Home doesn't go through that tab -- so without
  // this the Category dropdown offers nothing but "Uncategorized" until
  // you've visited Chart of Accounts at least once this session. Cached, so
  // it's a no-op every time after the first.
  await loadAccountSubtypes();
  // Populated from the selected type, same as the Chart of Accounts form --
  // the category list is per-type, so a stale one would offer, say, "Cost
  // of revenue" under an asset.
  populateAccountModalSubtypes();
}

function closeAccountModal() {
  document.getElementById("account-modal").style.display = "none";
}

function hideAccountModalError() {
  const el = document.getElementById("account-modal-error");
  el.textContent = "";
  el.style.display = "none";
}

function populateAccountModalSubtypes() {
  const type = document.getElementById("account-modal-type").value;
  document.getElementById("account-modal-subtype").innerHTML = subtypeOptionsHtml(type, "");
}

document.getElementById("account-modal-type").addEventListener("change", populateAccountModalSubtypes);
document.getElementById("account-modal-cancel").addEventListener("click", closeAccountModal);

document.getElementById("account-modal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAccountModalError();
  const error = await createAccount({
    name: document.getElementById("account-modal-name").value,
    type: document.getElementById("account-modal-type").value,
    subtype: document.getElementById("account-modal-subtype").value,
    code: document.getElementById("account-modal-code").value,
  });
  if (error) {
    // Kept open on failure, with the typing intact, for the same reason
    // saveCorrections returns before re-rendering: a duplicate code or a
    // name clash is something you fix in the field you just filled in, not
    // by reopening the form and starting again.
    const el = document.getElementById("account-modal-error");
    el.textContent = error;
    el.style.display = "";
    return;
  }
  closeAccountModal();
});

// Cached separately from __accounts__ above: the manual-entry form only
// ever needs active accounts to populate its line dropdowns, while the
// Chart of Accounts tab needs every account (active and not) to manage.
let journalEntryAccounts = [];

async function loadJournalEntryAccounts() {
  await cachedLoad(
    "__journal_entry_accounts__",
    async () => (await apiFetch("/api/accounts?active=true")).json(),
    (data) => {
      journalEntryAccounts = data.items;
      // Existing line rows keep whatever account they already had selected
      // (rebuilding options would otherwise reset a row mid-entry) -- new
      // rows added after this point pick up the fresh list.
      if (!document.getElementById("je-lines-body").children.length) {
        addJournalEntryLineRow();
        addJournalEntryLineRow();
      }
    }
  );
}

// The five account categories, in statement order: balance sheet first
// (assets, liabilities, equity), then the income statement (revenue,
// expenses). The server already returns accounts in this order -- see
// ledger.js's sortAccounts -- so grouping here is only a matter of
// inserting a heading each time the type changes, never re-sorting.
const ACCOUNT_TYPE_LABELS = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  revenue: "Revenue",
  expense: "Expenses",
};

// <optgroup> rather than a flat list: an account picker with forty entries
// is a wall of text, and the type of the account you want is the first
// thing you know about it.
function groupedAccountOptionsHtml(accounts, selectedId) {
  const groups = [];
  for (const a of accounts) {
    if (!groups.length || groups[groups.length - 1].type !== a.type) groups.push({ type: a.type, accounts: [] });
    groups[groups.length - 1].accounts.push(a);
  }
  return groups
    .map(
      (g) => `<optgroup label="${escapeHtml(ACCOUNT_TYPE_LABELS[g.type] || g.type)}">${g.accounts
        .map(
          (a) =>
            `<option value="${a.id}" ${a.id === selectedId ? "selected" : ""}>${escapeHtml(
              a.code ? `${a.code} - ${a.name}` : a.name
            )}</option>`
        )
        .join("")}</optgroup>`
    )
    .join("");
}

function accountOptionsHtml(selectedId) {
  return groupedAccountOptionsHtml(journalEntryAccounts, selectedId);
}

function updateJournalEntryBalanceIndicator() {
  const rows = [...document.getElementById("je-lines-body").querySelectorAll("tr")];
  let debit = 0;
  let credit = 0;
  for (const row of rows) {
    debit += Number(row.querySelector(".je-debit").value) || 0;
    credit += Number(row.querySelector(".je-credit").value) || 0;
  }
  const indicator = document.getElementById("je-balance-indicator");
  const diff = Math.round((debit - credit) * 100) / 100;
  if (diff === 0 && (debit || credit)) {
    indicator.textContent = `Balanced: ${fmtMoney(debit)}`;
    indicator.className = "hint";
  } else {
    indicator.textContent = `Debits ${fmtMoney(debit)}, credits ${fmtMoney(credit)} -- ${diff > 0 ? "needs more credit" : "needs more debit"} of ${fmtMoney(Math.abs(diff))} to balance.`;
    indicator.className = "hint kpi-sub-warning";
  }
}

function addJournalEntryLineRow() {
  const body = document.getElementById("je-lines-body");
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><select class="je-account" required>${accountOptionsHtml(null)}</select></td>
    <td><input type="number" class="je-debit" step="0.01" min="0" placeholder="0.00" /></td>
    <td><input type="number" class="je-credit" step="0.01" min="0" placeholder="0.00" /></td>
    <td><button type="button" class="je-remove-line linklike">Remove</button></td>
  `;
  body.appendChild(row);
  row.querySelectorAll(".je-debit, .je-credit").forEach((input) => input.addEventListener("input", updateJournalEntryBalanceIndicator));
  row.querySelector(".je-remove-line").addEventListener("click", () => {
    row.remove();
    updateJournalEntryBalanceIndicator();
  });
  updateJournalEntryBalanceIndicator();
}

document.getElementById("je-add-line").addEventListener("click", addJournalEntryLineRow);

document.getElementById("journal-entry-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("journal-entry-status");
  const rows = [...document.getElementById("je-lines-body").querySelectorAll("tr")];
  const lines = rows.map((row) => ({
    account_id: row.querySelector(".je-account").value,
    debit: Number(row.querySelector(".je-debit").value) || 0,
    credit: Number(row.querySelector(".je-credit").value) || 0,
  }));

  try {
    const res = await apiFetch("/api/journal-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry_date: document.getElementById("je-date").value,
        memo: document.getElementById("je-memo").value,
        doc_number: document.getElementById("je-doc-number").value,
        lines,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      statusEl.textContent = body.detail || "Something went wrong.";
      return;
    }
    statusEl.textContent = "";
    e.target.reset();
    document.getElementById("je-lines-body").innerHTML = "";
    addJournalEntryLineRow();
    addJournalEntryLineRow();
    invalidateCache("__journal_entries__");
    invalidateCache("__trial_balance__");
    loadJournalEntries();
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

// Which special-purpose journal is showing -- mirrors
// routes/journalEntries.js's SPECIAL_JOURNAL_SOURCES exactly, since these
// are filters over the one ledger by JournalEntry.source, not a second
// place transactions get written to. "" means unfiltered (every entry).
let activeJournalFilter = "";

const GENERAL_JOURNAL_HEAD = `<tr><th></th><th>Date</th><th>Memo</th><th>Doc #</th><th>Journal</th><th>Total</th><th>Status</th><th></th></tr>`;
const PURCHASES_JOURNAL_HEAD = `<tr><th>Date</th><th>Account title</th><th>Doc #</th><th>Post ref.</th><th>Amount</th><th>Status</th><th></th></tr>`;
const CASH_PAYMENTS_JOURNAL_HEAD = `<tr><th>Date</th><th>Account title</th><th>Doc #</th><th>Post ref.</th><th>Debit</th><th>Credit</th><th>Accounts payable debit</th><th>Purchases discount credit</th><th>Cash credit</th><th>Status</th><th></th></tr>`;

// Purchases and cash payments are the two journals whose checklist column
// set names specific named amounts (a single Purchases/AP amount; AP debit,
// Purchases discount credit, Cash credit) rather than a generic
// debit/credit pair -- these fetch each entry's lines (`include=lines`) and
// render a specialized table instead of the generic one every other
// journal uses. The render functions are declared further below (function
// declarations are hoisted, so referencing them here before their textual
// definition is safe).
const SPECIALIZED_JOURNAL_VIEWS = {
  purchases: { head: PURCHASES_JOURNAL_HEAD, render: renderPurchasesJournal },
  cash_payments: { head: CASH_PAYMENTS_JOURNAL_HEAD, render: renderCashPaymentsJournal },
};

async function loadJournalEntries() {
  const specialized = SPECIALIZED_JOURNAL_VIEWS[activeJournalFilter];
  document.getElementById("journal-entries-thead").innerHTML = specialized ? specialized.head : GENERAL_JOURNAL_HEAD;
  const q = activeJournalFilter ? `?journal=${activeJournalFilter}${specialized ? "&include=lines" : ""}` : "";
  await cachedLoad(
    `/api/journal-entries${q}`,
    async () => (await apiFetch(`/api/journal-entries${q}`)).json(),
    specialized ? specialized.render : renderJournalEntries
  );
}

const JOURNAL_ENTRY_SOURCE_LABELS = {
  manual: "Manual",
  invoice_approval: "Invoice approval",
  bill_payment: "Bill payment",
  customer_invoice: "Customer invoice",
  customer_payment: "Customer payment",
  revenue_recognition: "Revenue recognition",
  recurring_entry: "Recurring entry",
  reversing_entry: "Reversing entry",
  closing_entry: "Closing entry",
  equity_transaction: "Dividend declared",
  equity_contribution: "Capital contribution",
  equity_distribution: "Distribution to owners",
  equity_dividend_paid: "Dividend paid",
  equity_treasury_purchase: "Treasury purchase",
  equity_treasury_reissue: "Treasury reissue",
  stock_compensation: "Stock compensation",
  income_tax: "Income tax provision",
  income_tax_payment: "Income tax paid",
  payroll_run: "Payroll",
  void: "Void",
};

// Shared by every journal view (generic, purchases, cash payments): a
// "Void" button posts the same reversal regardless of which columns got it
// there.
function wireVoidButtons(body) {
  body.querySelectorAll(".je-void-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Void this journal entry?", "Posts a reversing entry; the original stays on the books for reference.", {
        confirmLabel: "Void",
        danger: true,
      });
      if (!confirmed) return;
      await apiFetch(`/api/journal-entries/${btn.dataset.entryId}/void`, { method: "POST" });
      invalidateCache("__journal_entries__");
      invalidateCache("__trial_balance__");
      loadJournalEntries();
    });
  });
}

function voidCellHtml(entry) {
  return entry.status === "posted" ? `<button type="button" class="je-void-btn" data-entry-id="${entry.id}">Void</button>` : "";
}

function renderJournalEntries(data) {
  const body = document.getElementById("journal-entries-body");
  body.innerHTML = data.items
    .map(
      (entry) => `
    <tr class="je-summary-row" data-entry-id="${entry.id}">
      <td><button type="button" class="je-expand-btn linklike" data-entry-id="${entry.id}" aria-label="Show lines">▸</button></td>
      <td>${entry.entry_date}</td>
      <td>${escapeHtml(entry.memo || "—")}</td>
      <td>${escapeHtml(entry.doc_number || "—")}</td>
      <td>${JOURNAL_ENTRY_SOURCE_LABELS[entry.source] || entry.source}</td>
      <td>${fmtMoney(entry.total)}</td>
      <td>${entry.status}</td>
      <td>${voidCellHtml(entry)}</td>
    </tr>
  `
    )
    .join("");
  wireVoidButtons(body);
  body.querySelectorAll(".je-expand-btn").forEach((btn) => {
    btn.addEventListener("click", () => toggleJournalEntryLines(btn));
  });
}

// Every invoice_approval entry is exactly two lines by construction
// (ledger.js's postInvoiceApproval): one expense/COGS debit, one Accounts
// Payable credit. The AP line is identified by account subtype, not name or
// code, since either can be renamed -- the other line is "the account title"
// the traditional single-amount purchases journal column names.
function classifyPurchasesLines(lines) {
  const apLine = lines.find((l) => l.account_subtype === "accounts_payable" && l.credit > 0);
  const otherLine = lines.find((l) => l !== apLine) || lines[0] || {};
  return { apLine, otherLine };
}

function renderPurchasesJournal(data) {
  const body = document.getElementById("journal-entries-body");
  body.innerHTML = data.items
    .map((entry) => {
      const { otherLine } = classifyPurchasesLines(entry.lines || []);
      // Debit and credit are the same figure by construction -- one Amount
      // column is both, per the checklist's own note.
      const amount = otherLine.debit || entry.total;
      return `
    <tr>
      <td>${entry.entry_date}</td>
      <td>${escapeHtml(otherLine.account_name || "—")}</td>
      <td>${escapeHtml(entry.doc_number || "—")}</td>
      <td>${escapeHtml(otherLine.post_ref || "—")}</td>
      <td>${fmtMoney(amount)}</td>
      <td>${entry.status}</td>
      <td>${voidCellHtml(entry)}</td>
    </tr>`;
    })
    .join("");
  wireVoidButtons(body);
}

// Cash-payment sources vary (paying a bill, running payroll, paying income
// tax, an equity distribution) and only the bill-payment case has real
// "Accounts Payable"/"Purchases discount" amounts -- everything else lands
// in the generic account-title/debit/credit columns instead of leaving
// those AP-specific columns awkwardly populated with something they were
// never meant for. Classified by account subtype (not name/code, both
// renameable): the AP line, the Purchases Discounts Taken line (if a
// discount was taken), and the cash/bank/credit-card line the money
// actually left from. Whatever's left -- payroll's wage and tax debits and
// its liability credit, an equity event's one debit line, and so on --
// falls into "everything else" and is summed/joined into the generic
// columns, which is exactly what those columns are for.
function classifyCashPaymentLines(lines) {
  const apLine = lines.find((l) => l.account_subtype === "accounts_payable" && l.debit > 0);
  const discountLine = lines.find((l) => l.account_subtype === "purchases_discount" && l.credit > 0);
  const cashLine = lines.find((l) => (l.account_subtype === "bank" || l.account_subtype === "credit_card") && l.credit > 0);
  const otherLines = lines.filter((l) => l !== apLine && l !== discountLine && l !== cashLine);
  return { apLine, discountLine, cashLine, otherLines };
}

function renderCashPaymentsJournal(data) {
  const body = document.getElementById("journal-entries-body");
  body.innerHTML = data.items
    .map((entry) => {
      const { apLine, discountLine, cashLine, otherLines } = classifyCashPaymentLines(entry.lines || []);
      const accountTitle = otherLines.map((l) => l.account_name).join(", ");
      const postRef = otherLines.map((l) => l.post_ref).filter(Boolean).join(", ");
      const otherDebit = otherLines.reduce((sum, l) => sum + (l.debit || 0), 0);
      const otherCredit = otherLines.reduce((sum, l) => sum + (l.credit || 0), 0);
      return `
    <tr>
      <td>${entry.entry_date}</td>
      <td>${escapeHtml(accountTitle || "—")}</td>
      <td>${escapeHtml(entry.doc_number || "—")}</td>
      <td>${escapeHtml(postRef || "—")}</td>
      <td>${otherDebit ? fmtMoney(otherDebit) : ""}</td>
      <td>${otherCredit ? fmtMoney(otherCredit) : ""}</td>
      <td>${apLine?.debit ? fmtMoney(apLine.debit) : ""}</td>
      <td>${discountLine?.credit ? fmtMoney(discountLine.credit) : ""}</td>
      <td>${cashLine?.credit ? fmtMoney(cashLine.credit) : ""}</td>
      <td>${entry.status}</td>
      <td>${voidCellHtml(entry)}</td>
    </tr>`;
    })
    .join("");
  wireVoidButtons(body);
}

// Every column the checklist asks for -- date, account title, doc #, post
// ref., debit, credit -- lives across the summary row (date, doc #) and
// this per-entry detail row (account title, post ref., debit, credit),
// fetched lazily on expand rather than upfront for every row in the list.
async function toggleJournalEntryLines(btn) {
  const summaryRow = btn.closest("tr");
  const existing = summaryRow.nextElementSibling;
  if (existing && existing.classList.contains("je-detail-row")) {
    existing.remove();
    btn.textContent = "▸";
    return;
  }
  document.querySelectorAll(".je-detail-row").forEach((row) => row.remove());
  document.querySelectorAll(".je-expand-btn").forEach((b) => (b.textContent = "▸"));
  btn.textContent = "▾";

  const detailRow = document.createElement("tr");
  detailRow.className = "je-detail-row";
  detailRow.innerHTML = `<td colspan="8">Loading…</td>`;
  summaryRow.after(detailRow);

  const entry = await (await apiFetch(`/api/journal-entries/${btn.dataset.entryId}`)).json();
  detailRow.innerHTML = `
    <td colspan="8">
      <table class="je-lines-detail">
        <thead><tr><th>Account title</th><th>Post ref.</th><th>Debit</th><th>Credit</th></tr></thead>
        <tbody>
          ${entry.lines
            .map(
              (l) => `<tr>
                <td>${escapeHtml(l.account_name || "—")}</td>
                <td>${escapeHtml(l.post_ref || "—")}</td>
                <td>${l.debit ? fmtMoney(l.debit) : ""}</td>
                <td>${l.credit ? fmtMoney(l.credit) : ""}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </td>`;
}

document.querySelectorAll("#journal-filter-tabs .filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeJournalFilter = btn.dataset.journal;
    document.querySelectorAll("#journal-filter-tabs .filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    loadJournalEntries();
  });
});

// ---- Payroll ----
// See payroll.js: this records a pay run's already-computed numbers
// (gross, withholding, employer taxes) and posts the journal entry they
// imply -- Rekono doesn't calculate tax tables itself.

async function loadPayrollAccounts() {
  const data = await (await apiFetch("/api/accounts?active=true")).json();
  const cashAccounts = data.items.filter((a) => ["asset", "liability"].includes(a.type));
  const expenseAccounts = data.items.filter((a) => a.type === "expense");
  const liabilityAccounts = data.items.filter((a) => a.type === "liability");
  document.getElementById("pr-payment-account").innerHTML = groupedAccountOptionsHtml(cashAccounts, null);
  document.getElementById("pr-wages-account").innerHTML = groupedAccountOptionsHtml(expenseAccounts, null);
  document.getElementById("pr-payroll-tax-account").innerHTML = groupedAccountOptionsHtml(expenseAccounts, null);
  document.getElementById("pr-liability-account").innerHTML = groupedAccountOptionsHtml(liabilityAccounts, null);
}

async function loadEmployees() {
  await cachedLoad("__employees__", async () => (await apiFetch("/api/employees")).json(), renderEmployees);
}

function renderEmployees(employees) {
  const list = document.getElementById("employees-list");
  list.innerHTML = employees.length
    ? `<table><thead><tr><th>Name</th><th>Status</th><th></th></tr></thead><tbody>${employees
        .map(
          (e) => `
    <tr>
      <td>${escapeHtml(e.name)}</td>
      <td>${e.active ? "Active" : "Inactive"}</td>
      <td><button type="button" class="employee-toggle-btn linklike" data-id="${e.id}" data-active="${e.active}">${
            e.active ? "Deactivate" : "Activate"
          }</button></td>
    </tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="hint">No employees yet -- add one above before recording a pay run.</p>`;

  list.querySelectorAll(".employee-toggle-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await apiFetch(`/api/employees/${btn.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: btn.dataset.active !== "true" }),
      });
      invalidateCache("__employees__");
      loadEmployees();
    })
  );

  const active = employees.filter((e) => e.active);
  document.getElementById("pr-employee").innerHTML = active.length
    ? active.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join("")
    : `<option value="">No active employees</option>`;
}

document.getElementById("employee-create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("employee-create-name");
  const res = await apiFetch("/api/employees", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nameInput.value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    await alertDialog("Couldn't add that employee", body.detail?.[0]?.message || body.detail || "Something went wrong.");
    return;
  }
  nameInput.value = "";
  invalidateCache("__employees__");
  loadEmployees();
});

// A live preview only -- the server computes and validates the real net
// pay from the same fields on submit, this just saves a round trip to
// notice a withholding total that doesn't add up.
function updatePayrollNetPayPreview() {
  const gross = Number(document.getElementById("pr-gross-wages").value) || 0;
  const federal = Number(document.getElementById("pr-federal-tax").value) || 0;
  const state = Number(document.getElementById("pr-state-tax").value) || 0;
  const ficaEmployee = Number(document.getElementById("pr-fica-employee").value) || 0;
  const other = Number(document.getElementById("pr-other-deductions").value) || 0;
  const net = gross - federal - state - ficaEmployee - other;
  const preview = document.getElementById("pr-net-pay-preview");
  preview.textContent = gross ? `Net pay: ${fmtMoney(net)}` : "";
  preview.className = net < 0 ? "hint kpi-sub-warning" : "hint";
}

["pr-gross-wages", "pr-federal-tax", "pr-state-tax", "pr-fica-employee", "pr-other-deductions"].forEach((id) => {
  document.getElementById(id).addEventListener("input", updatePayrollNetPayPreview);
});

document.getElementById("payroll-run-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("payroll-run-status");
  const res = await apiFetch("/api/payroll-runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      employee_id: document.getElementById("pr-employee").value,
      pay_date: document.getElementById("pr-pay-date").value,
      gross_wages: Number(document.getElementById("pr-gross-wages").value) || 0,
      federal_tax_withheld: Number(document.getElementById("pr-federal-tax").value) || 0,
      state_tax_withheld: Number(document.getElementById("pr-state-tax").value) || 0,
      fica_employee_withheld: Number(document.getElementById("pr-fica-employee").value) || 0,
      other_deductions: Number(document.getElementById("pr-other-deductions").value) || 0,
      employer_fica_match: Number(document.getElementById("pr-fica-employer").value) || 0,
      employer_unemployment_tax: Number(document.getElementById("pr-unemployment-tax").value) || 0,
      payment_account_id: document.getElementById("pr-payment-account").value,
      wages_expense_account_id: document.getElementById("pr-wages-account").value,
      payroll_tax_expense_account_id: document.getElementById("pr-payroll-tax-account").value,
      liability_account_id: document.getElementById("pr-liability-account").value,
      memo: document.getElementById("pr-memo").value,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = body.detail?.[0]?.message || body.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = "";
  e.target.reset();
  document.getElementById("pr-net-pay-preview").textContent = "";
  invalidateCache("__payroll_runs__");
  invalidateCache("__trial_balance__");
  invalidateCache("__journal_entries__");
  loadPayrollRuns();
});

async function loadPayrollRuns() {
  await cachedLoad("__payroll_runs__", async () => (await apiFetch("/api/payroll-runs")).json(), renderPayrollRuns);
}

function renderPayrollRuns(runs) {
  const body = document.getElementById("payroll-runs-body");
  if (!runs.length) {
    body.innerHTML = `<tr><td colspan="12" class="table-empty-row">No pay runs recorded yet.</td></tr>`;
    return;
  }
  body.innerHTML = runs
    .map(
      (r) => `
    <tr>
      <td>${r.pay_date}</td>
      <td>${escapeHtml(r.employee_name)}</td>
      <td>${fmtMoney(r.gross_wages)}</td>
      <td>${fmtMoney(r.federal_tax_withheld)}</td>
      <td>${fmtMoney(r.state_tax_withheld)}</td>
      <td>${fmtMoney(r.fica_employee_withheld)}</td>
      <td>${fmtMoney(r.other_deductions)}</td>
      <td>${fmtMoney(r.net_pay)}</td>
      <td>${fmtMoney(r.employer_fica_match)}</td>
      <td>${fmtMoney(r.employer_unemployment_tax)}</td>
      <td>${fmtMoney(r.employer_tax_total)}</td>
      <td><button type="button" class="pr-void-btn linklike" data-id="${r.id}">Void</button></td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".pr-void-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Void this pay run?", "Posts a reversing entry; the original stays on the books for reference.", {
        confirmLabel: "Void",
        danger: true,
      });
      if (!confirmed) return;
      const res = await apiFetch(`/api/payroll-runs/${btn.dataset.id}/void`, { method: "POST" });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        await alertDialog("Couldn't void that pay run", errBody.detail || "Something went wrong.");
        return;
      }
      invalidateCache("__payroll_runs__");
      invalidateCache("__trial_balance__");
      invalidateCache("__journal_entries__");
      loadPayrollRuns();
    })
  );
}

async function loadTrialBalance() {
  await cachedLoad("__trial_balance__", async () => (await apiFetch("/api/ledger/trial-balance")).json(), renderTrialBalance);
}

function renderTrialBalance(data) {
  document.getElementById("trial-balance-body").innerHTML = data.accounts
    .map(
      (a) => `
    <tr>
      <td>${escapeHtml(a.code)}</td>
      <td>${accountDrillButton(a.account_id, a.name, { to: data.as_of })}</td>
      <td>${a.type}</td>
      <td>${a.debit ? fmtMoney(a.debit) : ""}</td>
      <td>${a.credit ? fmtMoney(a.credit) : ""}</td>
    </tr>
  `
    )
    .join("");
  document.getElementById("trial-balance-total-debit").textContent = fmtMoney(data.total_debit);
  document.getElementById("trial-balance-total-credit").textContent = fmtMoney(data.total_credit);

  const banner = document.getElementById("trial-balance-banner");
  banner.textContent = data.balanced ? "Balanced." : "Not balanced -- this shouldn't happen; please contact support.";
  banner.className = data.balanced ? "hint" : "hint kpi-sub-warning";
}

// ---- Bank reconciliation ----
// Tying a cash account's book balance to a bank statement -- see
// bankReconciliation.js for the accounting. bankRecOpenId tracks whichever
// reconciliation the detail panel below is currently showing, so a clear/
// unclear click knows which one to post against without re-reading it out
// of the DOM.

let bankRecOpenId = null;
let bankRecAccountNames = new Map();

async function loadBankReconciliation() {
  const dateEl = document.getElementById("bankrec-statement-date");
  if (!dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);

  const [accountsData, historyData] = await Promise.all([
    apiFetch("/api/bank-reconciliations/accounts").then((r) => r.json()),
    apiFetch("/api/bank-reconciliations").then((r) => r.json()),
  ]);

  document.getElementById("bankrec-account").innerHTML = accountsData.items
    .map((a) => `<option value="${a.id}">${escapeHtml(a.code ? `${a.code} - ${a.name}` : a.name)}</option>`)
    .join("");
  bankRecAccountNames = new Map(accountsData.items.map((a) => [a.id, a.code ? `${a.code} - ${a.name}` : a.name]));

  renderBankRecHistory(historyData.items);

  if (bankRecOpenId && historyData.items.some((r) => r.id === bankRecOpenId)) {
    openBankReconciliation(bankRecOpenId);
  }
}

function renderBankRecHistory(items) {
  const body = document.getElementById("bankrec-history-body");
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="5" class="table-empty-row">No reconciliations yet.</td></tr>`;
    return;
  }
  body.innerHTML = items
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(bankRecAccountNames.get(r.cash_account_id) || "")}</td>
      <td>${escapeHtml(r.statement_date)}</td>
      <td>${fmtMoney(r.statement_ending_balance)}</td>
      <td>${r.status === "completed" ? "Reconciled" : "In progress"}</td>
      <td><button type="button" class="bankrec-open-btn" data-id="${r.id}">${r.status === "completed" ? "View" : "Resume"}</button></td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".bankrec-open-btn").forEach((btn) =>
    btn.addEventListener("click", () => openBankReconciliation(btn.dataset.id))
  );
}

document.getElementById("bankrec-start-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("bankrec-start-status");
  const res = await apiFetch("/api/bank-reconciliations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cash_account_id: document.getElementById("bankrec-account").value,
      statement_date: document.getElementById("bankrec-statement-date").value,
      statement_ending_balance: Number(document.getElementById("bankrec-ending-balance").value) || 0,
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = "";
  document.getElementById("bankrec-ending-balance").value = "";
  await loadBankReconciliation();
  renderBankRecDetail(parsed);
});

function bankRecLineRow(line) {
  const amount = line.credit || line.debit;
  return `
    <tr>
      <td>${escapeHtml(line.entry_date)}</td>
      <td>${escapeHtml(line.memo || "")}</td>
      <td>${fmtMoney(amount)}</td>
      <td><button type="button" class="bankrec-clear-btn" data-line-id="${line.journal_line_id}" data-cleared="false">Clear</button></td>
    </tr>
  `;
}

function bankRecClearedRow(line) {
  const amount = line.credit || line.debit;
  return `
    <tr>
      <td>${escapeHtml(line.entry_date)}</td>
      <td>${escapeHtml(line.memo || "")}</td>
      <td>${fmtMoney(amount)}</td>
      <td><button type="button" class="bankrec-clear-btn" data-line-id="${line.journal_line_id}" data-cleared="true">Undo</button></td>
    </tr>
  `;
}

async function openBankReconciliation(id) {
  const data = await (await apiFetch(`/api/bank-reconciliations/${id}`)).json();
  renderBankRecDetail(data);
}

function renderBankRecDetail(data) {
  bankRecOpenId = data.id;
  const panel = document.getElementById("bankrec-detail");
  panel.hidden = false;

  document.getElementById("bankrec-detail-title").textContent =
    `${data.cash_account_name} -- statement ${data.statement_date}`;
  document.getElementById("bankrec-d-statement").textContent = fmtMoney(data.statement_ending_balance);
  document.getElementById("bankrec-d-cleared").textContent = fmtMoney(data.cleared_balance);
  document.getElementById("bankrec-d-difference").textContent = fmtMoney(data.difference);
  document.getElementById("bankrec-d-book").textContent = fmtMoney(data.book_balance);

  const banner = document.getElementById("bankrec-detail-banner");
  if (data.status === "completed") {
    banner.textContent = "Reconciled.";
    banner.className = "hint";
  } else if (data.difference === 0) {
    banner.textContent = "Everything cleared ties out to the statement -- ready to mark reconciled.";
    banner.className = "hint";
  } else {
    banner.textContent = `Off by ${fmtMoney(Math.abs(data.difference))}. Check for a missing bank fee or interest, or a line cleared by mistake.`;
    banner.className = "hint kpi-sub-warning";
  }

  const isOpen = data.status !== "completed";
  const outstandingBody = document.getElementById("bankrec-outstanding-body");
  outstandingBody.innerHTML = data.outstanding_checks.length
    ? data.outstanding_checks.map(bankRecLineRow).join("")
    : `<tr><td colspan="4" class="table-empty-row">Nothing outstanding.</td></tr>`;

  const depositsBody = document.getElementById("bankrec-deposits-body");
  depositsBody.innerHTML = data.deposits_in_transit.length
    ? data.deposits_in_transit.map(bankRecLineRow).join("")
    : `<tr><td colspan="4" class="table-empty-row">Nothing in transit.</td></tr>`;

  const clearedBody = document.getElementById("bankrec-cleared-body");
  clearedBody.innerHTML = data.cleared_lines.length
    ? data.cleared_lines.map(bankRecClearedRow).join("")
    : `<tr><td colspan="4" class="table-empty-row">Nothing cleared yet.</td></tr>`;

  panel.querySelectorAll(".bankrec-clear-btn").forEach((btn) => {
    btn.disabled = !isOpen;
    btn.addEventListener("click", async () => {
      const res = await apiFetch(`/api/bank-reconciliations/${data.id}/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ journal_line_id: btn.dataset.lineId, cleared: btn.dataset.cleared !== "true" }),
      });
      const parsed = await res.json().catch(() => ({}));
      if (res.ok) renderBankRecDetail(parsed);
    });
  });

  document.getElementById("bankrec-complete-btn").hidden = !isOpen;
  document.getElementById("bankrec-reopen-btn").hidden = isOpen;
}

document.getElementById("bankrec-complete-btn").addEventListener("click", async () => {
  if (!bankRecOpenId) return;
  const confirmed = await confirmDialog("Mark this reconciliation reconciled?", "You can reopen it later if you need to change what's cleared.", {
    confirmLabel: "Mark reconciled",
  });
  if (!confirmed) return;
  const res = await apiFetch(`/api/bank-reconciliations/${bankRecOpenId}/complete`, { method: "POST" });
  const parsed = await res.json().catch(() => ({}));
  if (res.ok) {
    renderBankRecDetail(parsed);
    loadBankReconciliation();
  }
});

document.getElementById("bankrec-reopen-btn").addEventListener("click", async () => {
  if (!bankRecOpenId) return;
  const res = await apiFetch(`/api/bank-reconciliations/${bankRecOpenId}/reopen`, { method: "POST" });
  const parsed = await res.json().catch(() => ({}));
  if (res.ok) {
    renderBankRecDetail(parsed);
    loadBankReconciliation();
  }
});

// ---- Financial statements (P&L, balance sheet, cash flow) ----
// All three are read-only views over the ledger (financialStatements.js on
// the backend) -- nothing here creates or stores a statement, so there's
// no cache to invalidate on a mutation the way the ledger tabs above have.

// `period` is {from, to} (either may be omitted) -- passed straight through
// to the account-ledger drill-down so it opens showing exactly the window
// this row's amount was computed over.
function statementAccountRows(accounts, period = {}) {
  if (!accounts.length) return `<tr><td colspan="3" class="table-empty-row">No activity in this period.</td></tr>`;
  return accounts
    .map(
      (a) => `<tr><td>${escapeHtml(a.code)}</td><td>${accountDrillButton(a.account_id, a.name, period)}</td><td>${fmtMoney(a.amount)}</td></tr>`
    )
    .join("");
}

function accountDrillButton(accountId, name, { from = "", to = "" } = {}) {
  return `<button type="button" class="linklike account-drill-btn" data-account-id="${escapeHtml(accountId)}" data-account-name="${escapeHtml(name)}" data-from="${escapeHtml(from || "")}" data-to="${escapeHtml(to || "")}">${escapeHtml(name)}</button>`;
}

// ---- Account ledger drill-down ----
// "How was this number calculated" for any amount on the trial balance,
// income statement, or balance sheet: the actual posted lines that sum to
// it, oldest first, with a running balance. See routes/accounts.js's
// GET /api/accounts/:id/ledger.

async function openAccountLedger(accountId, accountName, from, to) {
  const modal = document.getElementById("account-ledger-modal");
  document.getElementById("account-ledger-title").textContent = accountName;
  document.getElementById("account-ledger-period").textContent = "Loading…";
  document.getElementById("account-ledger-body").innerHTML = "";
  document.getElementById("account-ledger-summary").textContent = "";
  modal.style.display = "flex";

  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const query = params.toString();
  const res = await apiFetch(`/api/accounts/${accountId}/ledger${query ? `?${query}` : ""}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    document.getElementById("account-ledger-period").textContent = data.detail || "Couldn't load this account's activity.";
    return;
  }

  document.getElementById("account-ledger-period").textContent =
    from && to ? `Activity from ${from} through ${to}.` : to ? `Everything posted through ${to}.` : "Everything posted to date.";

  document.getElementById("account-ledger-body").innerHTML = data.rows.length
    ? data.rows
        .map(
          (r) => `
    <tr>
      <td>${r.entry_date}</td>
      <td>${escapeHtml(r.memo || "—")}</td>
      <td>${JOURNAL_ENTRY_SOURCE_LABELS[r.source] || r.source}</td>
      <td>${escapeHtml(r.other_accounts.join(", ") || "—")}</td>
      <td>${r.debit ? fmtMoney(r.debit) : ""}</td>
      <td>${r.credit ? fmtMoney(r.credit) : ""}</td>
      <td>${fmtMoney(r.balance)}</td>
    </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="table-empty-row">No activity in this window.</td></tr>`;

  document.getElementById("account-ledger-summary").textContent =
    `Opening balance ${fmtMoney(data.opening_balance)} -- closing balance ${fmtMoney(data.closing_balance)}.`;
}

function closeAccountLedger() {
  document.getElementById("account-ledger-modal").style.display = "none";
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".account-drill-btn");
  if (btn) {
    openAccountLedger(btn.dataset.accountId, btn.dataset.accountName, btn.dataset.from || null, btn.dataset.to || null);
  }
});
document.getElementById("account-ledger-close").addEventListener("click", closeAccountLedger);
document.getElementById("account-ledger-modal").addEventListener("click", (e) => {
  if (e.target.id === "account-ledger-modal") closeAccountLedger();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("account-ledger-modal").style.display === "flex") closeAccountLedger();
});

// The period inputs default to the same window the API does when asked for
// nothing (year to date), so what's shown in the form always matches what's
// actually on screen rather than sitting blank over a defaulted report.
function defaultStatementPeriod() {
  const today = new Date().toISOString().slice(0, 10);
  return { from: `${new Date().getUTCFullYear()}-01-01`, to: today };
}

function periodQuery(fromId, toId) {
  const period = defaultStatementPeriod();
  const fromEl = document.getElementById(fromId);
  const toEl = document.getElementById(toId);
  if (!fromEl.value) fromEl.value = period.from;
  if (!toEl.value) toEl.value = period.to;
  return `from=${fromEl.value}&to=${toEl.value}`;
}

async function loadProfitAndLoss() {
  const query = periodQuery("pnl-from", "pnl-to");
  renderProfitAndLoss(await (await apiFetch(`/api/statements/profit-and-loss?${query}`)).json());
}

function renderProfitAndLoss(data) {
  const period = { from: data.from, to: data.to };
  document.getElementById("pnl-revenue-body").innerHTML = statementAccountRows(data.revenue.accounts, period);
  document.getElementById("pnl-revenue-total").textContent = fmtMoney(data.revenue.total);

  // The cost-of-revenue block only appears once something is actually
  // posted there. An org that doesn't separate cost of revenue would
  // otherwise get an empty table and a "gross profit" line repeating total
  // revenue, which is a subtotal that tells the reader nothing.
  const cogs = data.cost_of_revenue ?? { accounts: [], total: 0 };
  const hasCogs = cogs.accounts.length > 0;
  document.getElementById("pnl-cogs-section").hidden = !hasCogs;
  if (hasCogs) {
    document.getElementById("pnl-cogs-body").innerHTML = statementAccountRows(cogs.accounts, period);
    document.getElementById("pnl-cogs-total").textContent = fmtMoney(cogs.total);
    document.getElementById("pnl-gross-profit").textContent = fmtMoney(data.gross_profit);
  }

  document.getElementById("pnl-expenses-body").innerHTML = statementAccountRows(data.expenses.accounts, period);
  document.getElementById("pnl-expenses-total").textContent = fmtMoney(data.expenses.total);

  document.getElementById("pnl-operating-income").textContent = fmtMoney(data.operating_income);
  document.getElementById("pnl-tax").textContent = fmtMoney(data.income_tax_expense);

  const netIncomeEl = document.getElementById("pnl-net-income");
  netIncomeEl.textContent = fmtMoney(data.net_income);
  // A loss is the one number on this page worth calling out in color --
  // it's the whole reason someone opens a P&L.
  netIncomeEl.className = data.net_income < 0 ? "kpi-value kpi-sub-warning" : "kpi-value";
}

document.getElementById("pnl-period-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadProfitAndLoss();
});

// ---- Income tax provision ----
// See incomeTax.js. The rate is always the user's -- there is deliberately
// no default, because a plausible-looking default is exactly the kind of
// invented number this feature exists to avoid.

let taxAccounts = [];

async function loadIncomeTax() {
  const asOf = document.getElementById("tax-as-of");
  if (!asOf.value) asOf.value = new Date().toISOString().slice(0, 10);
  const payDate = document.getElementById("tax-pay-date");
  if (!payDate.value) payDate.value = new Date().toISOString().slice(0, 10);

  const data = await (await apiFetch("/api/accounts?active=true")).json();
  // Cash can leave a bank account or go onto a credit line, same rule the
  // equity tab uses. Income Taxes Payable is excluded by the API, and
  // excluded here too so it never appears as an option.
  taxAccounts = data.items.filter((a) => ["asset", "liability"].includes(a.type) && a.subtype !== "income_taxes_payable");
  document.getElementById("tax-pay-account").innerHTML = groupedAccountOptionsHtml(taxAccounts, null);
}

async function previewIncomeTax() {
  const asOf = document.getElementById("tax-as-of").value;
  const rate = document.getElementById("tax-rate").value;
  const el = document.getElementById("tax-preview");
  if (!asOf || rate === "") {
    el.textContent = "Enter a date and a rate.";
    return null;
  }

  const res = await apiFetch(`/api/income-tax/provision?as_of=${asOf}&rate_percent=${rate}`);
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    el.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return null;
  }

  el.textContent =
    `${parsed.fiscal_year}: ${fmtMoney(parsed.pre_tax_income)} pre-tax, so ${fmtMoney(parsed.provision)} at ${parsed.rate_percent}%. ` +
    (parsed.already_posted ? `${fmtMoney(parsed.already_posted)} already accrued, ` : "") +
    (parsed.to_post === 0 ? "nothing to post." : `${fmtMoney(parsed.to_post)} to post.`);
  document.getElementById("tax-payable").textContent = parsed.payable
    ? `${fmtMoney(parsed.payable)} accrued and unpaid as of ${asOf}.`
    : `Nothing accrued and unpaid as of ${asOf}.`;
  return parsed;
}

// Previewed live rather than behind a button: the whole point is to see
// what a rate produces before committing to it, and a button between the
// hint and the submit was both an extra step and a control crowding the
// footer's right edge, where the floating assistant widget sits.
document.getElementById("tax-rate").addEventListener("change", previewIncomeTax);
document.getElementById("tax-as-of").addEventListener("change", previewIncomeTax);

document.getElementById("tax-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("tax-status");
  const res = await apiFetch("/api/income-tax/provision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      as_of: document.getElementById("tax-as-of").value,
      rate_percent: Number(document.getElementById("tax-rate").value),
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = parsed.journal_entry_id
    ? `Accrued ${fmtMoney(parsed.to_post)} for ${parsed.fiscal_year}.`
    : `Nothing to post -- ${parsed.fiscal_year} is already accrued at that rate.`;
  loadProfitAndLoss();
  previewIncomeTax();
});

document.getElementById("tax-pay-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("tax-pay-status");
  const res = await apiFetch("/api/income-tax/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Number(document.getElementById("tax-pay-amount").value) || 0,
      payment_date: document.getElementById("tax-pay-date").value,
      cash_account_id: document.getElementById("tax-pay-account").value,
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Paid ${fmtMoney(parsed.amount)}. ${fmtMoney(parsed.payable)} still accrued overall.`;
  document.getElementById("tax-pay-amount").value = "";
  loadProfitAndLoss();
  previewIncomeTax();
});

async function loadBalanceSheet() {
  const asOfEl = document.getElementById("bs-as-of");
  if (!asOfEl.value) asOfEl.value = new Date().toISOString().slice(0, 10);
  renderBalanceSheet(await (await apiFetch(`/api/statements/balance-sheet?as_of=${asOfEl.value}`)).json());
}

function renderBalanceSheet(data) {
  const period = { to: data.as_of };
  document.getElementById("bs-assets-body").innerHTML = statementAccountRows(data.assets.accounts, period);
  document.getElementById("bs-assets-total").textContent = fmtMoney(data.assets.total);
  document.getElementById("bs-liabilities-body").innerHTML = statementAccountRows(data.liabilities.accounts, period);
  document.getElementById("bs-liabilities-total").textContent = fmtMoney(data.liabilities.total);

  // Both earnings figures are appended as their own rows rather than being
  // folded into the equity total silently -- see financialStatements.js on
  // why they're derived instead of posted. Retained earnings is settled
  // history (prior fiscal years); current-year earnings is the year in
  // progress and reconciles to a P&L run over the same window.
  const equityRows = statementAccountRows(data.equity.accounts, period).replace(
    /<tr><td colspan="3" class="table-empty-row">.*?<\/tr>/,
    ""
  );
  const fy = data.fiscal_year;
  document.getElementById("bs-equity-body").innerHTML =
    equityRows +
    `<tr><td></td><td><em>Retained earnings</em><br /><span class="hint">Prior fiscal years, through ${fy.prior_years_through}</span></td><td>${fmtMoney(
      data.equity.retained_earnings
    )}</td></tr>` +
    `<tr><td></td><td><em>Current year earnings</em><br /><span class="hint">${fy.label}, ${fy.start} to ${fy.end}</span></td><td>${fmtMoney(
      data.equity.current_year_earnings
    )}</td></tr>`;
  document.getElementById("bs-equity-total").textContent = fmtMoney(data.equity.total);
  document.getElementById("bs-total-liab-equity").textContent = fmtMoney(data.total_liabilities_and_equity);

  const banner = document.getElementById("bs-banner");
  banner.textContent = data.balanced
    ? "Balanced -- assets equal liabilities plus equity."
    : "Not balanced -- this shouldn't happen; please contact support.";
  banner.className = data.balanced ? "hint" : "hint kpi-sub-warning";
}

document.getElementById("bs-period-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadBalanceSheet();
});

async function loadCashFlow() {
  const query = periodQuery("cf-from", "cf-to");
  renderCashFlow(await (await apiFetch(`/api/statements/cash-flow?${query}`)).json());
}

const CASH_FLOW_ROWS = [
  ["operating", "Operating activities", "Cash moved against revenue and expense accounts -- the core business."],
  ["investing", "Investing activities", "Cash moved against other assets -- equipment, deposits, and the like."],
  ["financing", "Financing activities", "Cash moved against equity or debt -- contributions, draws, loans."],
];

function renderCashFlow(data) {
  document.getElementById("cash-flow-body").innerHTML = CASH_FLOW_ROWS.map(
    ([key, label, hint]) => `
    <tr>
      <td>${label}<br /><span class="hint">${hint}</span></td>
      <td>${fmtMoney(data[key])}</td>
    </tr>
  `
  ).join("");
  document.getElementById("cf-net-change").textContent = fmtMoney(data.net_change_in_cash);

  const banner = document.getElementById("cf-banner");
  banner.textContent = data.reconciled
    ? "Reconciled -- the activity above accounts for every dollar of cash movement."
    : "Not reconciled -- this shouldn't happen; please contact support.";
  banner.className = data.reconciled ? "hint" : "hint kpi-sub-warning";
}

document.getElementById("cf-period-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadCashFlow();
});

// ---- Budget vs actual ----
// A revenue/expense plan for the fiscal year, compared against what the
// ledger actually shows -- see budget.js for the accounting. budgetId
// tracks whichever budget the report last resolved to (the current
// fiscal year, unless the year field is filled in), so the "set an
// account's budget" form knows which budget to post against without
// re-deriving it.

let budgetId = null;
let budgetAccounts = [];

async function loadBudget() {
  const yearEl = document.getElementById("budget-fiscal-year");
  const throughEl = document.getElementById("budget-through-month");
  const params = new URLSearchParams();
  if (yearEl.value) params.set("fiscal_year_end_year", yearEl.value);
  if (throughEl.value) params.set("through_month", throughEl.value);

  const [report, accountsData] = await Promise.all([
    apiFetch(`/api/budget?${params}`).then((r) => r.json()),
    apiFetch("/api/accounts?active=true").then((r) => r.json()),
  ]);

  budgetAccounts = accountsData.items.filter((a) => a.type === "revenue" || a.type === "expense");
  document.getElementById("budget-set-account").innerHTML = groupedAccountOptionsHtml(budgetAccounts, null);

  renderBudget(report);
}

function renderBudget(data) {
  budgetId = data.budget_id;
  const yearEl = document.getElementById("budget-fiscal-year");
  if (!yearEl.value) yearEl.value = data.fiscal_year_end.slice(0, 4);

  document.getElementById("budget-summary").textContent =
    `${data.fiscal_year_label} (${data.fiscal_year_start} to ${data.fiscal_year_end})${data.through_month ? `, through ${data.through_month}` : ""}: ` +
    `budgeted net income ${fmtMoney(data.totals.budget_net_income)}, actual ${fmtMoney(data.totals.actual_net_income)}.`;

  document.getElementById("budget-create-panel").hidden = data.has_budget;
  document.getElementById("budget-set-panel").hidden = !data.has_budget;

  const body = document.getElementById("budget-body");
  if (!data.rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="table-empty-row">No budget lines or activity yet for this fiscal year.</td></tr>`;
  } else {
    body.innerHTML = data.rows
      .map(
        (r) => `
      <tr>
        <td>${escapeHtml(r.account_name)}</td>
        <td>${fmtMoney(r.budget)}</td>
        <td>${fmtMoney(r.actual)}</td>
        <td class="${r.favorable === true ? "variance-favorable" : r.favorable === false ? "variance-unfavorable" : ""}">${fmtMoney(r.variance)}</td>
        <td>${r.variance_pct === null ? "—" : `${r.variance_pct}%`}</td>
        <td>${r.budget !== 0 ? `<button type="button" class="budget-remove-btn linklike" data-account-id="${r.account_id}">Remove</button>` : ""}</td>
      </tr>
    `
      )
      .join("");
  }
  document.getElementById("budget-totals").innerHTML = `
    <th>Total</th>
    <th>${fmtMoney(data.totals.budget_revenue - data.totals.budget_expense)}</th>
    <th>${fmtMoney(data.totals.actual_revenue - data.totals.actual_expense)}</th>
    <th colspan="3"></th>
  `;

  body.querySelectorAll(".budget-remove-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Remove this account's budget?", "Its actual activity keeps showing on the report -- this only clears the plan.", {
        confirmLabel: "Remove",
        danger: true,
      });
      if (!confirmed) return;
      const res = await apiFetch(`/api/budget/${budgetId}/accounts/${btn.dataset.accountId}`, { method: "DELETE" });
      const parsed = await res.json().catch(() => ({}));
      if (res.ok) renderBudget(parsed);
    })
  );
}

document.getElementById("budget-period-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadBudget();
});

document.getElementById("budget-create-btn").addEventListener("click", async () => {
  const yearEl = document.getElementById("budget-fiscal-year");
  const res = await apiFetch("/api/budget", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fiscal_year_end_year: Number(yearEl.value) }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (res.ok) renderBudget(parsed);
});

document.getElementById("budget-set-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("budget-set-status");
  const res = await apiFetch(`/api/budget/${budgetId}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account_id: document.getElementById("budget-set-account").value,
      annual_amount: Number(document.getElementById("budget-set-amount").value) || 0,
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = "";
  document.getElementById("budget-set-amount").value = "";
  renderBudget(parsed);
});

// ---- Receivables (customers, customer invoices, AR aging) ----
// The AR side of the ledger -- see accountsReceivable.js on the backend.
// Money coming in, as opposed to the Documents tabs' AP pipeline.

async function loadCustomers() {
  await cachedLoad("__customers__", async () => (await apiFetch("/api/customers")).json(), renderCustomers);
}

function renderCustomers(data) {
  const body = document.getElementById("customers-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="6" class="table-empty-row">No customers yet -- add one above to start invoicing.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (c) => `
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.email || "—")}</td>
      <td>Net ${c.payment_terms_days}</td>
      <td><button type="button" class="customer-tax-exempt-btn linklike" data-customer-id="${c.id}" data-tax-exempt="${c.tax_exempt}">${
        c.tax_exempt ? "Exempt" : "Taxable"
      }</button></td>
      <td>${c.active ? "Active" : "Inactive"}</td>
      <td>
        <button type="button" class="customer-statement-btn linklike" data-customer-id="${c.id}" data-customer-name="${escapeHtml(c.name)}">Statement</button>
        ${c.active ? `<button type="button" class="customer-deactivate-btn" data-customer-id="${c.id}">Deactivate</button>` : ""}
      </td>
    </tr>
  `
    )
    .join("");
  body.querySelectorAll(".customer-statement-btn").forEach((btn) => {
    btn.addEventListener("click", () => openStatementModal(btn.dataset.customerId, btn.dataset.customerName));
  });
  body.querySelectorAll(".customer-deactivate-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Deactivate this customer?", "Their past invoices stay exactly as they are; you just won't be able to bill them again.", {
        confirmLabel: "Deactivate",
        danger: true,
      });
      if (!confirmed) return;
      await apiFetch(`/api/customers/${btn.dataset.customerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      invalidateCache("__customers__");
      loadCustomers();
    });
  });
  body.querySelectorAll(".customer-tax-exempt-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await apiFetch(`/api/customers/${btn.dataset.customerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tax_exempt: btn.dataset.taxExempt !== "true" }),
      });
      invalidateCache("__customers__");
      invalidateCache("__ci_form_data__");
      loadCustomers();
    });
  });
}

document.getElementById("customer-create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("customer-create-status");
  try {
    const res = await apiFetch("/api/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("customer-create-name").value,
        email: document.getElementById("customer-create-email").value,
        payment_terms_days: Number(document.getElementById("customer-create-terms").value) || 30,
        tax_exempt: document.getElementById("customer-create-tax-exempt").checked,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      statusEl.textContent = body.detail || "Something went wrong.";
      return;
    }
    statusEl.textContent = "";
    e.target.reset();
    document.getElementById("customer-create-terms").value = "30";
    invalidateCache("__customers__");
    loadCustomers();
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

// ---- Statements (customers and vendors) ----
// A customer's or vendor's own AR/AP activity with a running balance --
// see computeCustomerStatement (accountsReceivable.js) and
// computeVendorStatement (accountsPayable.js). Rendered as a print
// window, same pattern printWrittenCheck uses for a check. One modal
// serves both; `statementModalKind` picks the endpoint and print labels.

let statementModalId = null;
let statementModalKind = "customer";

function monthToDateRange() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}

function openStatementModal(id, name, kind = "customer") {
  statementModalId = id;
  statementModalKind = kind;
  document.getElementById("customer-statement-modal-title").textContent = `Statement for ${name}`;
  const { from, to } = monthToDateRange();
  document.getElementById("customer-statement-modal-from").value = from;
  document.getElementById("customer-statement-modal-to").value = to;
  document.getElementById("customer-statement-modal").style.display = "flex";
}

document.getElementById("customer-statement-modal-cancel").addEventListener("click", () => {
  document.getElementById("customer-statement-modal").style.display = "none";
});

document.getElementById("customer-statement-modal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const from = document.getElementById("customer-statement-modal-from").value;
  const to = document.getElementById("customer-statement-modal-to").value;
  const path = statementModalKind === "vendor" ? "vendors" : "customers";
  const res = await apiFetch(`/api/${path}/${statementModalId}/statement?from=${from}&to=${to}`);
  const statement = await res.json().catch(() => ({}));
  if (!res.ok) {
    await alertDialog("Couldn't load that statement", statement.detail || "Something went wrong.");
    return;
  }
  document.getElementById("customer-statement-modal").style.display = "none";
  printStatement(statement, statementModalKind);
});

function printStatement(statement, kind) {
  const win = window.open("", "_blank", "width=800,height=900");
  if (!win) return;
  const name = kind === "vendor" ? statement.vendor_name : statement.customer_name;
  const rows = statement.activity
    .map(
      (a) => `
    <tr>
      <td>${a.date}</td>
      <td>${escapeHtml(a.description)}</td>
      <td class="amt">${a.amount < 0 ? `(${fmtMoney(Math.abs(a.amount))})` : fmtMoney(a.amount)}</td>
      <td class="amt">${fmtMoney(a.balance)}</td>
    </tr>
  `
    )
    .join("");
  win.document.write(`
    <!doctype html>
    <html>
    <head>
      <title>Statement -- ${escapeHtml(name)}</title>
      <style>
        body { font-family: Georgia, serif; padding: 2rem; color: #101a33; }
        h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
        .period { color: #555; margin-bottom: 1.5rem; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; text-align: left; font-size: 0.9rem; }
        th.amt, td.amt { text-align: right; }
        .opening td, .closing td { font-weight: bold; border-top: 2px solid #333; }
      </style>
    </head>
    <body onload="window.print()">
      <h1>Statement -- ${escapeHtml(name)}</h1>
      <div class="period">${statement.from || "Inception"} to ${statement.to}</div>
      <table>
        <thead><tr><th>Date</th><th>Description</th><th class="amt">Amount</th><th class="amt">Balance</th></tr></thead>
        <tbody>
          <tr class="opening"><td colspan="3">Opening balance</td><td class="amt">${fmtMoney(statement.opening_balance)}</td></tr>
          ${rows}
          <tr class="closing"><td colspan="3">Closing balance</td><td class="amt">${fmtMoney(statement.closing_balance)}</td></tr>
        </tbody>
      </table>
    </body>
    </html>
  `);
  win.document.close();
}

// The new-invoice form needs both active customers and revenue accounts to
// populate its dropdowns -- fetched together so the form is never half
// usable.
let ciCustomers = [];
let ciRevenueAccounts = [];
let ciAllAccounts = [];
let ciSalesTaxRatePercent = null;

async function loadCustomerInvoiceFormData() {
  await cachedLoad(
    "__ci_form_data__",
    async () => {
      const [customers, accounts, orgSettings] = await Promise.all([
        apiFetch("/api/customers?active=true").then((r) => r.json()),
        apiFetch("/api/accounts?active=true").then((r) => r.json()),
        apiFetch("/api/org/settings").then((r) => r.json()),
      ]);
      return { customers: customers.items, accounts: accounts.items, salesTaxRatePercent: orgSettings.sales_tax_rate_percent };
    },
    ({ customers, accounts, salesTaxRatePercent }) => {
      ciCustomers = customers;
      ciAllAccounts = accounts;
      ciSalesTaxRatePercent = salesTaxRatePercent;
      // Invoice lines can only bill revenue; payments can only land in an
      // asset account. Both come off this one fetch.
      ciRevenueAccounts = accounts.filter((a) => a.type === "revenue");
      const customerOptionsHtml = customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
      document.getElementById("ci-customer").innerHTML = customerOptionsHtml;
      document.getElementById("ri-customer").innerHTML = customerOptionsHtml;
      document.getElementById("cm-customer").innerHTML = customerOptionsHtml;
      if (!document.getElementById("ci-lines-body").children.length) addCustomerInvoiceLineRow();
      if (!document.getElementById("ri-lines-body").children.length) addRecurringInvoiceLineRow();
      if (!document.getElementById("cm-lines-body").children.length) addCreditMemoLineRow();
    }
  );
}

function revenueOptionsHtml() {
  return groupedAccountOptionsHtml(ciRevenueAccounts, null);
}

// Estimate only -- the server recomputes tax from scratch at creation time
// (routes/receivables.js), which is the number that actually gets posted.
// This just gives a preview so the rate/exemption aren't a surprise after
// clicking Create draft.
function updateCustomerInvoiceTotal() {
  const rows = [...document.getElementById("ci-lines-body").querySelectorAll("tr")];
  const subtotal = rows.reduce((sum, row) => {
    const qty = Number(row.querySelector(".ci-qty").value) || 0;
    const price = Number(row.querySelector(".ci-price").value) || 0;
    return sum + qty * price;
  }, 0);
  const selectedCustomer = ciCustomers.find((c) => c.id === document.getElementById("ci-customer").value);
  const taxExempt = selectedCustomer?.tax_exempt;
  const taxableSubtotal = taxExempt
    ? 0
    : rows.reduce((sum, row) => {
        if (!row.querySelector(".ci-taxable").checked) return sum;
        const qty = Number(row.querySelector(".ci-qty").value) || 0;
        const price = Number(row.querySelector(".ci-price").value) || 0;
        return sum + qty * price;
      }, 0);
  const tax = ciSalesTaxRatePercent ? Math.round(taxableSubtotal * ciSalesTaxRatePercent) / 100 : 0;
  document.getElementById("ci-total-indicator").textContent = taxExempt
    ? `Subtotal: ${fmtMoney(subtotal)}. Tax-exempt customer -- no tax. Total: ${fmtMoney(subtotal)}.`
    : tax > 0
      ? `Subtotal: ${fmtMoney(subtotal)}. Tax (${ciSalesTaxRatePercent}%): ${fmtMoney(tax)}. Total: ${fmtMoney(subtotal + tax)}.`
      : `Invoice total: ${fmtMoney(subtotal)}`;
}

function addCustomerInvoiceLineRow() {
  const body = document.getElementById("ci-lines-body");
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><select class="ci-account" required>${revenueOptionsHtml()}</select></td>
    <td><input type="text" class="ci-desc" maxlength="512" placeholder="What are you billing for?" /></td>
    <td><input type="number" class="ci-qty" step="0.01" min="0" value="1" /></td>
    <td><input type="number" class="ci-price" step="0.01" min="0" placeholder="0.00" /></td>
    <td><input type="checkbox" class="ci-taxable" checked /></td>
    <td><input type="date" class="ci-service-start" /></td>
    <td><input type="date" class="ci-service-end" /></td>
    <td><button type="button" class="ci-remove-line linklike">Remove</button></td>
  `;
  body.appendChild(row);
  row.querySelectorAll(".ci-qty, .ci-price, .ci-taxable").forEach((i) => i.addEventListener("input", updateCustomerInvoiceTotal));
  row.querySelector(".ci-remove-line").addEventListener("click", () => {
    row.remove();
    updateCustomerInvoiceTotal();
  });
  updateCustomerInvoiceTotal();
}

document.getElementById("ci-add-line").addEventListener("click", addCustomerInvoiceLineRow);
document.getElementById("ci-customer").addEventListener("change", updateCustomerInvoiceTotal);

document.getElementById("customer-invoice-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("customer-invoice-status");
  const rows = [...document.getElementById("ci-lines-body").querySelectorAll("tr")];
  try {
    const res = await apiFetch("/api/customer-invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: document.getElementById("ci-customer").value,
        issue_date: document.getElementById("ci-issue-date").value,
        memo: document.getElementById("ci-memo").value,
        lines: rows.map((row) => {
          const start = row.querySelector(".ci-service-start").value;
          const end = row.querySelector(".ci-service-end").value;
          return {
            revenue_account_id: row.querySelector(".ci-account").value,
            description: row.querySelector(".ci-desc").value,
            quantity: Number(row.querySelector(".ci-qty").value) || 0,
            unit_price: Number(row.querySelector(".ci-price").value) || 0,
            taxable: row.querySelector(".ci-taxable").checked,
            // Omitted entirely unless both are filled -- the API rejects a
            // half-specified period rather than guessing at it, and an
            // empty string isn't a date.
            ...(start && end ? { service_start_date: start, service_end_date: end } : {}),
          };
        }),
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      statusEl.textContent = body.detail?.[0]?.message || body.detail || "Something went wrong.";
      return;
    }
    statusEl.textContent = `Created ${body.invoice_number} as a draft (${fmtMoney(body.total)}${
      body.tax > 0 ? `, incl. ${fmtMoney(body.tax)} tax` : ""
    }). Send it to put it on the books.`;
    document.getElementById("ci-lines-body").innerHTML = "";
    addCustomerInvoiceLineRow();
    document.getElementById("ci-memo").value = "";
    invalidateCache("__customer_invoices__");
    loadCustomerInvoices();
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

async function loadCustomerInvoices() {
  await cachedLoad("__customer_invoices__", async () => (await apiFetch("/api/customer-invoices")).json(), renderCustomerInvoices);
}

function renderCustomerInvoices(data) {
  const body = document.getElementById("customer-invoices-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="8" class="table-empty-row">No invoices yet.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (inv) => `
    <tr>
      <td>${escapeHtml(inv.invoice_number)}</td>
      <td>${escapeHtml(inv.customer_name || "—")}</td>
      <td>${inv.issue_date}</td>
      <td>${inv.due_date}</td>
      <td>${fmtMoney(inv.total)}</td>
      <td>${fmtMoney(inv.amount_outstanding)}</td>
      <td>${inv.status}</td>
      <td>
        ${inv.status === "draft" ? `<button type="button" class="ci-send-btn" data-id="${inv.id}">Send</button>` : ""}
        ${inv.status === "sent" ? `<button type="button" class="ci-pay-btn" data-id="${inv.id}" data-outstanding="${inv.amount_outstanding}">Record payment</button>` : ""}
        ${["sent", "paid"].includes(inv.status) && inv.amount_outstanding > 0 ? `<button type="button" class="ci-write-off-btn linklike" data-id="${inv.id}" data-outstanding="${inv.amount_outstanding}">Write off</button>` : ""}
        ${["draft", "sent"].includes(inv.status) ? `<button type="button" class="ci-void-btn linklike" data-id="${inv.id}">Void</button>` : ""}
      </td>
    </tr>
  `
    )
    .join("");

  async function act(id, path, body) {
    const res = await apiFetch(`/api/customer-invoices/${id}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const parsed = await res.json().catch(() => ({}));
    if (!res.ok) {
      await alertDialog("Couldn't complete that", parsed.detail || "Something went wrong.");
      return false;
    }
    invalidateCache("__customer_invoices__");
    invalidateCache("__ar_aging__");
    loadCustomerInvoices();
    return true;
  }

  body.querySelectorAll(".ci-send-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Send this invoice?", "It becomes a receivable and posts to your books. Sent invoices can't be edited.", {
        confirmLabel: "Send",
      });
      if (confirmed) await act(btn.dataset.id, "send");
    })
  );

  body.querySelectorAll(".ci-void-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Void this invoice?", "If it was already sent, this posts a reversing entry. The invoice stays on record either way.", {
        confirmLabel: "Void",
        danger: true,
      });
      if (confirmed) await act(btn.dataset.id, "void");
    })
  );

  body.querySelectorAll(".ci-pay-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const payment = await paymentDialog(Number(btn.dataset.outstanding));
      if (!payment) return;
      await act(btn.dataset.id, "payments", {
        amount: payment.amount,
        payment_date: payment.payment_date,
        deposit_account_id: payment.account_id,
      });
    })
  );

  body.querySelectorAll(".ci-write-off-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const writeOff = await writeOffDialog(Number(btn.dataset.outstanding));
      if (!writeOff) return;
      await act(btn.dataset.id, "write-off", {
        amount: writeOff.amount,
        write_off_date: writeOff.write_off_date,
        memo: writeOff.memo,
      });
    })
  );
}

let writeOffModalResolve = null;

async function writeOffDialog(outstandingDollars) {
  document.getElementById("write-off-modal-message").textContent =
    `Outstanding balance is ${fmtMoney(outstandingDollars)}. This posts to Bad Debt Expense -- the original sale stays booked.`;
  document.getElementById("write-off-modal-amount").value = outstandingDollars.toFixed(2);
  document.getElementById("write-off-modal-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("write-off-modal-memo").value = "";
  const errorEl = document.getElementById("write-off-modal-error");
  errorEl.textContent = "";
  errorEl.style.display = "none";
  document.getElementById("write-off-modal").style.display = "flex";
  document.getElementById("write-off-modal-amount").focus();

  return new Promise((resolve) => {
    writeOffModalResolve = resolve;
  });
}

function closeWriteOffModal(result) {
  document.getElementById("write-off-modal").style.display = "none";
  if (writeOffModalResolve) {
    writeOffModalResolve(result);
    writeOffModalResolve = null;
  }
}

document.getElementById("write-off-modal-cancel").addEventListener("click", () => closeWriteOffModal(null));

document.getElementById("write-off-modal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById("write-off-modal-amount").value);
  const errorEl = document.getElementById("write-off-modal-error");
  if (!(amount > 0)) {
    errorEl.textContent = "Enter an amount greater than zero.";
    errorEl.style.display = "";
    return;
  }
  closeWriteOffModal({
    amount,
    write_off_date: document.getElementById("write-off-modal-date").value,
    memo: document.getElementById("write-off-modal-memo").value,
  });
});

// ---- Credit memos ----

function creditMemoAccountOptions() {
  return groupedAccountOptionsHtml(ciRevenueAccounts, null);
}

// Same estimate-only reasoning as updateCustomerInvoiceTotal -- the server
// recomputes tax from scratch on issue.
function updateCreditMemoTotal() {
  const rows = [...document.getElementById("cm-lines-body").querySelectorAll("tr")];
  const subtotal = rows.reduce((sum, row) => sum + (Number(row.querySelector(".cm-amount").value) || 0), 0);
  const selectedCustomer = ciCustomers.find((c) => c.id === document.getElementById("cm-customer").value);
  const taxExempt = selectedCustomer?.tax_exempt;
  const taxableSubtotal = taxExempt
    ? 0
    : rows.reduce(
        (sum, row) => (row.querySelector(".cm-taxable").checked ? sum + (Number(row.querySelector(".cm-amount").value) || 0) : sum),
        0
      );
  const tax = ciSalesTaxRatePercent ? Math.round(taxableSubtotal * ciSalesTaxRatePercent) / 100 : 0;
  document.getElementById("cm-total-indicator").textContent = taxExempt
    ? `Subtotal: ${fmtMoney(subtotal)}. Tax-exempt customer -- no tax. Total: ${fmtMoney(subtotal)}.`
    : tax > 0
      ? `Subtotal: ${fmtMoney(subtotal)}. Tax (${ciSalesTaxRatePercent}%): ${fmtMoney(tax)}. Total: ${fmtMoney(subtotal + tax)}.`
      : `Credit total: ${fmtMoney(subtotal)}`;
}

function addCreditMemoLineRow() {
  const body = document.getElementById("cm-lines-body");
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><select class="cm-account" required>${creditMemoAccountOptions()}</select></td>
    <td><input type="text" class="cm-desc" maxlength="512" placeholder="What's being credited?" /></td>
    <td><input type="number" class="cm-amount" step="0.01" min="0" placeholder="0.00" /></td>
    <td><input type="checkbox" class="cm-taxable" checked /></td>
    <td><button type="button" class="cm-remove-line linklike">Remove</button></td>
  `;
  body.appendChild(row);
  row.querySelectorAll(".cm-amount, .cm-taxable").forEach((i) => i.addEventListener("input", updateCreditMemoTotal));
  row.querySelector(".cm-remove-line").addEventListener("click", () => {
    row.remove();
    updateCreditMemoTotal();
  });
  updateCreditMemoTotal();
}

document.getElementById("cm-add-line").addEventListener("click", addCreditMemoLineRow);
document.getElementById("cm-customer").addEventListener("change", updateCreditMemoTotal);

document.getElementById("credit-memo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("credit-memo-status");
  const rows = [...document.getElementById("cm-lines-body").querySelectorAll("tr")];
  try {
    const res = await apiFetch("/api/customer-credit-memos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: document.getElementById("cm-customer").value,
        issue_date: document.getElementById("cm-issue-date").value,
        memo: document.getElementById("cm-memo").value,
        lines: rows.map((row) => ({
          revenue_account_id: row.querySelector(".cm-account").value,
          description: row.querySelector(".cm-desc").value,
          amount: Number(row.querySelector(".cm-amount").value) || 0,
          taxable: row.querySelector(".cm-taxable").checked,
        })),
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      statusEl.textContent = body.detail?.[0]?.message || body.detail || "Something went wrong.";
      return;
    }
    statusEl.textContent = `Issued ${body.credit_number} for ${fmtMoney(body.total)}${
      body.tax > 0 ? ` (incl. ${fmtMoney(body.tax)} tax)` : ""
    }.`;
    document.getElementById("cm-lines-body").innerHTML = "";
    addCreditMemoLineRow();
    document.getElementById("cm-memo").value = "";
    invalidateCache("__credit_memos__");
    invalidateCache("__customer_invoices__");
    invalidateCache("__ar_aging__");
    loadCreditMemos();
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

async function loadCreditMemos() {
  await cachedLoad("__credit_memos__", async () => (await apiFetch("/api/customer-credit-memos")).json(), renderCreditMemos);
}

let applyCreditModalResolve = null;

function renderCreditMemos(data) {
  const body = document.getElementById("credit-memos-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="7" class="table-empty-row">No credit memos yet.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (m) => `
    <tr>
      <td>${escapeHtml(m.credit_number)}</td>
      <td>${escapeHtml(m.customer_name || "—")}</td>
      <td>${m.issue_date}</td>
      <td>${fmtMoney(m.total)}</td>
      <td>${fmtMoney(m.unapplied)}</td>
      <td>${m.status}</td>
      <td>
        ${
          m.status === "issued" && m.unapplied > 0
            ? `<button type="button" class="cm-apply-btn" data-id="${m.id}" data-customer-id="${m.customer_id}" data-unapplied="${m.unapplied}">Apply to invoice</button>`
            : ""
        }
        ${m.status === "issued" ? `<button type="button" class="cm-void-btn linklike" data-id="${m.id}">Void</button>` : ""}
      </td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".cm-void-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog(
        "Void this credit memo?",
        "This posts a reversing entry. The credit memo stays on record either way.",
        { confirmLabel: "Void", danger: true }
      );
      if (!confirmed) return;
      const res = await apiFetch(`/api/customer-credit-memos/${btn.dataset.id}/void`, { method: "POST" });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) {
        await alertDialog("Couldn't void that", parsed.detail || "Something went wrong.");
        return;
      }
      invalidateCache("__credit_memos__");
      loadCreditMemos();
    })
  );

  body.querySelectorAll(".cm-apply-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const result = await applyCreditDialog(btn.dataset.customerId, Number(btn.dataset.unapplied));
      if (!result) return;
      const res = await apiFetch(`/api/customer-credit-memos/${btn.dataset.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) {
        await alertDialog("Couldn't apply that credit", parsed.detail || "Something went wrong.");
        return;
      }
      invalidateCache("__credit_memos__");
      invalidateCache("__customer_invoices__");
      invalidateCache("__ar_aging__");
      loadCreditMemos();
      loadCustomerInvoices();
    })
  );
}

// Which of a customer's invoices still have a balance a credit could
// offset. Fetched fresh rather than read off the cached list -- the
// outstanding figure has to be current, since over-applying is refused
// server-side but reads as a confusing error if the dropdown was already
// showing a stale amount.
async function openInvoicesForCustomer(customerId) {
  const data = await (await apiFetch(`/api/customer-invoices?customer_id=${customerId}&status=sent`)).json();
  return data.items.filter((inv) => inv.amount_outstanding > 0);
}

async function applyCreditDialog(customerId, unappliedDollars) {
  const invoices = await openInvoicesForCustomer(customerId);
  if (!invoices.length) {
    await alertDialog("No open invoices", "This customer has no open invoices to apply a credit to.");
    return null;
  }

  document.getElementById("apply-credit-modal-message").textContent = `${fmtMoney(unappliedDollars)} unapplied on this credit memo.`;
  document.getElementById("apply-credit-modal-invoice").innerHTML = invoices
    .map(
      (inv) =>
        `<option value="${inv.id}" data-outstanding="${inv.amount_outstanding}">${escapeHtml(inv.invoice_number)} -- ${fmtMoney(inv.amount_outstanding)} outstanding</option>`
    )
    .join("");
  const amountEl = document.getElementById("apply-credit-modal-amount");
  const invoiceEl = document.getElementById("apply-credit-modal-invoice");
  const setDefaultAmount = () => {
    const outstanding = Number(invoiceEl.selectedOptions[0]?.dataset.outstanding || 0);
    amountEl.value = Math.min(unappliedDollars, outstanding).toFixed(2);
  };
  invoiceEl.onchange = setDefaultAmount;
  setDefaultAmount();
  document.getElementById("apply-credit-modal-date").value = new Date().toISOString().slice(0, 10);
  const errorEl = document.getElementById("apply-credit-modal-error");
  errorEl.textContent = "";
  errorEl.style.display = "none";
  document.getElementById("apply-credit-modal").style.display = "flex";
  amountEl.focus();

  return new Promise((resolve) => {
    applyCreditModalResolve = resolve;
  });
}

function closeApplyCreditModal(result) {
  document.getElementById("apply-credit-modal").style.display = "none";
  if (applyCreditModalResolve) {
    applyCreditModalResolve(result);
    applyCreditModalResolve = null;
  }
}

document.getElementById("apply-credit-modal-cancel").addEventListener("click", () => closeApplyCreditModal(null));

document.getElementById("apply-credit-modal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById("apply-credit-modal-amount").value);
  const errorEl = document.getElementById("apply-credit-modal-error");
  if (!(amount > 0)) {
    errorEl.textContent = "Enter an amount greater than zero.";
    errorEl.style.display = "";
    return;
  }
  closeApplyCreditModal({
    invoice_id: document.getElementById("apply-credit-modal-invoice").value,
    amount,
    applied_date: document.getElementById("apply-credit-modal-date").value,
  });
});

function riAccountOptions() {
  return groupedAccountOptionsHtml(ciRevenueAccounts, null);
}

function updateRecurringInvoiceTotal() {
  const rows = [...document.getElementById("ri-lines-body").querySelectorAll("tr")];
  const total = rows.reduce((sum, row) => {
    const qty = Number(row.querySelector(".ri-qty").value) || 0;
    const price = Number(row.querySelector(".ri-price").value) || 0;
    return sum + qty * price;
  }, 0);
  document.getElementById("ri-total-indicator").textContent = `Each occurrence: ${fmtMoney(total)}`;
}

function addRecurringInvoiceLineRow() {
  const body = document.getElementById("ri-lines-body");
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><select class="ri-account" required>${riAccountOptions()}</select></td>
    <td><input type="text" class="ri-desc" maxlength="512" placeholder="What are you billing for?" /></td>
    <td><input type="number" class="ri-qty" step="0.01" min="0" value="1" /></td>
    <td><input type="number" class="ri-price" step="0.01" min="0" placeholder="0.00" /></td>
    <td><input type="checkbox" class="ri-taxable" checked /></td>
    <td><button type="button" class="ri-remove-line linklike">Remove</button></td>
  `;
  body.appendChild(row);
  row.querySelectorAll(".ri-qty, .ri-price").forEach((i) => i.addEventListener("input", updateRecurringInvoiceTotal));
  row.querySelector(".ri-remove-line").addEventListener("click", () => {
    row.remove();
    updateRecurringInvoiceTotal();
  });
  updateRecurringInvoiceTotal();
}

document.getElementById("ri-add-line").addEventListener("click", addRecurringInvoiceLineRow);

document.getElementById("recurring-invoice-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("recurring-invoice-status");
  const rows = [...document.getElementById("ri-lines-body").querySelectorAll("tr")];
  const endDate = document.getElementById("ri-end").value;

  const res = await apiFetch("/api/recurring-invoices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_id: document.getElementById("ri-customer").value,
      name: document.getElementById("ri-name").value,
      frequency: document.getElementById("ri-frequency").value,
      start_date: document.getElementById("ri-start").value,
      ...(endDate ? { end_date: endDate } : {}),
      auto_send: document.getElementById("ri-auto-send").checked,
      lines: rows.map((row) => ({
        revenue_account_id: row.querySelector(".ri-account").value,
        description: row.querySelector(".ri-desc").value,
        quantity: Number(row.querySelector(".ri-qty").value) || 0,
        unit_price: Number(row.querySelector(".ri-price").value) || 0,
        taxable: row.querySelector(".ri-taxable").checked,
      })),
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Saved "${parsed.name}".`;
  document.getElementById("ri-name").value = "";
  document.getElementById("ri-auto-send").checked = false;
  document.getElementById("ri-lines-body").innerHTML = "";
  addRecurringInvoiceLineRow();
  loadRecurringInvoices();
});

async function loadRecurringInvoices() {
  const data = await (await apiFetch("/api/recurring-invoices")).json();
  const body = document.getElementById("recurring-invoices-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="9" class="table-empty-row">No recurring invoices yet — add one above.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (t) => `
    <tr>
      <td>${escapeHtml(t.name)}</td>
      <td>${escapeHtml(t.customer_name || "—")}</td>
      <td>${t.frequency}</td>
      <td>${t.start_date}</td>
      <td>${t.last_issued_date || "—"}</td>
      <td>${t.next_due || "—"}</td>
      <td>
        <button type="button" class="ri-auto-send-btn linklike" data-id="${t.id}" data-auto-send="${t.auto_send}">${
          t.auto_send ? "On" : "Off"
        }</button>
      </td>
      <td>${t.active ? "Active" : "Paused"}</td>
      <td>
        <button type="button" class="ri-toggle-btn" data-id="${t.id}" data-active="${t.active}">${
          t.active ? "Pause" : "Resume"
        }</button>
        <button type="button" class="ri-delete-btn linklike" data-id="${t.id}">Delete</button>
      </td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".ri-toggle-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await apiFetch(`/api/recurring-invoices/${btn.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: btn.dataset.active !== "true" }),
      });
      loadRecurringInvoices();
    })
  );
  body.querySelectorAll(".ri-auto-send-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await apiFetch(`/api/recurring-invoices/${btn.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_send: btn.dataset.autoSend !== "true" }),
      });
      loadRecurringInvoices();
    })
  );
  body.querySelectorAll(".ri-delete-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Delete this recurring invoice?", "Invoices it already created stay — this only stops future ones.", {
        confirmLabel: "Delete",
        danger: true,
      });
      if (!confirmed) return;
      await apiFetch(`/api/recurring-invoices/${btn.dataset.id}`, { method: "DELETE" });
      loadRecurringInvoices();
    })
  );
}

function riAsOf() {
  const el = document.getElementById("ri-as-of");
  if (!el.value) el.value = new Date().toISOString().slice(0, 10);
  return el.value;
}

document.getElementById("ri-preview").addEventListener("click", async () => {
  const data = await (await apiFetch(`/api/recurring-invoices/pending?as_of=${riAsOf()}`)).json();
  const el = document.getElementById("recurring-invoice-run-status");
  el.textContent = data.occurrences
    ? `Would issue ${data.occurrences} invoice${data.occurrences === 1 ? "" : "s"}: ${data.items
        .map((i) => `${i.name} x${i.periods.length}${i.auto_send ? " (auto-sends)" : ""}`)
        .join(", ")}.`
    : "Nothing due through that date.";
});

document.getElementById("recurring-invoice-run-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const el = document.getElementById("recurring-invoice-run-status");
  const res = await apiFetch("/api/recurring-invoices/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ as_of: riAsOf() }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    await alertDialog("Couldn't run those invoices", parsed.detail || "Something went wrong.");
    return;
  }
  const sentCount = parsed.issued.filter((i) => i.sent).length;
  const bits = [`Issued ${parsed.issued.length} invoice${parsed.issued.length === 1 ? "" : "s"} (${fmtMoney(parsed.total)}).`];
  if (sentCount) bits.push(`${sentCount} auto-sent.`);
  const sendFailures = parsed.issued.filter((i) => i.send_error);
  if (sendFailures.length) {
    bits.push(
      `Created as drafts instead of sending: ${sendFailures.map((i) => `${i.invoice_number} (${i.send_error})`).join("; ")}`
    );
  }
  if (parsed.skipped.length) bits.push(`Skipped: ${parsed.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`);
  el.textContent = bits.join(" ");
  invalidateCache("__customer_invoices__");
  loadCustomerInvoices();
  loadRecurringInvoices();
});

// Where a customer payment can land. Asset accounts, minus Accounts
// Receivable itself -- depositing into AR posts Debit AR / Credit AR, which
// balances, passes every check the ledger makes, and does nothing at all.
// It has to be excluded here rather than left to the user to avoid, since
// nothing downstream would flag it.
function ciDepositAccounts() {
  return ciAllAccounts.filter((a) => a.type === "asset" && a.subtype !== "accounts_receivable");
}

// Resolves to the payment body to POST, or null if dismissed. Modeled on
// confirmDialog above -- same overlay, same promise shape -- but with a
// form, because a payment needs three answers and picking the deposit
// account for the user is a posting decision made behind their back.
let paymentModalResolve = null;

// Shared by both sides of the ledger: money coming in against a customer
// invoice, and money going out against a vendor bill. The only differences
// are the wording and which accounts are offered, so those are arguments
// rather than a second near-identical dialog.
async function paymentDialog(
  outstanding,
  {
    title = "Record a payment",
    dateLabel = "Date received",
    accountLabel = "Deposit into",
    accounts = null,
    emptyTitle = "No deposit account",
    emptyMessage = "Add an asset account for the bank you were paid into first.",
    // Only a bill payment can take an early-payment discount -- a customer
    // paying Rekono's org doesn't owe this org anything to discount.
    allowDiscount = false,
  } = {}
) {
  const options = accounts || ciDepositAccounts();
  if (!options.length) {
    await alertDialog(emptyTitle, emptyMessage);
    return null;
  }

  document.getElementById("payment-modal-title").textContent = title;
  document.getElementById("payment-modal-date-label").textContent = dateLabel;
  document.getElementById("payment-modal-account-label").textContent = accountLabel;
  document.getElementById("payment-modal-message").textContent = `Outstanding balance is ${fmtMoney(outstanding)}.`;
  document.getElementById("payment-modal-amount").value = outstanding.toFixed(2);
  document.getElementById("payment-modal-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("payment-modal-account").innerHTML = groupedAccountOptionsHtml(options, null);
  const discountRow = document.getElementById("payment-modal-discount-row");
  discountRow.hidden = !allowDiscount;
  document.getElementById("payment-modal-discount").value = "";
  const errorEl = document.getElementById("payment-modal-error");
  errorEl.textContent = "";
  errorEl.style.display = "none";
  document.getElementById("payment-modal").style.display = "flex";
  document.getElementById("payment-modal-amount").focus();

  return new Promise((resolve) => {
    paymentModalResolve = resolve;
  });
}

function closePaymentModal(result) {
  document.getElementById("payment-modal").style.display = "none";
  if (paymentModalResolve) {
    paymentModalResolve(result);
    paymentModalResolve = null;
  }
}

document.getElementById("payment-modal-cancel").addEventListener("click", () => closePaymentModal(null));

document.getElementById("payment-modal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById("payment-modal-amount").value);
  const errorEl = document.getElementById("payment-modal-error");
  if (!(amount > 0)) {
    errorEl.textContent = "Enter an amount greater than zero.";
    errorEl.style.display = "";
    return;
  }
  // Resolved with a neutral `account_id` -- the AR API calls it
  // deposit_account_id and the AP API calls it payment_account_id, so each
  // caller names it rather than the shared dialog picking a side.
  closePaymentModal({
    amount,
    payment_date: document.getElementById("payment-modal-date").value,
    account_id: document.getElementById("payment-modal-account").value,
    discount: Number(document.getElementById("payment-modal-discount").value) || 0,
  });
});

async function loadArAging() {
  const asOfEl = document.getElementById("ar-as-of");
  if (!asOfEl.value) asOfEl.value = new Date().toISOString().slice(0, 10);
  renderArAging(await (await apiFetch(`/api/reports/ar-aging?as_of=${asOfEl.value}`)).json());
}

// Shared by both aging reports -- AR and AP bucket identically.
const AGING_BUCKET_KEYS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"];

function renderArAging(data) {
  const body = document.getElementById("ar-aging-body");
  if (!data.customers.length) {
    body.innerHTML = `<tr><td colspan="7" class="table-empty-row">Nothing outstanding — every sent invoice is paid.</td></tr>`;
  } else {
    body.innerHTML = data.customers
      .map(
        (row) => `
      <tr>
        <td>${escapeHtml(row.customer_name)}</td>
        ${AGING_BUCKET_KEYS.map((k) => `<td>${row[k] ? fmtMoney(row[k]) : ""}</td>`).join("")}
        <td>${fmtMoney(row.total)}</td>
      </tr>
    `
      )
      .join("");
  }
  document.getElementById("ar-aging-totals").innerHTML =
    `<th>Total</th>${AGING_BUCKET_KEYS.map((k) => `<th>${fmtMoney(data.totals[k])}</th>`).join("")}<th>${fmtMoney(
      data.totals.total
    )}</th>`;
}

document.getElementById("ar-aging-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadArAging();
});

// ---- Sales tax ----

async function loadSalesTax() {
  const dateEl = document.getElementById("sales-tax-date");
  if (!dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);

  const [taxData, accountsData] = await Promise.all([
    apiFetch("/api/reports/sales-tax").then((r) => r.json()),
    apiFetch("/api/accounts?active=true").then((r) => r.json()),
  ]);

  document.getElementById("sales-tax-summary").textContent =
    taxData.rate_percent
      ? `Rate: ${taxData.rate_percent}%. ${fmtMoney(taxData.payable)} collected and not yet remitted.`
      : `No sales tax rate set (Settings > Accounting). ${fmtMoney(taxData.payable)} collected and not yet remitted.`;

  // Cash can leave a bank account or go onto a credit line, same rule the
  // income tax and equity tabs use.
  const cashAccounts = accountsData.items.filter((a) => a.type === "asset");
  document.getElementById("sales-tax-account").innerHTML = groupedAccountOptionsHtml(cashAccounts, null);
}

document.getElementById("sales-tax-remit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("sales-tax-remit-status");
  const res = await apiFetch("/api/sales-tax/remit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Number(document.getElementById("sales-tax-amount").value) || 0,
      payment_date: document.getElementById("sales-tax-date").value,
      cash_account_id: document.getElementById("sales-tax-account").value,
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Remitted ${fmtMoney(parsed.amount)}. ${fmtMoney(parsed.payable)} still collected and unremitted.`;
  document.getElementById("sales-tax-amount").value = "";
  loadSalesTax();
});

// ---- Revenue recognition ----
// Revenue billed up front but earned over time (see revenueRecognition.js)
// sits in Deferred Revenue until delivered. This tab runs the monthly
// release and shows what's still waiting.

function revPeriod() {
  const el = document.getElementById("rev-period");
  if (!el.value) el.value = new Date().toISOString().slice(0, 7);
  return el.value;
}

async function loadDeferredRevenue() {
  revPeriod();
  const data = await (await apiFetch("/api/reports/deferred-revenue")).json();
  const body = document.getElementById("revenue-waterfall-body");
  if (!data.periods.length) {
    body.innerHTML = `<tr><td colspan="2" class="table-empty-row">Nothing deferred — every invoiced line has been earned.</td></tr>`;
  } else {
    body.innerHTML = data.periods
      .map((p) => `<tr><td>${p.period_month}</td><td>${fmtMoney(p.amount)}</td></tr>`)
      .join("");
    if (data.beyond.periods > 0) {
      body.innerHTML += `<tr><td class="hint">+ ${data.beyond.periods} later period${
        data.beyond.periods === 1 ? "" : "s"
      }</td><td>${fmtMoney(data.beyond.amount)}</td></tr>`;
    }
  }
  document.getElementById("revenue-waterfall-total").innerHTML =
    `<th>Total deferred</th><th>${fmtMoney(data.total_deferred)}</th>`;
}

// Previewing before posting matters here: recognition writes a journal
// entry dated into a month someone may already have reported on, so the
// number should be seen before it lands, not after.
document.getElementById("rev-preview").addEventListener("click", async () => {
  const statusEl = document.getElementById("revenue-recognize-status");
  const data = await (await apiFetch(`/api/revenue/pending?period_month=${revPeriod()}`)).json();
  if (!data.entry_count) {
    statusEl.textContent = `Nothing to recognize through ${data.period_month}.`;
    return;
  }
  const months = data.periods.map((p) => `${p.period_month} ${fmtMoney(p.amount)}`).join(", ");
  statusEl.textContent = `Would recognize ${fmtMoney(data.total)} across ${data.periods.length} period${
    data.periods.length === 1 ? "" : "s"
  }: ${months}.`;
});

// ---- Prepaid expenses ----
// Money paid up front for something consumed over time (see
// prepaidExpenses.js) sits in Prepaid Expenses until it's used. The AP
// mirror of the Revenue Recognition tab above.

async function loadPrepaidExpenseFormData() {
  await loadPaymentAccounts();
  document.getElementById("pe-expense-account").innerHTML = groupedAccountOptionsHtml(rbExpenseAccounts, null);
  document.getElementById("pe-payment-account").innerHTML = groupedAccountOptionsHtml(bpPaymentAccounts, null);
}

document.getElementById("prepaid-expense-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("prepaid-expense-status");
  const res = await apiFetch("/api/prepaid-expenses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vendor_name: document.getElementById("pe-vendor").value,
      expense_account_id: document.getElementById("pe-expense-account").value,
      payment_account_id: document.getElementById("pe-payment-account").value,
      payment_date: document.getElementById("pe-payment-date").value,
      amount: Number(document.getElementById("pe-amount").value) || 0,
      service_start_date: document.getElementById("pe-start").value,
      service_end_date: document.getElementById("pe-end").value,
      memo: document.getElementById("pe-memo").value,
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Recorded ${fmtMoney(parsed.total)} prepaid to ${parsed.vendor_name}.`;
  document.getElementById("pe-vendor").value = "";
  document.getElementById("pe-amount").value = "";
  document.getElementById("pe-memo").value = "";
  loadPrepaidExpenses();
  loadPrepaidWaterfall();
});

async function loadPrepaidExpenses() {
  const data = await (await apiFetch("/api/prepaid-expenses")).json();
  const body = document.getElementById("prepaid-expenses-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="7" class="table-empty-row">No prepaid expenses yet — record one above.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (p) => `
    <tr>
      <td>${escapeHtml(p.vendor_name)}</td>
      <td>${escapeHtml(p.expense_account_name || "—")}</td>
      <td>${p.service_start_date} to ${p.service_end_date}</td>
      <td>${fmtMoney(p.total)}</td>
      <td>${fmtMoney(p.unamortized)}</td>
      <td>${p.status}</td>
      <td>
        ${p.status === "active" && p.unamortized === p.total ? `<button type="button" class="pe-void-btn linklike" data-id="${p.id}">Void</button>` : ""}
      </td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".pe-void-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog(
        "Void this prepaid expense?",
        "This posts a reversing entry and drops its remaining schedule. Only possible before any month has been amortized.",
        { confirmLabel: "Void", danger: true }
      );
      if (!confirmed) return;
      const res = await apiFetch(`/api/prepaid-expenses/${btn.dataset.id}/void`, { method: "POST" });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) {
        await alertDialog("Couldn't void that", parsed.detail || "Something went wrong.");
        return;
      }
      loadPrepaidExpenses();
      loadPrepaidWaterfall();
    })
  );
}

function pePeriod() {
  const el = document.getElementById("pe-period");
  if (!el.value) el.value = new Date().toISOString().slice(0, 7);
  return el.value;
}

async function loadPrepaidWaterfall() {
  pePeriod();
  const data = await (await apiFetch("/api/reports/prepaid-expenses")).json();
  const body = document.getElementById("prepaid-waterfall-body");
  if (!data.periods.length) {
    body.innerHTML = `<tr><td colspan="2" class="table-empty-row">Nothing prepaid — every recorded item has been consumed.</td></tr>`;
  } else {
    body.innerHTML = data.periods
      .map((p) => `<tr><td>${p.period_month}</td><td>${fmtMoney(p.amount)}</td></tr>`)
      .join("");
    if (data.beyond.periods > 0) {
      body.innerHTML += `<tr><td class="hint">+ ${data.beyond.periods} later period${
        data.beyond.periods === 1 ? "" : "s"
      }</td><td>${fmtMoney(data.beyond.amount)}</td></tr>`;
    }
  }
  document.getElementById("prepaid-waterfall-total").innerHTML =
    `<th>Total prepaid</th><th>${fmtMoney(data.total_prepaid)}</th>`;
}

document.getElementById("pe-preview").addEventListener("click", async () => {
  const statusEl = document.getElementById("prepaid-amortize-status");
  const data = await (await apiFetch(`/api/prepaid-expenses-pending?period_month=${pePeriod()}`)).json();
  if (!data.entry_count) {
    statusEl.textContent = `Nothing to amortize through ${data.period_month}.`;
    return;
  }
  const months = data.periods.map((p) => `${p.period_month} ${fmtMoney(p.amount)}`).join(", ");
  statusEl.textContent = `Would amortize ${fmtMoney(data.total)} across ${data.periods.length} period${
    data.periods.length === 1 ? "" : "s"
  }: ${months}.`;
});

document.getElementById("prepaid-amortize-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("prepaid-amortize-status");
  const period = pePeriod();

  const confirmed = await confirmDialog(
    `Amortize prepaid expenses through ${period}?`,
    "This posts a journal entry for each period, dated to the end of the month it recognizes. Any earlier month that was never run is caught up too.",
    { confirmLabel: "Amortize" }
  );
  if (!confirmed) return;

  const res = await apiFetch("/api/prepaid-expenses-amortize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ period_month: period }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = "";
    await alertDialog("Couldn't amortize that period", parsed.detail || "Something went wrong.");
    return;
  }
  statusEl.textContent = parsed.periods.length
    ? `Amortized ${fmtMoney(parsed.amortized)} across ${parsed.periods.length} period${
        parsed.periods.length === 1 ? "" : "s"
      }.`
    : `Nothing was pending through ${period}.`;
  loadPrepaidExpenses();
  loadPrepaidWaterfall();
});

// ---- Stockholders' equity ----
// Owner capital in, distributions out, treasury stock -- and the statement
// that explains the movement. See equity.js and stockholdersEquity.js.

// Which types move cash, and so need an account named. A declared dividend
// creates the obligation without paying it, so it's the one that doesn't.
const EQ_CASHLESS = new Set(["dividend_declared"]);
// Only a contribution can be a share issuance, and only a reissue needs to
// know what the shares originally cost.
const EQ_SHARES_TYPES = new Set(["contribution"]);
const EQ_COST_TYPES = new Set(["treasury_reissue"]);

const EQ_TYPE_LABELS = {
  contribution: "Contribution",
  distribution: "Distribution",
  dividend_declared: "Dividend declared",
  dividend_paid: "Dividend paid",
  treasury_purchase: "Treasury purchase",
  treasury_reissue: "Treasury reissue",
};

const EQ_HINTS = {
  contribution: "Money in from owners. Give shares and a par value to record it as a stock issuance -- par goes to Common Stock and the rest to Additional Paid-In Capital.",
  distribution: "Money out to owners. Reduces equity through a contra account, so the year's distributions stay visible.",
  dividend_declared: "Creates the obligation without paying it. Equity drops now; the liability sits on the balance sheet until paid.",
  dividend_paid: "Settles a dividend already declared. Moves cash; equity is unchanged, because the reduction was recognized at declaration.",
  treasury_purchase: "Buying back your own shares, carried at cost. No gain or loss is ever recognized on your own stock.",
  treasury_reissue: "Selling treasury shares on. Above cost credits paid-in capital; below cost is charged to paid-in capital first, then retained earnings.",
};

let eqAccounts = [];

async function loadEquityAccounts() {
  const data = await (await apiFetch("/api/accounts?active=true")).json();
  // Cash can come from or go to an asset or a liability (a bank account or
  // a credit line). Equity accounts are refused by the API -- funding
  // equity from equity is circular.
  eqAccounts = data.items.filter((a) => ["asset", "liability"].includes(a.type));
  document.getElementById("eq-cash").innerHTML = groupedAccountOptionsHtml(eqAccounts, null);
  updateEquityForm();
}

function updateEquityForm() {
  const type = document.getElementById("eq-type").value;
  document.getElementById("eq-cash-field").style.display = EQ_CASHLESS.has(type) ? "none" : "";
  document.querySelectorAll(".eq-shares-field").forEach((el) => {
    el.style.display = EQ_SHARES_TYPES.has(type) ? "" : "none";
  });
  document.getElementById("eq-cost-field").style.display = EQ_COST_TYPES.has(type) ? "" : "none";
  document.getElementById("eq-hint").textContent = EQ_HINTS[type] || "";
}

document.getElementById("eq-type").addEventListener("change", updateEquityForm);

document.getElementById("equity-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("equity-status");
  const type = document.getElementById("eq-type").value;
  const shares = Number(document.getElementById("eq-shares").value) || 0;
  const par = document.getElementById("eq-par").value;
  const cost = Number(document.getElementById("eq-cost").value) || 0;

  const body = {
    type,
    transaction_date: document.getElementById("eq-date").value,
    amount: Number(document.getElementById("eq-amount").value) || 0,
    ...(EQ_CASHLESS.has(type) ? {} : { cash_account_id: document.getElementById("eq-cash").value }),
    // Sent only as a pair -- the API rejects one without the other rather
    // than guessing at the missing half.
    ...(EQ_SHARES_TYPES.has(type) && shares && par !== "" ? { shares, par_value: Number(par) } : {}),
    ...(EQ_COST_TYPES.has(type) && cost ? { cost_basis: cost } : {}),
  };

  const res = await apiFetch("/api/equity/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Recorded ${EQ_TYPE_LABELS[type]} of ${fmtMoney(parsed.amount)}.`;
  document.getElementById("eq-amount").value = "";
  document.getElementById("eq-shares").value = "";
  document.getElementById("eq-par").value = "";
  document.getElementById("eq-cost").value = "";
  loadEquityStatement();
  loadEquityTransactions();
});

async function loadEquityStatement() {
  const from = document.getElementById("eq-from");
  const to = document.getElementById("eq-to");
  if (!to.value) to.value = new Date().toISOString().slice(0, 10);
  if (!from.value) from.value = `${new Date().getUTCFullYear()}-01-01`;

  const data = await (await apiFetch(`/api/statements/stockholders-equity?from=${from.value}&to=${to.value}`)).json();

  // Totals use <th> cells, which is how every other statement in this app
  // marks them -- picks up the same emphasis with no new CSS.
  const row = (label, value, opts = {}) => {
    const cell = opts.strong ? "th" : "td";
    return `<tr><${cell}>${escapeHtml(label)}</${cell}><${cell}>${fmtMoney(value)}</${cell}></tr>`;
  };

  const lines = [
    row("Beginning balance", data.beginning_balance, { strong: true }),
    row("Net income", data.net_income),
    row("Contributions", data.contributions),
    row("Distributions and dividends", data.distributions),
    row("Treasury stock", data.treasury_stock),
  ];
  // Only shown when it's non-zero: equity moved by a plain journal entry
  // is real and needs naming, but a permanent zero row is noise.
  if (data.other !== 0) lines.push(row("Other (manual journal entries)", data.other));
  lines.push(row("Ending balance", data.ending_balance, { strong: true }));

  // Spelled out because the transactions table below is not
  // period-filtered -- without this, a transaction dated outside the
  // window reads as one the statement forgot.
  document.getElementById("equity-period-label").textContent = `${data.from} to ${data.to}`;
  document.getElementById("equity-statement-body").innerHTML = lines.join("");
  document.getElementById("equity-reconcile").textContent = data.reconciles
    ? `Ties to the balance sheet at ${data.to}.`
    : "This statement does not reconcile to the balance sheet — please report this.";
}

document.getElementById("equity-period-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadEquityStatement();
});

async function loadEquityTransactions() {
  const data = await (await apiFetch("/api/equity/transactions")).json();
  const body = document.getElementById("equity-transactions-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="6" class="table-empty-row">No equity transactions yet.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (t) => `
    <tr>
      <td>${t.transaction_date}</td>
      <td>${escapeHtml(EQ_TYPE_LABELS[t.type] || t.type)}</td>
      <td>${fmtMoney(t.amount)}</td>
      <td>${escapeHtml(t.cash_account_name || "—")}</td>
      <td>${escapeHtml(t.memo || "—")}</td>
      <td>${t.journal_entry_id ? `<button type="button" class="eq-void-btn linklike" data-id="${t.id}">Void</button>` : "voided"}</td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".eq-void-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Void this equity transaction?", "Its journal entry is reversed. The record itself is kept — an owner distribution that happened and was corrected is history worth keeping.", {
        confirmLabel: "Void",
        danger: true,
      });
      if (!confirmed) return;
      const res = await apiFetch(`/api/equity/transactions/${btn.dataset.id}/void`, { method: "POST" });
      if (!res.ok) {
        const parsed = await res.json().catch(() => ({}));
        await alertDialog("Couldn't void that", parsed.detail || "Something went wrong.");
        return;
      }
      loadEquityStatement();
      loadEquityTransactions();
    })
  );
}

// ---- Cap table ----
// The share register: positions in shares rather than dollars. See
// shareRegister.js.

// Which ends of a movement name a shareholder, and which one the money
// (if any) came through. Mirrors shareRegister.js's MOVEMENT table -- the
// form hides fields the API would refuse rather than letting someone fill
// in a "from" on an issuance and find out on submit.
const SH_SHAPE = {
  issue: { from: false, to: true, funding: "contribution" },
  transfer: { from: true, to: true, funding: null },
  repurchase: { from: true, to: false, funding: "treasury_purchase" },
  reissue: { from: false, to: true, funding: "treasury_reissue" },
};

const SH_TYPE_LABELS = {
  issue: "Issue",
  transfer: "Transfer",
  repurchase: "Repurchase",
  reissue: "Reissue",
};

const SH_HINTS = {
  issue: "New shares out of the company's authorized capital. Raises both issued and outstanding.",
  transfer: "One shareholder to another. Nothing about the company changes -- no money moves through it, and the totals stay put.",
  repurchase: "Buying shares back into treasury. Outstanding falls; issued does not, so these shares keep using up authorized capital.",
  reissue: "Selling treasury shares back out. Outstanding rises again, and no new authorized capital is consumed.",
};

let capClasses = [];
let capHolders = [];
let capFunding = [];

async function loadCapTable() {
  // Classes and holders first: the plan and award forms build their
  // dropdowns from both, so loading them in parallel would race.
  // loadEquityAccounts is the equity tab's, reused here because exercising
  // posts a contribution and needs the same list of cash accounts.
  await Promise.all([loadCapClasses(), loadCapHolders(), loadCapFunding(), loadEquityAccounts()]);
  await Promise.all([loadCapPositions(), loadCapCounts(), loadShareTransactions(), loadEquityPlans(), loadAwards(), loadFullyDiluted(), loadStockComp()]);
}

function holderOptions(holders) {
  return holders.map((h) => `<option value="${h.id}">${escapeHtml(h.name)}</option>`).join("");
}

async function loadCapClasses() {
  const data = await (await apiFetch("/api/share-classes")).json();
  capClasses = data.items;
  document.getElementById("sh-class").innerHTML = capClasses
    .filter((c) => c.active)
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
    .join("");
}

async function loadCapHolders() {
  const data = await (await apiFetch("/api/shareholders")).json();
  capHolders = data.items;
  // A deactivated holder can still give shares up -- selling out is how
  // someone stops being a shareholder -- but can't be handed more, so they
  // stay on the "from" list and come off the "to" list.
  document.getElementById("sh-from").innerHTML = holderOptions(capHolders);
  document.getElementById("sh-to").innerHTML = holderOptions(capHolders.filter((h) => h.active));
}

// Only equity transactions that aren't already spoken for -- the API
// refuses a second claim on one, so offering it here would be a trap.
async function loadCapFunding() {
  const data = await (await apiFetch("/api/share-register/reconciliation")).json();
  capFunding = data.unlinked_equity_transactions || [];
  updateShareForm();
}

function updateShareForm() {
  const type = document.getElementById("sh-type").value;
  const shape = SH_SHAPE[type];
  document.getElementById("sh-from-field").style.display = shape.from ? "" : "none";
  document.getElementById("sh-to-field").style.display = shape.to ? "" : "none";
  document.getElementById("sh-hint").textContent = SH_HINTS[type] || "";

  const field = document.getElementById("sh-equity-field");
  const matching = shape.funding ? capFunding.filter((t) => t.type === shape.funding) : [];
  // Hidden rather than shown empty: a transfer has nothing to link to at
  // all, and an empty dropdown reads like something failed to load.
  field.style.display = matching.length ? "" : "none";
  document.getElementById("sh-equity").innerHTML =
    `<option value="">Not linked</option>` +
    matching
      .map((t) => `<option value="${t.id}">${t.transaction_date} — ${fmtMoney(t.amount)}, ${t.shares.toLocaleString()} shares</option>`)
      .join("");
}

document.getElementById("sh-type").addEventListener("change", updateShareForm);

async function loadCapPositions() {
  const asOf = document.getElementById("cap-asof").value;
  const data = await (await apiFetch(`/api/cap-table${asOf ? `?as_of=${asOf}` : ""}`)).json();
  const body = document.getElementById("cap-table-body");

  document.getElementById("cap-summary").textContent = data.total_outstanding
    ? `${data.total_outstanding.toLocaleString()} shares outstanding across ${data.holders.length} holder${data.holders.length === 1 ? "" : "s"}.`
    : "";

  if (!data.holders.length) {
    body.innerHTML = `<tr><td colspan="5" class="table-empty-row">Nobody holds shares yet. Add a share class and a shareholder below, then issue.</td></tr>`;
    return;
  }

  // One row per position, with the holder's name and company-wide
  // percentage spanning their rows -- a holder of two classes is one
  // person, and repeating their name down the table implies two.
  body.innerHTML = data.holders
    .map((h) =>
      h.positions
        .map(
          (p, i) => `
    <tr>
      ${i === 0 ? `<td rowspan="${h.positions.length}">${escapeHtml(h.shareholder_name)}</td>` : ""}
      <td>${escapeHtml(p.share_class_name)}</td>
      <td>${p.shares.toLocaleString()}</td>
      <td>${p.percent.toFixed(2)}%</td>
      ${i === 0 ? `<td rowspan="${h.positions.length}">${h.percent.toFixed(2)}%</td>` : ""}
    </tr>`
        )
        .join("")
    )
    .join("");
}

async function loadCapCounts() {
  const asOf = document.getElementById("cap-asof").value;
  const [counts, reconciliation] = await Promise.all([
    (await apiFetch(`/api/share-classes/counts${asOf ? `?as_of=${asOf}` : ""}`)).json(),
    (await apiFetch(`/api/share-register/reconciliation${asOf ? `?as_of=${asOf}` : ""}`)).json(),
  ]);

  const body = document.getElementById("cap-classes-body");
  body.innerHTML = counts.items.length
    ? counts.items
        .map(
          (c) => `
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${c.par_value ? `$${c.par_value}` : "No par"}</td>
      <td>${c.authorized === null ? "No limit" : c.authorized.toLocaleString()}</td>
      <td>${c.issued.toLocaleString()}</td>
      <td>${c.treasury.toLocaleString()}</td>
      <td>${c.outstanding.toLocaleString()}</td>
      <td>${c.available === null ? "—" : c.available.toLocaleString()}</td>
    </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="table-empty-row">No share classes yet.</td></tr>`;

  // The tie-out to the general ledger. Said in full rather than as a
  // green tick, because "doesn't apply" and "reconciles" both look like
  // a difference of zero and mean completely different things.
  const el = document.getElementById("cap-reconcile");
  // Mentioned even when the numbers tie, because a treasury purchase or
  // reissue moves shares without touching Common Stock -- one of those
  // going unrecorded on the register leaves the tie-out passing and the
  // cap table wrong, which is the worst of both.
  const stray = reconciliation.unlinked_equity_transactions.length;
  const strayNote = stray
    ? ` ${stray} equity transaction${stray === 1 ? "" : "s"} record${stray === 1 ? "s" : ""} shares with no movement on the register.`
    : "";

  if (!reconciliation.applicable) {
    el.textContent = (reconciliation.reason || "") + strayNote;
  } else if (reconciliation.reconciles) {
    el.textContent =
      `Common Stock of ${fmtMoney(reconciliation.ledger_common_stock)} matches the par value of every share this register says was issued.` + strayNote;
  } else {
    el.textContent =
      `Common Stock is ${fmtMoney(reconciliation.ledger_common_stock)} but this register accounts for ${fmtMoney(reconciliation.register_par_value)} of par — ` +
      `a difference of ${fmtMoney(reconciliation.difference)}.` +
      strayNote;
  }
}

document.getElementById("cap-asof-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadCapPositions();
  loadCapCounts();
  loadFullyDiluted();
});

document.getElementById("share-class-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("share-class-status");
  const authorized = document.getElementById("sc-authorized").value;
  const res = await apiFetch("/api/share-classes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("sc-name").value,
      par_value: Number(document.getElementById("sc-par").value) || 0,
      // Null, not zero: no stated ceiling is not a ceiling of nothing.
      authorized_shares: authorized === "" ? null : Number(authorized),
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Added ${parsed.name}.`;
  document.getElementById("sc-name").value = "";
  document.getElementById("sc-authorized").value = "";
  await loadCapClasses();
  loadCapCounts();
  // The plan form picks its class from the same list.
  loadEquityPlans();
});

document.getElementById("shareholder-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("shareholder-status");
  const res = await apiFetch("/api/shareholders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("shh-name").value,
      email: document.getElementById("shh-email").value,
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Added ${parsed.name}.`;
  document.getElementById("shh-name").value = "";
  document.getElementById("shh-email").value = "";
  await loadCapHolders();
  // The award form's grantee list comes from the same holders.
  loadEquityPlans();
});

document.getElementById("share-txn-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("share-txn-status");
  const type = document.getElementById("sh-type").value;
  const shape = SH_SHAPE[type];
  const price = document.getElementById("sh-price").value;
  const funding = document.getElementById("sh-equity").value;

  const res = await apiFetch("/api/share-transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type,
      share_class_id: document.getElementById("sh-class").value,
      transaction_date: document.getElementById("sh-date").value,
      shares: Number(document.getElementById("sh-shares").value) || 0,
      ...(shape.from ? { from_shareholder_id: document.getElementById("sh-from").value } : {}),
      ...(shape.to ? { to_shareholder_id: document.getElementById("sh-to").value } : {}),
      ...(price === "" ? {} : { price_per_share: Number(price) }),
      ...(funding ? { equity_transaction_id: funding } : {}),
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Recorded ${SH_TYPE_LABELS[type].toLowerCase()} of ${parsed.shares.toLocaleString()} shares.`;
  document.getElementById("sh-shares").value = "";
  document.getElementById("sh-price").value = "";
  loadCapPositions();
  loadCapCounts();
  loadShareTransactions();
  loadCapFunding();
});

async function loadShareTransactions() {
  const data = await (await apiFetch("/api/share-transactions")).json();
  const body = document.getElementById("share-txns-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="7" class="table-empty-row">No share movements yet.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (t) => `
    <tr>
      <td>${t.transaction_date}</td>
      <td>${escapeHtml(SH_TYPE_LABELS[t.type] || t.type)}</td>
      <td>${escapeHtml(t.share_class_name || "—")}</td>
      <td>${t.shares.toLocaleString()}</td>
      <td>${escapeHtml(t.from_shareholder_name || "Company")}</td>
      <td>${escapeHtml(t.to_shareholder_name || "Company")}</td>
      <td><button type="button" class="sh-delete-btn linklike" data-id="${t.id}">Remove</button></td>
    </tr>`
    )
    .join("");

  body.querySelectorAll(".sh-delete-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      // Removed outright rather than voided, unlike everything on the
      // ledger side. A journal entry is a claim about money that moved and
      // has to be corrected by a second entry saying so; a register entry
      // is a claim about who owns what, and a wrong one leaves the wrong
      // name on the cap table.
      const confirmed = await confirmDialog(
        "Remove this share movement?",
        "The register is a record of ownership, so a wrong entry is removed rather than reversed. Any equity transaction that funded it keeps its journal entry.",
        { confirmLabel: "Remove", danger: true }
      );
      if (!confirmed) return;
      const res = await apiFetch(`/api/share-transactions/${btn.dataset.id}`, { method: "DELETE" });
      if (!res.ok) {
        const parsed = await res.json().catch(() => ({}));
        await alertDialog("Couldn't remove that", parsed.detail || "Something went wrong.");
        return;
      }
      loadCapPositions();
      loadCapCounts();
      loadShareTransactions();
      loadCapFunding();
    })
  );
}

// ---- Option pool and fully-diluted ownership ----
// Equity promised but not issued, and the denominator that falls out of
// it. See equityAwards.js.

const AWARD_TYPE_LABELS = { option: "Option", rsu: "RSU", warrant: "Warrant" };

const AWARD_HINTS = {
  option: "The right to buy shares at the strike price once vested. Nothing is issued until it's exercised.",
  rsu: "Settles into shares on vesting rather than being bought, so it has no strike price.",
  warrant: "The same instrument as an option, granted to an investor or a lender rather than an employee. Dilutes identically.",
};

let capPlans = [];
let exerciseModalResolve = null;

// Asks for the share count and the date. The date is not a formality --
// vesting is evaluated at it, and the API refuses one in the future for
// exactly that reason, so defaulting to today and letting it be backdated
// is the right shape.
function exerciseDialog(exercisable, { strike = null } = {}) {
  const proceeds = strike ? exercisable * strike : 0;
  document.getElementById("exercise-modal-message").textContent = strike
    ? `Up to ${exercisable.toLocaleString()} shares are exercisable today, at ${fmtMoney(strike)} a share — ${fmtMoney(proceeds)} in total.`
    : `Up to ${exercisable.toLocaleString()} shares are exercisable today. This award has no strike price, so no cash changes hands.`;

  // Only an award with a strike price brings money in. An RSU settles for
  // services, and the expense side of that is ASC 718 stock compensation,
  // which Rekono doesn't compute -- so there's nothing to post and nothing
  // to ask for.
  //
  // A real cash account is the default and "don't post" is the deliberate
  // opt-out, not the other way round: skipping the posting is what breaks
  // the register's tie-out to the ledger, and a default that quietly does
  // that is a default that is wrong most of the time.
  const accountField = document.getElementById("exercise-modal-account-field");
  accountField.style.display = strike ? "" : "none";
  document.getElementById("exercise-modal-account").innerHTML =
    groupedAccountOptionsHtml(eqAccounts, null) +
    `<option value="">Don't post to the ledger</option>`;
  document.getElementById("exercise-modal-shares").value = String(exercisable);
  document.getElementById("exercise-modal-shares").max = String(exercisable);
  document.getElementById("exercise-modal-date").value = new Date().toISOString().slice(0, 10);
  const errorEl = document.getElementById("exercise-modal-error");
  errorEl.textContent = "";
  errorEl.style.display = "none";
  document.getElementById("exercise-modal").style.display = "flex";
  document.getElementById("exercise-modal-shares").focus();

  return new Promise((resolve) => {
    exerciseModalResolve = resolve;
  });
}

function closeExerciseModal(result) {
  document.getElementById("exercise-modal").style.display = "none";
  if (exerciseModalResolve) {
    exerciseModalResolve(result);
    exerciseModalResolve = null;
  }
}

document.getElementById("exercise-modal-cancel").addEventListener("click", () => closeExerciseModal(null));
document.getElementById("exercise-modal").addEventListener("click", (e) => {
  if (e.target.id === "exercise-modal") closeExerciseModal(null);
});

document.getElementById("exercise-modal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const shares = Number(document.getElementById("exercise-modal-shares").value);
  const errorEl = document.getElementById("exercise-modal-error");
  if (!Number.isInteger(shares) || shares <= 0) {
    errorEl.textContent = "Enter a whole number of shares above zero.";
    errorEl.style.display = "";
    return;
  }
  const account = document.getElementById("exercise-modal-account").value;
  closeExerciseModal({
    shares,
    event_date: document.getElementById("exercise-modal-date").value,
    ...(account ? { cash_account_id: account } : {}),
  });
});

function updateAwardForm() {
  const type = document.getElementById("aw-type").value;
  // An RSU has nothing to pay, and the API refuses a strike price on one
  // rather than quietly storing a number that means nothing.
  document.getElementById("aw-strike-field").style.display = type === "rsu" ? "none" : "";
  document.getElementById("aw-hint").textContent = AWARD_HINTS[type] || "";
}

document.getElementById("aw-type").addEventListener("change", updateAwardForm);

async function loadEquityPlans() {
  const data = await (await apiFetch("/api/equity-plans")).json();
  capPlans = data.items;

  document.getElementById("pl-class").innerHTML = capClasses
    .filter((c) => c.active)
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
    .join("");
  document.getElementById("aw-plan").innerHTML = capPlans
    .filter((p) => p.active)
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${p.available.toLocaleString()} left)</option>`)
    .join("");
  document.getElementById("aw-holder").innerHTML = capHolders
    .filter((h) => h.active)
    .map((h) => `<option value="${h.id}">${escapeHtml(h.name)}</option>`)
    .join("");

  const body = document.getElementById("plans-body");
  body.innerHTML = capPlans.length
    ? capPlans
        .map(
          (p) => `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.share_class_name || "—")}</td>
      <td>${p.reserved.toLocaleString()}</td>
      <td>${p.granted.toLocaleString()}</td>
      <td>${p.exercised.toLocaleString()}</td>
      <td>${p.outstanding.toLocaleString()}</td>
      <td>${p.available.toLocaleString()}</td>
    </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="table-empty-row">No option pool yet.</td></tr>`;

  updateAwardForm();
}

async function loadFullyDiluted() {
  const asOf = document.getElementById("cap-asof").value;
  const data = await (await apiFetch(`/api/cap-table/fully-diluted${asOf ? `?as_of=${asOf}` : ""}`)).json();

  document.getElementById("fd-summary").textContent = data.fully_diluted_shares
    ? `${data.fully_diluted_shares.toLocaleString()} shares fully diluted — ${data.outstanding_shares.toLocaleString()} issued, ` +
      `${data.award_shares.toLocaleString()} promised in awards, ${data.unallocated_pool_shares.toLocaleString()} unallocated.`
    : "";

  const body = document.getElementById("fd-body");
  if (!data.holders.length && !data.unallocated_pool_shares) {
    body.innerHTML = `<tr><td colspan="6" class="table-empty-row">Nothing issued or promised yet.</td></tr>`;
    return;
  }

  const rows = data.holders.map(
    (h) => `
    <tr>
      <td>${escapeHtml(h.shareholder_name)}</td>
      <td>${h.shares.toLocaleString()}</td>
      <td>${h.award_shares.toLocaleString()}</td>
      <td>${h.fully_diluted_shares.toLocaleString()}</td>
      <td>${h.percent.toFixed(2)}%</td>
      <td>${h.outstanding_percent.toFixed(2)}%</td>
    </tr>`
  );

  // Its own row rather than folded into a holder, because it is held by
  // nobody. Dropping it would make every percentage above look better
  // than the one an investor will compute.
  if (data.unallocated_pool_shares > 0) {
    rows.push(`
    <tr>
      <td><em>Unallocated pool</em></td>
      <td>0</td>
      <td>${data.unallocated_pool_shares.toLocaleString()}</td>
      <td>${data.unallocated_pool_shares.toLocaleString()}</td>
      <td>${data.unallocated_pool_percent.toFixed(2)}%</td>
      <td>—</td>
    </tr>`);
  }
  body.innerHTML = rows.join("");
}

async function loadAwards() {
  const data = await (await apiFetch("/api/equity-awards")).json();
  const body = document.getElementById("awards-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="8" class="table-empty-row">No awards granted yet.</td></tr>`;
    return;
  }

  body.innerHTML = data.items
    .map(
      (a) => `
    <tr>
      <td>${a.grant_date}</td>
      <td>${escapeHtml(a.shareholder_name || "—")}</td>
      <td>${escapeHtml(AWARD_TYPE_LABELS[a.type] || a.type)}</td>
      <td>${a.shares.toLocaleString()}</td>
      <td>${(a.vested ?? 0).toLocaleString()}</td>
      <td>${(a.exercised ?? 0).toLocaleString()}</td>
      <td>${(a.exercisable ?? 0).toLocaleString()}</td>
      <td>
        ${a.exercisable ? `<button type="button" class="aw-exercise-btn linklike" data-id="${a.id}" data-max="${a.exercisable}" data-strike="${a.strike_price ?? ""}">Exercise</button>` : ""}
        ${a.outstanding ? `<button type="button" class="aw-cancel-btn linklike" data-id="${a.id}" data-shares="${a.outstanding}">Cancel</button>` : ""}
      </td>
    </tr>`
    )
    .join("");

  body.querySelectorAll(".aw-exercise-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const result = await exerciseDialog(Number(btn.dataset.max), { strike: btn.dataset.strike ? Number(btn.dataset.strike) : null });
      if (!result) return;
      const res = await apiFetch(`/api/equity-awards/${btn.dataset.id}/exercise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
      if (!res.ok) {
        const parsed = await res.json().catch(() => ({}));
        await alertDialog("Couldn't exercise that", parsed.detail || "Something went wrong.");
        return;
      }
      refreshCapPool();
    })
  );

  body.querySelectorAll(".aw-cancel-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const shares = Number(btn.dataset.shares);
      const confirmed = await confirmDialog(
        "Cancel this award?",
        `All ${shares.toLocaleString()} shares still outstanding on it go back to the plan and can be granted again. Anything already exercised is real stock and is unaffected.`,
        { confirmLabel: "Cancel award", danger: true }
      );
      if (!confirmed) return;
      const res = await apiFetch(`/api/equity-awards/${btn.dataset.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_date: new Date().toISOString().slice(0, 10) }),
      });
      if (!res.ok) {
        const parsed = await res.json().catch(() => ({}));
        await alertDialog("Couldn't cancel that", parsed.detail || "Something went wrong.");
        return;
      }
      refreshCapPool();
    })
  );
}

// Exercising touches the register, the pool and both cap tables at once,
// which is the whole point of routing it through one call server-side.
function refreshCapPool() {
  loadCapPositions();
  loadCapCounts();
  loadShareTransactions();
  loadEquityPlans();
  loadAwards();
  loadFullyDiluted();
  // A grant, an exercise or a forfeiture all move the ASC 718 schedule.
  loadStockComp();
}

document.getElementById("plan-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("plan-status");
  const res = await apiFetch("/api/equity-plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("pl-name").value,
      share_class_id: document.getElementById("pl-class").value,
      reserved_shares: Number(document.getElementById("pl-reserved").value) || 0,
      adopted_date: document.getElementById("pl-adopted").value,
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Added ${parsed.name}.`;
  document.getElementById("pl-name").value = "";
  document.getElementById("pl-reserved").value = "";
  await loadEquityPlans();
  loadFullyDiluted();
});

document.getElementById("award-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("award-status");
  const type = document.getElementById("aw-type").value;
  const strike = document.getElementById("aw-strike").value;
  const vestStart = document.getElementById("aw-vest-start").value;
  const fairValue = document.getElementById("aw-fv").value;

  const res = await apiFetch("/api/equity-awards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      equity_plan_id: document.getElementById("aw-plan").value,
      shareholder_id: document.getElementById("aw-holder").value,
      type,
      grant_date: document.getElementById("aw-date").value,
      shares: Number(document.getElementById("aw-shares").value) || 0,
      ...(type === "rsu" || strike === "" ? {} : { strike_price: Number(strike) }),
      // Optional, and null means "don't expense this award" rather than
      // "worth nothing" -- see EquityAward.grantDateFairValueMicros.
      ...(fairValue === "" ? {} : { grant_date_fair_value: Number(fairValue) }),
      ...(vestStart ? { vesting_start_date: vestStart } : {}),
      vesting_months: Number(document.getElementById("aw-vest-months").value),
      cliff_months: Number(document.getElementById("aw-cliff").value),
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Granted ${parsed.shares.toLocaleString()} shares.`;
  document.getElementById("aw-shares").value = "";
  document.getElementById("aw-strike").value = "";
  document.getElementById("aw-fv").value = "";
  refreshCapPool();
});

// ---- Stock compensation (ASC 718) ----
// What an equity award costs the income statement. See
// stockCompensation.js.

async function loadStockComp() {
  const through = document.getElementById("sc-through");
  if (!through.value) through.value = new Date().toISOString().slice(0, 7);

  const [schedule, awards] = await Promise.all([
    (await apiFetch(`/api/stock-compensation?through=${through.value}`)).json(),
    (await apiFetch("/api/stock-compensation/awards")).json(),
  ]);

  // The schedule runs from the first grant to today and only ever gets
  // longer -- a four-year grant is 48 near-identical rows, and burying the
  // months that still need posting under three years of "Posted $2,500"
  // is how someone misses them. Everything unposted is always shown; the
  // posted tail is capped, with a count of what's folded away.
  const body = document.getElementById("sc-schedule-body");
  const POSTED_SHOWN = 12;
  const unposted = schedule.months.filter((m) => !m.posted);
  const posted = schedule.months.filter((m) => m.posted);
  const shownPosted = posted.slice(-POSTED_SHOWN);
  const hidden = posted.length - shownPosted.length;

  const row = (m) => `
    <tr>
      <td>${m.period_month}</td>
      <td>${fmtMoney(m.amount)}</td>
      <td>${m.posted ? "Posted" : "To post"}</td>
    </tr>`;

  body.innerHTML = schedule.months.length
    ? (hidden > 0
        ? `<tr><td colspan="3" class="table-empty-row">${hidden} earlier month${hidden === 1 ? "" : "s"} already posted, not shown.</td></tr>`
        : "") +
      shownPosted.map(row).join("") +
      unposted.map(row).join("")
    : `<tr><td colspan="3" class="table-empty-row">No awards carry a grant-date fair value, so there's nothing to expense.</td></tr>`;

  document.getElementById("sc-status").textContent = schedule.total
    ? `${fmtMoney(schedule.total)} not yet posted through ${through.value}.`
    : schedule.months.length
    ? `Everything through ${through.value} is posted.`
    : "";

  const awardsBody = document.getElementById("sc-awards-body");
  awardsBody.innerHTML = awards.items.length
    ? awards.items
        .map(
          (a) => `
    <tr>
      <td>${a.grant_date}</td>
      <td>${a.shares.toLocaleString()}</td>
      <td>${fmtMoney(a.grant_date_fair_value)}</td>
      <td>${fmtMoney(a.total_cost)}</td>
      <td>${fmtMoney(a.recognized_cost)}</td>
      <td>${fmtMoney(a.unrecognized_cost)}</td>
      <td>${a.served_percent.toFixed(1)}%</td>
    </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="table-empty-row">No awards with a fair value on file.</td></tr>`;
}

document.getElementById("sc-run-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("sc-status");
  const through = document.getElementById("sc-through").value;
  if (!through) return;

  const res = await apiFetch("/api/stock-compensation/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ through }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = parsed.entries.length
    ? `Posted ${parsed.entries.length} month${parsed.entries.length === 1 ? "" : "s"}, ${fmtMoney(parsed.total)} in total.`
    : "Nothing new to post.";
  loadStockComp();
});

// ---- Adjusting entries and year-end close ----
// The entries a close actually consists of. See recurringEntries.js and
// yearEndClose.js.

let recAccounts = [];

async function loadAdjustmentAccounts() {
  const data = await (await apiFetch("/api/accounts?active=true")).json();
  recAccounts = data.items;
  if (!document.getElementById("rec-lines-body").children.length) {
    addRecurringLineRow();
    addRecurringLineRow();
  }
  populateFixedAssetAccountPickers();
}

// ---- Fixed assets ----
// See fixedAssets.js. Reuses recAccounts (already loaded above for the
// generic recurring-entry line builder) rather than fetching accounts a
// second time for the same tab.

function accountOptionsFilteredHtml(type) {
  return groupedAccountOptionsHtml(
    recAccounts.filter((a) => a.type === type),
    null
  );
}

function populateFixedAssetAccountPickers() {
  document.getElementById("fa-asset-account").innerHTML = accountOptionsFilteredHtml("asset");
  document.getElementById("fa-accum-account").innerHTML = accountOptionsFilteredHtml("asset");
  document.getElementById("fa-expense-account").innerHTML = accountOptionsFilteredHtml("expense");
}

function updateFixedAssetMonthlyPreview() {
  const cost = Number(document.getElementById("fa-cost").value) || 0;
  const salvage = Number(document.getElementById("fa-salvage").value) || 0;
  const months = Number(document.getElementById("fa-life").value) || 0;
  const method = document.getElementById("fa-method").value;
  const el = document.getElementById("fa-monthly-preview");
  if (!(cost > 0 && months > 0 && salvage <= cost)) {
    el.textContent = "";
    return;
  }
  if (method === "declining_balance") {
    const rate = Number(document.getElementById("fa-rate").value) || 0;
    if (rate > 0) {
      el.textContent = `${fmtMoney(Math.min((cost * rate) / 100 / 12, cost - salvage))} the first month -- shrinks every month after as book value drops.`;
    } else {
      el.textContent = "";
    }
  } else {
    el.textContent = `${fmtMoney((cost - salvage) / months)} a month, straight-line.`;
  }
}
["fa-cost", "fa-salvage", "fa-life", "fa-rate"].forEach((id) =>
  document.getElementById(id).addEventListener("input", updateFixedAssetMonthlyPreview)
);
document.getElementById("fa-method").addEventListener("change", () => {
  const isDeclining = document.getElementById("fa-method").value === "declining_balance";
  document.getElementById("fa-rate-row").hidden = !isDeclining;
  document.getElementById("fa-rate").required = isDeclining;
  updateFixedAssetMonthlyPreview();
});

const DEPRECIATION_METHOD_LABELS = { straight_line: "Straight-line", declining_balance: "Declining balance" };

async function loadFixedAssets() {
  const data = await (await apiFetch("/api/fixed-assets")).json();
  const body = document.getElementById("fixed-assets-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="9" class="table-empty-row">No fixed assets yet — add one above.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (a) => `
    <tr>
      <td>${escapeHtml(a.name)}</td>
      <td>${DEPRECIATION_METHOD_LABELS[a.method] || a.method}</td>
      <td>${fmtMoney(a.cost)}</td>
      <td>${fmtMoney(a.accumulated_depreciation)}</td>
      <td>${fmtMoney(a.book_value)}</td>
      <td>${fmtMoney(a.monthly_amount)}</td>
      <td>${a.fully_depreciated ? "—" : a.next_due || "—"}</td>
      <td>${a.fully_depreciated ? "Fully depreciated" : a.active ? "Active" : "Paused"}</td>
      <td>
        ${
          a.fully_depreciated
            ? ""
            : `<button type="button" class="fa-toggle-btn" data-id="${a.id}" data-active="${a.active}">${
                a.active ? "Pause" : "Resume"
              }</button>`
        }
        ${
          a.method === "declining_balance" && !a.fully_depreciated && a.active
            ? `<button type="button" class="fa-run-btn" data-id="${a.id}">Run depreciation</button>`
            : ""
        }
        <button type="button" class="fa-delete-btn linklike" data-id="${a.id}">Delete</button>
      </td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".fa-toggle-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await apiFetch(`/api/fixed-assets/${btn.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: btn.dataset.active !== "true" }),
      });
      loadFixedAssets();
    })
  );
  body.querySelectorAll(".fa-run-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const res = await apiFetch(`/api/fixed-assets/${btn.dataset.id}/run-depreciation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ as_of: new Date().toISOString().slice(0, 10) }),
      });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) {
        await alertDialog("Couldn't run depreciation", parsed.detail || "Something went wrong.");
        return;
      }
      loadFixedAssets();
    })
  );
  body.querySelectorAll(".fa-delete-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Delete this fixed asset?", "Depreciation it already posted stays on the books — this only stops future postings and removes the record.", {
        confirmLabel: "Delete",
        danger: true,
      });
      if (!confirmed) return;
      await apiFetch(`/api/fixed-assets/${btn.dataset.id}`, { method: "DELETE" });
      loadFixedAssets();
    })
  );
}

document.getElementById("fixed-asset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("fixed-asset-status");
  const method = document.getElementById("fa-method").value;
  const res = await apiFetch("/api/fixed-assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("fa-name").value,
      cost: Number(document.getElementById("fa-cost").value),
      salvage_value: Number(document.getElementById("fa-salvage").value) || 0,
      useful_life_months: Number(document.getElementById("fa-life").value),
      acquisition_date: document.getElementById("fa-acquired").value,
      method,
      ...(method === "declining_balance"
        ? { declining_balance_rate_percent: Number(document.getElementById("fa-rate").value) || 0 }
        : {}),
      asset_account_id: document.getElementById("fa-asset-account").value,
      expense_account_id: document.getElementById("fa-expense-account").value,
      accumulated_depreciation_account_id: document.getElementById("fa-accum-account").value,
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Added "${parsed.name}" -- ${fmtMoney(parsed.monthly_amount)} the first period.`;
  e.target.reset();
  document.getElementById("fa-rate-row").hidden = true;
  updateFixedAssetMonthlyPreview();
  loadFixedAssets();
});

function recAccountOptions() {
  return groupedAccountOptionsHtml(recAccounts, null);
}

function updateRecurringBalance() {
  const rows = [...document.getElementById("rec-lines-body").querySelectorAll("tr")];
  let debit = 0;
  let credit = 0;
  for (const r of rows) {
    debit += Number(r.querySelector(".rec-debit").value) || 0;
    credit += Number(r.querySelector(".rec-credit").value) || 0;
  }
  const el = document.getElementById("rec-balance-indicator");
  el.textContent =
    debit === credit && debit > 0
      ? `Balanced: ${fmtMoney(debit)}`
      : `Debits ${fmtMoney(debit)}, credits ${fmtMoney(credit)} -- must be equal.`;
}

function addRecurringLineRow() {
  const body = document.getElementById("rec-lines-body");
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><select class="rec-account" required>${recAccountOptions()}</select></td>
    <td><input type="number" class="rec-debit" step="0.01" min="0" placeholder="0.00" /></td>
    <td><input type="number" class="rec-credit" step="0.01" min="0" placeholder="0.00" /></td>
    <td><button type="button" class="rec-remove-line linklike">Remove</button></td>
  `;
  body.appendChild(row);
  row.querySelectorAll(".rec-debit, .rec-credit").forEach((i) => i.addEventListener("input", updateRecurringBalance));
  row.querySelector(".rec-remove-line").addEventListener("click", () => {
    row.remove();
    updateRecurringBalance();
  });
  updateRecurringBalance();
}

document.getElementById("rec-add-line").addEventListener("click", addRecurringLineRow);

document.getElementById("recurring-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("recurring-status");
  const rows = [...document.getElementById("rec-lines-body").querySelectorAll("tr")];
  const endDate = document.getElementById("rec-end").value;

  const res = await apiFetch("/api/recurring-entries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("rec-name").value,
      frequency: document.getElementById("rec-frequency").value,
      start_date: document.getElementById("rec-start").value,
      ...(endDate ? { end_date: endDate } : {}),
      auto_reverse: document.getElementById("rec-auto-reverse").checked,
      lines: rows.map((r) => {
        const debit = Number(r.querySelector(".rec-debit").value) || 0;
        const credit = Number(r.querySelector(".rec-credit").value) || 0;
        return {
          account_id: r.querySelector(".rec-account").value,
          ...(debit ? { debit } : {}),
          ...(credit ? { credit } : {}),
        };
      }),
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Saved "${parsed.name}".`;
  document.getElementById("rec-name").value = "";
  document.getElementById("rec-auto-reverse").checked = false;
  document.getElementById("rec-lines-body").innerHTML = "";
  addRecurringLineRow();
  addRecurringLineRow();
  loadRecurringEntries();
});

async function loadRecurringEntries() {
  const data = await (await apiFetch("/api/recurring-entries")).json();
  const body = document.getElementById("recurring-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="8" class="table-empty-row">No recurring entries yet — add one above.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (t) => `
    <tr>
      <td>${escapeHtml(t.name)}</td>
      <td>${t.frequency}</td>
      <td>${t.start_date}</td>
      <td>${t.last_posted_date || "—"}</td>
      <td>${t.next_due || "—"}</td>
      <td>
        <button type="button" class="rec-auto-reverse-btn linklike" data-id="${t.id}" data-auto-reverse="${t.auto_reverse}">${
          t.auto_reverse ? "On" : "Off"
        }</button>
      </td>
      <td>${t.active ? "Active" : "Paused"}</td>
      <td>
        <button type="button" class="rec-toggle-btn" data-id="${t.id}" data-active="${t.active}">${
          t.active ? "Pause" : "Resume"
        }</button>
        <button type="button" class="rec-delete-btn linklike" data-id="${t.id}">Delete</button>
      </td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".rec-toggle-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await apiFetch(`/api/recurring-entries/${btn.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: btn.dataset.active !== "true" }),
      });
      loadRecurringEntries();
    })
  );
  body.querySelectorAll(".rec-auto-reverse-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await apiFetch(`/api/recurring-entries/${btn.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_reverse: btn.dataset.autoReverse !== "true" }),
      });
      loadRecurringEntries();
    })
  );
  body.querySelectorAll(".rec-delete-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Delete this recurring entry?", "Entries it already posted stay on the books — this only stops future ones.", {
        confirmLabel: "Delete",
        danger: true,
      });
      if (!confirmed) return;
      await apiFetch(`/api/recurring-entries/${btn.dataset.id}`, { method: "DELETE" });
      loadRecurringEntries();
    })
  );
}

function recAsOf() {
  const el = document.getElementById("rec-as-of");
  if (!el.value) el.value = new Date().toISOString().slice(0, 10);
  return el.value;
}

document.getElementById("rec-preview").addEventListener("click", async () => {
  const data = await (await apiFetch(`/api/recurring-entries/pending?as_of=${recAsOf()}`)).json();
  const el = document.getElementById("recurring-run-status");
  el.textContent = data.occurrences
    ? `Would post ${data.occurrences} entr${data.occurrences === 1 ? "y" : "ies"}: ${data.items
        .map((i) => `${i.name} x${i.periods.length}${i.auto_reverse ? " (auto-reverses)" : ""}`)
        .join(", ")}.`
    : "Nothing due through that date.";
});

document.getElementById("recurring-run-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const el = document.getElementById("recurring-run-status");
  const res = await apiFetch("/api/recurring-entries/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ as_of: recAsOf() }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    await alertDialog("Couldn't run those entries", parsed.detail || "Something went wrong.");
    return;
  }
  const bits = [`Posted ${parsed.posted.length} entr${parsed.posted.length === 1 ? "y" : "ies"} (${fmtMoney(parsed.total)}).`];
  const reversed = parsed.posted.filter((p) => p.reversal_entry_id).length;
  if (reversed) bits.push(`${reversed} auto-reversed on their following month's 1st.`);
  // Surfaced rather than swallowed, same reasoning as a skipped occurrence
  // below: a reversal that couldn't post (its month already closed) is
  // exactly the kind of thing that silently produces a double-counted
  // expense next period if nobody is told.
  const reversalFailures = parsed.posted.filter((p) => p.reversal_error);
  if (reversalFailures.length) {
    bits.push(
      `Reversal not posted: ${reversalFailures.map((p) => `${p.template} ${p.entry_date} (${p.reversal_error})`).join("; ")}`
    );
  }
  // Skips are surfaced rather than swallowed -- a template that stopped
  // because its period was closed is exactly what someone needs to know.
  if (parsed.skipped.length) bits.push(`Skipped: ${parsed.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`);
  el.textContent = bits.join(" ");
  loadRecurringEntries();
});

function yeDate() {
  const el = document.getElementById("ye-date");
  if (!el.value) el.value = new Date().toISOString().slice(0, 10);
  return el.value;
}

async function loadYearEnd() {
  const data = await (await apiFetch(`/api/close/year-end?date=${yeDate()}`)).json();
  const el = document.getElementById("year-end-summary");
  const fy = `${data.fiscal_year.label} (${data.fiscal_year.start} to ${data.fiscal_year.end})`;
  if (data.needs_reclose) {
    // Closed, then something landed in the year afterwards. The books are
    // still right -- the balance sheet derives whatever the closing entry
    // missed -- but the accounts no longer stand at zero.
    el.textContent = `${fy} is closed, but ${fmtMoney(
      data.unclosed_since_close
    )} of activity has posted since. Your totals are still correct; reopen and close again to zero the accounts, ideally after locking the months in Month-End Close.`;
  } else if (data.already_closed) {
    el.textContent = `${fy} is closed.`;
  } else {
    el.textContent = `${fy}: revenue ${fmtMoney(data.revenue)}, expenses ${fmtMoney(
      data.expenses
    )}, net income ${fmtMoney(data.net_income)} across ${data.accounts} account${data.accounts === 1 ? "" : "s"}.`;
  }
}

document.getElementById("year-end-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const confirmed = await confirmDialog(
    "Close this fiscal year?",
    "Revenue and expense accounts are zeroed into Retained Earnings, dated to the last day of the year. Your reports are unaffected — the P&L still shows the year, and total equity doesn't change. Reversible with Reopen.",
    { confirmLabel: "Close year" }
  );
  if (!confirmed) return;

  const res = await apiFetch("/api/close/year-end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: yeDate() }),
  });
  const parsed = await res.json().catch(() => ({}));
  const el = document.getElementById("year-end-status");
  if (!res.ok) {
    el.textContent = "";
    await alertDialog("Couldn't close that year", parsed.detail || "Something went wrong.");
    return;
  }
  el.textContent = `${parsed.fiscal_year.label} closed.`;
  loadYearEnd();
});

document.getElementById("ye-reopen").addEventListener("click", async () => {
  const confirmed = await confirmDialog("Reopen this fiscal year?", "The closing entry is reversed and the revenue and expense balances come back.", {
    confirmLabel: "Reopen",
  });
  if (!confirmed) return;
  const res = await apiFetch("/api/close/year-end/reopen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: yeDate() }),
  });
  const parsed = await res.json().catch(() => ({}));
  const el = document.getElementById("year-end-status");
  if (!res.ok) {
    await alertDialog("Couldn't reopen that year", parsed.detail || "Something went wrong.");
    return;
  }
  el.textContent = `${parsed.fiscal_year.label} reopened.`;
  loadYearEnd();
});

document.getElementById("revenue-recognize-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("revenue-recognize-status");
  const period = revPeriod();

  const confirmed = await confirmDialog(
    `Recognize revenue through ${period}?`,
    "This posts a journal entry for each period, dated to the end of the month it recognizes. Any earlier month that was never run is caught up too.",
    { confirmLabel: "Recognize" }
  );
  if (!confirmed) return;

  const res = await apiFetch("/api/revenue/recognize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ period_month: period }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = "";
    await alertDialog("Couldn't recognize that period", parsed.detail || "Something went wrong.");
    return;
  }
  statusEl.textContent = parsed.periods.length
    ? `Recognized ${fmtMoney(parsed.recognized)} across ${parsed.periods.length} period${
        parsed.periods.length === 1 ? "" : "s"
      }.`
    : `Nothing was pending through ${period}.`;
  loadDeferredRevenue();
});

// ---- Payables (bill payments, AP aging) ----
// The AP side of the ledger -- see accountsPayable.js on the backend.
// Approving a bill records that you owe it; paying it here is what clears
// the payable off the books.

// Accounts a bill can be paid *from*: assets and liabilities, minus
// Accounts Payable itself (paying from AP posts Debit AP / Credit AP,
// which balances and moves nothing). A credit card is deliberately
// included -- paying a bill with one swaps one liability for another.
let bpPaymentAccounts = [];
let rbExpenseAccounts = [];

async function loadPaymentAccounts() {
  await cachedLoad(
    "__payment_accounts__",
    async () => (await apiFetch("/api/accounts?active=true")).json(),
    ({ items }) => {
      // Mirrors accountsPayable.js's isValidPaymentAccount: assets and
      // liabilities, minus the two control accounts. Paying from AP posts
      // Debit AP / Credit AP and moves nothing; crediting AR to pay a
      // vendor reads as a customer having settled their invoice.
      bpPaymentAccounts = items.filter(
        (a) =>
          ["asset", "liability"].includes(a.type) &&
          !["accounts_payable", "accounts_receivable"].includes(a.subtype)
      );
      // What a recurring bill's occurrence can post to -- mirrors
      // postInvoiceApproval (ledger.js), which always debits a single
      // expense account.
      rbExpenseAccounts = items.filter((a) => a.type === "expense");
    }
  );
}

async function loadRecurringBillFormData() {
  await loadPaymentAccounts();
  document.getElementById("rb-account").innerHTML = groupedAccountOptionsHtml(rbExpenseAccounts, null);
  document.getElementById("vcm-account").innerHTML = groupedAccountOptionsHtml(rbExpenseAccounts, null);
}

async function loadBillPayments() {
  const showAll = document.getElementById("bp-filter").value === "all";
  const data = await (await apiFetch(`/api/bills?outstanding=${showAll ? "false" : "true"}`)).json();
  renderBillPayments(data.items);
}

function renderBillPayments(rows) {
  const body = document.getElementById("bill-payments-body");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="table-empty-row">Nothing owed — every approved bill is paid.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.vendor_name || "—")}</td>
      <td>${escapeHtml(r.invoice_number || "—")}</td>
      <td>${r.due_date || "—"}</td>
      <td>${fmtMoney(r.total)}</td>
      <td>${fmtMoney(r.amount_paid)}</td>
      <td>${fmtMoney(r.amount_outstanding)}</td>
      <td>${
        r.amount_outstanding > 0
          ? `<button type="button" class="bp-pay-btn" data-id="${r.invoice_id}" data-outstanding="${r.amount_outstanding}">Record payment</button>
             <button type="button" class="bp-write-check-btn" data-id="${r.invoice_id}" data-outstanding="${r.amount_outstanding}" data-vendor="${escapeHtml(
              r.vendor_name || ""
            )}">Write check</button>`
          : ""
      }</td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".bp-pay-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const payment = await paymentDialog(Number(btn.dataset.outstanding), {
        title: "Record a bill payment",
        dateLabel: "Date paid",
        accountLabel: "Pay from",
        accounts: bpPaymentAccounts,
        emptyTitle: "No account to pay from",
        emptyMessage: "Add a bank, cash, or credit card account to your chart of accounts first.",
        allowDiscount: true,
      });
      if (!payment) return;

      const res = await apiFetch(`/api/invoices/${btn.dataset.id}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: payment.amount,
          payment_date: payment.payment_date,
          payment_account_id: payment.account_id,
          discount: payment.discount || 0,
        }),
      });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) {
        await alertDialog("Couldn't record that payment", parsed.detail || "Something went wrong.");
        return;
      }
      invalidateCache("__ap_aging__");
      loadBillPayments();
    })
  );

  body.querySelectorAll(".bp-write-check-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!bpPaymentAccounts.length) {
        await alertDialog("No account to pay from", "Add a bank, cash, or credit card account to your chart of accounts first.");
        return;
      }
      const check = await writeCheckDialog(Number(btn.dataset.outstanding), btn.dataset.vendor);
      if (!check) return;

      const res = await apiFetch("/api/written-checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: btn.dataset.id, ...check }),
      });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) {
        await alertDialog("Couldn't write that check", parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.");
        return;
      }
      invalidateCache("__ap_aging__");
      loadBillPayments();
      loadWrittenChecks();
    })
  );
}

document.getElementById("bp-filter").addEventListener("change", loadBillPayments);

// ---- Writing checks ----
// See writtenChecks.js. Each one posts the exact same bill payment
// "Record payment" above does, with a check number, payee, and memo on
// top, plus a printable layout.

let writeCheckModalResolve = null;

function writeCheckDialog(outstanding, vendorName) {
  document.getElementById("write-check-message").textContent = `Outstanding balance is ${fmtMoney(outstanding)}.`;
  document.getElementById("write-check-number").value = "";
  document.getElementById("write-check-payee").value = vendorName || "";
  document.getElementById("write-check-amount").value = outstanding.toFixed(2);
  document.getElementById("write-check-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("write-check-account").innerHTML = groupedAccountOptionsHtml(bpPaymentAccounts, null);
  document.getElementById("write-check-discount").value = "";
  document.getElementById("write-check-memo").value = "";
  const errorEl = document.getElementById("write-check-error");
  errorEl.textContent = "";
  errorEl.style.display = "none";
  document.getElementById("write-check-modal").style.display = "flex";
  document.getElementById("write-check-number").focus();

  return new Promise((resolve) => {
    writeCheckModalResolve = resolve;
  });
}

function closeWriteCheckModal(result) {
  document.getElementById("write-check-modal").style.display = "none";
  if (writeCheckModalResolve) {
    writeCheckModalResolve(result);
    writeCheckModalResolve = null;
  }
}

document.getElementById("write-check-cancel").addEventListener("click", () => closeWriteCheckModal(null));

document.getElementById("write-check-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById("write-check-amount").value);
  const errorEl = document.getElementById("write-check-error");
  if (!(amount > 0)) {
    errorEl.textContent = "Enter an amount greater than zero.";
    errorEl.style.display = "";
    return;
  }
  closeWriteCheckModal({
    check_number: document.getElementById("write-check-number").value,
    payee_name: document.getElementById("write-check-payee").value,
    amount,
    check_date: document.getElementById("write-check-date").value,
    payment_account_id: document.getElementById("write-check-account").value,
    discount: Number(document.getElementById("write-check-discount").value) || 0,
    memo: document.getElementById("write-check-memo").value,
  });
});

async function loadWrittenChecks() {
  const data = await (await apiFetch("/api/written-checks")).json();
  const body = document.getElementById("written-checks-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="6" class="table-empty-row">No checks written yet.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (c) => `
    <tr>
      <td>${escapeHtml(c.check_number)}</td>
      <td>${escapeHtml(c.payee_name)}</td>
      <td>${c.check_date}</td>
      <td>${escapeHtml(c.vendor_name || "—")}${c.invoice_number ? ` (${escapeHtml(c.invoice_number)})` : ""}</td>
      <td>${fmtMoney(c.amount)}</td>
      <td>
        <button type="button" class="wc-print-btn linklike" data-id="${c.id}">Print</button>
        <button type="button" class="wc-void-btn linklike" data-id="${c.id}">Void</button>
      </td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".wc-print-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const check = data.items.find((c) => c.id === btn.dataset.id);
      if (check) printWrittenCheck(check);
    })
  );
  body.querySelectorAll(".wc-void-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Void this check?", "Reverses the payment it made -- the reversal stays on the books alongside the original, same as any other void.", {
        confirmLabel: "Void",
        danger: true,
      });
      if (!confirmed) return;
      await apiFetch(`/api/written-checks/${btn.dataset.id}`, { method: "DELETE" });
      invalidateCache("__ap_aging__");
      loadBillPayments();
      loadWrittenChecks();
    })
  );
}

// ---- Recurring bills ----
// See recurringBills.js. The AP mirror of the recurring invoices section
// above -- one flat amount and one expense account per template, since
// postInvoiceApproval has never split an approved bill across more than one
// expense account.

document.getElementById("recurring-bill-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("recurring-bill-status");
  const endDate = document.getElementById("rb-end").value;

  const res = await apiFetch("/api/recurring-bills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vendor_name: document.getElementById("rb-vendor").value,
      expense_account_id: document.getElementById("rb-account").value,
      name: document.getElementById("rb-name").value,
      amount: Number(document.getElementById("rb-amount").value) || 0,
      frequency: document.getElementById("rb-frequency").value,
      start_date: document.getElementById("rb-start").value,
      ...(endDate ? { end_date: endDate } : {}),
      auto_approve: document.getElementById("rb-auto-approve").checked,
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Saved "${parsed.name}".`;
  document.getElementById("rb-vendor").value = "";
  document.getElementById("rb-name").value = "";
  document.getElementById("rb-amount").value = "";
  document.getElementById("rb-auto-approve").checked = false;
  loadRecurringBills();
});

async function loadRecurringBills() {
  const data = await (await apiFetch("/api/recurring-bills")).json();
  const body = document.getElementById("recurring-bills-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="9" class="table-empty-row">No recurring bills yet — add one above.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (t) => `
    <tr>
      <td>${escapeHtml(t.name)}</td>
      <td>${escapeHtml(t.vendor_name)}</td>
      <td>${escapeHtml(t.expense_account_name || "—")}</td>
      <td>${fmtMoney(t.amount)}</td>
      <td>${t.frequency}</td>
      <td>${t.last_issued_date || "—"}</td>
      <td>${t.next_due || "—"}</td>
      <td>
        <button type="button" class="rb-auto-approve-btn linklike" data-id="${t.id}" data-auto-approve="${t.auto_approve}">${
          t.auto_approve ? "On" : "Off"
        }</button>
      </td>
      <td>${t.active ? "Active" : "Paused"}</td>
      <td>
        <button type="button" class="rb-toggle-btn" data-id="${t.id}" data-active="${t.active}">${
          t.active ? "Pause" : "Resume"
        }</button>
        <button type="button" class="rb-delete-btn linklike" data-id="${t.id}">Delete</button>
      </td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".rb-toggle-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await apiFetch(`/api/recurring-bills/${btn.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: btn.dataset.active !== "true" }),
      });
      loadRecurringBills();
    })
  );
  body.querySelectorAll(".rb-auto-approve-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await apiFetch(`/api/recurring-bills/${btn.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_approve: btn.dataset.autoApprove !== "true" }),
      });
      loadRecurringBills();
    })
  );
  body.querySelectorAll(".rb-delete-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Delete this recurring bill?", "Bills it already created stay — this only stops future ones.", {
        confirmLabel: "Delete",
        danger: true,
      });
      if (!confirmed) return;
      await apiFetch(`/api/recurring-bills/${btn.dataset.id}`, { method: "DELETE" });
      loadRecurringBills();
    })
  );
}

function rbAsOf() {
  const el = document.getElementById("rb-as-of");
  if (!el.value) el.value = new Date().toISOString().slice(0, 10);
  return el.value;
}

document.getElementById("rb-preview").addEventListener("click", async () => {
  const data = await (await apiFetch(`/api/recurring-bills/pending?as_of=${rbAsOf()}`)).json();
  const el = document.getElementById("recurring-bill-run-status");
  el.textContent = data.occurrences
    ? `Would issue ${data.occurrences} bill${data.occurrences === 1 ? "" : "s"}: ${data.items
        .map((i) => `${i.name} x${i.periods.length}${i.auto_approve ? " (auto-approves)" : ""}`)
        .join(", ")}.`
    : "Nothing due through that date.";
});

document.getElementById("recurring-bill-run-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const el = document.getElementById("recurring-bill-run-status");
  const res = await apiFetch("/api/recurring-bills/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ as_of: rbAsOf() }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    await alertDialog("Couldn't run those bills", parsed.detail || "Something went wrong.");
    return;
  }
  const approvedCount = parsed.issued.filter((i) => i.approved).length;
  const bits = [`Issued ${parsed.issued.length} bill${parsed.issued.length === 1 ? "" : "s"} (${fmtMoney(parsed.total)}).`];
  if (approvedCount) bits.push(`${approvedCount} auto-approved.`);
  if (parsed.skipped.length) bits.push(`Skipped: ${parsed.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`);
  el.textContent = bits.join(" ");
  invalidateCache("__ap_aging__");
  loadBillPayments();
  loadRecurringBills();
});

// ---- Vendor credit memos ----
// See accountsPayable.js's postVendorCreditMemo/applyVendorCreditMemoToBill.
// The AP mirror of the customer credit memos section above -- one flat
// amount and one expense account, same reasoning as recurring bills.

document.getElementById("vendor-credit-memo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("vendor-credit-memo-status");
  const res = await apiFetch("/api/vendor-credit-memos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vendor_name: document.getElementById("vcm-vendor").value,
      expense_account_id: document.getElementById("vcm-account").value,
      issue_date: document.getElementById("vcm-date").value,
      amount: Number(document.getElementById("vcm-amount").value) || 0,
      memo: document.getElementById("vcm-memo").value,
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = `Issued ${parsed.credit_number}.`;
  document.getElementById("vcm-vendor").value = "";
  document.getElementById("vcm-amount").value = "";
  document.getElementById("vcm-memo").value = "";
  invalidateCache("__ap_aging__");
  loadVendorCreditMemos();
  loadBillPayments();
});

async function loadVendorCreditMemos() {
  const data = await (await apiFetch("/api/vendor-credit-memos")).json();
  renderVendorCreditMemos(data);
}

let applyVendorCreditModalResolve = null;

function renderVendorCreditMemos(data) {
  const body = document.getElementById("vendor-credit-memos-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="7" class="table-empty-row">No vendor credit memos yet.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (m) => `
    <tr>
      <td>${escapeHtml(m.credit_number)}</td>
      <td>${escapeHtml(m.vendor_name)}</td>
      <td>${m.issue_date}</td>
      <td>${fmtMoney(m.amount)}</td>
      <td>${fmtMoney(m.unapplied)}</td>
      <td>${m.status}</td>
      <td>
        ${
          m.status === "issued" && m.unapplied > 0
            ? `<button type="button" class="vcm-apply-btn" data-id="${m.id}" data-vendor="${escapeHtml(m.vendor_name)}" data-unapplied="${m.unapplied}">Apply to bill</button>`
            : ""
        }
        ${m.status === "issued" ? `<button type="button" class="vcm-void-btn linklike" data-id="${m.id}">Void</button>` : ""}
      </td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".vcm-void-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog(
        "Void this credit memo?",
        "This posts a reversing entry. The credit memo stays on record either way.",
        { confirmLabel: "Void", danger: true }
      );
      if (!confirmed) return;
      const res = await apiFetch(`/api/vendor-credit-memos/${btn.dataset.id}/void`, { method: "POST" });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) {
        await alertDialog("Couldn't void that", parsed.detail || "Something went wrong.");
        return;
      }
      invalidateCache("__ap_aging__");
      loadVendorCreditMemos();
    })
  );

  body.querySelectorAll(".vcm-apply-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const result = await applyVendorCreditDialog(btn.dataset.vendor, Number(btn.dataset.unapplied));
      if (!result) return;
      const res = await apiFetch(`/api/vendor-credit-memos/${btn.dataset.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) {
        await alertDialog("Couldn't apply that credit", parsed.detail || "Something went wrong.");
        return;
      }
      invalidateCache("__ap_aging__");
      loadVendorCreditMemos();
      loadBillPayments();
    })
  );
}

// Which of this vendor's bills still have a balance a credit could offset.
// Matched by name against the same /api/bills list Bill Payments shows --
// the server does the authoritative resolved-vendor-identity check when the
// apply actually posts, so a name match here is only ever a convenience
// filter, never the source of truth.
async function openBillsForVendor(vendorName) {
  const data = await (await apiFetch("/api/bills?outstanding=true")).json();
  return data.items.filter((b) => b.vendor_name === vendorName);
}

async function applyVendorCreditDialog(vendorName, unappliedDollars) {
  const bills = await openBillsForVendor(vendorName);
  if (!bills.length) {
    await alertDialog("No open bills", "This vendor has no open bills to apply a credit to.");
    return null;
  }

  document.getElementById("apply-vendor-credit-modal-message").textContent = `${fmtMoney(unappliedDollars)} unapplied on this credit memo.`;
  document.getElementById("apply-vendor-credit-modal-bill").innerHTML = bills
    .map(
      (b) =>
        `<option value="${b.invoice_id}" data-outstanding="${b.amount_outstanding}">${escapeHtml(b.invoice_number || b.invoice_id.slice(0, 8))} -- ${fmtMoney(b.amount_outstanding)} outstanding</option>`
    )
    .join("");
  const amountEl = document.getElementById("apply-vendor-credit-modal-amount");
  const billEl = document.getElementById("apply-vendor-credit-modal-bill");
  const setDefaultAmount = () => {
    const outstanding = Number(billEl.selectedOptions[0]?.dataset.outstanding || 0);
    amountEl.value = Math.min(unappliedDollars, outstanding).toFixed(2);
  };
  billEl.onchange = setDefaultAmount;
  setDefaultAmount();
  document.getElementById("apply-vendor-credit-modal-date").value = new Date().toISOString().slice(0, 10);
  const errorEl = document.getElementById("apply-vendor-credit-modal-error");
  errorEl.textContent = "";
  errorEl.style.display = "none";
  document.getElementById("apply-vendor-credit-modal").style.display = "flex";
  amountEl.focus();

  return new Promise((resolve) => {
    applyVendorCreditModalResolve = resolve;
  });
}

function closeApplyVendorCreditModal(result) {
  document.getElementById("apply-vendor-credit-modal").style.display = "none";
  if (applyVendorCreditModalResolve) {
    applyVendorCreditModalResolve(result);
    applyVendorCreditModalResolve = null;
  }
}

document.getElementById("apply-vendor-credit-modal-cancel").addEventListener("click", () => closeApplyVendorCreditModal(null));

document.getElementById("apply-vendor-credit-modal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const amount = Number(document.getElementById("apply-vendor-credit-modal-amount").value);
  const errorEl = document.getElementById("apply-vendor-credit-modal-error");
  if (!(amount > 0)) {
    errorEl.textContent = "Enter an amount greater than zero.";
    errorEl.style.display = "";
    return;
  }
  closeApplyVendorCreditModal({
    invoice_id: document.getElementById("apply-vendor-credit-modal-bill").value,
    amount,
    applied_date: document.getElementById("apply-vendor-credit-modal-date").value,
  });
});

// Standard check-printing convention: the amount spelled out in words is
// what actually controls if the numerals and the words ever disagree, so a
// printable check without it is not a usable one. Handles anything up to
// 999,999,999.99, which is every amount this app's own zod amount schemas
// allow through.
const NUMBER_WORDS_ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const NUMBER_WORDS_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function threeDigitsInWords(n) {
  const parts = [];
  if (n >= 100) {
    parts.push(`${NUMBER_WORDS_ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(NUMBER_WORDS_TENS[Math.floor(n / 10)] + (n % 10 ? `-${NUMBER_WORDS_ONES[n % 10].toLowerCase()}` : ""));
  } else if (n > 0) {
    parts.push(NUMBER_WORDS_ONES[n]);
  }
  return parts.join(" ");
}

function amountInWords(amount) {
  const wholeDollars = Math.floor(amount);
  const cents = Math.round((amount - wholeDollars) * 100);

  if (wholeDollars === 0) return `Zero and ${String(cents).padStart(2, "0")}/100 dollars`;

  const groups = [];
  let n = wholeDollars;
  const groupNames = ["", "Thousand", "Million"];
  let groupIndex = 0;
  while (n > 0 && groupIndex < groupNames.length) {
    const chunk = n % 1000;
    if (chunk > 0) {
      groups.unshift(`${threeDigitsInWords(chunk)}${groupNames[groupIndex] ? ` ${groupNames[groupIndex]}` : ""}`);
    }
    n = Math.floor(n / 1000);
    groupIndex += 1;
  }
  return `${groups.join(" ")} and ${String(cents).padStart(2, "0")}/100 dollars`;
}

function printWrittenCheck(check) {
  const win = window.open("", "_blank", "width=800,height=400");
  if (!win) return;
  win.document.write(`
    <!doctype html>
    <html>
    <head>
      <title>Check #${escapeHtml(check.check_number)}</title>
      <style>
        body { font-family: Georgia, serif; padding: 2rem; color: #101a33; }
        .check { border: 1px solid #999; padding: 1.5rem; max-width: 640px; }
        .row { display: flex; justify-content: space-between; margin-bottom: 1rem; }
        .payee-line { border-bottom: 1px solid #333; padding: 0.25rem 0; flex: 1; margin-right: 1rem; }
        .amount-box { border: 1px solid #333; padding: 0.4rem 0.8rem; }
        .words-line { border-bottom: 1px solid #333; padding: 0.25rem 0; }
        .memo { margin-top: 1.5rem; font-size: 0.85rem; color: #444; }
      </style>
    </head>
    <body onload="window.print()">
      <div class="check">
        <div class="row"><span>Check #${escapeHtml(check.check_number)}</span><span>${check.check_date}</span></div>
        <div class="row"><span class="payee-line">Pay to the order of: ${escapeHtml(check.payee_name)}</span><span class="amount-box">${fmtMoney(check.amount)}</span></div>
        <div class="words-line">${escapeHtml(amountInWords(check.amount))}</div>
        ${check.memo ? `<div class="memo">Memo: ${escapeHtml(check.memo)}</div>` : ""}
        <div class="memo">Paid from: ${escapeHtml(check.payment_account_name || "")}</div>
      </div>
    </body>
    </html>
  `);
  win.document.close();
}

async function loadApAging() {
  const asOfEl = document.getElementById("ap-as-of");
  if (!asOfEl.value) asOfEl.value = new Date().toISOString().slice(0, 10);
  renderApAging(await (await apiFetch(`/api/reports/ap-aging?as_of=${asOfEl.value}`)).json());
}

function renderApAging(data) {
  const body = document.getElementById("ap-aging-body");
  if (!data.vendors.length) {
    body.innerHTML = `<tr><td colspan="7" class="table-empty-row">Nothing outstanding — every approved bill is paid.</td></tr>`;
  } else {
    body.innerHTML = data.vendors
      .map(
        (row) => `
      <tr>
        <td>${escapeHtml(row.vendor_name)}${
          row.discount_available
            ? `<div class="ap-aging-discount">Save ${fmtMoney(row.discount_available)} by ${row.discount_deadline}</div>`
            : ""
        }</td>
        ${AGING_BUCKET_KEYS.map((k) => `<td>${row[k] ? fmtMoney(row[k]) : ""}</td>`).join("")}
        <td>${fmtMoney(row.total)}</td>
      </tr>
    `
      )
      .join("");
  }
  document.getElementById("ap-aging-totals").innerHTML =
    `<th>Total</th>${AGING_BUCKET_KEYS.map((k) => `<th>${fmtMoney(data.totals[k])}</th>`).join("")}<th>${fmtMoney(
      data.totals.total
    )}</th>`;

  const summaryEl = document.getElementById("ap-aging-discount-summary");
  summaryEl.textContent = data.totals.discount_available
    ? `${fmtMoney(data.totals.discount_available)} available in early-payment discounts if paid within their windows.`
    : "";
}

document.getElementById("ap-aging-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadApAging();
});

// ---- 1099-NEC prep ----
// Which vendors crossed the reporting threshold this year, and whether
// each has a TIN on file or has been marked exempt (see form1099.js).

async function loadForm1099() {
  const yearEl = document.getElementById("form1099-year");
  if (!yearEl.value) yearEl.value = new Date().getFullYear();
  renderForm1099(await (await apiFetch(`/api/reports/1099-nec?year=${yearEl.value}`)).json());
}

function form1099StatusHtml(row) {
  if (row.exempt) return `<span class="hint">Exempt</span>`;
  if (row.missing_tin) return `<span class="kpi-sub-warning">Missing TIN</span>`;
  return "TIN on file";
}

function renderForm1099(data) {
  const body = document.getElementById("form1099-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="5" class="table-empty-row">No vendor has crossed the ${fmtMoney(data.threshold)} threshold this year.</td></tr>`;
    return;
  }
  body.innerHTML = data.items
    .map(
      (row) => `
    <tr>
      <td>${escapeHtml(row.vendor_name)}</td>
      <td>${fmtMoney(row.total)}</td>
      <td>
        <input type="text" class="form1099-tax-id-input" data-vendor-id="${row.vendor_id}" placeholder="${row.tax_id_last4 ? `on file, ending ${escapeHtml(row.tax_id_last4)}` : "Enter TIN"}" style="width: 10rem;" />
        <button type="button" class="form1099-save-tax-id-btn linklike" data-vendor-id="${row.vendor_id}">Save</button>
      </td>
      <td>${form1099StatusHtml(row)}</td>
      <td><button type="button" class="form1099-exempt-btn linklike" data-vendor-id="${row.vendor_id}" data-exempt="${row.exempt}">${row.exempt ? "Un-exempt" : "Mark exempt"}</button></td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".form1099-save-tax-id-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const input = body.querySelector(`.form1099-tax-id-input[data-vendor-id="${btn.dataset.vendorId}"]`);
      if (!input.value.trim()) return;
      await apiFetch(`/api/vendors/${btn.dataset.vendorId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tax_id: input.value.trim() }),
      });
      loadForm1099();
    })
  );

  body.querySelectorAll(".form1099-exempt-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await apiFetch(`/api/vendors/${btn.dataset.vendorId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ form_1099_exempt: btn.dataset.exempt !== "true" }),
      });
      loadForm1099();
    })
  );
}

document.getElementById("form1099-year-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadForm1099();
});

// ---- Vendors ----
// Who the org buys from. Created automatically when a bill naming them is
// approved (see vendors.js), so this tab is mostly about the one thing
// automatic resolution can't do: deciding that two differently-spelled
// names are the same company.

let vendorList = [];

async function loadVendors() {
  const data = await (await apiFetch("/api/vendors")).json();
  vendorList = data.items;
  renderVendors(data.items);
}

function renderVendors(items) {
  const body = document.getElementById("vendors-body");
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="8" class="table-empty-row">No vendors yet — approve a bill, or add one above.</td></tr>`;
    return;
  }
  body.innerHTML = items
    .map(
      (v) => `
    <tr>
      <td>${escapeHtml(v.name)}</td>
      <td class="hint">${v.aliases.length ? escapeHtml(v.aliases.join(", ")) : "—"}</td>
      <td>Net ${v.payment_terms_days}</td>
      <td>${v.early_pay_discount_pct && v.early_pay_discount_days ? `${v.early_pay_discount_pct}% / ${v.early_pay_discount_days}d` : "—"}</td>
      <td>${v.bill_count}</td>
      <td>${fmtMoney(v.amount_outstanding)}</td>
      <td>${v.active ? "Active" : "Inactive"}</td>
      <td>
        <button type="button" class="vendor-statement-btn linklike" data-id="${v.id}" data-name="${escapeHtml(v.name)}">Statement</button>
        ${items.length > 1 ? `<button type="button" class="vendor-merge-btn" data-id="${v.id}" data-name="${escapeHtml(v.name)}">Merge</button>` : ""}
        ${v.active ? `<button type="button" class="vendor-deactivate-btn linklike" data-id="${v.id}">Deactivate</button>` : ""}
      </td>
    </tr>
  `
    )
    .join("");

  body.querySelectorAll(".vendor-statement-btn").forEach((btn) =>
    btn.addEventListener("click", () => openStatementModal(btn.dataset.id, btn.dataset.name, "vendor"))
  );

  body.querySelectorAll(".vendor-merge-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const targetId = await mergeDialog(btn.dataset.id, btn.dataset.name);
      if (!targetId) return;
      const res = await apiFetch(`/api/vendors/${btn.dataset.id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ into_vendor_id: targetId }),
      });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) {
        await alertDialog("Couldn't merge those vendors", parsed.detail || "Something went wrong.");
        return;
      }
      loadVendors();
    })
  );

  body.querySelectorAll(".vendor-deactivate-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const confirmed = await confirmDialog("Deactivate this vendor?", "Their past bills stay exactly as they are; you just won't be able to pick them for new ones.", {
        confirmLabel: "Deactivate",
        danger: true,
      });
      if (!confirmed) return;
      await apiFetch(`/api/vendors/${btn.dataset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      loadVendors();
    })
  );
}

document.getElementById("vendor-create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("vendor-create-status");
  const res = await apiFetch("/api/vendors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: document.getElementById("vendor-create-name").value,
      email: document.getElementById("vendor-create-email").value,
      payment_terms_days: Number(document.getElementById("vendor-create-terms").value) || 30,
      early_pay_discount_pct: document.getElementById("vendor-create-discount-pct").value
        ? Number(document.getElementById("vendor-create-discount-pct").value)
        : null,
      early_pay_discount_days: document.getElementById("vendor-create-discount-days").value
        ? Number(document.getElementById("vendor-create-discount-days").value)
        : null,
    }),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = parsed.detail?.[0]?.message || parsed.detail || "Something went wrong.";
    return;
  }
  statusEl.textContent = "";
  e.target.reset();
  document.getElementById("vendor-create-terms").value = "30";
  loadVendors();
});

// Resolves to the id of the vendor to merge into, or null if dismissed.
let mergeModalResolve = null;

function mergeDialog(loserId, loserName) {
  const options = vendorList.filter((v) => v.id !== loserId);
  document.getElementById("merge-modal-message").textContent =
    `"${loserName}" and its bills will move to the vendor you pick, and this row will disappear.`;
  document.getElementById("merge-modal-target").innerHTML = options
    .map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`)
    .join("");
  const errorEl = document.getElementById("merge-modal-error");
  errorEl.textContent = "";
  errorEl.style.display = "none";
  document.getElementById("merge-modal").style.display = "flex";

  return new Promise((resolve) => {
    mergeModalResolve = resolve;
  });
}

function closeMergeModal(result) {
  document.getElementById("merge-modal").style.display = "none";
  if (mergeModalResolve) {
    mergeModalResolve(result);
    mergeModalResolve = null;
  }
}

document.getElementById("merge-modal-cancel").addEventListener("click", () => closeMergeModal(null));

document.getElementById("merge-modal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  closeMergeModal(document.getElementById("merge-modal-target").value || null);
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
// `meter` is a 0-1 fill shown as a hairline bar under the value -- only
// passed where a real denominator exists (the plan's document cap). There is
// deliberately no delta badge here: the dashboard payload carries no
// prior-period figures, and a "+12%" with nothing behind it is worse than no
// badge at all. The one place a genuine comparison exists is the volume
// panel, which computes it from its own 14-day series.
function kpiCard({ label, value, sub, subTone = "", accent = "", meter = null }) {
  const meterBar =
    meter === null
      ? ""
      : `<span class="kpi-meter"><span class="kpi-meter-fill" style="width: ${Math.min(100, meter * 100).toFixed(
          1
        )}%"></span></span>`;
  return `
    <div class="kpi-card${accent ? ` kpi-${accent}` : ""}">
      <span class="kpi-label">${label}</span>
      <span class="kpi-value">${value}</span>
      ${meterBar}
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
      // Only where there's a real denominator -- an uncapped plan has
      // nothing to be a fraction of.
      meter: k.document_cap ? k.documents_used_this_month / k.document_cap : null,
      accent: capPct >= 90 ? "bad" : "",
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
    el.innerHTML = `<p class="dash-empty">Nothing processed in the last 14 days. <button type="button" class="linklike" data-tab="review">Upload a document</button> to get started.</p>`;
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

  // A real week-over-week comparison, not a decorative one: the series is
  // exactly 14 days, so its two halves are two complete 7-day windows. Shown
  // only when the prior week actually had volume -- "+300%" off a base of 1,
  // or any percentage at all off a base of 0, says nothing true.
  const half = Math.floor(trend.length / 2);
  const priorWeek = trend.slice(0, half).reduce((sum, d) => sum + d.count, 0);
  const thisWeek = trend.slice(half).reduce((sum, d) => sum + d.count, 0);
  const pctChange = priorWeek ? Math.round(((thisWeek - priorWeek) / priorWeek) * 100) : null;
  const deltaBadge =
    pctChange === null
      ? ""
      : `<span class="vol-delta vol-delta-${pctChange > 0 ? "up" : pctChange < 0 ? "down" : "flat"}">${
          pctChange > 0 ? "↑" : pctChange < 0 ? "↓" : "±"
        } ${Math.abs(pctChange)}%</span>
         <span class="vol-delta-note">vs prior 7 days</span>`;

  el.innerHTML = `
    <div class="vol-summary">
      <strong>${total}</strong>
      <span class="vol-summary-unit">document${total === 1 ? "" : "s"} processed</span>
      ${deltaBadge}
    </div>
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

  // Fetched and rendered independently of the block above -- a slow or
  // failed /trends call is a heavier, secondary read and shouldn't block
  // (or fail alongside) the KPIs every dashboard visit actually needs.
  try {
    const trendsRes = await apiFetch("/api/dashboard/trends");
    const trends = await trendsRes.json();
    if (trendsRes.ok) {
      renderMonthOverMonth(trends.month_over_month);
      renderTrendCharts(trends.weekly);
      renderVendorSpend(trends.vendor_spend);
    }
  } catch {
    // Non-critical: leave the loading skeletons rather than adding a
    // second error banner for a secondary panel.
  }
}

function momDeltaBadge(pctChange) {
  if (pctChange === null || pctChange === undefined) return "";
  const dir = pctChange > 0 ? "up" : pctChange < 0 ? "down" : "flat";
  const arrow = pctChange > 0 ? "↑" : pctChange < 0 ? "↓" : "±";
  return `<span class="vol-delta vol-delta-${dir}">${arrow} ${Math.abs(pctChange)}%</span>`;
}

function renderMonthOverMonth(mom) {
  const el = document.getElementById("dash-mom");
  el.innerHTML = `
    <div class="mom-tile">
      <span class="mom-label">Approved value</span>
      <strong class="mom-value">${fmtMoney(mom.approved_value.current)}</strong>
      ${momDeltaBadge(mom.approved_value.pct_change)}
    </div>
    <div class="mom-tile">
      <span class="mom-label">Documents processed</span>
      <strong class="mom-value">${mom.documents_processed.current}</strong>
      ${momDeltaBadge(mom.documents_processed.pct_change)}
    </div>
    <div class="mom-tile">
      <span class="mom-label">Touchless rate</span>
      <strong class="mom-value">${mom.touchless_rate.current === null ? "—" : fmtPct(mom.touchless_rate.current)}</strong>
      ${momDeltaBadge(mom.touchless_rate.pct_change)}
    </div>
  `;
}

// Two compact 13-week bar charts sharing the same inline-SVG-free approach
// as renderVolumeChart above (a dependency costs more here than it saves).
// A null week (no approvals that week, or no finished extractions) gets the
// same fixed hairline stub as a zero-count day there, for the same reason:
// a true 0% bar and "nothing to measure that week" must not look identical.
function renderTrendCharts(weekly) {
  const el = document.getElementById("dash-trend-charts");
  const hasAnyData = weekly.some((w) => w.avg_confidence !== null || w.touchless_rate !== null);
  if (!hasAnyData) {
    el.innerHTML = `<p class="dash-empty">Not enough history yet for a trend -- check back after a few weeks of activity.</p>`;
    return;
  }

  function miniChart(label, values) {
    const bars = values
      .map((v, i) => {
        const weekStart = new Date(`${weekly[i].week_start}T00:00:00Z`).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        });
        const pct = v === null ? 0 : Math.round(v * 100);
        const height = v === null ? "3px" : `${Math.max(pct, 4)}%`;
        const title = v === null ? `Week of ${weekStart}: no data` : `Week of ${weekStart}: ${fmtPct(v)}`;
        return `
        <div class="trend-bar-wrap" title="${title}">
          <div class="trend-bar${v === null ? " is-zero" : ""}" style="height: ${height}"></div>
        </div>`;
      })
      .join("");
    return `<div class="trend-chart"><div class="trend-chart-label">${label}</div><div class="trend-chart-bars">${bars}</div></div>`;
  }

  el.innerHTML =
    miniChart("Touchless rate", weekly.map((w) => w.touchless_rate)) +
    miniChart("Avg confidence", weekly.map((w) => w.avg_confidence));
}

function renderVendorSpend(vendors) {
  const el = document.getElementById("dash-vendor-spend");
  if (!vendors.length) {
    el.innerHTML = `<p class="dash-empty">No approved invoices yet.</p>`;
    return;
  }
  const max = Math.max(...vendors.map((v) => v.total));
  el.innerHTML = vendors
    .map(
      (v) => `
    <div class="vendor-row">
      <div class="vendor-row-head">
        <span class="vendor-name">${escapeHtml(v.vendor_name)}</span>
        <span class="vendor-total">${fmtMoney(v.total)}</span>
      </div>
      <div class="vendor-bar-track"><div class="vendor-bar-fill" style="width: ${Math.max((v.total / max) * 100, 2)}%"></div></div>
      <span class="vendor-count">${v.invoice_count} invoice${v.invoice_count === 1 ? "" : "s"}</span>
    </div>
  `
    )
    .join("");
}

// The export endpoints are bearer-token authenticated, so a plain <a href>
// would hit them with no Authorization header and 401. Fetch through
// apiFetch (which attaches the token) and hand the browser a blob: URL
// instead -- same approach the document-preview panes already use. Shared
// by both the dashboard's Reports rail and the Export tab's cards, which
// otherwise duplicated this exact fetch-blob-download dance.
function filenameFromContentDisposition(header) {
  // A blob: URL download never applies Content-Disposition automatically
  // the way a real browser-initiated navigation would -- fetch() just hands
  // back bytes, so the header has to be parsed out by hand or the server's
  // actual filename (routes/export.js sets a real one, e.g.
  // "rekono_invoices.csv") is silently lost in favor of whatever the
  // frontend makes up instead.
  const match = /filename="?([^";]+)"?/i.exec(header || "");
  return match ? match[1] : null;
}

async function downloadExport(path) {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error("Export failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameFromContentDisposition(res.headers.get("content-disposition")) || "export";
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


// ---- Net Worth (personal) ----
// The one tab in this app that isn't organization data. GET /api/net-worth
// returns everything this view needs in one payload -- accounts, both
// totals, and the trend series -- computed server-side for the same reason
// the dashboard's numbers are: so nothing on screen can disagree with
// anything else on screen.

const NW_CATEGORY_LABELS = {
  cash: "Cash",
  investment: "Investment",
  retirement: "Retirement",
  property: "Property",
  vehicle: "Vehicle",
  other_asset: "Other asset",
  credit_card: "Credit card",
  loan: "Loan",
  mortgage: "Mortgage",
  other_liability: "Other liability",
};

// Mirrors CATEGORY_KIND in models/NetWorthAccount.js. Duplicated rather than
// fetched because it's a fixed part of the UI's own structure (which of the
// two sections an account renders in, which optgroup it's offered under),
// not data -- and the server stays the authority on the arithmetic: every
// total shown here comes off the API payload, never from this map.
const NW_LIABILITY_CATEGORIES = new Set(["credit_card", "loan", "mortgage", "other_liability"]);

let nwEditingId = null;

function nwSetError(message) {
  const el = document.getElementById("nw-error");
  if (!message) {
    el.style.display = "none";
    return;
  }
  el.textContent = message;
  el.style.display = "block";
}

// A signed delta needs its own formatter: fmtCompactMoney is unsigned-ish
// (it renders a negative fine, but never marks a positive as "+"), and a
// change badge is unreadable without knowing which way it went.
function nwFmtDelta(v) {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${fmtCompactMoney(Math.abs(v))}`;
}

// The compact card that lives in the Home dashboard's side rail -- the one
// number from this whole feature worth surfacing without an extra click.
// Everything else (full trend chart, account lists, add-account form) lives
// behind the "Manage accounts" toggle, collapsed by default: two genuinely
// different kinds of data -- the org's AP metrics and the user's own
// accounts -- sharing one screen without one of them forcing a scroll past
// the other.
function nwRenderSummary(data) {
  const el = document.getElementById("nw-summary");
  el.removeAttribute("aria-busy");

  const trend = data.trend || [];
  // Compare against the *first* recorded point rather than the previous one:
  // entries are only written on days something changed, so "previous point"
  // could be yesterday or eight months ago, and a badge that silently means
  // a different span each time it renders is worse than no badge.
  const first = trend.length ? trend[0] : null;
  const change = first ? data.net_worth - first.net_worth : 0;
  const hasHistory = trend.length > 1;
  const changeTone = change > 0 ? "good" : change < 0 ? "bad" : "";

  const sub = hasHistory
    ? `<span class="nw-delta nw-delta-${changeTone || "flat"}">${nwFmtDelta(change)}</span> since ${nwFmtDate(
        first.date
      )}`
    : data.accounts.length
    ? "Add a second reading to see a trend"
    : "No accounts yet";

  el.innerHTML = `
    <div class="nw-summary-value">${fmtCompactMoney(data.net_worth)}</div>
    <div class="nw-summary-sub">${sub}</div>
    ${nwSparklineMarkup(trend)}`;
}

// Shared by the full trend chart and the dashboard sparkline: scaled to the
// series' own range rather than anchored at zero (a $296k-to-$377k climb
// against a zero-based domain is a flat line grazing the top of the chart),
// with zero pulled into the domain only when the series actually crosses
// it -- the one case where the sign change is worth showing at all.
function nwYDomain(values) {
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const crossesZero = dataMin < 0 && dataMax > 0;
  let min = crossesZero ? Math.min(dataMin, 0) : dataMin;
  let max = crossesZero ? Math.max(dataMax, 0) : dataMax;
  // A perfectly flat series has no range to scale to; give it a nominal one
  // so it renders as a centered horizontal line instead of dividing by zero.
  if (max === min) {
    const nominal = Math.abs(max) * 0.1 || 1;
    min -= nominal;
    max += nominal;
  }
  // Breathing room so the peak and trough don't sit flush against the edges.
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad, crossesZero };
}

// A quieter, axis-less relative of nwRenderTrend below -- same shape, same
// scaling rule, sized to sit next to a headline number in a dashboard card
// rather than fill a full panel. Renders nothing when there's not yet a
// second reading to draw a line between.
function nwSparklineMarkup(trend) {
  if (trend.length < 2) return "";
  const values = trend.map((p) => p.net_worth);
  const { min, max } = nwYDomain(values);
  const span = max - min;
  const x = (i) => (i / (trend.length - 1)) * 100;
  const y = (v) => 32 - ((v - min) / span) * 32;
  const points = trend.map((p, i) => `${x(i).toFixed(2)},${y(p.net_worth).toFixed(2)}`).join(" ");
  return `
    <svg class="nw-sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="nw-spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.25" />
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
        </linearGradient>
      </defs>
      <polygon points="0,32 ${points} 100,32" fill="url(#nw-spark-fill)" />
      <polyline class="nw-sparkline-line" points="${points}" />
    </svg>`;
}

function nwFmtDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// An area-filled line rather than the bar chart the dashboard's volume panel
// uses: bars read as "how much happened on each separate day", which is right
// for document counts and wrong here -- net worth is one continuous quantity
// carried forward, and the shape between readings is the point.
//
// Hand-built inline SVG for the same reason as that chart: it's a polyline
// and a fill, and a charting dependency would cost more than it saves. The
// viewBox is a fixed 0..100 x 0..100 grid with preserveAspectRatio="none", so
// it stretches to whatever width the panel is without a resize listener.
function nwRenderTrend(trend, currentNetWorth) {
  const el = document.getElementById("nw-trend");
  const rangeEl = document.getElementById("nw-trend-range");

  if (trend.length < 2) {
    rangeEl.textContent = "";
    el.innerHTML = `<p class="dash-empty">${
      trend.length
        ? "One reading so far. Update a balance on another day and the line starts here."
        : "No accounts yet. Add one on the right to start tracking."
    }</p>`;
    return;
  }

  rangeEl.textContent = `${nwFmtDate(trend[0].date)} – ${nwFmtDate(trend[trend.length - 1].date)}`;

  const values = trend.map((p) => p.net_worth);
  const { min, max, crossesZero } = nwYDomain(values);
  const span = max - min;

  const x = (i) => (i / (trend.length - 1)) * 100;
  const y = (v) => 100 - ((v - min) / span) * 100;

  const points = trend.map((p, i) => `${x(i).toFixed(2)},${y(p.net_worth).toFixed(2)}`).join(" ");
  // Zero only earns a rule when the series straddles it (which is also the
  // only case where it's inside the domain at all) -- on an all-positive
  // chart it would sit off-canvas, and clamped to the floor it would just
  // look like an axis that isn't one.
  const zeroY = y(0).toFixed(2);
  const last = trend[trend.length - 1];

  el.innerHTML = `
    <div class="nw-trend-value">${fmtCompactMoney(currentNetWorth)}</div>
    <div class="nw-trend-chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="nw-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28" />
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
          </linearGradient>
        </defs>
        ${crossesZero ? `<line class="nw-zero-line" x1="0" y1="${zeroY}" x2="100" y2="${zeroY}" />` : ""}
        <polygon class="nw-area" points="0,100 ${points} 100,100" fill="url(#nw-fill)" />
        <polyline class="nw-line" points="${points}" />
      </svg>
      <span class="nw-trend-endpoint" style="left: 100%; top: ${y(last.net_worth).toFixed(2)}%"></span>
    </div>
    <div class="vol-axis">
      <span>${nwFmtDate(trend[0].date)}</span>
      <span>${nwFmtDate(last.date)}</span>
    </div>`;
}

function nwAccountRow(a) {
  const notes = a.notes ? `<span class="nw-row-notes">${escapeHtml(a.notes)}</span>` : "";
  return `
    <div class="nw-row">
      <div class="nw-row-main">
        <span class="nw-row-name">${escapeHtml(a.name)}</span>
        <span class="nw-row-meta">${NW_CATEGORY_LABELS[a.category] || a.category}</span>
        ${notes}
      </div>
      <span class="nw-row-balance">${fmtMoney(a.current_balance)}</span>
      <div class="nw-row-actions">
        <button type="button" class="nw-edit" data-id="${a.id}">Edit</button>
        <button type="button" class="nw-delete" data-id="${a.id}" aria-label="Delete ${escapeHtml(a.name)}">Delete</button>
      </div>
    </div>`;
}

// Takes the whole payload (not just the account list) so the dollar totals
// in each panel's note come straight off the server's own arithmetic --
// same "server counts, client displays" rule the org dashboard's numbers
// follow -- rather than being re-summed client-side from the account rows.
function nwRenderAccounts(data) {
  const assets = data.accounts.filter((a) => !NW_LIABILITY_CATEGORIES.has(a.category));
  const liabilities = data.accounts.filter((a) => NW_LIABILITY_CATEGORIES.has(a.category));

  const fill = (elId, rows, emptyText) => {
    document.getElementById(elId).innerHTML = rows.length
      ? rows.map(nwAccountRow).join("")
      : `<p class="dash-empty">${emptyText}</p>`;
  };

  fill("nw-assets", assets, "No assets yet.");
  fill("nw-liabilities", liabilities, "No liabilities — nice.");

  const note = (total, list) =>
    list.length ? `${fmtCompactMoney(total)} · ${list.length} account${list.length === 1 ? "" : "s"}` : "";
  document.getElementById("nw-assets-total").textContent = note(data.total_assets, assets);
  document.getElementById("nw-liabilities-total").textContent = note(data.total_liabilities, liabilities);

  document.querySelectorAll(".nw-edit").forEach((b) =>
    b.addEventListener("click", () => nwStartEdit(data.accounts.find((a) => a.id === b.dataset.id)))
  );
  document.querySelectorAll(".nw-delete").forEach((b) =>
    b.addEventListener("click", () => nwDeleteAccount(data.accounts.find((a) => a.id === b.dataset.id)))
  );
}

async function loadNetWorth() {
  nwSetError("");
  try {
    const res = await apiFetch("/api/net-worth");
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Could not load your net worth.");

    nwRenderSummary(data);
    nwRenderTrend(data.trend || [], data.net_worth);
    nwRenderAccounts(data);
  } catch (err) {
    nwSetError(String(err.message || err));
    document.getElementById("nw-summary").innerHTML = "";
  }
}

// Collapsed by default (see index.html's `hidden` on #nw-details) so the
// full breakdown only takes up screen space once someone actually asks for
// it -- the compact card above already carries the one number that matters
// at a glance.
const nwToggleBtn = document.getElementById("nw-toggle");
const nwDetailsEl = document.getElementById("nw-details");
nwToggleBtn.addEventListener("click", () => {
  const expanding = nwDetailsEl.hidden;
  nwDetailsEl.hidden = !expanding;
  nwToggleBtn.setAttribute("aria-expanded", String(expanding));
  document.getElementById("nw-toggle-label").textContent = expanding ? "Hide accounts" : "Manage accounts";
  if (expanding) nwDetailsEl.scrollIntoView({ behavior: "smooth", block: "start" });
});

function nwStartEdit(account) {
  if (!account) return;
  nwEditingId = account.id;
  document.getElementById("nw-form-id").value = account.id;
  document.getElementById("nw-name").value = account.name;
  document.getElementById("nw-category").value = account.category;
  document.getElementById("nw-balance").value = account.current_balance;
  document.getElementById("nw-notes").value = account.notes || "";
  document.getElementById("nw-form-title").textContent = "Edit net worth account";
  document.getElementById("nw-submit").textContent = "Save changes";
  document.getElementById("nw-cancel").style.display = "";
  document.getElementById("nw-name").focus();
}

function nwResetForm() {
  nwEditingId = null;
  document.getElementById("nw-form").reset();
  document.getElementById("nw-form-id").value = "";
  document.getElementById("nw-form-title").textContent = "Add a net worth account";
  document.getElementById("nw-submit").textContent = "Add account";
  document.getElementById("nw-cancel").style.display = "none";
  document.getElementById("nw-form-status").textContent = "";
}

async function nwDeleteAccount(account) {
  if (!account) return;
  const ok = await confirmDialog(
    "Delete account?",
    `"${account.name}" and its balance history will be removed from your net worth.`,
    { confirmLabel: "Delete", danger: true }
  );
  if (!ok) return;

  try {
    const res = await apiFetch(`/api/net-worth/accounts/${account.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Could not delete that account.");
    }
    // The form could be sitting open on the row that just disappeared.
    if (nwEditingId === account.id) nwResetForm();
    await loadNetWorth();
  } catch (err) {
    nwSetError(String(err.message || err));
  }
}

document.getElementById("nw-cancel").addEventListener("click", nwResetForm);

document.getElementById("nw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById("nw-form-status");
  const submitBtn = document.getElementById("nw-submit");
  const original = submitBtn.textContent;

  const balance = Number(document.getElementById("nw-balance").value);
  if (!Number.isFinite(balance)) {
    statusEl.textContent = "Enter a balance.";
    return;
  }

  const payload = {
    name: document.getElementById("nw-name").value.trim(),
    category: document.getElementById("nw-category").value,
    current_balance: balance,
    notes: document.getElementById("nw-notes").value,
  };

  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";
  statusEl.textContent = "";

  try {
    const editing = nwEditingId;
    const res = await apiFetch(editing ? `/api/net-worth/accounts/${editing}` : "/api/net-worth/accounts", {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Could not save that account.");

    nwResetForm();
    await loadNetWorth();
  } catch (err) {
    statusEl.textContent = String(err.message || err);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = original;
  }
});

// Called by auth.js once a valid session is confirmed (not on script load,
// since there's nothing to load until we know the user is authenticated).
function onAuthenticated() {
  loadRecentUploads();
  loadDashboard();
  loadNetWorth();
  // Needed early (not just when the Settings tab is opened) so the invoice
  // detail panel's "Push to QuickBooks" button knows whether to show up.
  loadQuickbooksStatus();
}

// ---------------------------------------------------------------------------
// Checks
//
// The document half mirrors the tax-document tab. The part that has no
// counterpart on the other five is linking: a check isn't filed, it's
// applied, and applying it posts a real journal entry. So the detail pane
// leads with the suggested bills rather than burying them under the fields,
// and a linked check renders read-only with an Unlink button -- the server
// refuses corrections on one anyway (its fields are what the posted payment
// was based on), and offering inputs that will be rejected is worse than not
// offering them.
// ---------------------------------------------------------------------------

document.getElementById("check-upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("check-file-input");
  const files = Array.from(fileInput.files);
  if (!files.length) return;

  const statusEl = document.getElementById("check-upload-status");
  let uploaded = 0;
  const failures = [];

  for (const [i, file] of files.entries()) {
    statusEl.textContent =
      files.length > 1 ? `Uploading ${i + 1} of ${files.length}: ${file.name}...` : `Uploading ${file.name}...`;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await apiFetch("/api/checks/upload", { method: "POST", body: fd });
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
      uploaded > 1 ? `Uploaded ${uploaded} checks — queued for extraction.` : "Uploaded — queued for extraction.";
  }

  fileInput.value = "";
  if (uploaded) {
    invalidateCache("/api/checks?");
    loadChecks();
    bootstrapApp(); // refresh the account menu's shared "documents used this month" count
  }
});

document.querySelectorAll(".check-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".check-filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.status === "unlinked") {
      state.checkUnlinkedOnly = true;
      state.checkStatusFilter = "";
    } else {
      state.checkUnlinkedOnly = false;
      state.checkStatusFilter = btn.dataset.status;
    }
    state.checkPage = 1;
    loadChecks();
  });
});

async function loadChecks() {
  const params = new URLSearchParams();
  if (state.checkUnlinkedOnly) {
    params.set("linked", "false");
  } else if (state.checkStatusFilter) {
    params.set("status", state.checkStatusFilter);
  }
  if (state.checkSearchQuery) params.set("q", state.checkSearchQuery);
  params.set("sort", state.checkSortField);
  params.set("order", state.checkSortOrder);
  params.set("page", state.checkPage);
  params.set("page_size", QUEUE_PAGE_SIZE);

  const url = `/api/checks?${params.toString()}`;
  return cachedLoad(url, async () => (await apiFetch(url)).json(), renderCheckList);
}

function renderCheckList({ items, total, totals }) {
  const totalsEl = document.getElementById("check-totals");
  if (totals && totals.unlinked_count) {
    // The number that matters on this tab: money that left the account
    // with nothing on the books yet accounting for it.
    totalsEl.textContent = `${totals.unlinked_count} not yet applied — ${fmtMoney(totals.unlinked_amount)} of ${fmtMoney(totals.amount)} total.`;
  } else if (totals) {
    totalsEl.textContent = total ? `${total} check${total === 1 ? "" : "s"} — all applied to bills.` : "";
  }

  const tbody = document.querySelector("#check-table tbody");
  tbody.innerHTML = (items || [])
    .map(
      (c) => `
    <tr data-id="${c.id}" class="${c.id === state.selectedCheckId ? "selected" : ""}">
      <td>${escapeHtml(c.check_date || "—")}</td>
      <td>${escapeHtml(c.check_number || "—")}</td>
      <td>${escapeHtml(c.payee_name || "—")}</td>
      <td class="num">${c.amount == null ? "—" : fmtMoney(c.amount)}</td>
      <td><span class="badge status-${c.status}">${c.status === "approved" ? "linked" : c.status.replace("_", " ")}</span></td>
      <td class="num">${fmtPct(c.overall_confidence)}</td>
    </tr>`
    )
    .join("");

  tbody.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", () => selectCheck(row.dataset.id));
  });

  document.querySelectorAll("#check-table th.check-sortable").forEach((th) => {
    th.classList.toggle("sort-active", th.dataset.sort === state.checkSortField);
    th.dataset.order = th.dataset.sort === state.checkSortField ? state.checkSortOrder : "";
  });

  const start = total === 0 ? 0 : (state.checkPage - 1) * QUEUE_PAGE_SIZE + 1;
  const end = Math.min(total, state.checkPage * QUEUE_PAGE_SIZE);
  document.getElementById("check-queue-page-info").textContent = `${start}–${end} of ${total}`;
  document.getElementById("check-queue-prev-page").disabled = state.checkPage <= 1;
  document.getElementById("check-queue-next-page").disabled = end >= total;
}

document.querySelectorAll("#check-table th.check-sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const field = th.dataset.sort;
    if (state.checkSortField === field) {
      state.checkSortOrder = state.checkSortOrder === "asc" ? "desc" : "asc";
    } else {
      state.checkSortField = field;
      state.checkSortOrder = "desc";
    }
    state.checkPage = 1;
    loadChecks();
  });
});

document.getElementById("check-search").addEventListener(
  "input",
  debounce(() => {
    state.checkSearchQuery = document.getElementById("check-search").value.trim();
    state.checkPage = 1;
    loadChecks();
  }, 250)
);

document.getElementById("check-queue-prev-page").addEventListener("click", () => {
  if (state.checkPage <= 1) return;
  state.checkPage -= 1;
  loadChecks();
});

document.getElementById("check-queue-next-page").addEventListener("click", () => {
  state.checkPage += 1;
  loadChecks();
});

async function selectCheck(id) {
  state.selectedCheckId = id;
  const res = await apiFetch(`/api/checks/${id}`);
  const check = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't open this check", errorText(check.detail, "Could not load this check."));
    return;
  }
  renderCheckDetail(check);
}

function checkFieldConf(c, name) {
  return (c.field_confidence && c.field_confidence[name]) ?? 0;
}

function renderCheckDetail(c) {
  const el = document.getElementById("check-queue-detail");

  if (c.status === "queued" || c.status === "processing") {
    const isPdf = (c.content_type || "").includes("pdf");
    el.innerHTML = `
      <div class="cross-check processing">⏳ Still processing this check — this updates automatically. Most documents finish in well under a minute, but a slow OCR pass or AI response can occasionally take a couple of minutes.</div>
      <div class="doc-preview">
        <h3>Source document</h3>
        <div class="doc-preview-frame">
          ${isPdf ? `<iframe id="check-doc-preview-media"></iframe>` : `<img id="check-doc-preview-media" />`}
        </div>
      </div>
    `;
    loadCheckPreview(c);
    pollCheckWhileProcessing(c.id);
    return;
  }

  const lowConf = (name) => (checkFieldConf(c, name) < 0.85 ? "low-confidence" : "");
  const isPdf = (c.content_type || "").includes("pdf");
  const preview = isPdf ? `<iframe id="check-doc-preview-media"></iframe>` : `<img id="check-doc-preview-media" />`;
  const linked = Boolean(c.invoice_id);

  const statusBanner =
    c.status === "failed"
      ? `<div class="cross-check fail">⚠ Extraction failed: ${escapeHtml(c.error_message) || "Unknown error."} You can still fill in the fields below by hand.</div>`
      : `<div class="cross-check pass">✓ extraction method: ${c.extraction_method} &nbsp;·&nbsp; overall confidence: ${fmtPct(c.overall_confidence)}</div>`;

  // A linked check has moved money. Say so plainly at the top, because
  // every action below it behaves differently as a result.
  const linkBanner = linked
    ? `<div class="cross-check pass">✓ Applied to a bill — a payment of ${fmtMoney(c.amount)} has posted against Accounts Payable. Unlink to reverse it.</div>`
    : `<div class="cross-check warn">This check hasn't been applied to a bill yet, so nothing on the books accounts for it. Pick a bill below to record the payment.</div>`;

  // Read-only once linked: the server refuses corrections on a linked
  // check, so rendering editable inputs would only invite a 409.
  const ro = linked ? " disabled" : "";

  el.innerHTML = `
    ${linkBanner}
    ${statusBanner}

    <div class="detail-grid">
      <div class="field ${lowConf("payee_name")}"><label>Payee</label><input id="cf-payee_name" value="${escapeHtml(c.payee_name)}"${ro} /></div>
      <div class="field ${lowConf("amount")}"><label>Amount</label><input id="cf-amount" value="${c.amount ?? ""}"${ro} /></div>
      <div class="field ${lowConf("check_date")}"><label>Date</label><input id="cf-check_date" type="date" value="${c.check_date || ""}"${ro} /></div>
      <div class="field ${lowConf("check_number")}"><label>Check #</label><input id="cf-check_number" value="${escapeHtml(c.check_number)}"${ro} /></div>
      <div class="field ${lowConf("memo")}"><label>Memo</label><input id="cf-memo" value="${escapeHtml(c.memo)}"${ro} /></div>
      <div class="field ${lowConf("bank_name")}"><label>Bank</label><input id="cf-bank_name" value="${escapeHtml(c.bank_name)}"${ro} /></div>
      <!-- Deliberately no maxlength, same trap as the tax module's TIN
           field: a reviewer reads the check and types the whole account
           number, and a 4-character cap would keep the FIRST four digits.
           Let the full value through and let the server narrow it. -->
      <div class="field ${lowConf("account_last4")}"><label>Account</label><input id="cf-account_last4" inputmode="numeric" placeholder="Last 4, or paste the full number" value="${escapeHtml(c.account_last4)}"${ro} /></div>
      <div class="field"><label>Note</label><input id="cf-note" value="${escapeHtml(c.note)}"${ro} /></div>
    </div>
    ${linked ? "" : `<p class="hint">Rekono stores only the last four digits of the account number, and never stores the routing number — type or paste the whole number and it's narrowed on save. The full number stays in the source document.</p>`}

    <h3>${linked ? "Applied to" : "Apply to a bill"}</h3>
    <div id="check-link-area"><p class="hint">Loading bills…</p></div>

    <div class="actions">
      ${
        linked
          ? `<button class="reject" id="cbtn-unlink">Unlink and reverse payment</button>`
          : `<button class="save" id="cbtn-save">Save Corrections</button>
             <button class="reject" id="cbtn-reject">Reject</button>
             <button class="retry" id="cbtn-retry">Retry Extraction</button>
             <button class="delete" id="cbtn-delete">Delete</button>`
      }
    </div>

    <div class="doc-preview">
      <h3>Source document</h3>
      <div class="doc-preview-frame">
        ${preview}
      </div>
    </div>
  `;

  if (linked) {
    document.getElementById("cbtn-unlink").addEventListener("click", () => unlinkCheck(c.id));
  } else {
    document.getElementById("cbtn-save").addEventListener("click", () => saveCheckCorrections(c.id));
    document.getElementById("cbtn-reject").addEventListener("click", () => rejectCheck(c.id));
    document.getElementById("cbtn-retry").addEventListener("click", () => retryCheck(c.id));
    document.getElementById("cbtn-delete").addEventListener("click", () => deleteCheck(c.id));
  }

  loadCheckPreview(c);
  renderCheckLinkArea(c);
}

async function renderCheckLinkArea(c) {
  const area = document.getElementById("check-link-area");
  if (!area) return;

  if (c.invoice_id) {
    const res = await apiFetch(`/api/invoices/${c.invoice_id}`);
    const inv = await res.json();
    area.innerHTML = res.ok
      ? `<p>${escapeHtml(inv.vendor_name || "—")} &nbsp;·&nbsp; ${escapeHtml(inv.invoice_number || "no number")} &nbsp;·&nbsp; ${fmtMoney(inv.total)}</p>`
      : `<p class="hint">The linked bill could not be loaded.</p>`;
    return;
  }

  const res = await apiFetch(`/api/checks/${c.id}/match-suggestions`);
  const body = await res.json();
  if (!res.ok) {
    area.innerHTML = `<p class="hint">${escapeHtml(errorText(body.detail, "Could not load suggestions."))}</p>`;
    return;
  }

  if (!body.open_bill_count) {
    area.innerHTML = `<p class="hint">No open bills to apply this check to. A bill has to be approved (and not already paid in full) before a payment can relieve it.</p>`;
    return;
  }
  if (!body.suggestions.length) {
    area.innerHTML = `<p class="hint">None of your ${body.open_bill_count} open bills look like a match for this check. Check the payee and amount above, or record the payment from the Bill Payments tab instead.</p>`;
    return;
  }

  // The account picker is shared with the Bill Payments tab -- same filter,
  // same reasoning (see loadPaymentAccounts).
  const accountOptions = bpPaymentAccounts
    .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`)
    .join("");

  if (!accountOptions) {
    area.innerHTML = `<p class="hint">Add a bank, cash, or credit card account to your chart of accounts before applying a check.</p>`;
    return;
  }

  area.innerHTML = `
    <div class="field"><label for="check-pay-from">Pay from</label><select id="check-pay-from">${accountOptions}</select></div>
    <table class="line-items-table">
      <thead><tr><th>Vendor</th><th>Bill</th><th>Outstanding</th><th>Why</th><th></th></tr></thead>
      <tbody>
        ${body.suggestions
          .map(
            (s) => `
          <tr>
            <td>${escapeHtml(s.vendor_name || "—")}</td>
            <td>${escapeHtml(s.invoice_number || "—")}</td>
            <td class="num">${fmtMoney(s.outstanding)}</td>
            <td><span class="badge match-${s.status}">${s.status}</span> ${escapeHtml(s.reasoning)}</td>
            <td><button class="approve check-link-btn" data-invoice="${escapeHtml(s.invoice_id)}">Apply</button></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
    <p class="hint">Applying records a payment dated ${escapeHtml(c.check_date || "today")} against the bill, and posts it to the ledger.</p>
  `;

  area.querySelectorAll(".check-link-btn").forEach((btn) => {
    btn.addEventListener("click", () => linkCheck(c.id, btn.dataset.invoice));
  });
}

async function linkCheck(id, invoiceId) {
  const accountEl = document.getElementById("check-pay-from");
  if (!accountEl) return;

  const confirmed = await confirmDialog(
    "Apply this check to the bill?",
    "This records a payment against the bill and posts it to the ledger. You can reverse it by unlinking."
  );
  if (!confirmed) return;

  const res = await apiFetch(`/api/checks/${id}/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoice_id: invoiceId, payment_account_id: accountEl.value }),
  });
  const body = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't apply this check", errorText(body.detail, "Could not apply this check to that bill."));
    return;
  }
  renderCheckDetail(body);
  invalidateCache("/api/checks?");
  invalidateCache("__ap_aging__");
  loadChecks();
}

async function unlinkCheck(id) {
  const confirmed = await confirmDialog(
    "Unlink this check?",
    "The payment is reversed with an opposing journal entry — both stay on the books and cancel — and the bill goes back to outstanding."
  );
  if (!confirmed) return;

  const res = await apiFetch(`/api/checks/${id}/unlink`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't unlink this check", errorText(body.detail, "Could not unlink this check."));
    return;
  }
  renderCheckDetail(body);
  invalidateCache("/api/checks?");
  invalidateCache("__ap_aging__");
  loadChecks();
}

const CHECK_POLL_MAX_ATTEMPTS = 120;

function pollCheckWhileProcessing(id, attempt = 0) {
  if (attempt >= CHECK_POLL_MAX_ATTEMPTS) {
    if (state.selectedCheckId === id) {
      const banner = document.querySelector("#check-queue-detail .cross-check.processing");
      if (banner) {
        banner.textContent =
          "⏳ Still processing — this is taking much longer than usual. It will keep updating automatically; feel free to check back later.";
      }
    }
    return;
  }
  setTimeout(async () => {
    if (state.selectedCheckId !== id) return;
    const res = await apiFetch(`/api/checks/${id}`);
    const c = await res.json();
    if (state.selectedCheckId !== id) return;
    // A failed poll is almost always transient -- keep waiting rather than
    // rendering an error body as a finished check with every field empty.
    if (!res.ok) {
      pollCheckWhileProcessing(id, attempt + 1);
      return;
    }
    if (c.status === "queued" || c.status === "processing") {
      pollCheckWhileProcessing(id, attempt + 1);
    } else {
      renderCheckDetail(c);
      invalidateCache("/api/checks?");
      loadChecks();
    }
  }, 3000);
}

async function loadCheckPreview(c) {
  const media = document.getElementById("check-doc-preview-media");
  if (!media) return;
  if (checkDocPreviewObjectUrl) {
    URL.revokeObjectURL(checkDocPreviewObjectUrl);
    checkDocPreviewObjectUrl = null;
  }
  try {
    const res = await apiFetch(`/api/checks/${c.id}/file`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || "Could not load the source document.");
    }
    const blob = await res.blob();
    checkDocPreviewObjectUrl = URL.createObjectURL(blob);
    media.src = checkDocPreviewObjectUrl;
  } catch (err) {
    media.replaceWith(
      Object.assign(document.createElement("p"), { className: "hint", textContent: String(err.message || err) })
    );
  }
}

async function saveCheckCorrections(id) {
  const payload = {
    payee_name: document.getElementById("cf-payee_name").value,
    amount: numOrNull(document.getElementById("cf-amount").value),
    check_date: document.getElementById("cf-check_date").value || null,
    check_number: document.getElementById("cf-check_number").value,
    memo: document.getElementById("cf-memo").value,
    bank_name: document.getElementById("cf-bank_name").value,
    account_last4: document.getElementById("cf-account_last4").value,
    note: document.getElementById("cf-note").value,
  };

  const res = await apiFetch(`/api/checks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  // Returning before renderCheckDetail keeps the typing on screen when a
  // save is rejected -- see saveCorrections above for what happens when
  // this is skipped.
  if (!res.ok) {
    await alertDialog("Couldn't save your changes", errorText(body.detail, "Could not save these corrections."));
    return;
  }
  renderCheckDetail(body);
  invalidateCache("/api/checks?");
  loadChecks();
}

async function rejectCheck(id) {
  const res = await apiFetch(`/api/checks/${id}/reject`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't reject this check", errorText(body.detail, "Could not reject this check."));
    return;
  }
  renderCheckDetail(body);
  invalidateCache("/api/checks?");
  loadChecks();
}

async function retryCheck(id) {
  const res = await apiFetch(`/api/checks/${id}/retry`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    await alertDialog("Couldn't retry extraction", errorText(body.detail, "Could not retry this check."));
    return;
  }
  renderCheckDetail(body);
  invalidateCache("/api/checks?");
  loadChecks();
}

async function deleteCheck(id) {
  const confirmed = await confirmDialog("Delete this check?", "The stored image is removed. This can't be undone.");
  if (!confirmed) return;

  const res = await apiFetch(`/api/checks/${id}`, { method: "DELETE" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    await alertDialog("Couldn't delete this check", errorText(body.detail, "Could not delete this check."));
    return;
  }
  state.selectedCheckId = null;
  document.getElementById("check-queue-detail").innerHTML =
    `<div class="empty-state"><p class="hint">Select a check from the list to review it.</p></div>`;
  invalidateCache("/api/checks?");
  loadChecks();
}
