# Changelog

Versions are numbered `1.0`, `1.1`, `1.2`, … in order. Each release is one
merged change, and its commit subject carries the number (`v1.1: ...`), so
`git log --oneline` reads as the release history without needing tags.

## v1.18

Added a global "slow network" loading indicator -- a thin bar at the top
of the page that appears whenever a request is genuinely taking a while,
so a click on bad wifi reads as "working on it" instead of "did that
register at all?"

Deliberately not a spinner on every click regardless of speed: the bar
only appears once a request has been in flight for 250ms, so a normal
connection never sees it (auth endpoints are an expected exception --
bcrypt's deliberate cost means even signup/login on a fast connection
takes a couple hundred ms, and the bar reflects that honestly rather than
special-casing it away). It creeps toward 80% width over a few seconds
while waiting, then jumps to 100% and fades out the moment the response
actually lands, rather than sitting frozen at some arbitrary point.

Implemented by wrapping `window.fetch` itself once in `auth.js`, not by
touching `apiFetch` or any individual button handler -- this covers every
request in the app uniformly, including the pre-login screens' direct
`fetch()` calls (sign in, create account, password reset) that run before
`apiFetch`'s bearer-token wrapping even applies, with no per-call-site
plumbing to add or forget on the next feature.

Verified live in a browser rather than with a new Jest suite: this
codebase's frontend (`backend/public/`) has never had jsdom test
coverage, and introducing one just for a single small feature would be
more infrastructure than the feature warrants. Confirmed instead that a
normal-speed request never shows the bar, an artificially delayed one
(simulating bad wifi) does, and it correctly resets to hidden once the
response lands.

## v1.17

Added an optional AWS S3 + SQS backend, so this app can run on more than
one instance -- came out of a conversation about whether to move off
Render onto AWS Lambda for scale; Lambda would need a real rewrite (the
in-process job queue and local-disk storage don't translate), but the
actual blocker at any scale is narrower than that: local disk storage and
the in-process job queue both silently assume exactly one running
instance, which breaks the moment a second one is added purely for
request capacity. This closes that gap without changing the deployment
model at all.

- **`AWS_S3_BUCKET`** switches document storage (the 5 OCR/LLM pipelines)
  from local disk to S3. `storage.js` dispatches every operation --
  save, serve, delete, and the temp-file download OCR needs to shell out
  to pdftoppm/tesseract against -- on the *shape* of a record's
  `storagePath` (a plain path vs. an `s3://` string), not on whether S3 is
  currently configured, so demoSeed.js's always-local sample files keep
  working unmodified either way, and a record written under one mode
  still resolves correctly if the deployment's mode changes later. A
  document is always streamed through this server when served back, never
  redirected to a presigned URL -- the bearer token that authorized the
  request is the only thing that should ever prove access to it.
- **`AWS_SQS_QUEUE_URL`** switches the background job queue (`jobs.js`)
  from an in-memory array to SQS, which every instance polls -- the actual
  fix for "instance B never processes a job instance A queued." SQS's own
  visibility timeout replaces the local queue's boot-time orphaned-job
  recovery: a message that's received but never deleted (its instance
  crashed mid-job) simply becomes receivable again once the timeout
  expires, so `recoverOrphanedJobs` is skipped entirely in SQS mode rather
  than risking a duplicate enqueue of a message that's just waiting out
  its timeout.
- Both independent, both off by default -- unset, everything behaves
  exactly as it always has. Credentials come from the AWS SDK's own
  standard chain, not a Rekono-specific setting.
- As a side effect, `AWS_S3_BUCKET` alone also fixes Render's free-tier
  ephemeral-disk problem (uploaded files lost on every restart/redeploy)
  even on a single instance -- see render.yaml.

Tested down to the configured/unconfigured branch via a mocked S3/SQS
client (`tests/storage.test.js`, `tests/sqsQueue.test.js`), same pattern
as this app's Stripe/Google/QuickBooks coverage; not against a live AWS
account. See README.md's new "Scaling past one instance" section.

## v1.16

Added a staff-only cross-org usage dashboard -- the "Rekono operator" view
deliberately left out of the last three analytics releases (v1.13-v1.15,
all customer-facing) because it needed something new and security-relevant:
a request that intentionally opts out of the per-org row-level security
this app has otherwise built and tested throughout.

- **`STAFF_EMAILS`** (comma-separated, case-insensitive): an email
  allowlist rather than a database column, since no signup flow should
  ever be able to grant this, and a config value only whoever holds the
  deployment's env vars can change is a much smaller blast radius than a
  boolean a bug could flip on a row. Empty by default -- fail-closed,
  nobody (not even the first org's owner) can reach staff routes until
  this is explicitly configured, matching every other optional integration
  in `config.js`.
- **`requireStaff`** (`auth.js`): a separate middleware from the
  customer-facing `requireAuth`, not a flag added to it -- two small,
  distinctly-named functions make "does this route see one org or every
  org" a property of which one a route imports, visible at the call site,
  rather than a boolean that could default wrong. The key difference: it
  never calls `setOrgContext`, so the request stays in the system context
  `rlsRequestContext` already starts every request in, and plain
  unscoped queries genuinely see every tenant.
- **`GET /api/staff/overview`** (`routes/staff.js`): aggregate-only --
  org/plan counts, a 13-week signup trend, an activation funnel (signed
  up -> onboarded -> uploaded a real document -> approved one), document
  volume, and subscription health. Never a way to read any single
  customer's actual documents, vendor names, or dollar amounts -- that's a
  much bigger exposure than "how is the product doing" calls for. Demo
  orgs and seeded sample invoices (v1.11) are excluded from every figure.
  Each call logs a `staff_metrics_viewed` `AuditLog` entry against the
  staff member's own org, since there's no cross-org-shaped audit target
  to log it against instead.
- A "Staff" nav tab in the app shell, shown only when `/api/auth/me`'s new
  `is_staff` field is true -- UX only, since the server-side gate above is
  what actually matters.

Tests specifically prove the isolation properties that make this safe: 401
(not logged in) vs. 403 (logged in, not staff) are distinct; a staff user
genuinely sees multiple different orgs' data in one response; an ordinary
per-org request immediately after a staff request still can't see across
tenants (no context leakage between requests); demo orgs are excluded; and
the empty-`STAFF_EMAILS` default really does lock everyone out.

## v1.15

Added richer business KPIs to the dashboard's Trends panel, the last of
the three analytics improvements from this run (v1.13's marketing GA4,
v1.14's per-org team activity, now the org's own numbers):

- **13-week trend charts** for touchless rate and average confidence --
  the main dashboard's touchless/confidence figures are single snapshots,
  so there was no way to see whether automation quality is improving or
  slipping over time. Weekly, not daily: a single day's rate is noise at
  typical SMB volume.
- **Top vendors by approved spend, all-time** -- every existing KPI is a
  single rolled-up number; this is the AP-team question ("who are we
  actually paying the most") none of them answer.
- **Month-over-month tiles** for approved value, documents processed, and
  touchless rate -- this month to date vs. the same number of days into
  last month (not all of last month), so an early-month comparison
  doesn't read as a slump every time regardless of actual pace. Limited
  to flow metrics (things that happened in a window); outstanding AP is
  deliberately excluded since it's a snapshot with no clean "as of a
  month ago" value without reconstructing history the app doesn't record.

New `GET /api/dashboard/trends` endpoint, separate from the main
`/api/dashboard` -- a trends view is heavier (three weeks-long queries)
and not something every dashboard load needs to pay for.

Caught one bug writing the tests: Sequelize force-touches `updatedAt` to
"now" on every `create()`/`save()` regardless of what's passed, unless
`{ silent: true }` is set -- the month-over-month tests need control over
which month an invoice landed in, and without `silent` every "last
month" fixture was silently landing in the current month instead.

## v1.14

Added a per-org "Activity" panel to the Team tab (owner-only), breaking
down each teammate's uploads/approvals/rejections/corrections over the
last 30 days from existing AuditLog data -- distinct from the marketing
site analytics in v1.13, which is about whether Rekono itself is getting
traction, not how a specific customer's team uses it day to day. Every
current member shows up even at all-zero, since who *isn't* using it is
at least as useful to an owner as who is. Deliberately excludes
account-management actions (password changes, team invites, ...) and
anything with no human userId attached (auto-approvals) -- this counts
work on documents, not account housekeeping.

A platform-wide, cross-org usage view for Rekono's own team was
considered and deliberately deferred: it would need a new staff/
superadmin concept that intentionally opts out of the row-level security
this app has already built and tested against tenant isolation, which is
a big enough decision to warrant its own dedicated conversation rather
than folding it into this change.

## v1.13

Wired up marketing site analytics (previously off with no account at all).
`website/src/lib/analytics.js` adds GA4 -- genuinely free with no trial or
usage cap, unlike Plausible's hosted option, and self-hosting an
open-source alternative isn't realistic for a static site with no server.
It's a no-op until `VITE_GA_MEASUREMENT_ID` is set at build time (Vercel
env vars), matching the "missing config degrades gracefully" pattern every
other optional integration in this app already follows.

Once configured it tracks more than pageviews: every "Get started"/"Sign
in"/demo link across Nav, Hero, Pricing, FinalCTA, and MobileStickyCTA
fires a `cta_click` event naming where it was clicked, and a successful
contact-form submission fires GA4's recommended `generate_lead` event --
the actual conversion signal, not just a click. Initial config sets
`transport_type: "beacon"` so those click events survive the tab
navigating away immediately after, which is what every one of these CTAs
does by design.

## v1.12

Added optional TOTP-based two-factor authentication. Settings has a new
"Two-factor authentication" panel: Enable generates a secret and a QR code
(otplib + qrcode, both free/open-source), confirming a code from it turns
2FA on and hands back 8 single-use backup codes (shown once, like an API
key). Login for an account with 2FA on becomes two steps -- password (or
Google) succeeds, then a short-lived pending token exchanges for the real
access token once a TOTP or backup code verifies (POST /api/auth/2fa/verify).
Disabling 2FA and regenerating backup codes are gated behind the existing
password re-auth check (auth.js's requireReauth), same as disconnecting
QuickBooks or removing a team member.

Google sign-in also respects it: an account with 2FA enabled gets routed
through the same pending-token verification after a Google login succeeds,
rather than 2FA being a promise the app doesn't keep for anyone who's also
linked Google.

User.totpSecret is encrypted at rest (secretBox.js, the same mechanism
already protecting QuickBooks OAuth tokens) and backup codes are stored as
SHA-256 hashes, never plaintext. Caught one real bug while writing tests:
otplib's verify() throws (rather than returning invalid) for anything that
isn't 6 digits, which is exactly what a backup code is -- fixed in
twoFactor.js so submitting one doesn't 500 instead of falling through to
the backup-code check.

## v1.11

Seeds one realistic sample invoice into a brand-new org's Review Queue as
soon as onboarding completes (free plan, or a paid plan once checkout
confirms), so a first login has something to actually review instead of
relying only on the empty-state prompt from v1.10. It's marked
`needs_review` with a below-threshold confidence score, matching the
product's own pitch of an imperfect extraction getting caught before it
hits the books, and shows a "Sample" badge plus an explanatory banner in
the detail pane.

The sample must never look like real financial activity: `Invoice` gets an
`isSampleData` column and a `defaultScope` that excludes it everywhere
except the Review Queue's own routes (which opt back in via a `withSamples`
scope) -- dashboard KPIs, CSV/Excel exports, the AP/bank matching engine,
QuickBooks sync, the AI assistant's context, and the monthly document quota
all continue to see only real data, with no per-callsite changes needed
anywhere else. Seeding itself reuses demoSeed.js's `seedInvoice` (now
exported) rather than duplicating the synthetic-PDF-plus-audit-log logic
that already exists for the investor demo.

`tests/testUtils.js`'s shared `signup()` helper strips the sample back out
after onboarding, since dozens of other test files use it for "a normal
working account" and assert exact invoice counts of their own fixtures --
tests that want to verify the seeding itself drive `/api/onboarding`
directly instead, same as the existing onboarding tests already did.

## v1.10

Gave the invoice Review Queue a real empty state for brand-new orgs.
It was previously the thinnest of the five document-type queues: a bare
"No invoices." table cell and a generic "Select an invoice..." detail
pane, with no indication of what to do next -- landing there right after
signup looked broken rather than empty. Now a genuinely-empty org (no
invoices ever uploaded, not just a filter matching zero) gets an
"Upload your first invoice" prompt in both the table and the detail
pane, matching the pattern the dashboard's own empty state already used.
A filter or search that happens to match nothing still shows a plain
"No invoices match this filter." instead, so the CTA doesn't mislead
someone who already has invoices.

## v1.9

Added Vercel Speed Insights to the marketing site (`@vercel/speed-insights`,
mounted in `src/main.jsx`) now that it's deployed on Vercel, to get
real-user performance data on the now-client-rendered React page.

## v1.8

Moved the marketing site's deployment from GitHub Pages to Vercel.
GitHub Pages required building straight into the repo root with fixed
(non-hashed) filenames and `emptyOutDir: false`, since it served the repo
as-is with no build step -- all workarounds Vercel doesn't need, since it
builds `website/` in its own CI on every push and serves the output
itself. `vite.config.js` now builds to a normal disposable `dist/`
(gitignored) with Vite's default content-hashed filenames, and the
`/Rekono/` base path is gone since Vercel serves from its domain root.
`robots.txt`, `sitemap.xml`, and `404.html` moved from the repo root into
`website/public/` so Vite copies them into the build output; the old
committed build output at the repo root (`index.html`, `assets/`, the
favicon/icon files) is removed since it's no longer how the site is
served. `website/README.md`'s deploy section is rewritten to match.

The stale `winnersfrown.github.io` references in `robots.txt`,
`sitemap.xml`, and `website/index.html`'s canonical/Open Graph tags are
left as `TODO`s pending the real `*.vercel.app` domain, which Vercel
assigns on project creation -- a manual dashboard step, not something
scriptable from here.

## v1.7

Corrected README's row-level-security section: it claimed Neon "hand[s]
out ordinary roles by default," which is wrong, and cost a live outage to
find out. Every role Neon's Console, API, or CLI creates -- including a
project's own default role and anything added through the dashboard's
Roles page -- is automatically a `neon_superuser` member, which carries
`BYPASSRLS`. That membership can't be revoked afterward: `ALTER ROLE ...
NOBYPASSRLS` fails with `permission denied` no matter which role runs it,
including the project owner. `REASSIGN OWNED` and `DROP ROLE` hit the
same wall for the same reason (both require membership Neon's owner role
doesn't actually have over independently-created roles).

The only way to get a role Postgres will actually enforce RLS against on
Neon is creating it with plain SQL instead of the UI/API -- that path
skips the `neon_superuser` grant entirely. README now documents the exact
sequence: `CREATE ROLE` by SQL, `GRANT rekono_app TO neondb_owner` (needed
before `AUTHORIZATION rekono_app` can act as it), a fresh `public` schema
owned by the new role from creation (sidesteps per-table GRANT fights
against tables `neondb_owner` already owns), and `ALTER ROLE ... SET
search_path = public` (without it, table creation fails with "no schema
has been selected to create in" even though the schema exists and the
role owns it -- a role's default search_path isn't tied to what it owns).

No code changed -- this is corrected operational documentation for a
deployment step, discovered the hard way while bringing the app back
after the v1.6 Render migration.

## v1.6

Render suspended the whole account (unrelated to v1.5's fix -- happened
before it, likely an automated response to the same Safe Browsing flag).
Recovering it meant a new Render account, which meant a new service name
and a new onrender.com URL: rekono-couj.onrender.com, replacing
rekono-ai-new.onrender.com everywhere it was hardcoded --
website/src/lib/constants.js's APP_URL, config.js's ALLOWED_ORIGINS
default, a CORS test's expected origin, and the Lovable integration doc.
Rebuilt the marketing site bundle so the new URL actually ships in
assets/index.js, not just the source. Left the old URL untouched in this
changelog's own v1.5 entry -- that's a historical record of what was true
then, not a live reference to update.

## v1.5

Google Search Console flagged the live app (rekono-ai-new.onrender.com,
not the marketing site) as a "Deceptive pages" site -- Chrome would show
visitors a red warning. `Sample URLs: N/A`, so nothing to inspect directly;
had to reason out the actual cause from the code.

Ruled out first: no third-party/ad scripts, no `eval`, no redirects, no
phishing-style copy anywhere in the built site. The one meta tag that
looked suspicious on sight (`strix-verification`) turned out to be
legitimate and already explained by an earlier commit in this repo's own
history (#53) -- domain verification for a security-scanning tool, not
evidence of compromise.

The real cause: self-serve signup lets anyone set an organization's name to
literally anything (`org_name: z.string().min(1).max(256)`, no other
constraint), and that name rendered verbatim -- `You've been invited to
join ${org_name} on Rekono.` -- on the invite-accept page, which is
reachable with **no account**, by design, so an invitee can see the invite
before creating one. That's a free-text billboard on a legitimate domain,
sitting directly above a form asking for a name and password. Sign up once,
rename the org to something that reads like an urgent account-suspension
notice, generate one invite link, and the resulting URL is a phishing page
hosted on Rekono's own domain -- exactly what this flag describes, and
exactly the kind of thing that stops being reproducible (hence `Sample
URLs: N/A`) once the attacker's free trial or the invite token expires.

Fixed on two layers, since neither alone is sufficient:

- **Content**: `orgName.js`'s `orgNameSchema` rejects a name that's itself
  a URL (`http(s)://`, `www.`, or a bare `name.tld`), applied at both
  signup and org rename. Cheap, zero false-positive risk, closes the most
  mechanical version of the attack -- but a blocklist can't catch every
  phishing phrase, so it's not the real fix by itself.
- **Structure** (the actual fix): the invite-accept page no longer weaves
  the org name into a first-party-sounding sentence. It's quoted, under a
  fixed "Team invite" heading and a permanent disclaimer -- "Rekono doesn't
  verify organization names. If this doesn't look right, don't enter your
  password below." -- placed directly above the password field. This holds
  regardless of what the org name says, which a content filter alone never
  can.

Also: the whole app shell (`backend/public/index.html`) now sends
`noindex, nofollow`. It's an authenticated app shell that happens to also
serve the invite/reset panels, not marketing content -- there's no reason
for a crafted invite URL to be organically discoverable via search on top
of everything above.

Verified live, not just by reading the diff: signed up, created a real
invite, hit the actual invite-accept page with a real token, and confirmed
the org name renders quoted inside the new framing with the disclaimer
directly above the password field (screenshot taken via Playwright against
the running app). `tests/orgName.test.js` covers the schema directly plus
both real routes that accept an org name (signup, org rename) rejecting a
URL. Full suite: 634 passing, 0 failing (up from 624).

One earlier claim in this investigation turned out to be wrong and is
recorded here rather than quietly dropped: a missing `.nojekyll` file was
flagged as letting GitHub Pages serve the entire repo (source code
included) publicly. That's incorrect -- Jekyll's default processing only
excludes dotfiles/dotdirs, not regular directories like `backend/`, so
`.nojekyll` wouldn't have changed what's exposed either way. Not
implemented; whether the marketing-site repo being public already covers
this is a separate question for the user's own judgment call.

## v1.4

The marketing site read too small and too sparse -- both had a specific,
fixable cause rather than being a matter of taste.

**Too small:** `html`/`body` set `font-size: 15px`, 6% under the browser
default. Every rem-based size on the page -- headings, body text, buttons,
badges -- inherited that shrink uniformly. Back to 16px.

**Too sparse:** every major section (`HowItWorks`, `Features`, `Pricing`,
`FAQ`, `FinalCTA`) used `py-24` (96px top and bottom), so two adjacent
sections stacked to nearly 200px of pure whitespace between them -- visible
in a screenshot as a gap roughly as tall as the FAQ heading sitting above
it. Cut to `py-16` (`ProofStrip` to `py-10`, `Hero`'s asymmetric top/bottom
scaled down to match), which keeps each section legible as its own block
without the page reading like mostly blank space between five lines of
actual content.

Verified with real screenshots (Playwright against the production build, an
iPhone-width viewport matching the one in the report) at the hero and at
the pricing-to-FAQ boundary specifically, since that's where the gap was
most visible -- not just a visual guess that the numbers "should" look
better.

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
