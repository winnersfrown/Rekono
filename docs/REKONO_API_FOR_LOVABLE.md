# Rekono API — reference for a Lovable-built frontend

This document exists for one purpose: it is the context you paste into
Lovable so the frontend it generates talks to Rekono's **real** API instead
of inventing endpoints.

Rekono's backend is Node 22 + Express + Sequelize + Postgres. It cannot run
inside Lovable — Lovable builds Vite/React/TypeScript/Tailwind frontends and
has nowhere to run OCR (Tesseract), a job queue, or a Sequelize layer. So the
arrangement is:

```
Lovable project  ──►  its own GitHub repo (e.g. winnersfrown/rekono-ui)
       │                       React + Vite + TS + Tailwind
       │  HTTPS + Bearer token
       ▼
Rekono API       ──►  winnersfrown/Rekono  (unchanged)
                       https://rekono-ai-new.onrender.com
```

The existing vanilla-JS UI in `backend/public/` keeps working throughout. A
Lovable frontend is an *additional* client, not a replacement, until you
choose to cut over.

---

## Before the frontend will work: CORS

The API rejects browser requests from unknown origins (`src/app.js`). Add the
Lovable preview domain and whatever the frontend deploys to:

```
ALLOWED_ORIGINS=https://winnersfrown.github.io,https://rekono-ai-new.onrender.com,https://<your-lovable-app>.lovable.app
```

Set it on the Render service and redeploy. Without this every request fails
with a CORS error before it reaches a route, which looks like a broken
frontend but is a server config problem.

---

## Auth

Plain JWT bearer tokens. No cookies, no refresh flow.

```
POST /api/auth/signup   { org_name, full_name, email, password }  → 201 { access_token, token_type }
POST /api/auth/login    { email, password }                       → 200 { access_token, token_type }
POST /api/demo/login    (no body, no auth)                        → 200 { access_token, token_type }
```

Store the token and send it on every subsequent request:

```
Authorization: Bearer <access_token>
```

`GET /api/auth/me` returns the session context the whole shell depends on:

```jsonc
{
  "id": "...", "email": "...", "full_name": "...", "role": "owner|member",
  "org_id": "...", "org_name": "...",
  "plan": "starter|growth|scale|null",
  "subscription_status": "active|trialing|...",
  "trial_ends_at": "2026-09-05T...",
  "onboarding_completed": true,
  "is_demo": false,
  "documents_used_this_month": 18,
  "document_cap": 10000
}
```

`plan: null` / `onboarding_completed: false` means the user must pick a plan
before any document route will answer — those routes return `402` with
`{ detail, onboarding_required }` or `{ detail, billing_required }`.

**Build against `POST /api/demo/login` first.** It needs no signup, no card,
and returns a token for a freshly seeded org with realistic data across all
five document types. It is the fastest way to get a Lovable frontend
rendering real rows.

---

## Errors

Every error is `{ "detail": ... }`. `detail` is a plain sentence for most
failures and a Zod issues array for schema validation, so handle both:

```ts
const message = typeof body.detail === "string"
  ? body.detail
  : body.detail?.[0]?.message ?? "Something went wrong.";
```

Notable statuses: `401` bad/missing token · `402` plan cap or billing gate
(carries `plan_cap_reached` / `onboarding_required` / `billing_required`) ·
`409` illegal state transition (approving a queued document) · `413` file too
large · `422` validation · `429` rate limited.

---

## The five document pipelines

All five are **the same shape** with a different noun and schema. Build one
generic queue component and configure it five times rather than writing it
five times.

| Tab | Base path | Extra list filters |
|---|---|---|
| Review Queue | `/api/invoices` | — |
| Expenses | `/api/expenses` | `category` |
| Vendor Docs | `/api/vendor-documents` | `expiring_within_days=N` |
| Leases | `/api/leases` | `expiring_within_days=N` (matches expiration **or** renewal-notice date) |
| Tax Docs | `/api/tax-documents` | `tax_year=N`, `document_type`, `missing_tin=true` |

Every base path supports:

```
POST   {base}/upload            multipart/form-data, field name "file", one file per request
GET    {base}                   ?page= &page_size= &status= &q= &sort= &order=
GET    {base}/:id
GET    {base}/:id/file          the original PDF/image — fetch as a blob, don't <img src> it (needs the auth header)
GET    {base}/:id/audit-log
PATCH  {base}/:id               human corrections; writes an audit entry
POST   {base}/:id/approve       409 unless status is extracted|needs_review
POST   {base}/:id/reject        no status restriction
POST   {base}/:id/retry         409 once approved
DELETE {base}/:id               soft delete; still counts toward the monthly cap
```

List responses are `{ items, total, page, page_size }`. Tax docs additionally
return `document_types`, `tax_years`, and `totals` (see below).

### Status lifecycle

`queued → processing → extracted | needs_review | failed`, then
`approved | rejected` by a human. `needs_review` means extraction confidence
fell below the org threshold.

**Poll while processing.** Extraction is async (OCR + LLM). After an upload
the document comes back `queued`; poll `GET {base}/:id` every ~3s until status
leaves `queued`/`processing`. Most finish well under a minute; cap the polling
at ~120 attempts and show a "taking longer than usual" message rather than
spinning forever.

### Per-pipeline detail fields

Common to all: `id`, `original_filename`, `content_type`, `status`,
`error_message`, `note`, `extraction_method` (`"llm"` | `"heuristic"`),
`field_confidence` (per-field 0–1 map), `overall_confidence`, `created_at`,
`updated_at`.

Render a field with `field_confidence[name] < 0.85` as low-confidence
(highlighted for review) — that's what the existing UI does and it's the
whole point of the confidence scoring.

- **Invoices** — `vendor_name`, `invoice_number`, `invoice_date`, `due_date`, `subtotal`, `tax`, `total`, `line_items[]`, `match_results[]`, `cross_check_passed`, `cross_check_detail`, `duplicate_of_invoice_id`, `possible_multi_invoice`, plus the `quickbooks_*` fields.
- **Expenses** — `merchant_name`, `receipt_date`, `category`, `currency`, `tax`, `amount`.
- **Vendor docs** — `vendor_name`, `document_type`, `effective_date`, `expiration_date`, `reference_number`, `amount`.
- **Leases** — `landlord_name`, `property_address`, `commencement_date`, `expiration_date`, `renewal_notice_deadline`, `monthly_rent`, `annual_escalation_pct`.
- **Tax docs** — `document_type`, `tax_year`, `payer_name`, `recipient_name`, `recipient_tin_last4`, `amount`, `federal_tax_withheld`.

**Tax docs, two rules that matter.** Only the last four digits of a taxpayer
ID are ever stored — the field is `recipient_tin_last4`. A reviewer may type
the whole number and the server narrows it; do **not** put a `maxlength` on
that input (a 4-char cap keeps the *first* four characters, the wrong digits,
and the server then rejects it). An empty value means the form genuinely
shows no TIN, which is a compliance flag, not missing data — surface it.

Its list response carries totals over the **whole filtered set**, not the page:

```jsonc
{ "totals": { "amount": 315130.44, "federal_tax_withheld": 5400,
              "missing_tin": 1, "by_document_type": { "1099-NEC": 2 } } }
```

---

## Dashboard

`GET /api/dashboard` — one aggregated read for the landing view. Don't
recompute any of this client-side from list endpoints.

```jsonc
{
  "org_name": "...",
  "kpis": { "outstanding_ap": 0, "outstanding_ap_count": 0, "overdue_count": 0,
            "approved_this_month_value": 0, "review_queue": 0, "in_flight": 0,
            "failed": 0, "avg_confidence": 0.91,
            "documents_used_this_month": 18, "document_cap": 10000,
            "touchless": { "auto_approved": 0, "total_approvals": 0, "rate": null } },
  "workflow":  [{ "key": "...", "label": "...", "count": 0, "tab": "review" }],
  "attention": [{ "key": "...", "label": "...", "count": 0,
                  "severity": "critical|warning", "tab": "taxdocs" }],
  "volume_trend": [{ "date": "2026-08-22", "count": 3 }],
  "integrations": { "quickbooks": false, "ai_extraction": true }
}
```

`workflow` and `attention` entries each carry a `tab` — every count must be
clickable through to the tab that resolves it. A count with nowhere to go is
decoration.

Sums and averages come back `null` (not `0`) when nothing matches. Normalize
before rendering.

---

## Everything else

```
GET  /api/transactions                 ?category= &needs_review=true &q= &page=
POST /api/transactions/upload          bank/card statement CSV; categorizes inline, returns { imported, distinct_merchants, by_source }
POST /api/transactions/:id/categorize  { category, remember? } → { transaction, also_applied_to }
DELETE /api/transactions/:id

GET  /api/close                        ?period_month=YYYY-MM — derived readiness checks + manual tasks
POST /api/close/periods                { period_month }
POST /api/close/periods/:id/close  |  /reopen
POST /api/close/periods/:id/tasks      add a manual task
PATCH/DELETE /api/close/tasks/:id

GET  /api/matching/sources  |  POST /api/matching/sources   (CSV: PO / bank / receiving)
POST /api/matching/run                 two-way and three-way PO matching
GET  /api/matching/results

GET  /api/invoices/quick-review-queue  one uncertain field at a time
POST /api/invoices/:id/quick-review-field
POST /api/invoices/bulk-action         { ids, action: "approve"|"reject" }

GET  /api/org/settings  |  PATCH /api/org/settings
GET  /api/team  |  POST /api/team/invite  |  ...
POST /api/assistant/ask                { question, history? } — "Ask Rekono"
GET  /api/integrations/quickbooks/status | /accounts | /callback

GET  /api/export/csv            | /api/export/xlsx                    invoices
GET  /api/export/expenses/csv   | .../xlsx
GET  /api/export/vendor-documents/csv | .../xlsx
GET  /api/export/leases/csv     | .../xlsx
GET  /api/export/tax-documents/csv    | .../xlsx
```

### Downloads need the auth header

Exports and source-document previews are authenticated, so a plain
`<a href>` or `window.open` gets a 401. Fetch as a blob and click a synthetic
link — and read the filename off `Content-Disposition` rather than the URL
path, or every download lands with the wrong name:

```ts
const res  = await api(path);                       // adds the Bearer header
const name = /filename="?([^"]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1];
const url  = URL.createObjectURL(await res.blob());
Object.assign(document.createElement("a"), { href: url, download: name ?? "download" }).click();
URL.revokeObjectURL(url);
```

---

## Known issue worth fixing in the rebuild

The current UI horizontally overflows on mobile at 390px on **all five**
queue tabs — `.queue-layout` is a `1fr 1.3fr` grid that never collapses in the
mobile breakpoint. If you rebuild in Tailwind, stack the list and detail panes
below `md:` and give wide tables their own `overflow-x-auto` container.
