#!/usr/bin/env node
/**
 * DENY-TEST: THE ADMIN CREDENTIAL EXCHANGE REFUSES A GUEST TOKEN AND A HOST ASSERTION (A6, A9).
 *
 * Neither the guest issuer's people nor a host's are ever administrators: synth refuses `admin: true` on
 * both kinds, and the admin plane's edge authorizer leaves both out of its registry altogether, so their
 * tokens name an issuer it does not know. Against the DEPLOYED `AdminApi` (configuration C5 and later):
 *
 *   1. CONTROL. A genuine ID token of this deployment's own pool (an issuer that declares `admin: true`)
 *      reaches the admin exchange: the exchange itself answers a body naming no identity with 400
 *      `CONSOLE_SESSION_ONLY`. A route that refused every token would pass the rows below while proving
 *      nothing, so any other answer to the control fails the run.
 *   2. A GUEST TOKEN, from guest start on `PersonApi`: refused (401) at `POST /exchange-credentials` on
 *      `AdminApi`. Needs a guest issuer and a non-production instance (the captcha test keys).
 *   3. A HOST ASSERTION, signed with the test-double signer's key for the host-assertion issuer: refused
 *      (401) there, and its `jti` is not spent: the same assertion is then admitted at the person exchange
 *      when its subject was provisioned (`AE_HOST_SUBJECT`), or refused there only as unprovisioned (403).
 *
 * A row whose issuer this instance does not declare is a setup error naming what to declare, never a pass.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> AE_HOST_ASSERTION_KEY=<path> \
 *     [AE_HOST_ISSUER=<id>] [AE_HOST_SUBJECT=<org>:<user>] node backend/scripts/deny-test-admin-exchange.mjs
 *
 * Needs the backend built, and the test secret (`TEST_SECRET_NAME`, default `agent-interface/test-credentials`)
 * holding `cognitoClientId` and `basicUser { email, password }`. Exit 0 = every refusal held; 1 = a gap;
 * 2 = a setup error. Each run is recorded, dated, in docs/specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { loadKey, signAssertion } = require('./lib/host-assertion-signer.cjs');
const { issuersFromConfig } = require('./lib/issuer-checks.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const INSTANCE = resolveInstanceName(process.env);
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
const DUMMY_CAPTCHA = 'XXXX.DUMMY.TOKEN.XXXX';
const cfn = new CloudFormationClient({ region: REGION });
const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };

async function outputsOf(stackName) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries((r.Stacks?.[0]?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}

async function post(base, route, body, token) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* an empty body */ }
  return { status: res.status, body: json };
}

async function main() {
  const { PersonApiUrl: personBase } = await outputsOf(`${PREFIX}PersonApi`);
  const { AdminApiUrl: adminBase } = await outputsOf(`${PREFIX}AdminApi`);
  if (!personBase || !adminBase) throw new Error('this instance publishes no PersonApiUrl or no AdminApiUrl; declare the admin capability');
  const identity = await outputsOf(`${PREFIX}Identity`);
  if (!identity.GuestNoticeVersion) throw new Error('this instance declares no guest issuer; declare one (configuration C0 and later)');
  const config = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'deploy.config.json'), 'utf8'));
  const hosts = issuersFromConfig(config).filter((e) => e?.kind === 'host-assertion');
  const host = process.env.AE_HOST_ISSUER ? hosts.find((e) => e.id === process.env.AE_HOST_ISSUER) : hosts[0];
  if (!host) throw new Error('deploy.config.json declares no host-assertion issuer; declare one (configuration C5)');
  const keyPath = process.env.AE_HOST_ASSERTION_KEY;
  if (!keyPath) throw new Error('AE_HOST_ASSERTION_KEY names the test-double private key (deny-test-host-assertion.mjs --generate-key)');
  const { key, spki } = loadKey(keyPath);
  const kid = Object.entries(host.hostAssertion?.publicKeys || {}).find(([, v]) => v === spki)?.[0];
  if (!kid) throw new Error(`issuer "${host.id}" pins no key matching ${keyPath}`);

  // ── 1. CONTROL ──────────────────────────────────────────────────────────────────────────────────
  console.log('1. control: an admin issuer reaches the admin exchange');
  const secret = JSON.parse((await new SecretsManagerClient({ region: REGION }).send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
  const auth = await new CognitoIdentityProviderClient({ region: REGION }).send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH', ClientId: secret.cognitoClientId, AuthParameters: { USERNAME: secret.basicUser.email, PASSWORD: secret.basicUser.password },
  }));
  const poolToken = auth.AuthenticationResult?.IdToken;
  if (!poolToken) throw new Error('the test user could not sign in');
  // The exchange's OWN answer to a body naming no identity, 400 CONSOLE_SESSION_ONLY, is what proves the edge
  // admitted the token and the handler read it. "Not 401" would also pass a 403 from the edge, or a 500 from
  // an authorizer that failed, while proving nothing.
  const control = await post(adminBase, '/exchange-credentials', {}, poolToken);
  control.status === 400 && control.body?.code === 'CONSOLE_SESSION_ONLY'
    ? pass('a pool token reaches the admin exchange, which answers 400 CONSOLE_SESSION_ONLY')
    : fail(`the control answered ${control.status} ${JSON.stringify(control.body).slice(0, 200)}, expected the exchange's 400 CONSOLE_SESSION_ONLY`);

  // ── 2. A GUEST TOKEN ────────────────────────────────────────────────────────────────────────────
  console.log('2. a guest token');
  const guest = await post(personBase, '/guest/start', { captchaToken: DUMMY_CAPTCHA, noticeVersion: identity.GuestNoticeVersion });
  if (guest.status !== 200 || !guest.body?.guestToken) throw new Error(`guest start refused the visitor: ${guest.status} ${JSON.stringify(guest.body)}`);
  const g = await post(adminBase, '/exchange-credentials', {}, guest.body.guestToken);
  g.status === 401 ? pass('a guest token is refused at the admin exchange (401)') : fail(`a guest token answered ${g.status}`);

  // ── 3. A HOST ASSERTION ─────────────────────────────────────────────────────────────────────────
  console.log('3. a host assertion');
  const subject = process.env.AE_HOST_SUBJECT || '00D000000000AE1:deny-test-admin-exchange';
  const [org, ...rest] = subject.split(':');
  const mapping = host.clearance?.mapping;
  const { token } = signAssertion({
    key, kid, iss: host.issuer, aud: INSTANCE, org, sub: rest.join(':'),
    claims: mapping ? { [mapping.claim]: [Object.keys(mapping.values || {})[0]] } : {},
  });
  const h = await post(adminBase, '/exchange-credentials', {}, token);
  h.status === 401 ? pass('a host assertion is refused at the admin exchange (401)') : fail(`a host assertion answered ${h.status}`);
  const after = await post(personBase, '/exchange-credentials', {}, token);
  const expected = process.env.AE_HOST_SUBJECT ? 200 : 403;
  after.status === expected
    ? pass(`its jti was not spent at the admin plane: the person exchange answers it as ${expected === 200 ? 'a provisioned subject (200)' : 'an unprovisioned subject (403)'}`)
    : fail(`the person exchange then answered ${after.status}, expected ${expected}`);

  console.log(failures.length ? `\n${failures.length} refusal(s) did not hold` : '\nevery refusal held');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`setup error: ${err?.message || err}`);
  process.exit(2);
});
