# Changelog

Versions are numbered `1.0`, `1.1`, `1.2`, … in order. Each release is one
merged change, and its commit subject carries the number (`v1.1: ...`), so
`git log --oneline` reads as the release history without needing tags.

## v1.3

Adds `backend/scripts/check-llm.mjs`, a one-command preflight for whichever
LLM provider is configured. It calls `src/llm.js`'s `callTool` and
`generateText` directly -- the same code path extraction, categorization,
QuickBooks, and Ask Rekono all use -- so a pass here means those features
actually work, not just that a request shape looks right.

Exists because this sandbox can't verify that itself: `openrouter.ai` is
policy-blocked at the proxy level (`connect_rejected`, confirmed via the
proxy's own status endpoint), so v1.2 shipped with the wire format tested
against a stub and a local fake server, but no live call. This script is
what to run, with real credentials, wherever that block doesn't apply:

```
OPENROUTER_API_KEY=... OPENROUTER_MODEL=vendor/model-name node scripts/check-llm.mjs
```

Two checks: a forced tool call (adds two numbers via a `record_answer`
schema, so a pass also confirms the model gets simple arithmetic right
before it's trusted on invoice totals), then plain text. Failures are
specific rather than generic -- a model with no tool-calling support gets
told exactly that, since extraction, categorization, and both QuickBooks
suggestions all depend on it and silently fall back to the heuristic
extractor otherwise.

## v1.2

Any LLM call in the app -- extraction for all five document types, merchant
categorization, the two QuickBooks suggestions, and Ask Rekono -- can now run
on [OpenRouter](https://openrouter.ai) instead of Gemini. `llm.js` is the
only file that knows which provider is active; everything else asks it for a
forced tool call or for text.

Set `OPENROUTER_API_KEY` **and** `OPENROUTER_MODEL` to use it. There is no
default model on purpose: slugs are specific and change as models come and
go, so a key with no model is treated as unconfigured and logs why, rather
than guessing one and failing at the first real extraction. The chosen model
must support tool/function calling -- extraction forces a JSON schema
through a named function, which is what produces a confidence per field. A
model without it fails every extraction into the heuristic path, and says
so. With both providers configured OpenRouter wins; `LLM_PROVIDER=gemini`
overrides. With neither, the heuristic fallback behaves exactly as before.

Worth recording: the first pass converted three call sites, which was wrong.
There were nine, across six files -- the four non-invoice document
extractors and both QuickBooks suggestions also built their own Gemini
client. Converting only the three would have left invoices on OpenRouter
while receipts, leases, vendor documents and tax documents silently dropped
to the heuristic extractor, which reads as the model getting worse rather
than as a half-finished migration.

## v1.1

Started numbering releases, with v1.0 as the baseline. Adds this changelog
and `CLAUDE.md`, which records the convention so it survives the container
being rebuilt between sessions.

Annotated git tags would be the conventional way to mark these, but the git
proxy in the Claude Code sandbox rejects `refs/tags/*` pushes, so the number
lives in the commit subject and here instead.

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
