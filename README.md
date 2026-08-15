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
        LLM structured extraction (Claude, tool-use forced JSON)
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
- Structured extraction via Claude (`@anthropic-ai/sdk`), using tool-use to force a fixed JSON schema (vendor, invoice #, dates, PO reference, totals, line items) with a self-reported confidence per field.
- If `ANTHROPIC_API_KEY` isn't set, a heuristic regex extractor takes over so the full pipeline (ingest → extract → review → export → match) still runs end-to-end for demos, tests, and CI. Heuristic fields get a flat, low confidence score, which naturally routes them into the review queue instead of silently shipping bad data.
- Confidence scoring combines per-field confidence with an automatic cross-check (do line items sum to the total, or subtotal + tax = total?). A failed cross-check pulls overall confidence down independent of what the model claimed.
- Learned vendor aliases (`vendorAlias.js`): correcting a vendor name in review (`PATCH /api/invoices/:id`) remembers the original raw text → corrected name for that org. The next extraction whose raw vendor text matches exactly gets the corrected name applied automatically with a confidence boost, instead of needing the same correction every time that vendor's invoices come in.
- Possible-multi-invoice flag: extraction only ever fills in one invoice's worth of fields, so a document that actually contains more than one (a batch scan, several invoices in one PDF) forces review instead of silently extracting just the first one. The LLM self-reports this; the heuristic fallback flags more than one distinct invoice number found in the text.

**Matching/reconciliation engine** (`matching.js`, `routes/matching.js`): fuzzy vendor-name matching (`fuzzball`, a FuzzyWuzzy/rapidfuzz-style token-sort ratio) plus configurable amount tolerance (% and absolute) and a date window, with an exact PO/reference-number match as a strong signal. Produces `matched` / `partial` / `unmatched` with a human-readable reasoning string for every decision — this is the part of the system closest to a constraint-matching problem.

**Data layer** (`models/`): Postgres in production (SQLite by default for local dev — no separate DB server needed to try it out) via Sequelize. Every extraction, human correction, approval/rejection, and match decision writes an `AuditLog` row — the audit trail that finance/compliance conversations will ask about. Every table that holds customer data (`Invoice`, `MatchSource`, `AuditLog`) carries an `orgId`, and every route filters by the authenticated user's org — see `auth.js` and `models/` (`Organization`, `User`).

**Auth** (`auth.js`, `routes/auth.js`): email + password, bcrypt-hashed, stateless JWT bearer tokens (14-day expiry). Signup creates a new `Organization` plus its first `User` (`role: "owner"`). `SECRET_KEY` is read from the environment if set, otherwise auto-generated and persisted to a local file on first run — fine for a single instance, but set it explicitly (Render's Blueprint and the Fly.io instructions below both do this for you) for any deployment with more than one replica.

**Team invites** (`seats.js`, `routes/team.js`): the org's owner can invite teammates by email, up to the plan's seat count (`plans.js`'s `seats` -- `null` means unlimited; a pending invite reserves a seat so the cap can't be oversubscribed before anyone accepts). The invite email links to `/?invite_token=...`, which lets the invitee set a name and password and creates a `role: "member"` User on the same org -- no separate signup, no second organization. Degrades the same way as the other Resend-gated flows: without `RESEND_API_KEY` configured, the invite still gets created and its link is handed back directly in the API response instead of emailed.

**Onboarding & billing** (`plans.js`, `plan.js`, `routes/onboarding.js`, `routes/billing.js`): a new org's `plan` is `null` until the post-signup wizard completes -- `plan.js`'s `requireActivePlan` middleware (mounted the same way `requireActiveTrial` used to be) blocks every data route until it does. Picking Free activates instantly; picking a paid tier creates a Stripe Checkout session with the price built inline from `plans.js` (`price_data`, not a dashboard-configured Product/Price -- so standing up billing only ever needs a Stripe account + API keys, nothing to keep in sync by hand) and only activates the plan once Stripe confirms payment, both via the redirect back (`GET /api/billing/confirm`) and a webhook (`POST /api/billing/webhook`) that also keeps the plan in sync with renewals/cancellations afterward. `GET /api/billing/portal` hands off to Stripe's own hosted billing-management UI rather than a custom one. All of it degrades to a clear `503` instead of crashing when `STRIPE_SECRET_KEY` isn't set, same pattern as the Anthropic/Resend integrations.

**Output/integration layer** (`routes/export.js`): CSV/Excel export today. QuickBooks/Xero/NetSuite push integrations are additive on top of the same Invoice/MatchResult data (see Roadmap).

**Review UI** (`backend/public/`): a small vanilla-JS single-page app (no build step) behind a login/signup gate, laid out as a sidebar (nav + recent uploads, clickable straight into the Review Queue) next to a main panel: Ask Rekono / Upload / Review Queue / Matching / Export / Team / Settings. The review queue shows the source document next to editable extracted fields, with low-confidence fields visually flagged; corrections are saved via `PATCH /api/invoices/:id` and logged to the audit trail. A fresh signup lands in a two-step onboarding wizard first (a few personalization questions, then a plan picker) rather than straight in the dashboard -- picking a paid plan hands off to Stripe Checkout before the dashboard ever loads. Settings covers account (name, password), organization (name, owner-only), billing (plan summary, Stripe's hosted "Manage billing" portal, upgrade), and the review-queue confidence threshold.

**Ask Rekono** (`assistant.js`, `routes/assistant.js`): a grounded Q&A assistant over the org's own invoice data, reachable from the dashboard's default view. Each question is answered independently (no conversation memory) by handing Claude the org's invoice data as JSON and the question in one prompt, instructed to answer only from that data. Deliberately read-only -- it can summarize, count, and total, but it cannot approve, reject, export, or otherwise act, so there's no risk of an LLM mistake touching anyone's books. Needs `ANTHROPIC_API_KEY`; without it the endpoint returns `503` with a clear message rather than crashing.

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
cp ../.env.example .env   # set ANTHROPIC_API_KEY to enable LLM extraction (optional)
npm run dev
```

Open http://localhost:8000 for the review UI. Without `ANTHROPIC_API_KEY` set, extraction falls back to the heuristic extractor, so you can exercise the whole pipeline immediately.

Try it with the bundled sample data in `sample_data/`: sign up (creates your organization), then upload `sample_invoice.pdf` on the Upload tab, then upload `sample_po.csv` (as Purchase Orders) and `sample_bank.csv` (as Bank Statement) on the Matching tab and click "Run Matching". Regenerate the sample PDF with `python sample_data/generate_sample_invoice.py` (needs `pip install reportlab` -- this one utility script is Python since it's dev-tooling, not part of the running app).

### Docker

```bash
docker compose up --build
```

Runs the app against Postgres instead of SQLite. Set `ANTHROPIC_API_KEY` in your shell environment before `docker compose up` to enable LLM extraction.

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
fly secrets set ANTHROPIC_API_KEY=<your key>   # optional -- omit to run in heuristic/demo mode
fly deploy
```

`fly.toml` pins `min_machines_running = 1` rather than letting Fly scale the app to zero: invoice processing runs on an in-process background worker thread, not tied to any single HTTP request, so a machine that stopped right after an upload would strand that job mid-pipeline. That does mean it's not fully $0 depending on Fly's current pricing, but should stay inexpensive at this scale.

Your app is live at whatever URL `fly deploy` prints (`https://<your-app-name>.fly.dev` by default). Sign up from there to create the first organization and account.

#### Render (free tier)

`render.yaml` is a [Render Blueprint](https://render.com/docs/blueprint-spec) that provisions a web service + managed Postgres in one step, both on Render's **free** plan:

1. Push/fork this repo to your own GitHub.
2. In Render: **New → Blueprint**, point it at the repo. (If you don't see "Blueprint" as an option, your account may only show the per-resource flow — create a **Postgres** instance first, then a **Web Service** pointed at this repo's `Dockerfile`, and set its env vars to match `render.yaml`: `DATABASE_URL` from the Postgres instance's internal connection string, `STORAGE_DIR=/tmp/storage`, a random `SECRET_KEY`, and optionally `ANTHROPIC_API_KEY`.)
3. Once deployed, set `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, and/or `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` in the web service's environment variables (Render dashboard) to enable LLM extraction, the contact form, and paid plans respectively — all optional, all degrade to a clear error instead of crashing when unset. `DATABASE_URL` and `SECRET_KEY` are wired up automatically by the Blueprint.
4. Your app is live at `https://<service-name>.onrender.com`.

Two tradeoffs that come with staying on free: Render's free Postgres plan auto-deletes after 30 days (recreate it, or upgrade to `starter` in `render.yaml`, before then if you want to keep data), and free web services can't attach a persistent disk, so uploaded invoice files live in the container's ephemeral storage and don't survive a restart/redeploy — the extracted data and audit trail in Postgres are unaffected, only the original source files (used for the review UI's document preview) aren't. Free web services also spin down after 15 minutes idle and cold-start on the next request.

**If the deployed database ever gets into a broken schema state** that `initDb()`'s normal additive-only sync can't recover from on its own (its console logs will say so explicitly if this happens), there's a deliberately scary, explicitly-gated escape hatch: set `DANGEROUSLY_RESET_DB=true` in the web service's environment variables and redeploy. On boot, the app drops and recreates the entire `public` schema, then rebuilds every table fresh from the current models — **this permanently deletes all data**. Remove the env var again immediately after confirming it worked; it stays set across restarts otherwise, and every future boot would wipe the database again. This is meant for the "app is broken and there's nothing worth recovering" case (e.g. still in development), not a substitute for real backups or a real migration once there's data worth keeping.

### Tests

```bash
cd backend
npm test
```

Covers the confidence cross-check logic, the fuzzy matching engine, the heuristic extraction fallback, signup/login + cross-org data isolation, Google sign-in's find-or-create-by-verified-email logic and single-use handoff codes, onboarding + plan gating (`onboarding_required`/`billing_required`, including a "trialing" subscription counting as active), per-plan document cap enforcement and the "documents used this month" figure `GET /api/auth/me` reports, Stripe-backed billing routes (structurally, via their `503`-when-unconfigured path, plus unit coverage of the checkout-session/trial-period and subscription-replacement logic against a fake Stripe client), password reset, OCR error handling (missing files and unreadable images surface as a clean `OcrError` instead of a raw subprocess exception), the job queue's safety net that fails an invoice outright rather than leaving it stuck on "processing" forever if something throws unexpectedly mid-pipeline, startup recovery of invoices orphaned by a restart (re-run through the normal pipeline, or failed cleanly with a re-upload prompt if the source file didn't survive), duplicate-invoice detection (`findDuplicateInvoice`), the Business/Scale-only confidence threshold override (`effectiveConfidenceThreshold`, plus its own API route's plan gating), learned vendor-name aliases (`vendorAlias.js` -- a corrected vendor name is remembered and auto-applied, with a confidence boost, the next time that exact raw text is extracted for the same org), the possible-multi-invoice heuristic (more than one distinct invoice number in a document forces review), team invites (seat-cap enforcement, owner-only permission checks, the full invite → accept → same-org-member flow, revoking/removing), the global error handler never leaking a raw internal error message to the client (a genuinely malformed multipart upload is the real-world trigger this test uses), the core API endpoints (upload validation, matching upload/run, corrections + audit log, approval, export, a missing source file returning a clean 404), a battery of security-hardening checks (uploaded files are only ever served back with a content-type derived from a fixed extension allowlist, never the client-supplied one -- including a disguised executable with a spoofed PDF content-type; oversized uploads are rejected with a clean `413`; login, signup, and the AI assistant all rate-limit repeated requests from the same account/IP; CSV/Excel export neutralizes formula-injection payloads with a leading apostrophe instead of exporting a live formula; and every response carries the standard `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy` headers), the Settings page's account/organization management (updating a user's own name, changing password with current-password verification and its own rate limit, renaming the organization gated to the owner role, and that renaming doesn't clobber an untouched confidence threshold in the same request), deleting a document (removes it from every list/detail view and from duplicate-detection candidates regardless of its status, is scoped to the caller's org, and -- since it's a soft delete -- still counts toward the plan's monthly document cap so it can't be used to get free upload quota), and bulk-approving/rejecting invoices (applies to every eligible invoice in one call, skips -- without failing the rest of the batch -- anything approve's status restriction rejects or that belongs to another org, reject has no status restriction the same way the single-invoice route doesn't), and retrying a failed extraction (re-queues and clears the error message, is blocked once approved, and 404s for a nonexistent or another org's invoice) — 178 tests total, all without a live Anthropic/Resend/Stripe/Google key or a real Postgres database, so they run in plain CI. A handful of tests do shell out to the real Tesseract/Poppler binaries the Dockerfile installs (exercising real OCR failure paths); install both locally (`apt install tesseract-ocr poppler-utils` / `brew install tesseract poppler`) before running `npm test` outside Docker.

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
| `GET /api/org/settings` \| `PATCH /api/org/settings` | Org-level settings: the review-queue confidence threshold (a Business/Scale-only override, `customConfidenceThreshold` in `plans.js`, of the server-wide `REVIEW_CONFIDENCE_THRESHOLD` default -- `PATCH` with `{confidence_threshold: null}` always resets to the default, on any plan) and the organization's name (`org_name`, owner-only to change). Either field can be patched independently of the other |
| `GET /api/team` | List the org's members and pending invites, plus seat usage against the plan's limit |
| `POST /api/team/invite` | Owner-only. Invite by email, capped at the plan's seat count. Emails the invite link if `RESEND_API_KEY` is set, otherwise returns the link directly for the owner to share manually |
| `DELETE /api/team/invites/:id` | Owner-only. Revoke a pending invite, freeing its reserved seat |
| `DELETE /api/team/members/:userId` | Owner-only. Remove a teammate. The owner can't remove themself (no ownership transfer yet) |
| `GET /api/team/invite/:token` | Public. Validates an invite link and returns the org name + invited email, for the accept-invite page |
| `POST /api/team/invite/:token/accept` | Public. `{full_name, password}` → creates a `role: "member"` User on the inviting org, returns a bearer token |
| `POST /api/invoices/upload` | Upload one or more PDF/images (each queues its own extraction and its own document-cap check). Rejected with `402` + `plan_cap_reached` once the org's plan document cap for the current month is hit |
| `GET /api/invoices` | List invoices, optional `?status=` filter |
| `GET /api/invoices/:id` | Full invoice detail incl. line items, confidence, match results |
| `GET /api/invoices/:id/file` | Serve the original document (for preview) |
| `PATCH /api/invoices/:id` | Human corrections; writes an audit log entry. A corrected vendor name is also remembered (`vendorAlias.js`) and auto-applied to future extractions of that same raw text for this org |
| `POST /api/invoices/:id/approve` \| `/reject` | Review decision |
| `POST /api/invoices/bulk-action` | `{ids, action: "approve"\|"reject"}` -- applies the same transition across up to 500 invoices in one call. Never fails the whole batch for one bad id: anything outside the caller's org, or that approve's status restriction rejects, comes back in `skipped` (with why) instead of erroring |
| `DELETE /api/invoices/:id` | Delete a document, at any point in its review lifecycle. Soft delete (`Invoice` is a paranoid Sequelize model) -- the row and its line items/match results/audit log stay in the database but disappear from every normal query; still counts toward the plan's monthly document cap, so delete-and-re-upload can't be used to get extra quota |
| `POST /api/invoices/:id/retry` | Re-queues the document for a fresh OCR + extraction pass without a re-upload -- the recovery path for a transient OCR/LLM failure. Blocked once approved, since that means a human already signed off on the current field values |
| `GET /api/invoices/:id/audit-log` | Full audit trail for one invoice |
| `POST /api/matching/sources?source_type=po\|bank` | Upload a PO or bank statement CSV |
| `POST /api/matching/run` | Run the matching engine over all extracted invoices |
| `GET /api/matching/results` | All match results (newest first) |
| `GET /api/export/csv` \| `/api/export/xlsx` | Export all invoices with status + latest match result |
| `POST /api/assistant/ask` | Ask a question about this org's invoices; answered by Claude grounded in that data only |
| `POST /api/contact` | Public (no auth) -- the marketing site's "Talk to us" form. Rate-limited, honeypot-protected. |

## Configuration

See `.env.example`. Notable knobs: `REVIEW_CONFIDENCE_THRESHOLD` (below this, an invoice is flagged `needs_review` instead of fast-tracked as `extracted`), and `MATCH_AMOUNT_TOLERANCE_PCT` / `MATCH_AMOUNT_TOLERANCE_ABS` / `MATCH_DATE_WINDOW_DAYS` / `MATCH_VENDOR_SCORE_THRESHOLD` for the matching engine.

### Secrets & API keys

Every secret this app uses (`ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_SECRET`, `SECRET_KEY`, `DATABASE_URL`) is read from the environment in exactly one place (`config.js`) and never leaves the server:

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
- **Standard security headers** (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Strict-Transport-Security` when served over HTTPS) are set on every response. There's deliberately no Content-Security-Policy yet -- the review UI is hand-rolled vanilla JS/HTML with inline styles and no nonce/hash build step, so a real CSP needs that infrastructure first; a follow-up, not an oversight.
- Every route that looks up a record by ID scopes the query to the authenticated user's `orgId` (see `auth.js`'s `requireAuth` and each router's `where: { orgId: ... }`), so one org can never read or modify another's data by guessing/incrementing an ID.

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

## Roadmap (beyond this MVP)

Deliberately not built yet, to keep the MVP demoable and honest about what's real:

- **Email ingestion** (forward invoices to a dedicated address) and **watched folder/Drive integration** — additive front-ends onto `storage.js`'s upload handling + the existing job queue.
- **Production job queue**: swap the in-process queue (`src/jobs.js`) for BullMQ/Redis or SQS once throughput needs it. The `enqueue()` call site is the only integration point.
- **Cloud OCR**: swap Tesseract for AWS Textract or Google Document AI behind `ocr.extractText` for better accuracy on messy scans.
- **Accounting software integrations**: push approved invoices to QuickBooks/Xero/NetSuite via API/webhook — this is what makes it sellable rather than a CSV toy, and the natural next step once export is validated with a design partner.
- **Dashboard**: exceptions queue, reconciliation status, aging report, once there's enough volume for those views to matter.
- **Vertical-specific extraction schemas and matching rules** once there's a design partner in a specific industry (property management, trucking, medical billing, etc.) — the generic schema here is the horizontal starting point.
- **Prompt/rule feedback loop**: corrections made in the review UI are already captured as structured `human_correction` audit log entries; using that history to auto-tune the confidence threshold or few-shot the extraction prompt is future work.
- **Compliance**: audit logging exists from day one; formal data retention policy and SOC 2 groundwork come with the first real customer conversations.
