#!/usr/bin/env node
/**
 * DENY-TEST: ONLY THE TWO SUBJECT PROVISIONERS WRITE A `pending` ROW, AND A PENDING ROW IS BOUND ONCE (P-13).
 *
 * Against a DEPLOYED instance whose registry declares a `host-assertion` issuer (configuration C5 and
 * later), with the test-double signer's key (`deny-test-host-assertion.mjs --generate-key`):
 *
 *   1. WHO MAY WRITE A PENDING ROW. `iam simulate-principal-policy`, over every role this instance's stacks
 *      create, of `dynamodb:PutItem` on `Identities` with the request context a pending row carries (its
 *      key under the host's issuer, a pending row's attributes). Allowed only for the subject provisioners
 *      and the credential exchange (the one minter, whose write is unconditioned). Offboarding, the edge
 *      authorizer, user management, the webhook receiver and every other role: refused.
 *   2. EACH PROVISIONER IS HELD TO ITS OWN ISSUERS AND ROW. For each provisioner role: refused a key under
 *      this deployment's own pool (`deployment|...`), a `revoked#` marker, an attribute a pending row does
 *      not carry, and every `UpdateItem` and `DeleteItem`. Control: the pending row under its issuer is
 *      allowed.
 *   3. WHO MAY INVOKE A PROVISIONER. `lambda:InvokeFunction` on each: allowed only for its own caller's role
 *      (user management for the admin provisioner, the webhook receiver for the connectors one), refused for
 *      every other role.
 *   4. A PENDING ROW OF ONE ISSUER IS NOT ACCEPTED FROM ANOTHER. A pending row is written directly under the
 *      host's key naming another issuer: the host's assertion for that subject is refused (403) and the row
 *      is left pending. With a second host declared (`AE_SECOND_HOST_ISSUER`), a row pre-assigned under one
 *      host is refused to the other's assertion too.
 *   5. BOUND ONCE, UNDER CONCURRENCY. A subject is pre-assigned, and two fresh assertions for it are
 *      presented at once: both are vended, as the same AppInstanceUser, and that AppInstanceUser carries no
 *      expiration.
 *
 * The subjects it creates are removed at the end, whatever happens.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> AE_HOST_ASSERTION_KEY=<path> \
 *     [AE_HOST_ISSUER=<id>] [AE_SECOND_HOST_ISSUER=<id>] node backend/scripts/deny-test-pending-identities.mjs
 *
 * Needs the backend built. Exit 0 = every refusal held; 1 = a gap; 2 = a setup error. Each run is
 * recorded, dated, in docs/specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md ("Verified by").
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { LambdaClient, InvokeCommand, GetFunctionCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ChimeSDKIdentityClient, DeleteAppInstanceUserCommand, DescribeAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { instanceStacksAmong, listStackNames, listStackResources } = require('./lib/stack-resources.cjs');
const { loadKey, signAssertion } = require('./lib/host-assertion-signer.cjs');
const { issuersFromConfig } = require('./lib/issuer-checks.cjs');
const { appInstanceArnOf, userArnFor } = require('./lib/person-arn.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const INSTANCE = resolveInstanceName(process.env);
/** The attributes a pending row carries. Mirrors `PENDING_ROW_ATTRIBUTES` in lib/constructs/subject-provisioner.ts. */
const PENDING_ROW_ATTRIBUTES = ['issuerSubject', 'personArn', 'issuer', 'status', 'createdAt', 'provisionedBy'];

const cfn = new CloudFormationClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const note = (m) => console.log(`  NOTE  ${m}`);

async function outputsOf(stackName) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries((r.Stacks?.[0]?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}

function hostEntry(id) {
  const config = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'deploy.config.json'), 'utf8'));
  const entries = issuersFromConfig(config).filter((e) => e?.kind === 'host-assertion');
  const entry = id ? entries.find((e) => e.id === id) : entries[0];
  if (!entry) throw new Error(id ? `deploy.config.json declares no host-assertion issuer "${id}"` : 'deploy.config.json declares no host-assertion issuer');
  return entry;
}

/** One simulated decision: true when allowed. */
async function allowed(roleArn, action, resource, context = {}) {
  const ContextEntries = Object.entries(context).map(([k, v]) => ({ ContextKeyName: k, ContextKeyValues: v, ContextKeyType: 'stringList' }));
  const r = await iam.send(new SimulatePrincipalPolicyCommand({ PolicySourceArn: roleArn, ActionNames: [action], ResourceArns: [resource], ContextEntries }));
  return r.EvaluationResults?.[0]?.EvalDecision === 'allowed';
}

async function post(base, route, token) {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
  let json = null;
  try { json = await res.json(); } catch { /* an empty body */ }
  return { status: res.status, body: json };
}

async function main() {
  const host = hostEntry(process.env.AE_HOST_ISSUER);
  const keyPath = process.env.AE_HOST_ASSERTION_KEY;
  if (!keyPath) throw new Error('AE_HOST_ASSERTION_KEY names the test-double private key (deny-test-host-assertion.mjs --generate-key)');
  const { key, spki } = loadKey(keyPath);
  const kid = Object.entries(host.hostAssertion?.publicKeys || {}).find(([, v]) => v === spki)?.[0];
  if (!kid) throw new Error(`issuer "${host.id}" pins no key matching ${keyPath}`);
  const mapping = host.clearance?.mapping;
  const claimsFor = mapping ? { [mapping.claim]: [Object.keys(mapping.values || {})[0]] } : {};

  const account = (await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}))).Account;
  const { PersonApiUrl: base } = await outputsOf(`${PREFIX}PersonApi`);
  const identity = await outputsOf(`${PREFIX}Identity`);
  const provisioners = [
    { caller: 'admin', fn: identity.SubjectProvisionerAdminFunctionName, role: identity.SubjectProvisionerAdminRoleArn, callerRole: /^UserManagementFunctionServiceRole/ },
    { caller: 'connectors', fn: identity.SubjectProvisionerConnectorsFunctionName, role: identity.SubjectProvisionerConnectorsRoleArn, callerRole: /^WebhookReceiverRole/ },
  ].filter((p) => p.fn && p.role);
  if (!provisioners.length) throw new Error('this instance has no subject provisioner; declare a provisioned-only issuer with admin or a connector naming it');
  const ssm = new SSMClient({ region: REGION });
  const tableName = (await ssm.send(new GetParameterCommand({ Name: `/${INSTANCE}/shared/tables/identities-name` }))).Parameter?.Value;
  const tableArn = (await ssm.send(new GetParameterCommand({ Name: `/${INSTANCE}/shared/tables/identities-arn` }))).Parameter?.Value;

  const roles = [];
  for (const stack of instanceStacksAmong(await listStackNames(cfn), PREFIX)) {
    for (const r of (await listStackResources(cfn, stack)).filter((x) => x.ResourceType === 'AWS::IAM::Role')) {
      roles.push({ stack, logicalId: r.LogicalResourceId, arn: `arn:aws:iam::${account}:role/${r.PhysicalResourceId}` });
    }
  }
  const pendingContext = (k) => ({ 'dynamodb:LeadingKeys': [k], 'dynamodb:Attributes': PENDING_ROW_ATTRIBUTES });

  // ── 1. WHO MAY WRITE A PENDING ROW ──────────────────────────────────────────────────────────────
  console.log('1. who may write a pending row');
  const sampleKey = `${host.id}|deny-test-sample`;
  for (const r of roles) {
    const ok = await allowed(r.arn, 'dynamodb:PutItem', tableArn, pendingContext(sampleKey));
    const sanctioned = /^SubjectProvisioner(Admin|Connectors)Role/.test(r.logicalId) || /^CredentialExchangeRole/.test(r.logicalId);
    if (ok && !sanctioned) fail(`${r.stack}/${r.logicalId} may write a pending row`);
    if (!ok && /^SubjectProvisioner/.test(r.logicalId)) fail(`${r.stack}/${r.logicalId} is refused its own pending row`);
  }
  pass(`simulated ${roles.length} roles: only the provisioners and the exchange may write a pending row`);

  // ── 2. EACH PROVISIONER IS HELD TO ITS OWN ISSUERS AND ROW ──────────────────────────────────────
  console.log('2. each provisioner is held to its own issuers and row');
  for (const p of provisioners) {
    (await allowed(p.role, 'dynamodb:PutItem', tableArn, pendingContext(sampleKey))) ? pass(`control: ${p.caller} may write its pending row`) : fail(`${p.caller} is refused its pending row`);
    const refusals = [
      ['a key under this deployment\'s own pool', 'dynamodb:PutItem', pendingContext('deployment|deny-test-sample')],
      ['a revoked marker', 'dynamodb:PutItem', pendingContext('revoked#x#y')],
      ['an attribute a pending row does not carry', 'dynamodb:PutItem', { 'dynamodb:LeadingKeys': [sampleKey], 'dynamodb:Attributes': [...PENDING_ROW_ATTRIBUTES, 'boundAt'] }],
      ['an UpdateItem', 'dynamodb:UpdateItem', pendingContext(sampleKey)],
      ['a DeleteItem', 'dynamodb:DeleteItem', pendingContext(sampleKey)],
    ];
    for (const [label, action, context] of refusals) {
      (await allowed(p.role, action, tableArn, context)) ? fail(`${p.caller} may write ${label}`) : pass(`${p.caller} is refused ${label}`);
    }
  }

  // ── 3. WHO MAY INVOKE A PROVISIONER ─────────────────────────────────────────────────────────────
  console.log('3. who may invoke a provisioner');
  for (const p of provisioners) {
    const fnArn = (await lambda.send(new GetFunctionCommand({ FunctionName: p.fn }))).Configuration?.FunctionArn;
    const invokers = [];
    for (const r of roles) if (await allowed(r.arn, 'lambda:InvokeFunction', fnArn)) invokers.push(r.logicalId);
    const unsanctioned = invokers.filter((id) => !p.callerRole.test(id));
    unsanctioned.length ? fail(`the ${p.caller} provisioner may also be invoked by ${unsanctioned.join(', ')}`) : pass(`the ${p.caller} provisioner is invoked by its own caller alone (${invokers.join(', ') || 'none'})`);
    if (!invokers.length) fail(`no role may invoke the ${p.caller} provisioner: its caller cannot reach it`);
  }

  // ── 4 AND 5: LIVE ───────────────────────────────────────────────────────────────────────────────
  const org = process.env.AE_HOST_ORG || '00D000000000AE1';
  const fresh = () => `deny-test-${randomBytes(6).toString('hex')}`;
  const sign = (entry, sub) => signAssertion({ key, kid, iss: entry.issuer, aud: INSTANCE, org, sub, claims: claimsFor }).token;
  const created = [];
  const chime = new ChimeSDKIdentityClient({ region: REGION });
  const row = async (k) => (await doc.send(new GetCommand({ TableName: tableName, Key: { issuerSubject: k }, ConsistentRead: true }))).Item;
  try {
    console.log('4. a pending row of one issuer is not accepted from another');
    const crossed = fresh();
    const crossedKey = `${host.id}|${org}:${crossed}`;
    // The app instance, from the service admin's ARN (`<app instance>/user/<id>`).
    const adminArn = (await ssm.send(new GetParameterCommand({ Name: `/${INSTANCE}/app-instance-admin-arn` }))).Parameter?.Value || '';
    const appInstanceArn = appInstanceArnOf(adminArn);
    if (!appInstanceArn) throw new Error('the service admin ARN is not published; deploy Messaging first');
    await doc.send(new PutCommand({ TableName: tableName, Item: {
      issuerSubject: crossedKey, personArn: userArnFor(appInstanceArn, `0190a000-0000-7000-8000-${randomBytes(6).toString('hex')}`),
      issuer: `${host.id}-other`, status: 'pending', createdAt: new Date().toISOString(), provisionedBy: 'admin',
    } }));
    created.push({ key: crossedKey });
    const r4 = await post(base, '/exchange-credentials', sign(host, crossed));
    r4.status === 403 || r4.status === 401 ? pass(`a row naming another issuer is refused (${r4.status})`) : fail(`a row naming another issuer answered ${r4.status}`);
    (await row(crossedKey))?.status === 'pending' ? pass('and is left pending') : fail('the crossed row changed');
    const second = process.env.AE_SECOND_HOST_ISSUER ? hostEntry(process.env.AE_SECOND_HOST_ISSUER) : null;
    if (second) {
      const p = provisioners[0];
      const sub = fresh();
      const out = await lambda.send(new InvokeCommand({ FunctionName: p.fn, Payload: Buffer.from(JSON.stringify({ op: 'provisionSubject', issuer: host.id, subject: `${org}:${sub}`, actor: 'deny-test-pending-identities' })) }));
      const answer = JSON.parse(Buffer.from(out.Payload || []).toString() || '{}');
      created.push({ key: `${host.id}|${org}:${sub}`, personArn: answer.personArn });
      const r = await post(base, '/exchange-credentials', sign(second, sub));
      r.status === 403 ? pass(`a subject pre-assigned under ${host.id} is refused to ${second.id} (403)`) : fail(`${second.id} answered ${r.status} for a subject of ${host.id}`);
    } else {
      note('AE_SECOND_HOST_ISSUER is not set: the two-host case is not run here; the crossed-row case above runs on one host');
    }

    console.log('5. bound once, under concurrency');
    const p = provisioners[0];
    const sub = fresh();
    const out = await lambda.send(new InvokeCommand({ FunctionName: p.fn, Payload: Buffer.from(JSON.stringify({ op: 'provisionSubject', issuer: host.id, subject: `${org}:${sub}`, actor: 'deny-test-pending-identities' })) }));
    const answer = JSON.parse(Buffer.from(out.Payload || []).toString() || '{}');
    if (answer.ok !== true) throw new Error(`the ${p.caller} provisioner refused the setup subject: ${JSON.stringify(answer)}`);
    created.push({ key: `${host.id}|${org}:${sub}`, personArn: answer.personArn });
    const [a, b] = await Promise.all([post(base, '/exchange-credentials', sign(host, sub)), post(base, '/exchange-credentials', sign(host, sub))]);
    a.status === 200 && b.status === 200 ? pass('both concurrent first sign-ins are vended') : fail(`concurrent first sign-ins answered ${a.status} and ${b.status}`);
    a.body?.userArn && a.body.userArn === b.body?.userArn && a.body.userArn === answer.personArn
      ? pass('as the one pre-assigned AppInstanceUser') : fail(`they resolved to ${a.body?.userArn} and ${b.body?.userArn}, pre-assigned ${answer.personArn}`);
    const described = await chime.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: answer.personArn }));
    described.AppInstanceUser?.ExpirationSettings ? fail('the bound AppInstanceUser carries an expiration') : pass('the bound AppInstanceUser carries no expiration');
  } finally {
    for (const c of created) {
      await doc.send(new DeleteCommand({ TableName: tableName, Key: { issuerSubject: c.key } })).catch((e) => note(`could not remove ${c.key}: ${e?.name}`));
      if (c.personArn) await chime.send(new DeleteAppInstanceUserCommand({ AppInstanceUserArn: c.personArn })).catch((e) => { if (e?.name !== 'NotFoundException') note(`could not remove ${c.personArn}: ${e?.name}`); });
    }
  }

  console.log(failures.length ? `\n${failures.length} refusal(s) did not hold` : '\nevery refusal held');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`setup error: ${err?.message || err}`);
  process.exit(2);
});
