#!/usr/bin/env node
/**
 * DENY-TEST: A VISITOR BECOMES A PERSON ONLY BY THE RULES OF THE TWO UPGRADE PATHS, AND A SECOND ISSUER
 * IS LINKED ONLY BY A PINNED SESSION (B6, B7, PLAN §16.5 and §16.6).
 *
 * Against a DEPLOYED instance whose registry declares a guest issuer (C0 and later), on a non-production
 * instance (the captcha vendor's always-pass test keys). Path B and the link need a customers' pool in the
 * registry, named here by CUSTOMER_POOL_ID and CUSTOMER_CLIENT_ID (a pool whose clearance is fixed at the
 * customer classification), and path B a test inbox in the test secret (`testInbox`, an SES receipt rule
 * into S3, README "Test inbox"), because the claim travels only in the email; without them those rows are
 * SKIPPED, and REQUIRE_PATH_B=1 fails instead.
 *
 * NOTHING TO CLICK. A visitor never opts in to keeping their visit: the bind below sends
 * no confirmation, the registration's answer carries no claim token, and the claim arrives only as the
 * sign-in link in the email to the address the visitor registered.
 *
 * PATH A, THE BIND (P-11)
 *   The bind presents the visit's sign-in hand-off, which a guest refresh mints when the widget asks with the
 *   hash of a secret it keeps (`bindSecretHash`): its nonce and that secret. This script plays the widget.
 *   A1. An upgrade without a live hand-off adds nothing: a fresh account's first sign-in presenting a nonce
 *       nobody minted is refused (403 `BIND_NOT_HANDED_OFF`), and the visitor's guest token still vends.
 *   A12. A FORWARDED LINK BINDS NOTHING: the hand-off's nonce with any secret but its own is refused (403
 *       `BIND_NOT_HANDED_OFF`), a body naming a refresh credential (the link the widget no longer sends) is
 *       refused as malformed (400), and the visitor still vends. The secret goes only to the tab the widget
 *       opened, over `postMessage`; a link carries the nonce alone.
 *   A2. An existing account's sign-in cannot bind a guest AppInstanceUser: the test user (who has a row)
 *       presenting the visitor's live hand-off is refused (409), and the visitor still vends.
 *   A3. The bind: the fresh account's first sign-in plus the live hand-off answers 200 with the visitor's
 *       own AppInstanceUser ARN.
 *   A4. A bound AppInstanceUser carries no expiration (`DescribeAppInstanceUser`). This row is the O13
 *       probe owed at W18: if it fails, the fallback (create without expiration and sweep)
 *       is NOT BUILT, and the owner decides.
 *   A5. A `guest-refresh` issued before the bind (the one the hand-off names) is refused after it, and the
 *       guest token is refused too.
 *   A6. The account's next sign-in resolves to the same AppInstanceUser.
 *   A7. The visit continues in a new conversation: the bind's answer names one (`bound.conversationArn`),
 *       tagged `upgradedFrom` (the visitor's conversation) and `upgradedFromPerson` (the visitor's own
 *       AppInstanceUser), at the classification the session was vended at, which is never the guest's.
 *   A8. The visitor's conversation stays unreachable: the bound session is refused a read there and
 *       reads the continuation.
 *   A9. The same bind call retried opens no second conversation: it answers 200 with the same one.
 *   A10. The bind asks nothing of the visitor: every bind above sends no `confirmed`, and binds.
 *   A11. The visitor's conversation is deleted once the continuation and its seed exist (FR26), and the
 *        continuation's server-only seed holds the assistant's assessment of the visit, or (when the
 *        model did not answer) the visit's type alone, and never a message of it.
 *
 * PATH B, THE CLAIM (P-12)
 *   B1. A visitor posts in their conversation and registers with an address on the test inbox; the
 *       answer carries no claim token, and the claim arrives as the sign-in link in the email to that
 *       address (`#claim=` on the chat app). With `guest.registration.approval: "admin"` declared, the
 *       registration waits (`awaiting-approval`), no email is sent, the console lists it, and an
 *       operator's approval (`POST /users/guest/registrations/{id}/approve`) sends the email (R1, R2).
 *   B2. A claim is never found or bound by email: a body naming an email and no token is refused (400),
 *       and an unknown token finds nothing (404).
 *   B3. An account whose clearance does not reach the customer classification is refused (403), and the
 *       claim still redeems afterwards.
 *   B4. A customer's claim opens a conversation whose `upgradedFrom` tag names the visitor's conversation.
 *   B4a. Its server-only seed holds the assessment beside the registered fields, or the fields alone, and
 *        never the visitor's message; and the visitor's conversation is deleted afterwards.
 *   B5. A second redemption is refused (409).
 *   B6. Erasing the person follows that tag even though the visitor's conversation is gone: the customer
 *       is deleted through the console, and the visit's registration record goes with them.
 *
 * B7, ONE HUMAN THROUGH TWO ISSUERS (P-13)
 *   L1. A second issuer is added only with a session pinned to the person: a first sign-in (no person
 *       yet) asking to link is refused (403), and adds nothing.
 *   L2. A pinned session plus a fresh customer token links the customer subject to the pinned person
 *       (200), and the customer's next sign-in resolves to that person.
 *   L3. A subject that already has a row is never moved: linking it to another person is refused (409).
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> [CUSTOMER_POOL_ID=.. CUSTOMER_CLIENT_ID=..] \
 *     node backend/scripts/deny-test-upgrade.mjs
 *
 * Needs the backend built (`npm run build`) and the test credentials secret. Exit 0 = every refusal held;
 * 1 = a gap; 2 = a setup error. Each run is recorded, dated, in docs/guides/admin/GUEST-ISSUER.md.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ChimeSDKIdentityClient, DescribeAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';
import {
  ChimeSDKMessagingClient,
  DescribeChannelCommand,
  ListChannelMessagesCommand,
  ListTagsForResourceCommand,
  SendChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { exitWhenDrained, destroyClients } = require('./lib/exit-when-drained.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const INSTANCE = resolveInstanceName(process.env);
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
const DUMMY_CAPTCHA = 'XXXX.DUMMY.TOKEN.XXXX';
const CUSTOMER_POOL_ID = process.env.CUSTOMER_POOL_ID || '';
const CUSTOMER_CLIENT_ID = process.env.CUSTOMER_CLIENT_ID || '';
const REQUIRE_PATH_B = process.env.REQUIRE_PATH_B === '1';
/** A line the visitor says, which the carry-over's assessment may describe and no seed may copy. */
const VISIT_LINE = `deny-test visit line ${randomUUID()}`;

const cfn = new CloudFormationClient({ region: REGION });
const sm = new SecretsManagerClient({ region: REGION });
const idp = new CognitoIdentityProviderClient({ region: REGION });
const chimeIdentity = new ChimeSDKIdentityClient({ region: REGION });
const messaging = new ChimeSDKMessagingClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const ssm = new SSMClient({ region: REGION });

/**
 * THE CLAIM IN THE EMAIL: the newest message the inbox received for `address` since `since`, its sign-in
 * link read out of the raw MIME (quoted-printable undone). Polled, because SES delivers in seconds, not at
 * once. Null when no claim email arrives in `waitMs`.
 */
async function claimFromInbox(inbox, address, since, waitMs = 90_000) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: inbox.bucket, Prefix: inbox.prefix || undefined }));
    const recent = (listed.Contents || []).filter((o) => o.LastModified && o.LastModified.getTime() >= since).sort((a, b) => b.LastModified - a.LastModified);
    for (const o of recent) {
      const raw = await (await s3.send(new GetObjectCommand({ Bucket: inbox.bucket, Key: o.Key }))).Body.transformToString();
      if (!raw.toLowerCase().includes(address.toLowerCase())) continue;
      const text = raw.replace(/=\r?\n/g, '').replace(/=3D/gi, '=');
      const m = /#claim=([A-Za-z0-9_%-]{16,})/.exec(text);
      if (m) return decodeURIComponent(m[1]);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return null;
}

/** The channel-context row of a conversation (server-only), as the operator reads it. */
async function contextRowOf(table, channelArn) {
  const r = await ddb.send(new GetItemCommand({ TableName: table, Key: { channelArn: { S: channelArn } } }));
  return r.Item ? JSON.stringify(r.Item) : '';
}

/** Whether a conversation is gone: described as `bearer`, it answers NotFound. */
async function isDeleted(channelArn, bearer) {
  return messaging.send(new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: bearer })).then(() => false, (err) => err.name === 'NotFoundException');
}

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const skip = (m) => (REQUIRE_PATH_B ? fail(`required but skipped: ${m}`) : console.log(`  SKIP  ${m}`));
const cleanups = [];

async function outputsOf(stackName) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries((r.Stacks?.[0]?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
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

async function idToken(client, clientId, username, password) {
  const r = await client.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH', ClientId: clientId, AuthParameters: { USERNAME: username, PASSWORD: password },
  }));
  const t = r.AuthenticationResult?.IdToken;
  if (!t) throw new Error('no ID token');
  return t;
}

/** A disposable, approved account in a pool, deleted at the end. */
async function freshAccount(poolId, clientId, group) {
  const username = `upgrade-${randomUUID()}@deny-test.invalid`;
  const password = `Aa1!${randomBytes(12).toString('base64url')}`;
  await idp.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: username, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: username }, { Name: 'email_verified', Value: 'true' }] }));
  cleanups.push(() => idp.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: username })).catch(() => {}));
  await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: username, Password: password, Permanent: true }));
  await idp.send(new AdminUpdateUserAttributesCommand({ UserPoolId: poolId, Username: username, UserAttributes: [{ Name: 'custom:approved', Value: 'true' }] }))
    .catch(() => { /* a pool with no approval attribute */ });
  if (group) await idp.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: username, GroupName: group }));
  return { signIn: () => idToken(idp, clientId, username, password) };
}

const messagingAs = (credentials) => new ChimeSDKMessagingClient({
  region: REGION,
  credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken },
});

/** A signed call on the admin console's user-management API, with the test admin's console session. */
async function consoleCaller(base, adminToken) {
  const adminEnv = {};
  for (const line of fs.readFileSync(new URL('../../frontend/packages/admin/.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) adminEnv[m[1]] = m[2].trim();
  }
  const adminApi = (adminEnv.VITE_ADMIN_API_URL || '').replace(/\/$/, '');
  if (!adminApi) throw new Error('frontend/packages/admin/.env names no VITE_ADMIN_API_URL');
  await post(base, '/exchange-credentials', {}, adminToken);
  const vend = await post(adminApi, '/exchange-credentials', { identity: 'console' }, adminToken);
  if (vend.status !== 200) throw new Error(`the test admin was refused a console session: ${vend.status}`);
  const signer = new SignatureV4({
    service: 'execute-api', region: REGION, sha256: Sha256,
    credentials: { accessKeyId: vend.body.credentials.AccessKeyId, secretAccessKey: vend.body.credentials.SecretAccessKey, sessionToken: vend.body.credentials.SessionToken },
  });
  return async (path, json, method = 'POST') => {
    const u = new URL(`${adminApi}/users${path}`);
    const body = method === 'POST' ? JSON.stringify(json ?? {}) : undefined;
    const signed = await signer.sign({ method, protocol: u.protocol, hostname: u.hostname, path: u.pathname, headers: { host: u.host, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : {}) });
    const res = await fetch(u.toString(), { method, headers: signed.headers, ...(body ? { body } : {}) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

async function main() {
  const { PersonApiUrl } = await outputsOf(`${PREFIX}PersonApi`);
  if (!PersonApiUrl) throw new Error(`${PREFIX}PersonApi has no PersonApiUrl output`);
  const base = PersonApiUrl.replace(/\/$/, '');
  const identity = await outputsOf(`${PREFIX}Identity`);
  if (!identity.GuestNoticeVersion) throw new Error(`${PREFIX}Identity declares no guest issuer`);
  const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
  const poolId = identity.UserPoolId;
  const clientId = secret.cognitoClientId;
  const start = () => post(base, '/guest/start', { captchaToken: DUMMY_CAPTCHA, noticeVersion: identity.GuestNoticeVersion });
  const testUserToken = await idToken(idp, clientId, secret.testUser?.email ?? secret.testAdmin.email, secret.testUser?.password ?? secret.testAdmin.password);

  // ── PATH A ──────────────────────────────────────────────────────────────────────────────────────
  console.log('path A: the bind');
  const visitor = await start();
  if (visitor.status !== 200) throw new Error(`guest start refused the visitor: ${visitor.status} ${JSON.stringify(visitor.body)}`);
  const contextTable = (await outputsOf(`${PREFIX}Conversations`)).ChannelContextTableName;
  // A message for the assessment to read, which no seed may carry.
  await messagingAs(visitor.body.credentials).send(new SendChannelMessageCommand({
    ChannelArn: visitor.body.channelArn, Content: VISIT_LINE, Type: 'STANDARD', Persistence: 'PERSISTENT', ChimeBearer: visitor.body.userArn,
  }));
  const fresh = await freshAccount(poolId, clientId, process.env.UPGRADE_TEST_GROUP || 'basic');
  const freshToken = await fresh.signIn();

  // THE HAND-OFF, as the widget makes it: a secret kept here, its hash on one refresh, the nonce back.
  const handOffSecret = randomBytes(32).toString('base64url');
  const handed = await post(base, '/guest/refresh', {
    refreshToken: visitor.body.refreshToken, bindSecretHash: createHash('sha256').update(handOffSecret).digest('base64url'),
  });
  if (handed.status !== 200 || typeof handed.body?.bindNonce !== 'string') throw new Error(`the guest refresh minted no hand-off: ${handed.status} ${JSON.stringify(handed.body)}`);
  const handOff = { nonce: handed.body.bindNonce, secret: handOffSecret };
  const handedRefresh = handed.body.refreshToken;

  const notLive = await post(base, '/exchange-credentials', { bindGuest: { nonce: randomBytes(32).toString('base64url'), secret: randomBytes(32).toString('base64url') } }, freshToken);
  notLive.status === 403 && notLive.body?.code === 'BIND_NOT_HANDED_OFF'
    ? pass('A1: a hand-off nobody minted binds nothing (403)') : fail(`A1: answered ${notLive.status} ${JSON.stringify(notLive.body)}`);

  // A12: A FORWARDED LINK. Whoever holds the link has the nonce and not the secret.
  const forwarded = await post(base, '/exchange-credentials', { bindGuest: { nonce: handOff.nonce, secret: randomBytes(32).toString('base64url') } }, freshToken);
  forwarded.status === 403 && forwarded.body?.code === 'BIND_NOT_HANDED_OFF'
    ? pass('A12: a forwarded link (the nonce without its secret) binds nothing (403)') : fail(`A12: answered ${forwarded.status} ${JSON.stringify(forwarded.body)}`);
  const refreshLink = await post(base, '/exchange-credentials', { bindGuest: { refreshToken: handedRefresh } }, freshToken);
  refreshLink.status === 400 ? pass('A12: a bind naming a refresh credential is refused as malformed (400)') : fail(`A12: a refresh-credential bind answered ${refreshLink.status} ${JSON.stringify(refreshLink.body)}`);
  const stillGuestAfterForward = await post(base, '/exchange-credentials', {}, visitor.body.guestToken);
  stillGuestAfterForward.status === 200 ? pass('A12: the visitor still vends their conversation') : fail(`A12: the visitor no longer vends (${stillGuestAfterForward.status})`);
  const stillGuest = await post(base, '/exchange-credentials', {}, visitor.body.guestToken);
  stillGuest.status === 200 ? pass('A1: the visitor still vends their conversation') : fail(`A1: the visitor no longer vends (${stillGuest.status})`);

  const existing = await post(base, '/exchange-credentials', { bindGuest: handOff }, testUserToken);
  existing.status === 409 && existing.body?.code === 'SUBJECT_ALREADY_BOUND'
    ? pass('A2: an existing account cannot bind a visitor (409)') : fail(`A2: answered ${existing.status} ${JSON.stringify(existing.body)}`);
  const stillGuest2 = await post(base, '/exchange-credentials', {}, visitor.body.guestToken);
  stillGuest2.status === 200 ? pass('A2: the visitor still vends their conversation') : fail(`A2: the visitor no longer vends (${stillGuest2.status})`);

  const bound = await post(base, '/exchange-credentials', { bindGuest: handOff }, freshToken);
  bound.status === 200 && bound.body?.userArn === visitor.body.userArn
    ? pass('A3, A10: the first sign-in binds to the visitor\'s own AppInstanceUser, with no confirmation sent') : fail(`A3: answered ${bound.status} ${JSON.stringify(bound.body)}`);

  if (bound.status === 200) {
    const continuation = bound.body?.bound?.conversationArn;
    // The classification the session was vended at, under the exchange's one wire field.
    const { tier: accessClass } = bound.body;
    const tags = continuation ? (await messaging.send(new ListTagsForResourceCommand({ ResourceARN: continuation }))).Tags || [] : [];
    const tag = (k) => tags.find((t) => t.Key === k)?.Value;
    continuation && tag('upgradedFrom') === visitor.body.channelArn && tag('upgradedFromPerson') === visitor.body.userArn
      && tag('classification') === accessClass && accessClass !== 'guest'
      ? pass(`A7: the visit continues in a tagged conversation at the account's classification (${accessClass})`)
      : fail(`A7: continuation ${continuation} classification ${accessClass} tags ${JSON.stringify(tags)}`);
    const asAccount = messagingAs(bound.body.credentials);
    const guestRead = await asAccount.send(new ListChannelMessagesCommand({ ChannelArn: visitor.body.channelArn, ChimeBearer: visitor.body.userArn })).then(() => 'read', (err) => err.name);
    guestRead === 'AccessDeniedException' || guestRead === 'ForbiddenException'
      ? pass(`A8: the bound session cannot read the visitor's conversation (${guestRead})`) : fail(`A8: the bound session's read of the visitor's conversation answered ${guestRead}`);
    const continuationRead = continuation
      ? await asAccount.send(new ListChannelMessagesCommand({ ChannelArn: continuation, ChimeBearer: visitor.body.userArn })).then(() => 'read', (err) => err.name)
      : 'none';
    continuationRead === 'read' ? pass('A8: the bound session reads the continuation') : fail(`A8: the continuation read answered ${continuationRead}`);
    const retried = await post(base, '/exchange-credentials', { bindGuest: handOff }, freshToken);
    retried.status === 200 && retried.body?.bound?.conversationArn === continuation
      ? pass('A9: the same bind retried opens the same conversation') : fail(`A9: answered ${retried.status} ${JSON.stringify(retried.body?.bound ?? retried.body)}`);
    // A11: THE VISIT IS RETIRED once the continuation and its seed exist, and the seed is no transcript.
    (await isDeleted(visitor.body.channelArn, visitor.body.userArn))
      ? pass('A11: the visitor\'s conversation is deleted after the carry-over') : fail('A11: the visitor\'s conversation still exists after the carry-over');
    const seedRow = continuation && contextTable ? await contextRowOf(contextTable, continuation) : '';
    seedRow.includes('guest-visitor') && !seedRow.includes(VISIT_LINE)
      ? pass(`A11: the continuation's seed carries the visit (${seedRow.includes('assessment') ? 'with the assistant\'s assessment' : 'the model did not answer: its type alone'}), and none of its messages`)
      : fail(`A11: the continuation's seed row ${seedRow ? 'carries the visit\'s message or no visit' : 'could not be read'}`);
  }

  const described = await chimeIdentity.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: visitor.body.userArn })).catch((err) => ({ error: err }));
  if (described.error) fail(`A4: the bound AppInstanceUser could not be described: ${described.error.name}`);
  else if (described.AppInstanceUser?.ExpirationSettings) fail(`A4 (O13): the bound AppInstanceUser still carries an expiration ${JSON.stringify(described.AppInstanceUser.ExpirationSettings)}; the fallback is NOT BUILT`);
  else pass('A4 (O13): the bound AppInstanceUser carries no expiration');

  const oldRefresh = await post(base, '/guest/refresh', { refreshToken: handedRefresh });
  oldRefresh.status === 401 ? pass(`A5: the refresh credential issued before the bind is refused (${oldRefresh.body?.code})`) : fail(`A5: the old refresh answered ${oldRefresh.status}`);
  const oldGuest = await post(base, '/exchange-credentials', {}, visitor.body.guestToken);
  oldGuest.status === 401 || oldGuest.status === 403 ? pass(`A5: the guest token is refused after the bind (${oldGuest.status})`) : fail(`A5: the guest token answered ${oldGuest.status}`);

  const again = await post(base, '/exchange-credentials', {}, await fresh.signIn());
  again.status === 200 && again.body?.userArn === visitor.body.userArn ? pass('A6: the account signs in as the same AppInstanceUser') : fail(`A6: answered ${again.status} ${again.body?.userArn}`);

  // ── PATH B AND B7 ───────────────────────────────────────────────────────────────────────────────
  if (!CUSTOMER_POOL_ID || !CUSTOMER_CLIENT_ID || !secret.testInbox?.bucket) {
    skip('path B and the second-issuer link: CUSTOMER_POOL_ID and CUSTOMER_CLIENT_ID name no customers\' pool, or the test secret names no testInbox');
  } else {
    console.log('path B: the claim');
    const v = await start();
    if (v.status !== 200) throw new Error(`guest start refused the second visitor: ${v.status}`);
    const asVisitor = messagingAs(v.body.credentials);
    const sent = await asVisitor.send(new SendChannelMessageCommand({
      ChannelArn: v.body.channelArn, Content: 'deny-test: erased with the customer', Type: 'STANDARD', Persistence: 'PERSISTENT', ChimeBearer: v.body.userArn,
    }));
    const address = `claim-${randomUUID()}@${secret.testInbox.domain}`;
    const since = Date.now() - 5_000;
    const registered = await post(base, '/guest/register', { fields: { name: 'Deny Test', company: 'Example' }, email: address }, v.body.guestToken);
    if (registered.status !== 200) throw new Error(`B1: registration refused: ${registered.status} ${JSON.stringify(registered.body)}`);
    registered.body?.claimToken === undefined && !JSON.stringify(registered.body).includes('claim=')
      ? pass('B1: the registration\'s answer carries no claim token') : fail(`B1: the answer carries a claim: ${JSON.stringify(registered.body)}`);
    const consoleCall = await consoleCaller(base, await idToken(idp, clientId, secret.testAdmin.email, secret.testAdmin.password));
    if (registered.body?.status === 'awaiting-approval') {
      // R1: HELD FOR AN OPERATOR: no email until it is approved, and the console lists it.
      (await claimFromInbox(secret.testInbox, address, since, 20_000)) === null
        ? pass('R1: a registration awaiting approval sends no email') : fail('R1: a claim email arrived before approval');
      const listed = await consoleCall('/guest/registrations', undefined, 'GET');
      const waiting = (listed.body?.registrations || []).find((r) => r.registrationId === registered.body.registrationId);
      waiting?.deliverTo === address ? pass('R1: the console lists the waiting registration') : fail(`R1: the listing answered ${listed.status} ${JSON.stringify(listed.body)}`);
      const approved = await consoleCall(`/guest/registrations/${registered.body.registrationId}/approve`, {});
      approved.status === 200 ? pass('R2: an operator approves it') : fail(`R2: the approval answered ${approved.status} ${JSON.stringify(approved.body)}`);
    } else {
      registered.body?.status === 'sent' ? pass('B1: with no approval declared the link is sent at once') : fail(`B1: answered ${JSON.stringify(registered.body)}`);
    }
    const claimToken = await claimFromInbox(secret.testInbox, address, since);
    if (!claimToken) throw new Error('B1: no claim email reached the test inbox');
    pass('B1: the claim arrives as the sign-in link in the email to the registered address');
    registered.body.claimToken = claimToken;

    const customer = await freshAccount(CUSTOMER_POOL_ID, CUSTOMER_CLIENT_ID, null);
    const customerToken = await customer.signIn();
    await post(base, '/exchange-credentials', {}, customerToken);
    const byEmail = await post(base, '/upgrade/claim', { email: 'deny-test@deny-test.invalid' }, customerToken);
    byEmail.status === 400 ? pass('B2: a claim naming an email and no token is refused (400)') : fail(`B2: answered ${byEmail.status}`);
    const unknown = await post(base, '/upgrade/claim', { claimToken: randomBytes(32).toString('base64url') }, customerToken);
    unknown.status === 404 ? pass('B2: an unknown claim finds nothing (404)') : fail(`B2: an unknown claim answered ${unknown.status}`);

    const staff = await post(base, '/upgrade/claim', { claimToken: registered.body.claimToken }, testUserToken);
    staff.status === 403 && staff.body?.code === 'NOT_CLEARED_FOR_TARGET'
      ? pass('B3: an account that does not reach the customer classification is refused (403)') : fail(`B3: answered ${staff.status} ${JSON.stringify(staff.body)}`);

    const claimed = await post(base, '/upgrade/claim', { claimToken: registered.body.claimToken }, customerToken);
    if (claimed.status !== 200) fail(`B4: the claim answered ${claimed.status} ${JSON.stringify(claimed.body)}`);
    else {
      const tags = (await messaging.send(new ListTagsForResourceCommand({ ResourceARN: claimed.body.conversationArn }))).Tags || [];
      tags.find((t) => t.Key === 'upgradedFrom')?.Value === v.body.channelArn
        ? pass('B4: the claimed conversation is tagged with the visitor\'s conversation') : fail(`B4: tags ${JSON.stringify(tags)}`);
      const seedRow = await contextRowOf(contextTable, claimed.body.conversationArn);
      seedRow.includes('Deny Test') && !seedRow.includes('erased with the customer') && !seedRow.includes(address)
        ? pass(`B4a: the seed carries the registered fields${seedRow.includes('assessment') ? ' and the assistant\'s assessment' : ' (no assessment: the model did not answer)'}, and no message or address`)
        : fail('B4a: the seed is missing the fields, or carries a message or the address');
      (await isDeleted(v.body.channelArn, v.body.userArn))
        ? pass('B4a: the visitor\'s conversation is deleted after the claim') : fail('B4a: the visitor\'s conversation still exists after the claim');
    }
    const twice = await post(base, '/upgrade/claim', { claimToken: registered.body.claimToken }, customerToken);
    twice.status === 409 ? pass('B5: a second redemption is refused (409)') : fail(`B5: answered ${twice.status}`);

    const customerArn = (await post(base, '/exchange-credentials', {}, customerToken)).body?.userArn;
    const deleted = await consoleCall('/delete', { personArn: customerArn });
    if (deleted.status !== 200) fail(`B6: the customer could not be offboarded: ${deleted.status}`);
    else {
      // The visit is already gone, so its messages went with it; the registration record goes with the person.
      const registrationKey = `registration#${createHash('sha256').update(v.body.channelArn).digest('hex')}`;
      const tokensTable = (await ssm.send(new GetParameterCommand({ Name: `/${INSTANCE}/shared/tables/tokens-name` })).catch(() => null))?.Parameter?.Value;
      const left = tokensTable ? await ddb.send(new GetItemCommand({ TableName: tokensTable, Key: { pk: { S: registrationKey } } })) : null;
      tokensTable && !left?.Item
        ? pass('B6: erasure followed the tag to the retired visit, and its registration record is gone') : fail(`B6: the registration record ${tokensTable ? 'remains' : 'could not be read (no tokens-name parameter)'}`);
      void sent;
    }

    console.log('B7: one human through two issuers');
    const linkCandidate = await freshAccount(CUSTOMER_POOL_ID, CUSTOMER_CLIENT_ID, null);
    const unpinned = await freshAccount(poolId, clientId, process.env.UPGRADE_TEST_GROUP || 'basic');
    const noPerson = await post(base, '/exchange-credentials', { linkIssuer: { token: await linkCandidate.signIn() } }, await unpinned.signIn());
    noPerson.status === 403 && noPerson.body?.code === 'LINK_NEEDS_A_PERSON'
      ? pass('L1: a first sign-in cannot link a second issuer (403)') : fail(`L1: answered ${noPerson.status} ${JSON.stringify(noPerson.body)}`);
    const pinned = await post(base, '/exchange-credentials', {}, freshToken);
    const linked = await post(base, '/exchange-credentials', { linkIssuer: { token: await linkCandidate.signIn() } }, await fresh.signIn());
    linked.status === 200 && linked.body?.userArn === pinned.body?.userArn ? pass('L2: a pinned session links the second issuer to its person') : fail(`L2: answered ${linked.status} ${JSON.stringify(linked.body)}`);
    const asSecond = await post(base, '/exchange-credentials', {}, await linkCandidate.signIn());
    asSecond.status === 200 && asSecond.body?.userArn === pinned.body?.userArn ? pass('L2: the second issuer signs in as the same person') : fail(`L2: the second issuer resolved to ${asSecond.body?.userArn}`);
    const moved = await post(base, '/exchange-credentials', { linkIssuer: { token: await linkCandidate.signIn() } }, testUserToken);
    moved.status === 409 ? pass('L3: a subject that is somebody is never moved to another person (409)') : fail(`L3: answered ${moved.status} ${JSON.stringify(moved.body)}`);
  }

  console.log(failures.length ? `\n${failures.length} refusal(s) did not hold (instance ${INSTANCE})` : `\nevery refusal held (instance ${INSTANCE})`);
  return failures.length ? 1 : 0;
}

// NO process.exit() HERE: on Windows it aborts inside libuv after a fetch and the run ends with the abort's
// status instead of its verdict (lib/exit-when-drained.cjs). The code is set and the loop drains.
const finish = (code) => { destroyClients(cfn, sm, idp, chimeIdentity, messaging, ddb, s3, ssm); exitWhenDrained(code); };
main()
  .then(async (code) => { for (const c of cleanups) await c(); finish(code); })
  .catch(async (err) => {
    for (const c of cleanups) await c();
    console.error('setup error:', err?.message || err);
    finish(2);
  });
