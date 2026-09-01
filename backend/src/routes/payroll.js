// Employees and payroll runs -- see payroll.js for the accounting and why
// this records a pay run's numbers rather than computing withholding
// itself.
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { requireActivePlan } from "../plan.js";
import { Account, AuditLog, Employee, PayrollRun } from "../models/index.js";
import { LedgerError, centsToDollars, dollarsToCents } from "../ledger.js";
import {
  employerTaxCents,
  isValidCashAccount,
  isValidExpenseAccount,
  isValidLiabilityAccount,
  netPayCents,
  recordPayrollRun,
  voidPayrollRunEntry,
} from "../payroll.js";

const router = Router();

function serializeEmployee(e) {
  return { id: e.id, name: e.name, notes: e.notes, active: e.active };
}

function serializePayrollRun(run, employeeName) {
  return {
    id: run.id,
    employee_id: run.employeeId,
    employee_name: employeeName,
    pay_date: run.payDate,
    gross_wages: centsToDollars(run.grossWagesCents),
    federal_tax_withheld: centsToDollars(run.federalTaxWithheldCents),
    state_tax_withheld: centsToDollars(run.stateTaxWithheldCents),
    fica_employee_withheld: centsToDollars(run.ficaEmployeeWithheldCents),
    other_deductions: centsToDollars(run.otherDeductionsCents),
    employer_fica_match: centsToDollars(run.employerFicaMatchCents),
    employer_unemployment_tax: centsToDollars(run.employerUnemploymentTaxCents),
    net_pay: centsToDollars(netPayCents(run)),
    employer_tax_total: centsToDollars(employerTaxCents(run)),
    memo: run.memo,
    created_at: run.createdAt,
  };
}

// ---- Employees ----

router.get("/api/employees", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const employees = await Employee.findAll({ where: { orgId: req.currentUser.orgId }, order: [["name", "ASC"]] });
    res.json(employees.map(serializeEmployee));
  } catch (err) {
    next(err);
  }
});

const employeeCreateSchema = z.object({
  name: z.string().min(1).max(256),
  notes: z.string().max(2000).optional(),
});

router.post("/api/employees", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = employeeCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const employee = await Employee.create({
      orgId: req.currentUser.orgId,
      name: parsed.data.name,
      notes: parsed.data.notes || "",
    });

    await AuditLog.create({
      orgId: req.currentUser.orgId,
      userId: req.currentUser.id,
      action: "employee_added",
      actor: req.currentUser.email,
      details: { name: employee.name },
    });

    res.status(201).json(serializeEmployee(employee));
  } catch (err) {
    next(err);
  }
});

const employeeUpdateSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  notes: z.string().max(2000).optional(),
  active: z.boolean().optional(),
});

router.patch("/api/employees/:id", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = employeeUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });

    const employee = await Employee.findOne({ where: { id: req.params.id, orgId: req.currentUser.orgId } });
    if (!employee) return res.status(404).json({ detail: "Employee not found" });

    if (parsed.data.name !== undefined) employee.name = parsed.data.name;
    if (parsed.data.notes !== undefined) employee.notes = parsed.data.notes;
    if (parsed.data.active !== undefined) employee.active = parsed.data.active;
    await employee.save();

    res.json(serializeEmployee(employee));
  } catch (err) {
    next(err);
  }
});

// ---- Payroll runs ----

router.get("/api/payroll-runs", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const runs = await PayrollRun.findAll({ where: { orgId }, order: [["payDate", "DESC"], ["createdAt", "DESC"]] });
    const employees = await Employee.findAll({ where: { orgId } });
    const nameById = new Map(employees.map((e) => [e.id, e.name]));

    res.json(runs.map((run) => serializePayrollRun(run, nameById.get(run.employeeId) || "Unknown employee")));
  } catch (err) {
    next(err);
  }
});

const dollarsField = z.number().min(0).default(0);

const payrollRunSchema = z.object({
  employee_id: z.string().min(1),
  pay_date: z.string().min(1),
  gross_wages: z.number().positive(),
  federal_tax_withheld: dollarsField,
  state_tax_withheld: dollarsField,
  fica_employee_withheld: dollarsField,
  other_deductions: dollarsField,
  employer_fica_match: dollarsField,
  employer_unemployment_tax: dollarsField,
  payment_account_id: z.string().min(1),
  wages_expense_account_id: z.string().min(1),
  payroll_tax_expense_account_id: z.string().min(1),
  liability_account_id: z.string().min(1),
  memo: z.string().max(512).optional(),
});

router.post("/api/payroll-runs", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const parsed = payrollRunSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ detail: parsed.error.issues });
    const orgId = req.currentUser.orgId;
    const d = parsed.data;

    const employee = await Employee.findOne({ where: { id: d.employee_id, orgId } });
    if (!employee) return res.status(404).json({ detail: "Employee not found" });

    const [paymentAccount, wagesAccount, payrollTaxAccount, liabilityAccount] = await Promise.all([
      Account.findOne({ where: { id: d.payment_account_id, orgId } }),
      Account.findOne({ where: { id: d.wages_expense_account_id, orgId } }),
      Account.findOne({ where: { id: d.payroll_tax_expense_account_id, orgId } }),
      Account.findOne({ where: { id: d.liability_account_id, orgId } }),
    ]);
    if (!isValidCashAccount(paymentAccount)) {
      return res.status(422).json({ detail: "Payment account must be an asset or liability account you own." });
    }
    if (!isValidExpenseAccount(wagesAccount)) {
      return res.status(422).json({ detail: "Wages expense account must be an expense account you own." });
    }
    if (!isValidExpenseAccount(payrollTaxAccount)) {
      return res.status(422).json({ detail: "Payroll tax expense account must be an expense account you own." });
    }
    if (!isValidLiabilityAccount(liabilityAccount)) {
      return res.status(422).json({ detail: "Payroll liabilities account must be a liability account you own." });
    }

    const run = await recordPayrollRun(
      orgId,
      {
        employeeId: employee.id,
        payDate: d.pay_date,
        grossWagesCents: dollarsToCents(d.gross_wages),
        federalTaxWithheldCents: dollarsToCents(d.federal_tax_withheld),
        stateTaxWithheldCents: dollarsToCents(d.state_tax_withheld),
        ficaEmployeeWithheldCents: dollarsToCents(d.fica_employee_withheld),
        otherDeductionsCents: dollarsToCents(d.other_deductions),
        employerFicaMatchCents: dollarsToCents(d.employer_fica_match),
        employerUnemploymentTaxCents: dollarsToCents(d.employer_unemployment_tax),
        paymentAccountId: paymentAccount.id,
        wagesExpenseAccountId: wagesAccount.id,
        payrollTaxExpenseAccountId: payrollTaxAccount.id,
        liabilityAccountId: liabilityAccount.id,
        memo: d.memo || "",
      },
      { postedByUserId: req.currentUser.id, employeeName: employee.name }
    );

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "payroll_run_recorded",
      actor: req.currentUser.email,
      details: { employee: employee.name, gross_wages: d.gross_wages, pay_date: d.pay_date },
    });

    res.status(201).json(serializePayrollRun(run, employee.name));
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

router.post("/api/payroll-runs/:id/void", requireAuth, requireActivePlan, async (req, res, next) => {
  try {
    const orgId = req.currentUser.orgId;
    const run = await PayrollRun.findOne({ where: { id: req.params.id, orgId } });
    if (!run) return res.status(404).json({ detail: "Payroll run not found" });

    const reversal = await voidPayrollRunEntry(orgId, run.id, { postedByUserId: req.currentUser.id });
    if (!reversal) return res.status(409).json({ detail: "This payroll run was never posted, or is already voided." });

    await AuditLog.create({
      orgId,
      userId: req.currentUser.id,
      action: "payroll_run_voided",
      actor: req.currentUser.email,
      details: { payroll_run_id: run.id },
    });

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof LedgerError) return res.status(err.status).json({ detail: err.message });
    next(err);
  }
});

export default router;
