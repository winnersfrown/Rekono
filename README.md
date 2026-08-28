# Rekono

AI-powered invoice ingestion, extraction, and reconciliation for accounts payable, with a real double-entry general ledger underneath it. Upload an invoice, get back structured, confidence-scored data, review/correct what the model wasn't sure about, match it against your POs or bank statement -- and have its approval post itself to the books automatically.

This repo is the MVP described below: upload → extract → review → export → single-rule matching, plus a general ledger foundation (chart of accounts, journal entries, trial balance) that invoice approval posts to automatically. It's built to extend cleanly toward the fuller architecture (email ingestion, financial statements, revenue recognition, richer reconciliation) without a rewrite.

## MVP scope

1. Upload a PDF/image invoice → OCR → LLM structured extraction → confidence-scored JSON.
2. Review UI: side-by-side source document + editable extracted fields, low-confidence fields highlighted, approve/reject with a full audit trail.
3. Export approved (or all) invoices to CSV/Excel.
4. One matching rule: fuzzy vendor name + amount tolerance + date window against an uploaded PO or bank statement CSV -- extended to a three-way check (ordered / received / billed) once goods receipts are uploaded.
5. Accounts: email/password signup creates an organization; every invoice, match source, and audit log entry is scoped to it, so separate customers/teams never see each other's data.
6. Onboarding + plans: right after signup, a short wizard collects a few personalization questions and a plan choice (Free, or a paid tier via Stripe Checkout) before the dashboard loads. Every data-touching endpoint returns `402` until an org has completed this (see `plan.js`) -- `onboarding_required` if no plan was ever chosen, `billing_required` if a paid plan's subscription lapsed or was never completed. Each plan has a monthly document cap, enforced on upload (see `plans.js`, `routes/ingestion.js`).

## Architecture

```
Upload (PDF/image) ──▶ Storage (local disk / S3-compatible later)
                             │
                             ▼
                    In-process job queue ──▶ background worker
                             │
                             ▼
                    OCR (Tesseract) ──▶ raw text
                             │
                             ▼
        LLM structured extraction (Gemini, forced function calling)
        or heuristic regex fallback when no API key is configured
                             │
                             ▼
        Confidence scoring: per-field LLM confidence
        + automatic cross-check (line items sum ≈ total)
                             │
                             ▼
              Postgres/SQLite: Invoice, LineItem, AuditLog
                             │
                 ┌───────────┴────────────┐
                 ▼                        ▼
          Review UI (approve/         Matching engine
          correct, writes audit       (fuzzy vendor + amount
          log entries)                tolerance + date window
                 │                    vs. uploaded PO/bank CSV)
                 ▼                        │
          CSV / Excel export ◀────────────┘
```

**Ingestion layer** (`backend/src/storage.js`, `routes/ingestion.js`): accepts direct file upload today. Everything downstream depends only on "there's a normalized PDF/image on disk and an Invoice row" — so email-inbox and watched-folder/Drive ingestion (see Roadmap) are additive front-ends onto the same pipeline, not a redesign.

**Extraction layer** (`ocr.js`, `extraction.js`, `confidence.js`) — the core IP:
- OCR by shelling out to Tesseract + Poppler's `pdftoppm` (same system binaries a Python OCR stack would use, so behavior/accuracy doesn't depend on the runtime language). Swapping in AWS Textract or Google Document AI's purpose-built invoice parser is a drop-in replacement behind `ocr.extractText`.
- Structured extraction via an LLM, using forced function calling to get a fixed JSON schema back (vendor, invoice #, dates, PO reference, totals, line items) with a self-reported confidence per field. Either [Gemini](https://aistudio.google.com) (free key, no credit card) or [OpenRouter](https://openrouter.ai) (one API in front of many providers' models) works -- see "LLM provider" below.
- If no LLM is configured, a heuristic regex extractor takes over so the full pipeline (ingest → extract → review → export → match) still runs end-to-end for demos, tests, and CI. Heuristic fields get a flat, low confidence score, which naturally routes them into the review queue instead of silently shipping bad data.
- Confidence scoring combines per-field confidence with an automatic cross-check (do line items sum to the total, or subtotal + tax = total?). A failed cross-check pulls overall confidence down independent of what the model claimed.
- **Risk-based auto-approval** (Business/Scale, `plans.js`'s `riskBasedAutoApproval`, off by default even on a qualifying plan -- opt-in per org in Settings): an invoice that would already be fast-tracked as `extracted` (passes the confidence bar and cross-check, isn't a duplicate or possible multi-invoice) skips the manual "click Approve" step too if it's also low business risk -- a known vendor (has a learned `VendorAlias` for this org, i.e. a human corrected/confirmed it before) and at or under the org's own configured dollar ceiling. This never overrides a flagged review; it only removes a redundant click for spend that was already trustworthy on its own. Every auto-approval gets its own `auto_approved` audit log entry (reason, total, confidence) so it's fully traceable, never a silent skip. See `pipeline.js`'s `shouldAutoApprove`.
- **Quick Review** (dedicated sidebar tab): a needs_review invoice normally requires opening its full detail view even if only one field is actually uncertain. Quick Review instead flattens every low-confidence field across every eligible needs_review invoice (excluding ones flagged for a duplicate or possible multi-invoice, which need real judgment on the whole document) into one queue, reviewed a single field at a time -- confirm the prefilled value or correct it, Enter moves straight to the next. Confidence and the cross-check are recomputed after each field (`confidence.js`'s `score`, reused rather than re-derived); once nothing on an invoice is left flagged, it's auto-approved. See `GET /api/invoices/quick-review-queue` and `POST /api/invoices/:id/quick-review-field`.
- **Statistical sampling** (Business/Scale, same `riskBasedAutoApproval` gate and opt-in-per-org shape as auto-approval above): an auto-approved invoice never gets a human's eyes otherwise, so a configurable fraction of them (`Organization.sampleReviewRate`) get randomly flagged (`pipeline.js`'s `shouldSampleForQa`) for a retrospective spot-check -- catching drift in auto-approval decisions without reviewing every invoice it clears. Reviewing a sampled invoice (Settings tab's "Pending spot-checks" list) is purely a QA record -- it never changes the invoice's own status or touches QuickBooks; a real issue is a signal to revisit the org's settings, not something this route undoes automatically. See `GET /api/invoices/qa-sample-queue` and `POST /api/invoices/:id/qa-review`.
- Learned vendor aliases (`vendorAlias.js`): correcting a vendor name in review (`PATCH /api/invoices/:id`) remembers the original raw text → corrected name for that org. The next extraction whose raw vendor text matches exactly gets the corrected name applied automatically with a confidence boost, instead of needing the same correction every time that vendor's invoices come in.
- Possible-multi-invoice flag: extraction only ever fills in one invoice's worth of fields, so a document that actually contains more than one (a batch scan, several invoices in one PDF) forces review instead of silently extracting just the first one. The LLM self-reports this; the heuristic fallback flags more than one distinct invoice number found in the text.

**Matching/reconciliation engine** (`matching.js`, `routes/matching.js`): fuzzy vendor-name matching (`fuzzball`, a FuzzyWuzzy/rapidfuzz-style token-sort ratio) plus configurable amount tolerance (% and absolute) and a date window, with an exact PO/reference-number match as a strong signal. Produces `matched` / `partial` / `unmatched` with a human-readable reasoning string for every decision — this is the part of the system closest to a constraint-matching problem.

**Three-way matching** (`matching.js`'s `findThreeWayMatch`): two-way matching answers "does this invoice line up with something on file?". Three-way answers the question AP actually has before releasing money — *was this ordered, did it arrive, and is the bill consistent with both?* An invoice that reconciles perfectly against its PO still isn't safe to pay if nothing was ever received, and that gap is the most common way a finance team pays for goods it never got. Upload a goods-receipts CSV (`source_type=receiving`) and `POST /api/matching/run` automatically switches from two-way to three-way — inferred from the uploaded sources rather than a mode flag, since uploading receipts is already an unambiguous statement that you want them checked, with the mode used echoed back in the response either way. Each invoice is scored against the PO entries and the goods-receipt entries as two independent legs, and only a full `matched` on a leg counts as that leg being satisfied (a `partial` is precisely the case where you can't be confident it's the same transaction, which isn't a basis for paying). The combined verdict lands in `MatchResult.threeWayOutcome`: `matched`, `no_receipt` (billed and ordered but nothing delivered — don't pay), `no_po` (received and billed but never authorized), or `unmatched`. Bank entries are deliberately not a leg: they evidence that money left the account, which is the payment-reconciliation job (see the QuickBooks section), not the pre-payment authorization check. `threeWayOutcome` is a nullable plain string alongside the original `status` enum rather than new enum values, so every existing consumer (the exports' `match_status` column, the dashboard's unmatched count, the results table's badge) keeps working untouched and a two-way result stays distinguishable by its `null`.

**Data layer** (`models/`): Postgres in production (SQLite by default for local dev — no separate DB server needed to try it out) via Sequelize. Every extraction, human correction, approval/rejection, and match decision writes an `AuditLog` row — the audit trail that finance/compliance conversations will ask about. Every table that holds customer data (`Invoice`, `MatchSource`, `AuditLog`) carries an `orgId`, and every route filters by the authenticated user's org — enforced entirely in application code (every query scopes by `req.currentUser.orgId`, verified route-by-route; there's no database-level row-level security layer underneath it) and locked in by regression tests (`tests/orgIsolation.test.js` plus the cross-org tests alongside each feature) rather than by convention alone — see `auth.js` and `models/` (`Organization`, `User`).

**Auth** (`auth.js`, `routes/auth.js`): email + password, bcrypt-hashed, stateless JWT bearer tokens (14-day expiry). Signup creates a new `Organization` plus its first `User` (`role: "owner"`). `SECRET_KEY` is read from the environment if set, otherwise auto-generated and persisted to a local file on first run — fine for a single instance, but set it explicitly (Render's Blueprint does this for you) for any deployment with more than one replica.

**Team invites** (`seats.js`, `routes/team.js`): the org's owner can invite teammates by email, up to the plan's seat count (`plans.js`'s `seats` -- `null` means unlimited; a pending invite reserves a seat so the cap can't be oversubscribed before anyone accepts). The invite email links to `/?invite_token=...`, which lets the invitee set a name and password and creates a `role: "member"` User on the same org -- no separate signup, no second organization. Degrades the same way as the other Resend-gated flows: without `RESEND_API_KEY` configured, the invite still gets created and its link is handed back directly in the API response instead of emailed.

**Onboarding & billing** (`plans.js`, `plan.js`, `routes/onboarding.js`, `routes/billing.js`): a new org's `plan` is `null` until the post-signup wizard completes -- `plan.js`'s `requireActivePlan` middleware (mounted the same way `requireActiveTrial` used to be) blocks every data route until it does. Picking Free activates instantly; picking a paid tier creates a Stripe Checkout session with the price built inline from `plans.js` (`price_data`, not a dashboard-configured Product/Price -- so standing up billing only ever needs a Stripe account + API keys, nothing to keep in sync by hand) and only activates the plan once Stripe confirms payment, both via the redirect back (`GET /api/billing/confirm`) and a webhook (`POST /api/billing/webhook`) that also keeps the plan in sync with renewals/cancellations afterward. `GET /api/billing/portal` hands off to Stripe's own hosted billing-management UI rather than a custom one. All of it degrades to a clear `503` instead of crashing when `STRIPE_SECRET_KEY` isn't set, same pattern as the Gemini/Resend integrations.

**Output/integration layer** (`routes/export.js`): CSV/Excel export today. QuickBooks/Xero/NetSuite push integrations are additive on top of the same Invoice/MatchResult data (see Roadmap).

**Review UI** (`backend/public/`): a small vanilla-JS single-page app (no build step) behind a login/signup gate, laid out as a sidebar (nav + recent uploads, clickable straight into the Review Queue) next to a main panel: Ask Rekono / Upload / Review Queue / Matching / Export / Team / Settings. The review queue shows the source document next to editable extracted fields, with low-confidence fields visually flagged; corrections are saved via `PATCH /api/invoices/:id` and logged to the audit trail. A fresh signup lands in a two-step onboarding wizard first (a few personalization questions, then a plan picker) rather than straight in the dashboard -- picking a paid plan hands off to Stripe Checkout before the dashboard ever loads. Settings covers account (name, password), organization (name, owner-only), billing (plan summary, Stripe's hosted "Manage billing" portal, upgrade), and the review-queue confidence threshold.

**Ask Rekono** (`assistant.js`, `routes/assistant.js`): a grounded Q&A assistant over the org's own invoice data, reachable from the dashboard's default view. Each question hands Gemini the org's invoice data as JSON plus the question, instructed to answer only from that data; the client also resends the visible thread (capped to the last 6 exchanges) so follow-ups like "what about just the unpaid ones" resolve against the previous answer, without the server persisting any conversation state. Deliberately read-only -- it can summarize, count, and total, but it cannot approve, reject, export, or otherwise act, so there's no risk of an LLM mistake touching anyone's books. Needs an LLM configured; without one the endpoint returns `503` with a clear message rather than crashing.

**Expense Receipts** (`extractionReceipts.js`, `confidenceReceipts.js`, `expensePipeline.js`, `routes/expenses.js`, `ExpenseReceipt` model): a second document-processing pipeline, built by copying the invoice pipeline's shape (upload → OCR → LLM/heuristic extraction → confidence-gated review → approve/reject → export) onto a different document type and schema instead of generalizing the invoice code into a shared abstraction across two independently-evolving domains. A receipt has a merchant, date, category (from a fixed list, so the LLM classifies into it directly rather than inventing labels), currency, tax, and amount — no line items, no PO reference, no vendor matching. Confidence scoring is a plain weighted average of per-field confidence (`confidenceReceipts.js`) with no line-items-sum-vs-total cross-check, since a receipt has nothing to cross-check the total against. Deliberately v1-scoped: no bulk actions, no Quick Review queue, no auto-approval, no statistical sampling, no vendor-alias learning, no duplicate detection, no QuickBooks push — the same core loop the invoice pipeline itself started with before those grew on top of it one at a time. Shares the invoice pipeline's job queue (`jobs.js` dispatches by `kind`), monthly document cap (`documentUsage.js` sums both tables — one budget for total OCR/LLM spend per org, not a cap per document type), and confidence threshold setting. Reachable from the dashboard's "Expenses" sidebar tab, with its own CSV/Excel export.

**Vendor Documents** (`extractionVendorDocs.js`, `confidenceVendorDocs.js`, `vendorDocPipeline.js`, `routes/vendorDocuments.js`, `VendorDocument` model): a third document-processing pipeline, same shape as the two above, applied to vendor compliance paperwork -- W-9s, certificates of insurance, and contracts. Extracted fields are generic across all three types rather than one schema per type: vendor name, document type (classified from a fixed list, same reasoning as receipts' category), effective date, expiration date, a reference number (a TIN/EIN on a W-9, a policy number on a certificate of insurance, a contract number on a contract), and an amount (coverage limit or contract value; blank on a W-9). Confidence scoring weights vendor name and document type more heavily than the other fields, since expiration date/reference number/amount don't apply to every document type -- a valid W-9 extraction with no expiration date shouldn't score as if a field were missing. This module's one feature beyond the other two pipelines' core loop: `GET /api/vendor-documents?expiring_within_days=N` (and the dashboard's "Expiring within 30 days" filter) surfaces everything expiring soon or already expired, since flagging what's about to lapse before it does is the whole reason this module exists -- a document with no expiration date at all (a W-9) is correctly never "expiring". Same v1 scope as expense receipts otherwise (no bulk actions, Quick Review, auto-approval, QA sampling, vendor-alias learning, duplicate detection, or QuickBooks push), and shares the same job queue, monthly document cap, and confidence threshold. Reachable from the dashboard's "Vendor Docs" sidebar tab, with its own CSV/Excel export.

**Leases** (`extractionLeases.js`, `confidenceLeases.js`, `leasePipeline.js`, `routes/leases.js`, `Lease` model): a fourth document-processing pipeline, same shape as the three above, applied to commercial lease abstraction -- rent, escalations, and the two dates a lease actually needs tracked. Extracted fields: landlord name, property address, commencement date, expiration date, a renewal-option notice deadline, monthly rent, and an annual rent-escalation percentage. Unlike vendor documents' single expiration date, a lease has two dates worth flagging -- its own expiration, and the (often much earlier) deadline to notify the landlord in order to exercise a renewal option, tracked as its own field since missing that deadline forfeits the option even though the lease itself hasn't ended. `GET /api/leases?expiring_within_days=N` (and the dashboard's "Expiring or renewal notice due within 90 days" filter -- a longer window than vendor documents' 30, since lease decisions have a longer lead time than an insurance certificate's) matches on *either* date landing inside the window; a lease with neither date set is never "expiring". The queue table shows whichever of the two dates comes first; the detail view shows both, each with its own status banner. Confidence scoring weights landlord name and property address most heavily, since those identify which lease this even is. Same v1 scope as the other two document pipelines otherwise (no bulk actions, Quick Review, auto-approval, QA sampling, vendor-alias learning, duplicate detection, or QuickBooks push), and shares the same job queue, monthly document cap, and confidence threshold. Reachable from the dashboard's "Leases" sidebar tab, with its own CSV/Excel export.

**Tax Documents** (`extractionTaxDocs.js`, `confidenceTaxDocs.js`, `taxDocPipeline.js`, `routes/taxDocuments.js`, `TaxDocument` model): a fifth document-processing pipeline, same shape as the four above, applied to the inbound tax forms that arrive every January -- 1099-NEC/MISC/K/INT/DIV, W-2s, 1098s and K-1s (classified from a fixed list, same reasoning as receipts' category). Extracted fields: form type, tax year, payer, recipient, the recipient's TIN, the form's headline dollar figure (which box that is differs per form -- box 1 nonemployee compensation on a 1099-NEC, box 1 wages on a W-2, gross payments on a 1099-K), and federal tax withheld.

Two things are specific to this module rather than inherited from the other four. **First, taxpayer IDs are reduced to their last four digits on the way in and never stored in full.** These forms carry SSNs, and a full SSN in a database column -- flowing out through every CSV export onto someone's laptop -- is a liability with no matching upside: last-four is the standard reconciliation key, and the whole number is still in the stored source document if anyone genuinely needs it. That narrowing happens at three points, because any one of them alone would leave a hole: extraction (`tinLast4`, applied to the LLM's output too, in case a model returns the whole number despite being asked not to), the correction route (a reviewer naturally types what's printed on the form, so `PATCH` narrows it server-side -- and the review field deliberately has *no* `maxlength`, since a 4-character cap would keep the *first* four characters, the wrong digits), and the raw OCR text (`redactTins` masks every TIN-shaped run before `rawOcrText` is persisted, so the stored OCR isn't a second unmasked copy). A TIN too short to narrow is rejected with a 422 rather than silently stored as blank, which would be indistinguishable from "this form shows no TIN".

**Second, the filters are tax year, form type, and missing-TIN** rather than a date window. Every one of these documents belongs to exactly one year and working through them means working a year at a time, so `GET /api/tax-documents?tax_year=N` is the primary lens, and the list response carries totals (reported amount, federal tax withheld, count by form type) computed over the whole filtered set rather than the current page -- "what do I report for 2025" is the question the year filter exists to answer, and a per-page sum would answer a different one. `?missing_tin=true` surfaces the one defect on these forms that carries a deadline and a penalty: an information return filed without the payee's TIN is what triggers an IRS B-notice and backup withholding, so it gets its own one-click view and its own dashboard attention row (scoped to extracted/approved forms -- one still in review simply hasn't been read yet). Confidence scoring weights form type and tax year most heavily, since getting either wrong misfiles the document somewhere nobody will look again; the TIN is weighted lightest, being four digits a reviewer can confirm at a glance against the preview pane. Same v1 scope as the other pipelines otherwise, and shares the same job queue, monthly document cap, and confidence threshold. Reachable from the dashboard's "Tax Docs" sidebar tab, with its own CSV/Excel export.

**Month-end close** (`routes/close.js`, `ClosePeriod`/`CloseTask` models): the recurring checklist a finance team works through to sign off a month's books -- deliberately not a generic to-do list, because a close checklist is only worth having inside Rekono if it can answer the questions Rekono already knows the answer to. A period has two halves. **Readiness checks** are recomputed from live data on every read and can't be ticked by hand, only resolved: invoices and expense receipts still awaiting review, documents still extracting, failed extractions, approved invoices not yet reconciled, pending auto-approval spot-checks, and vendor documents expired as of period end. A stored "all invoices reviewed" flag would be wrong the moment someone uploads another invoice, so these are derived rather than persisted (there's a test pinning exactly that). Each one links to the tab where you'd actually fix it. **Manual tasks** are the judgment work a human does and then attests to (reconcile statements, post accruals, controller sign-off), seeded from a template and fully editable, each recording who ticked it and when -- cleared on un-ticking so a re-completed task never carries a stale attestation. The readiness window is everything created *before the period ends*, not just within its own month: a straggler from July blocks an honest August close just as much as an August one does. Closing is deliberately **not** gated on a clean board -- a close is a human attestation and there are legitimate reasons to sign off with a known exception -- but whatever was still outstanding at that moment is captured in the `close_period_closed` audit entry, so the exception is on the record rather than silently invisible. A closed period's checklist is frozen until it's reopened (which leaves its own audit entry), since editing it after the fact would rewrite what was attested to.

**AI transaction categorization** (`transactionCategorization.js`, `routes/transactions.js`, `Transaction`/`MerchantCategory` models): upload a bank or card statement as CSV and every line gets an expense category from the same fixed list receipts use (`EXPENSE_CATEGORIES`), so a card charge and its receipt land in the same bucket rather than two parallel taxonomies. The central design decision is that this categorizes **distinct merchants, not transactions** -- twenty Starbucks charges are one question, not twenty -- which is what makes a single batched LLM call viable where per-row calls would be slow and expensive. Descriptors are normalized first (`normalizeMerchant`): processor prefixes (`SQ *`, `TST*`, `PAYPAL *`), trailing `CITY ST`, per-charge store numbers and dates are all stripped, so `SQ *BLUE BOTTLE COFFEE 1123 SAN FRANCISCO CA` and `BLUE BOTTLE COFFEE` collapse to one merchant. Three tiers run cheapest-first: **learned** (a human already ruled on this merchant for this org -- no API call), **ai** (one batched Gemini call for whatever's left, with any category outside the fixed list rejected so a model can't invent "Groceries" and poison every downstream filter and report), and **heuristic** (keyword match when there's no API key or the call fails, at deliberately low confidence so it routes to review). Anything none of the three can place stays uncategorized rather than being guessed into "Other". Correcting a category writes a `MerchantCategory` mapping and back-applies to that merchant's other un-reviewed rows in the same statement -- but never to rows a human already reviewed, whose explicit decision wins -- so one correction settles the whole merchant and the *next* statement needs no review for it at all. Unlike the QuickBooks expense-account suggestion (which has no heuristic path, since matching free text against an arbitrary user-defined chart of accounts isn't something a regex can do), this works without `GEMINI_API_KEY` because the category list is fixed.

**Stack**: Node.js 22 + Express + Sequelize (SQLite/Postgres), plain JavaScript (ESM, no build step/TypeScript compile) so `docker run`/`node src/server.js` is all it takes to run it, matching the no-build-step philosophy of the frontend it's paired with.

## Running locally

Requires Node.js 20+, and the Tesseract + Poppler system binaries for OCR:

```bash
# macOS
brew install tesseract poppler
# Debian/Ubuntu
sudo apt-get install tesseract-ocr poppler-utils
```

```bash
cd backend
npm install
cp ../.env.example .env   # set an LLM key to enable LLM extraction (optional)
npm run dev
```

Open http://localhost:8000 for the review UI. With no LLM configured, extraction falls back to the heuristic extractor, so you can exercise the whole pipeline immediately.

Try it with the bundled sample data in `sample_data/`: sign up (creates your organization), then upload `sample_invoice.pdf` on the Upload tab, then upload `sample_po.csv` (as Purchase Orders) and `sample_bank.csv` (as Bank Statement) on the Matching tab and click "Run Matching". Regenerate the sample PDF with `python sample_data/generate_sample_invoice.py` (needs `pip install reportlab` -- this one utility script is Python since it's dev-tooling, not part of the running app).

### Docker

```bash
docker compose up --build
```

Runs the app against Postgres instead of SQLite. Set `GEMINI_API_KEY` (or `OPENROUTER_API_KEY` + `OPENROUTER_MODEL`) in your shell environment before `docker compose up` to enable LLM extraction.

### Deploying a live instance (Render)

Everything above runs locally or in your own Docker Compose — nothing is publicly reachable until you deploy it somewhere. `render.yaml` is a [Render Blueprint](https://render.com/docs/blueprint-spec) that provisions the web service on Render's **free** plan. It deliberately does **not** provision Render's own Postgres — see "Database (Neon)" below for why — so you'll need a Postgres connection string from elsewhere (Neon's free tier is the recommended option) before deploying.

1. Create a free Neon project (see "Database (Neon)" below) and copy its connection string.
2. Push/fork this repo to your own GitHub.
3. In Render: **New → Blueprint**, point it at the repo. (If you don't see "Blueprint" as an option, your account may only show the per-resource flow — create a **Web Service** pointed at this repo's `Dockerfile` instead, and set its env vars to match `render.yaml`: `DATABASE_URL` set to your Neon connection string, `STORAGE_DIR=/tmp/storage`, a random `SECRET_KEY`, and optionally `GEMINI_API_KEY`.)
4. Once deployed, set `DATABASE_URL` to your Neon connection string, plus optionally `GEMINI_API_KEY`, `RESEND_API_KEY`, and/or `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` in the web service's environment variables (Render dashboard) to enable LLM extraction, the contact form, and paid plans respectively — all optional, all degrade to a clear error instead of crashing when unset. `SECRET_KEY` is wired up automatically by the Blueprint.
5. Your app is live at `https://<service-name>.onrender.com`.

One tradeoff that comes with staying on free: web services can't attach a persistent disk, so uploaded invoice files live in the container's ephemeral storage and don't survive a restart/redeploy — the extracted data and audit trail in the database are unaffected, only the original source files (used for the review UI's document preview) aren't. Free web services also spin down after 15 minutes idle and cold-start on the next request.

### Database (Neon)

`DATABASE_URL` needs to point at a real Postgres instance for any deployed environment (SQLite, the local default, is fine for dev but isn't meant for concurrent production traffic). [Neon](https://neon.tech) is the recommended option for Render specifically: Render's own free Postgres plan auto-deletes the whole database after 30 days of the *plan*, not of inactivity, whereas Neon's free tier persists indefinitely (an idle project scales its compute to zero, but the data itself is never deleted).

1. Sign up at [neon.tech](https://neon.tech) (free tier, no credit card required) and create a project.
2. From the project dashboard, copy the **connection string** (**Connect** → the pooled connection string is fine for this app's connection volume).
3. Set `DATABASE_URL` to that connection string wherever the backend runs (Render dashboard, or `.env` locally) — no other code or config changes needed, since this app already talks to Postgres through Sequelize via `DATABASE_URL` alone.
4. On first boot against a fresh database, `initDb()` creates every table automatically (see `models/index.js`) — no manual migration step.

**If the deployed database ever gets into a broken schema state** that `initDb()`'s normal additive-only sync can't recover from on its own (its console logs will say so explicitly if this happens), there's a deliberately scary, explicitly-gated escape hatch: set `DANGEROUSLY_RESET_DB=true` in the web service's environment variables and redeploy. On boot, the app drops and recreates the entire `public` schema, then rebuilds every table fresh from the current models — **this permanently deletes all data**. Remove the env var again immediately after confirming it worked; it stays set across restarts otherwise, and every future boot would wipe the database again. This is meant for the "app is broken and there's nothing worth recovering" case (e.g. still in development), not a substitute for real backups or a real migration once there's data worth keeping.

### Tests

```bash
cd backend
npm test
```

Covers the confidence cross-check logic, the fuzzy matching engine, the heuristic extraction fallback, signup/login + cross-org data isolation, Google sign-in's find-or-create-by-verified-email logic and single-use handoff codes, onboarding + plan gating (`onboarding_required`/`billing_required`, including a "trialing" subscription counting as active), per-plan document cap enforcement and the "documents used this month" figure `GET /api/auth/me` reports, Stripe-backed billing routes (structurally, via their `503`-when-unconfigured path, plus unit coverage of the checkout-session/trial-period and subscription-replacement logic against a fake Stripe client), password reset, OCR error handling (missing files and unreadable images surface as a clean `OcrError` instead of a raw subprocess exception), the job queue's safety net that fails an invoice outright rather than leaving it stuck on "processing" forever if something throws unexpectedly mid-pipeline, startup recovery of invoices orphaned by a restart (re-run through the normal pipeline, or failed cleanly with a re-upload prompt if the source file didn't survive), duplicate-invoice detection (`findDuplicateInvoice`), the Business/Scale-only confidence threshold override (`effectiveConfidenceThreshold`, plus its own API route's plan gating), risk-based auto-approval (`shouldAutoApprove`'s every gating condition, plus the settings route's plan gating and its can't-enable-without-a-ceiling validation), learned vendor-name aliases (`vendorAlias.js` -- a corrected vendor name is remembered and auto-applied, with a confidence boost, the next time that exact raw text is extracted for the same org), the possible-multi-invoice heuristic (more than one distinct invoice number in a document forces review), team invites (seat-cap enforcement, owner-only permission checks, the full invite → accept → same-org-member flow, revoking/removing), the global error handler never leaking a raw internal error message to the client (a genuinely malformed multipart upload is the real-world trigger this test uses), the core API endpoints (upload validation, matching upload/run, corrections + audit log, approval, export, a missing source file returning a clean 404), a battery of security-hardening checks (uploaded files are only ever served back with a content-type derived from a fixed extension allowlist, never the client-supplied one -- including a disguised executable with a spoofed PDF content-type; oversized uploads are rejected with a clean `413`; login, signup, and the AI assistant all rate-limit repeated requests from the same account/IP; CSV/Excel export neutralizes formula-injection payloads with a leading apostrophe instead of exporting a live formula; and every response carries the standard `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy` headers), the Settings page's account/organization management (updating a user's own name, changing password with current-password verification and its own rate limit, renaming the organization gated to the owner role, and that renaming doesn't clobber an untouched confidence threshold in the same request), deleting a document (removes it from every list/detail view and from duplicate-detection candidates regardless of its status, is scoped to the caller's org, and -- since it's a soft delete -- still counts toward the plan's monthly document cap so it can't be used to get free upload quota), and bulk-approving/rejecting invoices (applies to every eligible invoice in one call, skips -- without failing the rest of the batch -- anything approve's status restriction rejects or that belongs to another org, reject has no status restriction the same way the single-invoice route doesn't), and retrying a failed extraction (re-queues and clears the error message, is blocked once approved, and 404s for a nonexistent or another org's invoice), and the invoice list's pagination, search, and sort (`page`/`page_size` bounds and the reported `total`, `q` matching vendor name and invoice number case-insensitively regardless of Postgres vs. SQLite, and `sort`/`order` honoring the fixed field allowlist rather than an arbitrary column), and Ask Rekono's conversation-history handling (a well-formed `history` array clears validation, a malformed role or an oversized array is rejected with a `422`), and deleting a matching source (removes it and its entries, is scoped to the caller's org, 404s the second time or for one that never existed, and leaves past match results in place with `match_entry_id` gone `null` rather than cascading into the audit trail). `tests/orgIsolation.test.js` collects the cross-org boundary checks that don't already live next to their own feature's tests in one place: an invoice's detail/file/audit-log/correction/approve/reject routes all 404 for another org, CSV/Excel export never includes another org's rows, and a matching run never treats another org's uploaded source as a candidate; `billing.js`'s `checkoutSessionBelongsToOrg` (stopping a signed-in user from hand-crafting someone else's real Stripe session id to activate billing on their own org) and team management's org scoping (`GET /api/team`, revoking an invite, removing a member) get the same direct coverage The expense receipts, vendor documents, leases, and tax documents modules each get the same shape of coverage against their own suite of test files: heuristic extraction, weighted-average confidence scoring, upload/list/search/detail/correct/approve/reject/retry/delete, CSV/Excel export (incl. formula-injection neutralization), cross-org isolation, the shared monthly document cap counting all five document types together, and orphaned-job recovery picking up stuck receipts/vendor documents/leases/tax documents alongside stuck invoices. Vendor documents and leases additionally cover their own `expiring_within_days` filter: a document expiring soon or already expired is included, one expiring further out is excluded, one with no expiration date at all (a W-9) is never treated as "expiring", and the filter never crosses an org boundary; leases specifically also cover a lease whose expiration is far off but whose renewal-notice deadline is coming up soon still being surfaced (the filter matches on either date). Tax documents cover their own tax-year/form-type/missing-TIN filters and the list totals being computed over the whole filtered set rather than the current page, plus the three places a taxpayer ID is narrowed to its last four digits: extraction (including picking the *recipient's* TIN when a form shows both the payer's and the recipient's, and refusing to guess when two are present and neither is labeled), the correction route (a full number typed in by a reviewer is narrowed — including in the audit trail — and one too short to narrow is rejected rather than silently blanked), and `redactTins` scrubbing the raw OCR text. That last one is covered end-to-end through a real Tesseract pass over a generated W-2 rather than only at the unit level, which is also what caught the OCR-renders-apostrophes-as-’ case the label patterns now handle — 585 tests total, all without a live Gemini/Resend/Stripe/Google key or a real Postgres database, so they run in plain CI. A handful of tests do shell out to the real Tesseract/Poppler binaries the Dockerfile installs (exercising real OCR failure paths); install both locally (`apt install tesseract-ocr poppler-utils` / `brew install tesseract poppler`) before running `npm test` outside Docker.

## API surface

Every endpoint below except `/api/auth/signup`, `/api/auth/login`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/google*`, `/api/demo/login`, `/api/team/invite/:token` (both the `GET` check and the `POST .../accept`), and `/api/health` requires an `Authorization: Bearer <token>` header, and every result is scoped to that token's organization. Every endpoint except those auth/invite-acceptance routes also returns `402` once that org's onboarding/billing state isn't active (`onboarding_required` or `billing_required` -- see `plan.js`).

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/signup` | Create an organization + first user, returns a bearer token |
| `POST /api/auth/login` | Email + password → bearer token |
| `GET /api/auth/google` | Redirects to Google's OAuth consent screen (requires `GOOGLE_CLIENT_ID`) |
| `GET /api/auth/google/callback` | Google redirects back here; finds or creates the account by verified email and redirects to `/` with a single-use handoff code |
| `GET /api/auth/google/exchange` | `{code}` from that redirect → bearer token (the actual token is never put in a URL) |
| `POST /api/demo/login` | Public, no request body. Seeds a brand-new org with realistic sample data across every document type and returns a bearer token -- the "View live demo" flow, see Demo mode below |
| `POST /api/auth/forgot-password` | Email a password reset link (requires `RESEND_API_KEY`; always responds the same way regardless of whether the email matches an account, to avoid leaking which emails are registered) |
| `POST /api/auth/reset-password` | `{token, password}` from the emailed link → new password, returns a bearer token (signs the user in) |
| `GET /api/auth/me` | Current user + org name + plan status (`plan`, `billing_period`, `subscription_status`, `trial_ends_at`, `onboarding_completed`, `documents_used_this_month`, `document_cap`), for verifying a stored token |
| `PATCH /api/auth/me` | Update the caller's own `full_name`. Returns the same shape as `GET` |
| `POST /api/auth/change-password` | `{current_password, new_password}` for a signed-in user to change their own password without an emailed reset link (works even when `RESEND_API_KEY` isn't configured) |
| `POST /api/onboarding` | Personalization answers + plan choice. Free activates immediately; a paid plan returns a Stripe Checkout URL to redirect to |
| `POST /api/billing/checkout` | Start a Stripe Checkout session for a plan change (same mechanism onboarding uses for its first plan choice) |
| `GET /api/billing/confirm?session_id=` | Called on the redirect back from Stripe Checkout; verifies the session belongs to the caller's org and activates the plan |
| `GET /api/billing/portal` | Stripe's hosted billing-management session URL (update card, cancel, view invoices) -- surfaced in-app from the Settings tab's Billing section, not just the billing-required gate |
| `POST /api/billing/webhook` | Stripe webhook (signature-verified, not user-authenticated) -- keeps plan/subscription status in sync with renewals and cancellations |
| `GET /api/org/settings` \| `PATCH /api/org/settings` | Org-level settings: the review-queue confidence threshold (a Business/Scale-only override, `customConfidenceThreshold` in `plans.js`, of the server-wide `REVIEW_CONFIDENCE_THRESHOLD` default -- `PATCH` with `{confidence_threshold: null}` always resets to the default, on any plan), risk-based auto-approval (`auto_approval_enabled` + `auto_approval_max_amount`, also Business/Scale-only via `riskBasedAutoApproval` -- enabling without a max amount set is rejected with `422`; disabling or clearing the amount is always allowed, on any plan), statistical sampling (`sample_review_enabled` + `sample_review_rate`, same gating and can't-enable-without-a-rate shape), and the organization's name (`org_name`, owner-only to change). Any field can be patched independently of the others |
| `GET /api/invoices/quick-review-queue` | Flat queue of low-confidence `{invoice_id, field, value, confidence, ...}` items across every eligible needs_review invoice -- see "Quick Review" above |
| `POST /api/invoices/:id/quick-review-field` | `{field, value}` -- confirms or corrects one field, recomputes confidence/cross-check, auto-approves once nothing is left flagged |
| `GET /api/invoices/qa-sample-queue` | Auto-approved invoices randomly sampled for a spot-check, still awaiting one |
| `POST /api/invoices/:id/qa-review` | `{outcome: "confirmed" \| "issue_flagged", note?}` -- records a human's verdict on a sampled invoice; never changes its status |
| `GET /api/team` | List the org's members and pending invites, plus seat usage against the plan's limit |
| `POST /api/team/invite` | Owner-only. Invite by email, capped at the plan's seat count. Emails the invite link if `RESEND_API_KEY` is set, otherwise returns the link directly for the owner to share manually |
| `DELETE /api/team/invites/:id` | Owner-only. Revoke a pending invite, freeing its reserved seat |
| `DELETE /api/team/members/:userId` | Owner-only. Remove a teammate. The owner can't remove themself (no ownership transfer yet) |
| `GET /api/team/invite/:token` | Public. Validates an invite link and returns the org name + invited email, for the accept-invite page |
| `POST /api/team/invite/:token/accept` | Public. `{full_name, password}` → creates a `role: "member"` User on the inviting org, returns a bearer token |
| `GET /api/staff/overview` | Rekono staff only (`STAFF_EMAILS`), refused with `403` for everyone else. Aggregate, cross-org usage metrics -- org/plan counts, activation funnel, document volume, subscription health. See README.md's "Staff / cross-org usage dashboard" section |
| `GET /api/accounts` | List the org's chart of accounts, optionally filtered by `type` or `active` |
| `POST /api/accounts` | `{name, type, code?}` -- add a custom account. Rejects a duplicate name |
| `PATCH /api/accounts/:id` | Rename, re-code, or deactivate an account. A system account (the seeded defaults) can be renamed but not deactivated |
| `GET /api/journal-entries` | Paginated list of the org's journal entries, newest first, each with its total |
| `POST /api/journal-entries` | `{entry_date, memo?, lines: [{account_id, debit?, credit?}]}` -- posts a manual entry. `422` if it doesn't balance or has fewer than 2 lines |
| `GET /api/journal-entries/:id` | One entry with its full line detail |
| `POST /api/journal-entries/:id/void` | Posts the entry's exact mirror image and marks the original voided -- corrections are reversals, never edits or deletes |
| `GET /api/ledger/trial-balance` | Every account's debit/credit totals as of an optional `?as_of=` date, plus whether they balance to zero |
| `GET /api/statements/profit-and-loss` | Revenue, expenses, and net income over `?from=`/`?to=` (defaults to year-to-date). Accrual basis |
| `GET /api/statements/balance-sheet` | Assets, liabilities, and equity as of `?as_of=` (defaults to today), splitting derived prior-year retained earnings from current-year earnings, plus the fiscal year in effect and whether it balances |
| `GET /api/statements/cash-flow` | Cash movement over `?from=`/`?to=`, split into operating/investing/financing, plus whether it reconciles |
| `GET /api/customers` | List the org's customers, optionally `?active=true` |
| `POST /api/customers` | `{name, email?, payment_terms_days?}` -- add a customer. Rejects a duplicate name |
| `PATCH /api/customers/:id` | Rename, re-term, or deactivate a customer |
| `GET /api/customer-invoices` | Paginated list of issued invoices, filterable by `?status=`/`?customer_id=`, each with amount paid and outstanding |
| `POST /api/customer-invoices` | `{customer_id, issue_date, due_date?, lines:[{revenue_account_id, quantity, unit_price}]}` -- creates a **draft**. Due date defaults from the customer's net terms |
| `GET /api/customer-invoices/:id` | One invoice with its full line detail |
| `POST /api/customer-invoices/:id/send` | Draft → sent. Posts Debit Accounts Receivable / Credit each line's revenue account |
| `POST /api/customer-invoices/:id/void` | Reverses the invoice off the books. Refused if payments exist against it |
| `POST /api/customer-invoices/:id/payments` | `{amount, payment_date, deposit_account_id}` -- records cash received. Posts Debit deposit / Credit AR, and flips the invoice to `paid` once settled. Overpayment and depositing into AR itself are both refused |
| `GET /api/reports/ar-aging` | What customers owe, bucketed current / 1-30 / 31-60 / 61-90 / 90+ days past due as of `?as_of=` |
| `GET /api/revenue/pending` | What a recognition run through `?period_month=` would post, per period, without posting it |
| `POST /api/revenue/recognize` | `{period_month}` -- releases every pending month through that period out of deferred revenue. One journal entry per month |
| `GET /api/revenue/schedule` | Every scheduled month across the org, filterable by `?period_month=` / `?recognized=false` |
| `GET /api/customer-invoices/:id/revenue-schedule` | One invoice's schedule, recognized and pending, with the entry that recognized each month |
| `GET /api/reports/deferred-revenue` | The waterfall: what's unearned and which month each part releases in |
| `GET /api/recurring-entries` | Adjusting-entry templates with their lines, last posted period, and next due date |
| `POST /api/recurring-entries` | `{name, frequency, start_date, end_date?, lines}` -- must balance at creation |
| `POST /api/recurring-entries/depreciation` | `{cost, salvage_value, useful_life_months, ...}` -- builds a straight-line template that ends when the asset is fully depreciated |
| `GET /api/recurring-entries/pending` | What a run through `?as_of=` would post, without posting it |
| `POST /api/recurring-entries/run` | Posts every occurrence due through `as_of`, catching up periods nobody ran |
| `PATCH /api/recurring-entries/:id` | Rename, pause, or set an end date |
| `DELETE /api/recurring-entries/:id` | Stops future postings; entries already posted stay on the books |
| `GET /api/close/year-end` | The fiscal year's closable balances, whether it's closed, and whether it's gone stale since |
| `POST /api/close/year-end` | Zeroes revenue and expense into Retained Earnings, dated to the year's last day |
| `POST /api/close/year-end/reopen` | Reverses the closing entry and puts the balances back |
| `GET /api/equity/transactions` | Contributions, distributions, dividends and treasury movements, newest first |
| `POST /api/equity/transactions` | `{type, transaction_date, amount, cash_account_id?, shares?, par_value?, cost_basis?}` |
| `POST /api/equity/transactions/:id/void` | Reverses the posting; the record is kept |
| `GET /api/statements/stockholders-equity` | The roll-forward over `?from=`/`?to=`, tying to the balance sheet at both ends |
| `GET`/`POST /api/share-classes` | Classes of stock. `{name, par_value, authorized_shares?}` -- par in dollars per share, null authorized means no stated ceiling |
| `PATCH /api/share-classes/:id` | Rename, change the authorized ceiling, deactivate. Par value is deliberately not editable |
| `GET /api/share-classes/counts` | Authorized, issued, treasury, outstanding and unissued per class, at `?as_of=` |
| `GET`/`POST /api/shareholders` | Holders of record. `PATCH /:id` renames or deactivates |
| `GET /api/share-transactions` | Share movements, newest first. `?type=`/`?share_class_id=` filter |
| `POST /api/share-transactions` | `{type, share_class_id, transaction_date, shares, from_shareholder_id?, to_shareholder_id?, price_per_share?, equity_transaction_id?}` |
| `DELETE /api/share-transactions/:id` | Removes a movement. Refused if a later one depends on it |
| `GET /api/cap-table` | Every holder, their position in each class, and what share of the company that is, at `?as_of=` |
| `GET /api/share-register/reconciliation` | Common Stock divided by par against the shares the register says were issued, plus the equity transactions no movement claims |
| `GET`/`POST /api/equity-plans` | Option pools with reserved, granted, exercised and available counts at `?as_of=`. `{name, share_class_id, reserved_shares, adopted_date}` |
| `PATCH /api/equity-plans/:id` | Rename, raise the reserve (a board amendment), or close the plan. The share class is deliberately not editable |
| `GET`/`POST /api/equity-awards` | Grants with vested/exercised/exercisable computed at `?as_of=`. `{equity_plan_id, shareholder_id, type, grant_date, shares, strike_price?, vesting_start_date?, vesting_months?, cliff_months?}` |
| `POST /api/equity-awards/:id/exercise` | `{shares, event_date, cash_account_id?, equity_transaction_id?}` -- issues the shares onto the register and posts the strike money as a capital contribution |
| `POST /api/equity-awards/:id/cancel` | `{event_date, shares?}` -- forfeiture. Omit `shares` to cancel everything still outstanding |
| `GET /api/cap-table/fully-diluted` | Issued shares plus unexercised awards plus the unallocated pool, per holder, at `?as_of=` |
| `GET /api/stock-compensation` | The ASC 718 expense schedule month by month through `?through=`, each month flagged posted or not |
| `POST /api/stock-compensation/run` | `{through}` -- posts every unposted month. Debit Stock Compensation Expense / Credit APIC. Idempotent on the period month |
| `GET /api/stock-compensation/awards` | Per-award total, recognized and unrecognized cost at `?as_of=` -- the disclosure audited financials carry |
| `GET /api/income-tax/provision` | Previews the provision for the fiscal year containing `?as_of=` at `?rate_percent=`, without posting: pre-tax income, provision, already accrued, and what a run would post |
| `POST /api/income-tax/provision` | `{as_of, rate_percent}` -- accrues the difference. Debit Income Tax Expense / Credit Income Taxes Payable. Cumulative-to-date, so re-running at the same rate posts nothing |
| `GET /api/close/suggestions` | Ledger-derived suggestions for `?period_month=`: an expense that posts every month and didn't, and fixed assets with nothing depreciating them |
| `POST /api/income-tax/payments` | `{amount, payment_date, cash_account_id}` -- settles the accrual. Overpaying what's accrued is refused |
| `GET /api/bills` | Approved vendor bills with amount paid and outstanding on each, soonest due first. `?outstanding=false` includes fully paid ones |
| `GET /api/invoices/:id/payments` | Payments recorded against one bill, with its total, paid, and outstanding |
| `POST /api/invoices/:id/payments` | `{amount, payment_date, payment_account_id}` -- records money paid out. Posts Debit Accounts Payable / Credit the payment account. Overpayment, and paying from AP or AR, are all refused |
| `DELETE /api/invoices/:id/payments/:paymentId` | Unapplies a payment, reversing its journal entry |
| `GET /api/reports/ap-aging` | What you owe vendors, bucketed the same way as AR aging, grouped by vendor |
| `GET /api/vendors` | The org's vendors, each with its other known spellings, bill count, and outstanding balance |
| `POST /api/vendors` | `{name, email?, payment_terms_days?}` -- add a vendor by hand. Rejects a name that normalizes onto an existing one |
| `PATCH /api/vendors/:id` | Rename, re-term, or deactivate a vendor |
| `POST /api/vendors/:id/merge` | `{into_vendor_id}` -- folds this vendor into another: bills move, the spelling becomes an alias, the row disappears |
| `POST /api/invoices/upload` | Upload one or more PDF/images (each queues its own extraction and its own document-cap check). Rejected with `402` + `plan_cap_reached` once the org's plan document cap for the current month is hit |
| `GET /api/invoices` | Paginated invoice list: `?page=`/`?page_size=` (default 100, max 500), `?status=` filter, `?q=` case-insensitive search against vendor name and invoice number, `?sort=`/`?order=` (allowlisted sort fields: `created_at`, `total`, `vendor_name`, `overall_confidence`). Returns `{items, total, page, page_size}` |
| `GET /api/invoices/:id` | Full invoice detail incl. line items, confidence, match results |
| `GET /api/invoices/:id/file` | Serve the original document (for preview) |
| `PATCH /api/invoices/:id` | Human corrections; writes an audit log entry. A corrected vendor name is also remembered (`vendorAlias.js`) and auto-applied to future extractions of that same raw text for this org |
| `POST /api/invoices/:id/approve` \| `/reject` | Review decision |
| `POST /api/invoices/bulk-action` | `{ids, action: "approve"\|"reject"}` -- applies the same transition across up to 500 invoices in one call. Never fails the whole batch for one bad id: anything outside the caller's org, or that approve's status restriction rejects, comes back in `skipped` (with why) instead of erroring |
| `DELETE /api/invoices/:id` | Delete a document, at any point in its review lifecycle. Soft delete (`Invoice` is a paranoid Sequelize model) -- the row and its line items/match results/audit log stay in the database but disappear from every normal query; still counts toward the plan's monthly document cap, so delete-and-re-upload can't be used to get extra quota |
| `POST /api/invoices/:id/retry` | Re-queues the document for a fresh OCR + extraction pass without a re-upload -- the recovery path for a transient OCR/LLM failure. Blocked once approved, since that means a human already signed off on the current field values |
| `GET /api/invoices/:id/audit-log` | Full audit trail for one invoice |
| `POST /api/matching/sources?source_type=po\|receiving\|bank` | Upload a PO list, goods-receipts, or bank statement CSV |
| `DELETE /api/matching/sources/:id` | Delete an uploaded source and its rows. Past match results that once matched against it are untouched -- they're a record of a past evaluation, not something the source owns -- their `match_entry_id` just goes `null` |
| `POST /api/matching/run` | Run the matching engine over all extracted invoices |
| `GET /api/matching/results` | All match results (newest first) |
| `POST /api/transactions/upload` | Import a bank/card statement CSV and categorize it (returns counts by how each row was resolved) |
| `GET /api/transactions` | Paginated list with `?category=`, `?needs_review=true`, `?q=` filters, plus category totals over the whole filtered set (not just the page) |
| `POST /api/transactions/:id/categorize` | Accept or correct a category. Remembered for the merchant by default (`remember: false` opts out) and back-applied to its other un-reviewed rows |
| `DELETE /api/transactions/:id` | Soft-delete a transaction |
| `GET /api/close` | The close period to show (`?period_month=YYYY-MM`, else the current month, else the most recent), with its checklist and live readiness checks. `period: null` when the org has never opened one |
| `GET /api/close/periods` | Every period the org has opened, newest first |
| `POST /api/close/periods` | Open a period for a month and seed the default checklist. `409` if that month already exists |
| `POST /api/close/periods/:id/close` | Sign off the month. Allowed with outstanding items -- exactly what was outstanding is written to the audit trail |
| `POST /api/close/periods/:id/reopen` | Reopen a closed period so its checklist can be edited again |
| `POST /api/close/periods/:id/tasks` \| `PATCH /api/close/tasks/:id` \| `DELETE /api/close/tasks/:id` | Add / tick / rename / remove a manual checklist task. All `409` while the period is closed |
| `GET /api/export/csv` \| `/api/export/xlsx` | Export all invoices with status + latest match result |
| `POST /api/expenses/upload` | Upload one or more expense receipts (PDF/image). Same per-file document-cap check as invoice uploads, drawn from the same shared monthly budget |
| `GET /api/expenses` | Paginated receipt list: `?page=`/`?page_size=`, `?status=` filter, `?q=` case-insensitive search against merchant name, `?sort=`/`?order=` (allowlisted: `created_at`, `amount`, `merchant_name`, `overall_confidence`). Returns `{items, total, page, page_size, categories}` |
| `GET /api/expenses/:id` | Full receipt detail |
| `GET /api/expenses/:id/file` | Serve the original document (for preview) |
| `PATCH /api/expenses/:id` | Human corrections (merchant, date, category, currency, tax, amount, note); writes an audit log entry |
| `POST /api/expenses/:id/approve` \| `/reject` | Review decision |
| `DELETE /api/expenses/:id` | Delete a receipt, at any point in its review lifecycle. Soft delete, same reasoning as invoice delete -- still counts toward the plan's monthly document cap |
| `POST /api/expenses/:id/retry` | Re-queues the receipt for a fresh OCR + extraction pass. Blocked once approved |
| `GET /api/expenses/:id/audit-log` | Full audit trail for one receipt |
| `GET /api/export/expenses/csv` \| `/api/export/expenses/xlsx` | Export all expense receipts |
| `POST /api/vendor-documents/upload` | Upload one or more vendor documents (W-9, certificate of insurance, contract). Same shared document cap as invoice/expense uploads |
| `GET /api/vendor-documents` | Paginated document list: `?page=`/`?page_size=`, `?status=` filter, `?q=` case-insensitive search against vendor name, `?expiring_within_days=N` to surface only documents expiring within N days or already expired (a document with no expiration date is never included), `?sort=`/`?order=` (allowlisted: `created_at`, `expiration_date`, `vendor_name`, `overall_confidence`). Returns `{items, total, page, page_size, document_types}` |
| `GET /api/vendor-documents/:id` | Full document detail |
| `GET /api/vendor-documents/:id/file` | Serve the original document (for preview) |
| `PATCH /api/vendor-documents/:id` | Human corrections (vendor name, document type, effective/expiration date, reference number, amount, note); writes an audit log entry |
| `POST /api/vendor-documents/:id/approve` \| `/reject` | Review decision |
| `DELETE /api/vendor-documents/:id` | Delete a document, at any point in its review lifecycle. Soft delete, same reasoning as invoice/expense delete -- still counts toward the plan's monthly document cap |
| `POST /api/vendor-documents/:id/retry` | Re-queues the document for a fresh OCR + extraction pass. Blocked once approved |
| `GET /api/vendor-documents/:id/audit-log` | Full audit trail for one document |
| `GET /api/export/vendor-documents/csv` \| `/api/export/vendor-documents/xlsx` | Export all vendor documents |
| `POST /api/leases/upload` | Upload one or more leases (PDF/image). Same shared document cap as the other three pipelines' uploads |
| `GET /api/leases` | Paginated lease list: `?page=`/`?page_size=`, `?status=` filter, `?q=` case-insensitive search against landlord name, `?expiring_within_days=N` to surface leases whose expiration date *or* renewal-notice deadline falls within N days or has already passed (a lease with neither date set is never included), `?sort=`/`?order=` (allowlisted: `created_at`, `expiration_date`, `renewal_notice_deadline`, `landlord_name`, `monthly_rent`, `overall_confidence`). Returns `{items, total, page, page_size}` |
| `GET /api/leases/:id` | Full lease detail |
| `GET /api/leases/:id/file` | Serve the original document (for preview) |
| `PATCH /api/leases/:id` | Human corrections (landlord, property address, commencement/expiration/renewal-notice dates, monthly rent, annual escalation, note); writes an audit log entry |
| `POST /api/leases/:id/approve` \| `/reject` | Review decision |
| `DELETE /api/leases/:id` | Delete a lease, at any point in its review lifecycle. Soft delete, same reasoning as the other three pipelines' delete -- still counts toward the plan's monthly document cap |
| `POST /api/leases/:id/retry` | Re-queues the lease for a fresh OCR + extraction pass. Blocked once approved |
| `GET /api/leases/:id/audit-log` | Full audit trail for one lease |
| `GET /api/export/leases/csv` \| `/api/export/leases/xlsx` | Export all leases |
| `POST /api/tax-documents/upload` | Upload one or more tax forms (PDF/image). Same shared document cap as the other four pipelines' uploads |
| `GET /api/tax-documents` | Paginated tax document list: `?page=`/`?page_size=`, `?status=` filter, `?tax_year=N`, `?document_type=`, `?missing_tin=true` (forms with no recipient TIN on file), `?q=` case-insensitive search against payer name, `?sort=`/`?order=` (allowlisted: `created_at`, `tax_year`, `document_type`, `payer_name`, `amount`, `overall_confidence`). Returns `{items, total, page, page_size, document_types, tax_years, totals}` — `totals` (reported amount, federal tax withheld, missing-TIN count, count by form type) covers the whole filtered set, not just the current page |
| `GET /api/tax-documents/:id` | Full tax document detail |
| `GET /api/tax-documents/:id/file` | Serve the original document (for preview) |
| `PATCH /api/tax-documents/:id` | Human corrections (form type, tax year, payer, recipient, TIN, amount, federal tax withheld, note); a TIN is narrowed to its last four digits server-side, and one too short to narrow is rejected rather than silently blanked. Writes an audit log entry |
| `POST /api/tax-documents/:id/approve` \| `/reject` | Review decision |
| `DELETE /api/tax-documents/:id` | Delete a tax document, at any point in its review lifecycle. Soft delete, same reasoning as the other four pipelines' delete -- still counts toward the plan's monthly document cap |
| `POST /api/tax-documents/:id/retry` | Re-queues the document for a fresh OCR + extraction pass. Blocked once approved |
| `GET /api/tax-documents/:id/audit-log` | Full audit trail for one tax document |
| `GET /api/export/tax-documents/csv` \| `/api/export/tax-documents/xlsx` | Export all tax documents (taxpayer IDs as last-four only) |
| `POST /api/assistant/ask` | Ask a question about this org's invoices; answered by Gemini grounded in that data only. Optional `history` (last few `{role, content}` turns) carries conversation context for follow-up questions -- nothing is persisted server-side |
| `POST /api/contact` | Public (no auth) -- the marketing site's "Talk to us" form. Rate-limited, honeypot-protected. |
| `GET /api/integrations/quickbooks/status` | Whether QuickBooks is configured server-side and whether this org has connected, plus the chosen default expense account |
| `GET /api/integrations/quickbooks/connect` | Returns an `authorize_url` to redirect the browser to (requires `QUICKBOOKS_CLIENT_ID`) |
| `GET /api/integrations/quickbooks/callback` | Intuit redirects back here after consent; exchanges the code for tokens and redirects to `/` |
| `GET /api/integrations/quickbooks/accounts` | This org's QuickBooks expense accounts, for the default-account picker |
| `PATCH /api/integrations/quickbooks/default-account` | `{account_id, account_name}` -- sets which expense account new Bills are pushed against |
| `POST /api/integrations/quickbooks/disconnect` | Clears this org's QuickBooks connection |
| `POST /api/integrations/quickbooks/invoices/:id/suggest-account` | Categorizes one invoice against org's real chart of accounts -- checks a per-vendor memory of past corrections first, then an LLM call if needed (requires `GEMINI_API_KEY`; no-ops to "no suggestion" without it). Idempotent once an invoice already has a chosen account |
| `PATCH /api/integrations/quickbooks/invoices/:id/expense-account` | `{account_id, account_name}` -- sets (or corrects) one invoice's own expense account, overriding the org default for that invoice, and remembers the choice for that vendor's future invoices |
| `POST /api/integrations/quickbooks/invoices/:id/push` | Pushes one invoice to QuickBooks as a Bill (one-way, manual, Phase 1 -- see Roadmap). Uses the invoice's own categorized account if set, else the org default |
| `GET /api/integrations/quickbooks/bank-transactions` | QuickBooks bank/card transactions that look like payment for a bill Rekono already pushed but hasn't been marked paid yet, each with its candidate bill(s) and (when unambiguous) a suggested match |
| `POST /api/integrations/quickbooks/bank-transactions/:txnId/confirm` | `{invoice_id, transaction_date}` -- confirms a transaction as one invoice's payment; marks that invoice paid on Rekono's side |
| `POST /api/integrations/quickbooks/bank-transactions/:txnId/dismiss` | Marks a transaction as "not a match" so it stops resurfacing |

## Configuration

See `.env.example`. Notable knobs: `REVIEW_CONFIDENCE_THRESHOLD` (below this, an invoice is flagged `needs_review` instead of fast-tracked as `extracted`), and `MATCH_AMOUNT_TOLERANCE_PCT` / `MATCH_AMOUNT_TOLERANCE_ABS` / `MATCH_DATE_WINDOW_DAYS` / `MATCH_VENDOR_SCORE_THRESHOLD` for the matching engine.

### Secrets & API keys

Every secret this app uses (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_SECRET`, `QUICKBOOKS_CLIENT_SECRET`, `SECRET_KEY`, `DATABASE_URL`) is read from the environment in exactly one place (`config.js`) and never leaves the server:

- They're never sent to the browser. `backend/public/` is plain static HTML/JS with no build/bundling step, so there's no risk of a secret accidentally getting compiled into client-side code the way there can be in a bundled frontend -- the server-side `config.js` module is never loaded there in the first place.
- They're never echoed back in an API response, including error responses -- an unexpected server error (a DB failure, a bug) logs its full detail server-side but only ever returns a generic `"Internal server error"` to the caller (`app.js`'s `handleUnexpectedError`), so a stray internal error message can't leak connection strings or other detail. Every deliberate error response (validation, auth, plan gating) is written by hand in its own route and never includes secret material.
- `.env` is git-ignored (`.gitignore`) and `.env.example` -- the only env file actually committed -- contains no real values, just variable names.
- The two OAuth/webhook secrets that do get sent somewhere (`GOOGLE_CLIENT_SECRET` to Google's token endpoint, `STRIPE_WEBHOOK_SECRET` used to verify incoming signatures) are only ever used in server-to-server calls, never returned to a client.

If you're deploying this yourself: the only place these values should ever live is your platform's secret store (Render's dashboard env vars, or a local `.env` that stays untracked) -- never hardcoded into a file that gets committed. `git log -p | grep`-ing for key-shaped strings before a `git push` is a cheap habit if you're ever unsure whether one slipped in.

### Hardening

Beyond the secrets handling above, a few other defenses worth knowing about if you're extending this app:

- **Uploaded-file content-type is never trusted from the client.** `storage.js`'s `canonicalContentType` derives it solely from the file's extension against a fixed allowlist (`.pdf`, `.png`, `.jpg`/`.jpeg`, `.tif`/`.tiff`, `.bmp`, `.webp`) -- a client-declared `Content-Type` is ignored entirely, both on upload and when a file is served back for the review UI's document preview. This closes a stored-XSS path where an HTML/JS file disguised as a PDF, if served with an attacker-chosen content-type, would execute same-origin when previewed.
- **All user-controlled text rendered into the review UI is HTML-escaped** (`escapeHtml` in `backend/public/app.js`) -- vendor names, filenames, matching reasoning, and every other field that ultimately comes from an uploaded document or a human correction.
- **Rate limiting** (`rateLimit.js`) works at two levels. Per-account limits guard specific abuse: login, signup, password reset, re-authentication, the contact form, and the AI assistant (`POST /api/assistant/ask`, limited per-org rather than per-IP since the real cost there is API spend, not request volume). Underneath those, two per-IP ceilings mounted in `app.js` bound volume generally -- one across the whole API, and a tighter one on the endpoints that cost real CPU and disk per call (the five document-upload routes, matching source upload and runs, and all spreadsheet exports). Those two are tunable via `RATE_LIMIT_API_MAX`/`RATE_LIMIT_EXPENSIVE_MAX` because the right number is a property of the deployment: an office behind a single NAT address spends one shared budget.
- **Destructive actions require the password again** (`auth.js`'s `requireReauth`). A bearer token stays valid for 14 days, which is a weak basis for irreversibly removing a colleague's access or tearing out a live accounting integration from an unattended machine. Removing a team member and disconnecting QuickBooks both take `current_password` in the request body (the same field `POST /api/auth/change-password` already used), and answer `403` with `reauth_required: true` so the UI can prompt rather than show a dead end. Rate-limited per user, since any endpoint that checks a password is a guessing oracle otherwise.
- **CSV/Excel export neutralizes formula injection**: a cell value starting with `=`, `+`, `-`, or `@` is prefixed with a leading apostrophe before being written out, so a malicious vendor name or filename can't turn into a live formula when the export is opened in Excel/Sheets/LibreOffice.
- **Standard security headers** (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Strict-Transport-Security` when served over HTTPS) are set on every response.
- **Content-Security-Policy** (`app.js`): `script-src 'self'` with no `unsafe-inline`/`unsafe-eval` -- the review UI (`backend/public/`) has no inline `<script>` blocks or inline event-handler attributes anywhere, only `<script src="/*.js">`, so this is a real restriction, not a symbolic one. `style-src` needs `'unsafe-inline'` for the UI's inline `style="..."` attributes (no build step to generate nonces/hashes for them) plus Google Fonts' stylesheet host; `img-src`/`frame-src` allow `blob:` for the document preview, which fetches the file with its bearer token and hands the `<iframe>`/`<img>` a `URL.createObjectURL(blob)` URL instead of pointing `src=` straight at the API (which couldn't carry the token). Everything else (`connect-src`, `form-action`, `frame-ancestors`, `object-src`) is locked to `'self'`/`'none'`.
- Every route that looks up a record by ID scopes the query to the authenticated user's `orgId` (see `auth.js`'s `requireAuth` and each router's `where: { orgId: ... }`), so one org can never read or modify another's data by guessing/incrementing an ID.
- **Row-level security enforces that same boundary in the database** (`rls.js`), so a route that forgets its `where orgId` isn't a data leak -- see the section below.
- **CORS is a fixed allowlist**, not wide open (`app.js`) -- only the marketing site's own origin and the app's own deployed origin can make cross-origin browser requests. `ALLOWED_ORIGINS` (comma-separated) overrides the default list if you deploy this somewhere else. A request with no `Origin` header at all (server-to-server calls, curl) is unaffected -- that header only exists for a browser to enforce same-origin policy client-side in the first place.
- **QuickBooks OAuth tokens are encrypted at rest** (`secretBox.js`, AES-256-GCM, key derived from `SECRET_KEY` via HKDF) -- `Organization.quickbooksAccessToken`/`quickbooksRefreshToken` are ciphertext in the database and only ever decrypted in memory via the model's getter. A database compromise alone (leaked connection string, SQL injection, insider access) doesn't also hand over a live credential into a customer's real QuickBooks company file.

### Row-level security

Application code has always scoped every query to the caller's organization, and `tests/orgIsolation.test.js` locks that in route by route. Row-level security (`backend/src/rls.js`) puts the same rule underneath it, in Postgres, so the guarantee doesn't depend on every future route remembering: a query that omits its `where orgId` returns nothing instead of another tenant's rows.

Each request runs inside one transaction that sets two transaction-local settings (`SET LOCAL`, so they're discarded at commit and can never leak onto a pooled connection some other request picks up next). Policies read them with `current_setting(..., true)`, which is `NULL` when unset -- and `"orgId" = NULL` is `NULL`, not true, so **no context means no rows**. It fails closed by construction.

There are two contexts. *System* covers the pre-auth substrate that legitimately spans orgs: login finding a user by email before any org is known, signup creating the org, the Stripe webhook, and boot-time recovery of jobs left mid-pipeline by a restart. *Org* covers everything after `requireAuth` resolves a user, which is where essentially all customer data access happens. A request starts in system context and `requireAuth` narrows it. Background jobs, which run outside any request, resolve their record's org first and then process it scoped to that org alone.

Two things about the deployment matter, and both are easy to get wrong silently:

1. **The app must not connect as a superuser or a `BYPASSRLS` role.** Postgres skips row security entirely for those, so the policies would be in place and enforcing nothing. The app checks the role it actually connects as on boot and logs a loud error if row security can't take effect.
2. **`FORCE ROW LEVEL SECURITY`, not just `ENABLE`.** A table's owner is exempt from its own policies unless they're forced -- and the app needs to be the owner of what it creates for this to matter. Both are applied to all 22 tables on boot.

**On Neon specifically, this needs a role created a particular way** -- worth documenting since it took a live outage to work out. Every role Neon's Console, API, or CLI creates (including the one handed to you when the project is created, and any role added through the dashboard's Roles page) is automatically made a member of `neon_superuser`, which carries `BYPASSRLS` -- and that membership can't be revoked afterward; `ALTER ROLE ... NOBYPASSRLS` fails with `permission denied` no matter which role runs it, including the project's own owner role. The only way to get a role Postgres actually enforces RLS against is to create it with plain SQL instead of Neon's UI/API, which does not grant that membership:

```sql
-- Run as the project's default (neondb_owner-style) role.
CREATE ROLE rekono_app LOGIN PASSWORD '...';

-- Membership is required before the next step can act "as" rekono_app.
GRANT rekono_app TO neondb_owner;

-- A role you just created owns nothing yet -- give it a schema of its own
-- rather than fighting per-table GRANTs against neondb_owner's existing
-- objects. AUTHORIZATION makes rekono_app the owner from creation, which
-- is what lets FORCE ROW LEVEL SECURITY (above) actually bind on tables
-- rekono_app creates in it.
DROP SCHEMA public CASCADE;
CREATE SCHEMA public AUTHORIZATION rekono_app;
GRANT ALL ON SCHEMA public TO rekono_app;

-- Without this, table creation fails with "no schema has been selected
-- to create in" -- a role's default search_path isn't guaranteed to
-- include public just because the schema exists and it owns it.
ALTER ROLE rekono_app SET search_path = public;
```

`DROP SCHEMA public CASCADE` deletes every table in it -- only safe to run this against an empty or expendable database, not one with real data. Use that role's connection string (same host, `rekono_app`'s own username/password) as `DATABASE_URL`; it won't appear in Neon's own "Connect" dialog since it wasn't created through the UI, so build it by hand.

SQLite (the local/test default) has no equivalent feature, so all of this no-ops there and the normal `npm test` run exercises the app without it. To run the suite against Postgres with the policies live:

```bash
cd backend
./scripts/setup-test-postgres.sh        # non-superuser role + one database per Jest worker
REKONO_TEST_PG_URL=postgres://rekono_app:apppw@127.0.0.1:5432 npm test
```

`tests/rls.test.js` covers the enforcement itself and skips unless that variable is set: policies present and forced on every table, the connecting role being one they apply to, cross-org reads returning nothing (including by exact primary key, and including a deliberately unscoped query), cross-org writes and re-homing an existing row both rejected, child tables scoped through their parent, and an absent context seeing nothing at all.

One caveat on that Postgres run: `tests/rls.test.js` and the rest of the row-level-security coverage pass reliably, but the *full* suite against Postgres is currently flaky, with a different handful of tests failing run to run. The cause is in the harness rather than the app: uploads deliberately return as soon as the job is queued, so a test can finish while its background job is still writing, and the next test's reset then contends with that job for table locks. `resetDb` waits for the queue and retries the deadlock, which removed most of it, but tests that don't await their own uploads can still race. Treat the SQLite run (`npm test`, green) as the gate and the Postgres run as the way to exercise the policies; tightening the remaining races is worth doing before wiring it into CI.

No software is ever fully "unhackable" -- this is a genuine, tested hardening pass against the realistic risks for an app like this (XSS, stored-content-type confusion, brute force, spreadsheet formula injection, cross-org data leakage), not a guarantee against every possible attack.

### LLM provider (Gemini or OpenRouter)

One model powers structured extraction, merchant categorization, the QuickBooks expense-account and bank-match suggestions, and Ask Rekono. Two providers are supported and either satisfies all of them -- `llm.js` is the only file that knows which is in use.

**Gemini.** Set `GEMINI_API_KEY`. [Google AI Studio](https://aistudio.google.com) issues a free key with no credit card.

**OpenRouter.** Set **both** `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. OpenRouter proxies many providers behind one OpenAI-compatible API, so choosing it is really choosing whichever model the slug names.

There is deliberately no default model. Slugs are specific (`vendor/model-name`), they change as models come and go, and a wrong guess would fail at the first real extraction rather than at boot -- so a key without a model is treated as unconfigured and says so in the logs. Copy the exact slug from the model's page on OpenRouter; anything with a `:free` suffix costs nothing.

**The model must support tool/function calling.** Extraction doesn't ask for JSON politely, it forces a schema through a named function call -- that's what makes the output parseable and gives each field its own confidence. A model without tool support fails every extraction and falls back to the heuristic path. If that happens the error names it explicitly rather than leaving you to infer it.

With both configured, OpenRouter wins; set `LLM_PROVIDER=gemini` to override. With neither, extraction uses the heuristic regex extractor and the AI-only features return "no suggestion" -- the whole pipeline still runs, which is what lets the test suite and local demos work without any key. The provider in use is logged at startup.

`tests/llm.test.js` covers the OpenRouter adapter against a stubbed `fetch`: the request shape it builds (OpenAI-style `tools`, forced `tool_choice`, the schema passed through untouched), parsing arguments that arrive as a JSON string rather than an object, HTTP and body-level errors (OpenRouter reports some upstream failures with a `200`), the retry, and the abort on timeout.

### Contact form email (Resend)

`POST /api/contact` sends through [Resend](https://resend.com) and needs `RESEND_API_KEY` set, or it responds `503` (the marketing site's contact modal falls back to a `mailto:` link automatically when that happens, so the form degrading gracefully doesn't mean visitors are stuck).

1. Sign up at [resend.com](https://resend.com) (free tier: 3,000 emails/month, 100/day).
2. Get an API key from the dashboard (**API Keys → Create API Key**).
3. Set `RESEND_API_KEY` on the deployed backend (Render dashboard, or `.env` locally).
4. By default, `CONTACT_FROM_EMAIL` is `onboarding@resend.dev` -- Resend's shared sandbox sender, which works without any domain setup as long as `CONTACT_TO_EMAIL` (defaults to `wfrownusa@yahoo.com`) is the same address you signed up to Resend with. To send from your own domain instead, verify it in Resend (**Domains** tab) and set `CONTACT_FROM_EMAIL` to an address at that domain.

### Plans & billing (Stripe)

Paid-plan checkout, the billing-management portal, and the onboarding wizard's paid-plan path all need `STRIPE_SECRET_KEY` set, or they respond `503` (Free-plan onboarding and every other route work regardless -- billing is the one thing this gates).

1. Sign up at [stripe.com](https://stripe.com) and grab your **test mode** secret key first (**Developers → API keys**) to try the flow safely -- it's a normal Checkout page, just backed by [Stripe's test card numbers](https://stripe.com/docs/testing) instead of real money.
2. Set `STRIPE_SECRET_KEY` on the deployed backend (Render dashboard, or `.env` locally). That alone is enough for checkout and the billing portal to work -- no Products/Prices need to be created in the Stripe dashboard, since `routes/billing.js` builds the price inline from `plans.js` at checkout time.
3. For the webhook (keeps plan status in sync with renewals/cancellations after the initial checkout): in Stripe, **Developers → Webhooks → Add endpoint**, pointed at `https://<your-deployed-url>/api/billing/webhook`, listening for `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`. Copy the endpoint's **Signing secret** into `STRIPE_WEBHOOK_SECRET`.
4. Switch to live mode keys (both the secret key and a live-mode webhook endpoint/secret) once you're ready to accept real payments -- test and live are entirely separate in Stripe, including their webhooks.
5. Plan prices/caps live in `backend/src/plans.js`, matching the marketing site's pricing section -- change both together if either changes.
6. A brand new org's first paid plan choice (during onboarding) gets a 14-day Stripe trial (`TRIAL_DAYS` in `plans.js`) -- a card is collected at checkout but not charged until the trial ends, handled entirely by Stripe's `subscription_data.trial_period_days`, no custom day-counting. A later plan change through the in-app Upgrade button bills immediately, no trial (see `createCheckoutSession` in `routes/billing.js`).

### Sign in with Google

The "Sign in with Google" button needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` set, or `GET /api/auth/google` redirects straight back with an error instead of crashing (email/password sign-in and everything else work regardless).

1. In the [Google Cloud Console](https://console.cloud.google.com), create a project (or reuse one) and go to **APIs & Services → OAuth consent screen**. Fill in the required fields (app name, support email); external + testing mode is fine to start.
2. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**, application type **Web application**.
3. Under **Authorized redirect URIs**, add `https://<your-deployed-url>/api/auth/google/callback` (and `http://localhost:8000/api/auth/google/callback` too, for local dev). This has to match exactly what the backend sends, which is always `<request origin>/api/auth/google/callback`.
4. Copy the generated **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (Render dashboard, or `.env` locally).
5. No new database columns or account-linking table: a Google sign-in is matched to an existing account purely by verified email, and creates a new org + user (same as a normal signup, sent through the same onboarding wizard) if there's no match yet. See `completeGoogleLogin` in `routes/auth.js`.

### Demo mode

`POST /api/demo/login` is a public, unauthenticated endpoint (rate-limited per IP, same shape as signup) that spins up a brand-new org, seeds it with a realistic, varied-status dataset across all five document pipelines (invoices, expense receipts, vendor documents, leases, tax documents) plus matching data and an audit trail (`src/demoSeed.js`), and returns a working bearer token -- no signup, no email, no card. It's meant for investors/prospects to click straight into a populated instance: the marketing site's hero has a "View live demo" link (`?demo=1` on the app's own origin), which `public/auth.js` detects on load and exchanges for a session the same way the Google sign-in handoff works. A logged-in demo session shows a persistent "Demo Mode" banner in the app shell with a one-click path to the real signup form.

Seeded rows are inserted directly rather than run through the real OCR/LLM pipeline (the login response needs to come back immediately), but every field is set to what that pipeline would actually have produced -- confidence bars, cross-checks, and the review queue all render exactly as they would for a real org. Small real (synthetic, hand-generated) PDF files are still written to disk per row, so the document preview pane has something real to load.

**Known limitation:** demo orgs are never automatically deleted. There's no cascade-delete from `Organization` down through its invoices/receipts/vendor documents/leases/tax documents/match data/audit log today, so a correct sweep would need to touch every org-scoped table -- not worth the added complexity/risk for what's expected to be low-traffic marketing-site clicks, each capped by the endpoint's own rate limit. Revisit this (e.g. a scheduled job that deletes `Organization` rows where `isDemo` is true and older than N days) if demo-mode traffic grows enough for storage/DB size to matter.

### QuickBooks Online (Phase 1)

The Settings tab's "Integrations" panel needs `QUICKBOOKS_CLIENT_ID`/`QUICKBOOKS_CLIENT_SECRET` set, or it shows "QuickBooks isn't set up yet" instead of a Connect button (every other route works regardless). Phase 1 is deliberately scoped: OAuth connect against Intuit's free Sandbox company file, a default-expense-account picker, and a manual, one-way, per-invoice "Push to QuickBooks" button that creates a Bill. No sync-back, no bulk push, no push-on-approve automation yet -- see Roadmap.

Each invoice also gets its own suggested expense account (shown on the invoice detail panel once connected) instead of always filing under the org's static default -- vendor/line-items are matched against org's real chart of accounts via an LLM call (`quickbooks.js`'s `suggestExpenseAccount`), same self-reported-confidence pattern as extraction. This needs `GEMINI_API_KEY` set (see below); without it, every invoice just falls back to the org default exactly as Phase 1 originally shipped -- there's no reasonable regex/heuristic way to match free-text vendor wording against an arbitrary chart of accounts, so this one feature has no heuristic fallback path. A human correcting or confirming an account is remembered per-vendor (`VendorExpenseAccount`, same shape as `VendorAlias`'s learned vendor-name corrections), so the same vendor's future invoices suggest it directly without another LLM call.

The Matching tab also surfaces **bank reconciliation** once connected: QuickBooks' bank/card feed API has no public endpoint for the raw "for review" feed, but once a transaction has been added as a `Purchase` (the common outcome when a bookkeeper doesn't recognize it as paying an existing Bill), it's a normal queryable transaction -- and often duplicates a Bill Rekono already pushed and is still sitting unpaid. `quickbooks.js`'s `fetchBankTransactions` pulls those, `findExactAmountCandidates` narrows them to Rekono's own unpaid pushed bills by exact dollar amount and a loose date window (no AI needed -- this alone usually resolves to a single confident match), and `suggestBankTransactionMatch` (an LLM call, same `GEMINI_API_KEY`-gated no-fallback shape as expense categorization) only gets involved to disambiguate multiple same-amount candidates using the transaction's often-abbreviated payee/memo text. Confirming a match is Rekono-side only -- it marks the invoice paid here, but never writes back to (or deletes/voids anything in) QuickBooks itself; cleaning up the duplicate `Purchase` transaction is left to the human, in QuickBooks, once they've confirmed the match.

1. Create an app at the [Intuit Developer Portal](https://developer.intuit.com) (**My Apps → Create an app → QuickBooks Online and Payments**).
2. Under the app's **Keys & OAuth** tab, copy the **Sandbox** **Client ID**/**Client Secret** into `QUICKBOOKS_CLIENT_ID`/`QUICKBOOKS_CLIENT_SECRET`. Leave `QUICKBOOKS_ENVIRONMENT` unset (defaults to `sandbox`) -- no Intuit app-review is required for Sandbox use, only for Production.
3. Under **Redirect URIs**, add `https://<your-deployed-url>/api/integrations/quickbooks/callback` (and `http://localhost:8000/api/integrations/quickbooks/callback` for local dev). This has to match exactly what the backend sends, which is always `<request origin>/api/integrations/quickbooks/callback`.
4. The Developer Portal also provides a free Sandbox company file (**Sandbox** tab) to connect against and inspect pushed Bills in.
5. Connecting stores tokens per-org on `Organization` (`quickbooksAccessToken`/`quickbooksRefreshToken`, both nullable so a disconnected org just has `null`s -- see `models/Organization.js`); access tokens auto-refresh on use (`ensureFreshToken` in `quickbooks.js`). Going to Production later means switching `QUICKBOOKS_ENVIRONMENT=production`, swapping in Production keys, and passing Intuit's app-assessment review (token storage/data retention, roughly 2-3 weeks) -- Sandbox needs none of that.

### General ledger

`ledger.js` is a real double-entry general ledger sitting underneath the invoice pipeline -- the first piece of turning Rekono from an AP-automation tool into actual accounting software. Three tables: `Account` (chart of accounts), `JournalEntry` (a header: date, memo, source, status), and `JournalLine` (its debit/credit lines). `postJournalEntry` is the one place a line ever gets written -- it rejects (with a clean `422`, not a raw DB error) any entry with fewer than 2 lines or where debits don't exactly equal credits, so nothing that reaches the database can be unbalanced.

Every org gets a starter chart of accounts at onboarding (same hook point `sampleSeed.js`'s sample invoice uses): Cash, Accounts Receivable, Accounts Payable, Credit Card, Owner's Equity, Uncategorized Revenue, one expense account per `ExpenseReceipt.EXPENSE_CATEGORIES` value, and Uncategorized Expense -- so the ledger has something to post to from day one instead of an empty setup screen.

**Approving an invoice auto-posts it**: Debit the matched expense account, Credit Accounts Payable, for the invoice's total. Every path that can transition an invoice to `approved` -- the single approve route, bulk-action, the quick-review flow auto-approving once every flag clears, and `pipeline.js`'s own auto-approval -- calls the same `postInvoiceApproval`, which reuses `invoice.quickbooksExpenseAccountName` (the *existing* AI-suggested-or-vendor-learned field from the QuickBooks integration) to pick the expense account, falling back to "Uncategorized Expense" when it's unset or doesn't match anything in the chart of accounts. No new categorization logic -- it's the same inference the app already computes for QuickBooks, reused as the ledger's posting signal too. `postInvoiceApproval` checks for an already-posted entry before posting, so it's safe to call from every one of those sites without risking a double-post. Rejecting or deleting a previously-approved invoice reverses its entry (`voidInvoiceJournalEntry`) automatically.

Posted entries are immutable -- there's no edit or delete route, only `POST /api/journal-entries/:id/void`, which posts the entry's exact mirror image and marks the original voided. Corrections are always a new entry, never a rewrite of history, same reasoning invoices are soft-deleted rather than destroyed.

Amounts are stored as integer cents (`JournalLine.debitCents`/`creditCents`), not the `FLOAT` the rest of this app's money fields (`Invoice.total`, etc.) use, and not `DECIMAL` either -- floating-point rounding error is a real problem specifically here, where debits have to sum to *exactly* credits, and Sequelize's SQLite dialect (this app's test/local default) can hand `DECIMAL` columns back as strings depending on the value, which would silently break that arithmetic. Integer cents behaves identically on SQLite and Postgres with no parsing required; `ledger.js`'s `dollarsToCents`/`centsToDollars` convert at the one boundary where this meets the rest of the app's dollar-float fields.

The **Accounting** nav group (Chart of Accounts, Journal Entries, Trial Balance) is the UI for all of this -- available on every plan, not gated to Business/Scale like the confidence-threshold/auto-approval features are, since this is meant to be core to what the product is now rather than an advanced add-on.

Deliberately not built yet (the roadmap after this): revenue recognition (deferred-revenue schedules for subscription businesses), accounts receivable/customer invoicing (money coming in, not just out), live bank feeds replacing manual CSV import, and AI-driven close automation. See `CHANGELOG.md`'s v1.20 entry for the fuller context on why this scope and not more, in one pass.

### Financial statements

`financialStatements.js` computes the three statements directly from posted journal lines -- no new tables, no stored balances, nothing to drift out of sync with the ledger it reads. All three are read-only.

**Profit & loss** (`?from=`/`?to=`, defaults to year-to-date) is accrual basis: an approved invoice hits it the moment it's approved, not when it's paid. **Balance sheet** (`?as_of=`, defaults to today) is a point-in-time snapshot. **Cash flow** (`?from=`/`?to=`) is the direct method -- every entry that moved cash, classified by what the cash moved *against*: revenue/expense counter-accounts are operating, other assets are investing, equity and debt are financing.

Two design decisions worth knowing:

- **Earnings are derived, not posted.** Rekono never posts year-end closing entries (the traditional move that sweeps revenue and expense balances into equity and resets them to zero). Without those, revenue and expenses accumulate forever and belong to no equity account, so a naive assets-vs-liabilities+equity comparison would be off by exactly the cumulative net income, every time. So the balance sheet derives both earnings figures instead, and shows them as two separate labeled equity lines — matching how every other GL presents them:
  - **Retained earnings** — everything earned in fiscal years *before* the one containing the as-of date. Settled history.
  - **Current year earnings** — the fiscal year in progress. Reconciles exactly to a P&L run over the same fiscal year (`tests/fiscalYear.test.js` asserts this against an independently-computed P&L).

  Deriving isn't a shortcut: QuickBooks and Xero both compute current-year earnings the same way, because the year isn't over and there's nothing to close. Deriving the prior years too (rather than posting real closing entries) additionally means changing the fiscal year end re-slices the split instantly, with nothing to un-post.
- **The direct method, not indirect.** Most SaaS finance teams present the indirect method (net income plus non-cash adjustments), but it needs a working-capital story — period-over-period AR and AP deltas — and Rekono has no AR side yet. The direct method is the honest version to ship first; indirect follows AR.

**Fiscal year and period locking.** `Organization.fiscalYearEndMonth` (1-12, default December) sets where the year boundary falls; `fiscalYear.js` computes the boundaries, handling non-calendar years correctly — a June year-end means FY2026 runs 2025-07-01 through 2026-06-30, and the last day of the year-end month is computed rather than hardcoded, so a leap February lands on the 29th. Set it under Settings → Accounting.

Closing a month in the Month-End Close tab now **locks it**: `postJournalEntry` refuses any entry dated into a closed period, so a backdated entry can't silently rewrite financials you already reported. Enforced in the ledger rather than the routes, so it covers every posting path (manual entries, invoice approval, voids) from one place, and reopening the period unlocks it again — it's a control, not a one-way door. Before this, `ClosePeriod` was a pure checklist that touched nothing in the ledger.

One deliberate exception: invoice approval must never *fail* because the ledger refused a posting. Auto-posting always carries today's date, so it only hits a closed period if the current month was closed early — rare, but possible. When it happens the approval still succeeds and a `journal_posting_skipped` audit entry records why, so the gap is findable at close time instead of surfacing months later as an unexplained variance.

Building these surfaced a latent bug in v1.20's trial balance: it filtered to `status: "posted"`, which dropped a voided entry while keeping the reversing entry that cancels it, leaving the account showing the exact *negative* of the voided amount. It stayed invisible in that report because a reversal is itself balanced, so its `balanced` flag never went false. Both the statements and the trial balance now include voided entries alongside their reversals, which is what nets them to zero — and because a reversal carries its own (later) date, an entry voided in a subsequent period correctly reverses in the period it was corrected rather than rewriting history.

### Accounts receivable

`accountsReceivable.js` is the mirror image of the AP pipeline this app started as. Where an approved vendor bill posts Debit expense / Credit Accounts Payable, issuing a customer invoice posts **Debit Accounts Receivable / Credit revenue**, and recording a payment posts **Debit the deposit account / Credit Accounts Receivable**. Everything routes through `ledger.js`'s `postJournalEntry`, so AR inherits the same guarantees as everything else: balanced entries only, closed periods refused, corrections as reversals.

Four models: `Customer` (a real table rather than a name string — payment terms and the aging report both need a stable identity), `CustomerInvoice`, `CustomerInvoiceLine` (each line names its own revenue account, so the P&L's revenue section stays broken out rather than collapsing into one lump), and `CustomerPayment` (its own table because partial payments are normal and each is a dated event the cash flow statement needs).

**A draft is not a receivable.** An invoice affects nothing until it's sent — no revenue, no AR, nothing on any statement. That's how real AR software works: you build an invoice before committing to it. Sending is the moment it hits the books, and from then on it's immutable, same reasoning as a posted journal entry. Amounts are integer cents throughout, matching `JournalLine` rather than the AP `Invoice`'s FLOAT, because these have to tie out to a journal entry exactly.

Invoice numbers are sequential per org (`INV-0001`), derived from the highest existing number rather than a stored counter — a deliberate simplicity trade, since the only way it collides is two people creating an invoice in the same millisecond.

**AR aging** buckets outstanding balances by days past the *due* date (current / 1-30 / 31-60 / 61-90 / 90+), which is what makes it a collections tool rather than a list sorted by age. Drafts, paid invoices, and voided invoices are all excluded; a partially paid invoice ages only its outstanding balance.

Building this surfaced a bug in v1.21's cash flow classifier. It bucketed by account *type* alone, so collecting a receivable (an asset) read as **investing** and paying down a payable (a liability) read as **financing**. Both are plainly operating activities — investing means buying and selling long-term assets, financing means raising and returning capital, and neither describes collecting what you're owed or settling what you owe. `financialStatements.js` now special-cases the `accounts_receivable`/`accounts_payable` subtypes, with tests pinning both directions.

### Vendors and merging

AP aging used to group by normalizing the extracted vendor name. That handles `"Acme Inc."` vs `"  ACME Inc. "` and nothing else — the moment the same company's name arrives genuinely differently (`"Acme Inc"` one month, `"Acme Incorporated"` the next, which OCR and a change of letterhead both produce), the report shows one vendor as two, and every collections decision made off it is wrong. No cleverer normalizer fixes that, because nothing can know those two strings are one company.

`Vendor` is the AP counterpart to `Customer`: a stable identity with payment terms and an email, created automatically the first time a bill naming it is approved. **At approval, not at extraction** — OCR noise on a document nobody approves shouldn't litter the vendor list. `Invoice.vendorName` is deliberately left exactly as extracted; overwriting it with a canonical name would destroy the record of what the document actually said, which is the one thing an audit needs to check. `Invoice.vendorId` is the resolved identity alongside it.

**Merging is what the table exists for.** `POST /api/vendors/:id/merge` moves every bill to the surviving vendor, carries the remembered expense-account categorization across, and writes the merged-away spelling as an alias so the next bill carrying it resolves on its own rather than recreating the duplicate. It is presentational only — regrouping never moves a cent, and a test pins that AP aging still reconciles to the balance sheet afterwards.

`computeApAging` resolves identity **at read time** through vendors and aliases rather than trusting a stored column. Two things fall out of that: a merge regroups history immediately with nothing rewritten, and bills approved before vendors existed (no `vendorId` at all) still group by name instead of vanishing. No backfill and no migration were needed.

**The normalizer** (`normalizeVendorName`, shared by `vendorAlias.js` and `vendorExpenseAccount.js` so a key written by one and read by another folds identically) draws its line at what carries no information: case, surrounding and repeated whitespace, trailing punctuation. Anything that could conceivably distinguish two companies stays out — no stripping of `Inc`/`Ltd`, no edit-distance matching, no dropping internal punctuation. The costs are asymmetric: a missed fold is one visible merge click, while a wrong one silently combines two real companies and is nearly impossible to notice.

### Stockholders' equity

Every equity posting was expressible as a raw journal entry already. What was missing is **classification** — a credit to an equity account says equity went up, not whether that was a capital contribution, a share issuance, or a treasury reissue, and those are three different lines on a statement of stockholders' equity. The type is what a journal entry can't carry.

Six typed events: contribution, distribution, dividend declared, dividend paid, treasury purchase, treasury reissue. All post through `postJournalEntry`, so they inherit balance enforcement and closed-period refusal like everything else.

- **Declaring and paying a dividend are separate.** A declared-but-unpaid dividend is a liability the balance sheet has to show. Paying it moves cash and clears the liability — equity is unchanged, because the reduction was recognized at declaration. Counting it twice is the classic error.
- **A contribution splits par from premium only when shares and a par value are given** (par to Common Stock, the rest to APIC). Without them it credits Owner's Equity. Driven by the transaction rather than an org-level flag, because the same company can do both.
- **Treasury stock uses the cost method** — no gain or loss is ever recognized on a company's own shares. Reissuing above cost credits paid-in capital; reissuing below cost charges paid-in capital first and reaches retained earnings only once that's exhausted.
- **Distributions and Treasury Stock are contra-equity** and carry debit balances. No special handling was needed: an equity account's normal balance is credit minus debit, so they subtract on their own.

**Par value is stored in millionths of a dollar, not cents.** $0.001 par is common and $0.0001 is the Delaware default; both round to zero cents. Converting per-share par to cents before multiplying by the share count destroys the par and emits a zero-value line the ledger rejects. Multiply first, round once.

**The statement ties by construction.** Beginning and ending totals come straight from `computeBalanceSheet` at the two dates, so it can't disagree with the balance sheet beside it. Movements are attributed from the typed transactions plus net income; anything left over lands on an explicit `other` line. Equity is reachable by a plain journal entry, so a hand-posted credit to Owner's Equity is always possible — a statement that swallowed it would be wrong, and one that refused to balance would be useless, so it gets named instead.

### The share register

An equity transaction carries a share count, which is enough to split par from premium and no more. A count on a transaction can't say how many shares are outstanding, who holds them, what percentage each holder owns, or whether the charter's authorized limit is used up. Those are *positions*, and positions need their own ledger.

`shareRegister.js` is that second ledger, denominated in shares rather than dollars. It is deliberately not derived from the journal: a transfer between two shareholders moves no company money and posts nothing at all, and it is still the most common event in a real register.

Four kinds of movement — issue, transfer, repurchase, reissue. `shares` is always positive and direction is carried by which ends name a shareholder, not by a signed quantity, because a signed quantity makes "who lost these shares" unanswerable for a transfer.

- **Issued never comes back down.** Shares bought back are still issued, just no longer outstanding — which is why treasury shares keep consuming authorized capital, and why a reissue is its own type rather than a second issuance. Outstanding is issued minus treasury and is never stored.
- **Issuing past the authorized ceiling is refused**, not flagged. It's void as a matter of corporate law, not untidy data.
- **Positions are replayed in date order, not summed.** A transfer dated last March can look valid against today's balances and still be impossible — the holder may not have owned the shares yet in March, or may have sold them in April. Only a replay sees either case.
- **A wrong movement is deleted, not voided** — the one place in this app where that's right. A journal entry is a claim about money that moved and has to be corrected by a second entry saying so; a register entry is a claim about who owns what, and a wrong one leaves the wrong name on the cap table. The deletion is refused if a later movement depends on it, and the funding equity transaction keeps its own immutable journal entry.

**The tie-out to the general ledger.** Common Stock is credited with par value on every issuance, so its balance divided by par is the number of shares issued — and the register knows that number independently. `GET /api/share-register/reconciliation` compares them, and names the equity transactions recording shares that no movement claims, so a discrepancy comes with a list to go fix. *Issued*, not outstanding, is the right side of that equation: the cost method debits Treasury Stock on a buyback and leaves Common Stock untouched.

Where the equation doesn't apply — no-par stock, where the full proceeds land in Common Stock, or nothing issued yet — it says so in words. "Doesn't apply" and "reconciles" both look like a difference of zero and mean completely different things.

### The option pool and fully-diluted ownership

The register answers "who owns what" in issued shares, which is the wrong denominator for almost every question a founder or investor asks — a company with a 15% option pool does not own the percentages its register shows. Three things sit between the two numbers: granted awards not yet exercised, the unallocated reserve nobody has been promised, and exercised awards that are already real stock.

The middle one is what people leave out and what gets negotiated. An unallocated pool dilutes the existing holders and nobody else, which is the whole substance of the "pool shuffle" argument in a priced round, so it is counted and gets its own row rather than being assigned to a person.

- **A plan is a board reserve, not stock.** Nothing moves in the register when a plan is created or a grant is made from it. Shares become real only on exercise — that is why outstanding and fully diluted differ at all.
- **Vesting is computed, never stored.** Months are counted by anniversary with the same clamping the recurring-entry schedule uses (a start on the 31st has its February anniversary on the 28th), and the rounding remainder lands on the final month, so a grant finishes at exactly the number of shares it was for.
- **Cancelled shares return to the pool; exercised ones don't** — those left it permanently when they became real stock and are counted by the register from then on.
- **Events can't be dated in the future.** Every gate is evaluated at the event's own date, so without this a barely-started grant could be exercised in full by typing a date four years out. The register has no equivalent rule because a transfer has no time-based gate to bypass.

**Exercising posts to both other ledgers.** It issues stock through `recordShareTransaction` (inheriting the authorized-capital check) *and* posts the strike money as a capital contribution. Without that second half, Common Stock stays put while the register's issued count climbs and the tie-out reports a difference nothing can close. Naming a cash account is optional but is the default in the UI, since skipping it is what breaks the tie-out. If the register then refuses the issuance, the contribution is voided rather than left as cash raised against shares that will never exist.

An RSU has no strike price and so no cash to post. The expense side of one is ASC 718 stock compensation — grant-date fair value recognized over the vesting period — which Rekono does not compute.

### Stock compensation expense (ASC 718)

The option pool tracks what a grant does to *ownership*. This is what it does to the *income statement*: a grant is compensation paid in equity rather than cash, and it is an expense in the period the employee earns it even though no cash moves.

Rekono does not value an option — that needs Black-Scholes inputs and a 409A valuation of the underlying, and a wrong number flows straight into reported net income. The grant-date fair value per share is supplied, the same stance the income tax provision takes below. An award with no fair value on file is never expensed, which is how grants predating this feature stay out of the P&L.

- **Recognition is not the vesting curve.** Under a 12-month cliff nothing vests for a year, but service is rendered the whole time, so a year of expense is recognized. `vestedShares` answers "how many shares could they exercise"; recognition asks "how much service has been rendered". Reusing the vesting curve would defer a year of real cost and then dump it in one month.
- **Forfeiture reverses expense, on the unvested part only.** Shares already vested keep their cost — that service was rendered whatever happened after. Whether a share had vested is asked of `vestedShares` rather than approximated: someone leaving at five months against a twelve-month cliff has vested nothing, so the entire grant forfeits.
- **Each month is the change in cumulative expense**, not a recomputed slice, which is what makes forfeiture fall out with no special case — the month of a cancellation the delta simply goes negative. Negative months post as a real credit to expense with the lines flipped, since the ledger has no signed values.
- The entry is Debit Stock Compensation Expense / Credit APIC. Total equity is unchanged: the cost moves value from retained earnings to paid-in capital, which is what a non-cash equity-settled expense should do.

### Close automation

The close checklist asks document-workflow questions — are the invoices reviewed, is anything still extracting, is approved spend matched. All of those look at the queue. None looks at the **ledger**, so the failure that actually matters at month-end went unnoticed: the month where rent simply never got posted.

Two suggestions, derived from the books rather than from anything configured:

- **An expense that posts every month and didn't.** Three of the last four months is the bar — not four of four (an expense that skipped one month is still plainly monthly), not two (a coincidence).
- **A fixed asset with nothing depreciating it**, reported with the straight-line arithmetic already done.

Expenses only: a revenue account with nothing in it is a slow month, not an omission, and assets and liabilities move irregularly by nature. The expected amount is the **median** of prior months, so one double payment doesn't misstate it. An expense already due on a recurring template is skipped, since the recurring-entries preview surfaces and can post that one — reporting it twice would send someone chasing one problem across two screens.

Depreciation is posed as a question, not an assertion: land is never depreciated, an asset bought this month may not be in service, and a deposit in an asset account isn't a fixed asset. Cash and receivables are never suggested.

Nothing here posts anything or blocks a close. A close is a human attestation and there are legitimate reasons to sign off with a known exception; the job is making sure the exception is one somebody saw. The close banner says so explicitly rather than claiming everything checks out while suggestions sit below it.

### The income tax provision

**This is not a tax calculation.** It multiplies pre-tax book income by an effective rate you provide. It knows nothing about entity type, multi-state apportionment, book-tax differences, deferred taxes, valuation allowances, credits or loss carryforwards — every one of which changes the real number. What it gives you is a provision accrued on the books, so the P&L isn't silently pre-tax and the balance sheet isn't missing the liability. Not a return, and not advice. There is deliberately no default rate.

- **The base is pre-tax income, not net income.** A provision computed against net income feeds on itself: post the tax, income drops, the next run wants less tax, forever. `preTaxIncomeCents` excludes income tax expense from the expense side, and a test pins the consequence — a second run at the same rate posts nothing.
- **A loss accrues no benefit.** Booking one asserts the loss will shelter future income (a deferred tax asset, only recognizable if you expect to use it, and one most companies at this stage fully reserve against). That judgment isn't the app's to make, so the provision floors at zero.
- **Cumulative-to-date with true-ups**, the way a real provision behaves quarter to quarter. A quarter where income fell posts a negative increment, as a real credit to expense with the lines flipped.
- Accruing moves no cash; paying is a separate event that settles the liability and touches neither the P&L nor equity, since the expense was recognized at accrual.

The P&L presents it properly — revenue, operating expenses, **income before income taxes**, income tax expense, net income. Not cosmetic: burying tax in the expense total leaves the reader no way to check the number against the rate. Tax is identified by account subtype, not by name, so renaming the account can't break the arithmetic.

### Adjusting entries and the year-end close

Closing a month used to lock the period and tick a checklist while posting nothing — so the "closed" books were missing exactly the depreciation and accruals a close exists to record. `recurringEntries.js` and `yearEndClose.js` are the two halves that were missing.

**Recurring entries** are a template plus a schedule, not a queue of future-dated entries. An entry that exists before its period would show up in a trial balance run today, and books already containing next quarter's depreciation are wrong in a way nobody notices until an audit. Due dates derive from the start date and frequency rather than from "the last one plus an interval", so a period nobody ran stays due instead of being lost — and a month starting on the 31st clamps to the 30th in April rather than rolling into May, because an adjusting entry landing in the wrong period is the whole failure mode.

A template that hits a closed period stops there rather than posting over the gap: books with April and June but no May are harder to spot than a template that visibly stopped. Templates must balance at creation, since an unbalanced one is a trap that looks saved and then fails silently every month.

**Year-end closing entries** zero revenue and expense into a Retained Earnings account. One entry, not the textbook Income Summary three-step — that intermediate account exists to make the arithmetic visible by hand, and in a system that posts atomically it adds an account that is always zero plus a second entry that can only be a transcription of the first.

**Why this doesn't double-count retained earnings.** Rekono *derives* retained earnings from cumulative revenue minus expenses (v1.21/v1.22), and a closing entry also credits a Retained Earnings *account*. Both counting would double equity. They don't, because the closing entry debits every revenue account to zero: that year's contribution to the derivation becomes exactly zero at the same instant its net income lands in the account. The earnings move from the derived half of equity to the posted half; the total never changes.

Two consequences worth knowing:

- **The P&L excludes closing entries**, the balance sheet includes them. Otherwise a P&L over a closed year would report zero revenue — going blank precisely because the books were closed properly.
- **A closed year can pick up later activity**, since period locking is a separate mechanism. Nothing breaks (the balance sheet derives whatever the closing entry missed, so totals stay right), but "closed" stops meaning the accounts are at zero. The year-end preview flags that and names the amount rather than reporting the leftover as if it were the year's income.

### Revenue recognition (ASC 606)

Sending a customer an annual invoice in January used to credit twelve months of revenue into January — a P&L spike that didn't happen and eleven dead months. What's true on day one is that a receivable exists and the org **owes twelve months of service**, which is a liability, not income.

A `CustomerInvoiceLine` with a service period credits **Deferred Revenue** rather than its revenue account, and a monthly run releases each month's earned share:

```
Invoice sent   Debit Accounts Receivable / Credit Deferred Revenue
Each month     Debit Deferred Revenue     / Credit Revenue
```

A line *without* a service period is unchanged — point-in-time delivery is earned when billed — so a setup fee and a subscription on the same invoice are each treated on their own terms.

**Straight-line over days, not equal twelfths.** A term almost never starts on the 1st: Jan 15 – Jan 14 is 17 days of the first January and 14 of the last, and calling both "one month" overstates one end and understates the other. The rounding remainder lands on the final month so the schedule sums to the line *exactly* — rounding each month independently strands a cent in deferred revenue that never clears and that nobody can explain a year later.

`RevenueScheduleEntry` stores the plan rather than recomputing it, for the same reason journal entries are stored while statements are derived: the schedule is a document someone reconciles against, and once a month is recognized it carries the journal entry that did it.

Two properties worth knowing:

- **Recognition posts into the month it recognizes**, dated to that month's last day rather than the day the job ran. Otherwise a subscription's revenue smears across whichever months the operator happened to be at their desk.
- **A later run catches up everything missed.** Running April also recognizes a January nobody ran. `GET /api/revenue/pending` previews exactly what would post first — this writes into months that may already have been reported on.

It's a normal posting, so a closed period refuses it and the month stays pending rather than being marked recognized against an entry that never posted. Voiding an invoice drops its unearned months and leaves recognized ones alone.

### Accounts payable: paying bills

`accountsPayable.js` is the mirror of `accountsReceivable.js`, and closes the asymmetry AR made obvious. Approving a vendor bill has posted **Debit expense / Credit Accounts Payable** since v1.20, but nothing relieved that payable — AP only ever grew, and the balance sheet showed every bill the org had ever approved as still owed. Recording a payment posts **Debit Accounts Payable / Credit the account the money left from**.

`BillPayment` is its own table rather than a `paidAt` flag on `Invoice`, for the same reasons as `CustomerPayment`: partial payments are normal, and each is a dated event the cash flow statement needs. `Invoice.total` is a FLOAT in dollars (the AP pipeline predates the ledger's integer-cents convention), so `invoiceTotalCents` converts at that one boundary rather than mixing representations.

**A credit card is a valid thing to pay from** — paying a bill with one swaps one liability for another rather than spending cash, and the ledger models that correctly. Accounts Payable and Accounts Receivable are both refused as sources: paying from AP posts Debit AP / Credit AP, which balances, passes every check, and moves nothing; crediting AR to pay a vendor reads as a customer having settled their invoice.

**You can only relieve a payable that exists.** Approving is what credits AP, and that posting can be skipped (a bill approved into a closed period — see `postInvoiceApproval`), so an `approved` status alone isn't proof it landed. Debiting AP for a bill that never credited it drives the balance negative against nothing, so it's refused — recoverably, since re-approving re-runs the idempotent posting.

**AP aging** buckets outstanding balances by days past due, grouped by the resolved `Vendor` (see above).

One subtlety worth knowing: the aging report and the payments endpoints both use `Invoice`'s `withSamples` scope rather than its default. The Review Queue deliberately shows the seeded sample invoice and lets it be approved like any other, and approving it posts to Accounts Payable for real — so filtering it out of aging alone would leave the report disagreeing with the balance sheet by exactly the sample's amount.

Confirming a QuickBooks bank match posts a payment too, which is what finally closes that loop in both directions. It's best-effort: the QuickBooks fact is true whether or not the ledger accepts the posting, so a refusal writes a `journal_posting_skipped` audit entry rather than failing the match.

### Staff / cross-org usage dashboard

`GET /api/staff/overview` and the app shell's "Staff" nav tab are Rekono's own team's view of the product -- not a customer feature. It answers "how is Rekono doing" (org counts and plan mix, a signup trend, an activation funnel from signup through a first approved document, document volume, and subscription health), never a way to read any single customer's actual documents, vendor names, or dollar amounts. Demo orgs (`Organization.isDemo`) and seeded sample invoices (`Invoice.isSampleData`, see below) are excluded from every figure so they don't inflate the numbers with activity nobody actually did.

Gated by `STAFF_EMAILS` (comma-separated, case-insensitive) -- an email allowlist rather than a database column, since there's no signup flow that should ever be able to grant this, and a config value only whoever holds the deployment's env vars can change is a much smaller blast radius than a boolean a bug could flip on a row. Unset/empty (the default) means nobody can reach it, not even the first org's owner. `auth.js`'s `requireStaff` is a separate middleware from the customer-facing `requireAuth`, not a flag on it, and is the one route family that deliberately never narrows the request to a single org -- see `rls.js` and the "Row-level security" section below for why every other route does. Every call is logged to the staff member's own `AuditLog` (`staff_metrics_viewed`) for accountability, since there's no cross-org-shaped audit target to log it against instead.

## Roadmap (beyond this MVP)

Deliberately not built yet, to keep the MVP demoable and honest about what's real:

- **Email ingestion** (forward invoices to a dedicated address) and **watched folder/Drive integration** — additive front-ends onto `storage.js`'s upload handling + the existing job queue.
- **Production job queue**: swap the in-process queue (`src/jobs.js`) for BullMQ/Redis or SQS once throughput needs it. The `enqueue()` call site is the only integration point.
- **Cloud OCR**: swap Tesseract for AWS Textract or Google Document AI behind `ocr.extractText` for better accuracy on messy scans.
- **Accounting software integrations**: QuickBooks Online Phase 1 (Sandbox OAuth connect + manual one-way Bill push + per-invoice AI expense-account categorization + AI-assisted bank reconciliation, see above) is done. Still ahead: Production access (Intuit app-assessment review), push-on-approve automation instead of a manual button, bulk push, and Xero/NetSuite support.
- **Vendor payment terms on new bills**: `Vendor.paymentTermsDays` is stored but nothing reads it yet — a bill that arrives without a due date could inherit it the way a customer invoice already does.
- **Usage-based and milestone revenue**: recognition is straight-line over a service period today. Consumption billing and percentage-of-completion are the other two ASC 606 patterns a subscription business eventually needs.
- **Live bank feeds** (Plaid) replacing `routes/transactions.js`'s manual CSV import, so bank activity posts to the ledger automatically instead of needing a periodic upload.
- **A stored trial-balance snapshot at close**: close automation (above) now suggests what a month is missing, but a close still records no frozen picture of the numbers it signed off on, so re-closing a reopened period leaves no diff to inspect.
- **Convertible notes and SAFEs**: options, RSUs and warrants dilute on a known share count and are handled (above). A note or SAFE converts at a price set by a future round, so its dilution isn't knowable until that round prices — modelling it means pro-forma scenarios, not a number to put on today's cap table.
- **Option valuation and expected forfeitures**: expense recognition ships (above), but the grant-date fair value is supplied rather than computed — Black-Scholes needs volatility, risk-free rate and expected term. Rekono also recognizes forfeitures as they happen rather than estimating a forfeiture rate up front, which ASC 718 permits as a policy election but which understates early-period expense against companies that estimate.
- **Deferred taxes and the actual return**: the provision (above) accrues current tax at a rate you supply. Deferred taxes — book-tax timing differences, NOL carryforwards, valuation allowances — and anything resembling a filed return remain out of scope, and depend on entity type and multi-state apportionment that Rekono does not model.
- **Payroll**: Rekono records payroll journal entries but computes no withholding. Full payroll (withholding tables, FICA, SUTA/FUTA, multi-state, filings) is a product in its own right; integrating with one is the realistic path.
- **Dashboard**: exceptions queue and reconciliation status, once there's enough volume for those views to matter. (AR and AP aging both shipped, above.)
- **Vertical-specific extraction schemas and matching rules** once there's a design partner in a specific industry (property management, trucking, medical billing, etc.) — the generic schema here is the horizontal starting point.
- **Prompt/rule feedback loop**: corrections made in the review UI are already captured as structured `human_correction` audit log entries; using that history to auto-tune the confidence threshold or few-shot the extraction prompt is future work.
- **Compliance**: audit logging exists from day one; formal data retention policy and SOC 2 groundwork come with the first real customer conversations.

## License

Proprietary -- all rights reserved. See [`LICENSE`](LICENSE). This repository being visible on GitHub does not grant permission to use, copy, modify, host, or distribute this software; contact the owner for a license, including for self-hosting.
