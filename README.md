# Rekono

AI-powered invoice ingestion, extraction, and reconciliation for accounts payable. Upload an invoice, get back structured, confidence-scored data, review/correct what the model wasn't sure about, and match it against your POs or bank statement.

This repo is the MVP described below: upload → extract → review → export → single-rule matching. It's built to extend cleanly toward the fuller architecture (email ingestion, accounting-software integrations, richer reconciliation) without a rewrite.

## MVP scope

1. Upload a PDF/image invoice → OCR → LLM structured extraction → confidence-scored JSON.
2. Review UI: side-by-side source document + editable extracted fields, low-confidence fields highlighted, approve/reject with a full audit trail.
3. Export approved (or all) invoices to CSV/Excel.
4. One matching rule: fuzzy vendor name + amount tolerance + date window against an uploaded PO or bank statement CSV.
5. Accounts: email/password signup creates an organization; every invoice, match source, and audit log entry is scoped to it, so separate customers/teams never see each other's data.

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

**Matching/reconciliation engine** (`matching.js`, `routes/matching.js`): fuzzy vendor-name matching (`fuzzball`, a FuzzyWuzzy/rapidfuzz-style token-sort ratio) plus configurable amount tolerance (% and absolute) and a date window, with an exact PO/reference-number match as a strong signal. Produces `matched` / `partial` / `unmatched` with a human-readable reasoning string for every decision — this is the part of the system closest to a constraint-matching problem.

**Data layer** (`models/`): Postgres in production (SQLite by default for local dev — no separate DB server needed to try it out) via Sequelize. Every extraction, human correction, approval/rejection, and match decision writes an `AuditLog` row — the audit trail that finance/compliance conversations will ask about. Every table that holds customer data (`Invoice`, `MatchSource`, `AuditLog`) carries an `orgId`, and every route filters by the authenticated user's org — see `auth.js` and `models/` (`Organization`, `User`).

**Auth** (`auth.js`, `routes/auth.js`): email + password, bcrypt-hashed, stateless JWT bearer tokens (14-day expiry). Signup creates a new `Organization` plus its first `User`; there's no cross-org signup/invite flow yet (see Roadmap). `SECRET_KEY` is read from the environment if set, otherwise auto-generated and persisted to a local file on first run — fine for a single instance, but set it explicitly (Render's Blueprint and the Fly.io instructions below both do this for you) for any deployment with more than one replica.

**Output/integration layer** (`routes/export.js`): CSV/Excel export today. QuickBooks/Xero/NetSuite push integrations are additive on top of the same Invoice/MatchResult data (see Roadmap).

**Review UI** (`backend/public/`): a small vanilla-JS single-page app (no build step) — Upload / Review Queue / Matching / Export tabs, in front of a login/signup gate. The review queue shows the source document next to editable extracted fields, with low-confidence fields visually flagged; corrections are saved via `PATCH /api/invoices/:id` and logged to the audit trail.

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
3. Once deployed, set `ANTHROPIC_API_KEY` in the web service's environment variables (Render dashboard) if you want LLM extraction instead of the heuristic fallback — everything else (`DATABASE_URL`, `SECRET_KEY`) is wired up automatically by the Blueprint.
4. Your app is live at `https://<service-name>.onrender.com`.

Two tradeoffs that come with staying on free: Render's free Postgres plan auto-deletes after 30 days (recreate it, or upgrade to `starter` in `render.yaml`, before then if you want to keep data), and free web services can't attach a persistent disk, so uploaded invoice files live in the container's ephemeral storage and don't survive a restart/redeploy — the extracted data and audit trail in Postgres are unaffected, only the original source files (used for the review UI's document preview) aren't. Free web services also spin down after 15 minutes idle and cold-start on the next request.

### Tests

```bash
cd backend
npm test
```

Covers the confidence cross-check logic, the fuzzy matching engine, the heuristic extraction fallback, signup/login + cross-org data isolation, and the core API endpoints (upload validation, matching upload/run, corrections + audit log, approval, export) — 24 tests total, all without requiring Tesseract, Poppler, or an Anthropic API key, so they run in plain CI.

## API surface

Every endpoint below except `/api/auth/signup`, `/api/auth/login`, and `/api/health` requires an `Authorization: Bearer <token>` header, and every result is scoped to that token's organization.

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/signup` | Create an organization + first user, returns a bearer token |
| `POST /api/auth/login` | Email + password → bearer token |
| `GET /api/auth/me` | Current user, for verifying a stored token |
| `POST /api/invoices/upload` | Upload a PDF/image; queues extraction |
| `GET /api/invoices` | List invoices, optional `?status=` filter |
| `GET /api/invoices/:id` | Full invoice detail incl. line items, confidence, match results |
| `GET /api/invoices/:id/file` | Serve the original document (for preview) |
| `PATCH /api/invoices/:id` | Human corrections; writes an audit log entry |
| `POST /api/invoices/:id/approve` \| `/reject` | Review decision |
| `GET /api/invoices/:id/audit-log` | Full audit trail for one invoice |
| `POST /api/matching/sources?source_type=po\|bank` | Upload a PO or bank statement CSV |
| `POST /api/matching/run` | Run the matching engine over all extracted invoices |
| `GET /api/matching/results` | All match results (newest first) |
| `GET /api/export/csv` \| `/api/export/xlsx` | Export all invoices with status + latest match result |

## Configuration

See `.env.example`. Notable knobs: `REVIEW_CONFIDENCE_THRESHOLD` (below this, an invoice is flagged `needs_review` instead of fast-tracked as `extracted`), and `MATCH_AMOUNT_TOLERANCE_PCT` / `MATCH_AMOUNT_TOLERANCE_ABS` / `MATCH_DATE_WINDOW_DAYS` / `MATCH_VENDOR_SCORE_THRESHOLD` for the matching engine.

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
