#!/usr/bin/env node
/**
 * THE GUEST KILL SWITCH (L16): pause or resume guest start for a guest issuer, recording who changed it.
 *
 * The switch is an SSM parameter under the instance's `SSM_ROOT` (`/<instance>/guest/<issuer id>/paused`),
 * created off by the Identity stack. Guest start and guest refresh read it (cached for ten seconds) and
 * refuse with `paused` while it is on, and with `unavailable` when it cannot be read. This writes it with
 * the caller's IAM identity, the time and the reason; SSM's own parameter history records the principal of
 * every change too (`aws ssm get-parameter-history`).
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/guest-switch.mjs pause --reason "abuse from one network"
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/guest-switch.mjs resume --reason "cleared"
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/guest-switch.mjs status
 *
 * `--issuer <id>` names the guest issuer (default `guest`). A reason is required to change the switch.
 */
import { createRequire } from 'node:module';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const require = createRequire(import.meta.url);
const { resolveInstanceName } = require('./lib/stack-lookup.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const issuer = flag('issuer') || 'guest';
const reason = flag('reason');

if (!['pause', 'resume', 'status'].includes(command) || !/^[a-z][a-z0-9-]{0,31}$/.test(issuer)) {
  console.error('usage: guest-switch.mjs pause|resume|status [--issuer <id>] [--reason "<why>"]');
  process.exit(2);
}
const name = `/${resolveInstanceName(process.env)}/guest/${issuer}/paused`;
const ssm = new SSMClient({ region: REGION });

const current = await ssm.send(new GetParameterCommand({ Name: name })).then(
  (r) => r.Parameter?.Value,
  (err) => { console.error(`${name} could not be read: ${err?.name || err}`); process.exit(2); },
);
if (command === 'status') {
  console.log(`${name}: ${current}`);
  process.exit(0);
}
if (!reason || !reason.trim()) {
  console.error('a reason is required to change the kill switch (--reason "<why>")');
  process.exit(2);
}
const changedBy = (await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}))).Arn;
const value = JSON.stringify({ paused: command === 'pause', changedBy, changedAt: new Date().toISOString(), reason: reason.trim().slice(0, 200) });
await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: 'String', Overwrite: true }));
console.log(`${name}: ${current}\n  -> ${value}\nGuest start reads it within ten seconds.`);
