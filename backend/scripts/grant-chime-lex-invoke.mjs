#!/usr/bin/env node
/**
 * Grant Chime SDK Messaging permission to invoke the Lex bots.
 *
 * Amazon Chime SDK AppInstanceBots invoke their configured Lex bot via the
 * bot-ALIAS ARN. For that to succeed, BOTH the Lex bot AND the bot-alias need a
 * resource policy allowing `messaging.chime.amazonaws.com` to call `lex:*`,
 * scoped to this app instance. Without it, every bot message comes back as
 * `{"Code":403}` (Chime can't invoke Lex). See docs/TROUBLESHOOTING.md.
 *
 * create-lex-bot.ts now does this automatically on bot creation; this script
 * patches EXISTING bots (e.g. after a teardown/redeploy left bots without the
 * policy). Idempotent — replaces the policy if one already exists.
 *
 * Usage:
 *   AWS_PROFILE=<p> node backend/scripts/grant-chime-lex-invoke.mjs <botId> [botId...]
 *   (alias defaults to TSTALIASID; override with LEX_ALIAS_ID)
 */
import {
  LexModelsV2Client,
  CreateResourcePolicyCommand,
  UpdateResourcePolicyCommand,
} from '@aws-sdk/client-lex-models-v2';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const region = process.env.AWS_REGION || 'us-east-1';
const account = process.env.AWS_ACCOUNT_ID;
const aliasId = process.env.LEX_ALIAS_ID || 'TSTALIASID';
const lex = new LexModelsV2Client({ region });
const cfn = new CloudFormationClient({ region });

const botIds = process.argv.slice(2);
if (botIds.length === 0) {
  console.error('Usage: node grant-chime-lex-invoke.mjs <botId> [botId...]');
  process.exit(1);
}

async function getAppInstanceArn() {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: 'AgentEchelonChimeMessaging' }));
  const o = {};
  for (const x of r.Stacks?.[0]?.Outputs || []) if (x.OutputKey && x.OutputValue) o[x.OutputKey] = x.OutputValue;
  return o['AppInstanceArnOutput'] || o['AppInstanceArn'];
}

function policyFor(resourceArn, appInstanceArn, acct) {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowChimeMessagingToInvokeLex',
        Effect: 'Allow',
        Principal: { Service: 'messaging.chime.amazonaws.com' },
        Action: 'lex:*',
        Resource: resourceArn,
        Condition: {
          StringEquals: { 'AWS:SourceAccount': acct },
          // ArnLike (not ArnEquals) so the app-instance/bot/* wildcard matches.
          ArnLike: { 'AWS:SourceArn': `${appInstanceArn}/bot/*` },
        },
      },
    ],
  });
}

async function apply(resourceArn, policy) {
  try {
    await lex.send(new CreateResourcePolicyCommand({ resourceArn, policy }));
    console.log(`  + policy created: ${resourceArn}`);
  } catch (err) {
    if (err.name === 'PreconditionFailedException' || err.name === 'ResourceConflictException' || /already/i.test(err.message || '')) {
      await lex.send(new UpdateResourcePolicyCommand({ resourceArn, policy }));
      console.log(`  ~ policy replaced: ${resourceArn}`);
    } else {
      throw err;
    }
  }
}

async function main() {
  const acct = account || (await getAppInstanceArn())?.split(':')[4];
  const appInstanceArn = await getAppInstanceArn();
  if (!appInstanceArn || !acct) throw new Error('Could not resolve app instance ARN / account.');
  console.log(`appInstance=${appInstanceArn}`);
  for (const botId of botIds) {
    const botArn = `arn:aws:lex:${region}:${acct}:bot/${botId}`;
    const aliasArn = `arn:aws:lex:${region}:${acct}:bot-alias/${botId}/${aliasId}`;
    console.log(`bot ${botId}:`);
    await apply(botArn, policyFor(botArn, appInstanceArn, acct));
    await apply(aliasArn, policyFor(aliasArn, appInstanceArn, acct));
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error('grant-chime-lex-invoke failed:', e);
  process.exit(1);
});
