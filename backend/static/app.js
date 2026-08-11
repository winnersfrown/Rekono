const state = { statusFilter: "", selectedInvoiceId: null };

// ---- Tabs ----
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "review") loadInvoices();
    if (btn.dataset.tab === "matching") { loadSources(); loadMatchResults(); }
  });
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
    const res = await fetch("/api/invoices/upload", { method: "POST", body: fd });
    if (!res.ok) {
      const err = await res.json();
      statusEl.textContent = `Error: ${err.detail || res.statusText}`;
      return;
    }
    const invoice = await res.json();
    statusEl.textContent = `Uploaded "${invoice.original_filename}" — queued for extraction (id ${invoice.id}).`;
    fileInput.value = "";
    loadRecentUploads();
  } catch (err) {
    statusEl.textContent = `Error: ${err}`;
  }
});

async function loadRecentUploads() {
  const res = await fetch("/api/invoices");
  const invoices = await res.json();
  const el = document.getElementById("recent-uploads");
  el.innerHTML = "<h3>Recent uploads</h3>" + invoices.slice(0, 8).map((inv) => (
    `<div>${inv.original_filename} — <span class="badge status-${inv.status}">${inv.status}</span></div>`
  )).join("");
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
  const res = await fetch(`/api/invoices${qs}`);
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
  const res = await fetch(`/api/invoices/${id}`);
  const inv = await res.json();
  renderDetail(inv);
}

function fieldConf(inv, name) {
  return (inv.field_confidence && inv.field_confidence[name]) ?? 0;
}

function renderDetail(inv) {
  const el = document.getElementById("queue-detail");
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
  const preview = isPdf
    ? `<iframe src="/api/invoices/${inv.id}/file"></iframe>`
    : `<img src="/api/invoices/${inv.id}/file" />`;

  const matchHtml = (inv.match_results && inv.match_results.length)
    ? inv.match_results.map((m) => `<div><span class="badge match-${m.status}">${m.status}</span> score ${m.score.toFixed(0)} — ${m.reasoning}</div>`).join("")
    : `<div class="hint">No match run yet for this invoice.</div>`;

  el.innerHTML = `
    <div class="cross-check ${inv.cross_check_passed ? "pass" : "fail"}">
      ${inv.cross_check_passed ? "✓" : "✗"} Cross-check: ${inv.cross_check_detail || "n/a"}
      &nbsp;·&nbsp; extraction method: ${inv.extraction_method} &nbsp;·&nbsp; overall confidence: ${fmtPct(inv.overall_confidence)}
    </div>

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

  const res = await fetch(`/api/invoices/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const inv = await res.json();
  renderDetail(inv);
  loadInvoices();
}

async function approveInvoice(id) {
  const res = await fetch(`/api/invoices/${id}/approve`, { method: "POST" });
  const inv = await res.json();
  renderDetail(inv);
  loadInvoices();
}

async function rejectInvoice(id) {
  const res = await fetch(`/api/invoices/${id}/reject`, { method: "POST" });
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

  const res = await fetch(`/api/matching/sources?source_type=${sourceType}`, { method: "POST", body: fd });
  if (!res.ok) {
    const err = await res.json();
    alert(`Error: ${err.detail || res.statusText}`);
    return;
  }
  fileInput.value = "";
  loadSources();
});

async function loadSources() {
  const res = await fetch("/api/matching/sources");
  const sources = await res.json();
  document.getElementById("sources-list").innerHTML = "<h3>Uploaded sources</h3>" + (sources.map((s) => (
    `<div>${s.name} (${s.source_type}) — ${s.entry_count} rows</div>`
  )).join("") || "<div class='hint'>None yet.</div>");
}

document.getElementById("run-matching-btn").addEventListener("click", async () => {
  const res = await fetch("/api/matching/run", { method: "POST" });
  const summary = await res.json();
  document.getElementById("matching-summary").textContent =
    `Evaluated ${summary.invoices_evaluated} invoices — matched ${summary.matched}, partial ${summary.partial}, unmatched ${summary.unmatched}.`;
  loadMatchResults();
});

async function loadMatchResults() {
  const [resultsRes, invoicesRes] = await Promise.all([
    fetch("/api/matching/results"),
    fetch("/api/invoices"),
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

// ---- Init ----
loadRecentUploads();
