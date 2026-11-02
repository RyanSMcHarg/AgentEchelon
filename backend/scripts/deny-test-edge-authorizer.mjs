#!/usr/bin/env node
/**
 * DENY-TEST: THE EDGE AUTHORIZER ADMITS A TOKEN ONLY WHERE ITS PERSON IS SERVED (A3, plan risk R1).
 *
 * Against the DEPLOYED `PersonApi`, every person-facing route the API serves (read from the API itself, so
 * a route added later is covered without an edit here) is called with each token the edge must refuse,
 * and each answer must be a refusal:
 *
 *   1. No token at all: 401, from the gateway, before the authorizer runs.
 *   2. A token from an issuer the registry does not declare (signed with a key generated here): 401.
 *   3. A genuine token from this deployment's pool with its signature altered: 401.
 *   4. A genuine token with its header rewritten to `alg: none`, and to `alg: HS256`: 401.
 *   5. The token type the registry does not declare (the pool's ACCESS token, where `id` is declared): 401.
 *   6. A first-time token (a disposable pool account that has never been through the exchange): refused
 *      (403) on every route but the exchange, and admitted there.
 *   7. A one-conversation issuer's token (the host pool, when the test secret names it): refused (403) on
 *      every route but `ONE_CHANNEL_ROUTES`.
 *
 * The control: the same genuine token is admitted (not 401 or 403, and not a 5xx) on the routes it reaches. A route that
 * refuses every token, the control included, would pass every refusal above while proving nothing, so a
 * control that is refused fails the run.
 *
 * A route is refused when the answer is 401 or 403; any other status (the handler's own 400 for an empty
 * body included) means the edge admitted the token, which for a refusal row is the gap this test exists to
 * find. The unit tables (`test/lib/the-edge-refuses-a-token-it-cannot-prove.test.ts`,
 * `test/lib/the-edge-admits-a-token-only-where-its-person-is-served.test.ts`) prove each check offline;
 * this proves the deployed API is wired to them.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/deny-test-edge-authorizer.mjs
 *
 * Needs: the backend built (`npm run build`), and the test secret (`TEST_SECRET_NAME`, default
 * `agent-interface/test-credentials`) holding `cognitoClientId` and `basicUser { email, password }`;
 * for row 7, `federatedClientId` and `federatedUser { email, password }` of a one-conversation host pool.
 * Without the host-pool fixture row 7 is skipped with the reason printed; `REQUIRE_FEDERATED=1` fails
 * instead. The disposable account of row 6 is created here and deleted at the end.
 *
 * Exit 0 = every refusal held; 1 = a gap; 2 = a setup error.
 */
import { generateKeyPairSync, randomBytes, randomUUID, sign as signBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { CloudFormationClient, DescribeStacksCommand, GetTemplateCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminAddUserToGroupCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const require = createRequire(import.meta.url);
const { resolveStackPrefix } = require('./lib/stack-lookup.cjs');
const { ONE_CHANNEL_ROUTES } = require('../lib/constructs/trusted-issuers.js');
const { EXCHANGE_ROUTE } = require('../lib/constructs/edge-authorizer.js');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
const REQUIRE_FEDERATED = process.env.REQUIRE_FEDERATED === '1';

const cfn = new CloudFormationClient({ region: REGION });
const sm = new SecretsManagerClient({ region: REGION });
const idp = new CognitoIdentityProviderClient({ region: REGION });

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const skip = (m) => (REQUIRE_FEDERATED ? fail(`required but skipped: ${m}`) : console.log(`  SKIP  ${m}`));

async function outputsOf(stackName) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries((r.Stacks?.[0]?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}

/** Every route the deployed stack serves behind an authorizer, as `METHOD /path`, read from its deployed template. */
async function guardedRoutes(stackName) {
  const r = await cfn.send(new GetTemplateCommand({ StackName: stackName, TemplateStage: 'Processed' }));
  const resources = JSON.parse(r.TemplateBody || '{}').Resources || {};
  return Object.values(resources)
    .filter((x) => x.Type === 'AWS::ApiGatewayV2::Route' && x.Properties?.AuthorizationType && x.Properties.AuthorizationType !== 'NONE')
    .map((x) => x.Properties.RouteKey)
    .sort();
}

async function tokens(client, clientId, username, password) {
  const r = await client.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH', ClientId: clientId, AuthParameters: { USERNAME: username, PASSWORD: password },
  }));
  const a = r.AuthenticationResult || {};
  if (!a.IdToken || !a.AccessToken) throw new Error('the sign-in returned no tokens');
  return { id: a.IdToken, access: a.AccessToken };
}

/** One call to a route, with a bearer (or none). A path parameter is filled with a probe value. */
async function call(base, routeKey, token) {
  const [method, path] = routeKey.split(' ');
  const res = await fetch(`${base}${path.replace(/\{[^}]+\}/g, 'deny-test-probe')}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
  return res.status;
}

const refused = (s) => s === 401 || s === 403;
/**
 * A CONTROL IS ADMITTED WHEN THE HANDLER ANSWERED: neither refused nor a 5xx. An authorizer that throws answers
 * 500 at the gateway, the same status a handler crash does, so a 5xx proves nothing about admission.
 */
const handlerAnswered = (s) => !refused(s) && s < 500;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A token from an issuer no registry declares, signed with a key made here. */
function undeclaredIssuerToken() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'deny-test' });
  const body = b64({ iss: 'https://issuer.deny-test.invalid', aud: 'deny-test', sub: randomUUID(), token_use: 'id', iat: now, exp: now + 600 });
  return `${head}.${body}.${signBytes('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}

/** The same token with its signature altered. */
function forged(token) {
  const [h, p, s] = token.split('.');
  const bytes = Buffer.from(s, 'base64url');
  bytes[bytes.length - 1] ^= 0xff;
  return `${h}.${p}.${bytes.toString('base64url')}`;
}

/** The same token's claims under a header naming another algorithm. */
function withAlgorithm(token, alg) {
  const [h, p] = token.split('.');
  const header = { ...JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), alg };
  const head = b64(header);
  return alg === 'none' ? `${head}.${p}.` : `${head}.${p}.${randomBytes(32).toString('base64url')}`;
}

/** Each route is refused for this token; a route that answers anything else is a gap. */
async function expectRefusedEverywhere(label, base, routes, token, expected = [401]) {
  const admitted = [];
  for (const route of routes) {
    const status = await call(base, route, token);
    if (!expected.includes(status)) admitted.push(`${route} -> ${status}`);
  }
  if (admitted.length) fail(`${label}: not refused on ${admitted.join(', ')}`);
  else pass(`${label}: refused on all ${routes.length} routes`);
}

async function main() {
  const person = await outputsOf(`${PREFIX}PersonApi`);
  const identity = await outputsOf(`${PREFIX}Identity`);
  const base = (person.PersonApiUrl || '').replace(/\/$/, '');
  if (!base) { console.error(`${PREFIX}PersonApi has no PersonApiUrl output`); process.exit(2); }
  const routes = await guardedRoutes(`${PREFIX}PersonApi`);
  if (routes.length < 10 || !routes.includes(EXCHANGE_ROUTE)) { console.error(`PersonApi serves ${routes.length} guarded routes; expected the exchange and the rest`); process.exit(2); }
  console.log(`PersonApi ${base}: ${routes.length} guarded routes`);
  const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
  const user = secret.basicUser;
  if (!secret.cognitoClientId || !user) { console.error('the test secret names no cognitoClientId and basicUser'); process.exit(2); }
  const genuine = await tokens(idp, secret.cognitoClientId, user.email, user.password);

  // THE CONTROL: a person's own token is admitted on every route (the exchange first, so the person exists).
  console.log('\nthe control');
  const admittedAll = [];
  for (const route of [EXCHANGE_ROUTE, ...routes.filter((r) => r !== EXCHANGE_ROUTE)]) {
    const status = await call(base, route, genuine.id);
    if (!handlerAnswered(status)) admittedAll.push(`${route} -> ${status}`);
  }
  if (admittedAll.length) fail(`the control token is refused on ${admittedAll.join(', ')}: the refusals below would prove nothing`);
  else pass(`the control token is admitted on all ${routes.length} routes`);

  console.log('\ntokens the edge cannot prove');
  await expectRefusedEverywhere('1. no token', base, routes, null);
  await expectRefusedEverywhere('2. an undeclared issuer', base, routes, undeclaredIssuerToken());
  await expectRefusedEverywhere('3. an altered signature', base, routes, forged(genuine.id));
  await expectRefusedEverywhere('4a. alg none', base, routes, withAlgorithm(genuine.id, 'none'));
  await expectRefusedEverywhere('4b. alg HS256', base, routes, withAlgorithm(genuine.id, 'HS256'));
  await expectRefusedEverywhere('5. the undeclared token type (an access token where id is declared)', base, routes, genuine.access);

  // 6. A FIRST-TIME TOKEN: a disposable account, never exchanged.
  console.log('\na first-time token');
  const poolId = identity.UserPoolId;
  if (!poolId) skip('6. the deployment has no pool of its own to create a first-time account in');
  else {
    const username = `edge-${randomUUID()}@deny-test.invalid`;
    const password = `Aa1!${randomBytes(12).toString('base64url')}`;
    await idp.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: username, MessageAction: 'SUPPRESS',
      UserAttributes: [{ Name: 'email', Value: username }, { Name: 'email_verified', Value: 'true' }] }));
    try {
      await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: username, Password: password, Permanent: true }));
      await idp.send(new AdminUpdateUserAttributesCommand({ UserPoolId: poolId, Username: username, UserAttributes: [{ Name: 'custom:approved', Value: 'true' }] }));
      await idp.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: username, GroupName: process.env.EDGE_TEST_GROUP || 'basic' }));
      const first = await tokens(idp, secret.cognitoClientId, username, password);
      await expectRefusedEverywhere('6. a first-time token, everywhere but the exchange', base, routes.filter((r) => r !== EXCHANGE_ROUTE), first.id, [403]);
      const atExchange = await call(base, EXCHANGE_ROUTE, first.id);
      if (!handlerAnswered(atExchange)) fail(`6. a first-time token is not admitted at the exchange (${atExchange})`);
      else pass(`6. a first-time token is admitted at the exchange (${atExchange})`);
    } finally {
      await idp.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: username })).catch(() => undefined);
    }
  }

  // 7. A ONE-CONVERSATION ISSUER: its own routes only.
  console.log('\na one-conversation issuer');
  if (!secret.federatedClientId || !secret.federatedUser) skip('7. the test secret names no federatedClientId and federatedUser');
  else {
    const host = await tokens(new CognitoIdentityProviderClient({ region: secret.federatedRegion || REGION }),
      secret.federatedClientId, secret.federatedUser.email, secret.federatedUser.password);
    // The exchange first, so the person exists and the refusals below are the edge's, not a first sign-in's.
    await call(base, EXCHANGE_ROUTE, host.id);
    await expectRefusedEverywhere('7. a one-conversation token, outside its routes', base,
      routes.filter((r) => !ONE_CHANNEL_ROUTES.includes(r)), host.id, [403]);
    for (const route of ONE_CHANNEL_ROUTES) {
      const status = await call(base, route, host.id);
      if (!handlerAnswered(status)) fail(`7. a one-conversation token is not admitted on its own route ${route} (${status})`);
      else pass(`7. a one-conversation token is admitted on ${route} (${status})`);
    }
  }

  console.log(failures.length ? `\n${failures.length} gap(s)` : '\nEvery refusal held');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error('setup error:', err?.name || err); process.exit(2); });
