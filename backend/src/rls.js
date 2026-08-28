// Database-level tenant isolation (Postgres only).
//
// Every route already scopes its queries by req.currentUser.orgId, and
// tests/orgIsolation.test.js locks that in. This is the layer underneath
// that: even a query that forgets its `where orgId` clause -- a new route, a
// refactor, a raw sequelize.query -- returns nothing instead of another
// tenant's rows, because Postgres itself filters them out.
//
// How the org is communicated to Postgres: each request runs inside one
// transaction, and that transaction sets two transaction-local GUCs
// (`SET LOCAL`, so they're discarded at commit/rollback and can never leak
// onto a pooled connection that a different request picks up next).
// Policies read them via current_setting(..., true), which returns NULL
// when unset -- and `"orgId" = NULL` is NULL, not true, so an unset context
// matches no rows. Fail-closed by construction, not by convention.
//
// Two contexts exist:
//   - system: the pre-auth substrate. Login has to find a user by email
//     before any org is known, signup creates the org itself, the Stripe
//     webhook arrives with no session, and boot-time job recovery sweeps
//     every tenant's stuck rows. These legitimately span orgs.
//   - org: everything after requireAuth resolves a user. This is where
//     essentially all customer data access happens, and where RLS earns
//     its keep.
//
// A request starts in system context and is narrowed to org context by
// requireAuth (see auth.js). Narrowing re-runs SET LOCAL on the same
// transaction, so there's exactly one transaction per request either way.
import { AsyncLocalStorage } from "node:async_hooks";
import { QueryTypes, Sequelize } from "sequelize";
import { sequelize } from "./db.js";

const ORG_GUC = "rekono.org_id";
const SYSTEM_GUC = "rekono.system";

// Tables whose rows carry an "orgId" column directly.
const DIRECT_ORG_TABLES = [
  "accounts",
  "audit_logs",
  "bill_payments",
  "close_periods",
  "close_tasks",
  "customer_invoices",
  "customer_payments",
  "customers",
  "dismissed_bank_transactions",
  "equity_transactions",
  "expense_receipts",
  "invites",
  "invoices",
  "journal_entries",
  "leases",
  "match_sources",
  "merchant_categories",
  "tax_documents",
  "transactions",
  "users",
  "vendor_aliases",
  "recurring_entries",
  "revenue_schedule_entries",
  "award_events",
  "equity_awards",
  "equity_plans",
  "share_classes",
  "shareholders",
  "share_transactions",
  "vendors",
  "vendor_documents",
  "vendor_expense_accounts",
];

// Tables with no orgId of their own, reached through a parent that has one.
// The EXISTS subquery is itself subject to the parent's policy, so these
// need no org predicate: if the parent row is invisible, so is the child.
const DERIVED_TABLES = {
  customer_invoice_lines: `EXISTS (SELECT 1 FROM customer_invoices p WHERE p.id = customer_invoice_lines."customerInvoiceId")`,
  recurring_entry_lines: `EXISTS (SELECT 1 FROM recurring_entries p WHERE p.id = recurring_entry_lines."recurringEntryId")`,
  journal_lines: `EXISTS (SELECT 1 FROM journal_entries p WHERE p.id = journal_lines."journalEntryId")`,
  line_items: `EXISTS (SELECT 1 FROM invoices p WHERE p.id = line_items."invoiceId")`,
  match_results: `EXISTS (SELECT 1 FROM invoices p WHERE p.id = match_results."invoiceId")`,
  match_entries: `EXISTS (SELECT 1 FROM match_sources p WHERE p.id = match_entries."sourceId")`,
  net_worth_accounts: `EXISTS (SELECT 1 FROM users p WHERE p.id = net_worth_accounts."userId")`,
  net_worth_entries: `EXISTS (SELECT 1 FROM net_worth_accounts p WHERE p.id = net_worth_entries."accountId")`,
};

const POLICY_NAME = "rekono_tenant_isolation";

const SYSTEM_ESCAPE = `current_setting('${SYSTEM_GUC}', true) = 'on'`;

function policyExpression(table) {
  const derived = DERIVED_TABLES[table];
  if (derived) return `${SYSTEM_ESCAPE} OR ${derived}`;
  if (table === "organizations") return `${SYSTEM_ESCAPE} OR id = current_setting('${ORG_GUC}', true)`;
  return `${SYSTEM_ESCAPE} OR "orgId" = current_setting('${ORG_GUC}', true)`;
}

export const RLS_TABLES = ["organizations", ...DIRECT_ORG_TABLES, ...Object.keys(DERIVED_TABLES)];

export function rlsSupported() {
  return sequelize.getDialect() === "postgres";
}

// Sequelize needs a CLS namespace to attach the ambient transaction to
// every query automatically -- without it each route would have to thread a
// `{ transaction }` option through every single call. Node's built-in
// AsyncLocalStorage does the job; Sequelize only requires run/get/set/bind.
const storage = new AsyncLocalStorage();

export const clsNamespace = {
  run(fn) {
    const store = new Map();
    return storage.run(store, () => fn(store));
  },
  get(key) {
    return storage.getStore()?.get(key);
  },
  set(key, value) {
    storage.getStore()?.set(key, value);
    return value;
  },
  bind(fn) {
    const store = storage.getStore();
    return (...args) => storage.run(store ?? new Map(), () => fn(...args));
  },
};

let clsInstalled = false;

export function installCls() {
  if (clsInstalled) return;
  Sequelize.useCLS(clsNamespace);
  clsInstalled = true;
}

// `true` as set_config's third argument means SET LOCAL: scoped to the
// current transaction, reverted on commit/rollback.
async function applyContext({ orgId, system }, transaction) {
  await sequelize.query(`SELECT set_config('${SYSTEM_GUC}', $1, true), set_config('${ORG_GUC}', $2, true)`, {
    bind: [system ? "on" : "off", orgId ?? ""],
    transaction,
  });
}

// Narrows an already-open request transaction from system to org context.
export async function setOrgContext(orgId) {
  if (!rlsSupported()) return;
  const transaction = clsNamespace.get("transaction");
  if (!transaction) return;
  await applyContext({ orgId, system: false }, transaction);
}

function runInContext(context, fn) {
  if (!rlsSupported()) return fn();
  return sequelize.transaction(async (transaction) => {
    await applyContext(context, transaction);
    return fn();
  });
}

// Cross-tenant server-side work: login/signup lookups, the Stripe webhook,
// boot-time orphaned-job recovery. Never reachable from a request that has
// already been narrowed to an org.
export function runWithSystemContext(fn) {
  return runInContext({ system: true }, fn);
}

export function runWithOrgContext(orgId, fn) {
  return runInContext({ orgId, system: false }, fn);
}

// Opens the one transaction a request runs inside, in system context.
// requireAuth narrows it to a single org as soon as it knows which one.
//
// The transaction has to outlive the handler chain -- a route that writes
// and then streams a file is still inside it -- so it's held until the
// response is done. "finish" covers a normal response; "close" covers a
// client that hung up mid-response, which would otherwise strand the
// transaction and its pooled connection until the acquire timeout.
export function rlsRequestContext(req, res, next) {
  if (!rlsSupported()) return next();

  runWithSystemContext(
    () =>
      new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        res.once("finish", done);
        res.once("close", done);
        next();
      })
  ).catch(next);
}

export async function applyRlsPolicies() {
  if (!rlsSupported()) return { applied: 0 };

  const existingRows =
    (await sequelize.query(`SELECT tablename FROM pg_policies WHERE policyname = $1`, {
      type: QueryTypes.SELECT,
      bind: [POLICY_NAME],
    })) ?? [];
  const existing = new Set(existingRows.map((row) => row.tablename));

  let applied = 0;
  for (const table of RLS_TABLES) {
    const predicate = policyExpression(table);
    try {
      // FORCE matters as much as ENABLE here: without it Postgres exempts
      // the table's owner from its own policies, and the app connects as
      // the owner on every managed provider this deploys to (Neon, Render,
      // Supabase). ENABLE alone would look configured and enforce nothing.
      await sequelize.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await sequelize.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);

      // ALTER rather than DROP-then-CREATE when the policy is already
      // there. Between a drop and its recreate the table has row security
      // on and no policy at all, which denies everything -- on a rolling
      // deploy that window is a live instance serving empty results. ALTER
      // swaps the predicate in one statement, so there's never a moment
      // where the table is unprotected *or* fully closed.
      const verb = existing.has(table) ? `ALTER POLICY ${POLICY_NAME} ON ${table}` : `CREATE POLICY ${POLICY_NAME} ON ${table}`;
      await sequelize.query(`${verb} USING (${predicate}) WITH CHECK (${predicate})`);
      applied += 1;
    } catch (err) {
      // Render's rolling deploys start the new container while the old one
      // is still up, so two instances legitimately race this on every
      // deploy -- the same race models/index.js already tolerates for
      // sequelize.sync(). 42710 means the other one created this policy
      // between our pg_policies read and our CREATE, which is the outcome
      // we wanted anyway.
      const code = err?.parent?.code || err?.original?.code;
      if (code === "42710") {
        applied += 1;
        continue;
      }
      throw err;
    }
  }
  return { applied };
}

// Policies are inert against a superuser or a BYPASSRLS role -- Postgres
// skips row security for both, silently. That failure mode is worse than
// having no policies at all, because everything looks configured. Check the
// role the app actually connects as and say so plainly at boot.
export async function verifyRlsEffective() {
  if (!rlsSupported()) return { effective: false, reason: "not postgres" };

  // Never let this check itself be what stops the app from booting: it's a
  // diagnostic about a misconfiguration, and failing it closed would turn
  // "your role is wrong" into "your service is down".
  let row;
  try {
    [row] = (await sequelize.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`, {
      type: QueryTypes.SELECT,
    })) ?? [];
  } catch (err) {
    console.warn(`Could not determine whether row-level security is in effect: ${err.message}`);
    return { effective: false, reason: "unknown" };
  }

  if (row?.rolsuper || row?.rolbypassrls) {
    const why = row.rolsuper ? "a superuser" : "a BYPASSRLS role";
    console.error(
      `Row-level security is NOT in effect: the database user this app connects as is ${why}, ` +
        `and Postgres skips row security entirely for those. Tenant isolation is currently enforced only by ` +
        `application code. Connect as an ordinary (non-superuser, non-BYPASSRLS) role to activate it.`
    );
    return { effective: false, reason: why };
  }

  return { effective: true };
}
