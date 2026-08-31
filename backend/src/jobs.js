// A minimal in-process async job queue -- Node's event loop plays the role
// the Python backend's dedicated worker thread did: `enqueue` pushes an id
// and lazily kicks off draining if nothing is already in flight. Swapping
// this for a real broker (BullMQ/Redis, SQS) later is a drop-in
// replacement behind `enqueue`.
//
// One queue, five document kinds: `kind` picks which pipeline processes a
// given id (invoices, expense receipts, vendor documents, leases, tax
// documents -- see pipeline.js/expensePipeline.js/vendorDocPipeline.js/
// leasePipeline.js/taxDocPipeline.js). Kept as one shared queue/drain loop
// rather than separate ones per kind -- there's nothing kind-specific
// about ordering or concurrency here, just which processor a given id's
// job hands off to.

import { processInvoice, markFailedIfStuck as markInvoiceFailedIfStuck } from "./pipeline.js";
import { processExpense, markFailedIfStuck as markExpenseFailedIfStuck } from "./expensePipeline.js";
import { processVendorDocument, markFailedIfStuck as markVendorDocFailedIfStuck } from "./vendorDocPipeline.js";
import { processLease, markFailedIfStuck as markLeaseFailedIfStuck } from "./leasePipeline.js";
import { processTaxDocument, markFailedIfStuck as markTaxDocFailedIfStuck } from "./taxDocPipeline.js";
import { processCheck, markFailedIfStuck as markCheckFailedIfStuck } from "./checkPipeline.js";
import { Invoice, ExpenseReceipt, VendorDocument, Lease, TaxDocument, Check } from "./models/index.js";
import { runWithOrgContext, runWithSystemContext } from "./rls.js";

const PROCESSORS = {
  invoice: { process: processInvoice, markFailedIfStuck: markInvoiceFailedIfStuck, model: Invoice },
  expense: { process: processExpense, markFailedIfStuck: markExpenseFailedIfStuck, model: ExpenseReceipt },
  vendor_document: { process: processVendorDocument, markFailedIfStuck: markVendorDocFailedIfStuck, model: VendorDocument },
  lease: { process: processLease, markFailedIfStuck: markLeaseFailedIfStuck, model: Lease },
  tax_document: { process: processTaxDocument, markFailedIfStuck: markTaxDocFailedIfStuck, model: TaxDocument },
  check: { process: processCheck, markFailedIfStuck: markCheckFailedIfStuck, model: Check },
};

const queue = [];
let processing = false;
let draining = null;

export function enqueue(id, kind = "invoice") {
  queue.push({ id, kind });
  draining = drain();
  void draining;
}

// Resolves once nothing is queued or in flight. Uploading returns to the
// caller the moment the job is queued, so without this there's no way to
// know when the work behind it has actually finished -- which callers that
// need a settled database (a shutdown path, a test resetting its schema)
// otherwise have to guess at with a sleep.
export function whenIdle() {
  return draining ?? Promise.resolve();
}

async function drain() {
  if (processing) return draining;
  processing = true;
  try {
    while (queue.length) {
      const { id, kind } = queue.shift();
      const { process, markFailedIfStuck, model } = PROCESSORS[kind];

      // A job runs outside any request, so it starts with no database
      // tenant context at all -- and under row-level security that means it
      // can see nothing. Resolve which org the record belongs to first
      // (system context, since that lookup is the thing that answers the
      // question), then run the pipeline itself scoped to just that org, so
      // a job stays as confined as the request that queued it.
      const orgId = await runWithSystemContext(async () => {
        const record = await model.findByPk(id, { attributes: ["orgId"] });
        return record?.orgId ?? null;
      });

      if (!orgId) {
        console.error(`Skipping ${kind} ${id}: no such record (deleted before it was processed?)`);
        continue;
      }

      try {
        await runWithOrgContext(orgId, () => process(id));
      } catch (err) {
        console.error(`Unhandled error processing ${kind} ${id}`, err);
        try {
          await runWithOrgContext(orgId, () => markFailedIfStuck(id, err));
        } catch (markErr) {
          console.error(`Also failed to mark ${kind} ${id} as failed`, markErr);
        }
      }
    }
  } finally {
    processing = false;
    draining = null;
  }
}

export function queueDepth() {
  return queue.length;
}

// This queue is purely in-process/in-memory -- it doesn't survive a
// restart. If the process is killed or redeployed while an invoice is
// "queued" or "processing", that record is orphaned: the DB still says it's
// mid-pipeline, but the job that was going to move it forward is gone, so
// without this it would stay "processing" forever with nothing watching it.
// Call once at boot, after the DB connection is up, to pick those back up --
// each one re-runs the normal pipeline, which already handles a source file
// that didn't survive the restart (see pipeline.js's "File not found"
// handling) by failing cleanly with a re-upload prompt instead of hanging.
// Deliberately cross-tenant: this sweeps whatever the previous process left
// mid-pipeline, for every org at once, before any request has arrived to
// establish an org context.
export function recoverOrphanedJobs() {
  return runWithSystemContext(recoverOrphanedJobsInContext);
}

async function recoverOrphanedJobsInContext() {
  const stuckInvoices = await Invoice.findAll({ where: { status: ["queued", "processing"] } });
  for (const invoice of stuckInvoices) {
    console.warn(`Recovering orphaned invoice ${invoice.id} (was "${invoice.status}" from a previous process)`);
    enqueue(invoice.id, "invoice");
  }

  const stuckReceipts = await ExpenseReceipt.findAll({ where: { status: ["queued", "processing"] } });
  for (const receipt of stuckReceipts) {
    console.warn(`Recovering orphaned receipt ${receipt.id} (was "${receipt.status}" from a previous process)`);
    enqueue(receipt.id, "expense");
  }

  const stuckVendorDocs = await VendorDocument.findAll({ where: { status: ["queued", "processing"] } });
  for (const doc of stuckVendorDocs) {
    console.warn(`Recovering orphaned vendor document ${doc.id} (was "${doc.status}" from a previous process)`);
    enqueue(doc.id, "vendor_document");
  }

  const stuckLeases = await Lease.findAll({ where: { status: ["queued", "processing"] } });
  for (const lease of stuckLeases) {
    console.warn(`Recovering orphaned lease ${lease.id} (was "${lease.status}" from a previous process)`);
    enqueue(lease.id, "lease");
  }

  const stuckTaxDocs = await TaxDocument.findAll({ where: { status: ["queued", "processing"] } });
  for (const doc of stuckTaxDocs) {
    console.warn(`Recovering orphaned tax document ${doc.id} (was "${doc.status}" from a previous process)`);
    enqueue(doc.id, "tax_document");
  }

  const stuckChecks = await Check.findAll({ where: { status: ["queued", "processing"] } });
  for (const check of stuckChecks) {
    console.warn(`Recovering orphaned check ${check.id} (was "${check.status}" from a previous process)`);
    enqueue(check.id, "check");
  }

  return (
    stuckInvoices.length +
    stuckReceipts.length +
    stuckVendorDocs.length +
    stuckLeases.length +
    stuckTaxDocs.length +
    stuckChecks.length
  );
}
