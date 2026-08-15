const state = { statusFilter: "", selectedInvoiceId: null };
let docPreviewObjectUrl = null;

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
  if (name === "review") loadInvoices();
  if (name === "matching") { loadSources(); loadMatchResults(); }
  if (name === "settings") loadOrgSettings();
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
  if (uploaded) bootstrapApp();
});

async function loadRecentUploads() {
  const res = await apiFetch("/api/invoices");
  const invoices = await res.json();
  const el = document.getElementById("sidebar-recent-uploads");
  el.innerHTML = invoices.slice(0, 8).map((inv) => (
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
    loadInvoices();
  });
});

async function loadInvoices() {
  const qs = state.statusFilter ? `?status=${state.statusFilter}` : "";
  const res = await apiFetch(`/api/invoices${qs}`);
  const invoices = await res.json();
  const tbody = document.querySelector("#invoice-table tbody");
  tbody.innerHTML = invoices.map((inv) => `
    <tr data-id="${inv.id}">
      <td>${inv.vendor_name ? escapeHtml(inv.vendor_name) : "(unknown)"}</td>
      <td>${fmtMoney(inv.total)}</td>
      <td><span class="badge status-${inv.status}">${inv.status}</span></td>
      <td>${fmtPct(inv.overall_confidence)}</td>
    </tr>
  `).join("") || "<tr><td colspan='4'>No invoices.</td></tr>";

  tbody.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", () => selectInvoice(row.dataset.id));
  });
}

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
        ${isPdf ? `<iframe id="doc-preview-media"></iframe>` : `<img id="doc-preview-media" />`}
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
      <tbody id="line-items-body">${lineItemsRows || "<tr><td colspan='4'>No line items extracted.</td></tr>"}</tbody>
    </table>

    <h3>Matching</h3>
    ${matchHtml}

    <div class="actions">
      <button class="save" id="btn-save">Save Corrections</button>
      <button class="approve" id="btn-approve">Approve</button>
      <button class="reject" id="btn-reject">Reject</button>
      <button class="delete" id="btn-delete">Delete</button>
    </div>

    <div class="doc-preview">
      <h3>Source document</h3>
      ${preview}
    </div>
  `;

  document.getElementById("btn-save").addEventListener("click", () => saveCorrections(inv.id));
  document.getElementById("btn-approve").addEventListener("click", () => approveInvoice(inv.id));
  document.getElementById("btn-reject").addEventListener("click", () => rejectInvoice(inv.id));
  document.getElementById("btn-delete").addEventListener("click", () => deleteInvoice(inv.id));

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
    if (!res.ok) throw new Error("Could not load the source document.");
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
  loadInvoices();
}

async function approveInvoice(id) {
  const res = await apiFetch(`/api/invoices/${id}/approve`, { method: "POST" });
  const inv = await res.json();
  renderDetail(inv);
  loadInvoices();
}

async function rejectInvoice(id) {
  const res = await apiFetch(`/api/invoices/${id}/reject`, { method: "POST" });
  const inv = await res.json();
  renderDetail(inv);
  loadInvoices();
}

// No status restriction on the backend -- a document can be deleted at any
// point in review, whenever the user decides they don't want it around
// anymore. Callable from either the sidebar's recent-uploads list or the
// review-detail panel, so both need refreshing regardless of which one this
// was clicked from.
async function deleteInvoice(id) {
  if (!confirm("Delete this document? This can't be undone from the review UI.")) return;

  const res = await apiFetch(`/api/invoices/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.detail || "Could not delete this document.");
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
  loadInvoices();
  loadRecentUploads();
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
    alert(`Error: ${err.detail || res.statusText}`);
    return;
  }
  fileInput.value = "";
  loadSources();
});

async function loadSources() {
  const res = await apiFetch("/api/matching/sources");
  const sources = await res.json();
  document.getElementById("sources-list").innerHTML = "<h3>Uploaded sources</h3>" + (sources.map((s) => (
    `<div>${escapeHtml(s.name)} (${s.source_type}) — ${s.entry_count} rows</div>`
  )).join("") || "<div class='hint'>None yet.</div>");
}

document.getElementById("run-matching-btn").addEventListener("click", async () => {
  const res = await apiFetch("/api/matching/run", { method: "POST" });
  const summary = await res.json();
  document.getElementById("matching-summary").textContent =
    `Evaluated ${summary.invoices_evaluated} invoices — matched ${summary.matched}, partial ${summary.partial}, unmatched ${summary.unmatched}.`;
  loadMatchResults();
});

async function loadMatchResults() {
  const [resultsRes, invoicesRes] = await Promise.all([
    apiFetch("/api/matching/results"),
    apiFetch("/api/invoices"),
  ]);
  const results = await resultsRes.json();
  const invoices = await invoicesRes.json();
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
  }).join("") || "<tr><td colspan='6'>No matching results yet.</td></tr>";
}

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
      body: JSON.stringify({ question }),
    });
    const body = await res.json();
    answerEl.classList.remove("ask-answer-loading");
    if (res.ok) {
      answerEl.textContent = body.answer;
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
  const [settingsRes, me] = await Promise.all([
    apiFetch("/api/org/settings").then((r) => r.json()),
    apiFetch("/api/auth/me").then((r) => r.json()),
  ]);
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
    if (res.ok) showApp(body); // refreshes the sidebar name badge too
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
    loadOrgSettings();
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

// ---- Team ----
async function loadTeam() {
  const res = await apiFetch("/api/team");
  const data = await res.json();
  const me = await (await apiFetch("/api/auth/me")).json();
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
      if (!confirm("Remove this teammate from your account?")) return;
      await apiFetch(`/api/team/members/${btn.dataset.userId}`, { method: "DELETE" });
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
    loadTeam();
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  }
});

// ---- Init ----
// Called by auth.js once a valid session is confirmed (not on script load,
// since there's nothing to load until we know the user is authenticated).
function onAuthenticated() {
  loadRecentUploads();
}
