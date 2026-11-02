#!/usr/bin/env node
/**
 * DENY-TEST: A GUEST REACHES ITS OWN CONVERSATION AND NOTHING ELSE, AND GUEST START FAILS CLOSED (A7, L16).
 *
 * Against a DEPLOYED instance whose trusted-issuer registry declares a guest issuer (configuration C0 and
 * every later one), on a non-production instance (the captcha vendor's always-pass test keys, so the
 * dummy response `XXXX.DUMMY.TOKEN.XXXX` passes and an empty one fails):
 *
 *   1. ANOTHER GUEST'S CHANNEL. Two visitors are started. Visitor A's vended credential is refused
 *      `SendChannelMessage` and `ListChannelMessages` on visitor B's conversation (IAM), and A's guest
 *      token presented at the exchange naming B's conversation is refused (403). Control: A sends and
 *      lists in A's own conversation.
 *   2. EVERY OTHER ROUTE. A's guest token is refused (401 or 403) on every person-facing route but the
 *      credential exchange and path B's registration (`GUEST_ROUTES`), read from the deployed API so a route added later is covered.
 *   3. A REFRESH REPLAY REVOKES THE FAMILY. A's refresh credential R1 is rotated to R2. R1 presented again
 *      after the reuse grace is refused (`replayed`), and then R2, the most recent legitimate credential,
 *      is refused too (`revoked`).
 *   4. TWO TABS. A third visitor's refresh credential is presented twice at once; both are admitted and
 *      each gets a successor, so both tabs keep the session.
 *   5. CAPTCHA, AND A CONTROL THAT CANNOT ANSWER. Guest start with no captcha response is refused
 *      `captcha_failed` (403). The kill switch is set to an unreadable value and guest start is refused
 *      `unavailable` (503), then set paused and refused `paused` (503); it is restored to what it held at
 *      the start whatever happens. A captcha VERIFIER that cannot be reached, and a limit STORE that cannot
 *      answer, are proven by `test/the-guest-session-fails-closed.test.ts` (a live verifier or store
 *      outage is not something this script can cause), and this row says so in its output.
 *   6. THE GUEST-SESSION ROLE WITH NO SESSION POLICY. `iam simulate-principal-policy` on the deployed
 *      role (its identity policy and its permissions boundary both apply) with the session's own tags:
 *      `chime:CreateChannel` and `chime:CreateChannelMembership` are refused, and so is
 *      `chime:SendChannelMessage` on a channel other than the one the session is tagged with. Control:
 *      `SendChannelMessage` on its own channel, tagged with the guest classification, is allowed.
 *   7. A BURST FROM ONE ADDRESS. Guest start is called until it is refused `rate_limited` (429), within the
 *      issuer's per-address limit plus one; this machine's address stays limited for the rest of the window,
 *      so this row runs last.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/deny-test-guest.mjs
 *
 * Needs the backend built (`npm run build`). Exit 0 = every refusal held; 1 = a gap; 2 = a setup error.
 * Each run is recorded, dated, in docs/guides/admin/GUEST-ISSUER.md ("Verified by").
 */
import { createRequire } from 'node:module';
import { CloudFormationClient, DescribeStacksCommand, DescribeStackResourcesCommand, GetTemplateCommand } from '@aws-sdk/client-cloudformation';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  ChimeSDKMessagingClient,
  ListChannelMessagesCommand,
  SendChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { GUEST_ROUTES } = require('../lib/constructs/trusted-issuers.js');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const INSTANCE = resolveInstanceName(process.env);
const DUMMY_CAPTCHA = 'XXXX.DUMMY.TOKEN.XXXX';
const REUSE_GRACE_SECONDS = 10;

const cfn = new CloudFormationClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const note = (m) => console.log(`  NOTE  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function outputsOf(stackName) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries((r.Stacks?.[0]?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}

async function physicalId(stackName, logicalPrefix, type) {
  const r = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
  const hit = (r.StackResources || []).find((x) => x.LogicalResourceId?.startsWith(logicalPrefix) && x.ResourceType === type);
  if (!hit?.PhysicalResourceId) throw new Error(`${stackName} has no ${type} ${logicalPrefix}*`);
  return hit.PhysicalResourceId;
}

async function guardedRoutes(stackName) {
  const r = await cfn.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: 'Processed' }));
  const resources = JSON.parse(r.TemplateBody || '{}').Resources || {};
  return Object.values(resources)
    .filter((x) => x.Type === 'AWS::ApiGatewayV2::Route' && x.Properties?.AuthorizationType && x.Properties.AuthorizationType !== 'NONE')
    .map((x) => x.Properties.RouteKey)
    .sort();
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

async function call(base, routeKey, token) {
  const [method, path] = routeKey.split(' ');
  const res = await fetch(`${base}${path.replace(/\{[^}]+\}/g, 'deny-test-probe')}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
  return res.status;
}

const messagingAs = (credentials) => new ChimeSDKMessagingClient({
  region: REGION,
  credentials: {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  },
});

async function refusedByIam(fn) {
  try {
    await fn();
    return false;
  } catch (err) {
    return err?.name === 'AccessDeniedException' || err?.name === 'ForbiddenException' || /not authorized|AccessDenied/i.test(String(err?.message));
  }
}

async function main() {
  const identityStack = `${PREFIX}Identity`;
  const personApiStack = `${PREFIX}PersonApi`;
  const { PersonApiUrl: base } = await outputsOf(personApiStack);
  if (!base) throw new Error(`${personApiStack} has no PersonApiUrl output`);
  const identityOutputs = await outputsOf(identityStack);
  const killSwitch = identityOutputs.GuestKillSwitchParameter;
  const sessionRoleArn = identityOutputs.GuestSessionRoleArn;
  const noticeVersion = identityOutputs.GuestNoticeVersion;
  if (!killSwitch || !sessionRoleArn || !noticeVersion) {
    throw new Error(`${identityStack} declares no guest issuer (no GuestKillSwitchParameter, GuestSessionRoleArn or GuestNoticeVersion output)`);
  }
  const start = () => post(base, '/guest/start', { captchaToken: DUMMY_CAPTCHA, noticeVersion });

  const original = (await ssm.send(new GetParameterCommand({ Name: killSwitch }))).Parameter?.Value;
  const restore = async () => {
    if (original !== undefined) await ssm.send(new PutParameterCommand({ Name: killSwitch, Value: original, Overwrite: true, Type: 'String' }));
  };

  try {
    // ── 1. ANOTHER GUEST'S CHANNEL ──────────────────────────────────────────────────────────────────
    console.log('1. another guest\'s channel');
    const a = await start();
    const b = await start();
    if (a.status !== 200 || b.status !== 200) throw new Error(`guest start did not admit the two visitors: ${a.status} ${JSON.stringify(a.body)} / ${b.status}`);
    const asA = messagingAs(a.body.credentials);
    // THE CONTROL SUCCEEDS, or fails naming what refused it. "Not refused by IAM" is not a send: a throttle
    // or a validation error would have passed it while proving nothing below.
    const control = await asA.send(new SendChannelMessageCommand({
      ChannelArn: a.body.channelArn, Content: 'deny-test control', Type: 'STANDARD', Persistence: 'PERSISTENT', ChimeBearer: a.body.userArn,
    })).then(() => null, (err) => `${err?.name || err}: ${String(err?.message || '').slice(0, 160)}`);
    if (control) fail(`control: visitor A could not send in A's own conversation (${control}), so nothing below proves a boundary`);
    else pass('control: visitor A sends in A\'s own conversation');
    (await refusedByIam(() => asA.send(new SendChannelMessageCommand({
      ChannelArn: b.body.channelArn, Content: 'deny-test crossing', Type: 'STANDARD', Persistence: 'PERSISTENT', ChimeBearer: a.body.userArn,
    })))) ? pass('visitor A is refused SendChannelMessage on B\'s conversation') : fail('visitor A sent into B\'s conversation');
    (await refusedByIam(() => asA.send(new ListChannelMessagesCommand({ ChannelArn: b.body.channelArn, ChimeBearer: a.body.userArn }))))
      ? pass('visitor A is refused ListChannelMessages on B\'s conversation') : fail('visitor A read B\'s conversation');
    (await refusedByIam(() => asA.send(new SendChannelMessageCommand({
      ChannelArn: a.body.channelArn, Content: 'deny-test impersonation', Type: 'STANDARD', Persistence: 'PERSISTENT', ChimeBearer: b.body.userArn,
    })))) ? pass('visitor A is refused sending as visitor B') : fail('visitor A sent as visitor B');
    const crossVend = await post(base, '/exchange-credentials', { channelArn: b.body.channelArn }, a.body.guestToken);
    crossVend.status === 403 ? pass('the exchange refuses A\'s guest token naming B\'s conversation (403)') : fail(`the exchange answered ${crossVend.status} for A's token naming B's conversation`);
    const ownVend = await post(base, '/exchange-credentials', {}, a.body.guestToken);
    ownVend.status === 200 && ownVend.body?.scopedTo === a.body.channelArn
      ? pass('control: the exchange vends A\'s own conversation') : fail(`the exchange did not vend A's own conversation: ${ownVend.status}`);

    // ── 2. EVERY OTHER ROUTE ────────────────────────────────────────────────────────────────────────
    console.log('2. every other person-facing route');
    const routes = await guardedRoutes(personApiStack);
    if (routes.length < 10) fail(`only ${routes.length} guarded routes were found; a scan over nothing proves nothing`);
    for (const route of routes) {
      if (GUEST_ROUTES.includes(route)) continue;
      const status = await call(base, route, a.body.guestToken);
      status === 401 || status === 403 ? pass(`${route}: refused (${status})`) : fail(`${route}: a guest token was admitted (${status})`);
    }

    // ── 3. A REFRESH REPLAY REVOKES THE FAMILY ──────────────────────────────────────────────────────
    console.log('3. a refresh replay revokes the family');
    const r1 = a.body.refreshToken;
    const first = await post(base, '/guest/refresh', { refreshToken: r1 });
    if (first.status !== 200) throw new Error(`the first refresh was refused: ${first.status} ${JSON.stringify(first.body)}`);
    pass('control: the first refresh rotates the credential');
    await sleep((REUSE_GRACE_SECONDS + 2) * 1000);
    const replay = await post(base, '/guest/refresh', { refreshToken: r1 });
    replay.status === 401 && replay.body?.code === 'replayed' ? pass('the replayed credential is refused (replayed)') : fail(`the replay answered ${replay.status} ${JSON.stringify(replay.body)}`);
    const after = await post(base, '/guest/refresh', { refreshToken: first.body.refreshToken });
    after.status === 401 && after.body?.code === 'revoked' ? pass('the most recent legitimate credential is refused too (revoked)') : fail(`the latest credential answered ${after.status} ${JSON.stringify(after.body)}`);

    // ── 4. TWO TABS ─────────────────────────────────────────────────────────────────────────────────
    console.log('4. two tabs refresh at once');
    const c = await start();
    if (c.status !== 200) throw new Error(`guest start did not admit the third visitor: ${c.status}`);
    const [t1, t2] = await Promise.all([
      post(base, '/guest/refresh', { refreshToken: c.body.refreshToken }),
      post(base, '/guest/refresh', { refreshToken: c.body.refreshToken }),
    ]);
    t1.status === 200 && t2.status === 200 && t1.body.refreshToken !== t2.body.refreshToken
      ? pass('both tabs keep the session, each with its own successor') : fail(`two tabs answered ${t1.status} and ${t2.status}`);
    const tabNext = await post(base, '/guest/refresh', { refreshToken: t2.body?.refreshToken });
    tabNext.status === 200 ? pass('a tab\'s successor refreshes again') : fail(`a tab's successor answered ${tabNext.status}`);

    // ── 5. CAPTCHA, AND A CONTROL THAT CANNOT ANSWER ────────────────────────────────────────────────
    console.log('5. captcha, and a control that cannot answer');
    const noCaptcha = await post(base, '/guest/start', { noticeVersion });
    noCaptcha.status === 403 && noCaptcha.body?.code === 'captcha_failed' ? pass('no captcha response: captcha_failed (403)') : fail(`no captcha response answered ${noCaptcha.status} ${JSON.stringify(noCaptcha.body)}`);
    await ssm.send(new PutParameterCommand({ Name: killSwitch, Value: 'deny-test: not a state', Overwrite: true, Type: 'String' }));
    await sleep(12_000);
    const unreadable = await start();
    unreadable.status === 503 && unreadable.body?.code === 'unavailable' ? pass('an unreadable kill switch: unavailable (503)') : fail(`an unreadable kill switch answered ${unreadable.status} ${JSON.stringify(unreadable.body)}`);
    const who = (await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}))).Arn;
    await ssm.send(new PutParameterCommand({
      Name: killSwitch, Overwrite: true, Type: 'String',
      Value: JSON.stringify({ paused: true, changedBy: who, changedAt: new Date().toISOString(), reason: 'deny-test-guest' }),
    }));
    await sleep(12_000);
    const paused = await start();
    paused.status === 503 && paused.body?.code === 'paused' ? pass('the kill switch on: paused (503)') : fail(`the kill switch on answered ${paused.status} ${JSON.stringify(paused.body)}`);
    await restore();
    note('a captcha verifier or limit store outage is proven by backend/test/the-guest-session-fails-closed.test.ts, not here');

    // ── 6. THE GUEST-SESSION ROLE WITH NO SESSION POLICY ───────────────────────────────────────────
    console.log('6. the guest-session role, with no session policy');
    const appInstance = a.body.channelArn.split('/channel/')[0];
    const mine = a.body.channelArn.split('/channel/')[1];
    const personId = a.body.userArn.slice(a.body.userArn.lastIndexOf('/') + 1);
    const sim = async (action, resource, resourceTags = {}) => {
      const r = await iam.send(new SimulatePrincipalPolicyCommand({
        PolicySourceArn: sessionRoleArn,
        ActionNames: [action],
        ResourceArns: [resource],
        ContextEntries: [
          { ContextKeyName: 'aws:PrincipalTag/person', ContextKeyType: 'string', ContextKeyValues: [personId] },
          { ContextKeyName: 'aws:PrincipalTag/channel', ContextKeyType: 'string', ContextKeyValues: [mine] },
          ...Object.entries(resourceTags).map(([k, v]) => ({ ContextKeyName: `aws:ResourceTag/${k}`, ContextKeyType: 'string', ContextKeyValues: [v] })),
        ],
      }));
      return r.EvaluationResults?.[0]?.EvalDecision;
    };
    const guestTag = { classification: process.env.GUEST_CLASSIFICATION || 'guest' };
    (await sim('chime:SendChannelMessage', `${appInstance}/channel/${mine}`, guestTag)) === 'allowed'
      ? pass('control: the role allows SendChannelMessage on its own tagged channel') : fail('control: the role does not allow its own channel');
    for (const action of ['chime:CreateChannel', 'chime:CreateChannelMembership']) {
      for (const resource of [appInstance, `${appInstance}/channel/${mine}`, `${appInstance}/channel/*`]) {
        const d = await sim(action, resource, guestTag);
        d !== 'allowed' ? pass(`${action} on ${resource.split('/').slice(-2).join('/')}: ${d}`) : fail(`${action} on ${resource} is allowed`);
      }
    }
    const other = b.body.channelArn.split('/channel/')[1];
    (await sim('chime:SendChannelMessage', `${appInstance}/channel/${other}`, guestTag)) !== 'allowed'
      ? pass('SendChannelMessage on another channel is refused') : fail('SendChannelMessage on another channel is allowed');
    (await sim('chime:SendChannelMessage', `${appInstance}/channel/${mine}`, { classification: 'basic' })) !== 'allowed'
      ? pass('SendChannelMessage on its own channel id carrying another classification is refused') : fail('a channel carrying another classification is allowed');

    // ── 7. A BURST FROM ONE ADDRESS ────────────────────────────────────────────────────────────────
    console.log('7. a burst from one address');
    let limited = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await start();
      if (r.status === 429 && r.body?.code === 'rate_limited') limited = r;
      else if (r.status !== 200) { fail(`a burst start answered ${r.status} ${JSON.stringify(r.body)} before the limit`); break; }
    }
    limited && Number(limited.body.retryAfterSeconds) > 0
      ? pass(`the burst is refused rate_limited (429), retry after ${limited.body.retryAfterSeconds}s`)
      : fail('no start in the burst was refused rate_limited');
  } finally {
    await restore();
  }

  console.log(failures.length ? `\n${failures.length} refusal(s) did not hold (instance ${INSTANCE})` : `\nevery refusal held (instance ${INSTANCE})`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('setup error:', err?.message || err);
  process.exit(2);
});
