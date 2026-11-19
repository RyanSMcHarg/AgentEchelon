#!/usr/bin/env node
/**
 * Re-run the archival batches that failed every retry, from the archival dead-letter queue (Aurora mode).
 *
 * Usage, from backend/:
 *   AWS_PROFILE=<profile> node scripts/redrive-archival-dlq.mjs --dry-run         # what is queued, and whether it can be re-run
 *   AWS_PROFILE=<profile> node scripts/redrive-archival-dlq.mjs                   # re-run every batch the stream still holds
 *   AWS_PROFILE=<profile> node scripts/redrive-archival-dlq.mjs --discard-expired # also remove the ones it no longer holds
 *
 * Each message in the queue is a failed batch's position: its shard and its first and last sequence numbers. The
 * records are read back from the message stream by that range (GetRecords through the AWS CLI) and handed to the
 * archival function as the Kinesis event its event source would have sent, one synchronous invoke per hundred
 * records. A batch whose every invoke succeeds is deleted from the queue; one that fails again stays, with the
 * function's error printed, so the cause can be fixed and the script run again. The archival writes are
 * idempotent, so a batch that partly committed before failing lands on the rows it already wrote.
 *
 * The stream keeps a record for twenty-four hours, so a batch is re-runnable for twenty-four hours after its
 * records arrived. A batch the stream no longer holds is reported as expired and left in the queue, where it stays
 * as the record of what the projection is missing until `--discard-expired` removes it or the queue's
 * fourteen-day retention does. Its events are still in the S3 conversation archive.
 *
 * The queue and the function are found in this instance's Archive stack (`AE_STACK_PREFIX`, as every script
 * here); `--queue-url=` and `--function=` name them directly. Exits 1 when any batch could not be re-run.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';

const require = createRequire(import.meta.url);
const { resolveStackPrefix } = require('./lib/stack-lookup.cjs');
const { physicalIdsIn } = require('./lib/stack-resources.cjs');
const { batchOfDeadLetter, recordsOfBatch, kinesisEventOf, chunks } = require('./lib/archival-redrive.cjs');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dryRun = flag('dry-run');
const discardExpired = flag('discard-expired');

/** One AWS CLI call, as parsed JSON. UTF-8 output, so a non-ASCII value parses on Windows. */
function aws(cliArgs) {
  const out = execFileSync('aws', [...cliArgs, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out || '{}');
}

/** The queue URL and the archival function, from the flags or from this instance's Archive stack. */
async function resolveTargets() {
  let queueUrl = option('queue-url');
  let functionName = option('function');
  if (queueUrl && functionName) return { queueUrl, functionName };
  const cfn = new CloudFormationClient({ region: REGION });
  const stack = `${resolveStackPrefix(process.env)}Archive`;
  queueUrl ||= (await physicalIdsIn(cfn, [stack], { type: 'AWS::SQS::Queue', logicalId: /^ArchivalDeadLetterQueue/ }))[0];
  functionName ||= (await physicalIdsIn(cfn, [stack], { type: 'AWS::Lambda::Function', logicalId: /^ArchivalLambda/ }))[0];
  if (!queueUrl || !functionName) {
    throw new Error(`${stack} has no archival dead-letter queue or archival function; is this an Aurora-mode deployment?`);
  }
  return { queueUrl, functionName };
}

/** The records of the batch's shard from its first sequence number onward, until its last is passed. */
function readBatch(batch) {
  const streamName = batch.streamArn.split('/').pop();
  let iterator;
  try {
    iterator = aws([
      'kinesis', 'get-shard-iterator', '--stream-name', streamName, '--shard-id', batch.shardId,
      '--shard-iterator-type', 'AT_SEQUENCE_NUMBER', '--starting-sequence-number', batch.startSequenceNumber,
    ]).ShardIterator;
  } catch (err) {
    // A sequence number the stream has trimmed, or a shard that no longer exists.
    return { records: [], expired: true, reachedEnd: false, reason: String(err.stderr || err.message).trim() };
  }
  const read = [];
  for (let page = 0; iterator && page < 200; page++) {
    const res = aws(['kinesis', 'get-records', '--shard-iterator', iterator, '--limit', '1000']);
    read.push(...(res.Records || []));
    const sofar = recordsOfBatch(batch, read);
    if (sofar.reachedEnd) return sofar;
    if (!(res.Records || []).length && !res.MillisBehindLatest) break;
    iterator = res.NextShardIterator;
  }
  return recordsOfBatch(batch, read);
}

/** Hand the records to the archival function, a hundred at a time. Returns the first error, or null. */
async function rerun(lambda, functionName, batch, records) {
  for (const part of chunks(records, 100)) {
    const res = await lambda.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(kinesisEventOf(batch, part, REGION))),
    }));
    if (res.FunctionError) return Buffer.from(res.Payload || []).toString('utf8') || res.FunctionError;
  }
  return null;
}

async function main() {
  const { queueUrl, functionName } = await resolveTargets();
  const lambda = new LambdaClient({ region: REGION });
  console.log(`Queue: ${queueUrl}\nFunction: ${functionName}${dryRun ? '\n(dry run: nothing is invoked or deleted)' : ''}`);

  const seen = new Set();
  // Messages kept in the queue. They stay hidden while this run receives, so each is read once, and are made
  // visible again when it ends, so the queue depth (and its alarm) counts them at once.
  const leftInQueue = [];
  const tally = { rerun: 0, failed: 0, expired: 0, discarded: 0, unreadable: 0 };
  for (;;) {
    const { Messages = [] } = aws([
      'sqs', 'receive-message', '--queue-url', queueUrl, '--max-number-of-messages', '10',
      '--visibility-timeout', '900', '--wait-time-seconds', '2',
    ]);
    const fresh = Messages.filter((m) => !seen.has(m.MessageId));
    if (!fresh.length) break;
    for (const m of fresh) {
      seen.add(m.MessageId);
      const remove = () => aws(['sqs', 'delete-message', '--queue-url', queueUrl, '--receipt-handle', m.ReceiptHandle]);
      const release = () => leftInQueue.push(m.ReceiptHandle);
      const batch = batchOfDeadLetter(m.Body);
      if (!batch) {
        tally.unreadable++;
        release();
        console.log(`- ${m.MessageId}: not a Kinesis batch record; left in the queue.`);
        continue;
      }
      const label = `${batch.shardId} ${batch.startSequenceNumber}..${batch.endSequenceNumber} (failed ${batch.failedAt || 'at an unrecorded time'})`;
      const read = readBatch(batch);
      if (read.expired) {
        tally.expired++;
        if (discardExpired && !dryRun) {
          remove();
          tally.discarded++;
          console.log(`- ${label}: the stream no longer holds it; discarded.`);
        } else {
          release();
          console.log(`- ${label}: the stream no longer holds it; left in the queue.${read.reason ? ` (${read.reason})` : ''}`);
        }
        continue;
      }
      if (dryRun) {
        release();
        console.log(`- ${label}: ${read.records.length} record(s) re-runnable.`);
        continue;
      }
      const error = await rerun(lambda, functionName, batch, read.records);
      if (error) {
        tally.failed++;
        release();
        console.log(`- ${label}: failed again; left in the queue.\n  ${error}`);
        continue;
      }
      remove();
      tally.rerun++;
      console.log(`- ${label}: ${read.records.length} record(s) archived; removed from the queue.`);
    }
  }
  for (const handle of leftInQueue) {
    aws(['sqs', 'change-message-visibility', '--queue-url', queueUrl, '--receipt-handle', handle, '--visibility-timeout', '0']);
  }
  console.log(
    `\nRe-run: ${tally.rerun}. Failed again: ${tally.failed}. Expired: ${tally.expired}`
    + ` (discarded ${tally.discarded}). Not a batch record: ${tally.unreadable}.`,
  );
  if (tally.failed || (tally.expired && !discardExpired) || tally.unreadable) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
