# Graph Report - Rekono  (2026-09-02)

## Corpus Check
- 65 files · ~424,653 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2247 nodes · 5535 edges · 165 communities (96 shown, 64 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 268 edges (avg confidence: 0.84)
- Token cost: 976,980 input · 0 output

## Community Hubs (Navigation)
- Frontend App Shell (app.js)
- Check API + Ledger Test Helpers
- Sequelize Data Models
- Express App Bootstrap
- Close Automation Suggestions
- Equity Awards (Stock Options)
- Marketing Site App Shell
- Frontend Formatting Helpers
- Ledger/AR/AP Changelog Arc
- Bank Models + RLS Bootstrap
- Graphify Watch/Ingest Tools
- Frontend Auth Client
- Accounts Payable Logic
- Frontend Doc-Review Actions
- Expenses Route + Corrections
- Plaid Bank Integration
- Frontend Close/Statements Loaders
- Equity Ledger Postings
- Account Taxonomy/Classification
- Accounts Receivable Logic
- Org Naming + Billing Plans
- Marketing Site Build Deps
- LLM Provider Preflight Check
- Bank Matching + Column Parsing
- Trial Balance + Plan Gating
- Auth Routes (Password/Google)
- Invoice Model + Charges Tests
- QuickBooks Integration
- Lease Approval Frontend
- Financial Statements Engine
- Transaction Categorization Frontend
- Tax Doc Extraction
- Auth/2FA Core Logic
- Confidence Scoring + Invoices Route
- Matching/Close Models
- Job Queue + RLS
- Design System References
- Fiscal Year + AP Tests
- Revenue Recognition Models
- Doc Pipeline Tabs Changelog Arc
- Rate Limiting + Assistant
- Config + Expense Pipeline
- Demo Seed Data
- Net Worth + Staff Dashboard Frontend
- Stock Compensation (ASC 718)
- Income Tax Provision
- Payroll Model + Logic
- Document Usage Limits
- Vendor Model + Routes
- Vendor Alias + Pipeline
- Graphify Extraction Spec Rules
- Core Accounting Tabs Changelog Arc
- Invoice Extraction
- Check Extraction
- Vendor Doc Extraction
- Vendor Expense Account Memory
- Lease Extraction
- Receipt Extraction
- CSV/Excel Export Builders
- Backend Runtime Dependencies
- Tax Docs Frontend Actions
- Payroll/Adjustments Tabs Changelog Arc
- Expenses Frontend Actions
- Plaid/Matching Tabs Changelog Arc
- Lease Confidence Scoring
- Staff Analytics Helpers
- Check Pipeline + Confidence
- Vendor Doc Confidence
- Revenue Recognition Tests
- Backend PWA Manifest
- Website PWA Manifest
- Backend package.json
- Plaid Frontend Section
- Onboarding/Auth Architecture Arc
- Early Releases Changelog Arc (v1.0-v1.16)
- Test Tooling Dependencies
- Settings Sub-Panels Frontend
- Chart of Accounts Nav Changelog Arc
- Tax Doc Confidence
- Three-Way Matching Engine
- OCR Extraction
- Payroll API Tests
- Equity/Cap Table Frontend Panels
- Checks/Backend Stack Arc
- Income Statement Tests
- Sub-Journals Tests
- Receipt Confidence
- Session-Start Hook Script
- npm Scripts
- Vendor Terms Changelog Arc
- Pipeline Architecture Concepts
- Infra/Docs Fixes Changelog Arc
- Graphify Multi-Repo Merge
- Graphify Setup Steps
- Sample Invoice Generator
- Deployment Infra Concepts
- Admin Tabs (Team/Staff/Palette)
- dotenv Dependency
- express Dependency
- fuzzball Dependency
- @google/genai Dependency
- jsonwebtoken Dependency
- multer Dependency
- otplib Dependency
- pg Dependency
- plaid Dependency
- qrcode Dependency
- resend Dependency
- stripe Dependency
- zod Dependency
- Apple Touch Icon (Both Sites)
- Legal Pages (Privacy/Terms)
- Postgres Test Setup Script
- Jest Setup File
- Review Queue Empty-State Changelog Pair
- AWS S3/SQS Reversal Changelog Pair
- Vercel Migration Changelog Pair
- Claude Config + Graphify Skill
- Project Scope Concepts
- Sample Invoice Test Data
- Security Policy
- OG Social Share Image (Website Root)
- Backend Favicon 16x16
- Backend Favicon 32x32
- Backend Favicon SVG
- Google Site Verification
- Backend PWA Icon 192
- Backend PWA Icon 512
- Account Ledger Drill-Down Modal
- Add Account Modal
- AR Aging Tab
- Customer Invoices Tab
- Customers Tab
- Merge Vendors Modal
- Revenue Recognition Tab
- Two-Factor Auth Changelog Entry
- Slow-Network Indicator Changelog Entry
- Marketing Font-Size Fix Changelog Entry
- LICENSE Fix Changelog Entry
- Standing PR Authorization Changelog Entry
- OpenSSF Scorecard Action Changelog Entry
- Scorecard Findings Changelog Entry
- Investor Demo Data Changelog Entry
- Graphify FalkorDB Export Step
- Graphify GraphML Export Step
- Graphify MCP Server Step
- Graphify Neo4j Export Step
- Graphify SVG Export Step
- Graphify Token Benchmark Step
- Dependabot Config
- CodeQL Workflow
- OpenSSF Scorecard Workflow
- Node/Express/Sequelize Stack Concept
- Marketing 404 Page
- Website Favicon 16x16
- Website Favicon 32x32
- Website Favicon SVG
- Website PWA Icon 192
- Website PWA Icon 512
- GA4 Analytics Changelog Entry

## God Nodes (most connected - your core abstractions)
1. `authHeader()` - 167 edges
2. `resetDb()` - 77 edges
3. `escapeHtml()` - 68 edges
4. `signup()` - 67 edges
5. `app` - 67 edges
6. `LedgerError` - 63 edges
7. `centsToDollars()` - 60 edges
8. `switchTab()` - 59 edges
9. `fmtMoney()` - 51 edges
10. `newId()` - 44 edges

## Surprising Connections (you probably didn't know these)
- `Editorial/Technical Aesthetic Direction` --semantically_similar_to--> `Anti-Slop Frontend Skill (design-taste-frontend)`  [INFERRED] [semantically similar]
  DESIGN.md → .claude/skills/taste-skill/SKILL.md
- `docker-compose.yml (Local Postgres Stack)` --semantically_similar_to--> `render.yaml (Render Blueprint)`  [INFERRED] [semantically similar]
  docker-compose.yml → render.yaml
- `Apple touch icon: minimalist document/report logomark (rounded-corner sheet with folded top-right corner, two horizontal text-line strokes, one navy one blue) used as the Rekono app icon` --semantically_similar_to--> `Website Apple Touch Icon (Document Logomark)`  [INFERRED] [semantically similar]
  backend/public/apple-touch-icon.png → website/public/apple-touch-icon.png
- `v1.44: Spelled-Out PO Label Fix` --conceptually_related_to--> `Extraction Layer`  [INFERRED]
  CHANGELOG.md → README.md
- `v1.50: Check Writing` --conceptually_related_to--> `Checks Pipeline`  [AMBIGUOUS]
  CHANGELOG.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Marketing Site Migration and Rebuild (Vercel + React + Analytics)** — changelog_v1_8, changelog_v1_13, website_readme, docs_references_10k_website_guide [INFERRED 0.75]
- **Graphify self-improving query feedback loop** — claude_skills_graphify_references_query_vocab_expansion, claude_skills_graphify_references_query_bfs_dfs_traversal, claude_skills_graphify_references_query_save_result, claude_skills_graphify_references_query_reflect_lessons [INFERRED 0.80]
- **playwright-cli plan/generate/heal test authoring lifecycle** — claude_skills_playwright_cli_references_test_generation_seed_test, claude_skills_playwright_cli_references_test_generation_plan_generate_heal, claude_skills_playwright_cli_references_playwright_tests_debug_cli, claude_skills_playwright_cli_references_session_management_attach [INFERRED 0.80]
- **Rekono General-Ledger Core Principles** — claude_accounting_conventions, changelog_v1_20, changelog_v1_21, changelog_v1_27 [INFERRED 0.80]
- **Atmospheric Gradient Mesh Backdrop Pattern** — claude_skills_design_references_design_md_stripe_design, claude_skills_design_references_design_md_vercel_design, claude_skills_design_references_design_md_slack_design [INFERRED 0.85]
- **Dark Canvas, No-Shadow Developer Brand Pattern** — claude_skills_design_references_design_md_linear_app_design, claude_skills_design_references_design_md_resend_design, claude_skills_design_references_design_md_revolut_design, claude_skills_design_references_design_md_sentry_design, claude_skills_design_references_design_md_vercel_design [INFERRED 0.85]
- **Polarity-Flipped Featured Pricing Tier Pattern** — claude_skills_design_references_design_md_stripe_design, claude_skills_design_references_design_md_revolut_design, claude_skills_design_references_design_md_notion_design, claude_skills_design_references_design_md_slack_design, claude_skills_design_references_design_md_wise_design, claude_skills_design_references_design_md_zapier_design, claude_skills_design_references_design_md_vercel_design, claude_skills_design_references_design_md_resend_design, claude_skills_design_references_design_md_superhuman_design, claude_skills_design_references_design_md_sentry_design [INFERRED 0.85]
- **Graphify full build pipeline (detect -> extract -> build/cluster -> label -> export)** — claude_skills_graphify_skill_step2_detect, claude_skills_graphify_skill_step3_extract, claude_skills_graphify_skill_step4_build_cluster, claude_skills_graphify_skill_step5_label, claude_skills_graphify_skill_step6_obsidian_html [INFERRED 0.85]
- **Shared Document Pipeline Pattern** — readme_review_ui, readme_expense_receipts, readme_vendor_documents, readme_leases, readme_tax_documents, readme_checks [EXTRACTED 0.90]
- **Chart of Accounts Evolution Across Releases** — readme_chart_of_accounts_ordering, changelog_v1_40, changelog_v1_48, changelog_v1_56 [EXTRACTED 0.85]
- **Workpaper Design Language Iterations** — readme_design, changelog_v1_36, changelog_v1_37, changelog_v1_41, changelog_v1_58 [EXTRACTED 0.85]
- **Equity and cap-table subsystem: stockholders' equity, share register, option pool, and stock compensation expense** — changelog_v1_29, changelog_v1_30, changelog_v1_31, changelog_v1_33 [INFERRED 0.85]
- **The accounting pivot: general ledger, financial statements, accounts receivable, bill payments, and revenue recognition** — changelog_v1_20, changelog_v1_21, changelog_v1_23, changelog_v1_24, changelog_v1_26 [INFERRED 0.85]
- **Analytics and usage-visibility releases: marketing GA4, per-org team activity, business KPI trends, and staff cross-org dashboard** — changelog_v1_13, changelog_v1_14, changelog_v1_15, changelog_v1_16 [EXTRACTED 1.00]
- **Admin-ish tabs: Team, Staff, Settings** — backend_public_index_team, backend_public_index_staff, backend_public_index_settings [INFERRED 0.75]
- **Ownership/equity ledger cluster: Equity, Cap Table, Stock Compensation** — backend_public_index_equity, backend_public_index_captable, backend_public_index_stockcompensation [INFERRED 0.75]
- **Transaction-recording modals sharing the confirm-modal-card + line-item-form pattern** — backend_public_index_paymentmodal, backend_public_index_writecheckmodal, backend_public_index_exercisemodal, backend_public_index_mergemodal [INFERRED 0.65]

## Communities (165 total, 64 thin omitted)

### Community 0 - "Frontend App Shell (app.js)"
Cohesion: 0.03
Nodes (93): ACCOUNT_TYPE_LABELS, accountOptionsFilteredHtml(), accountOptionsHtml(), accountSubtypesByType, addCustomerInvoiceLineRow(), addJournalEntryLineRow(), addRecurringLineRow(), AGING_BUCKET_KEYS (+85 more)

### Community 1 - "Check API + Ledger Test Helpers"
Cohesion: 0.05
Nodes (63): EquityTransaction, accountId(), makeApprovedInvoice(), orgId(), trialBalance(), accountId(), makeAccount(), postExpense() (+55 more)

### Community 2 - "Sequelize Data Models"
Cohesion: 0.06
Nodes (26): CHECK_STATUSES, CUSTOMER_INVOICE_STATUSES, EQUITY_TRANSACTION_TYPES, EXPENSE_RECEIPT_STATUSES, DEPRECIATION_METHODS, newId(), INVOICE_STATUSES, JOURNAL_ENTRY_SOURCES (+18 more)

### Community 3 - "Express App Bootstrap"
Cohesion: 0.07
Nodes (20): app, CONTENT_SECURITY_POLICY, __dirname, EXPENSIVE_PATHS, handleUnexpectedError(), publicDir, whenIdle(), Organization (+12 more)

### Community 4 - "Close Automation Suggestions"
Cohesion: 0.06
Nodes (50): median(), monthBounds(), monthlyActivity(), NON_DEPRECIABLE_ASSET_SUBTYPES, previousMonth(), suggestDepreciation(), suggestionsFor(), suggestMissingExpenses() (+42 more)

### Community 5 - "Equity Awards (Stock Options)"
Cohesion: 0.07
Nodes (54): awardsWithEvents(), cancelAward(), computeFullyDiluted(), computePlanStatus(), exerciseAward(), loadAward(), loadPlan(), monthsElapsed() (+46 more)

### Community 6 - "Marketing Site App Shell"
Cohesion: 0.08
Nodes (35): App(), ContactModal(), handleSubmit(), FAQ(), ITEMS, Features(), GROUPS, FinalCTA() (+27 more)

### Community 7 - "Frontend Formatting Helpers"
Cohesion: 0.07
Nodes (53): accountDrillButton(), amountInWords(), ciDepositAccounts(), classifyCashPaymentLines(), classifyPurchasesLines(), escapeHtml(), fmtMoney(), holderOptions() (+45 more)

### Community 8 - "Ledger/AR/AP Changelog Arc"
Cohesion: 0.05
Nodes (52): v1.20: Double-entry general ledger -- chart of accounts, journal entries, trial balance, v1.21: Financial statements (P&L, balance sheet, cash flow) derived from the general ledger, v1.22: Fiscal year, split retained/current-year earnings on the balance sheet, and period locking, v1.23: Accounts receivable -- customers, customer invoices, payments, and AR aging, v1.24: Bill payments and AP aging, relieving Accounts Payable, v1.25: Vendors as a real table with merge and alias, replacing name-normalization grouping, v1.26: Revenue recognition (ASC 606) with deferred revenue and straight-line-over-days schedules, v1.27: Adjusting entries (recurring templates) and year-end closing entries (+44 more)

### Community 9 - "Bank Models + RLS Bootstrap"
Cohesion: 0.06
Nodes (23): queueDepth(), BankAccount, BankConnection, ExpenseReceipt, BENIGN_SYNC_RACE_CODES, enableRowLevelSecurity(), initDb(), syncSchema() (+15 more)

### Community 10 - "Graphify Watch/Ingest Tools"
Cohesion: 0.06
Nodes (44): Watch debounce (default 3s), /graphify add <url>, --watch folder watcher, graphify claude install (CLAUDE.md integration), graphify hook install (post-commit hook), BFS/DFS graph traversal, /graphify explain, /graphify path (+36 more)

### Community 11 - "Frontend Auth Client"
Cohesion: 0.08
Nodes (39): apiCache, apiFetch(), authError(), authSuccess(), beginNetworkRequest(), bootstrapApp(), checkoutParam, clearToken() (+31 more)

### Community 12 - "Accounts Payable Logic"
Cohesion: 0.10
Nodes (33): addDaysIso(), AGING_BUCKETS, amountPaidCents(), computeApAging(), daysBetween(), earlyPayDiscount(), ensurePurchasesDiscountAccount(), invoiceTotalCents() (+25 more)

### Community 13 - "Frontend Doc-Review Actions"
Cohesion: 0.12
Nodes (38): alertDialog(), approveInvoice(), checkFieldConf(), confirmDialog(), deleteCheck(), deleteInvoice(), deleteLease(), deleteVendorDoc() (+30 more)

### Community 14 - "Expenses Route + Corrections"
Cohesion: 0.07
Nodes (26): TAX_DOCUMENT_TYPES, correctionSchema, FIELD_TO_ATTR, router, SORTABLE_FIELDS, router, correctionSchema, FIELD_TO_ATTR (+18 more)

### Community 15 - "Plaid Bank Integration"
Cohesion: 0.09
Nodes (22): EXPENSE_CATEGORIES, createLinkToken(), exchangePublicToken(), fetchAccountsForItem(), fetchInstitutionName(), fetchTransactions(), plaidConfigured(), plaidErrorDetail() (+14 more)

### Community 16 - "Frontend Close/Statements Loaders"
Cohesion: 0.08
Nodes (35): closeStatus(), defaultStatementPeriod(), deleteCloseTask(), greetingForHour(), loadApAging(), loadArAging(), loadBalanceSheet(), loadCashFlow() (+27 more)

### Community 17 - "Equity Ledger Postings"
Cohesion: 0.10
Nodes (31): voidCustomerInvoiceEntry(), accountBalanceCents(), buildLines(), DIVIDENDS_PAYABLE_SUBTYPE, ensureAccount(), EQUITY_SUBTYPES, JOURNAL_SOURCE_BY_TYPE, MEMO_BY_TYPE (+23 more)

### Community 18 - "Account Taxonomy/Classification"
Cohesion: 0.09
Nodes (26): PURCHASES_DISCOUNT_SUBTYPE, ACCOUNT_SUBTYPES, CLASSIFICATION_BY_TYPE_AND_VALUE, CLASSIFICATIONS, LABEL_BY_TYPE_AND_VALUE, INCOME_TAX_EXPENSE_SUBTYPE, INCOME_TAXES_PAYABLE_SUBTYPE, accountSortRank() (+18 more)

### Community 19 - "Accounts Receivable Logic"
Cohesion: 0.12
Nodes (26): addDays(), AGING_BUCKETS, amountPaidCents(), computeArAging(), daysBetween(), findSystemAccount(), nextInvoiceNumber(), postCustomerInvoice() (+18 more)

### Community 20 - "Org Naming + Billing Plans"
Cohesion: 0.11
Nodes (21): formatInvoiceDoc(), seedInvoice(), orgNameSchema, billingCycleAmountUsd(), isValidPlanId(), PAID_PLAN_IDS, PLANS, priceUsd() (+13 more)

### Community 21 - "Marketing Site Build Deps"
Cohesion: 0.07
Nodes (29): autoprefixer, framer-motion, postcss, react, react-dom, @vercel/speed-insights, vite, @vitejs/plugin-react (+21 more)

### Community 22 - "LLM Provider Preflight Check"
Cohesion: 0.12
Nodes (20): provider, TEST_TOOL, warning, callTool(), chatCompletionsUrl(), EmptyLlmResponseError, geminiClient(), geminiReady() (+12 more)

### Community 23 - "Bank Matching + Column Parsing"
Cohesion: 0.09
Nodes (21): accountClassification(), subtypeLabel(), VENDOR_DOCUMENT_TYPES, COLUMN_ALIASES, router, correctionSchema, FIELD_TO_ATTR, router (+13 more)

### Community 24 - "Trial Balance + Plan Gating"
Cohesion: 0.08
Nodes (18): computeTrialBalance(), DismissedBankTransaction, requireActivePlan(), router, confirmBankMatchSchema, defaultAccountSchema, expenseAccountSchema, pendingConnections (+10 more)

### Community 25 - "Auth Routes (Password/Google)"
Cohesion: 0.09
Nodes (25): changePasswordSchema, createGoogleHandoffCode(), forgotPasswordSchema, isChangePasswordRateLimited, isForgotRateLimited, isLoginRateLimited, isResetRateLimited, isSignupRateLimited (+17 more)

### Community 26 - "Invoice Model + Charges Tests"
Cohesion: 0.10
Nodes (14): Invoice, LineItem, RLS_TABLES, orgId(), flaggedInvoice(), orgId(), accountId(), orgId() (+6 more)

### Community 27 - "QuickBooks Integration"
Cohesion: 0.16
Nodes (22): llmConfigured(), applyTokens(), basicAuthHeader(), CATEGORIZE_TOOL, clamp01(), ensureFreshToken(), escapeQbQueryString(), exchangeCodeForTokens() (+14 more)

### Community 28 - "Lease Approval Frontend"
Cohesion: 0.11
Nodes (26): approveLease(), approveVendorDoc(), expiryBadge(), leaseCriticalDate(), leaseExpiryBadge(), leaseFieldConf(), loadLeasePreview(), loadLeases() (+18 more)

### Community 29 - "Financial Statements Engine"
Cohesion: 0.16
Nodes (23): CASH_SUBTYPES, cashFlowCategoryFor(), CATEGORY_BY_COUNTER_TYPE, computeBalanceSheet(), computeCashFlow(), computeProfitAndLoss(), DEBIT_NORMAL_TYPES, isCashAccount() (+15 more)

### Community 30 - "Transaction Categorization Frontend"
Cohesion: 0.09
Nodes (25): categorizeTransaction(), confirmBankMatch(), deleteTransaction(), dismissBankTransaction(), fmtPct(), loadExpenseAccountSuggestion(), loadOrgSettings(), loadQaSampleQueue() (+17 more)

### Community 31 - "Tax Doc Extraction"
Cohesion: 0.16
Nodes (23): AMOUNT_LABELS, clamp01(), cleanNumber(), cleanTaxYear(), extract(), extractHeuristic(), extractionPrompt(), extractWithLlm() (+15 more)

### Community 32 - "Auth/2FA Core Logic"
Cohesion: 0.12
Nodes (18): createAccessToken(), hashPassword(), isReauthRateLimited, isStaffEmail(), requireReauth(), requireStaff(), verifyPassword(), Invite (+10 more)

### Community 33 - "Confidence Scoring + Invoices Route"
Cohesion: 0.11
Nodes (18): adjustmentsTotal(), CORE_FIELDS_WEIGHT, crossCheckTotal(), round2(), score(), bulkActionSchema, correctionSchema, FIELD_TO_ATTR (+10 more)

### Community 34 - "Matching/Close Models"
Cohesion: 0.10
Nodes (13): CloseTask, MatchEntry, MatchResult, MatchSource, AFTER_PERIOD, BEFORE_PERIOD, IN_PERIOD, openPeriod() (+5 more)

### Community 35 - "Job Queue + RLS"
Cohesion: 0.17
Nodes (20): drain(), enqueue(), PROCESSORS, queue, recoverOrphanedJobs(), recoverOrphanedJobsInContext(), applyContext(), applyRlsPolicies() (+12 more)

### Community 36 - "Design System References"
Cohesion: 0.14
Nodes (21): voltagent/awesome-design-md, Figma Design System, Intercom Design System, Linear Design System, Mastercard Design System, Notion Design System, Resend Design System, Revolut Design System (+13 more)

### Community 37 - "Fiscal Year + AP Tests"
Cohesion: 0.10
Nodes (17): ClosePeriod, CustomerPayment, accountId(), orgId(), postEntry(), TODAY, accountId(), makeApprovedInvoice() (+9 more)

### Community 38 - "Revenue Recognition Models"
Cohesion: 0.17
Nodes (18): CustomerInvoice, CustomerInvoiceLine, buildSchedule(), computeDeferredRevenueWaterfall(), createSchedulesForInvoice(), daysInclusive(), dropUnrecognizedSchedule(), ensureDeferredRevenueAccount() (+10 more)

### Community 39 - "Doc Pipeline Tabs Changelog Arc"
Cohesion: 0.11
Nodes (20): Expenses Tab, Leases Tab, Quick Review Tab, Tax Docs Tab, v1.39: Full Invoice Charge Schema, v1.42: Configurable OpenAI-Compatible Endpoint, v1.44: Spelled-Out PO Label Fix, Confidence Scoring & Cross-Check (+12 more)

### Community 40 - "Rate Limiting + Assistant"
Cohesion: 0.15
Nodes (14): createRateLimiter(), isRateLimited(), sweep(), rateLimitMiddleware(), askSchema, historyEntrySchema, isAssistantRateLimited, router (+6 more)

### Community 41 - "Config + Expense Pipeline"
Cohesion: 0.22
Nodes (11): settings, storageDir, effectiveConfidenceThreshold(), fail(), markFailedIfStuck(), processExpense(), AuditLog, effectiveConfidenceThreshold() (+3 more)

### Community 42 - "Demo Seed Data"
Cohesion: 0.25
Nodes (18): buildPdf(), COMPANY_NAMES, daysFromNow(), isoDay(), monthsAgo(), seedClosePeriod(), seedDemoOrg(), seedEquity() (+10 more)

### Community 43 - "Net Worth + Staff Dashboard Frontend"
Cohesion: 0.16
Nodes (18): fmtCompactMoney(), kpiCard(), loadNetWorth(), loadStaffOverview(), nwAccountRow(), nwDeleteAccount(), nwFmtDate(), nwFmtDelta() (+10 more)

### Community 44 - "Stock Compensation (ASC 718)"
Cohesion: 0.22
Nodes (15): requireAuth(), router, runSchema, computeAwardCosts(), computeSchedule(), cumulativeExpenseCents(), ensureStockCompensationAccount(), grantCostCents() (+7 more)

### Community 45 - "Income Tax Provision"
Cohesion: 0.20
Nodes (15): seedIncomeTax(), computeProvision(), ensureTaxAccount(), fiscalYearForOrg(), ON_DEMAND, postedProvisionCents(), preTaxIncomeCents(), recordProvision() (+7 more)

### Community 46 - "Payroll Model + Logic"
Cohesion: 0.18
Nodes (15): Employee, PayrollRun, employerTaxCents(), isValidCashAccount(), isValidExpenseAccount(), isValidLiabilityAccount(), netPayCents(), postPayrollRun() (+7 more)

### Community 47 - "Document Usage Limits"
Cohesion: 0.21
Nodes (12): documentsUsedThisMonth(), startOfCurrentMonthUtc(), TaxDocument, daysFromNow(), documentsCreatedInRange(), isoDate(), monthOverMonth(), pctChange() (+4 more)

### Community 48 - "Vendor Model + Routes"
Cohesion: 0.18
Nodes (12): Vendor, mergeSchema, router, vendorPatchSchema, vendorSchema, addDaysIso(), attachVendorToInvoice(), buildVendorResolver() (+4 more)

### Community 49 - "Vendor Alias + Pipeline"
Cohesion: 0.25
Nodes (11): VendorAlias, applyVendorAlias(), effectiveConfidenceThreshold(), fail(), findDuplicateInvoice(), markFailedIfStuck(), processInvoice(), shouldAutoApprove() (+3 more)

### Community 50 - "Graphify Extraction Spec Rules"
Cohesion: 0.12
Nodes (16): Step 6b: Wiki export, Confidence score rubric, Hyperedge rule, Node ID format rule, semantically_similar_to edge rule, Extraction subagent prompt template, DEEP_MODE flag, graph.json shrink guard (#479) (+8 more)

### Community 51 - "Core Accounting Tabs Changelog Arc"
Cohesion: 0.15
Nodes (15): Ask Rekono floating widget, Balance Sheet Tab, Dashboard (Home/Ask Rekono Tab), Income Statement Tab, Invoices Tab (Upload + Review Queue), Trial Balance Tab, v1.36: Workpaper Visual Identity Redesign, v1.37: Revert to Bitter/Blue Palette (+7 more)

### Community 52 - "Invoice Extraction"
Cohesion: 0.26
Nodes (13): clamp01(), cleanDate(), cleanNumber(), detectMultipleInvoicesHeuristic(), extract(), extractHeuristic(), extractionPrompt(), extractWithLlm() (+5 more)

### Community 53 - "Check Extraction"
Cohesion: 0.27
Nodes (13): accountLast4(), CHECK_TOOL, clamp01(), cleanDate(), cleanNumber(), extract(), extractHeuristic(), extractionPrompt() (+5 more)

### Community 54 - "Vendor Doc Extraction"
Cohesion: 0.25
Nodes (13): clamp01(), cleanDate(), cleanNumber(), DOCUMENT_TYPE_KEYWORDS, extract(), extractHeuristic(), extractionPrompt(), extractWithLlm() (+5 more)

### Community 55 - "Vendor Expense Account Memory"
Cohesion: 0.16
Nodes (5): VendorExpenseAccount, lookupVendorExpenseAccount(), rememberVendorExpenseAccount(), orgId(), TODAY

### Community 56 - "Lease Extraction"
Cohesion: 0.27
Nodes (12): clamp01(), cleanDate(), cleanNumber(), extract(), extractHeuristic(), extractionPrompt(), extractWithLlm(), FIELDS (+4 more)

### Community 57 - "Receipt Extraction"
Cohesion: 0.25
Nodes (12): CATEGORY_KEYWORDS, clamp01(), cleanDate(), cleanNumber(), extract(), extractHeuristic(), extractionPrompt(), extractWithLlm() (+4 more)

### Community 58 - "CSV/Excel Export Builders"
Cohesion: 0.20
Nodes (12): buildExpenseRows(), buildLeaseRows(), buildRows(), buildTaxDocumentRows(), buildVendorDocumentRows(), COLUMNS, EXPENSE_COLUMNS, LEASE_COLUMNS (+4 more)

### Community 59 - "Backend Runtime Dependencies"
Cohesion: 0.15
Nodes (13): dependencies, bcryptjs, cors, csv-parse, exceljs, sequelize, sqlite3, bcryptjs (+5 more)

### Community 60 - "Tax Docs Frontend Actions"
Cohesion: 0.23
Nodes (13): approveTaxDoc(), deleteTaxDoc(), loadTaxDocPreview(), loadTaxDocs(), pollTaxDocWhileProcessing(), rejectTaxDoc(), renderTaxDocDetail(), renderTaxDocs() (+5 more)

### Community 61 - "Payroll/Adjustments Tabs Changelog Arc"
Cohesion: 0.19
Nodes (13): Adjusting Entries Tab, Bill Payments Tab, Journal Entries Tab, Net Worth Widget & Add-Account Modal, Payroll Tab, v1.49: Fixed Asset Tracking, v1.56: Payroll & Special-Purpose Journals, v1.59: Add-Account Form Split & Invoice Tab Merge (+5 more)

### Community 62 - "Expenses Frontend Actions"
Cohesion: 0.26
Nodes (12): approveExpense(), deleteExpense(), expenseFieldConf(), loadExpenseDocPreview(), loadExpenses(), pollExpenseWhileProcessing(), rejectExpense(), renderExpenseDetail() (+4 more)

### Community 63 - "Plaid/Matching Tabs Changelog Arc"
Cohesion: 0.18
Nodes (12): Month-End Close Tab, Matching/Reconciliation Tab, Connected Bank Accounts (Plaid) Section, Transactions Tab, Vendor Docs Tab, v1.54: Plaid Bank Connections, v1.55: Plaid Merchant-Name Matching Fix, AI Transaction Categorization (+4 more)

### Community 64 - "Lease Confidence Scoring"
Cohesion: 0.26
Nodes (6): FIELD_WEIGHT, score(), effectiveConfidenceThreshold(), fail(), markFailedIfStuck(), processLease()

### Community 65 - "Staff Analytics Helpers"
Cohesion: 0.29
Nodes (9): activationFunnel(), bucketByWeek(), daysFromNow(), documentVolumeTrend(), isoDate(), orgIdsWithAnyDocument(), router, signupTrend() (+1 more)

### Community 66 - "Check Pipeline + Confidence"
Cohesion: 0.31
Nodes (6): effectiveConfidenceThreshold(), fail(), markFailedIfStuck(), processCheck(), FIELD_WEIGHT, Check

### Community 67 - "Vendor Doc Confidence"
Cohesion: 0.29
Nodes (6): FIELD_WEIGHT, score(), effectiveConfidenceThreshold(), fail(), markFailedIfStuck(), processVendorDocument()

### Community 68 - "Revenue Recognition Tests"
Cohesion: 0.27
Nodes (8): RevenueScheduleEntry, accountId(), makeCustomer(), makeInvoice(), orgId(), pnl(), send(), trialBalance()

### Community 69 - "Backend PWA Manifest"
Cohesion: 0.22
Nodes (8): background_color, description, display, icons, name, short_name, start_url, theme_color

### Community 70 - "Website PWA Manifest"
Cohesion: 0.22
Nodes (8): background_color, description, display, icons, name, short_name, start_url, theme_color

### Community 71 - "Backend package.json"
Cohesion: 0.25
Nodes (7): license, name, overrides, uuid, private, type, version

### Community 72 - "Plaid Frontend Section"
Cohesion: 0.36
Nodes (8): deleteSource(), disconnectPlaidConnection(), loadPlaidSection(), loadSources(), renderPlaidConnections(), renderPlaidStatus(), renderSources(), syncPlaidAccount()

### Community 73 - "Onboarding/Auth Architecture Arc"
Cohesion: 0.29
Nodes (8): Auth Gate (Login/Signup/2FA/Invite), Onboarding Wizard, Plan Picker Grid, v1.57: New Logomark, API Surface, Auth (JWT/bcrypt), Onboarding & Billing (Stripe), Team Invites

### Community 74 - "Early Releases Changelog Arc (v1.0-v1.16)"
Cohesion: 0.36
Nodes (8): v1.0: Baseline -- document pipeline, review/correction, matching, multi-tenancy with RLS, accounts/billing, QuickBooks integration, hardening, v1.1: Started numbering releases, adding CHANGELOG.md and CLAUDE.md, v1.13: Marketing site GA4 analytics with cta_click and generate_lead events, v1.14: Per-org team Activity panel breaking down teammate actions from AuditLog, v1.15: Business KPI trends (13-week charts, top vendors, month-over-month tiles) on the dashboard, v1.16: Staff-only cross-org usage dashboard that deliberately opts out of row-level security, v1.2: OpenRouter added as an alternative LLM provider to Gemini across all nine call sites, v1.3: Added check-llm.mjs, a live preflight for the configured LLM provider

### Community 75 - "Test Tooling Dependencies"
Cohesion: 0.29
Nodes (7): devDependencies, jest, @playwright/cli, supertest, jest, @playwright/cli, supertest

### Community 76 - "Settings Sub-Panels Frontend"
Cohesion: 0.29
Nodes (7): Risk-based auto-approval panel, QuickBooks integration panel, Review queue confidence threshold panel, Settings tab, Statistical sampling panel, Two-factor authentication panel, Upgrade plan modal

### Community 77 - "Chart of Accounts Nav Changelog Arc"
Cohesion: 0.43
Nodes (7): Chart of Accounts Tab, Command Palette Button, Top Bar Navigation Menus, v1.40: Chart of Accounts & Nav Organization, v1.48: Chart of Accounts Subtype Taxonomy, v1.60: Command Palette, Chart of Accounts Ordering

### Community 78 - "Tax Doc Confidence"
Cohesion: 0.38
Nodes (5): FIELD_WEIGHT, score(), ALL_FIELDS, allAt(), makeResult()

### Community 79 - "Three-Way Matching Engine"
Cohesion: 0.43
Nodes (4): findBestMatch(), findThreeWayMatch(), scorePair(), THREE_WAY_VERDICTS

### Community 80 - "OCR Extraction"
Cohesion: 0.76
Nodes (5): execFileAsync, extractFromImage(), extractFromPdf(), extractText(), OcrError

### Community 81 - "Payroll API Tests"
Cohesion: 0.38
Nodes (3): accountId(), basicPayrollPayload(), standardAccounts()

### Community 82 - "Equity/Cap Table Frontend Panels"
Cohesion: 0.33
Nodes (6): Cap Table tab, Equity tab, Exercise award modal, Record a payment modal, Stock compensation sub-section (ASC 718 expense), Write a check modal

### Community 83 - "Checks/Backend Stack Arc"
Cohesion: 0.47
Nodes (6): Checks Tab, v1.45: Check Scanning & Correction-Save Fix, v1.50: Check Writing, Checks Pipeline, Data Layer (Sequelize/Postgres), Backend Test Suite

### Community 84 - "Income Statement Tests"
Cohesion: 0.47
Nodes (5): accountId(), incomeStatement(), postEntry(), TODAY, tradingOrg()

### Community 85 - "Sub-Journals Tests"
Cohesion: 0.47
Nodes (3): accountId(), postCustomerInvoice(), postManualEntry()

### Community 87 - "Session-Start Hook Script"
Cohesion: 0.70
Nodes (4): bridge_chromium(), install_gstack(), install_ruflo(), session-start.sh script

### Community 88 - "npm Scripts"
Cohesion: 0.50
Nodes (4): scripts, dev, start, test

### Community 89 - "Vendor Terms Changelog Arc"
Cohesion: 0.67
Nodes (4): AP Aging Tab, Vendors Tab, v1.43: Vendor Early-Payment Discount Terms, v1.53: Graphify Install & Vendor Payment Terms Fallback

### Community 90 - "Pipeline Architecture Concepts"
Cohesion: 0.50
Nodes (4): Export Tab, Architecture Pipeline, Ingestion Layer, Output/Integration Layer

### Community 91 - "Infra/Docs Fixes Changelog Arc"
Cohesion: 0.50
Nodes (4): v1.5: Fixed Google Safe Browsing 'Deceptive pages' flag caused by free-text org names on the invite-accept page, v1.6: Render account suspension and migration to a new service name/URL, v1.7: Corrected README's row-level-security docs on Neon's forced neon_superuser/BYPASSRLS grant, Rekono API Reference for Lovable Frontend

### Community 92 - "Graphify Multi-Repo Merge"
Cohesion: 0.50
Nodes (4): graphify clone <url>, graphify merge-graphs, Monorepo / multi-subfolder flow, Step 0: GitHub repos and multi-path merge

### Community 93 - "Graphify Setup Steps"
Cohesion: 0.50
Nodes (4): Gemini semantic extraction backend, Step 1: Ensure graphify is installed, Step 2: Detect files, Step 3: Extract entities and relationships

### Community 94 - "Sample Invoice Generator"
Cohesion: 0.50
Nodes (3): Path, build_pdf(), Generates a sample invoice PDF for local demos/testing. Requires reportlab (not…

### Community 95 - "Deployment Infra Concepts"
Cohesion: 0.50
Nodes (4): Docker Compose Setup, Neon Postgres Database, Render Blueprint Deployment, Running Locally

### Community 96 - "Admin Tabs (Team/Staff/Palette)"
Cohesion: 0.67
Nodes (3): Command palette, Staff tab (Rekono internal cross-org dashboard), Team tab

## Ambiguous Edges - Review These
- `Checks Pipeline` → `v1.50: Check Writing`  [AMBIGUOUS]
  CHANGELOG.md · relation: conceptually_related_to

## Knowledge Gaps
- **528 isolated node(s):** `personalization`, `apiCache`, `checkoutParam`, `demoParam`, `GOOGLE_AUTH_ERROR_MESSAGES` (+523 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 740 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **64 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Checks Pipeline` and `v1.50: Check Writing`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `authHeader()` connect `Check API + Ledger Test Helpers` to `Matching/Close Models`, `Express App Bootstrap`, `Close Automation Suggestions`, `Fiscal Year + AP Tests`, `Revenue Recognition Tests`, `Bank Models + RLS Bootstrap`, `Payroll API Tests`, `Income Statement Tests`, `Sub-Journals Tests`, `Vendor Expense Account Memory`, `Invoice Model + Charges Tests`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `llmConfigured()` connect `QuickBooks Integration` to `Rate Limiting + Assistant`, `Document Usage Limits`, `Plaid Bank Integration`, `Invoice Extraction`, `Check Extraction`, `Vendor Doc Extraction`, `LLM Provider Preflight Check`, `Lease Extraction`, `Receipt Extraction`, `Tax Doc Extraction`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `AuditLog` connect `Config + Expense Pipeline` to `Sequelize Data Models`, `Express App Bootstrap`, `Close Automation Suggestions`, `Equity Awards (Stock Options)`, `Bank Models + RLS Bootstrap`, `Accounts Payable Logic`, `Expenses Route + Corrections`, `Plaid Bank Integration`, `Equity Ledger Postings`, `Accounts Receivable Logic`, `Org Naming + Billing Plans`, `Bank Matching + Column Parsing`, `Trial Balance + Plan Gating`, `Auth Routes (Password/Google)`, `Auth/2FA Core Logic`, `Confidence Scoring + Invoices Route`, `Matching/Close Models`, `Fiscal Year + AP Tests`, `Revenue Recognition Models`, `Stock Compensation (ASC 718)`, `Income Tax Provision`, `Document Usage Limits`, `Vendor Model + Routes`, `Vendor Alias + Pipeline`, `Lease Confidence Scoring`, `Staff Analytics Helpers`, `Check Pipeline + Confidence`, `Vendor Doc Confidence`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **Are the 61 inferred relationships involving `resetDb()` (e.g. with `accountOrdering.test.js` and `accountTaxonomy.test.js`) actually correct?**
  _`resetDb()` has 61 INFERRED edges - model-reasoned connections that need verification._
- **What connects `personalization`, `apiCache`, `checkoutParam` to the rest of the system?**
  _528 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Frontend App Shell (app.js)` be split into smaller, more focused modules?**
  _Cohesion score 0.0268857356235997 - nodes in this community are weakly interconnected._