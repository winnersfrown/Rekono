# Rekono

AI-powered invoice ingestion, extraction, and reconciliation for accounts payable. Upload an invoice, get back structured, confidence-scored data, review/correct what the model wasn't sure about, and match it against your POs or bank statement.

This repo is the MVP described below: upload → extract → review → export → single-rule matching. It's built to extend cleanly toward the fuller architecture (email ingestion, accounting-software integrations, richer reconciliation) without a rewrite.

## MVP scope

1. Upload a PDF/image invoice → OCR → LLM structured extraction → confidence-scored JSON.
2. Review UI: side-by-side source document + editable extracted fields, low-confidence fields highlighted, approve/reject with a full audit trail.
3. Export approved (or all) invoices to CSV/Excel.
4. One matching rule: fuzzy vendor name + amount tolerance + date window against an uploaded PO or bank statement CSV.
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
- Structured extraction via Gemini (`@google/genai`), using forced function calling to get a fixed JSON schema back (vendor, invoice #, dates, PO reference, totals, line items) with a self-reported confidence per field. Google AI Studio issues a free API key (no credit card) with a generous rate limit -- see [aistudio.google.com](https://aistudio.google.com).
- If `GEMINI_API_KEY` isn't set, a heuristic regex extractor takes over so the full pipeline (ingest → extract → review → export → match) still runs end-to-end for demos, tests, and CI. Heuristic fields get a flat, low confidence score, which naturally routes them into the review queue instead of silently shipping bad data.
- Confidence scoring combines per-field confidence with an automatic cross-check (do line items sum to the total, or subtotal + tax = total?). A failed cross-check pulls overall confidence down independent of what the model claimed.
- **Risk-based auto-approval** (Business/Scale, `plans.js`'s `riskBasedAutoApproval`, off by default even on a qualifying plan -- opt-in per org in Settings): an invoice that would already be fast-tracked as `extracted` (passes the confidence bar and cross-check, isn't a duplicate or possible multi-invoice) skips the manual "click Approve" step too if it's also low business risk -- a known vendor (has a learned `VendorAlias` for this org, i.e. a human corrected/confirmed it before) and at or under the org's own configured dollar ceiling. This never overrides a flagged review; it only removes a redundant click for spend that was already trustworthy on its own. Every auto-approval gets its own `auto_approved` audit log entry (reason, total, confidence) so it's fully traceable, never a silent skip. See `pipeline.js`'s `shouldAutoApprove`.
- **Quick Review** (dedicated sidebar tab): a needs_review invoice normally requires opening its full detail view even if only one field is actually uncertain. Quick Review instead flattens every low-confidence field across every eligible needs_review invoice (excluding ones flagged for a duplicate or possible multi-invoice, which need real judgment on the whole document) into one queue, reviewed a single field at a time -- confirm the prefilled value or correct it, Enter moves straight to the next. Confidence and the cross-check are recomputed after each field (`confidence.js`'s `score`, reused rather than re-derived); once nothing on an invoice is left flagged, it's auto-approved. See `GET /api/invoices/quick-review-queue` and `POST /api/invoices/:id/quick-review-field`.
- **Statistical sampling** (Business/Scale, same `riskBasedAutoApproval` gate and opt-in-per-org shape as auto-approval above): an auto-approved invoice never gets a human's eyes otherwise, so a configurable fraction of them (`Organization.sampleReviewRate`) get randomly flagged (`pipeline.js`'s `shouldSampleForQa`) for a retrospective spot-check -- catching drift in auto-approval decisions without reviewing every invoice it clears. Reviewing a sampled invoice (Settings tab's "Pending spot-checks" list) is purely a QA record -- it never changes the invoice's own status or touches QuickBooks; a real issue is a signal to revisit the org's settings, not something this route undoes automatically. See `GET /api/invoices/qa-sample-queue` and `POST /api/invoices/:id/qa-review`.
- Learned vendor aliases (`vendorAlias.js`): correcting a vendor name in review (`PATCH /api/invoices/:id`) remembers the original raw text → corrected name for that org. The next extraction whose raw vendor text matches exactly gets the corrected name applied automatically with a confidence boost, instead of needing the same correction every time that vendor's invoices come in.
- Possible-multi-invoice flag: extraction only ever fills in one invoice's worth of fields, so a document that actually contains more than one (a batch scan, several invoices in one PDF) forces review instead of silently extracting just the first one. The LLM self-reports this; the heuristic fallback flags more than one distinct invoice number found in the text.

**Matching/reconciliation engine** (`matching.js`, `routes/matching.js`): fuzzy vendor-name matching (`fuzzball`, a FuzzyWuzzy/rapidfuzz-style token-sort ratio) plus configurable amount tolerance (% and absolute) and a date window, with an exact PO/reference-number match as a strong signal. Produces `matched` / `partial` / `unmatched` with a human-readable reasoning string for every decision — this is the part of the system closest to a constraint-matching problem.

**Data layer** (`models/`): Postgres in production (SQLite by default for local dev — no separate DB server needed to try it out) via Sequelize. Every extraction, human correction, approval/rejection, and match decision writes an `AuditLog` row — the audit trail that finance/compliance conversations will ask about. Every table that holds customer data (`Invoice`, `MatchSource`, `AuditLog`) carries an `orgId`, and every route filters by the authenticated user's org — enforced entirely in application code (every query scopes by `req.currentUser.orgId`, verified route-by-route; there's no database-level row-level security layer underneath it) and locked in by regression tests (`tests/orgIsolation.test.js` plus the cross-org tests alongside each feature) rather than by convention alone — see `auth.js` and `models/` (`Organization`, `User`).

**Auth** (`auth.js`, `routes/auth.js`): email + password, bcrypt-hashed, stateless JWT bearer tokens (14-day expiry). Signup creates a new `Organization` plus its first `User` (`role: "owner"`). `SECRET_KEY` is read from the environment if set, otherwise auto-generated and persisted to a local file on first run — fine for a single instance, but set it explicitly (Render's Blueprint and the Fly.io instructions below both do this for you) for any deployment with more than one replica.

**Team invites** (`seats.js`, `routes/team.js`): the org's owner can invite teammates by email, up to the plan's seat count (`plans.js`'s `seats` -- `null` means unlimited; a pending invite reserves a seat so the cap can't be oversubscribed before anyone accepts). The invite email links to `/?invite_token=...`, which lets the invitee set a name and password and creates a `role: "member"` User on the same org -- no separate signup, no second organization. Degrades the same way as the other Resend-gated flows: without `RESEND_API_KEY` configured, the invite still gets created and its link is handed back directly in the API response instead of emailed.

**Onboarding & billing** (`plans.js`, `plan.js`, `routes/onboarding.js`, `routes/billing.js`): a new org's `plan` is `null` until the post-signup wizard completes -- `plan.js`'s `requireActivePlan` middleware (mounted the same way `requireActiveTrial` used to be) blocks every data route until it does. Picking Free activates instantly; picking a paid tier creates a Stripe Checkout session with the price built inline from `plans.js` (`price_data`, not a dashboard-configured Product/Price -- so standing up billing only ever needs a Stripe account + API keys, nothing to keep in sync by hand) and only activates the plan once Stripe confirms payment, both via the redirect back (`GET /api/billing/confirm`) and a webhook (`POST /api/billing/webhook`) that also keeps the plan in sync with renewals/cancellations afterward. `GET /api/billing/portal` hands off to Stripe's own hosted billing-management UI rather than a custom one. All of it degrades to a clear `503` instead of crashing when `STRIPE_SECRET_KEY` isn't set, same pattern as the Gemini/Resend integrations.

**Output/integration layer** (`routes/export.js`): CSV/Excel export today. QuickBooks/Xero/NetSuite push integrations are additive on top of the same Invoice/MatchResult data (see Roadmap).

**Review UI** (`backend/public/`): a small vanilla-JS single-page app (no build step) behind a login/signup gate, laid out as a sidebar (nav + recent uploads, clickable straight into the Review Queue) next to a main panel: Ask Rekono / Upload / Review Queue / Matching / Export / Team / Settings. The review queue shows the source document next to editable extracted fields, with low-confidence fields visually flagged; corrections are saved via `PATCH /api/invoices/:id` and logged to the audit trail. A fresh signup lands in a two-step onboarding wizard first (a few personalization questions, then a plan picker) rather than straight in the dashboard -- picking a paid plan hands off to Stripe Checkout before the dashboard ever loads. Settings covers account (name, password), organization (name, owner-only), billing (plan summary, Stripe's hosted "Manage billing" portal, upgrade), and the review-queue confidence threshold.

**Ask Rekono** (`assistant.js`, `routes/assistant.js`): a grounded Q&A assistant over the org's own invoice data, reachable from the dashboard's default view. Each question hands Gemini the org's invoice data as JSON plus the question, instructed to answer only from that data; the client also resends the visible thread (capped to the last 6 exchanges) so follow-ups like "what about just the unpaid ones" resolve against the previous answer, without the server persisting any conversation state. Deliberately read-only -- it can summarize, count, and total, but it cannot approve, reject, export, or otherwise act, so there's no risk of an LLM mistake touching anyone's books. Needs `GEMINI_API_KEY`; without it the endpoint returns `503` with a clear message rather than crashing.

**Expense Receipts** (`extractionReceipts.js`, `confidenceReceipts.js`, `expensePipeline.js`, `routes/expenses.js`, `ExpenseReceipt` model): a second document-processing pipeline, built by copying the invoice pipeline's shape (upload → OCR → LLM/heuristic extraction → confidence-gated review → approve/reject → export) onto a different document type and schema instead of generalizing the invoice code into a shared abstraction across two independently-evolving domains. A receipt has a merchant, date, category (from a fixed list, so the LLM classifies into it directly rather than inventing labels), currency, tax, and amount — no line items, no PO reference, no vendor matching. Confidence scoring is a plain weighted average of per-field confidence (`confidenceReceipts.js`) with no line-items-sum-vs-total cross-check, since a receipt has nothing to cross-check the total against. Deliberately v1-scoped: no bulk actions, no Quick Review queue, no auto-approval, no statistical sampling, no vendor-alias learning, no duplicate detection, no QuickBooks push — the same core loop the invoice pipeline itself started with before those grew on top of it one at a time. Shares the invoice pipeline's job queue (`jobs.js` dispatches by `kind`), monthly document cap (`documentUsage.js` sums both tables — one budget for total OCR/LLM spend per org, not a cap per document type), and confidence threshold setting. Reachable from the dashboard's "Expenses" sidebar tab, with its own CSV/Excel export.

**Vendor Documents** (`extractionVendorDocs.js`, `confidenceVendorDocs.js`, `vendorDocPipeline.js`, `routes/vendorDocuments.js`, `VendorDocument` model): a third document-processing pipeline, same shape as the two above, applied to vendor compliance paperwork -- W-9s, certificates of insurance, and contracts. Extracted fields are generic across all three types rather than one schema per type: vendor name, document type (classified from a fixed list, same reasoning as receipts' category), effective date, expiration date, a reference number (a TIN/EIN on a W-9, a policy number on a certificate of insurance, a contract number on a contract), and an amount (coverage limit or contract value; blank on a W-9). Confidence scoring weights vendor name and document type more heavily than the other fields, since expiration date/reference number/amount don't apply to every document type -- a valid W-9 extraction with no expiration date shouldn't score as if a field were missing. This module's one feature beyond the other two pipelines' core loop: `GET /api/vendor-documents?expiring_within_days=N` (and the dashboard's "Expiring within 30 days" filter) surfaces everything expiring soon or already expired, since flagging what's about to lapse before it does is the whole reason this module exists -- a document with no expiration date at all (a W-9) is correctly never "expiring". Same v1 scope as expense receipts otherwise (no bulk actions, Quick Review, auto-approval, QA sampling, vendor-alias learning, duplicate detection, or QuickBooks push), and shares the same job queue, monthly document cap, and confidence threshold. Reachable from the dashboard's "Vendor Docs" sidebar tab, with its own CSV/Excel export.

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
cp ../.env.example .env   # set GEMINI_API_KEY to enable LLM extraction (optional)
npm run dev
```

Open http://localhost:8000 for the review UI. Without `GEMINI_API_KEY` set, extraction falls back to the heuristic extractor, so you can exercise the whole pipeline immediately.

Try it with the bundled sample data in `sample_data/`: sign up (creates your organization), then upload `sample_invoice.pdf` on the Upload tab, then upload `sample_po.csv` (as Purchase Orders) and `sample_bank.csv` (as Bank Statement) on the Matching tab and click "Run Matching". Regenerate the sample PDF with `python sample_data/generate_sample_invoice.py` (needs `pip install reportlab` -- this one utility script is Python since it's dev-tooling, not part of the running app).

### Docker

```bash
docker compose up --build
```

Runs the app against Postgres instead of SQLite. Set `GEMINI_API_KEY` in your shell environment before `docker compose up` to enable LLM extraction.

### Deploying a live instance

Everything above runs locally or in your own Docker Compose — nothing is publicly reachable until you deploy it somewhere. Two prepared options, both under **your own** account (neither requires giving anyone else credentials):

#### Fly.io (has a free allowance)

`fly.toml` targets [Fly.io](https://fly.io), whose free allowance includes persistent volumes — the piece most "free" PaaS tiers drop, which matters here since uploaded invoices need to survive restarts. Requires the [`flyctl` CLI](https://fly.io/docs/flyctl/install/) and `fly auth login` first.

```bash
fly apps create <your-unique-app-name>   # "rekono-api" is likely taken globally -- pick your own,
                                          # then update the `app = "..."` line in fly.toml to match
fly postgres create --name rekono-db     # a separate Postgres app, on the same free allowance
fly postgres attach rekono-db            # wires DATABASE_URL into this app automatically
fly volumes create rekono_storage --size 3
fly secrets set SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
fly secrets set GEMINI_API_KEY=<your key>      # optional -- omit to run in heuristic/demo mode
fly deploy
```

`fly.toml` pins `min_machines_running = 1` rather than letting Fly scale the app to zero: invoice processing runs on an in-process background worker thread, not tied to any single HTTP request, so a machine that stopped right after an upload would strand that job mid-pipeline. That does mean it's not fully $0 depending on Fly's current pricing, but should stay inexpensive at this scale.

Your app is live at whatever URL `fly deploy` prints (`https://<your-app-name>.fly.dev` by default). Sign up from there to create the first organization and account.

#### Render (free tier)

`render.yaml` is a [Render Blueprint](https://render.com/docs/blueprint-spec) that provisions the web service on Render's **free** plan. It deliberately does **not** provision Render's own Postgres — see "Database (Neon)" below for why — so you'll need a Postgres connection string from elsewhere (Neon's free tier is the recommended option) before deploying.

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
3. Set `DATABASE_URL` to that connection string wherever the backend runs (Render/Fly dashboard, or `.env` locally) — no other code or config changes needed, since this app already talks to Postgres through Sequelize via `DATABASE_URL` alone.
4. On first boot against a fresh database, `initDb()` creates every table automatically (see `models/index.js`) — no manual migration step.

Fly.io's own `fly postgres create` (see below) doesn't have this 30-day deletion problem, so Neon is optional there — only worth it if you'd rather not manage a separate Fly Postgres app.

**If the deployed database ever gets into a broken schema state** that `initDb()`'s normal additive-only sync can't recover from on its own (its console logs will say so explicitly if this happens), there's a deliberately scary, explicitly-gated escape hatch: set `DANGEROUSLY_RESET_DB=true` in the web service's environment variables and redeploy. On boot, the app drops and recreates the entire `public` schema, then rebuilds every table fresh from the current models — **this permanently deletes all data**. Remove the env var again immediately after confirming it worked; it stays set across restarts otherwise, and every future boot would wipe the database again. This is meant for the "app is broken and there's nothing worth recovering" case (e.g. still in development), not a substitute for real backups or a real migration once there's data worth keeping.

### Tests

```bash
cd backend
npm test
```

Covers the confidence cross-check logic, the fuzzy matching engine, the heuristic extraction fallback, signup/login + cross-org data isolation, Google sign-in's find-or-create-by-verified-email logic and single-use handoff codes, onboarding + plan gating (`onboarding_required`/`billing_required`, including a "trialing" subscription counting as active), per-plan document cap enforcement and the "documents used this month" figure `GET /api/auth/me` reports, Stripe-backed billing routes (structurally, via their `503`-when-unconfigured path, plus unit coverage of the checkout-session/trial-period and subscription-replacement logic against a fake Stripe client), password reset, OCR error handling (missing files and unreadable images surface as a clean `OcrError` instead of a raw subprocess exception), the job queue's safety net that fails an invoice outright rather than leaving it stuck on "processing" forever if something throws unexpectedly mid-pipeline, startup recovery of invoices orphaned by a restart (re-run through the normal pipeline, or failed cleanly with a re-upload prompt if the source file didn't survive), duplicate-invoice detection (`findDuplicateInvoice`), the Business/Scale-only confidence threshold override (`effectiveConfidenceThreshold`, plus its own API route's plan gating), risk-based auto-approval (`shouldAutoApprove`'s every gating condition, plus the settings route's plan gating and its can't-enable-without-a-ceiling validation), learned vendor-name aliases (`vendorAlias.js` -- a corrected vendor name is remembered and auto-applied, with a confidence boost, the next time that exact raw text is extracted for the same org), the possible-multi-invoice heuristic (more than one distinct invoice number in a document forces review), team invites (seat-cap enforcement, owner-only permission checks, the full invite → accept → same-org-member flow, revoking/removing), the global error handler never leaking a raw internal error message to the client (a genuinely malformed multipart upload is the real-world trigger this test uses), the core API endpoints (upload validation, matching upload/run, corrections + audit log, approval, export, a missing source file returning a clean 404), a battery of security-hardening checks (uploaded files are only ever served back with a content-type derived from a fixed extension allowlist, never the client-supplied one -- including a disguised executable with a spoofed PDF content-type; oversized uploads are rejected with a clean `413`; login, signup, and the AI assistant all rate-limit repeated requests from the same account/IP; CSV/Excel export neutralizes formula-injection payloads with a leading apostrophe instead of exporting a live formula; and every response carries the standard `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy` headers), the Settings page's account/organization management (updating a user's own name, changing password with current-password verification and its own rate limit, renaming the organization gated to the owner role, and that renaming doesn't clobber an untouched confidence threshold in the same request), deleting a document (removes it from every list/detail view and from duplicate-detection candidates regardless of its status, is scoped to the caller's org, and -- since it's a soft delete -- still counts toward the plan's monthly document cap so it can't be used to get free upload quota), and bulk-approving/rejecting invoices (applies to every eligible invoice in one call, skips -- without failing the rest of the batch -- anything approve's status restriction rejects or that belongs to another org, reject has no status restriction the same way the single-invoice route doesn't), and retrying a failed extraction (re-queues and clears the error message, is blocked once approved, and 404s for a nonexistent or another org's invoice), and the invoice list's pagination, search, and sort (`page`/`page_size` bounds and the reported `total`, `q` matching vendor name and invoice number case-insensitively regardless of Postgres vs. SQLite, and `sort`/`order` honoring the fixed field allowlist rather than an arbitrary column), and Ask Rekono's conversation-history handling (a well-formed `history` array clears validation, a malformed role or an oversized array is rejected with a `422`), and deleting a matching source (removes it and its entries, is scoped to the caller's org, 404s the second time or for one that never existed, and leaves past match results in place with `match_entry_id` gone `null` rather than cascading into the audit trail). `tests/orgIsolation.test.js` collects the cross-org boundary checks that don't already live next to their own feature's tests in one place: an invoice's detail/file/audit-log/correction/approve/reject routes all 404 for another org, CSV/Excel export never includes another org's rows, and a matching run never treats another org's uploaded source as a candidate; `billing.js`'s `checkoutSessionBelongsToOrg` (stopping a signed-in user from hand-crafting someone else's real Stripe session id to activate billing on their own org) and team management's org scoping (`GET /api/team`, revoking an invite, removing a member) get the same direct coverage The expense receipts and vendor documents modules each get the same shape of coverage against their own suite of test files: heuristic extraction, weighted-average confidence scoring, upload/list/search/detail/correct/approve/reject/retry/delete, CSV/Excel export (incl. formula-injection neutralization), cross-org isolation, the shared monthly document cap counting all three document types together, and orphaned-job recovery picking up stuck receipts/vendor documents alongside stuck invoices. Vendor documents additionally cover the `expiring_within_days` filter: a document expiring soon or already expired is included, one expiring further out is excluded, one with no expiration date at all (a W-9) is never treated as "expiring", and the filter never crosses an org boundary — 418 tests total, all without a live Gemini/Resend/Stripe/Google key or a real Postgres database, so they run in plain CI. A handful of tests do shell out to the real Tesseract/Poppler binaries the Dockerfile installs (exercising real OCR failure paths); install both locally (`apt install tesseract-ocr poppler-utils` / `brew install tesseract poppler`) before running `npm test` outside Docker.

## API surface

Every endpoint below except `/api/auth/signup`, `/api/auth/login`, `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/google*`, `/api/team/invite/:token` (both the `GET` check and the `POST .../accept`), and `/api/health` requires an `Authorization: Bearer <token>` header, and every result is scoped to that token's organization. Every endpoint except those auth/invite-acceptance routes also returns `402` once that org's onboarding/billing state isn't active (`onboarding_required` or `billing_required` -- see `plan.js`).

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/signup` | Create an organization + first user, returns a bearer token |
| `POST /api/auth/login` | Email + password → bearer token |
| `GET /api/auth/google` | Redirects to Google's OAuth consent screen (requires `GOOGLE_CLIENT_ID`) |
| `GET /api/auth/google/callback` | Google redirects back here; finds or creates the account by verified email and redirects to `/` with a single-use handoff code |
| `GET /api/auth/google/exchange` | `{code}` from that redirect → bearer token (the actual token is never put in a URL) |
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
| `POST /api/matching/sources?source_type=po\|bank` | Upload a PO or bank statement CSV |
| `DELETE /api/matching/sources/:id` | Delete an uploaded source and its rows. Past match results that once matched against it are untouched -- they're a record of a past evaluation, not something the source owns -- their `match_entry_id` just goes `null` |
| `POST /api/matching/run` | Run the matching engine over all extracted invoices |
| `GET /api/matching/results` | All match results (newest first) |
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

Every secret this app uses (`GEMINI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_SECRET`, `QUICKBOOKS_CLIENT_SECRET`, `SECRET_KEY`, `DATABASE_URL`) is read from the environment in exactly one place (`config.js`) and never leaves the server:

- They're never sent to the browser. `backend/public/` is plain static HTML/JS with no build/bundling step, so there's no risk of a secret accidentally getting compiled into client-side code the way there can be in a bundled frontend -- the server-side `config.js` module is never loaded there in the first place.
- They're never echoed back in an API response, including error responses -- an unexpected server error (a DB failure, a bug) logs its full detail server-side but only ever returns a generic `"Internal server error"` to the caller (`app.js`'s `handleUnexpectedError`), so a stray internal error message can't leak connection strings or other detail. Every deliberate error response (validation, auth, plan gating) is written by hand in its own route and never includes secret material.
- `.env` is git-ignored (`.gitignore`) and `.env.example` -- the only env file actually committed -- contains no real values, just variable names.
- The two OAuth/webhook secrets that do get sent somewhere (`GOOGLE_CLIENT_SECRET` to Google's token endpoint, `STRIPE_WEBHOOK_SECRET` used to verify incoming signatures) are only ever used in server-to-server calls, never returned to a client.

If you're deploying this yourself: the only place these values should ever live is your platform's secret store (Render/Fly's dashboard env vars, or a local `.env` that stays untracked) -- never hardcoded into a file that gets committed. `git log -p | grep`-ing for key-shaped strings before a `git push` is a cheap habit if you're ever unsure whether one slipped in.

### Hardening

Beyond the secrets handling above, a few other defenses worth knowing about if you're extending this app:

- **Uploaded-file content-type is never trusted from the client.** `storage.js`'s `canonicalContentType` derives it solely from the file's extension against a fixed allowlist (`.pdf`, `.png`, `.jpg`/`.jpeg`, `.tif`/`.tiff`, `.bmp`, `.webp`) -- a client-declared `Content-Type` is ignored entirely, both on upload and when a file is served back for the review UI's document preview. This closes a stored-XSS path where an HTML/JS file disguised as a PDF, if served with an attacker-chosen content-type, would execute same-origin when previewed.
- **All user-controlled text rendered into the review UI is HTML-escaped** (`escapeHtml` in `backend/public/app.js`) -- vendor names, filenames, matching reasoning, and every other field that ultimately comes from an uploaded document or a human correction.
- **Rate limiting** (`rateLimit.js`) applies to login, signup, password reset, the contact form, and the AI assistant (`POST /api/assistant/ask`, limited per-org rather than per-IP since the real cost there is API spend, not request volume).
- **CSV/Excel export neutralizes formula injection**: a cell value starting with `=`, `+`, `-`, or `@` is prefixed with a leading apostrophe before being written out, so a malicious vendor name or filename can't turn into a live formula when the export is opened in Excel/Sheets/LibreOffice.
- **Standard security headers** (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Strict-Transport-Security` when served over HTTPS) are set on every response.
- **Content-Security-Policy** (`app.js`): `script-src 'self'` with no `unsafe-inline`/`unsafe-eval` -- the review UI (`backend/public/`) has no inline `<script>` blocks or inline event-handler attributes anywhere, only `<script src="/*.js">`, so this is a real restriction, not a symbolic one. `style-src` needs `'unsafe-inline'` for the UI's inline `style="..."` attributes (no build step to generate nonces/hashes for them) plus Google Fonts' stylesheet host; `img-src`/`frame-src` allow `blob:` for the document preview, which fetches the file with its bearer token and hands the `<iframe>`/`<img>` a `URL.createObjectURL(blob)` URL instead of pointing `src=` straight at the API (which couldn't carry the token). Everything else (`connect-src`, `form-action`, `frame-ancestors`, `object-src`) is locked to `'self'`/`'none'`.
- Every route that looks up a record by ID scopes the query to the authenticated user's `orgId` (see `auth.js`'s `requireAuth` and each router's `where: { orgId: ... }`), so one org can never read or modify another's data by guessing/incrementing an ID.
- **CORS is a fixed allowlist**, not wide open (`app.js`) -- only the marketing site's own origin and the app's own deployed origin can make cross-origin browser requests. `ALLOWED_ORIGINS` (comma-separated) overrides the default list if you deploy this somewhere else. A request with no `Origin` header at all (server-to-server calls, curl) is unaffected -- that header only exists for a browser to enforce same-origin policy client-side in the first place.
- **QuickBooks OAuth tokens are encrypted at rest** (`secretBox.js`, AES-256-GCM, key derived from `SECRET_KEY` via HKDF) -- `Organization.quickbooksAccessToken`/`quickbooksRefreshToken` are ciphertext in the database and only ever decrypted in memory via the model's getter. A database compromise alone (leaked connection string, SQL injection, insider access) doesn't also hand over a live credential into a customer's real QuickBooks company file.

No software is ever fully "unhackable" -- this is a genuine, tested hardening pass against the realistic risks for an app like this (XSS, stored-content-type confusion, brute force, spreadsheet formula injection, cross-org data leakage), not a guarantee against every possible attack.

### Contact form email (Resend)

`POST /api/contact` sends through [Resend](https://resend.com) and needs `RESEND_API_KEY` set, or it responds `503` (the marketing site's contact modal falls back to a `mailto:` link automatically when that happens, so the form degrading gracefully doesn't mean visitors are stuck).

1. Sign up at [resend.com](https://resend.com) (free tier: 3,000 emails/month, 100/day).
2. Get an API key from the dashboard (**API Keys → Create API Key**).
3. Set `RESEND_API_KEY` on the deployed backend (Render/Fly dashboard, or `.env` locally).
4. By default, `CONTACT_FROM_EMAIL` is `onboarding@resend.dev` -- Resend's shared sandbox sender, which works without any domain setup as long as `CONTACT_TO_EMAIL` (defaults to `wfrownusa@yahoo.com`) is the same address you signed up to Resend with. To send from your own domain instead, verify it in Resend (**Domains** tab) and set `CONTACT_FROM_EMAIL` to an address at that domain.

### Plans & billing (Stripe)

Paid-plan checkout, the billing-management portal, and the onboarding wizard's paid-plan path all need `STRIPE_SECRET_KEY` set, or they respond `503` (Free-plan onboarding and every other route work regardless -- billing is the one thing this gates).

1. Sign up at [stripe.com](https://stripe.com) and grab your **test mode** secret key first (**Developers → API keys**) to try the flow safely -- it's a normal Checkout page, just backed by [Stripe's test card numbers](https://stripe.com/docs/testing) instead of real money.
2. Set `STRIPE_SECRET_KEY` on the deployed backend (Render/Fly dashboard, or `.env` locally). That alone is enough for checkout and the billing portal to work -- no Products/Prices need to be created in the Stripe dashboard, since `routes/billing.js` builds the price inline from `plans.js` at checkout time.
3. For the webhook (keeps plan status in sync with renewals/cancellations after the initial checkout): in Stripe, **Developers → Webhooks → Add endpoint**, pointed at `https://<your-deployed-url>/api/billing/webhook`, listening for `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`. Copy the endpoint's **Signing secret** into `STRIPE_WEBHOOK_SECRET`.
4. Switch to live mode keys (both the secret key and a live-mode webhook endpoint/secret) once you're ready to accept real payments -- test and live are entirely separate in Stripe, including their webhooks.
5. Plan prices/caps live in `backend/src/plans.js`, matching the marketing site's pricing section -- change both together if either changes.
6. A brand new org's first paid plan choice (during onboarding) gets a 14-day Stripe trial (`TRIAL_DAYS` in `plans.js`) -- a card is collected at checkout but not charged until the trial ends, handled entirely by Stripe's `subscription_data.trial_period_days`, no custom day-counting. A later plan change through the in-app Upgrade button bills immediately, no trial (see `createCheckoutSession` in `routes/billing.js`).

### Sign in with Google

The "Sign in with Google" button needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` set, or `GET /api/auth/google` redirects straight back with an error instead of crashing (email/password sign-in and everything else work regardless).

1. In the [Google Cloud Console](https://console.cloud.google.com), create a project (or reuse one) and go to **APIs & Services → OAuth consent screen**. Fill in the required fields (app name, support email); external + testing mode is fine to start.
2. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**, application type **Web application**.
3. Under **Authorized redirect URIs**, add `https://<your-deployed-url>/api/auth/google/callback` (and `http://localhost:8000/api/auth/google/callback` too, for local dev). This has to match exactly what the backend sends, which is always `<request origin>/api/auth/google/callback`.
4. Copy the generated **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (Render/Fly dashboard, or `.env` locally).
5. No new database columns or account-linking table: a Google sign-in is matched to an existing account purely by verified email, and creates a new org + user (same as a normal signup, sent through the same onboarding wizard) if there's no match yet. See `completeGoogleLogin` in `routes/auth.js`.

### QuickBooks Online (Phase 1)

The Settings tab's "Integrations" panel needs `QUICKBOOKS_CLIENT_ID`/`QUICKBOOKS_CLIENT_SECRET` set, or it shows "QuickBooks isn't set up yet" instead of a Connect button (every other route works regardless). Phase 1 is deliberately scoped: OAuth connect against Intuit's free Sandbox company file, a default-expense-account picker, and a manual, one-way, per-invoice "Push to QuickBooks" button that creates a Bill. No sync-back, no bulk push, no push-on-approve automation yet -- see Roadmap.

Each invoice also gets its own suggested expense account (shown on the invoice detail panel once connected) instead of always filing under the org's static default -- vendor/line-items are matched against org's real chart of accounts via an LLM call (`quickbooks.js`'s `suggestExpenseAccount`), same self-reported-confidence pattern as extraction. This needs `GEMINI_API_KEY` set (see below); without it, every invoice just falls back to the org default exactly as Phase 1 originally shipped -- there's no reasonable regex/heuristic way to match free-text vendor wording against an arbitrary chart of accounts, so this one feature has no heuristic fallback path. A human correcting or confirming an account is remembered per-vendor (`VendorExpenseAccount`, same shape as `VendorAlias`'s learned vendor-name corrections), so the same vendor's future invoices suggest it directly without another LLM call.

The Matching tab also surfaces **bank reconciliation** once connected: QuickBooks' bank/card feed API has no public endpoint for the raw "for review" feed, but once a transaction has been added as a `Purchase` (the common outcome when a bookkeeper doesn't recognize it as paying an existing Bill), it's a normal queryable transaction -- and often duplicates a Bill Rekono already pushed and is still sitting unpaid. `quickbooks.js`'s `fetchBankTransactions` pulls those, `findExactAmountCandidates` narrows them to Rekono's own unpaid pushed bills by exact dollar amount and a loose date window (no AI needed -- this alone usually resolves to a single confident match), and `suggestBankTransactionMatch` (an LLM call, same `GEMINI_API_KEY`-gated no-fallback shape as expense categorization) only gets involved to disambiguate multiple same-amount candidates using the transaction's often-abbreviated payee/memo text. Confirming a match is Rekono-side only -- it marks the invoice paid here, but never writes back to (or deletes/voids anything in) QuickBooks itself; cleaning up the duplicate `Purchase` transaction is left to the human, in QuickBooks, once they've confirmed the match.

1. Create an app at the [Intuit Developer Portal](https://developer.intuit.com) (**My Apps → Create an app → QuickBooks Online and Payments**).
2. Under the app's **Keys & OAuth** tab, copy the **Sandbox** **Client ID**/**Client Secret** into `QUICKBOOKS_CLIENT_ID`/`QUICKBOOKS_CLIENT_SECRET`. Leave `QUICKBOOKS_ENVIRONMENT` unset (defaults to `sandbox`) -- no Intuit app-review is required for Sandbox use, only for Production.
3. Under **Redirect URIs**, add `https://<your-deployed-url>/api/integrations/quickbooks/callback` (and `http://localhost:8000/api/integrations/quickbooks/callback` for local dev). This has to match exactly what the backend sends, which is always `<request origin>/api/integrations/quickbooks/callback`.
4. The Developer Portal also provides a free Sandbox company file (**Sandbox** tab) to connect against and inspect pushed Bills in.
5. Connecting stores tokens per-org on `Organization` (`quickbooksAccessToken`/`quickbooksRefreshToken`, both nullable so a disconnected org just has `null`s -- see `models/Organization.js`); access tokens auto-refresh on use (`ensureFreshToken` in `quickbooks.js`). Going to Production later means switching `QUICKBOOKS_ENVIRONMENT=production`, swapping in Production keys, and passing Intuit's app-assessment review (token storage/data retention, roughly 2-3 weeks) -- Sandbox needs none of that.

## Roadmap (beyond this MVP)

Deliberately not built yet, to keep the MVP demoable and honest about what's real:

- **Email ingestion** (forward invoices to a dedicated address) and **watched folder/Drive integration** — additive front-ends onto `storage.js`'s upload handling + the existing job queue.
- **Production job queue**: swap the in-process queue (`src/jobs.js`) for BullMQ/Redis or SQS once throughput needs it. The `enqueue()` call site is the only integration point.
- **Cloud OCR**: swap Tesseract for AWS Textract or Google Document AI behind `ocr.extractText` for better accuracy on messy scans.
- **Accounting software integrations**: QuickBooks Online Phase 1 (Sandbox OAuth connect + manual one-way Bill push + per-invoice AI expense-account categorization + AI-assisted bank reconciliation, see above) is done. Still ahead: Production access (Intuit app-assessment review), push-on-approve automation instead of a manual button, bulk push, and Xero/NetSuite support — this is what makes it sellable rather than a CSV toy.
- **Dashboard**: exceptions queue, reconciliation status, aging report, once there's enough volume for those views to matter.
- **Vertical-specific extraction schemas and matching rules** once there's a design partner in a specific industry (property management, trucking, medical billing, etc.) — the generic schema here is the horizontal starting point.
- **Prompt/rule feedback loop**: corrections made in the review UI are already captured as structured `human_correction` audit log entries; using that history to auto-tune the confidence threshold or few-shot the extraction prompt is future work.
- **Compliance**: audit logging exists from day one; formal data retention policy and SOC 2 groundwork come with the first real customer conversations.

## License

Proprietary -- all rights reserved. See [`LICENSE`](LICENSE). This repository being visible on GitHub does not grant permission to use, copy, modify, host, or distribute this software; contact the owner for a license, including for self-hosting.
