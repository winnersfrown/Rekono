// The SQS-backed job queue (jobs.js) that switches on when
// AWS_SQS_QUEUE_URL is configured -- see config.js's comment on why:
// the default in-process queue only exists on the one instance running
// it, so a second instance added purely for request capacity would drain
// its own separate, empty queue instead of sharing the work.
//
// settings.awsSqsQueueUrl is mutated directly rather than through
// process.env for the same reason storage.test.js and staff.test.js do --
// ES module imports are hoisted above the rest of a file's code, so a
// plain process.env assignment would run too late to affect config.js.
//
// pollSqsOnce (one receive-process-delete cycle) is tested directly rather
// than the pollSqs/startSqsConsumer wrapper around it: that wrapper is a
// genuine `for (;;)` loop meant to run for the lifetime of the process,
// and there's no safe way to let it run even once inside a test without
// either faking out setInterval-style control flow or risking a runaway
// async loop that outlives the test itself. This is the same shape of
// gap as googleAuth.test.js only covering Google OAuth down to its
// "not configured" redirect -- the actually-external-facing loop isn't
// exercised live, but every real decision inside one cycle of it is.
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { settings } from "../src/config.js";
import { enqueue, pollSqsOnce, queueDepth, recoverOrphanedJobs, whenIdle } from "../src/jobs.js";
import { Invoice } from "../src/models/index.js";
import { resetDb } from "./testUtils.js";

const sqsMock = mockClient(SQSClient);

beforeEach(async () => {
  await resetDb();
  sqsMock.reset();
  settings.awsSqsQueueUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/rekono-jobs";
  settings.awsRegion = "us-east-1";
});

afterEach(() => {
  settings.awsSqsQueueUrl = "";
});

test("enqueue sends to SQS instead of the local queue when configured", () => {
  sqsMock.on(SendMessageCommand).resolves({});

  enqueue("inv-123", "invoice");

  const calls = sqsMock.commandCalls(SendMessageCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input.QueueUrl).toBe(settings.awsSqsQueueUrl);
  expect(JSON.parse(calls[0].args[0].input.MessageBody)).toEqual({ id: "inv-123", kind: "invoice" });
  // Never touches the in-process queue in SQS mode -- two instances each
  // draining their own local queue is exactly the problem SQS mode exists
  // to avoid.
  expect(queueDepth()).toBe(0);
});

test("enqueue uses the local queue, not SQS, when AWS_SQS_QUEUE_URL is unset", () => {
  settings.awsSqsQueueUrl = "";
  enqueue("inv-local", "invoice");
  expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  return whenIdle();
});

test("recoverOrphanedJobs skips the DB scan entirely in SQS mode -- SQS's own visibility timeout is the replacement", async () => {
  await Invoice.create({
    orgId: "11111111111111111111111111111111",
    originalFilename: "test.pdf",
    storagePath: "/tmp/rekono-sqs-test-does-not-exist.pdf",
    contentType: "application/pdf",
    status: "processing",
  });

  const recoveredCount = await recoverOrphanedJobs();

  // Not 1, even though a genuinely orphaned-looking invoice exists --
  // proving this actually short-circuits rather than just finding nothing.
  expect(recoveredCount).toBe(0);
});

test("pollSqsOnce does nothing when the queue is empty", async () => {
  sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });
  await expect(pollSqsOnce()).resolves.toBeUndefined();
  expect(sqsMock.commandCalls(DeleteMessageCommand)).toHaveLength(0);
});

test("pollSqsOnce processes a received message and deletes it once handled", async () => {
  const invoice = await Invoice.create({
    orgId: "11111111111111111111111111111111",
    originalFilename: "test.pdf",
    storagePath: "/tmp/rekono-sqs-test-message-file.pdf",
    contentType: "application/pdf",
    status: "queued",
  });

  sqsMock.on(ReceiveMessageCommand).resolves({
    Messages: [
      {
        Body: JSON.stringify({ id: invoice.id, kind: "invoice" }),
        ReceiptHandle: "receipt-handle-1",
      },
    ],
  });
  sqsMock.on(DeleteMessageCommand).resolves({});

  await pollSqsOnce();

  const deleteCalls = sqsMock.commandCalls(DeleteMessageCommand);
  expect(deleteCalls).toHaveLength(1);
  expect(deleteCalls[0].args[0].input).toMatchObject({
    QueueUrl: settings.awsSqsQueueUrl,
    ReceiptHandle: "receipt-handle-1",
  });

  // The source file doesn't exist, so the pipeline fails it cleanly --
  // same processJob logic the local queue uses, just handed the id by SQS
  // instead of an in-memory array.
  await invoice.reload();
  expect(invoice.status).toBe("failed");
});

test("pollSqsOnce swallows a receive failure instead of throwing", async () => {
  sqsMock.on(ReceiveMessageCommand).rejects(new Error("simulated SQS outage"));
  await expect(pollSqsOnce()).resolves.toBeUndefined();
}, 10000);
