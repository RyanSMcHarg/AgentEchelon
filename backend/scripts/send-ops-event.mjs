#!/usr/bin/env node
/**
 * PUT THE PLATFORM'S OPS EVENT ON THE BUS, so an `ops` conversation opens for the person it names.
 *
 * The `ops` conversation type declares that `ae.ops` / `Incident opened` opens it (`openedBy`,
 * `lib/config/event-openers.ts`), and the premium classification stack builds the rule that hands the event
 * to its typed-conversation creator. This script is the sender: what an alerting pipeline or an on-call tool
 * puts on the bus, and what the presenter fires on cue in the demo (DEMO-AND-VALIDATION.md, "An ops event
 * opens a room").
 *
 * The event names the person (by email address, as the deployment's own pool holds it, or by AppInstanceUser
 * ARN), the conversation it concerns, a label and a one-line summary. It names no classification and no
 * conversation type: the rule decides the type, and the creator creates at the classification it was
 * deployed with. The creator then welcomes the person, and everyone the `ops` group admits, into the new
 * room, and each welcome is emailed with a link into it, from the room's assistant.
 *
 * Usage:
 *   node scripts/send-ops-event.mjs --concerns <channel ARN> [--for <email | person ARN>]
 *     [--title "Report latency"] [--summary "Report generation is running slow."] [--alarm <alarm name>] [--service <service>] [--bus default] [--dry-run]
 *
 *   --concerns  the conversation the incident concerns, at the `ops` type's classification (the operations
 *               team's standing room). Required: an `ops` room concerns another.
 *   --for       the person the room is for. Default: the demo cast's on-call lead, read from the demo secret
 *               (DEMO_SECRET_NAME, default agent-interface/demo-credentials).
 *   --alarm     the CloudWatch alarm the incident is about. The room watches it: each state change the alarm
 *               makes runs the room assistant's `alarm-state-changed` workflow there (ADR-061, the incident watch).
 *   --dry-run   print the entry and send nothing.
 *
 * The instance is the deployment's (AE_INSTANCE_NAME, as every operator script resolves it), and the rule
 * matches that instance only. Needs `events:PutEvents` on the default bus.
 */
import { createRequire } from 'node:module';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const require = createRequire(import.meta.url);
const { resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { opsEventEntry } = require('./lib/ops-event.cjs');

const region = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';

function args(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const take = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--concerns') out.concerns = take();
    else if (a === '--for') out.forPerson = take();
    else if (a === '--title') out.title = take();
    else if (a === '--summary') out.summary = take();
    else if (a === '--alarm') out.alarm = take();
    else if (a === '--service') out.service = take();
    else if (a === '--bus') out.bus = take();
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/** An address shown with its local part hidden, so a run on camera does not print a login. */
const masked = (v) => (v.includes('@') ? `${v[0]}***@${v.split('@')[1]}` : v.replace(/[^/]{6}$/, '******'));

async function demoLead() {
  const name = process.env.DEMO_SECRET_NAME || 'agent-interface/demo-credentials';
  const res = await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: name }));
  const email = JSON.parse(res.SecretString || '{}')?.onCallLead?.email;
  if (!email) throw new Error(`the ${name} secret names no onCallLead; pass --for, or run: npm run provision-test-users -- --cast ops-demo`);
  return email;
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (opts.help) {
    console.log('node scripts/send-ops-event.mjs --concerns <channel ARN> [--for <email | person ARN>] [--title ...] [--summary ...] [--alarm <alarm name>] [--service <service>] [--bus default] [--dry-run]');
    return;
  }
  if (!opts.concerns) throw new Error('--concerns <channel ARN> is required: an ops room concerns another conversation');
  const forPerson = opts.forPerson || await demoLead();
  const entry = opsEventEntry({
    instance: resolveInstanceName(process.env),
    forPerson,
    concernedChannelArn: opts.concerns,
    topicLabel: opts.title || 'Report latency',
    summary: opts.summary || 'Report generation is running slow.',
    ...(opts.alarm ? { alarmName: opts.alarm } : {}),
    ...(opts.service ? { service: opts.service } : {}),
    eventBusName: opts.bus || 'default',
  });
  if (opts.dryRun) {
    console.log('Dry run: this entry would be put on the bus, and nothing was sent.');
    console.log(JSON.stringify({ ...entry, Detail: JSON.parse(entry.Detail) }, null, 2));
    return;
  }
  const res = await new EventBridgeClient({ region }).send(new PutEventsCommand({ Entries: [entry] }));
  const [result] = res.Entries || [];
  if (res.FailedEntryCount || !result?.EventId) {
    throw new Error(`the bus refused the event: ${result?.ErrorCode || 'unknown'} ${result?.ErrorMessage || ''}`.trim());
  }
  console.log(`Sent ${entry.Source} / ${entry.DetailType} (event ${result.EventId}) for ${masked(forPerson)}.`);
  console.log('The ops room opens within seconds, and its people are emailed a link into it by the room\'s assistant.');
  console.log('If nothing opens, read the creator\'s log (TypedConversationFromEvent): a refusal names its reason.');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
