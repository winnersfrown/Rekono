# Changelog

Versions are numbered `1.0`, `1.1`, `1.2`, … in order. Each release is one
merged change, and its commit subject carries the number (`v1.1: ...`), so
`git log --oneline` reads as the release history without needing tags.

## v1.0

The first numbered version. Everything below already existed at the point
numbering started -- it's recorded here as the baseline the later entries
build on, not as work done for this release.

**Document pipeline.** Upload a PDF or image; Tesseract/Poppler lift the
text, a language model parses it into a fixed schema, and per-field
confidence plus a cross-check on the arithmetic decides whether it can be
auto-approved or needs a human. Falls back to a heuristic regex extractor
when no model key is configured, so the pipeline runs end to end without
one. Five document types on the same shape: invoices, expense receipts,
vendor documents, leases, and tax documents.

**Review and correction.** A reviewer sees the extracted fields beside the
source document, corrects what's wrong, and approves or rejects. Every
extraction, correction, approval and match decision writes an audit row. A
corrected vendor name is remembered and auto-applied next time the same raw
text comes in.

**Matching.** Fuzzy vendor matching with configurable amount tolerance and a
date window, plus exact PO/reference matching as a strong signal. Uploading
goods receipts switches it from two-way to three-way automatically, which
answers the question AP actually has before paying: was this ordered, did it
arrive, and does the bill agree with both.

**Multi-tenancy.** Every table that holds customer data carries an `orgId`,
every route scopes to the caller's org, and Postgres row-level security
enforces the same boundary underneath the application code, so a query that
forgets its scope returns nothing rather than another tenant's rows.

**Accounts and billing.** Email/password and Google sign-in, team invites
with per-plan seat caps, onboarding, Stripe-backed plans with a trial, and
per-plan monthly document caps.

**Integrations and export.** QuickBooks Online (OAuth connect, Bill push,
bank-transaction reconciliation) with tokens encrypted at rest; CSV and
Excel export with formula-injection neutralized.

**Hardening.** Rate limiting per account and per IP, re-authentication on
destructive actions, a fixed CORS allowlist, CSP and the standard security
headers, upload content-type derived from an extension allowlist rather than
the client's claim, and an error handler that never echoes internals.

**Surfaces.** The review UI (vanilla JS, no build step, served by Express)
and the marketing site (React + Vite + Tailwind, built into the repo root
for GitHub Pages).
