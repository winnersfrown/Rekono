// A minimal in-process async job queue -- Node's event loop plays the role
// the Python backend's dedicated worker thread did: `enqueue` pushes an id
// and lazily kicks off draining if nothing is already in flight. Swapping
// this for a real broker (BullMQ/Redis, SQS) later is a drop-in
// replacement behind `enqueue`.

import { processInvoice, markFailedIfStuck } from "./pipeline.js";

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
