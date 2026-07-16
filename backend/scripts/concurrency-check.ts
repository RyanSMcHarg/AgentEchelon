#!/usr/bin/env npx ts-node
/**
 * TEMP: higher-concurrency latency check for a deployed tier async-processor
 * (ADR-011 caveat — the spike + tier-context validation were low-concurrency).
 *
 * Fires N concurrent RequestResponse invocations of the processor, each with
 * its own placeholder (carrying the correlation marker the processor polls
 * for) in a shared channel, then reports the latency distribution + any
 * throttle/error count. Exercises the real Converse tool-loop turn under load.
 *
 *   APP_INSTANCE_ARN=… BOT_ARN=… FN=<tier processor name> N=20 \
 *     AWS_PROFILE=… npx ts-node scripts/concurrency-check.ts
 */

import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  SendChannelMessageCommand,
  DeleteChannelCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { randomUUID } from 'crypto';

const region = process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN!;
const BOT_ARN = process.env.BOT_ARN!;
const FN = process.env.FN!;
const N = parseInt(process.env.N || '20', 10);
const QUESTION = 'Give me a concise 2-sentence overview of the company.';

const chime = new ChimeSDKMessagingClient({ region });
const lambda = new LambdaClient({ region });

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main(): Promise<void> {
  if (!APP_INSTANCE_ARN || !BOT_ARN || !FN) {
    throw new Error('Set APP_INSTANCE_ARN, BOT_ARN, FN');
  }
  console.log(`Concurrency check: N=${N} concurrent invocations of ${FN}`);

  const ch = await chime.send(new CreateChannelCommand({
    AppInstanceArn: APP_INSTANCE_ARN,
    Name: `concurrency-check-${Date.now()}`,
    Mode: 'RESTRICTED',
    Privacy: 'PRIVATE',
    ChimeBearer: BOT_ARN,
    ClientRequestToken: randomUUID(),
  }));
  const channelArn = ch.ChannelArn!;

  // Pre-create N placeholders (one per invocation, unique correlation marker).
  const corrIds: string[] = [];
  for (let i = 0; i < N; i++) {
    const correlationId = randomUUID();
    corrIds.push(correlationId);
    await chime.send(new SendChannelMessageCommand({
      ChannelArn: channelArn,
      Content: `One moment... <!--corr:${correlationId}-->`,
      Type: 'STANDARD',
      Persistence: 'PERSISTENT',
      ChimeBearer: BOT_ARN,
      ClientRequestToken: randomUUID(),
    }));
  }

  // Fire all N concurrently, measure each round-trip.
  const results = await Promise.all(corrIds.map(async (correlationId) => {
    const t0 = Date.now();
    try {
      const resp = await lambda.send(new InvokeCommand({
        FunctionName: FN,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify({
          channelArn,
          correlationId,
          userMessage: QUESTION,
          userName: 'LoadTest',
          userType: process.env.USER_TYPE || 'standard',
          botArn: BOT_ARN,
          senderArn: BOT_ARN,
        })),
      }));
      const ms = Date.now() - t0;
      const errored = resp.FunctionError != null;
      return { ms, errored };
    } catch (err) {
      return { ms: Date.now() - t0, errored: true, err: (err as Error).name };
    }
  }));

  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const errors = results.filter((r) => r.errored);
  console.log(`\nresults (${results.length} invocations):`);
  console.log(`  errors:   ${errors.length}${errors.length ? ' -> ' + JSON.stringify(errors.slice(0, 5)) : ''}`);
  console.log(`  min:  ${latencies[0]} ms`);
  console.log(`  p50:  ${pct(latencies, 50)} ms`);
  console.log(`  p95:  ${pct(latencies, 95)} ms`);
  console.log(`  max:  ${latencies[latencies.length - 1]} ms`);

  await chime.send(new DeleteChannelCommand({ ChannelArn: channelArn, ChimeBearer: BOT_ARN }));
  console.log('\ndone.');
}

main().catch((e) => {
  console.error('concurrency check failed:', e);
  process.exit(1);
});
