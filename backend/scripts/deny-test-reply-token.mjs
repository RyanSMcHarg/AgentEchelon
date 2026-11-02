#!/usr/bin/env node
/**
 * DENY-TEST: EMAIL GOES ONLY WITH CONSENT, AND MAIL WITHOUT A VALID REPLY TOKEN POSTS NOTHING (B9, B10).
 *
 * Against a DEPLOYED instance that declares `notifications` (configuration C3 and later). The inbound half
 * needs `replyDomain` and `replyRuleSet` deployed, the reply subdomain's MX record pointing at SES, and the
 * sender identity able to send to it; without them it says so and checks the rest.
 *
 *   1. THE PREFERENCE PAGE IS AUTHENTICATED BY ITS TOKEN. `GET` and a one-click `POST` of
 *      `/email/preferences` with a token this deployment never minted: refused (404), and nothing written.
 *   2. ITS ROLE REACHES ITS OWN RECORDS ONLY. `iam simulate-principal-policy`: the preference function's role
 *      may read an `unsubscribe#` token (the control) and is refused a `reply#` and an `invitation#` token,
 *      a person's profile item and a contact copy, and any SES send.
 *   3. THE POSTER HOLDS NO POST OF ITS OWN. The reply poster's role is refused `chime:SendChannelMessage`
 *      on its own credentials and every token write: it posts only on the person's pinned session.
 *   4. MAIL WITHOUT A VALID REPLY TOKEN POSTS NOTHING. Sent from the deployment's sender identity:
 *      a) to an address on the reply domain that carries no token;
 *      b) to a reply address with a token this deployment never minted;
 *      c) to a reply address with a VALID token, written to `Tokens` for a person who is a member of a test
 *         conversation, from an address that is not theirs: refused by the From check (or by DMARC, where
 *         the sender's domain publishes none).
 *      Each is refused in the poster's log by reason, and the conversation gains no message.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> \
 *   DENY_TEST_CHANNEL_ARN=<a test conversation> DENY_TEST_PERSON_ARN=<a member of it> \
 *   node backend/scripts/deny-test-reply-token.mjs
 *
 * Exit 0 = every refusal held; 1 = a gap; 2 = a setup error. Each run is recorded, dated, in
 * docs/specs/communication/SPEC-NOTIFICATION-BRIDGE.md ("Verified by").
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { CloudFormationClient, DescribeStacksCommand, DescribeStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { execFileSync } from 'node:child_process';
import { ChimeSDKMessagingClient, ListChannelMessagesCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const INSTANCE = resolveInstanceName(process.env);
const SSM_ROOT = `/${INSTANCE}`;
const WAIT_MS = 45_000;

const cfn = new CloudFormationClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const note = (m) => console.log(`  NOTE  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The poster's log lines matching a phrase since a time, through the AWS CLI. */
const logLines = (group, since, phrase) => JSON.parse(execFileSync('aws', [
  'logs', 'filter-log-events', '--region', REGION, '--log-group-name', group, '--start-time', String(since),
  '--filter-pattern', `"${phrase}"`, '--output', 'json',
], { encoding: 'utf8' })).events || [];
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
/** A token in the shape the poster accepts: 52 characters of lowercase base32. */
const caseFreeToken = () => [...randomBytes(52)].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('');

async function outputsOf(stackName) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries((r.Stacks?.[0]?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}

async function resourcesOf(stackName) {
  const r = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
  return r.StackResources || [];
}

const param = async (name) => (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;

async function sim(principal, action, resource, leadingKey) {
  const r = await iam.send(new SimulatePrincipalPolicyCommand({
    PolicySourceArn: principal,
    ActionNames: [action],
    ResourceArns: [resource],
    ...(leadingKey ? { ContextEntries: [{ ContextKeyName: 'dynamodb:LeadingKeys', ContextKeyType: 'stringList', ContextKeyValues: [leadingKey] }] } : {}),
  }));
  return r.EvaluationResults?.[0]?.EvalDecision;
}

async function main() {
  const account = (await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}))).Account;
  const roleArn = (name) => `arn:aws:iam::${account}:role/${name}`;
  const notifications = await resourcesOf(`${PREFIX}Notifications`).catch((err) => {
    if (/does not exist/.test(String(err?.message))) throw new Error(`${PREFIX}Notifications is not deployed: this configuration declares no notifications`);
    throw err;
  });
  const base = (await outputsOf(`${PREFIX}PersonApi`)).PersonApiUrl;
  const tokensTable = await param(`${SSM_ROOT}/shared/tables/tokens-name`);
  const tokensArn = await param(`${SSM_ROOT}/shared/tables/tokens-arn`);
  const profileArn = await param(`${SSM_ROOT}/shared/tables/user-profile-arn`);
  if (!base || !tokensTable || !tokensArn || !profileArn) throw new Error('the person API or the shared tables are not published');
  const fnRole = (logicalPrefix) => {
    const fn = notifications.find((x) => x.ResourceType === 'AWS::IAM::Role' && x.LogicalResourceId?.startsWith(logicalPrefix));
    return fn?.PhysicalResourceId;
  };

  // ── 1. THE PREFERENCE PAGE IS AUTHENTICATED BY ITS TOKEN ────────────────────────────────────────
  console.log('1. the preference page is authenticated by its token');
  const stranger = randomBytes(32).toString('base64url');
  const get = await fetch(`${base}/email/preferences?t=${stranger}`);
  get.status === 404 ? pass('a GET with a token never minted is refused (404)') : fail(`a GET with a token never minted answered ${get.status}`);
  const oneClick = await fetch(`${base}/email/preferences?t=${stranger}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
  });
  oneClick.status === 404 ? pass('a one-click POST with a token never minted is refused (404)') : fail(`a one-click POST with a token never minted answered ${oneClick.status}`);
  const none = await fetch(`${base}/email/preferences`, { method: 'POST', body: 'List-Unsubscribe=One-Click' });
  none.status === 404 ? pass('a POST with no token is refused (404)') : fail(`a POST with no token answered ${none.status}`);

  // ── 2. THE PREFERENCE ROLE REACHES ITS OWN RECORDS ONLY ─────────────────────────────────────────
  console.log('2. the preference role reaches its own records only');
  const prefsRole = fnRole('EmailPreferencesFunctionServiceRole');
  if (!prefsRole) throw new Error('the preference function role was not found');
  (await sim(roleArn(prefsRole), 'dynamodb:GetItem', tokensArn, `unsubscribe#${sha256('x')}`)) === 'allowed'
    ? pass('control: it may read an unsubscribe token') : fail('control: it may not read an unsubscribe token');
  for (const kind of ['reply', 'invitation', 'claim', 'guest-refresh']) {
    const d = await sim(roleArn(prefsRole), 'dynamodb:GetItem', tokensArn, `${kind}#${sha256('x')}`);
    d !== 'allowed' ? pass(`it is refused a ${kind} token (${d})`) : fail(`it may read a ${kind} token`);
  }
  for (const key of ['0192f0e0-0000-7000-8000-000000000001', '0192f0e0-0000-7000-8000-000000000001#contact#deployment']) {
    const d = await sim(roleArn(prefsRole), 'dynamodb:GetItem', profileArn, key);
    d !== 'allowed' ? pass(`it is refused the profile item ${key.includes('#contact#') ? '(a contact copy)' : '(the profile)'} (${d})`) : fail(`it may read ${key}`);
  }
  const ses = await sim(roleArn(prefsRole), 'ses:SendEmail', `arn:aws:ses:${REGION}:${account}:identity/*`);
  ses !== 'allowed' ? pass(`it holds no SES send (${ses})`) : fail('it may send email');

  // ── 3. THE POSTER HOLDS NO POST OF ITS OWN ──────────────────────────────────────────────────────
  console.log('3. the poster holds no post of its own');
  const identity = await resourcesOf(`${PREFIX}Identity`);
  const posterRole = identity.find((x) => x.ResourceType === 'AWS::IAM::Role' && x.LogicalResourceId?.startsWith('EmailReplyPosterRole'))?.PhysicalResourceId;
  const replyFn = notifications.find((x) => x.ResourceType === 'AWS::Lambda::Function' && x.LogicalResourceId?.startsWith('EmailReplyFunction'))?.PhysicalResourceId;
  if (!posterRole || !replyFn) {
    note('replyDomain is not deployed on this instance: no poster, so 3 and 4 have nothing to refuse');
  } else {
    const d = await sim(roleArn(posterRole), 'chime:SendChannelMessage', `arn:aws:chime:${REGION}:${account}:app-instance/*/channel/*`);
    d !== 'allowed' ? pass(`the poster cannot send a message on its own credentials (${d})`) : fail('the poster may send a message as itself');
    for (const kind of ['reply', 'unsubscribe', 'invitation']) {
      const w = await sim(roleArn(posterRole), 'dynamodb:PutItem', tokensArn, `${kind}#${sha256('x')}`);
      w !== 'allowed' ? pass(`the poster is refused a ${kind} token write (${w})`) : fail(`the poster may write a ${kind} token`);
    }

    // ── 4. MAIL WITHOUT A VALID REPLY TOKEN POSTS NOTHING ─────────────────────────────────────────
    console.log('4. mail without a valid reply token posts nothing');
    const replyDomain = notifications.length && (await outputsOf(`${PREFIX}Notifications`)).ReplyDomainMx?.split(' ')[0];
    const sender = (await outputsOf(`${PREFIX}Notifications`)).SenderEmailIdentityArn?.split('/').pop();
    const channelArn = process.env.DENY_TEST_CHANNEL_ARN;
    const personArn = process.env.DENY_TEST_PERSON_ARN;
    if (!replyDomain || !sender || !channelArn || !personArn) throw new Error('set DENY_TEST_CHANNEL_ARN and DENY_TEST_PERSON_ARN (a test conversation and a member of it)');
    const sesClient = new SESv2Client({ region: REGION });
    const chime = new ChimeSDKMessagingClient({ region: REGION });
    const adminArn = await param(`${SSM_ROOT}/app-instance-admin-arn`).catch(() => undefined);
    const lastMessages = async () => {
      if (!adminArn) return null;
      const r = await chime.send(new ListChannelMessagesCommand({ ChannelArn: channelArn, ChimeBearer: adminArn, MaxResults: 5, SortOrder: 'DESCENDING' }));
      return (r.ChannelMessages || []).map((m) => m.MessageId);
    };
    const before = await lastMessages();
    const valid = caseFreeToken();
    const now = Math.floor(Date.now() / 1000);
    const validKey = `reply#${sha256(valid)}`;
    await doc.send(new PutCommand({ TableName: tokensTable, Item: {
      pk: validKey, kind: 'reply', redemption: 'bounded', channelArn, personArn, issuer: '', noticeId: 'deny-test',
      expiresAt: now + 3600, reclaimAt: now + 3600 + 7 * 86400, createdAt: new Date().toISOString(),
    } }));
    const marker = `deny-test-${randomBytes(6).toString('hex')}`;
    const cases = [
      ['no token', `support@${replyDomain}`, ['no-token']],
      ['a token never minted', `reply+${caseFreeToken()}@${replyDomain}`, ['token-unknown']],
      ['a valid token from an address that is not the person\'s', `reply+${valid}@${replyDomain}`, ['from-not-the-person', 'dmarc']],
    ];
    const started = Date.now();
    for (const [, to] of cases) {
      await sesClient.send(new SendEmailCommand({
        FromEmailAddress: sender, Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: marker }, Body: { Text: { Data: `${marker} this must not be posted` } } } },
      }));
    }
    await sleep(WAIT_MS);
    const events = logLines(`/aws/lambda/${replyFn}`, started - 5000, '[email-reply] refused');
    const reasons = events.map((e) => /reason: '([^']+)'/.exec(e.message || '')?.[1]).filter(Boolean);
    for (const [name, , expected] of cases) {
      reasons.some((r) => expected.includes(r)) ? pass(`${name}: refused (${expected.join(' or ')})`) : fail(`${name}: no refusal by ${expected.join(' or ')} in the poster's log`);
    }
    const posted = logLines(`/aws/lambda/${replyFn}`, started - 5000, '[email-reply] posted as the person');
    posted.length === 0 ? pass('nothing was posted') : fail(`${posted.length} reply was posted`);
    const after = await lastMessages();
    if (before && after) JSON.stringify(before) === JSON.stringify(after) ? pass('the conversation gained no message') : fail('the conversation gained a message');
    else note('no app-instance admin was readable, so the conversation itself was not listed');
    await doc.send(new DeleteCommand({ TableName: tokensTable, Key: { pk: validKey } }));
  }

  console.log(failures.length ? `\n${failures.length} refusal(s) did not hold (instance ${INSTANCE})` : `\nevery refusal held (instance ${INSTANCE})`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('setup error:', err?.message || err);
  process.exit(2);
});
