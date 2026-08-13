// A minimal in-process async job queue -- Node's event loop plays the role
// the Python backend's dedicated worker thread did: `enqueue` pushes an id
// and lazily kicks off draining if nothing is already in flight. Swapping
// this for a real broker (BullMQ/Redis, SQS) later is a drop-in
// replacement behind `enqueue`.

import { processInvoice, markFailedIfStuck } from "./pipeline.js";
import { Invoice } from "./models/index.js";

const queue = [];
let processing = false;

export function enqueue(invoiceId) {
  queue.push(invoiceId);
  void drain();
}

async function drain() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      const invoiceId = queue.shift();
      try {
        await processInvoice(invoiceId);
      } catch (err) {
        console.error(`Unhandled error processing invoice ${invoiceId}`, err);
        try {
          await markFailedIfStuck(invoiceId, err);
        } catch (markErr) {
          console.error(`Also failed to mark invoice ${invoiceId} as failed`, markErr);
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
  const stuck = await Invoice.findAll({ where: { status: ["queued", "processing"] } });
  for (const invoice of stuck) {
    console.warn(`Recovering orphaned invoice ${invoice.id} (was "${invoice.status}" from a previous process)`);
    enqueue(invoice.id);
  }
  return stuck.length;
}
