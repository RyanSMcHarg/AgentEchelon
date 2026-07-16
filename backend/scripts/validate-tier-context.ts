#!/usr/bin/env npx ts-node
/**
 * Live validation: tier-scoped company-context (defense-in-depth).
 *
 * Confirms, against DEPLOYED infrastructure, that the assistant only surfaces
 * company documents the caller's tier is permitted to see. Company docs live
 * in the attachments bucket under context/{basic,standard,premium}/, and each
 * tier's async-processor Lambda has an S3 role scoped to its own prefixes:
 *
 *   basic    → context/basic/* only
 *   standard → context/basic/* + context/standard/*
 *   premium  → all three (incl. the premium-only financial docs)
 *
 * When the model calls the `load_company_context` tool mid-reply, S3 returns
 * only what that tier's role allows. So a financial question should yield:
 *
 *   basic   → cannot read context/premium/financial-data.json → declines /
 *             cites no figures
 *   premium → can read it → cites the specific financials
 *
 * How it works: per tier, create a real Chime channel, post the bot's
 * "one moment" placeholder (carrying the correlation marker the processor
 * polls for), invoke that tier's DEPLOYED async-processor with a financial
 * question, then read the updated placeholder and check for real dollar
 * figures. This exercises the actual processor, its tier-scoped role, S3, and
 * Bedrock — not mocks. Channels are deleted on the way out.
 *
 *   APP_INSTANCE_ARN=… BOT_ARN=… BASIC_FN=… PREMIUM_FN=… \
 *     AWS_PROFILE=… npx ts-node scripts/validate-tier-context.ts
 */

import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  SendChannelMessageCommand,
  GetChannelMessageCommand,
  DeleteChannelCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { randomUUID } from 'crypto';

const region = process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN!;
const BOT_ARN = process.env.BOT_ARN!;
const FN: Record<string, string> = {
  basic: process.env.BASIC_FN!,
  premium: process.env.PREMIUM_FN!,
};

const chime = new ChimeSDKMessagingClient({ region });
const lambda = new LambdaClient({ region });

const QUESTION = 'What was our Q2 revenue and ARR? Please cite the specific figures.';

async function runTier(tier: 'basic' | 'premium'): Promise<void> {
  const correlationId = randomUUID();
  console.log(`\n=== ${tier.toUpperCase()} ===`);

  // 1. real channel, created as the bot (the member the processor acts as)
  const ch = await chime.send(new CreateChannelCommand({
    AppInstanceArn: APP_INSTANCE_ARN,
    Name: `tier-context-validate-${tier}-${Date.now()}`,
    Mode: 'RESTRICTED',
    Privacy: 'PRIVATE',
    ChimeBearer: BOT_ARN,
    ClientRequestToken: randomUUID(),
  }));
  const channelArn = ch.ChannelArn!;

  // 2. placeholder the processor polls for (by correlation marker) and updates
  const ph = await chime.send(new SendChannelMessageCommand({
    ChannelArn: channelArn,
    Content: `One moment... <!--corr:${correlationId}-->`,
    Type: 'STANDARD',
    Persistence: 'PERSISTENT',
    ChimeBearer: BOT_ARN,
    ClientRequestToken: randomUUID(),
  }));
  const placeholderId = ph.MessageId!;

  // 3. invoke the deployed tier processor synchronously
  const t0 = Date.now();
  await lambda.send(new InvokeCommand({
    FunctionName: FN[tier],
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify({
      channelArn,
      correlationId,
      userMessage: QUESTION,
      userName: 'Validator',
      userType: tier,
      botArn: BOT_ARN,
      senderArn: BOT_ARN,
    })),
  }));
  const ms = Date.now() - t0;

  // 4. read the updated placeholder (Chime stores Content URL-encoded)
  const msg = await chime.send(new GetChannelMessageCommand({
    ChannelArn: channelArn,
    MessageId: placeholderId,
    ChimeBearer: BOT_ARN,
  }));
  const rawContent = (msg.ChannelMessage?.Content || '').replace(/<!--[^>]*-->/g, '');
  let reply = rawContent;
  try { reply = decodeURIComponent(rawContent); } catch { /* leave raw if not %-encoded */ }
  reply = reply.trim();

  console.log(`(${ms} ms) reply:\n${reply}\n`);
  // Dollar figures are the unambiguous signal: basic must have NONE (its role
  // can't read context/premium/financial-data.json); premium cites them.
  const figures = reply.match(/\$[\d][\d,.]*\s*[KMB]?/gi) || [];
  console.log(`dollar figures cited: ${figures.length}${figures.length ? ' -> ' + figures.slice(0, 6).join(', ') : ''}`);
  console.log(
    tier === 'premium'
      ? (figures.length >= 1 ? 'EXPECTED: premium cites financials ✓' : 'UNEXPECTED: premium did not cite financials ✗')
      : (figures.length === 0 ? 'EXPECTED: basic blocked from financials (no figures) ✓' : 'UNEXPECTED: basic surfaced figures ✗'),
  );

  // 5. cleanup
  await chime.send(new DeleteChannelCommand({ ChannelArn: channelArn, ChimeBearer: BOT_ARN }));
}

async function main(): Promise<void> {
  if (!APP_INSTANCE_ARN || !BOT_ARN || !FN.basic || !FN.premium) {
    throw new Error('Set APP_INSTANCE_ARN, BOT_ARN, BASIC_FN, PREMIUM_FN');
  }
  console.log('Tier-scoped company-context validation — deployed per-tier processors\nQ:', QUESTION);
  await runTier('basic');
  await runTier('premium');
  console.log('\ndone.');
}

main().catch((e) => {
  console.error('validation failed:', e);
  process.exit(1);
});
