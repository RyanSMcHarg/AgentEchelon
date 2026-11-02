#!/usr/bin/env node
/**
 * DENY-TEST: EVERY ROLE A SESSION IS VENDED ON OR AN ASSISTANT ACTS THROUGH IS CAPPED BY ITS PERMISSIONS
 * BOUNDARY, WHATEVER ITS IDENTITY OR SESSION POLICY GRANTS (tenet P4, F4).
 *
 * Against a DEPLOYED instance, normally the whole matrix's last configuration (C7), whose stacks hold the
 * bounded roles:
 *
 *   - each classification's assistant acting role (`AssistantActingRole*` in `<prefix>Assistants-<c>`);
 *   - the guest-session role (`*SessionRole*` under the guest issuer in `<prefix>Identity`), when the
 *     registry declares a guest issuer;
 *   - the `link` session role (`*SessionRole*` under the invitation-link issuer in `<prefix>Identity`), when
 *     it declares an invitation-link issuer;
 *   - each person vend role (`ExchangeRole` in `<prefix>Assistants-<c>` for a conversational classification, and
 *     the admin plane's and `ExchangeRoleRestricted` in `<prefix>Identity`), which a host assertion's session is
 *     vended on too;
 *   - the admin exchange's roles (`ExchangeRoleAdminPlane`, `AdminConsoleRole`, `TeamConsoleRole`,
 *     `TeamAttachmentRole` in `<prefix>AdminServices`), when `admin` is declared;
 *   - the provisioner's session (`RuntimeAssistantProvisionerRole` in `<prefix>Messaging`), on which every assistant
 *     is built and retired;
 *   - the edge authorizer's function role in `<prefix>PersonApi` and `<prefix>AdminApi`;
 *   - the connector runtime's roles (`ConnectorEventReceiverRole`, `ConnectorGrantRoutesRole`,
 *     `ConnectorGrantRevokerRole` in `<prefix>Connectors`), when `connectors` is declared.
 *
 * For each one found:
 *
 *   1. IT CARRIES A BOUNDARY. `iam:GetRole` names a permissions boundary. A bounded role found without one
 *      is a gap.
 *   2. THE BOUNDARY CAPS AN IDENTITY POLICY THAT GRANTS EVERYTHING. `iam:SimulateCustomPolicy` evaluates an
 *      identity policy allowing `*` on `*` (what any session policy could at most leave standing) under the
 *      role's own boundary document, read live (`GetPolicy`, `GetPolicyVersion`). Every probe must come back
 *      denied:
 *        - every bounded role: creating or passing a role, assuming another role, changing a function,
 *          deleting a stack;
 *        - an acting role, whose boundary is the services a turn uses: tagging a session, tagging or untagging
 *          an identity, every classification-gated action on a channel or a bot whose classification
 *          tag is one the boundary does not admit (read from the boundary's own conditioned Deny
 *          statements, with the tag supplied as a context entry), reading an object in a bucket the
 *          boundary does not name, and reading or listing a `context/` prefix of a classification it does
 *          not grant (one no deployment declares, so the boundary refuses it without naming it), with its
 *          own granted context prefix as the control;
 *        - a session role, whose boundary is one conversation: reading or deleting a table, a bucket, a key
 *          or a secret, invoking a model, and creating a channel, a person or deleting the app instance;
 *        - a person vend role, whose boundary is its role's bearer-pinned messaging set: the same, and every
 *          classification-gated channel action on a channel tagged with a classification its role does not
 *          reach (read from the boundary's own conditioned Allow statements);
 *        - an admin exchange role, whose boundary is today's admin-plane reach: reading a table, a key or a
 *          secret, invoking a model, and creating a person, an app-instance admin or deleting the app instance;
 *        - the edge authorizer, whose boundary is reading `Identities`: every write to `Identities` (on the
 *          table its boundary names), a token of any kind but `assertion-jti` (the leading key supplied as a
 *          context entry), signing or decrypting with a key, reading a secret, and creating a person;
 *        - the connector runtime, whose boundary is its own secrets and grants: every Amazon Chime SDK channel
 *          action, a secret outside its connectors' own, a write to `Identities`, and invoking a model.
 *   3. CONTROL: the same boundary still allows what it is for. The first statement of the boundary that
 *      allows a named action on `*` with no condition (the messaging session endpoint, for a session role)
 *      comes back allowed under the allow-all identity policy, so the denials above are the boundary's and
 *      not a simulation that denies everything; for an acting role, so does a gated action on a channel
 *      tagged with a classification the boundary admits. A boundary with no such statement is said, not
 *      failed.
 *
 * Roles the instance holds that carry no boundary (Lambda execution roles, which no session is vended
 * on) are counted and listed, never failed: the claim is about the roles a credential is minted on.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/deny-test-permission-boundaries.mjs
 *
 * Read-only: it creates, changes and deletes nothing. Exit 0 = every boundary held; 1 = a gap; 2 = a
 * setup error (no instance stacks, no bounded role found).
 */
import { createRequire } from 'node:module';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { GetPolicyCommand, GetPolicyVersionCommand, GetRoleCommand, IAMClient, SimulateCustomPolicyCommand } from '@aws-sdk/client-iam';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { instanceStacksAmong, listStackNames, listStackResources } = require('./lib/stack-resources.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const INSTANCE = resolveInstanceName(process.env);
const PREFIX = resolveStackPrefix(process.env);

const cfn = new CloudFormationClient({ region: REGION });
const iam = new IAMClient({ region: REGION });

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const note = (m) => console.log(`  NOTE  ${m}`);

/** What no bounded role may do, whatever kind it is. */
const EVERY_ROLE = ['iam:CreateRole', 'iam:PassRole', 'sts:AssumeRole', 'lambda:UpdateFunctionCode', 'cloudformation:DeleteStack'];

/** What no session or runtime role reaches: a table read or delete, a bucket delete, a key, a secret, a model. */
const NO_DATA = ['dynamodb:Scan', 'dynamodb:DeleteTable', 's3:DeleteBucket', 'kms:Decrypt', 'secretsmanager:GetSecretValue', 'bedrock:InvokeModel'];

/** The roles a session is vended on or an assistant acts through, by stack and logical id, and their own probes. */
const BOUNDED = [
  {
    what: 'assistant acting role', kind: 'acting', stack: /^Assistants-/, logicalId: /^AssistantActingRole/,
    probes: ['sts:TagSession', 'chime:TagResource', 'chime:UntagResource'],
  },
  {
    what: 'session role', kind: 'session', stack: /^Identity$/, logicalId: /SessionRole/,
    probes: [
      'dynamodb:Scan', 'dynamodb:DeleteTable', 's3:GetObject', 's3:DeleteBucket', 'kms:Decrypt', 'secretsmanager:GetSecretValue',
      'bedrock:InvokeModel', 'chime:CreateChannel', 'chime:CreateAppInstanceUser', 'chime:DeleteAppInstance',
    ],
  },
  {
    what: 'person vend role', kind: 'vend', stack: /^(Identity|Assistants-.+)$/, logicalId: /^ExchangeRole/,
    probes: [...NO_DATA, 's3:GetObject', 'chime:CreateChannel', 'chime:CreateChannelMembership', 'chime:CreateAppInstanceUser', 'chime:DeleteAppInstance', 'chime:RedactChannelMessage'],
  },
  {
    what: 'admin exchange role', kind: 'admin', stack: /^AdminServices$/, logicalId: /^(ExchangeRoleAdminPlane|AdminConsoleRole|TeamConsoleRole|TeamAttachmentRole)/,
    probes: [...NO_DATA, 'chime:CreateAppInstanceUser', 'chime:CreateAppInstanceAdmin', 'chime:DeleteAppInstance', 'cognito-idp:AdminDeleteUser'],
  },
  {
    // The provisioner's session, on which every assistant is built and retired, in the core beside the app instance.
    what: 'assistant provisioner session', kind: 'runtime-build', stack: /^Messaging$/, logicalId: /^RuntimeAssistantProvisionerRole/,
    probes: [...NO_DATA, 'chime:SendChannelMessage', 'chime:CreateChannel', 'chime:CreateChannelMembership', 'cognito-idp:AdminDeleteUser'],
  },
  {
    what: 'edge authorizer', kind: 'edge', stack: /^(PersonApi|AdminApi)$/, logicalId: /EdgeAuthorizerFnServiceRole/,
    probes: [...NO_DATA, 'kms:Sign', 'chime:CreateAppInstanceUser', 'chime:SendChannelMessage'],
  },
  {
    what: 'connector runtime role', kind: 'connector', stack: /^Connectors$/, logicalId: /^Connector(EventReceiver|GrantRoutes|GrantRevoker)Role/,
    probes: ['bedrock:InvokeModel', 's3:GetObject', 'chime:SendChannelMessage', 'chime:CreateChannel', 'chime:CreateChannelMembership', 'chime:ListChannelMessages'],
  },
];

const ALLOW_ALL = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] });

async function boundaryDocument(policyArn) {
  const p = (await iam.send(new GetPolicyCommand({ PolicyArn: policyArn }))).Policy;
  const v = (await iam.send(new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: p.DefaultVersionId }))).PolicyVersion;
  return decodeURIComponent(v.Document);
}

/** The decision for one action on one resource, under an allow-all identity policy and this boundary. */
async function decision(boundary, action, resource, context = {}) {
  const r = await iam.send(new SimulateCustomPolicyCommand({
    PolicyInputList: [ALLOW_ALL],
    PermissionsBoundaryPolicyInputList: [boundary],
    ActionNames: [action],
    ResourceArns: [resource],
    ...(Object.keys(context).length ? {
      ContextEntries: Object.entries(context).map(([ContextKeyName, value]) => ({ ContextKeyName, ContextKeyType: 'string', ContextKeyValues: [value] })),
    } : {}),
  }));
  return r.EvaluationResults?.[0]?.EvalDecision ?? 'unknown';
}

const list = (v) => [].concat(v ?? []);

/** The first named action the boundary allows on `*` with no condition: the control. */
function controlOf(boundary) {
  for (const st of list(JSON.parse(boundary).Statement)) {
    if (st.Effect !== 'Allow' || st.Condition) continue;
    const actions = list(st.Action).filter((a) => typeof a === 'string' && !a.includes('*'));
    if (list(st.Resource).includes('*') && actions.length) return actions[0];
  }
  return null;
}

/**
 * THE CLASSIFICATION GATES: each Deny the boundary conditions on a resource's `classification` tag not being
 * one of a list, as (actions, a concrete resource under its pattern, the admitted values).
 */
function classificationGatesOf(boundary) {
  const gates = [];
  for (const st of list(JSON.parse(boundary).Statement)) {
    const admitted = st.Effect === 'Deny' ? list(st.Condition?.StringNotEquals?.['aws:ResourceTag/classification']) : [];
    const pattern = list(st.Resource).find((r) => typeof r === 'string' && r.endsWith('/*'));
    const actions = list(st.Action).filter((a) => typeof a === 'string' && !a.includes('*'));
    if (admitted.length && pattern && actions.length) gates.push({ actions, resource: pattern.replace(/\*$/, 'deny-test-probe'), admitted });
  }
  return gates;
}

/**
 * THE GATES A BOUNDARY'S ALLOWS CARRY: each Allow conditioned on a resource's `classification` tag equalling one
 * of a list (a person vend role's tag-gated channel set), as (actions, a concrete resource, the admitted values,
 * and the gate's other StringEquals keys, such as the `adminPlane` session tag the admin-plane gate also requires).
 */
function allowGatesOf(boundary) {
  const gates = [];
  for (const st of list(JSON.parse(boundary).Statement)) {
    const admitted = st.Effect === 'Allow' ? list(st.Condition?.StringEquals?.['aws:ResourceTag/classification']) : [];
    const pattern = list(st.Resource).find((r) => typeof r === 'string' && /\/channel\/\*$/.test(r));
    const actions = list(st.Action).filter((a) => typeof a === 'string' && !a.includes('*'));
    const requires = Object.fromEntries(Object.entries(st.Condition?.StringEquals ?? {})
      .filter(([k]) => k !== 'aws:ResourceTag/classification')
      .map(([k, v]) => [k, list(v)[0]]));
    if (admitted.length && pattern && actions.length) gates.push({ actions, resource: pattern.replace(/\*$/, 'deny-test-probe'), admitted, requires });
  }
  return gates;
}

/** The first resource other than `*` a boundary statement with `effect` names for `action`. */
function resourceOf(boundary, effect, action) {
  for (const st of list(JSON.parse(boundary).Statement)) {
    if (st.Effect !== effect || !list(st.Action).includes(action)) continue;
    const r = list(st.Resource).find((x) => typeof x === 'string' && x !== '*');
    if (r) return r;
  }
  return null;
}

/** The decision for one action on one resource with list-valued context keys (`dynamodb:LeadingKeys`). */
async function decisionWithList(boundary, action, resource, context) {
  const r = await iam.send(new SimulateCustomPolicyCommand({
    PolicyInputList: [ALLOW_ALL],
    PermissionsBoundaryPolicyInputList: [boundary],
    ActionNames: [action],
    ResourceArns: [resource],
    ContextEntries: Object.entries(context).map(([ContextKeyName, values]) => ({ ContextKeyName, ContextKeyType: 'stringList', ContextKeyValues: values })),
  }));
  return r.EvaluationResults?.[0]?.EvalDecision ?? 'unknown';
}

const IDENTITIES_WRITES = ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'];

/** What one kind probes on the resources its boundary names, beyond the plain probes on `*`. */
async function kindProbes(b, name, boundary) {
  const [, , , region, account] = String(b.roleArn || '').split(':');
  const refused = async (label, d) => (d !== 'allowed' ? pass(`${label} is refused (${d})`) : fail(`${name}: the boundary allows ${label}`));
  const allowed = async (label, d) => (d === 'allowed' ? pass(`control: ${label} is allowed`) : fail(`${name}: control ${label} answered ${d}; the simulation proves nothing`));
  if (b.kind.kind === 'vend') {
    // A tag-gated role: a channel outside its classifications is refused, one it reaches is allowed.
    for (const gate of allowGatesOf(boundary)) {
      const outside = `deny-test-not-${gate.admitted.join('-')}`.slice(0, 64);
      for (const action of gate.actions.slice(0, 3)) {
        await refused(`${action} on a channel tagged ${outside}`, await decision(boundary, action, gate.resource, { 'aws:ResourceTag/classification': outside }));
      }
      // CONTROL: a channel the gate admits, with every other key the gate requires.
      const held = Object.entries(gate.requires).map(([k, v]) => ` with ${k}=${v}`).join('');
      await allowed(`${gate.actions[0]} on a channel tagged ${gate.admitted[0]}${held}`,
        await decision(boundary, gate.actions[0], gate.resource, { 'aws:ResourceTag/classification': gate.admitted[0], ...gate.requires }));
      // A gate that also requires a session tag (the admin plane's) refuses the admitted channel without it.
      if (held) {
        await refused(`${gate.actions[0]} on a channel tagged ${gate.admitted[0]} lacking${held.replace(/ with /g, " ")}`,
          await decision(boundary, gate.actions[0], gate.resource, { 'aws:ResourceTag/classification': gate.admitted[0] }));
      }
    }
  }
  if (b.kind.kind === 'acting') {
    // S3 ONLY WHERE A TURN USES IT: the boundary allows the objects a turn uses and the classification's own
    // granted `context/` prefixes, and names no other classification. So a bucket it does not name and a
    // `context/` prefix of a classification it does not grant (one no deployment declares, here) are refused
    // without the boundary listing them, and its own context is the control.
    await refused('s3:GetObject in a bucket the boundary does not name',
      await decision(boundary, 's3:GetObject', 'arn:aws:s3:::deny-test-probe-bucket/deny-test-probe'));
    const objects = list(JSON.parse(boundary).Statement).find((st) => st.Sid === 'BoundaryObjectsATurnUses');
    const own = list(objects?.Resource).find((r) => typeof r === 'string' && /\/context\/[^/*]+\/\*$/.test(r));
    if (!own) fail(`${name}: the boundary allows no context prefix of its own (BoundaryObjectsATurnUses)`);
    else {
      const bucket = own.slice(0, own.indexOf('/context/'));
      await refused('s3:GetObject on a context prefix of a classification it does not grant',
        await decision(boundary, 's3:GetObject', `${bucket}/context/deny-test-undeclared/deny-test-probe`));
      await refused('s3:ListBucket on a context prefix of a classification it does not grant',
        await decision(boundary, 's3:ListBucket', bucket, { 's3:prefix': 'context/deny-test-undeclared/' }));
      await allowed(`s3:GetObject on its own ${own.slice(bucket.length + 1)}`,
        await decision(boundary, 's3:GetObject', own.replace(/\*$/, 'deny-test-probe')));
    }
  }
  if (b.kind.kind === 'edge') {
    const identities = resourceOf(boundary, 'Allow', 'dynamodb:GetItem');
    if (!identities) fail(`${name}: the boundary names no Identities table to read`);
    else {
      for (const action of IDENTITIES_WRITES) await refused(`${action} on Identities`, await decision(boundary, action, identities));
      await allowed('GetItem on Identities', await decision(boundary, 'dynamodb:GetItem', identities));
    }
    const tokens = resourceOf(boundary, 'Allow', 'dynamodb:PutItem');
    if (!tokens) note('no host-assertion issuer is declared: the boundary allows no token write at all');
    else {
      for (const kind of ['reply', 'claim', 'invitation', 'guest-refresh']) {
        await refused(`a ${kind} token write`, await decisionWithList(boundary, 'dynamodb:PutItem', tokens, { 'dynamodb:LeadingKeys': [`${kind}#deny-test-probe`] }));
      }
      await allowed('an assertion-jti write', await decisionWithList(boundary, 'dynamodb:PutItem', tokens, { 'dynamodb:LeadingKeys': ['assertion-jti#deny-test-probe'] }));
    }
  }
  if (b.kind.kind === 'connector') {
    const foreign = `arn:aws:secretsmanager:${region}:${account}:secret:deny-test-probe-AbCdEf`;
    await refused('a secret outside its connectors\' own', await decision(boundary, 'secretsmanager:GetSecretValue', foreign));
    const identities = resourceOf(boundary, 'Deny', 'dynamodb:PutItem');
    if (!identities) fail(`${name}: the boundary denies no Identities write`);
    else for (const action of IDENTITIES_WRITES) await refused(`${action} on Identities`, await decision(boundary, action, identities));
  }
}

async function main() {
  const stacks = instanceStacksAmong(await listStackNames(cfn), PREFIX);
  if (!stacks.length) {
    console.error(`no stacks of the instance "${INSTANCE}" (prefix ${PREFIX}) in ${REGION}`);
    process.exit(2);
  }
  const bounded = [];
  const unbounded = [];
  for (const stack of stacks) {
    const short = stack.slice(PREFIX.length);
    const kinds = BOUNDED.filter((b) => b.stack.test(short));
    for (const r of (await listStackResources(cfn, stack)).filter((x) => x.ResourceType === 'AWS::IAM::Role' && x.PhysicalResourceId)) {
      const kind = kinds.find((b) => b.logicalId.test(r.LogicalResourceId));
      const expected = !!kind;
      const role = (await iam.send(new GetRoleCommand({ RoleName: r.PhysicalResourceId }))).Role;
      const boundaryArn = role?.PermissionsBoundary?.PermissionsBoundaryArn;
      if (expected) bounded.push({ stack: short, logicalId: r.LogicalResourceId, boundaryArn, kind, roleArn: role?.Arn });
      else if (!boundaryArn) unbounded.push(`${short}/${r.LogicalResourceId}`);
    }
  }
  if (!bounded.length) {
    console.error('no bounded role (acting, session, vend, admin exchange, edge or connector) was found; is this the instance you meant?');
    process.exit(2);
  }

  for (const b of bounded) {
    const name = `${b.stack}/${b.logicalId}`;
    console.log(`${b.kind.what}: ${name}`);
    // 1. IT CARRIES A BOUNDARY.
    if (!b.boundaryArn) {
      fail(`${name} carries no permissions boundary`);
      continue;
    }
    pass(`carries its boundary ${b.boundaryArn.split('/').pop()}`);
    const boundary = await boundaryDocument(b.boundaryArn);
    // 2. EVERY PROBE IS DENIED, under an identity policy that grants everything.
    for (const action of [...EVERY_ROLE, ...b.kind.probes]) {
      const d = await decision(boundary, action, '*');
      d !== 'allowed' ? pass(`${action} is refused (${d})`) : fail(`${name}: the boundary allows ${action}`);
    }
    if (b.kind.kind === 'acting') {
      const gates = classificationGatesOf(boundary);
      if (!gates.length) fail(`${name}: the boundary gates no channel or bot by its classification tag`);
      for (const gate of gates) {
        const outside = `deny-test-not-${gate.admitted.join('-')}`.slice(0, 64);
        for (const action of gate.actions.slice(0, 3)) {
          const d = await decision(boundary, action, gate.resource, { 'aws:ResourceTag/classification': outside });
          d !== 'allowed' ? pass(`${action} on ${gate.resource.split('/').slice(-2, -1)[0]} tagged outside the boundary is refused (${d})`)
            : fail(`${name}: the boundary allows ${action} on a resource tagged ${outside}`);
        }
        // CONTROL: the same action on one the boundary admits.
        const d = await decision(boundary, gate.actions[0], gate.resource, { 'aws:ResourceTag/classification': gate.admitted[0] });
        d === 'allowed' ? pass(`control: ${gate.actions[0]} tagged ${gate.admitted[0]} is allowed`)
          : fail(`${name}: control ${gate.actions[0]} tagged ${gate.admitted[0]} answered ${d}; the simulation proves nothing`);
      }
    }
    await kindProbes(b, name, boundary);
    // 3. CONTROL: what the boundary is for still comes back allowed.
    const control = controlOf(boundary);
    if (!control) {
      note('the boundary allows no named action on * without a condition, so this role has no plain control row');
      continue;
    }
    const d = await decision(boundary, control, '*');
    d === 'allowed' ? pass(`control: ${control} is allowed under the boundary`) : fail(`${name}: control ${control} answered ${d}; the simulation proves nothing`);
  }
  note(`${unbounded.length} other roles of the instance carry no boundary (no session is vended on them)${unbounded.length ? `: ${unbounded.join(', ')}` : ''}`);

  console.log(failures.length ? `\n${failures.length} gap(s).` : '\nEvery permissions boundary held.');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`setup error: ${err?.name || 'error'}: ${err?.message || err}`);
  process.exit(2);
});
