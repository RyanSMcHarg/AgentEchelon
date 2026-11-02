#!/usr/bin/env node
/**
 * DENY-TEST: THE TOKEN STORE REFUSES A TOKEN IT SHOULD NOT REDEEM, AND EACH WRITER REACHES ITS OWN KINDS (A8).
 *
 * Against a DEPLOYED instance (configuration C0 and every later one). The kinds built are the guest's
 * refresh credential (`guest-refresh`) and a host assertion's `jti` (`assertion-jti`, whose record the edge
 * writes and the exchange consumes; its redemption is `deny-test-host-assertion.mjs`). Every kind is
 * checked for write scope here; `invitation` for redemption by `deny-test-invitations.mjs`, `claim` by
 * `deny-test-upgrade.mjs` and `reply` by `deny-test-reply-token.mjs`.
 *
 *   1. A SECOND REDEMPTION. A visitor's refresh credential is redeemed once, then again after the reuse
 *      grace: refused (`replayed`).
 *   2. EXPIRED BEFORE TTL DELETES IT. A refresh record is written directly to `Tokens` with an expiry a
 *      minute in the past (TTL reclaims a record only 7 days after it expires, so it is certainly still
 *      there), and presented: refused (`expired`).
 *   3. ANOTHER CHANNEL. A visitor's guest token, presented at the exchange naming another conversation:
 *      refused (403). (An invitation names no channel a caller supplies: its redemption reaches the record's own.)
 *   4. EACH KIND'S WRITER, AND NO OTHER. `iam simulate-principal-policy` on `Tokens`:
 *      - the credential exchange's role may `PutItem` a `guest-refresh#` key (the control) and is refused
 *        an `invitation#`, a `claim#`, a `reply#` and an `assertion-jti#` key (it consumes an
 *        `assertion-jti#` and an `invitation#` record with `UpdateItem`, and never writes one: the edge and
 *        the invitations function do);
 *      - the Notifications stack's roles, where `notifications` is declared, are refused an `invitation#`
 *        key (in a configuration without it, the row says the stack is not deployed);
 *      - the guest-session role, the one a visitor's own credential is on, is refused every `Tokens` write.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/deny-test-tokens.mjs
 *
 * Needs the backend built (`npm run build`) and a non-production instance (the captcha test keys).
 * Exit 0 = every refusal held; 1 = a gap; 2 = a setup error. Each run is recorded, dated, in
 * docs/guides/admin/GUEST-ISSUER.md ("Verified by").
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { CloudFormationClient, DescribeStacksCommand, DescribeStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const INSTANCE = resolveInstanceName(process.env);
const SSM_ROOT = `/${INSTANCE}`;
const DUMMY_CAPTCHA = 'XXXX.DUMMY.TOKEN.XXXX';
const REUSE_GRACE_SECONDS = 10;
const KINDS_NOT_THE_EXCHANGES = ['invitation', 'claim', 'reply', 'assertion-jti'];

const cfn = new CloudFormationClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const note = (m) => console.log(`  NOTE  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (v) => createHash('sha256').update(v).digest('hex');

async function outputsOf(stackName) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries((r.Stacks?.[0]?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}

async function rolesOf(stackName, logicalPrefix) {
  try {
    const r = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
    return (r.StackResources || [])
      .filter((x) => x.ResourceType === 'AWS::IAM::Role' && (!logicalPrefix || x.LogicalResourceId?.startsWith(logicalPrefix)))
      .map((x) => x.PhysicalResourceId);
  } catch (err) {
    if (/does not exist/.test(String(err?.message))) return null;
    throw err;
  }
}

async function post(base, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* an empty body */ }
  return { status: res.status, body: json };
}

async function main() {
  const account = (await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}))).Account;
  const roleArn = (name) => `arn:aws:iam::${account}:role/${name}`;
  const { PersonApiUrl: base } = await outputsOf(`${PREFIX}PersonApi`);
  const identity = await outputsOf(`${PREFIX}Identity`);
  if (!base || !identity.GuestNoticeVersion) throw new Error('this instance declares no guest issuer, so no token kind is built on it');
  const tokensTable = (await ssm.send(new GetParameterCommand({ Name: `${SSM_ROOT}/shared/tables/tokens-name` }))).Parameter?.Value;
  const tokensArn = (await ssm.send(new GetParameterCommand({ Name: `${SSM_ROOT}/shared/tables/tokens-arn` }))).Parameter?.Value;
  if (!tokensTable || !tokensArn) throw new Error('the Tokens table is not published');
  const start = () => post(base, '/guest/start', { captchaToken: DUMMY_CAPTCHA, noticeVersion: identity.GuestNoticeVersion });

  // ── 1. A SECOND REDEMPTION ────────────────────────────────────────────────────────────────────────
  console.log('1. a second redemption');
  const v = await start();
  if (v.status !== 200) throw new Error(`guest start refused the visitor: ${v.status} ${JSON.stringify(v.body)}`);
  const once = await post(base, '/guest/refresh', { refreshToken: v.body.refreshToken });
  once.status === 200 ? pass('control: the first redemption is admitted') : fail(`the first redemption answered ${once.status}`);
  await sleep((REUSE_GRACE_SECONDS + 2) * 1000);
  const twice = await post(base, '/guest/refresh', { refreshToken: v.body.refreshToken });
  twice.status === 401 ? pass(`the second redemption is refused (${twice.body?.code})`) : fail(`the second redemption answered ${twice.status}`);

  // ── 2. EXPIRED, BEFORE TTL DELETES IT ─────────────────────────────────────────────────────────────
  console.log('2. an expired token, before TTL deletes it');
  const w = await start();
  if (w.status !== 200) throw new Error(`guest start refused the second visitor: ${w.status}`);
  const token = randomBytes(32).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const familyId = `deny-test-${randomBytes(8).toString('hex')}`;
  await doc.send(new PutCommand({ TableName: tokensTable, Item: {
    pk: `guest-family#${sha256(familyId)}`, kind: 'guest-family', redemption: 'bounded', status: 'active',
    channelArn: w.body.channelArn, personArn: w.body.userArn, issuer: 'deny-test', expiresAt: now + 3600, reclaimAt: now + 3600 + 7 * 86400,
    createdAt: new Date().toISOString(),
  } }));
  await doc.send(new PutCommand({ TableName: tokensTable, Item: {
    pk: `guest-refresh#${sha256(token)}`, kind: 'guest-refresh', redemption: 'single-use', familyId, subject: 'deny-test',
    channelArn: w.body.channelArn, personArn: w.body.userArn, issuer: 'deny-test', sessionEndsAt: now + 3600,
    expiresAt: now - 60, reclaimAt: now - 60 + 7 * 86400, createdAt: new Date().toISOString(),
  } }));
  const expired = await post(base, '/guest/refresh', { refreshToken: token });
  expired.status === 401 && expired.body?.code === 'expired' ? pass('an expired record is refused (expired)') : fail(`an expired record answered ${expired.status} ${JSON.stringify(expired.body)}`);

  // ── 3. ANOTHER CHANNEL ────────────────────────────────────────────────────────────────────────────
  console.log('3. another channel');
  const cross = await post(base, '/exchange-credentials', { channelArn: w.body.channelArn }, v.body.guestToken);
  cross.status === 403 ? pass('a guest token naming another conversation is refused (403)') : fail(`a guest token naming another conversation answered ${cross.status}`);
  note('an invitation\'s redemption is deny-test-invitations.mjs');

  // ── 4. EACH KIND'S WRITER, AND NO OTHER ───────────────────────────────────────────────────────────
  console.log('4. each kind\'s writer, and no other');
  const sim = async (principal, key, action = 'dynamodb:PutItem') => {
    const r = await iam.send(new SimulatePrincipalPolicyCommand({
      PolicySourceArn: principal,
      ActionNames: [action],
      ResourceArns: [tokensArn],
      ContextEntries: [{ ContextKeyName: 'dynamodb:LeadingKeys', ContextKeyType: 'stringList', ContextKeyValues: [key] }],
    }));
    return r.EvaluationResults?.[0]?.EvalDecision;
  };
  const exchange = (await rolesOf(`${PREFIX}Identity`, 'CredentialExchangeRole'))?.[0];
  if (!exchange) throw new Error('the credential exchange role was not found');
  (await sim(roleArn(exchange), `guest-refresh#${sha256('x')}`)) === 'allowed'
    ? pass('control: the exchange may write a guest-refresh record') : fail('control: the exchange may not write a guest-refresh record');
  for (const kind of KINDS_NOT_THE_EXCHANGES) {
    const d = await sim(roleArn(exchange), `${kind}#${sha256('x')}`);
    d !== 'allowed' ? pass(`the exchange is refused a ${kind} record (${d})`) : fail(`the exchange may write a ${kind} record`);
  }
  const notifications = await rolesOf(`${PREFIX}Notifications`);
  if (notifications === null) note(`${PREFIX}Notifications is not deployed in this configuration, so it holds no role to refuse`);
  else {
    for (const r of notifications) {
      const d = await sim(roleArn(r), `invitation#${sha256('x')}`);
      d !== 'allowed' ? pass(`${r} is refused an invitation record (${d})`) : fail(`${r} may write an invitation record`);
    }
  }
  const sessionRole = identity.GuestSessionRoleArn;
  for (const action of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem']) {
    const d = await sim(sessionRole, `guest-refresh#${sha256('x')}`, action);
    d !== 'allowed' ? pass(`the guest-session role is refused ${action} on Tokens (${d})`) : fail(`the guest-session role may ${action} on Tokens`);
  }

  console.log(failures.length ? `\n${failures.length} refusal(s) did not hold (instance ${INSTANCE})` : `\nevery refusal held (instance ${INSTANCE})`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('setup error:', err?.message || err);
  process.exit(2);
});
