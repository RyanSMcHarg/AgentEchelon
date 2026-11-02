#!/usr/bin/env node
/**
 * DENY-TEST: A FOREIGN ISSUER'S PEOPLE REACH WHAT ITS MAPPING DECLARES, AND NOTHING ELSE (Q5).
 *
 * A trusted issuer whose clearance source is a `mapping` (`lib/config/issuers.ts`) reaches only the
 * classifications its declared claim values map to, within its declared classifications. A claim value the mapping
 * does not declare reaches nothing. Against the DEPLOYED stacks, through the one credential exchange:
 *
 *   1. A person whose token carries a mapped value is vended a credential, and posts in a conversation
 *      of a classification the mapping reaches (the control).
 *   2. The same credential is refused (AccessDenied) reading and posting in a conversation of a
 *      classification the mapping does not reach: the classification tag gate, not membership, because
 *      they are a member of both.
 *   3. A person of the same issuer whose token carries only a value the mapping does not declare is
 *      vended nothing (403), and no credential comes back.
 *
 * The issuer is a Cognito pool the registry declares with a mapping clearance on a claim that is not a groups
 * claim (a groups claim is translated, `groups.map`, and synth refuses a mapping on one), because a pool is what
 * the person authorizers admit; an OIDC issuer reaches the exchange once the edge authorizer does.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/deny-test-issuer-mapping.mjs
 *
 * Test secret (`TEST_SECRET_NAME`, default `agent-interface/test-credentials`): `mappedIssuer` =
 * `{ clientId, region?, reaches, outside, mappedUser: { email, password }, unmappedUser: { email, password } }`,
 * where `reaches` is a classification the mapped user's value maps to and `outside` one it does not.
 * Without that fixture the script skips with the reason printed; `REQUIRE_ISSUER_MAPPING=1` fails instead.
 *
 * Exit 0 = every refusal held; 1 = a gap; 2 = a setup error.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  DeleteChannelCommand,
  ListChannelMessagesCommand,
  SendChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';

const require = createRequire(import.meta.url);
const { resolveStackPrefix } = require('./lib/stack-lookup.cjs');
const { appInstanceArnOf } = require('./lib/person-arn.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const STACK = process.env.COGNITO_STACK || `${resolveStackPrefix(process.env)}Identity`;
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
const REQUIRE_ISSUER_MAPPING = process.env.REQUIRE_ISSUER_MAPPING === '1';

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };

const isAccessDenied = (e) => e?.name === 'AccessDeniedException' || /not authorized|access ?denied/i.test(String(e?.message));

async function idToken(idp, clientId, email, password) {
  const r = await idp.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const t = r.AuthenticationResult?.IdToken;
  if (!t) throw new Error(`no ID token for ${email}`);
  return t;
}

/** The exchange's answer, status and body, without throwing on a refusal (a refusal is the assertion). */
async function exchange(url, token) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  let body = {};
  try { body = await resp.json(); } catch { /* an empty refusal */ }
  return { status: resp.status, body };
}

function chimeFor(creds) {
  return new ChimeSDKMessagingClient({
    region: REGION,
    credentials: { accessKeyId: creds.AccessKeyId, secretAccessKey: creds.SecretAccessKey, sessionToken: creds.SessionToken },
  });
}

/** A channel of `classification` with the person as its creator and member, made with the runner's creds. */
async function channelOf(appInstanceArn, personArn, classification) {
  const admin = new ChimeSDKMessagingClient({ region: REGION });
  const created = await admin.send(new CreateChannelCommand({
    AppInstanceArn: appInstanceArn,
    Name: `deny-test-issuer-mapping-${classification}`,
    Mode: 'RESTRICTED',
    Privacy: 'PRIVATE',
    ChimeBearer: personArn,
    ClientRequestToken: randomBytes(16).toString('hex'),
    Tags: [{ Key: 'classification', Value: classification }],
  }));
  return { arn: created.ChannelArn, remove: () => admin.send(new DeleteChannelCommand({ ChannelArn: created.ChannelArn, ChimeBearer: personArn })) };
}

async function attempt(label, call, wantDenied) {
  try {
    await call();
    if (wantDenied) fail(`${label}: allowed, expected AccessDenied`);
    else pass(`${label}: allowed`);
  } catch (e) {
    // A row that expects the call allowed is the control, and only success proves it: a refusal by the
    // membership check (ForbiddenException) or anything else means no path was shown to work.
    if (wantDenied && isAccessDenied(e)) pass(`${label}: AccessDenied`);
    else fail(`${label}: ${e?.name || e}: ${String(e?.message || '').slice(0, 160)}, expected ${wantDenied ? 'AccessDenied' : 'allowed'}`);
  }
}

async function main() {
  const secret = JSON.parse((await new SecretsManagerClient({ region: REGION }).send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
  const fixture = secret.mappedIssuer;
  if (!fixture?.clientId || !fixture.mappedUser || !fixture.unmappedUser || !fixture.reaches || !fixture.outside) {
    const why = 'the test secret names no mappedIssuer { clientId, reaches, outside, mappedUser, unmappedUser }';
    if (REQUIRE_ISSUER_MAPPING) { console.error(`  FAIL  required but skipped: ${why}`); process.exit(1); }
    console.log(`  SKIP  ${why}`);
    process.exit(0);
  }
  // The person credential exchange is a route on PersonApi.
  const personStack = `${resolveStackPrefix(process.env)}PersonApi`;
  const outputs = {};
  for (const o of (await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: personStack }))).Stacks?.[0]?.Outputs || []) {
    outputs[o.OutputKey] = o.OutputValue;
  }
  if (!outputs.PersonApiUrl) { console.error(`${personStack} has no PersonApiUrl output`); process.exit(2); }
  const url = `${outputs.PersonApiUrl.replace(/\/$/, '')}/exchange-credentials`;
  const idp = new CognitoIdentityProviderClient({ region: fixture.region || REGION });

  console.log('\n1. A mapped value reaches its classification, and nothing past it\n');
  const mapped = await exchange(url, await idToken(idp, fixture.clientId, fixture.mappedUser.email, fixture.mappedUser.password));
  if (mapped.status !== 200 || !mapped.body?.credentials) {
    fail(`the mapped user was vended nothing (${mapped.status} ${JSON.stringify(mapped.body)}); the registry entry or its mapping is not deployed`);
  } else {
    const personArn = mapped.body.userArn;
    const chime = chimeFor(mapped.body.credentials);
    const appInstanceArn = appInstanceArnOf(personArn);
    for (const [classification, wantDenied] of [[fixture.reaches, false], [fixture.outside, true]]) {
      let channel;
      try {
        channel = await channelOf(appInstanceArn, personArn, classification);
      } catch (e) {
        console.error(`SETUP FAILED: the runner could not create a ${classification} channel: ${String(e?.message || e)}`);
        process.exit(2);
      }
      try {
        await attempt(`send in a ${classification} conversation`, () => chime.send(new SendChannelMessageCommand({
          ChannelArn: channel.arn, Content: 'deny-test', Type: 'STANDARD', Persistence: 'NON_PERSISTENT', ChimeBearer: personArn,
        })), wantDenied);
        await attempt(`read a ${classification} conversation`, () => chime.send(new ListChannelMessagesCommand({
          ChannelArn: channel.arn, ChimeBearer: personArn, MaxResults: 1,
        })), wantDenied);
      } finally {
        try { await channel.remove(); } catch (e) { console.error(`  (cleanup) could not delete ${channel.arn}: ${String(e?.message || e)}`); }
      }
    }
  }

  console.log('\n2. A claim value outside the mapping reaches nothing\n');
  const unmapped = await exchange(url, await idToken(idp, fixture.clientId, fixture.unmappedUser.email, fixture.unmappedUser.password));
  if (unmapped.status === 403 && !unmapped.body?.credentials) pass(`the unmapped user is refused (${unmapped.status})`);
  else fail(`the unmapped user got ${unmapped.status}${unmapped.body?.credentials ? ' and a credential' : ''}, expected 403 and none`);

  console.log(failures.length ? `\n${failures.length} gap(s)` : '\nA foreign issuer reaches only what its mapping declares');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error('setup error:', err?.name || err); process.exit(2); });
