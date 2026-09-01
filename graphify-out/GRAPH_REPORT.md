# Graph Report - Rekono  (2026-09-01)

## Corpus Check
- 340 files · ~402,290 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2016 nodes · 5178 edges · 152 communities (95 shown, 51 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 253 edges (avg confidence: 0.84)
- Token cost: 675,988 input · 0 output

## Community Hubs (Navigation)
- Frontend Ledger Form Helpers
- Express App Bootstrap & Security
- Accounts Payable & Vendors
- Equity & Adjustments Tests
- DB Init & Org Isolation Tests
- Marketing Site React Components
- Month-End Close Automation
- Accounts Receivable & Revenue Recognition
- Equity & Share Register
- Auth, 2FA & Rate Limiting
- graphify Skill Pipeline & Commands
- Frontend Auth & API Client
- Frontend Delete/Approve Dialogs
- Sequelize Models Index
- LLM Provider Config & Checks
- Financial Statements Computation
- Frontend Recurring Entries & Equity Awards UI
- Frontend Dashboard & Close UI
- General Ledger Core
- Demo Data Seeding
- Package
- Income Tax
- Equity Awards
- App
- Transaction Categorization
- Quickbooks
- Extraction Tax Docs
- Tax Documents
- Billing
- Design
- Payables Tests
- App
- Auth
- Stock Compensation
- Checks
- Dashboard
- Extraction Vendor Docs
- Serializers
- Invoices
- Skill
- Readme
- Extraction
- Extraction Checks
- Rls
- Net Worth
- App
- App
- App
- Financial Statements
- Extraction Leases
- Extraction Receipts
- Export
- Package
- Receivables Tests
- Check Pipeline
- Staff
- Community 56
- App
- App
- Changelog
- Lease Pipeline
- Pipeline
- Expense Pipeline
- Vendor Doc Pipeline
- Revenue Recognition Tests
- Claude
- Design
- Manifest
- Jobs
- Leases
- Vendor Documents
- Changelog
- Ci
- Changelog
- Manifest
- Package
- Confidence
- Quick Review Tests
- Tax Doc Pipeline
- Written Checks Tests
- Package
- Confidence Tax Docs Tests
- Secret Box
- Ocr
- Sample Invoice Tests
- Financial Statements Tests
- Income Statement Tests
- App
- Net Worth Tests
- Confidence Leases
- Session Start
- Package
- Github And Merge
- Skill
- Generate Sample Invoice
- App
- Journal Entry
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Package
- Setup Test Postgres
- Jest.Setup
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Changelog
- Exports
- Exports
- Exports
- Exports
- Exports
- Exports

## God Nodes (most connected - your core abstractions)
1. `authHeader()` - 173 edges
2. `resetDb()` - 71 edges
3. `app` - 61 edges
4. `signup()` - 61 edges
5. `LedgerError` - 60 edges
6. `escapeHtml()` - 59 edges
7. `centsToDollars()` - 57 edges
8. `switchTab()` - 54 edges
9. `AuditLog` - 47 edges
10. `Invoice` - 46 edges

## Surprising Connections (you probably didn't know these)
- `Editorial/Technical Aesthetic Direction` --semantically_similar_to--> `Anti-Slop Frontend Skill (design-taste-frontend)`  [INFERRED] [semantically similar]
  DESIGN.md → .claude/skills/taste-skill/SKILL.md
- `v1.11: Seed Sample Invoice for New Orgs` --conceptually_related_to--> `Sample Invoice PDF (Test/Demo Data)`  [INFERRED]
  CHANGELOG.md → sample_data/sample_invoice.pdf
- `docker-compose.yml (Local Postgres Stack)` --semantically_similar_to--> `render.yaml (Render Blueprint)`  [INFERRED] [semantically similar]
  docker-compose.yml → render.yaml
- `v1.28: Move High-Frequency Facts into CLAUDE.md` --references--> `README.md (Project Overview)`  [EXTRACTED]
  CHANGELOG.md → README.md
- `DESIGN.md (Design System)` --shares_data_with--> `App Shell (index.html)`  [INFERRED]
  DESIGN.md → backend/public/index.html

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Polarity-Flipped Featured Pricing Tier Pattern** — claude_skills_design_references_design_md_stripe_design, claude_skills_design_references_design_md_revolut_design, claude_skills_design_references_design_md_notion_design, claude_skills_design_references_design_md_slack_design, claude_skills_design_references_design_md_wise_design, claude_skills_design_references_design_md_zapier_design, claude_skills_design_references_design_md_vercel_design, claude_skills_design_references_design_md_resend_design, claude_skills_design_references_design_md_superhuman_design, claude_skills_design_references_design_md_sentry_design [INFERRED 0.85]
- **Atmospheric Gradient Mesh Backdrop Pattern** — claude_skills_design_references_design_md_stripe_design, claude_skills_design_references_design_md_vercel_design, claude_skills_design_references_design_md_slack_design [INFERRED 0.85]
- **Dark Canvas, No-Shadow Developer Brand Pattern** — claude_skills_design_references_design_md_linear_app_design, claude_skills_design_references_design_md_resend_design, claude_skills_design_references_design_md_revolut_design, claude_skills_design_references_design_md_sentry_design, claude_skills_design_references_design_md_vercel_design [INFERRED 0.85]
- **Graphify full build pipeline (detect -> extract -> build/cluster -> label -> export)** — claude_skills_graphify_skill_step2_detect, claude_skills_graphify_skill_step3_extract, claude_skills_graphify_skill_step4_build_cluster, claude_skills_graphify_skill_step5_label, claude_skills_graphify_skill_step6_obsidian_html [INFERRED 0.85]
- **Graphify self-improving query feedback loop** — claude_skills_graphify_references_query_vocab_expansion, claude_skills_graphify_references_query_bfs_dfs_traversal, claude_skills_graphify_references_query_save_result, claude_skills_graphify_references_query_reflect_lessons [INFERRED 0.80]
- **playwright-cli plan/generate/heal test authoring lifecycle** — claude_skills_playwright_cli_references_test_generation_seed_test, claude_skills_playwright_cli_references_test_generation_plan_generate_heal, claude_skills_playwright_cli_references_playwright_tests_debug_cli, claude_skills_playwright_cli_references_session_management_attach [INFERRED 0.80]
- **Supply Chain Security Pipeline (Dependabot + CI + CodeQL + Scorecard)** — github_dependabot, github_workflows_ci, github_workflows_codeql, github_workflows_scorecard, changelog_v1_52 [INFERRED 0.85]
- **Rekono General-Ledger Core Principles** — claude_accounting_conventions, changelog_v1_20, changelog_v1_21, changelog_v1_27 [INFERRED 0.80]
- **Marketing Site Migration and Rebuild (Vercel + React + Analytics)** — changelog_v1_8, changelog_v1_13, website_readme, docs_references_10k_website_guide [INFERRED 0.75]

## Communities (152 total, 51 thin omitted)

### Community 0 - "Frontend Ledger Form Helpers"
Cohesion: 0.03
Nodes (68): ACCOUNT_TYPE_LABELS, accountOptionsHtml(), accountSubtypesByType, addCustomerInvoiceLineRow(), addJournalEntryLineRow(), AGING_BUCKET_KEYS, amountInWords(), AWARD_HINTS (+60 more)

### Community 1 - "Express App Bootstrap & Security"
Cohesion: 0.07
Nodes (27): app, CONTENT_SECURITY_POLICY, __dirname, EXPENSIVE_PATHS, handleUnexpectedError(), publicDir, whenIdle(), Organization (+19 more)

### Community 2 - "Accounts Payable & Vendors"
Cohesion: 0.05
Nodes (50): addDaysIso(), AGING_BUCKETS, amountPaidCents(), computeApAging(), daysBetween(), earlyPayDiscount(), invoiceTotalCents(), isValidPaymentAccount() (+42 more)

### Community 3 - "Equity & Adjustments Tests"
Cohesion: 0.05
Nodes (60): EquityTransaction, accountId(), balanceSheet(), makeTemplate(), orgId(), pnl(), seedActivity(), trialBalance() (+52 more)

### Community 4 - "DB Init & Org Isolation Tests"
Cohesion: 0.06
Nodes (30): queueDepth(), CloseTask, ExpenseReceipt, BENIGN_SYNC_RACE_CODES, initDb(), syncSchema(), Invoice, Lease (+22 more)

### Community 5 - "Marketing Site React Components"
Cohesion: 0.08
Nodes (35): App(), ContactModal(), handleSubmit(), FAQ(), ITEMS, Features(), GROUPS, FinalCTA() (+27 more)

### Community 6 - "Month-End Close Automation"
Cohesion: 0.08
Nodes (44): median(), monthBounds(), monthlyActivity(), NON_DEPRECIABLE_ASSET_SUBTYPES, previousMonth(), suggestDepreciation(), suggestionsFor(), suggestMissingExpenses() (+36 more)

### Community 7 - "Accounts Receivable & Revenue Recognition"
Cohesion: 0.08
Nodes (40): addDays(), AGING_BUCKETS, amountPaidCents(), computeArAging(), daysBetween(), findSystemAccount(), nextInvoiceNumber(), postCustomerInvoice() (+32 more)

### Community 8 - "Equity & Share Register"
Cohesion: 0.09
Nodes (38): accountBalanceCents(), buildLines(), ensureAccount(), MEMO_BY_TYPE, ON_DEMAND_ACCOUNTS, ownersEquityAccount(), recordEquityTransaction(), requireCashAccount() (+30 more)

### Community 9 - "Auth, 2FA & Rate Limiting"
Cohesion: 0.06
Nodes (36): orgNameSchema, createRateLimiter(), isRateLimited(), sweep(), rateLimitMiddleware(), changePasswordSchema, createGoogleHandoffCode(), forgotPasswordSchema (+28 more)

### Community 10 - "graphify Skill Pipeline & Commands"
Cohesion: 0.06
Nodes (44): Watch debounce (default 3s), /graphify add <url>, --watch folder watcher, graphify claude install (CLAUDE.md integration), graphify hook install (post-commit hook), BFS/DFS graph traversal, /graphify explain, /graphify path (+36 more)

### Community 11 - "Frontend Auth & API Client"
Cohesion: 0.08
Nodes (39): apiCache, apiFetch(), authError(), authSuccess(), beginNetworkRequest(), bootstrapApp(), checkoutParam, clearToken() (+31 more)

### Community 12 - "Frontend Delete/Approve Dialogs"
Cohesion: 0.12
Nodes (38): alertDialog(), approveInvoice(), checkFieldConf(), confirmDialog(), deleteCheck(), deleteExpense(), deleteInvoice(), deleteTaxDoc() (+30 more)

### Community 13 - "Sequelize Models Index"
Cohesion: 0.13
Nodes (8): CHECK_STATUSES, CUSTOMER_INVOICE_STATUSES, DEPRECIATION_METHODS, newId(), INVOICE_STATUSES, LEASE_STATUSES, TAX_DOCUMENT_STATUSES, VENDOR_DOCUMENT_STATUSES

### Community 14 - "LLM Provider Config & Checks"
Cohesion: 0.11
Nodes (22): provider, TEST_TOOL, warning, callTool(), chatCompletionsUrl(), EmptyLlmResponseError, geminiClient(), geminiReady() (+14 more)

### Community 15 - "Financial Statements Computation"
Cohesion: 0.12
Nodes (29): serializeEquityTransaction(), CASH_SUBTYPES, cashFlowCategoryFor(), CATEGORY_BY_COUNTER_TYPE, computeBalanceSheet(), computeCashFlow(), computeProfitAndLoss(), DEBIT_NORMAL_TYPES (+21 more)

### Community 16 - "Frontend Recurring Entries & Equity Awards UI"
Cohesion: 0.09
Nodes (32): accountOptionsFilteredHtml(), addRecurringLineRow(), ciDepositAccounts(), defaultStatementPeriod(), exerciseDialog(), fmtMoney(), groupedAccountOptionsHtml(), loadAdjustmentAccounts() (+24 more)

### Community 17 - "Frontend Dashboard & Close UI"
Cohesion: 0.09
Nodes (32): closeStatus(), deleteCloseTask(), greetingForHour(), kpiCard(), loadClose(), loadCloseSuggestions(), loadDashboard(), loadEquityAccounts() (+24 more)

### Community 18 - "General Ledger Core"
Cohesion: 0.10
Nodes (27): voidCustomerInvoiceEntry(), accountSortRank(), BALANCE_SHEET_TYPES, compareAccountsWithinType(), computeTrialBalance(), findAccountByName(), LIQUIDITY_RANK, postInvoiceApproval() (+19 more)

### Community 19 - "Demo Data Seeding"
Cohesion: 0.11
Nodes (27): buildPdf(), COMPANY_NAMES, daysFromNow(), formatInvoiceDoc(), isoDay(), monthsAgo(), seedClosePeriod(), seedDemoOrg() (+19 more)

### Community 20 - "Package"
Cohesion: 0.07
Nodes (29): autoprefixer, framer-motion, postcss, react, react-dom, @vercel/speed-insights, vite, @vitejs/plugin-react (+21 more)

### Community 21 - "Income Tax"
Cohesion: 0.10
Nodes (26): ACCOUNT_SUBTYPES, accountClassification(), CLASSIFICATION_BY_TYPE_AND_VALUE, CLASSIFICATIONS, LABEL_BY_TYPE_AND_VALUE, subtypeLabel(), DIVIDENDS_PAYABLE_SUBTYPE, EQUITY_SUBTYPES (+18 more)

### Community 22 - "Equity Awards"
Cohesion: 0.14
Nodes (25): voidEquityTransaction(), awardsWithEvents(), cancelAward(), computeFullyDiluted(), computePlanStatus(), exerciseAward(), loadAward(), loadPlan() (+17 more)

### Community 23 - "App"
Cohesion: 0.12
Nodes (28): escapeHtml(), holderOptions(), loadArAging(), loadAwards(), loadCapClasses(), loadCapCounts(), loadCapFunding(), loadCapHolders() (+20 more)

### Community 24 - "Transaction Categorization"
Cohesion: 0.11
Nodes (17): EXPENSE_CATEGORIES, EXPENSE_RECEIPT_STATUSES, MerchantCategory, Transaction, COLUMN_ALIASES, correctSchema, router, CATEGORIZE_TOOL (+9 more)

### Community 25 - "Quickbooks"
Cohesion: 0.16
Nodes (22): llmConfigured(), applyTokens(), basicAuthHeader(), CATEGORIZE_TOOL, clamp01(), ensureFreshToken(), escapeQbQueryString(), exchangeCodeForTokens() (+14 more)

### Community 26 - "Extraction Tax Docs"
Cohesion: 0.15
Nodes (24): AMOUNT_LABELS, clamp01(), cleanNumber(), cleanTaxYear(), extract(), extractHeuristic(), extractionPrompt(), extractWithLlm() (+16 more)

### Community 27 - "Tax Documents"
Cohesion: 0.10
Nodes (14): COLUMN_ALIASES, router, correctionSchema, FIELD_TO_ATTR, router, SORTABLE_FIELDS, serializeMatchSource(), serializeTaxDocumentDetail() (+6 more)

### Community 28 - "Billing"
Cohesion: 0.16
Nodes (14): billingCycleAmountUsd(), isValidPlanId(), PAID_PLAN_IDS, PLANS, priceUsd(), TRIAL_DAYS, cancelReplacedSubscription(), checkoutSchema (+6 more)

### Community 29 - "Design"
Cohesion: 0.14
Nodes (21): voltagent/awesome-design-md, Figma Design System, Intercom Design System, Linear Design System, Mastercard Design System, Notion Design System, Resend Design System, Revolut Design System (+13 more)

### Community 30 - "Payables Tests"
Cohesion: 0.10
Nodes (14): BillPayment, JournalEntry, accountId(), makeApprovedInvoice(), orgId(), trialBalance(), accountId(), orgId() (+6 more)

### Community 31 - "App"
Cohesion: 0.11
Nodes (20): categorizeTransaction(), confirmBankMatch(), deleteTransaction(), dismissBankTransaction(), fmtPct(), loadExpenseAccountSuggestion(), loadQuickbooksReconciliation(), loadQuickReviewQueue() (+12 more)

### Community 32 - "Auth"
Cohesion: 0.14
Nodes (14): isReauthRateLimited, isStaffEmail(), requireReauth(), requireStaff(), verifyPassword(), Invite, buildMeResponse(), acceptInviteSchema (+6 more)

### Community 33 - "Stock Compensation"
Cohesion: 0.22
Nodes (17): monthsElapsed(), vestedShares(), periodEndDate(), router, runSchema, computeAwardCosts(), computeSchedule(), cumulativeExpenseCents() (+9 more)

### Community 34 - "Checks"
Cohesion: 0.15
Nodes (11): findBestMatch(), findThreeWayMatch(), scorePair(), THREE_WAY_VERDICTS, correctionSchema, FIELD_TO_ATTR, linkSchema, router (+3 more)

### Community 35 - "Dashboard"
Cohesion: 0.22
Nodes (11): documentsUsedThisMonth(), startOfCurrentMonthUtc(), daysFromNow(), documentsCreatedInRange(), isoDate(), monthOverMonth(), pctChange(), router (+3 more)

### Community 36 - "Extraction Vendor Docs"
Cohesion: 0.23
Nodes (14): clamp01(), cleanDate(), cleanNumber(), DOCUMENT_TYPE_KEYWORDS, extract(), extractHeuristic(), extractionPrompt(), extractWithLlm() (+6 more)

### Community 37 - "Serializers"
Cohesion: 0.18
Nodes (12): correctionSchema, FIELD_TO_ATTR, router, SORTABLE_FIELDS, paymentSummary(), ratePercent(), serializeAuditLog(), serializeExpenseReceiptDetail() (+4 more)

### Community 38 - "Invoices"
Cohesion: 0.12
Nodes (13): bulkActionSchema, correctionSchema, FIELD_TO_ATTR, Invoice, lineItemSchema, NUMERIC_QUICK_REVIEW_FIELDS, OPTIONAL_QUICK_REVIEW_FIELDS, qaReviewSchema (+5 more)

### Community 39 - "Skill"
Cohesion: 0.12
Nodes (16): Step 6b: Wiki export, Confidence score rubric, Hyperedge rule, Node ID format rule, semantically_similar_to edge rule, Extraction subagent prompt template, DEEP_MODE flag, graph.json shrink guard (#479) (+8 more)

### Community 40 - "Readme"
Cohesion: 0.16
Nodes (15): Onboarding Wizard (Personalize + Plan Steps), v1.11: Seed Sample Invoice for New Orgs, v1.45: Check Scanning and Bill Application, docker-compose.yml (Local Postgres Stack), README.md (Project Overview), Architecture (Ingestion/Extraction/Matching Pipeline), Checks Pipeline Section, Demo Mode Section (+7 more)

### Community 41 - "Extraction"
Cohesion: 0.26
Nodes (13): clamp01(), cleanDate(), cleanNumber(), detectMultipleInvoicesHeuristic(), extract(), extractHeuristic(), extractionPrompt(), extractWithLlm() (+5 more)

### Community 42 - "Extraction Checks"
Cohesion: 0.27
Nodes (13): accountLast4(), CHECK_TOOL, clamp01(), cleanDate(), cleanNumber(), extract(), extractHeuristic(), extractionPrompt() (+5 more)

### Community 43 - "Rls"
Cohesion: 0.23
Nodes (14): enableRowLevelSecurity(), applyContext(), applyRlsPolicies(), clsNamespace, DERIVED_TABLES, DIRECT_ORG_TABLES, policyExpression(), rlsRequestContext() (+6 more)

### Community 44 - "Net Worth"
Cohesion: 0.17
Nodes (10): CATEGORY_KIND, NET_WORTH_CATEGORIES, NetWorthAccount, NetWorthEntry, createSchema, recordBalance(), router, todayIsoDate() (+2 more)

### Community 45 - "App"
Cohesion: 0.22
Nodes (14): approveLease(), deleteLease(), leaseCriticalDate(), leaseExpiryBadge(), leaseFieldConf(), loadLeasePreview(), loadLeases(), pollLeaseWhileProcessing() (+6 more)

### Community 46 - "App"
Cohesion: 0.20
Nodes (14): approveTaxDoc(), loadTaxDocPreview(), loadTaxDocs(), numOrNull(), pollTaxDocWhileProcessing(), rejectTaxDoc(), renderTaxDocDetail(), renderTaxDocs() (+6 more)

### Community 47 - "App"
Cohesion: 0.22
Nodes (14): fmtCompactMoney(), loadNetWorth(), nwAccountRow(), nwDeleteAccount(), nwFmtDate(), nwFmtDelta(), nwRenderAccounts(), nwRenderSummary() (+6 more)

### Community 48 - "Financial Statements"
Cohesion: 0.20
Nodes (6): requireAuth(), requireActivePlan(), router, router, router, settingsSchema

### Community 49 - "Extraction Leases"
Cohesion: 0.27
Nodes (12): clamp01(), cleanDate(), cleanNumber(), extract(), extractHeuristic(), extractionPrompt(), extractWithLlm(), FIELDS (+4 more)

### Community 50 - "Extraction Receipts"
Cohesion: 0.25
Nodes (12): CATEGORY_KEYWORDS, clamp01(), cleanDate(), cleanNumber(), extract(), extractHeuristic(), extractionPrompt(), extractWithLlm() (+4 more)

### Community 51 - "Export"
Cohesion: 0.20
Nodes (12): buildExpenseRows(), buildLeaseRows(), buildRows(), buildTaxDocumentRows(), buildVendorDocumentRows(), COLUMNS, EXPENSE_COLUMNS, LEASE_COLUMNS (+4 more)

### Community 52 - "Package"
Cohesion: 0.15
Nodes (13): dependencies, bcryptjs, cors, @google/genai, resend, stripe, zod, bcryptjs (+5 more)

### Community 53 - "Receivables Tests"
Cohesion: 0.17
Nodes (11): ClosePeriod, CustomerPayment, accountId(), orgId(), postEntry(), TODAY, accountId(), makeCustomer() (+3 more)

### Community 54 - "Check Pipeline"
Cohesion: 0.29
Nodes (7): effectiveConfidenceThreshold(), fail(), markFailedIfStuck(), processCheck(), FIELD_WEIGHT, AuditLog, Check

### Community 55 - "Staff"
Cohesion: 0.29
Nodes (9): activationFunnel(), bucketByWeek(), daysFromNow(), documentVolumeTrend(), isoDate(), orgIdsWithAnyDocument(), router, signupTrend() (+1 more)

### Community 56 - "Community 56"
Cohesion: 0.17
Nodes (12): Anti-Slop Frontend Skill (design-taste-frontend), AI Tells (Forbidden Patterns), The Block Library, Brief Inference / Design Read, Brief to Design System Map, Em-Dash Ban, Eyebrow Restraint Rule, Premium-Consumer Palette Ban (beige/brass/espresso) (+4 more)

### Community 57 - "App"
Cohesion: 0.27
Nodes (11): approveExpense(), expenseFieldConf(), loadExpenseDocPreview(), loadExpenses(), pollExpenseWhileProcessing(), rejectExpense(), renderExpenseDetail(), renderExpenses() (+3 more)

### Community 58 - "App"
Cohesion: 0.27
Nodes (11): approveVendorDoc(), expiryBadge(), loadVendorDocPreview(), loadVendorDocs(), pollVendorDocWhileProcessing(), rejectVendorDoc(), renderVendorDocDetail(), renderVendorDocs() (+3 more)

### Community 59 - "Changelog"
Cohesion: 0.20
Nodes (11): Google Site Verification File, App Shell (index.html), Topbar Navigation (Documents/Workflow/Receivables/Payables/Accounting/Admin menus), Privacy Policy Page, Terms of Service Page, v1.12: TOTP Two-Factor Authentication, v1.16: Staff Cross-Org Usage Dashboard, v1.18: Global Slow-Network Loading Indicator (+3 more)

### Community 60 - "Lease Pipeline"
Cohesion: 0.33
Nodes (6): settings, storageDir, effectiveConfidenceThreshold(), fail(), markFailedIfStuck(), processLease()

### Community 61 - "Pipeline"
Cohesion: 0.38
Nodes (7): effectiveConfidenceThreshold(), fail(), findDuplicateInvoice(), markFailedIfStuck(), processInvoice(), shouldAutoApprove(), shouldSampleForQa()

### Community 62 - "Expense Pipeline"
Cohesion: 0.29
Nodes (6): FIELD_WEIGHT, score(), effectiveConfidenceThreshold(), fail(), markFailedIfStuck(), processExpense()

### Community 63 - "Vendor Doc Pipeline"
Cohesion: 0.29
Nodes (6): FIELD_WEIGHT, score(), effectiveConfidenceThreshold(), fail(), markFailedIfStuck(), processVendorDocument()

### Community 64 - "Revenue Recognition Tests"
Cohesion: 0.27
Nodes (8): RevenueScheduleEntry, accountId(), makeCustomer(), makeInvoice(), orgId(), pnl(), send(), trialBalance()

### Community 65 - "Claude"
Cohesion: 0.20
Nodes (10): v1.28: Move High-Frequency Facts into CLAUDE.md, v1.53: Install graphify Knowledge-Graph Skill, v1.7: Correct Neon RLS Documentation, CLAUDE.md (Repo Working Instructions), Rekono Claude Config, graphify Skill Routing Rules, Shipping Workflow (Rebase, Squash-Merge, Commit Autonomy), Version Numbering Convention (+2 more)

### Community 66 - "Design"
Cohesion: 0.24
Nodes (10): v1.36: New Visual Identity (Workpaper Redesign), v1.37: Revert to Bitter/Blue Palette, v1.41: Product and Marketing Layout Width Pass, DESIGN.md (Design System), Three Accent Tokens for WCAG Contrast Compliance, Editorial/Technical Aesthetic Direction, Accent Color Token System (--accent/--accent-ink/--accent-text), Design Decisions Log (+2 more)

### Community 67 - "Manifest"
Cohesion: 0.22
Nodes (8): background_color, description, display, icons, name, short_name, start_url, theme_color

### Community 68 - "Jobs"
Cohesion: 0.36
Nodes (8): drain(), enqueue(), PROCESSORS, queue, recoverOrphanedJobs(), recoverOrphanedJobsInContext(), runWithSystemContext(), twoOrgsWithAnInvoiceEach()

### Community 69 - "Leases"
Cohesion: 0.22
Nodes (6): correctionSchema, FIELD_TO_ATTR, router, SORTABLE_FIELDS, serializeLeaseDetail(), serializeLeaseListItem()

### Community 70 - "Vendor Documents"
Cohesion: 0.22
Nodes (6): correctionSchema, FIELD_TO_ATTR, router, SORTABLE_FIELDS, serializeVendorDocumentDetail(), serializeVendorDocumentListItem()

### Community 71 - "Changelog"
Cohesion: 0.22
Nodes (9): v1.20: Double-Entry General Ledger (Phase 1), v1.21: Financial Statements (P&L, Balance Sheet, Cash Flow), v1.30: Share Register / Cap Table, v1.31: Option Pool and Fully-Diluted Ownership, v1.32: Install ruflo Tooling via SessionStart Hook, v1.33: Stock Compensation Expense (ASC 718), v1.34: Income Tax Provision, v1.35: Close Automation Suggestions (+1 more)

### Community 72 - "Ci"
Cohesion: 0.22
Nodes (9): v1.52: Security Hardening Pass (Vulns, Docker Pin, CI, CodeQL), SQLite Test Gate (npm test), Dependabot Configuration, CI Workflow, Backend Tests Job (SQLite), Marketing Site Build Job, CodeQL Analysis Workflow, SECURITY.md (Security Policy) (+1 more)

### Community 73 - "Changelog"
Cohesion: 0.25
Nodes (9): v1.8: Marketing Site GitHub Pages to Vercel, v1.9: Vercel Speed Insights, Taste Skill Vendoring Notice, Leonxlnx/taste-skill (upstream repo), Build a $10K Website in Claude Code Guide, Marketing Site Entry (index.html), Marketing Site 404 Page, robots.txt (Marketing Site) (+1 more)

### Community 74 - "Manifest"
Cohesion: 0.22
Nodes (8): background_color, description, display, icons, name, short_name, start_url, theme_color

### Community 75 - "Package"
Cohesion: 0.25
Nodes (7): license, name, overrides, uuid, private, type, version

### Community 76 - "Confidence"
Cohesion: 0.43
Nodes (5): adjustmentsTotal(), CORE_FIELDS_WEIGHT, crossCheckTotal(), round2(), score()

### Community 77 - "Quick Review Tests"
Cohesion: 0.25
Nodes (4): LineItem, flaggedInvoice(), FULL_CONFIDENCE, orgId()

### Community 78 - "Tax Doc Pipeline"
Cohesion: 0.50
Nodes (5): TaxDocument, effectiveConfidenceThreshold(), fail(), markFailedIfStuck(), processTaxDocument()

### Community 79 - "Written Checks Tests"
Cohesion: 0.29
Nodes (6): accountId(), makeApprovedInvoice(), orgId(), TODAY, trialBalance(), writeCheckFor()

### Community 80 - "Package"
Cohesion: 0.29
Nodes (7): devDependencies, jest, @playwright/cli, supertest, jest, @playwright/cli, supertest

### Community 81 - "Confidence Tax Docs Tests"
Cohesion: 0.38
Nodes (5): FIELD_WEIGHT, score(), ALL_FIELDS, allAt(), makeResult()

### Community 82 - "Secret Box"
Cohesion: 0.38
Nodes (3): decrypt(), encrypt(), encryptionKey()

### Community 83 - "Ocr"
Cohesion: 0.76
Nodes (5): execFileAsync, extractFromImage(), extractFromPdf(), extractText(), OcrError

### Community 84 - "Sample Invoice Tests"
Cohesion: 0.38
Nodes (5): daysFromNow(), seedSampleInvoiceForNewOrg(), orgId(), personalization, signupNoCleanup()

### Community 85 - "Financial Statements Tests"
Cohesion: 0.53
Nodes (5): accountId(), orgId(), postEntry(), seedScenario(), TODAY

### Community 86 - "Income Statement Tests"
Cohesion: 0.47
Nodes (5): accountId(), incomeStatement(), postEntry(), TODAY, tradingOrg()

### Community 87 - "App"
Cohesion: 0.50
Nodes (5): loadOrgSettings(), loadQaSampleQueue(), renderOrgSettings(), renderQaSampleQueue(), submitQaReview()

### Community 88 - "Net Worth Tests"
Cohesion: 0.60
Nodes (4): createAccessToken(), hashPassword(), addTeammate(), orgIdFor()

### Community 90 - "Session Start"
Cohesion: 0.70
Nodes (4): bridge_chromium(), install_gstack(), install_ruflo(), session-start.sh script

### Community 91 - "Package"
Cohesion: 0.50
Nodes (4): scripts, dev, start, test

### Community 92 - "Github And Merge"
Cohesion: 0.50
Nodes (4): graphify clone <url>, graphify merge-graphs, Monorepo / multi-subfolder flow, Step 0: GitHub repos and multi-path merge

### Community 93 - "Skill"
Cohesion: 0.50
Nodes (4): Gemini semantic extraction backend, Step 1: Ensure graphify is installed, Step 2: Detect files, Step 3: Extract entities and relationships

### Community 94 - "Generate Sample Invoice"
Cohesion: 0.50
Nodes (3): Path, build_pdf(), Generates a sample invoice PDF for local demos/testing. Requires reportlab (not…

### Community 95 - "App"
Cohesion: 1.00
Nodes (3): deleteSource(), loadSources(), renderSources()

## Knowledge Gaps
- **454 isolated node(s):** `name`, `version`, `private`, `license`, `type` (+449 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 620 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **51 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `authHeader()` connect `Equity & Adjustments Tests` to `Revenue Recognition Tests`, `Express App Bootstrap & Security`, `DB Init & Org Isolation Tests`, `Quick Review Tests`, `Written Checks Tests`, `Sample Invoice Tests`, `Financial Statements Tests`, `Receivables Tests`, `Income Statement Tests`, `Net Worth Tests`, `Transaction Categorization`, `Billing`, `Payables Tests`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `AuditLog` connect `Check Pipeline` to `Express App Bootstrap & Security`, `Accounts Payable & Vendors`, `DB Init & Org Isolation Tests`, `Month-End Close Automation`, `Accounts Receivable & Revenue Recognition`, `Equity & Share Register`, `Auth, 2FA & Rate Limiting`, `Sequelize Models Index`, `Financial Statements Computation`, `General Ledger Core`, `Demo Data Seeding`, `Income Tax`, `Equity Awards`, `Transaction Categorization`, `Tax Documents`, `Payables Tests`, `Auth`, `Stock Compensation`, `Checks`, `Dashboard`, `Serializers`, `Invoices`, `Financial Statements`, `Staff`, `Lease Pipeline`, `Pipeline`, `Expense Pipeline`, `Vendor Doc Pipeline`, `Leases`, `Vendor Documents`, `Tax Doc Pipeline`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `LedgerError` connect `Equity & Share Register` to `Stock Compensation`, `Accounts Payable & Vendors`, `Checks`, `Month-End Close Automation`, `Accounts Receivable & Revenue Recognition`, `Financial Statements Computation`, `General Ledger Core`, `Income Tax`, `Equity Awards`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **Are the 65 inferred relationships involving `resetDb()` (e.g. with `accountOrdering.test.js` and `accountTaxonomy.test.js`) actually correct?**
  _`resetDb()` has 65 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _454 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Frontend Ledger Form Helpers` be split into smaller, more focused modules?**
  _Cohesion score 0.03144224196855776 - nodes in this community are weakly interconnected._
- **Should `Express App Bootstrap & Security` be split into smaller, more focused modules?**
  _Cohesion score 0.07027027027027027 - nodes in this community are weakly interconnected._