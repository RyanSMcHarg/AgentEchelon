#!/usr/bin/env npx ts-node
/**
 * TEMP: end-to-end router→tier-processor→channel-reply check against deployed
 * infra. Exercises the live runtime path the direct-invoke validation skips:
 * the shared router resolving the tier processor ARN from SSM and invoking it
 * async, the processor polling the placeholder and updating it in-channel.
 *
 * Mirrors prod timing: the router returns the "One moment…<!--corr:X-->"
 * placeholder text (which Lex posts in prod); here we post it ourselves right
 * after, and the processor's poll-with-retries finds it.
 *
 *   APP_INSTANCE_ARN=… BOT_ARN=… ROUTER_FN=… TIER=basic \
 *     AWS_PROFILE=… npx ts-node scripts/e2e-router-dispatch.ts
 */

import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  SendChannelMessageCommand,
  GetChannelMessageCommand,
  ListChannelMessagesCommand,
  DeleteChannelCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { randomUUID } from 'crypto';

const region = process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN!;
const BOT_ARN = process.env.BOT_ARN!;
const ROUTER_FN = process.env.ROUTER_FN!;
const TIER = process.env.TIER || 'basic';
const QUESTION = 'What products does the company offer? Keep it to 2 sentences.';

const chime = new ChimeSDKMessagingClient({ region });
const lambda = new LambdaClient({ region });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!APP_INSTANCE_ARN || !BOT_ARN || !ROUTER_FN) {
    throw new Error('Set APP_INSTANCE_ARN, BOT_ARN, ROUTER_FN');
  }
  console.log(`E2E router dispatch — tier=${TIER}\nQ: ${QUESTION}`);

  const ch = await chime.send(new CreateChannelCommand({
    AppInstanceArn: APP_INSTANCE_ARN,
    Name: `e2e-router-${TIER}-${Date.now()}`,
    Metadata: JSON.stringify({ modelTier: TIER }),
    Mode: 'RESTRICTED',
    Privacy: 'PRIVATE',
    ChimeBearer: BOT_ARN,
    ClientRequestToken: randomUUID(),
  }));
  const channelArn = ch.ChannelArn!;
  const messageId = randomUUID();

  // 1. Invoke the router exactly as Lex would (FallbackIntent fulfillment).
  const routerResp = await lambda.send(new InvokeCommand({
    FunctionName: ROUTER_FN,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify({
      inputTranscript: QUESTION,
      sessionState: { intent: { name: 'FallbackIntent' } },
      requestAttributes: {
        'CHIME.channel.arn': channelArn,
        'CHIME.sender.arn': `${APP_INSTANCE_ARN}/user/e2e-test-user`,
        'CHIME.message.id': messageId,
      },
    })),
  }));
  const routerOut = JSON.parse(Buffer.from(routerResp.Payload!).toString());
  const content: string = routerOut?.messages?.[0]?.content || '';
  const corr = content.match(/<!--corr:([^>]+)-->/)?.[1];
  console.log(`router replied: "${content.slice(0, 80)}"  (corr=${corr})`);
  if (!corr) {
    console.log('UNEXPECTED: router did not return a correlation marker ✗');
    await chime.send(new DeleteChannelCommand({ ChannelArn: channelArn, ChimeBearer: BOT_ARN }));
    process.exit(1);
  }

  // 2. Post the placeholder Lex would have posted, carrying the same corr.
  const ph = await chime.send(new SendChannelMessageCommand({
    ChannelArn: channelArn,
    Content: `One moment... <!--corr:${corr}-->`,
    Type: 'STANDARD',
    Persistence: 'PERSISTENT',
    ChimeBearer: BOT_ARN,
    ClientRequestToken: randomUUID(),
  }));
  const placeholderId = ph.MessageId!;

  // 3. Poll the placeholder for the processor's in-channel update.
  let reply = '';
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const msg = await chime.send(new GetChannelMessageCommand({
      ChannelArn: channelArn,
      MessageId: placeholderId,
      ChimeBearer: BOT_ARN,
    }));
    let c = (msg.ChannelMessage?.Content || '').replace(/<!--[^>]*-->/g, '');
    try { c = decodeURIComponent(c); } catch { /* raw */ }
    c = c.trim();
    if (c && !c.startsWith('One moment')) { reply = c; break; }
  }

  if (reply) {
    console.log(`\nbot reply (via router → ${TIER} tier processor → channel):\n${reply}\n`);
    console.log('EXPECTED: router dispatched to the tier processor and it replied in-channel ✓');
  } else {
    console.log('\nUNEXPECTED: placeholder never updated — router→processor dispatch may be broken ✗');
    // Dump recent messages for debugging.
    const list = await chime.send(new ListChannelMessagesCommand({ ChannelArn: channelArn, ChimeBearer: BOT_ARN, MaxResults: 5 }));
    console.log('recent messages:', (list.ChannelMessages || []).map((m) => (m.Content || '').slice(0, 60)));
  }

  await chime.send(new DeleteChannelCommand({ ChannelArn: channelArn, ChimeBearer: BOT_ARN }));
  console.log('done.');
  if (!reply) process.exit(1);
}

main().catch((e) => {
  console.error('e2e router dispatch failed:', e);
  process.exit(1);
});
