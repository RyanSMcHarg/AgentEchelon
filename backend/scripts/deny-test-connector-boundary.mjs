#!/usr/bin/env node
/**
 * DENY-TEST: THE CONNECTOR RUNTIME REACHES ONLY WHAT IT IS FOR (the boundary row: E13, K3).
 *
 * The connector roles trust only Lambda and cannot be assumed here, so each DEPLOYED role (read from the
 * `Connectors` stack's resources) is evaluated by IAM itself, through `iam:SimulatePrincipalPolicy`, which
 * applies the role's attached and inline policies exactly as a request from it would be. Every row below
 * must be denied:
 *
 *   1. Any Amazon Chime SDK channel action - post, add or remove a member, create a channel - on any
 *      channel of this app instance. A connector posts nothing and changes no membership.
 *   2. `Identities` written in any way: `PutItem`, `UpdateItem`, `DeleteItem`. A connector names a person
 *      and never authenticates or mints one (K1).
 *   3. A secret that is not one of its own connectors': another connector id's OAuth client secret, and an
 *      unrelated secret under the same instance prefix. The receiver reads no secret at all.
 *   4. The grants key used outside DynamoDB without the grant encryption context (`purpose=connector-grant`),
 *      or with another purpose: the key seals grants and nothing else.
 *   5. `events:PutEvents` for any source but the role's own (`ae.connector` for the receiver, `ae.alert`
 *      for the revoker).
 *
 * The control: each role's own reach is ALLOWED - the receiver's replay write, the grant routes' seal under
 * the grant context, the revoker's alert. A role that the simulator denies everything would pass the
 * rows above while proving nothing, so a denied control fails the run.
 *
 * A simulation, not a live request: it proves what IAM decides for these roles, which is the boundary; the
 * live event path is `deny-test-connector-events.mjs`.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/deny-test-connector-boundary.mjs
 *
 * Exit 0 = every refusal held; 1 = a gap; 2 = a setup error.
 */
import { createRequire } from 'node:module';
import { CloudFormationClient, DescribeStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { connectorSecretNames } = require('../lib/config/connectors.js');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const RES_PREFIX = resolveInstanceName(process.env);

const cfn = new CloudFormationClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const sts = new STSClient({ region: REGION });

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };

async function resourcesOf(stack) {
  return (await cfn.send(new DescribeStackResourcesCommand({ StackName: stack }))).StackResources || [];
}

async function simulate(roleArn, action, resource, context = []) {
  const r = await iam.send(new SimulatePrincipalPolicyCommand({
    PolicySourceArn: roleArn,
    ActionNames: [action],
    ResourceArns: [resource],
    ContextEntries: context,
  }));
  return r.EvaluationResults?.[0]?.EvalDecision || 'unknown';
}

async function expectDenied(label, roleArn, action, resource, context) {
  const d = await simulate(roleArn, action, resource, context);
  d === 'allowed' ? fail(`${label}: ${action} on ${resource} is ALLOWED`) : pass(`${label}: ${action} denied (${d})`);
}

async function expectAllowed(label, roleArn, action, resource, context) {
  const d = await simulate(roleArn, action, resource, context);
  d === 'allowed' ? pass(`CONTROL ${label}: ${action} allowed`) : fail(`CONTROL ${label}: ${action} on ${resource} is ${d}; the refusals prove nothing`);
}

const ctx = (key, value) => ({ ContextKeyName: key, ContextKeyValues: [value], ContextKeyType: 'string' });

async function main() {
  const account = (await sts.send(new GetCallerIdentityCommand({}))).Account;
  const connectors = await resourcesOf(`${PREFIX}Connectors`);
  const identity = await resourcesOf(`${PREFIX}Identity`);
  const messaging = (await cfn.send(new DescribeStacksCommand({ StackName: `${PREFIX}Messaging` }))).Stacks?.[0]?.Outputs || [];
  const appInstanceArn = messaging.find((o) => /AppInstanceArn/.test(o.OutputKey || ''))?.OutputValue;
  const identitiesTable = identity.find((r) => r.ResourceType === 'AWS::DynamoDB::Table' && /Identities/.test(r.LogicalResourceId))?.PhysicalResourceId;
  if (!appInstanceArn || !identitiesTable) { console.error('could not read the app instance or the Identities table'); process.exit(2); }
  const roleArn = (logical) => {
    const r = connectors.find((x) => x.ResourceType === 'AWS::IAM::Role' && x.LogicalResourceId.startsWith(logical));
    return r ? `arn:aws:iam::${account}:role/${r.PhysicalResourceId}` : null;
  };
  const roles = {
    receiver: roleArn('ConnectorEventReceiverRole'),
    grantRoutes: roleArn('ConnectorGrantRoutesRole'),
    revoker: roleArn('ConnectorGrantRevokerRole'),
  };
  const present = Object.entries(roles).filter(([, arn]) => arn);
  if (!present.length) { console.error('the Connectors stack has no connector role'); process.exit(2); }
  const keyId = connectors.find((r) => r.ResourceType === 'AWS::KMS::Key')?.PhysicalResourceId;
  const keyArn = keyId ? `arn:aws:kms:${REGION}:${account}:key/${keyId}` : null;
  const replayTable = connectors.find((r) => r.ResourceType === 'AWS::DynamoDB::Table' && /ConnectorReplay/.test(r.LogicalResourceId))?.PhysicalResourceId;
  const tableArn = (name) => `arn:aws:dynamodb:${REGION}:${account}:table/${name}`;
  const secretArn = (name) => `arn:aws:secretsmanager:${REGION}:${account}:secret:${name}-AbCdEf`;
  const other = connectorSecretNames(RES_PREFIX, 'deny-test-other');

  for (const [label, arn] of present) {
    console.log(`${label} (${arn})`);
    for (const action of ['chime:SendChannelMessage', 'chime:CreateChannelMembership', 'chime:DeleteChannelMembership', 'chime:CreateChannel']) {
      await expectDenied(label, arn, action, `${appInstanceArn}/channel/deny-test`);
    }
    for (const action of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem']) {
      await expectDenied(label, arn, action, tableArn(identitiesTable));
    }
    await expectDenied(label, arn, 'secretsmanager:GetSecretValue', secretArn(other.oauthClient));
    await expectDenied(label, arn, 'secretsmanager:GetSecretValue', secretArn(`${RES_PREFIX}/analytics-db/master`));
    if (keyArn) {
      await expectDenied(label, arn, 'kms:Decrypt', keyArn, [ctx('kms:EncryptionContext:purpose', 'something-else')]);
      await expectDenied(label, arn, 'kms:Decrypt', keyArn);
    }
    await expectDenied(label, arn, 'events:PutEvents', `arn:aws:events:${REGION}:${account}:event-bus/default`, [ctx('events:source', 'aws.deny-test')]);
  }

  if (roles.receiver && replayTable) await expectAllowed('receiver', roles.receiver, 'dynamodb:PutItem', tableArn(replayTable));
  if (roles.grantRoutes && keyArn) await expectAllowed('grant routes', roles.grantRoutes, 'kms:Encrypt', keyArn, [ctx('kms:EncryptionContext:purpose', 'connector-grant')]);
  if (roles.revoker) await expectAllowed('revoker', roles.revoker, 'events:PutEvents', `arn:aws:events:${REGION}:${account}:event-bus/default`, [ctx('events:source', 'ae.alert')]);

  console.log(failures.length ? `\n${failures.length} gap(s)` : '\nevery refusal held');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  // CloudFormation answers a stack that is not deployed with a ValidationError ("Stack with id X does not exist").
  // `Connectors` is a declared capability, so its absence means this instance does not declare connectors.
  if (err?.name === 'ValidationError' && /does not exist/.test(err.message || '')) {
    const missing = /Stack with id (\S+) does not exist/.exec(err.message)?.[1] || 'a stack';
    console.error(`setup error: ${missing} is not deployed${missing === `${PREFIX}Connectors` ? '; this instance declares no connectors capability' : ''}`);
  } else {
    console.error('setup error:', err?.name || err, err?.message || '');
  }
  process.exit(2);
});
