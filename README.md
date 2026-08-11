# Rekono

AI-powered invoice ingestion, extraction, and reconciliation for accounts payable. Upload an invoice, get back structured, confidence-scored data, review/correct what the model wasn't sure about, and match it against your POs or bank statement.

This repo is the MVP described below: upload → extract → review → export → single-rule matching. It's built to extend cleanly toward the fuller architecture (email ingestion, accounting-software integrations, richer reconciliation) without a rewrite.

## MVP scope

1. Upload a PDF/image invoice → OCR → LLM structured extraction → confidence-scored JSON.
2. Review UI: side-by-side source document + editable extracted fields, low-confidence fields highlighted, approve/reject with a full audit trail.
3. Export approved (or all) invoices to CSV/Excel.
4. One matching rule: fuzzy vendor name + amount tolerance + date window against an uploaded PO or bank statement CSV.

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

**Ingestion layer** (`backend/app/storage.py`, `routers/ingestion.py`): accepts direct file upload today. Everything downstream depends only on "there's a normalized PDF/image on disk and an Invoice row" — so email-inbox and watched-folder/Drive ingestion (see Roadmap) are additive front-ends onto the same pipeline, not a redesign.

**Extraction layer** (`ocr.py`, `extraction.py`, `confidence.py`) — the core IP:
- OCR via Tesseract (`pytesseract` + `pdf2image`). Swapping in AWS Textract or Google Document AI's purpose-built invoice parser is a drop-in replacement behind `ocr.extract_text`.
- Structured extraction via Claude, using tool-use to force a fixed JSON schema (vendor, invoice #, dates, PO reference, totals, line items) with a self-reported confidence per field.
- If `ANTHROPIC_API_KEY` isn't set, a heuristic regex extractor takes over so the full pipeline (ingest → extract → review → export → match) still runs end-to-end for demos, tests, and CI. Heuristic fields get a flat, low confidence score, which naturally routes them into the review queue instead of silently shipping bad data.
- Confidence scoring combines per-field confidence with an automatic cross-check (do line items sum to the total, or subtotal + tax = total?). A failed cross-check pulls overall confidence down independent of what the model claimed.

**Matching/reconciliation engine** (`matching.py`, `routers/matching.py`): fuzzy vendor-name matching (`rapidfuzz`) plus configurable amount tolerance (% and absolute) and a date window, with an exact PO/reference-number match as a strong signal. Produces `matched` / `partial` / `unmatched` with a human-readable reasoning string for every decision — this is the part of the system closest to a constraint-matching problem.

**Data layer** (`models.py`): Postgres in production (SQLite by default for local dev — no separate DB server needed to try it out) via SQLAlchemy. Every extraction, human correction, approval/rejection, and match decision writes an `AuditLog` row — the audit trail that finance/compliance conversations will ask about.

**Output/integration layer** (`routers/export.py`): CSV/Excel export today. QuickBooks/Xero/NetSuite push integrations are additive on top of the same Invoice/MatchResult data (see Roadmap).

**Review UI** (`backend/static/`): a small vanilla-JS single-page app (no build step) — Upload / Review Queue / Matching / Export tabs. The review queue shows the source document next to editable extracted fields, with low-confidence fields visually flagged; corrections are saved via `PATCH /api/invoices/{id}` and logged to the audit trail.

## Running locally

Requires Python 3.11+, and the Tesseract + Poppler system binaries for OCR:

```bash
# macOS
brew install tesseract poppler
# Debian/Ubuntu
sudo apt-get install tesseract-ocr poppler-utils
```

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # set ANTHROPIC_API_KEY to enable LLM extraction (optional)

cd backend
uvicorn app.main:app --reload
```

Open http://localhost:8000 for the review UI. Without `ANTHROPIC_API_KEY` set, extraction falls back to the heuristic extractor, so you can exercise the whole pipeline immediately.

Try it with the bundled sample data in `sample_data/`: upload `sample_invoice.pdf` on the Upload tab, then upload `sample_po.csv` (as Purchase Orders) and `sample_bank.csv` (as Bank Statement) on the Matching tab and click "Run Matching". Regenerate the sample PDF with `python sample_data/generate_sample_invoice.py` (needs `pip install reportlab`, not a runtime dependency).

### Docker

```bash
docker compose up --build
```

Runs the app against Postgres instead of SQLite. Set `ANTHROPIC_API_KEY` in your shell environment before `docker compose up` to enable LLM extraction.

### Tests

```bash
cd backend
pytest
```

Covers the confidence cross-check logic, the fuzzy matching engine, the heuristic extraction fallback, and the core API endpoints (upload validation, matching upload/run, corrections + audit log, approval, export) — all without requiring Tesseract, Poppler, or an Anthropic API key, so they run in plain CI.

## API surface

| Endpoint | Purpose |
|---|---|
| `POST /api/invoices/upload` | Upload a PDF/image; queues extraction |
| `GET /api/invoices` | List invoices, optional `?status=` filter |
| `GET /api/invoices/{id}` | Full invoice detail incl. line items, confidence, match results |
| `GET /api/invoices/{id}/file` | Serve the original document (for preview) |
| `PATCH /api/invoices/{id}` | Human corrections; writes an audit log entry |
| `POST /api/invoices/{id}/approve` \| `/reject` | Review decision |
| `GET /api/invoices/{id}/audit-log` | Full audit trail for one invoice |
| `POST /api/matching/sources?source_type=po\|bank` | Upload a PO or bank statement CSV |
| `POST /api/matching/run` | Run the matching engine over all extracted invoices |
| `GET /api/matching/results` | All match results (newest first) |
| `GET /api/export/csv` \| `/api/export/xlsx` | Export all invoices with status + latest match result |

## Configuration

See `.env.example`. Notable knobs: `REVIEW_CONFIDENCE_THRESHOLD` (below this, an invoice is flagged `needs_review` instead of fast-tracked as `extracted`), and `MATCH_AMOUNT_TOLERANCE_PCT` / `MATCH_AMOUNT_TOLERANCE_ABS` / `MATCH_DATE_WINDOW_DAYS` / `MATCH_VENDOR_SCORE_THRESHOLD` for the matching engine.

## Roadmap (beyond this MVP)

Deliberately not built yet, to keep the MVP demoable and honest about what's real:

- **Email ingestion** (forward invoices to a dedicated address) and **watched folder/Drive integration** — additive front-ends onto `storage.save_upload` + the existing job queue.
- **Production job queue**: swap the in-process `queue.Queue` worker (`app/jobs.py`) for Celery/RQ or SQS once throughput needs it. The `enqueue()` call site is the only integration point.
- **Cloud OCR**: swap Tesseract for AWS Textract or Google Document AI behind `ocr.extract_text` for better accuracy on messy scans.
- **Accounting software integrations**: push approved invoices to QuickBooks/Xero/NetSuite via API/webhook — this is what makes it sellable rather than a CSV toy, and the natural next step once export is validated with a design partner.
- **Dashboard**: exceptions queue, reconciliation status, aging report, once there's enough volume for those views to matter.
- **Vertical-specific extraction schemas and matching rules** once there's a design partner in a specific industry (property management, trucking, medical billing, etc.) — the generic schema here is the horizontal starting point.
- **Prompt/rule feedback loop**: corrections made in the review UI are already captured as structured `human_correction` audit log entries; using that history to auto-tune the confidence threshold or few-shot the extraction prompt is future work.
- **Compliance**: audit logging exists from day one; formal data retention policy and SOC 2 groundwork come with the first real customer conversations.
