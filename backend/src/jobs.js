// A minimal in-process async job queue by default -- Node's event loop
// plays the role the Python backend's dedicated worker thread did:
// `enqueue` pushes an id and lazily kicks off draining if nothing is
// already in flight. Switches to Amazon SQS when AWS_SQS_QUEUE_URL is set
// (config.js) -- see README.md's "Scaling past one instance" section:
// this in-process queue only exists on the one instance it's running in,
// so a second instance added purely for request capacity would drain a
// separate, empty queue of its own rather than sharing the work.
//
// One queue, five document kinds: `kind` picks which pipeline processes a
// given id (invoices, expense receipts, vendor documents, leases, tax
// documents -- see pipeline.js/expensePipeline.js/vendorDocPipeline.js/
// leasePipeline.js/taxDocPipeline.js). Kept as one shared queue/drain loop
// rather than separate ones per kind -- there's nothing kind-specific
// about ordering or concurrency here, just which processor a given id's
// job hands off to. Same for the SQS mode: one queue URL, one message
// shape ({id, kind}), for the same reason.

import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { settings } from "./config.js";
import { processInvoice, markFailedIfStuck as markInvoiceFailedIfStuck } from "./pipeline.js";
import { processExpense, markFailedIfStuck as markExpenseFailedIfStuck } from "./expensePipeline.js";
import { processVendorDocument, markFailedIfStuck as markVendorDocFailedIfStuck } from "./vendorDocPipeline.js";
import { processLease, markFailedIfStuck as markLeaseFailedIfStuck } from "./leasePipeline.js";
import { processTaxDocument, markFailedIfStuck as markTaxDocFailedIfStuck } from "./taxDocPipeline.js";
import { Invoice, ExpenseReceipt, VendorDocument, Lease, TaxDocument } from "./models/index.js";
import { runWithOrgContext, runWithSystemContext } from "./rls.js";

function sqsConfigured() {
  return Boolean(settings.awsSqsQueueUrl);
}

let sqsClient = null;
function sqs() {
  if (!sqsClient) sqsClient = new SQSClient({ region: settings.awsRegion });
  return sqsClient;
}

const PROCESSORS = {
  invoice: { process: processInvoice, markFailedIfStuck: markInvoiceFailedIfStuck, model: Invoice },
  expense: { process: processExpense, markFailedIfStuck: markExpenseFailedIfStuck, model: ExpenseReceipt },
  vendor_document: { process: processVendorDocument, markFailedIfStuck: markVendorDocFailedIfStuck, model: VendorDocument },
  lease: { process: processLease, markFailedIfStuck: markLeaseFailedIfStuck, model: Lease },
  tax_document: { process: processTaxDocument, markFailedIfStuck: markTaxDocFailedIfStuck, model: TaxDocument },
};

const queue = [];
let processing = false;
let draining = null;

export function enqueue(id, kind = "invoice") {
  if (sqsConfigured()) {
    void sqs()
      .send(new SendMessageCommand({ QueueUrl: settings.awsSqsQueueUrl, MessageBody: JSON.stringify({ id, kind }) }))
      .catch((err) => console.error(`Failed to enqueue ${kind} ${id} to SQS:`, err.message));
    return;
  }
  queue.push({ id, kind });
  draining = drain();
  void draining;
}

// Resolves once nothing is queued or in flight. Uploading returns to the
// caller the moment the job is queued, so without this there's no way to
// know when the work behind it has actually finished -- which callers that
// need a settled database (a shutdown path, a test resetting its schema)
// otherwise have to guess at with a sleep. Local-queue-only: in SQS mode
// `draining` is never set (enqueue takes the branch above instead), so this
// already resolves immediately -- there's no equivalent "empty" signal for
// a shared external queue that could be mid-flight on another instance.
export function whenIdle() {
  return draining ?? Promise.resolve();
}

// The actual per-job work, shared by both the local drain loop below and
// the SQS consumer -- resolving org context and the fail-if-unhandled
// safety net are the same regardless of which queue handed the job over.
async function processJob(id, kind) {
  const { process, markFailedIfStuck, model } = PROCESSORS[kind];

  // A job runs outside any request, so it starts with no database tenant
  // context at all -- and under row-level security that means it can see
  // nothing. Resolve which org the record belongs to first (system
  // context, since that lookup is the thing that answers the question),
  // then run the pipeline itself scoped to just that org, so a job stays
  // as confined as the request that queued it.
  const orgId = await runWithSystemContext(async () => {
    const record = await model.findByPk(id, { attributes: ["orgId"] });
    return record?.orgId ?? null;
  });

  if (!orgId) {
    console.error(`Skipping ${kind} ${id}: no such record (deleted before it was processed?)`);
    return;
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

async function drain() {
  if (processing) return draining;
  processing = true;
  try {
    while (queue.length) {
      const { id, kind } = queue.shift();
      await processJob(id, kind);
    }
  } finally {
    processing = false;
    draining = null;
  }
}

export function queueDepth() {
  return queue.length;
}

let sqsPollingStarted = false;

// Long-polls the shared SQS queue for work. Call once at boot (server.js);
// a no-op unless AWS_SQS_QUEUE_URL is set. Every app instance runs this
// same loop, so scaling horizontally -- the entire point of switching off
// the in-process queue -- naturally spreads jobs across instances: SQS's
// own visibility timeout keeps two instances from picking up the same
// message at once, and deleting a message only after processJob resolves
// (success or a handled failure) means a crash mid-job leaves the message
// to reappear and retry on whichever instance receives it next, rather
// than silently vanishing.
export function startSqsConsumer() {
  if (!sqsConfigured() || sqsPollingStarted) return;
  sqsPollingStarted = true;
  void pollSqs();
}

async function pollSqs() {
  for (;;) {
    await pollSqsOnce();
  }
}

// One receive-process-delete cycle, pulled out of pollSqs's infinite loop
// so it has something callable in isolation -- both by that loop and by
// tests, which have no safe way to exercise a genuinely infinite `for(;;)`.
export async function pollSqsOnce() {
  let result;
  try {
    result = await sqs().send(
      new ReceiveMessageCommand({
        QueueUrl: settings.awsSqsQueueUrl,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: 20, // long polling -- avoids hammering SQS with empty receives
        VisibilityTimeout: 300, // generous: OCR plus an LLM round trip can take a while
      })
    );
  } catch (err) {
    console.error("SQS receive failed, retrying shortly:", err.message);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return;
  }

  for (const message of result.Messages || []) {
    const { id, kind } = JSON.parse(message.Body);
    await processJob(id, kind);
    await sqs()
      .send(new DeleteMessageCommand({ QueueUrl: settings.awsSqsQueueUrl, ReceiptHandle: message.ReceiptHandle }))
      .catch((err) => console.error(`Failed to delete processed SQS message for ${kind} ${id}:`, err.message));
  }
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
//
// Skipped entirely in SQS mode: a message that never gets deleted (because
// the instance that received it died mid-job) already becomes receivable
// again once its visibility timeout expires, and lands on whichever
// instance polls next -- SQS's own redelivery is the correct replacement
// for exactly the failure mode this function patches over on the local
// queue. Also scanning the DB here would risk enqueueing the same record a
// second time while the original message is still just waiting out its
// timeout, not actually lost.
export function recoverOrphanedJobs() {
  if (sqsConfigured()) return Promise.resolve(0);
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

  return stuckInvoices.length + stuckReceipts.length + stuckVendorDocs.length + stuckLeases.length + stuckTaxDocs.length;
}
