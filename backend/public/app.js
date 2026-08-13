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
document.getElementById("upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById("file-input");
  if (!fileInput.files.length) return;
  const fd = new FormData();
  fd.append("file", fileInput.files[0]);

  const statusEl = document.getElementById("upload-status");
  statusEl.textContent = "Uploading...";
  try {
    const res = await apiFetch("/api/invoices/upload", { method: "POST", body: fd });
    if (!res.ok) {
      const err = await res.json();
      statusEl.textContent = `Error: ${err.detail || res.statusText}`;
      return;
    }
    const invoice = await res.json();
    statusEl.textContent = `Uploaded "${invoice.original_filename}" — queued for extraction (id ${invoice.id}).`;
    fileInput.value = "";
    // bootstrapApp() already re-runs loadRecentUploads() via onAuthenticated()
    // once it re-confirms the session, alongside refreshing the sidebar's
    // "documents used this month" count -- calling loadRecentUploads() here
    // too would just fire the same GET /api/invoices twice per upload.
    bootstrapApp();
  } catch (err) {
    // err is a real Error here (thrown by apiFetch on 401/402, or a network
    // failure) -- its own message already reads naturally on its own
    // ("You've reached your Free plan's limit..."), so this avoids
    // interpolating the whole Error object and doubling up "Error: Error: ".
    statusEl.textContent = err.message || String(err);
  }
});

async function loadRecentUploads() {
  const res = await apiFetch("/api/invoices");
  const invoices = await res.json();
  const el = document.getElementById("sidebar-recent-uploads");
  el.innerHTML = invoices.slice(0, 8).map((inv) => (
    `<button type="button" class="sidebar-recent-item" data-id="${inv.id}">
      <span class="sidebar-recent-name">${escapeAttr(inv.original_filename)}</span>
      <span class="badge status-${inv.status}">${inv.status}</span>
    </button>`
  )).join("") || `<p class="hint sidebar-recent-empty">Nothing uploaded yet.</p>`;

  el.querySelectorAll(".sidebar-recent-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab("review");
      selectInvoice(btn.dataset.id);
    });
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
      <td>${inv.vendor_name || "(unknown)"}</td>
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
      <td><input data-li="${i}" data-field="description" value="${escapeAttr(li.description)}" /></td>
      <td><input data-li="${i}" data-field="quantity" value="${li.quantity ?? ""}" style="width:4rem" /></td>
      <td><input data-li="${i}" data-field="unit_price" value="${li.unit_price ?? ""}" style="width:5rem" /></td>
      <td><input data-li="${i}" data-field="amount" value="${li.amount ?? ""}" style="width:5rem" /></td>
    </tr>
  `).join("");

  const isPdf = (inv.content_type || "").includes("pdf");
  const preview = isPdf ? `<iframe id="doc-preview-media"></iframe>` : `<img id="doc-preview-media" />`;

  const matchHtml = (inv.match_results && inv.match_results.length)
    ? inv.match_results.map((m) => `<div><span class="badge match-${m.status}">${m.status}</span> score ${m.score.toFixed(0)} — ${m.reasoning}</div>`).join("")
    : `<div class="hint">No match run yet for this invoice.</div>`;

  const statusBanner = inv.status === "failed"
    ? `<div class="cross-check fail">⚠ Extraction failed: ${escapeAttr(inv.error_message) || "Unknown error."} You can still fill in the fields below by hand.</div>`
    : `<div class="cross-check ${inv.cross_check_passed ? "pass" : "fail"}">
      ${inv.cross_check_passed ? "✓" : "✗"} Cross-check: ${inv.cross_check_detail || "n/a"}
      &nbsp;·&nbsp; extraction method: ${inv.extraction_method} &nbsp;·&nbsp; overall confidence: ${fmtPct(inv.overall_confidence)}
    </div>`;

  el.innerHTML = `
    ${statusBanner}

    <div class="detail-grid">
      <div class="field ${lowConf("vendor_name")}"><label>Vendor</label><input id="f-vendor_name" value="${escapeAttr(inv.vendor_name)}" /></div>
      <div class="field ${lowConf("invoice_number")}"><label>Invoice #</label><input id="f-invoice_number" value="${escapeAttr(inv.invoice_number)}" /></div>
      <div class="field ${lowConf("invoice_date")}"><label>Invoice Date</label><input id="f-invoice_date" type="date" value="${inv.invoice_date || ""}" /></div>
      <div class="field ${lowConf("due_date")}"><label>Due Date</label><input id="f-due_date" type="date" value="${inv.due_date || ""}" /></div>
      <div class="field ${lowConf("po_reference")}"><label>PO Reference</label><input id="f-po_reference" value="${escapeAttr(inv.po_reference)}" /></div>
      <div class="field ${lowConf("currency")}"><label>Currency</label><input id="f-currency" value="${escapeAttr(inv.currency)}" /></div>
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
    </div>

    <div class="doc-preview">
      <h3>Source document</h3>
      ${preview}
    </div>
  `;

  document.getElementById("btn-save").addEventListener("click", () => saveCorrections(inv.id));
  document.getElementById("btn-approve").addEventListener("click", () => approveInvoice(inv.id));
  document.getElementById("btn-reject").addEventListener("click", () => rejectInvoice(inv.id));

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

function escapeAttr(s) {
  return (s ?? "").toString().replace(/"/g, "&quot;");
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
    `<div>${s.name} (${s.source_type}) — ${s.entry_count} rows</div>`
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
        <td>${inv.original_filename || r.invoice_id}</td>
        <td>${inv.vendor_name || ""}</td>
        <td>${fmtMoney(inv.total)}</td>
        <td><span class="badge match-${r.status}">${r.status}</span></td>
        <td>${r.score.toFixed(0)}</td>
        <td>${r.reasoning}</td>
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

// ---- Init ----
// Called by auth.js once a valid session is confirmed (not on script load,
// since there's nothing to load until we know the user is authenticated).
function onAuthenticated() {
  loadRecentUploads();
}
