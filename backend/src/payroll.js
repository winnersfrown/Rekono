// Payroll: records a pay run's numbers (computed elsewhere -- a real
// payroll provider or a spreadsheet) and posts the balanced journal entry
// they imply. See models/PayrollRun.js for the full accounting reasoning
// and the entry shape.
import { Account, JournalEntry, PayrollRun } from "./models/index.js";
import { LedgerError, postJournalEntry, voidJournalEntry } from "./ledger.js";

// A payroll run's accounts have to be real, org-owned, and the right
// shape for what they're used for -- same reasoning isValidPaymentAccount
// in accountsPayable.js exists: nothing stops a bad account id at the
// schema level, only a real check here does.
export function isValidExpenseAccount(account) {
  return Boolean(account) && account.type === "expense";
}

export function isValidLiabilityAccount(account) {
  return Boolean(account) && account.type === "liability";
}

export function isValidCashAccount(account) {
  return Boolean(account) && (account.type === "asset" || account.type === "liability");
}

export async function postPayrollRun(run, { postedByUserId = null, employeeName = "" } = {}) {
  const netPayCents =
    run.grossWagesCents -
    run.federalTaxWithheldCents -
    run.stateTaxWithheldCents -
    run.ficaEmployeeWithheldCents -
    run.otherDeductionsCents;
  if (netPayCents < 0) {
    throw new LedgerError("Withholding and deductions can't add up to more than gross wages.");
  }

  const employerTaxCents = run.employerFicaMatchCents + run.employerUnemploymentTaxCents;
  const liabilityCents =
    run.federalTaxWithheldCents +
    run.stateTaxWithheldCents +
    run.ficaEmployeeWithheldCents +
    run.otherDeductionsCents +
    employerTaxCents;

  const lines = [
    { accountId: run.wagesExpenseAccountId, debitCents: run.grossWagesCents },
  ];
  if (employerTaxCents > 0) {
    lines.push({ accountId: run.payrollTaxExpenseAccountId, debitCents: employerTaxCents });
  }
  if (netPayCents > 0) {
    lines.push({ accountId: run.paymentAccountId, creditCents: netPayCents });
  }
  if (liabilityCents > 0) {
    lines.push({ accountId: run.liabilityAccountId, creditCents: liabilityCents });
  }

  return postJournalEntry(run.orgId, {
    entryDate: run.payDate,
    memo: run.memo || `Payroll -- ${employeeName || "employee"}`,
    source: "payroll_run",
    sourceType: "payroll_run",
    sourceId: run.id,
    postedByUserId,
    lines,
  });
}

export async function voidPayrollRunEntry(orgId, payrollRunId, { postedByUserId = null } = {}) {
  const entry = await JournalEntry.findOne({
    where: { orgId, sourceType: "payroll_run", sourceId: payrollRunId, status: "posted" },
  });
  if (!entry) return null;
  return voidJournalEntry(orgId, entry.id, { postedByUserId });
}

// Creates the run and posts it, unwinding the row if the ledger refuses --
// same all-or-nothing shape as accountsPayable.js's recordBillPayment.
export async function recordPayrollRun(orgId, fields, { postedByUserId = null, employeeName = "" } = {}) {
  const run = await PayrollRun.create({ orgId, ...fields });
  try {
    await postPayrollRun(run, { postedByUserId, employeeName });
  } catch (err) {
    await run.destroy();
    throw err;
  }
  return run;
}

export function netPayCents(run) {
  return (
    run.grossWagesCents -
    run.federalTaxWithheldCents -
    run.stateTaxWithheldCents -
    run.ficaEmployeeWithheldCents -
    run.otherDeductionsCents
  );
}

export function employerTaxCents(run) {
  return run.employerFicaMatchCents + run.employerUnemploymentTaxCents;
}
