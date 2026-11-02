#!/usr/bin/env node
/**
 * ONLY THE OWNERSHIP FUNCTION CAN WRITE `owner-team`, ON THE DEPLOYED POLICIES
 * (SPEC-ADMIN-CONSOLE FR47, acceptance criterion (i)).
 *
 * `every-tag-grant-excludes-ownership.test.ts` proves it at synthesis. This proves it against what IAM
 * actually holds: every role of the deployment is asked, through IAM's policy simulator, whether it may
 * `chime:TagResource` an assistant's bot with the `owner-team` key, and with an ordinary key beside it.
 * Exactly one role may write `owner-team`, the ownership function's, and the provisioners still tag.
 * Nobody may change a bot's `classification` to another value, while the conversation creator can still
 * tag the bearer it creates as, the service admin, and cannot tag a bot at all (it never creates as an
 * assistant).
 *
 * Scope: the roles in the deployment's stacks (or, with `DENY_TEST_ROLE_PREFIXES`, the roles whose names
 * start with those prefixes), one bot, and
 * the TagResource and UntagResource actions. Principals outside the deployment - account
 * administrators, single sign-on roles, the CDK bootstrap roles - are not this test's subject.
 *
 * Usage: AWS_PROFILE=... node scripts/deny-test-owner-team-tag.mjs
 * Needs: frontend/packages/admin/.env (for the app instance), and one assistant bot in it.
 */
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'node:module';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { listStackNames, instanceStacksAmong, physicalIdsIn, withNestedStacks } = require('./lib/stack-resources.cjs');
const { userArnFor } = require('./lib/person-arn.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
// An explicit list of role-name prefixes, when set. Otherwise the deployment's roles are the ones its stacks
// hold, read from the stacks rather than matched on generated names (scripts/lib/stack-resources.cjs).
const PREFIXES = process.env.DENY_TEST_ROLE_PREFIXES ? process.env.DENY_TEST_ROLE_PREFIXES.split(',') : null;

const env = {};
for (const line of fs.readFileSync(new URL('../../frontend/packages/admin/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const aws = (args) => JSON.parse(execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, MSYS_NO_PATHCONV: '1' },
}));
// THE SIMULATOR CALLS RUN A FEW AT A TIME. One at a time, the ~1,000 calls for a full deployment's roles
// outran a 15-minute budget; a small pool keeps the process count (one CLI each) modest.
const POOL = Number(process.env.DENY_TEST_CONCURRENCY || 4);
let running = 0;
const waiting = [];
const awsAsync = async (args) => {
  if (running >= POOL) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await new Promise((resolve, reject) => execFile('aws', [...args, '--region', REGION, '--output', 'json'], {
      // IAM throttles the simulator; adaptive retry backs off rather than failing the run.
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1', AWS_RETRY_MODE: 'adaptive', AWS_MAX_ATTEMPTS: '12' },
    }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out)))));
  } finally {
    running--;
    waiting.shift()?.();
  }
};

const bots = aws(['chime-sdk-identity', 'list-app-instance-bots', '--app-instance-arn', env.VITE_APP_INSTANCE_ARN]).AppInstanceBots ?? [];
if (!bots.length) { console.error('no AppInstanceBot to test against'); process.exit(2); }
const bot = bots[0].AppInstanceBotArn;

const stackRoles = PREFIXES ? null : await (async () => {
  const cfn = new CloudFormationClient({ region: REGION });
  const stacks = instanceStacksAmong(await listStackNames(cfn), resolveStackPrefix(process.env));
  // The ownership function's role sits in a nested stack, so the nested stacks are read too.
  return new Set(await physicalIdsIn(cfn, await withNestedStacks(cfn, stacks), { type: 'AWS::IAM::Role' }));
})();
const roles = aws(['iam', 'list-roles']).Roles
  .filter((r) => (PREFIXES ? PREFIXES.some((p) => r.RoleName.startsWith(p)) : stackRoles.has(r.RoleName)));
// The request as IAM sees it: the keys being written AND, for a tag write, each key's requested value.
// Without the value, a grant conditioned on `aws:RequestTag/<key>` is refused whether or not it excludes
// `owner-team`, and the check would pass for a reason that is not the one it claims.
const decide = async (arn, action, key, value) => (await awsAsync([
  'iam', 'simulate-principal-policy', '--policy-source-arn', arn, '--action-names', action,
  '--resource-arns', bot, '--context-entries',
  `ContextKeyName=aws:TagKeys,ContextKeyValues=${key},ContextKeyType=stringList`,
  ...(value ? [`ContextKeyName=aws:RequestTag/${key},ContextKeyValues=${value},ContextKeyType=string`] : []),
])).EvaluationResults[0].EvalDecision;

// WHICH ASSISTANT A BOT IS: `assistant` and `role`, written the way the provisioner writes them - beside
// the bot's own classification, on a bot already carrying it - so a correctly scoped provisioner is
// allowed and the check cannot pass merely because nothing could tag at all.
const botClass = (aws(['chime-sdk-identity', 'list-tags-for-resource', '--resource-arn', bot]).Tags ?? [])
  .find((t) => t.Key === 'classification')?.Value;
if (!botClass) { console.error(`${bot} carries no classification tag to test against`); process.exit(2); }
const decideIdentity = async (arn, key) => (await awsAsync([
  'iam', 'simulate-principal-policy', '--policy-source-arn', arn, '--action-names', 'chime:TagResource',
  '--resource-arns', bot, '--context-entries', JSON.stringify([
    { ContextKeyName: 'aws:TagKeys', ContextKeyValues: ['classification', key], ContextKeyType: 'stringList' },
    { ContextKeyName: 'aws:RequestTag/classification', ContextKeyValues: [botClass], ContextKeyType: 'string' },
    { ContextKeyName: `aws:RequestTag/${key}`, ContextKeyValues: ['another-assistant'], ContextKeyType: 'string' },
    { ContextKeyName: 'aws:ResourceTag/classification', ContextKeyValues: [botClass], ContextKeyType: 'string' },
  ]),
])).EvaluationResults[0].EvalDecision;
const identityWriters = { assistant: [], role: [] };

// A BOT'S CLASSIFICATION, which IAM evaluates for that assistant. Creating a channel
// with `Tags` while bearing a bot checks `chime:TagResource` on that bot, so creators may write a bot's
// classification as the value it already carries. Changing it to another value is nobody's to do.
const otherClass = botClass === 'premium' ? 'basic' : 'premium';
// The audience the bot's classification declares (`members` unless it is an outside classification's bot).
const BOT_AUDIENCE = process.env.DENY_TEST_BOT_AUDIENCE || 'members';
const decideClassification = async (arn, resource, value, current) => (await awsAsync([
  'iam', 'simulate-principal-policy', '--policy-source-arn', arn, '--action-names', 'chime:TagResource',
  '--resource-arns', resource, '--context-entries', JSON.stringify([
    { ContextKeyName: 'aws:TagKeys', ContextKeyValues: ['classification', 'audience'], ContextKeyType: 'stringList' },
    { ContextKeyName: 'aws:RequestTag/classification', ContextKeyValues: [value], ContextKeyType: 'string' },
    // A creator stamps the classification's audience in the same request, and its grant requires it.
    { ContextKeyName: 'aws:RequestTag/audience', ContextKeyValues: [BOT_AUDIENCE], ContextKeyType: 'string' },
    ...(current ? [{ ContextKeyName: 'aws:ResourceTag/classification', ContextKeyValues: [current], ContextKeyType: 'string' }] : []),
  ]),
])).EvaluationResults[0].EvalDecision;
const classificationChangers = [];
const bearerBotTaggers = [];
// AND THE CREATOR STILL REACHES THE SERVICE ADMIN IT BEARS, which is what a grant naming only channels
// refused on this deployment (2026-10-10): every conversation creation failed.
const serviceAdmin = userArnFor(env.VITE_APP_INSTANCE_ARN, process.env.DENY_TEST_SERVICE_ADMIN_ID || `${resolveInstanceName(process.env)}-admin`);
const serviceAdminTaggers = [];

const writers = [];
let tagging = 0;
await Promise.all(roles.map(async (r) => {
  const [tagOwner, untagOwner, ordinary, change, keep, admin, ...identity] = await Promise.all([
    decide(r.Arn, 'chime:TagResource', 'owner-team', 'ops'),
    decide(r.Arn, 'chime:UntagResource', 'owner-team'),
    decide(r.Arn, 'chime:TagResource', 'classification', 'premium'),
    decideClassification(r.Arn, bot, otherClass, botClass),
    decideClassification(r.Arn, bot, botClass, botClass),
    decideClassification(r.Arn, serviceAdmin, botClass),
    ...Object.keys(identityWriters).map((key) => decideIdentity(r.Arn, key)),
  ]);
  if (tagOwner === 'allowed' || untagOwner === 'allowed') writers.push(r.RoleName);
  if (ordinary === 'allowed') tagging++;
  Object.keys(identityWriters).forEach((key, i) => { if (identity[i] === 'allowed') identityWriters[key].push(r.RoleName); });
  if (change === 'allowed') classificationChangers.push(r.RoleName);
  if (keep === 'allowed') bearerBotTaggers.push(r.RoleName);
  if (admin === 'allowed') serviceAdminTaggers.push(r.RoleName);
}));

console.log(`roles checked: ${roles.length}; roles that may tag a bot with an ordinary key: ${tagging}`);
const failures = [];
if (roles.length < 10) failures.push(`only ${roles.length} roles matched ${PREFIXES ? PREFIXES.join(',') : "this deployment's stacks"}: the check would pass vacuously`);
if (writers.length !== 1 || !/AssistantOwnershipRole/.test(writers[0] ?? '')) {
  failures.push(`roles that may write owner-team: ${writers.join(', ') || 'none'} (expected exactly the ownership function's)`);
}
if (tagging === 0) failures.push('no role may tag a bot at all, so the provisioners can no longer classify an assistant');
for (const [key, who] of Object.entries(identityWriters)) {
  const others = who.filter((n) => !/CreateBot/i.test(n));
  if (others.length) failures.push(`roles other than a provisioner that may write ${key}: ${others.join(', ')}`);
  if (who.length === 0) failures.push(`no provisioner may write ${key} on a ${botClass} bot, so a new assistant could not be identified`);
}
// THE ONE RECORDED RESIDUAL: the `cdk-amazon-chime-resources` provider holds `chime:*` to create the
// app instance and runs only when CloudFormation deploys it (the synthesis test names it the same way).
// The role name is generated from the stack name (`<prefix>Messaging-CustomMessagingResourcesCusto-...`).
const DEPLOY_TIME_ONLY = /Messaging-CustomMessagingResources/;
const changers = classificationChangers.filter((n) => !DEPLOY_TIME_ONLY.test(n));
if (changers.length) {
  failures.push(`roles that may change a ${botClass} bot's classification to ${otherClass}: ${changers.join(', ')}`);
}
// THE CONVERSATION CREATOR NEVER CREATES AS AN ASSISTANT: with no service
// admin it refuses, so it holds no tag on a bot at all.
if (bearerBotTaggers.some((n) => /-ConversationCreator$/.test(n))) {
  failures.push(`the conversation creator may tag a ${botClass} bot, so it could still create as that assistant`);
}
if (!serviceAdminTaggers.some((n) => /-ConversationCreator$/.test(n))) {
  failures.push(`the conversation creator may not tag ${serviceAdmin}, so every conversation creation fails`);
}
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`only ${writers[0]} may write owner-team`);
for (const [key, who] of Object.entries(identityWriters)) console.log(`only provisioners may write ${key}: ${who.join(', ')}`);
console.log(`nobody may change a ${botClass} bot's classification to ${otherClass}, but the deploy-time provider: ${classificationChangers.filter((n) => DEPLOY_TIME_ONLY.test(n)).join(', ') || 'none'}`);
console.log(`may tag a ${botClass} bot with the classification it has (create-with-tags as that bot): ${bearerBotTaggers.join(', ')}`);
console.log(`may tag the service admin (create-with-tags as it): ${serviceAdminTaggers.join(', ')}`);
