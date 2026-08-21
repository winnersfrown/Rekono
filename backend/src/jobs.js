// A minimal in-process async job queue -- Node's event loop plays the role
// the Python backend's dedicated worker thread did: `enqueue` pushes an id
// and lazily kicks off draining if nothing is already in flight. Swapping
// this for a real broker (BullMQ/Redis, SQS) later is a drop-in
// replacement behind `enqueue`.
//
// One queue, four document kinds: `kind` picks which pipeline processes a
// given id (invoices, expense receipts, vendor documents, leases -- see
// pipeline.js/expensePipeline.js/vendorDocPipeline.js/leasePipeline.js).
// Kept as one shared queue/drain loop rather than separate ones per kind --
// there's nothing kind-specific about ordering or concurrency here, just
// which processor a given id's job hands off to.

import { processInvoice, markFailedIfStuck as markInvoiceFailedIfStuck } from "./pipeline.js";
import { processExpense, markFailedIfStuck as markExpenseFailedIfStuck } from "./expensePipeline.js";
import { processVendorDocument, markFailedIfStuck as markVendorDocFailedIfStuck } from "./vendorDocPipeline.js";
import { processLease, markFailedIfStuck as markLeaseFailedIfStuck } from "./leasePipeline.js";
import { Invoice, ExpenseReceipt, VendorDocument, Lease } from "./models/index.js";

const PROCESSORS = {
  invoice: { process: processInvoice, markFailedIfStuck: markInvoiceFailedIfStuck },
  expense: { process: processExpense, markFailedIfStuck: markExpenseFailedIfStuck },
  vendor_document: { process: processVendorDocument, markFailedIfStuck: markVendorDocFailedIfStuck },
  lease: { process: processLease, markFailedIfStuck: markLeaseFailedIfStuck },
};

const queue = [];
let processing = false;

export function enqueue(id, kind = "invoice") {
  queue.push({ id, kind });
  void drain();
}

async function drain() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      const { id, kind } = queue.shift();
      const { process, markFailedIfStuck } = PROCESSORS[kind];
      try {
        await process(id);
      } catch (err) {
        console.error(`Unhandled error processing ${kind} ${id}`, err);
        try {
          await markFailedIfStuck(id, err);
        } catch (markErr) {
          console.error(`Also failed to mark ${kind} ${id} as failed`, markErr);
        }
      }
    }
  } finally {
    processing = false;
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
export async function recoverOrphanedJobs() {
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

  return stuckInvoices.length + stuckReceipts.length + stuckVendorDocs.length + stuckLeases.length;
}
