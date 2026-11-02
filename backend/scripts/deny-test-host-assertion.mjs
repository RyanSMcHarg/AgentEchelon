#!/usr/bin/env node
/**
 * DENY-TEST: A HOST ASSERTION IS ACCEPTED ONCE, AT THE EXCHANGE ALONE, FOR A PROVISIONED SUBJECT (A9, R14).
 *
 * Against a DEPLOYED instance whose trusted-issuer registry declares a `host-assertion` issuer whose
 * pinned key is the public half of a key this script holds: the TEST-DOUBLE SIGNER (the
 * Apex signer is NOT BUILT, O9). Configuration C5 and later. Every assertion is posted to the deployed
 * `PersonApi`, so the edge authorizer, the `Tokens` record and the exchange each answer for real:
 *
 *   1. CONTROL. A subject is pre-assigned through the subject provisioner (`pending`), and a fresh
 *      assertion for it, carrying a mapped permission set, is vended a credential (200); its row is now
 *      `active`.
 *   2. REPLAY. The same assertion presented again: refused (401).
 *   3. EACH CHECK. A fresh assertion with another deployment's audience; with an `exp` an hour ahead; with
 *      no `jti`; naming a `kid` the registry does not pin; signed with a key the registry does not pin:
 *      each refused (401).
 *   4. ANOTHER ROUTE. A fresh assertion for a second pending subject on `POST /create-conversation`:
 *      refused (401) and the `jti` NOT spent: the same assertion is then vended at the exchange (200).
 *   5. AN UNMAPPED PERMISSION SET. A fresh assertion for the bound subject carrying only a permission set
 *      the mapping does not declare: refused (403), nothing vended.
 *   6. A SUBJECT NOBODY PROVISIONED. Refused (403), and `Identities` holds no row for it afterwards.
 *   7. THE COUNT. `AssertionRefused` in `AgentEchelon/HostAssertion` has data points for the checks above
 *      (polled for up to three minutes: CloudWatch extracts an EMF line asynchronously).
 *
 * NOT TESTED HERE, AND WHY: the widget's checks that the posted assertion comes from a declared host
 * origin and from `window.parent` are the widget frame's own, made in the browser before anything reaches
 * the server, so no request this script sends can exercise them. They are proven by the widget's component
 * tests (`frontend/packages/widget/src/session/hostAssertion.test.ts`). This script says so in its output
 * rather than passing a row it did not run.
 *
 * The subjects it creates are `deny-test-<random>` under the host's org id; their `Identities` rows and
 * AppInstanceUsers are removed at the end, whatever happens.
 *
 * USAGE
 *   node backend/scripts/deny-test-host-assertion.mjs --generate-key <path>      # once: a test-double key
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> AE_HOST_ASSERTION_KEY=<path> \
 *     [AE_HOST_ISSUER=<registry id>] node backend/scripts/deny-test-host-assertion.mjs
 *
 * The registry entry is read from `backend/deploy.config.json` (the first `host-assertion` entry, or
 * `AE_HOST_ISSUER`), and its pinned key must be this key's public half. Needs the backend built.
 * Exit 0 = every refusal held; 1 = a gap; 2 = a setup error. Each run is recorded, dated, in
 * docs/specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md ("Verified by").
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ChimeSDKIdentityClient, DeleteAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { generateKey, loadKey, signAssertion } = require('./lib/host-assertion-signer.cjs');
const { issuersFromConfig } = require('./lib/issuer-checks.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGION = process.env.AWS_REGION || 'us-east-1';

if (process.argv[2] === '--generate-key') {
  const out = process.argv[3];
  if (!out) { console.error('usage: --generate-key <path>'); process.exit(2); }
  const spki = generateKey(out);
  console.log(`Wrote the test-double private key to ${out}. Declare its public half on the host-assertion entry:\n`);
  console.log(JSON.stringify({ hostAssertion: { publicKeys: { 'deny-test-1': spki } } }, null, 2));
  process.exit(0);
}

const PREFIX = resolveStackPrefix(process.env);
const INSTANCE = resolveInstanceName(process.env);
const cfn = new CloudFormationClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const note = (m) => console.log(`  NOTE  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function outputsOf(stackName) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries((r.Stacks?.[0]?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}

async function post(base, route, token, body = {}) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* an empty body */ }
  return { status: res.status, body: json };
}

/** The host-assertion entry this run signs for, from deploy.config.json. */
function hostEntry() {
  const config = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'deploy.config.json'), 'utf8'));
  const entries = issuersFromConfig(config).filter((e) => e?.kind === 'host-assertion');
  const wanted = process.env.AE_HOST_ISSUER;
  const entry = wanted ? entries.find((e) => e.id === wanted) : entries[0];
  if (!entry) throw new Error(wanted ? `deploy.config.json declares no host-assertion issuer "${wanted}"` : 'deploy.config.json declares no host-assertion issuer');
  return entry;
}

async function main() {
  const keyPath = process.env.AE_HOST_ASSERTION_KEY;
  if (!keyPath) throw new Error('AE_HOST_ASSERTION_KEY names the test-double private key (see --generate-key)');
  const entry = hostEntry();
  const { key, spki } = loadKey(keyPath);
  const kid = Object.entries(entry.hostAssertion?.publicKeys || {}).find(([, v]) => v === spki)?.[0];
  if (!kid) throw new Error(`issuer "${entry.id}" pins no key matching ${keyPath}; declare its public half (--generate-key prints it)`);
  const algorithm = entry.algorithm || 'RS256';
  if (algorithm !== 'RS256') throw new Error('the test-double signer signs RS256; declare an RS256 entry for this run');
  const mapping = entry.clearance?.mapping;
  if (!mapping) throw new Error(`issuer "${entry.id}" declares no mapping; this run needs a permission-set mapping`);
  const permset = Object.keys(mapping.values || {})[0];

  const { PersonApiUrl: base } = await outputsOf(`${PREFIX}PersonApi`);
  const identity = await outputsOf(`${PREFIX}Identity`);
  const provisioner = identity.SubjectProvisionerAdminFunctionName || identity.SubjectProvisionerConnectorsFunctionName;
  if (!base || !provisioner) throw new Error('this instance publishes no PersonApiUrl or no subject provisioner; deploy a registry with this host first');
  const identitiesTable = (await new SSMClient({ region: REGION }).send(new GetParameterCommand({ Name: `/${INSTANCE}/shared/tables/identities-name` }))).Parameter?.Value;
  const org = process.env.AE_HOST_ORG || '00D000000000AE1';
  const iss = entry.issuer;
  const sign = (sub, over = {}) => signAssertion({ key, kid, iss, aud: INSTANCE, org, sub, claims: { [mapping.claim]: [permset], ...over.claims }, header: over.header, algorithm });
  const created = [];
  const provision = async (sub) => {
    const out = await new LambdaClient({ region: REGION }).send(new InvokeCommand({
      FunctionName: provisioner,
      Payload: Buffer.from(JSON.stringify({ op: 'provisionSubject', issuer: entry.id, subject: `${org}:${sub}`, actor: 'deny-test-host-assertion' })),
    }));
    const answer = JSON.parse(Buffer.from(out.Payload || []).toString() || '{}');
    if (answer.ok !== true || answer.state !== 'provisioned') throw new Error(`the provisioner refused the setup subject: ${JSON.stringify(answer)}`);
    created.push({ key: `${entry.id}|${org}:${sub}`, personArn: answer.personArn });
    return answer.personArn;
  };
  const rowOf = async (sub) => (await doc.send(new GetCommand({ TableName: identitiesTable, Key: { issuerSubject: `${entry.id}|${org}:${sub}` }, ConsistentRead: true }))).Item;
  const fresh = () => `deny-test-${randomBytes(6).toString('hex')}`;

  try {
    // ── 1. CONTROL ──────────────────────────────────────────────────────────────────────────────
    console.log('1. control: a provisioned subject is vended once');
    const bound = fresh();
    await provision(bound);
    const first = sign(bound);
    const ok = await post(base, '/exchange-credentials', first.token);
    ok.status === 200 ? pass('control: a fresh assertion for a pending subject is vended (200)') : fail(`control: the exchange answered ${ok.status} ${JSON.stringify(ok.body)}`);
    (await rowOf(bound))?.status === 'active' ? pass('control: the pending row is now active') : fail('control: the row was not bound');

    // ── 2. REPLAY ───────────────────────────────────────────────────────────────────────────────
    console.log('2. the same assertion presented twice');
    const replay = await post(base, '/exchange-credentials', first.token);
    replay.status === 401 ? pass('a replayed assertion is refused (401)') : fail(`a replayed assertion answered ${replay.status}`);

    // ── 3. EACH CHECK ───────────────────────────────────────────────────────────────────────────
    console.log('3. each check');
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const rows = [
      ['another deployment\'s audience', sign(bound, { claims: { aud: `${INSTANCE}-other` } }).token],
      ['an exp an hour ahead', sign(bound, { claims: { exp: Math.floor(Date.now() / 1000) + 3600 } }).token],
      ['no jti', sign(bound, { claims: { jti: undefined } }).token],
      ['a kid the registry does not pin', sign(bound, { header: { kid: 'not-pinned' } }).token],
      ['a key the registry does not pin', signAssertion({ key: stranger, kid, iss, aud: INSTANCE, org, sub: bound, claims: { [mapping.claim]: [permset] } }).token],
    ];
    for (const [label, token] of rows) {
      const r = await post(base, '/exchange-credentials', token);
      r.status === 401 ? pass(`${label}: refused (401)`) : fail(`${label}: answered ${r.status}`);
    }

    // ── 4. ANOTHER ROUTE ────────────────────────────────────────────────────────────────────────
    console.log('4. an assertion on a route other than the exchange');
    const pending = fresh();
    await provision(pending);
    const elsewhere = sign(pending);
    const off = await post(base, '/create-conversation', elsewhere.token, { type: 'general' });
    off.status === 401 ? pass('refused on POST /create-conversation (401)') : fail(`POST /create-conversation answered ${off.status}`);
    (await rowOf(pending))?.status === 'pending' ? pass('the pending row is untouched') : fail('the pending row changed');
    const after = await post(base, '/exchange-credentials', elsewhere.token);
    after.status === 200 ? pass('its jti was not spent there: the exchange then vends it (200)') : fail(`the exchange then answered ${after.status}`);

    // ── 5. AN UNMAPPED PERMISSION SET ───────────────────────────────────────────────────────────
    console.log('5. a permission set the mapping does not declare');
    const unmapped = await post(base, '/exchange-credentials', sign(bound, { claims: { [mapping.claim]: ['Not_A_Declared_Permission_Set'] } }).token);
    unmapped.status === 403 && !unmapped.body?.credentials ? pass('refused (403), nothing vended') : fail(`answered ${unmapped.status}`);

    // ── 6. A SUBJECT NOBODY PROVISIONED ─────────────────────────────────────────────────────────
    console.log('6. a subject nobody provisioned');
    const stray = fresh();
    const unknown = await post(base, '/exchange-credentials', sign(stray).token);
    unknown.status === 403 ? pass('refused (403)') : fail(`answered ${unknown.status}`);
    (await rowOf(stray)) ? fail('an Identities row was created for it') : pass('no Identities row was created');

    // ── 7. THE COUNT ────────────────────────────────────────────────────────────────────────────
    console.log('7. the refusals are counted by check');
    const cw = new CloudWatchClient({ region: REGION });
    let checks = [];
    for (let i = 0; i < 18 && !checks.length; i++) {
      const r = await cw.send(new ListMetricsCommand({ Namespace: 'AgentEchelon/HostAssertion', MetricName: 'AssertionRefused', RecentlyActive: 'PT3H' }));
      checks = [...new Set((r.Metrics || []).flatMap((m) => (m.Dimensions || []).filter((d) => d.Name === 'Check').map((d) => d.Value)))];
      if (!checks.length) await sleep(10_000);
    }
    checks.length ? pass(`AssertionRefused is reported by check: ${checks.sort().join(', ')}`) : fail('no AssertionRefused metric appeared within three minutes');

    note('the widget\'s undeclared-origin and parent-frame refusals are client-side, proven by frontend/packages/widget/src/session/hostAssertion.test.ts; not run here');
  } finally {
    // ── CLEANUP: the subjects this run created ──────────────────────────────────────────────────
    const chime = new ChimeSDKIdentityClient({ region: REGION });
    for (const c of created) {
      await doc.send(new DeleteCommand({ TableName: identitiesTable, Key: { issuerSubject: c.key } })).catch((e) => note(`could not remove ${c.key}: ${e?.name}`));
      await chime.send(new DeleteAppInstanceUserCommand({ AppInstanceUserArn: c.personArn })).catch((e) => {
        if (e?.name !== 'NotFoundException') note(`could not remove ${c.personArn}: ${e?.name}`);
      });
    }
  }

  console.log(failures.length ? `\n${failures.length} refusal(s) did not hold` : '\nevery refusal held');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`setup error: ${err?.message || err}`);
  process.exit(2);
});
