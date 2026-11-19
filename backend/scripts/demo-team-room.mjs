#!/usr/bin/env node
/**
 * THE OPERATIONS TEAM'S CONVERSATION, READY FOR A DEMO: its assistants re-added, so each one's welcome is said again
 * (demo/portable-assistants/WALKTHROUGH.md, "Before the demo").
 *
 * An assistant's welcome is its Amazon Lex `WelcomeIntent`, which Amazon Chime SDK fires when the assistant's AppInstanceBot
 * is added to a channel. This script removes every assistant from the classification's `ops-team` conversation, then asks
 * the conversation's own creator (`<prefix>Assistants-<classification>-TypedCreator`) to complete it, which adds them back in
 * the order creation does: the primary as a moderator, then the type's other assistants. The welcomes are the team conversation's
 * `welcome-ops-team` and Advisor's, as the assistants' active versions declare them. A conversation that does not stand yet is
 * created by the same call, so this also opens it. The people are not touched.
 *
 * Usage, from backend/:
 *   AWS_PROFILE=<profile> npm run demo:team-room             re-add the assistants to the ops team conversation
 *   AWS_PROFILE=<profile> npm run demo:team-room -- --dry-run   name the assistants it would re-add, and change nothing
 *   --classification=<name>   the conversation's classification (default: the one the `ops-team` type declares)
 */
import { createRequire } from 'node:module';
import { ChimeSDKMessagingClient, ListChannelMembershipsCommand, DeleteChannelMembershipCommand, DescribeChannelCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const require = createRequire(import.meta.url);
const { resolveInstanceName, resolveStackPrefix } = require('./lib/stack-lookup.cjs');
const { appInstanceArnOf, botIdFromArn, isAssistantArn } = require('./lib/person-arn.cjs');

const region = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
// THE TYPE NAMES ITS CLASSIFICATION (`lib/config/conversation-types.ts`), so no classification is written here.
const { getConversationTypeConfig } = require('../lib/config/conversation-types.js');
const classification = argv.find((a) => a.startsWith('--classification='))?.split('=')[1] || getConversationTypeConfig('ops-team').classifications?.[0];
if (!classification) throw new Error('the ops-team type declares no classification; name one with --classification=<name>');
const instance = resolveInstanceName();
const prefix = resolveStackPrefix();

const ssm = new SSMClient({ region });
const chime = new ChimeSDKMessagingClient({ region });
const adminArn = (await ssm.send(new GetParameterCommand({ Name: `/${instance}/app-instance-admin-arn` }))).Parameter?.Value;
if (!adminArn) throw new Error(`/${instance}/app-instance-admin-arn is not set; is this the right instance?`);
const channelArn = `${appInstanceArnOf(adminArn)}/channel/team-ops-team-${classification}`;
const creator = `${prefix}Assistants-${classification}-TypedCreator`;

/** The conversation's assistants: its AppInstanceBot members. Null when the conversation does not stand yet. */
async function assistantsIn() {
  try {
    await chime.send(new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: adminArn }));
  } catch (err) {
    if (['NotFoundException', 'ForbiddenException'].includes(err?.name)) return null;
    throw err;
  }
  const bots = [];
  let NextToken;
  do {
    const r = await chime.send(new ListChannelMembershipsCommand({ ChannelArn: channelArn, ChimeBearer: adminArn, MaxResults: 50, NextToken }));
    for (const m of r.ChannelMemberships || []) if (isAssistantArn(m.Member?.Arn)) bots.push({ arn: m.Member.Arn, name: m.Member.Name || botIdFromArn(m.Member.Arn) });
    NextToken = r.NextToken;
  } while (NextToken);
  return bots;
}

const before = await assistantsIn();
console.log(`${channelArn}`);
console.log(before === null ? '  the conversation does not stand yet: completing it creates it, with its assistants' : `  assistants now: ${before.map((b) => b.name).join(', ') || 'none'}`);
if (dryRun) {
  console.log(`--dry-run: would remove ${before?.length ?? 0} assistant(s), then invoke ${creator} to add them back. Nothing changed.`);
  process.exit(0);
}

for (const b of before ?? []) {
  await chime.send(new DeleteChannelMembershipCommand({ ChannelArn: channelArn, MemberArn: b.arn, ChimeBearer: adminArn }));
  console.log(`  - removed ${b.name}`);
}

// THE CONVERSATION'S OWN CREATOR ADDS THEM BACK, the same call that opens it (demo/portable-assistants/README.md).
const payload = { detail: { conversationType: 'ops-team', forRole: 'on-call:ops', teamRoom: true } };
const out = await new LambdaClient({ region }).send(new InvokeCommand({ FunctionName: creator, Payload: Buffer.from(JSON.stringify(payload)) }));
const body = out.Payload ? Buffer.from(out.Payload).toString('utf8') : '';
if (out.FunctionError) throw new Error(`${creator} failed: ${body.slice(0, 400)}`);

const after = await assistantsIn();
console.log(`  assistants after: ${(after ?? []).map((b) => b.name).join(', ') || 'none'}`);
if (!after?.length) {
  console.error(`  ✗ the conversation has no assistant after ${creator} completed it: ${body.slice(0, 400)}`);
  process.exit(1);
}
console.log('  ✓ re-added; each assistant\'s welcome posts in the conversation within a few seconds.');
